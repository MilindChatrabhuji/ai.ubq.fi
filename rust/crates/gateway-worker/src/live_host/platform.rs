//! Fixed live operations over the original actor and the common account authority.
use std::collections::BTreeMap;

use gateway_auth::provider_credentials::{codex_access_expiry_ms, read_codex_source_pool};
use gateway_authority::{
    Authority,
    routing::{LiveAccountSelection, LiveRouteSelection},
};
use gateway_core::{GatewayError, js_string::JsString16};
use gateway_live_runtime::{
    runtime::PreparedSideband,
    types::{LiveAccount, LiveCreateRequest, LiveDispatchFailure, LiveHost, LiveResponse},
};

use super::{Body, CurrentLiveAccount, WorkerLiveHost, account, body, health};
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformTokens},
    storage::now_ms,
    transport::outbound::Cancellation,
};

impl WorkerLiveHost {
    fn authority(&self) -> Authority<RemoteAuthorityStore, PlatformTokens> {
        Authority::with_clock(self.platform.store.clone(), PlatformTokens, PlatformClock)
    }

    async fn read_selected(
        &self,
        selected: LiveAccountSelection,
    ) -> Result<CurrentLiveAccount, GatewayError> {
        let source = read_codex_source_pool(&self.platform.store, now_ms()?)
            .await?
            .ok_or_else(account::missing)?;
        let slot = usize::try_from(selected.binding.slot).map_err(|_| account::missing())?;
        let account = source
            .pool
            .accounts
            .get(slot)
            .cloned()
            .ok_or_else(account::missing)?;
        let identity = account.identity();
        if source.revision != selected.binding.pool_versionstamp.0
            || identity.routing_account_hash != selected.binding.account_id_hash
            || identity.credential_version != selected.binding.credential_version
        {
            return Err(account::missing());
        }
        Ok(CurrentLiveAccount {
            source: account,
            source_revision: source.revision,
            selected: Some(selected),
            store: self.platform.store.clone(),
        })
    }

    async fn resolve(
        &self,
        mut account: CurrentLiveAccount,
    ) -> Result<CurrentLiveAccount, GatewayError> {
        let now = now_ms()?;
        // Source auth.ts uses a truthy JWT expiry, otherwise the exact source age.
        let needs_renewal = codex_access_expiry_ms(&account.source.access_token)
            .filter(|expiry| *expiry != 0.0)
            .map_or(
                (now as f64) - account.source.updated_at_ms > 420_000.0,
                |expiry| expiry - (now as f64) < 120_000.0,
            );
        if needs_renewal {
            if let Some(selected) = &account.selected {
                self.platform
                    .native
                    .renew_live_create(&self.actor, selected, &self.platform, &self.config)
                    .await?;
                // Publication changes the credential fence. Reprepare through the
                // actual selector, but never adopt a different selected identity.
                let fresh = self
                    .authority()
                    .select_live_account(selected.model.as_ref(), now_ms()?)
                    .await?;
                let LiveRouteSelection::Eligible(fresh) = fresh else {
                    return Err(account::missing());
                };
                if fresh.binding.account_id_hash != selected.binding.account_id_hash {
                    return Err(account::missing());
                }
                account = self.read_selected(fresh).await?;
            } else {
                let call_id = self
                    .mapped_call_id
                    .as_deref()
                    .ok_or_else(account::missing)?;
                self.platform
                    .native
                    .renew_live_mapped(&self.actor, call_id, &self.platform, &self.config)
                    .await?;
                let source = read_codex_source_pool(&self.platform.store, now_ms()?)
                    .await?
                    .ok_or_else(account::missing)?;
                let current = source
                    .pool
                    .accounts
                    .into_iter()
                    .find(|current| current.account_id == account.source.account_id)
                    .ok_or_else(account::missing)?;
                account = CurrentLiveAccount {
                    source: current,
                    source_revision: source.revision,
                    selected: None,
                    store: self.platform.store.clone(),
                };
            }
        }
        account.ensure_current().await?;
        Ok(account)
    }

    pub async fn upgrade(
        &self,
        prepared: PreparedSideband<RemoteAuthorityStore, CurrentLiveAccount>,
    ) -> Result<crate::GatewayResponse, GatewayError> {
        let parts = prepared.into_parts();
        parts.account.ensure_current().await?;
        let transport = self.platform.native.transport()?;
        let authority = self.authority();
        let live = gateway_authority::native_live::NativeLiveAuthority::configured(
            &authority,
            &transport.identity,
            &self.config,
        );
        let action = live
            .prepare_live_sideband(&self.actor, parts.target.call_id())
            .await?;
        // Native reconstructs the same mapping/current actor and owns actual socket limits.
        // Keep the opaque capability alive until the actual upgrade result is obtained.
        let response = transport
            .live_upgrade(action.action_ref(), &self.platform)
            .await;
        drop(parts.retirement);
        response
    }
}

impl LiveHost for WorkerLiveHost {
    type Account = CurrentLiveAccount;
    type Body = Body;
    type Cancellation = Cancellation;

    fn now_ms(&self) -> i64 {
        now_ms().unwrap_or(i64::MAX)
    }
    fn user_agent(&self) -> String {
        "codex_cli_rs/0.100.0 (ai.ubq.fi)".into()
    }
    fn body_from_bytes(&self, body: Vec<u8>) -> Body {
        Body::Bytes(body)
    }

    async fn select_account(
        &self,
        model: Option<&JsString16>,
        attempted: &[String],
        cancel: &Cancellation,
    ) -> Result<CurrentLiveAccount, LiveResponse<Body>> {
        if cancel.signal().aborted() {
            return Err(body::error(gateway_admission::cancellation_error()));
        }
        let selection = self
            .authority()
            .select_live_account(model, now_ms().map_err(body::error)?)
            .await
            .map_err(body::error)?;
        match selection {
            LiveRouteSelection::Eligible(selected) => {
                let account = self
                    .resolve(self.read_selected(selected).await.map_err(body::error)?)
                    .await
                    .map_err(body::error)?;
                if attempted.iter().any(|id| id == account.account_id()) {
                    return Err(body::error(account::missing()));
                }
                Ok(account)
            }
            LiveRouteSelection::QuotaBlocked { retry_at_ms } => {
                let mut response = body::error(GatewayError::new(
                    429,
                    "Codex subscription capacity is exhausted for realtime voice; retry after the reported reset.",
                    Some("codex_quota_blocked"),
                ));
                if let Some(at) = retry_at_ms {
                    let delay = at.saturating_sub(self.now_ms()).saturating_add(999) / 1000;
                    response
                        .headers
                        .insert("retry-after".into(), delay.clamp(1, 60).to_string());
                }
                Err(response)
            }
            LiveRouteSelection::CredentialsInvalid => {
                let mut response = body::error(GatewayError::new(
                    401,
                    "The gateway's Codex auth.json needs re-authentication. Upload a fresh auth.json and retry. All configured Codex credentials are invalid.",
                    Some("codex_auth_invalid"),
                ));
                response.headers.insert(
                    "x-uos-warning".into(),
                    "codex_auth_reauthentication_required".into(),
                );
                Err(response)
            }
            LiveRouteSelection::ModelUnavailable { detail } => {
                Err(model_unavailable(model, detail.as_ref()).map_err(body::error)?)
            }
            LiveRouteSelection::RoutingUnavailable => Err(body::error(GatewayError::unavailable(
                "Codex routing state is temporarily unavailable; retry the request.",
                "codex_auth_missing",
            ))),
        }
    }

    async fn current_account(
        &self,
        account_id: &str,
    ) -> Result<CurrentLiveAccount, LiveResponse<Body>> {
        let snapshot = read_codex_source_pool(&self.platform.store, now_ms().map_err(body::error)?)
            .await
            .map_err(body::error)?;
        let source = snapshot.ok_or_else(|| body::error(account::missing()))?;
        let account = source
            .pool
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
            .ok_or_else(|| {
                body::error(GatewayError::new(
                    404,
                    "The realtime call account is no longer configured.",
                    Some("not_found"),
                ))
            })?;
        self.resolve(CurrentLiveAccount {
            source: account,
            source_revision: source.revision,
            selected: None,
            store: self.platform.store.clone(),
        })
        .await
        .map_err(body::error)
    }

    async fn dispatch_create(
        &self,
        account: &CurrentLiveAccount,
        request: LiveCreateRequest,
        _cancel: &Cancellation,
    ) -> Result<LiveResponse<Body>, LiveDispatchFailure<Body>> {
        body::send(&self.platform, &account.source, request, || {
            account.ensure_current()
        })
        .await
    }
    async fn invalidate_credential(
        &self,
        account: &CurrentLiveAccount,
    ) -> Result<(), GatewayError> {
        let selected = account.selected.as_ref().ok_or_else(account::missing)?;
        if !self
            .authority()
            .mark_live_credential_invalid(selected, now_ms()?)
            .await?
        {
            return Err(account::missing());
        }
        Ok(())
    }
    async fn response_health(&self, account: &CurrentLiveAccount, response: &LiveResponse<Body>) {
        health::response(
            self.platform.store.clone(),
            account,
            response,
            self.context.clone(),
        )
        .await
    }
    async fn transport_health(
        &self,
        account: &CurrentLiveAccount,
        failure: &LiveDispatchFailure<Body>,
    ) {
        health::failure(
            self.platform.store.clone(),
            account,
            failure,
            self.context.clone(),
        )
        .await
    }
    async fn await_routing_transition(&self) {}
    async fn capture_retry(
        &self,
        response: LiveResponse<Body>,
        cancel: &Cancellation,
    ) -> LiveResponse<Body> {
        body::capture(response, cancel).await
    }
}

fn model_unavailable(
    model: Option<&JsString16>,
    detail: Option<&JsString16>,
) -> Result<LiveResponse<Body>, GatewayError> {
    let mut units = "The model '".encode_utf16().collect::<Vec<_>>();
    units.extend(model.map(JsString16::as_units).unwrap_or_default());
    units.extend("' does not exist or is not available through this gateway. Use /v1/models for supported models.".encode_utf16());
    if let Some(detail) = detail {
        units.extend(" Upstream detail: ".encode_utf16());
        units.extend_from_slice(detail.as_units());
    }
    let message = JsString16::from_units(units).to_source_json()?;
    let body = format!("{{\"error\":{{\"message\":{},\"type\":\"invalid_request_error\",\"code\":\"model_not_found\"}}}}", message.as_str()).into_bytes();
    Ok(LiveResponse {
        status: 404,
        status_text: None,
        headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
        body: Body::Bytes(body),
    })
}

#[cfg(test)]
mod source_detail_tests {
    #[test]
    fn unavailable_model_and_detail_keep_source_units() {
        let model = gateway_core::js_string::JsString16::from_units(vec![109, 0xd800]);
        let detail = gateway_core::js_string::JsString16::from_units(vec![100, 0xdc00]);
        let response = super::model_unavailable(Some(&model), Some(&detail)).unwrap();
        let super::Body::Bytes(bytes) = response.body else {
            panic!("model refusal is bytes");
        };
        let value =
            gateway_core::source_json::SourceJson::parse(std::str::from_utf8(&bytes).unwrap())
                .unwrap();
        let message = gateway_core::source_serialization::member(&value, "error")
            .and_then(|value| gateway_core::source_serialization::member(&value, "message"))
            .as_ref()
            .and_then(gateway_core::source_serialization::string)
            .unwrap();
        assert!(message.as_units().contains(&0xd800));
        assert!(message.as_units().contains(&0xdc00));
        assert_eq!(response.status, 404);
    }
}
