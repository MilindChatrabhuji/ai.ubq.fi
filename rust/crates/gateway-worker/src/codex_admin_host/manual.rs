//! One explicit manual reset. Shared authority owns every intent, budget and promotion.
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformHost, PlatformTokens},
    storage::now_ms,
    transport::outbound::{PinnedDestination, send_http},
};
use gateway_admin_runtime::capabilities::Context;
use gateway_auth::{
    AuthConfig, AuthRequest, AuthResponse, AuthService,
    provider_credentials::{CodexSourceAccount, read_codex_source_pool},
};
use gateway_authority::{
    Authority,
    manual_reset::{ManualResetPreparation, ManualResetTarget},
    native_control::actor::{authenticate_admin_actor, principal_id},
    reset::{AccountResetInventory, ResetClaim, ResetCredit, ResetState, select_reset_credit},
    routing::{CapacityObservation, parse_capacity_observation},
};
use gateway_core::{
    GatewayError,
    identity::{PrincipalId, RequestContext, RequestId},
    state::AuthorityStore,
};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
};
use worker::{Method, Url};

pub(super) async fn consume(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    original: &AuthRequest,
    config: &AuthConfig,
    hash: &str,
    context: Context,
) -> Result<AuthResponse, GatewayError> {
    let mut phase = None;
    let result = run(store, platform, original, config, hash, context, &mut phase).await;
    let mut response = match result {
        Ok(body) => AuthResponse::json(200, body),
        Err(error) => {
            let mut body = serde_json::to_value(&error.envelope)
                .map_err(|_| unavailable("Reset response could not be encoded."))?;
            if let Some(status) = phase {
                body["reset_status"] = json!(status);
            }
            AuthResponse::json(error.status, body)
        }
    };
    response
        .headers
        .insert("Cache-Control".into(), "no-store".into());
    Ok(response)
}

async fn run(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    original: &AuthRequest,
    config: &AuthConfig,
    hash: &str,
    context: Context,
    phase: &mut Option<&'static str>,
) -> Result<Value, GatewayError> {
    let authority = Authority::with_clock(store.clone(), PlatformTokens, PlatformClock);
    let principal = AuthService::new(store, platform, config)
        .authenticate_admin(original)
        .await?;
    let request = RequestContext {
        request_id: RequestId(context.request_id),
        principal: PrincipalId(principal_id(&principal)),
        key_id: None,
        route: "/admin/providers/codex/banked-resets/consume".into(),
        started_at_ms: context.now_ms,
    };
    let actor = authenticate_admin_actor(&authority, platform, config, original, &request).await?;
    let action = match authority.prepare_manual_reset(&actor, config, hash).await? {
        ManualResetPreparation::Ready(action) => action,
        ManualResetPreparation::NeedsUsage(target) => {
            let usage = usage(store, platform, &target).await?;
            authority
                .begin_manual_reset(&target, config, &usage)
                .await?
        }
    };
    let invocation = action.invocation()?;
    let previous = store
        .read(&gateway_authority::keys::reset_redemption(
            &invocation.identity.account_id_hash,
            &invocation.identity.quota_generation,
        ))
        .await?;
    // A known prior operation is resolved by authority before any new inventory/consume.
    // First attempts select complete inventory before claiming a submission owner.
    let credit = if previous.is_none() {
        authority.prepare_manual_reset(&actor, config, hash).await?;
        Some(inventory(store, platform, action.target()).await?)
    } else {
        None
    };
    let verified = match authority.claim_manual_reset(&action, config).await? {
        ResetClaim::Verified(record) => record,
        ResetClaim::InProgress(_) | ResetClaim::Reconcile { .. } => {
            *phase = Some("pending");
            return Err(failure(
                409,
                "codex_reset_unverified",
                "Reset verification is pending.",
            ));
        }
        ResetClaim::Rejected(record) => {
            return Err(failure(
                422,
                record
                    .last_error_code
                    .as_deref()
                    .unwrap_or("codex_reset_rejected"),
                "Banked reset was not completed.",
            ));
        }
        ResetClaim::Disabled(reason) => {
            return Err(failure(422, reason, "Banked reset was not completed."));
        }
        ResetClaim::Submit { record, invocation } => {
            let credit = match credit {
                Some(credit) => credit,
                None => {
                    authority.prepare_manual_reset(&actor, config, hash).await?;
                    inventory(store, platform, action.target()).await?
                }
            };
            let record = authority
                .prepare_manual_reset_submission(&action, config, &record)
                .await?;
            *phase = Some("pending");
            let latest = RefCell::new(record);
            let account = account(store, action.target()).await?;
            let (_, consume) = endpoints(platform)?;
            let body = serde_json::to_vec(
                &json!({"redeem_request_id":invocation.idempotency_key,"credit_id":credit}),
            )
            .map_err(|_| unavailable("Reset request is invalid."))?;
            let destination = PinnedDestination::new(consume.as_str())?;
            let cancellation = platform.cancellation.child()?;
            let headers = headers(&account, true);
            let response = send_http(
                &destination,
                Method::Post,
                &headers,
                &body,
                &cancellation,
                || async {
                    let expected = latest.borrow().clone();
                    let renewed = authority
                        .renew_manual_reset_before_redeem(&action, config, &expected)
                        .await?;
                    *latest.borrow_mut() = renewed;
                    Ok(())
                },
            )
            .await;
            let code = match response {
                Ok(mut response) if (200..300).contains(&response.status_code()) => response
                    .bytes()
                    .await
                    .ok()
                    .and_then(|bytes| consume_code(&bytes)),
                Ok(mut response) => {
                    crate::transport::body::discard_response(&mut response);
                    None
                }
                Err(_) => None,
            };
            let state = match code.as_deref() {
                Some("reset" | "already_redeemed") => ResetState::Verified,
                Some("nothing_to_reset" | "no_credit") => ResetState::Rejected,
                _ => ResetState::Unknown,
            };
            let error = if state == ResetState::Rejected {
                code.as_deref()
            } else if state == ResetState::Unknown {
                Some("provider_outcome_unknown")
            } else {
                None
            };
            let observed = authority
                .record_reset_outcome(&latest.into_inner(), state, None, error, now_ms()?)
                .await?;
            if state != ResetState::Verified {
                if state == ResetState::Rejected {
                    *phase = None;
                }
                return Err(failure(
                    if state == ResetState::Unknown {
                        409
                    } else {
                        422
                    },
                    error.unwrap_or("codex_reset_unverified"),
                    "Banked reset was not completed.",
                ));
            }
            observed
        }
    };
    *phase = Some("verified");
    authority.prepare_manual_reset(&actor, config, hash).await?;
    let observation = usage(store, platform, action.target()).await.map_err(|_| failure(409,"codex_reset_usage_pending","Reset verified; current quota verification is pending. Check again without consuming another reset."))?;
    let promoted = authority
        .promote_manual_reset(&action, config, &verified, &observation)
        .await?;
    serde_json::to_value(promoted).map_err(|_| unavailable("Reset promotion response is invalid."))
}

async fn account(
    store: &RemoteAuthorityStore,
    target: &ManualResetTarget,
) -> Result<CodexSourceAccount, GatewayError> {
    let pool = read_codex_source_pool(store, now_ms()?)
        .await?
        .ok_or_else(|| unavailable("Subscription source is unavailable."))?;
    pool.pool
        .accounts
        .into_iter()
        .find(|account| {
            account.account_id == target.account_id()
                && account.identity().credential_version.0 == target.credential_version()
        })
        .ok_or_else(|| {
            failure(
                409,
                "codex_account_changed",
                "Subscription changed. Reload Providers.",
            )
        })
}
pub(super) fn headers(account: &CodexSourceAccount, content: bool) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::from([
        (
            "Authorization".into(),
            format!("Bearer {}", account.access_token.expose()),
        ),
        ("ChatGPT-Account-ID".into(), account.account_id.clone()),
        (
            "User-Agent".into(),
            "codex_cli_rs/0.100.0 (ai.ubq.fi)".into(),
        ),
    ]);
    if content {
        headers.insert("Content-Type".into(), "application/json".into());
    }
    headers
}
pub(super) fn endpoints(platform: &PlatformHost) -> Result<(Url, Url), GatewayError> {
    let base = crate::host::setting(&platform.env, "CODEX_BASE_URL")
        .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
    let mut url = Url::parse(gateway_schema::util::js_trim(&base))
        .map_err(|_| unavailable("Reset base URL is invalid."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(unavailable("Reset base URL is invalid."));
    }
    let path = match url.path().trim_end_matches('/') {
        "/backend-api" | "/backend-api/codex" => "/backend-api/wham/rate-limit-reset-credits",
        "" | "/api/codex" => "/api/codex/rate-limit-reset-credits",
        _ => return Err(unavailable("Reset base URL layout is unsupported.")),
    };
    url.set_path(path);
    let mut consume = url.clone();
    consume.set_path(&format!("{path}/consume"));
    Ok((url, consume))
}
pub(super) async fn get(
    platform: &PlatformHost,
    url: &Url,
    account: &CodexSourceAccount,
    deadline: Option<i32>,
) -> Result<Value, GatewayError> {
    let cancellation = platform.cancellation.child()?;
    let _deadline = deadline
        .map(|ms| cancellation.set_timeout_ms(ms))
        .transpose()?;
    let destination = PinnedDestination::new(url.as_str())?;
    let mut response = send_http(
        &destination,
        Method::Get,
        &headers(account, false),
        &[],
        &cancellation,
        || async { Ok(()) },
    )
    .await
    .map_err(|failure| failure.error)?;
    if !(200..300).contains(&response.status_code()) {
        crate::transport::body::discard_response(&mut response);
        return Err(unavailable("Reset observation is unavailable."));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|_| unavailable("Reset observation could not be read."))?;
    serde_json::from_slice(&bytes).map_err(|_| unavailable("Reset observation is invalid."))
}
async fn usage(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    target: &ManualResetTarget,
) -> Result<CapacityObservation, GatewayError> {
    let account = account(store, target).await?;
    let (base, _) = endpoints(platform)?;
    let url = base
        .join("/backend-api/wham/usage")
        .map_err(|_| unavailable("Usage URL is invalid."))?;
    let at = now_ms()?;
    let payload = get(platform, &url, &account, Some(8000)).await?;
    let windows =
        gateway_observability::capacity_shapes::parse_codex_usage(&payload).ok_or_else(|| {
            failure(
                409,
                "codex_quota_unavailable",
                "Current subscription quota is unavailable.",
            )
        })?;
    parse_capacity_observation(
        &json!({"slot":target.binding().slot,"account_id_hash":target.binding().account_id_hash.0,"state":"available","source_observed_at_ms":at,"snapshot_at_ms":now_ms()?,"windows":{"primary":windows["primary"],"secondary":windows["secondary"]},"additional_rate_limits":windows["additional_rate_limits"]}),
    )
}
async fn inventory(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    target: &ManualResetTarget,
) -> Result<String, GatewayError> {
    let account = account(store, target).await?;
    let (url, _) = endpoints(platform)?;
    let payload = get(platform, &url, &account, Some(5000)).await?;
    let at = now_ms()?;
    let credits = parse_inventory(&payload, at)?;
    select_reset_credit(
        &[AccountResetInventory {
            binding: target.binding().clone(),
            observed_at_ms: at,
            credits,
        }],
        at,
    )?
    .map(|selected| selected.credit.credit_id)
    .ok_or_else(|| {
        failure(
            422,
            "no_eligible_credit",
            "Banked reset was not completed: no eligible credit.",
        )
    })
}

pub(super) fn parse_inventory(payload: &Value, at: i64) -> Result<Vec<ResetCredit>, GatewayError> {
    let available = payload["available_count"]
        .as_f64()
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && (0.0..=gateway_core::identity::MAX_SAFE_INTEGER as f64).contains(n)
        })
        .map(|n| n as i64)
        .ok_or_else(|| unavailable("Reset inventory is incomplete."))?;
    let rows = payload["credits"]
        .as_array()
        .ok_or_else(|| unavailable("Reset inventory is incomplete."))?;
    let mut ids = BTreeSet::new();
    let mut credits = Vec::new();
    let mut count = 0;
    for row in rows {
        let text = |field| {
            row[field]
                .as_str()
                .filter(|s| !gateway_schema::util::js_trim(s).is_empty())
                .ok_or_else(|| unavailable("Reset inventory is invalid."))
        };
        let id = text("id")?;
        let status = text("status")?;
        let kind = text("reset_type")?;
        if !ids.insert(id) {
            return Err(unavailable("Reset inventory repeats a credit."));
        }
        let expiry = match row.get("expires_at") {
            Some(Value::Null) => None,
            Some(Value::String(value)) if !gateway_schema::util::js_trim(value).is_empty() => {
                let n = worker::js_sys::Date::parse(value);
                if !n.is_finite()
                    || n.fract() != 0.0
                    || !(0.0..=gateway_core::identity::MAX_SAFE_INTEGER as f64).contains(&n)
                {
                    return Err(unavailable("Reset expiry is invalid."));
                }
                Some(n as i64)
            }
            _ => return Err(unavailable("Reset expiry is invalid.")),
        };
        if status == "available" {
            count += 1;
        }
        credits.push(ResetCredit {
            credit_id: id.into(),
            expires_at_ms: expiry,
            observed_at_ms: at,
            eligible: status == "available" && kind == "codex_rate_limits",
        });
    }
    if count != available {
        return Err(unavailable("Reset inventory is incomplete."));
    }
    Ok(credits)
}
fn failure(status: u16, code: &str, message: &str) -> GatewayError {
    GatewayError::new(status, message, Some(code))
}
fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "codex_reset_unavailable")
}

fn consume_code(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let value = gateway_core::source_json::SourceJson::parse(
        text.strip_prefix('\u{feff}').unwrap_or(&text),
    )
    .ok()?;
    value
        .object_entries()
        .ok()?
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq("code".encode_utf16()))?
        .1
        .deserialize()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_terminal_ignores_unrelated_lossless_operator_text() {
        assert_eq!(
            consume_code(br#"{"code":"reset","unrelated":"\ud800"}"#).as_deref(),
            Some("reset")
        );
        assert_eq!(
            consume_code(b"\xef\xbb\xbf{\"code\":\"already_redeemed\"}").as_deref(),
            Some("already_redeemed")
        );
        assert_eq!(consume_code(br#"{"code":null}"#), None);
    }
    #[test]
    fn incomplete_credit_inventory_never_becomes_a_spend_candidate() {
        let one = json!({"id":"fixture-credit","status":"available","reset_type":"codex_rate_limits","expires_at":null});
        assert!(
            parse_inventory(&json!({"available_count":2,"credits":[one.clone()]}), 10).is_err()
        );
        assert!(
            parse_inventory(
                &json!({"available_count":2,"credits":[one.clone(),one.clone()]}),
                10
            )
            .is_err()
        );
        let credits = parse_inventory(&json!({"available_count":1.0,"credits":[one]}), 10).unwrap();
        assert_eq!(credits.len(), 1);
        assert!(credits[0].eligible);
    }
}
