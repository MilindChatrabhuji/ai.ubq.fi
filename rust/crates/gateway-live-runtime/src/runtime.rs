use gateway_auth::AuthPrincipal;
use gateway_core::state::AuthorityStore;

use crate::{
    mapping::{LiveRuntime, Retirement, mapping_missing},
    protocol::{call_id_from_location, create_headers, encode_call_id, parse_create, principal_id},
    types::*,
};

/// Minted only after authenticated mapping and current-account resolution. No serialization.
pub struct PreparedSideband<S, A> {
    account: A,
    target: SidebandTarget,
    retirement: Retirement<S>,
}
pub struct SidebandParts<S, A> {
    pub account: A,
    pub target: SidebandTarget,
    pub retirement: Retirement<S>,
}

/// Fixed upstream capability. Only the portable runtime constructs it; no caller URL.
pub struct SidebandTarget {
    call_id: String,
}
impl SidebandTarget {
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    pub fn url(&self) -> String {
        format!(
            "wss://api.openai.com/v1/live/{}",
            encode_call_id(&self.call_id)
        )
    }
}

impl<S, A> PreparedSideband<S, A> {
    pub fn into_parts(self) -> SidebandParts<S, A> {
        SidebandParts {
            account: self.account,
            target: self.target,
            retirement: self.retirement,
        }
    }
}

impl<S: AuthorityStore> LiveRuntime<S> {
    pub async fn create_call<H: LiveHost>(
        &self,
        principal: &AuthPrincipal,
        input: LiveCreateInput,
        host: &H,
        cancel: &H::Cancellation,
    ) -> LiveResponse<H::Body> {
        let (body, model) = match parse_create(&input) {
            Ok(parts) => parts,
            Err(error) => return response_error(host, error),
        };
        let mut attempted = Vec::new();
        let mut captured = None;
        for attempt in 0..2 {
            let account = match host.select_account(model.as_ref(), &attempted, cancel).await {
                Ok(account) if !attempted.iter().any(|id| id == account.account_id()) => account,
                Ok(_) => return captured.unwrap_or_else(|| response_error(host, gateway_core::GatewayError::unavailable("Codex routing state exposed no account for this realtime call; retry the request.", "codex_auth_missing"))),
                Err(response) => return captured.unwrap_or(response),
            };
            attempted.push(account.account_id().to_owned());
            let request = LiveCreateRequest {
                body: body.clone(),
                headers: create_headers(&input, host.user_agent()),
            };
            let upstream = match host.dispatch_create(&account, request, cancel).await {
                Ok(response) => response,
                Err(failure) => {
                    host.transport_health(&account, &failure).await;
                    return captured.unwrap_or(failure.response);
                }
            };
            let credential_failure = matches!(upstream.status, 401 | 403);
            if credential_failure && let Err(error) = host.invalidate_credential(&account).await {
                return response_error(host, error);
            }
            host.response_health(&account, &upstream).await;
            if !credential_failure || attempt == 1 {
                return self
                    .relay(
                        upstream,
                        account.account_id(),
                        &principal_id(principal),
                        host.now_ms(),
                    )
                    .await;
            }
            host.await_routing_transition().await;
            captured = Some(host.capture_retry(upstream, cancel).await);
        }
        captured.expect("two attempts either returned a response or captured the first failure")
    }

    async fn relay<B>(
        &self,
        mut response: LiveResponse<B>,
        account: &str,
        principal: &str,
        now: i64,
    ) -> LiveResponse<B> {
        let location = response.headers.get("location").cloned();
        let content_type = response.headers.get("content-type").cloned();
        response.headers.clear();
        if let Some(value) = content_type {
            response.headers.insert("content-type".into(), value);
        }
        if let Some(location) = location {
            if let Some(id) = call_id_from_location(&location) {
                response.headers.insert(
                    "location".into(),
                    format!("/v1/live/{}", encode_call_id(&id)),
                );
                if (200..300).contains(&response.status) {
                    self.write_mapping(&id, account, principal, now).await;
                }
            } else {
                response.headers.insert("location".into(), location);
            }
        }
        response
    }

    pub async fn prepare_sideband<H: LiveHost>(
        &self,
        principal: &AuthPrincipal,
        call_id: &str,
        upgrade: &str,
        host: &H,
    ) -> Result<PreparedSideband<S, H::Account>, LiveResponse<H::Body>> {
        let mapping = self
            .read_mapping(call_id, host.now_ms())
            .await
            .ok_or_else(|| response_error(host, mapping_missing()))?;
        if mapping.principal_id.as_deref() != Some(&principal_id(principal)) {
            return Err(response_error(
                host,
                gateway_core::GatewayError::new(
                    403,
                    "The realtime call was not created by this gateway principal.",
                    Some("forbidden"),
                ),
            ));
        }
        let account = host.current_account(&mapping.account_id).await?;
        // A host may renew/replace this account's credentials, never select another identity.
        if account.account_id() != mapping.account_id {
            return Err(response_error(host, mapping_missing()));
        }
        // Selected adaptation: retirements that began during credential I/O must also suppress dial.
        let Some(current) = self.read_mapping(call_id, host.now_ms()).await else {
            return Err(response_error(host, mapping_missing()));
        };
        if current.account_id != mapping.account_id || current.principal_id != mapping.principal_id
        {
            return Err(response_error(host, mapping_missing()));
        }
        if !upgrade.trim().eq_ignore_ascii_case("websocket") {
            return Err(response_error(
                host,
                invalid(426, "The realtime sideband requires a WebSocket upgrade."),
            ));
        }
        Ok(PreparedSideband {
            account,
            target: SidebandTarget {
                call_id: call_id.into(),
            },
            retirement: Retirement {
                runtime: self.clone(),
                call_id: call_id.into(),
            },
        })
    }
}
