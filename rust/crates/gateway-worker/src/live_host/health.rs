//! Optional source health writes never decide live account eligibility or paid continuation.
use gateway_auth::provider_credentials::codex_access_expiry_ms;
use gateway_live_runtime::types::{LiveAccount, LiveDispatchFailure, LiveResponse};
use gateway_observability::{
    ObservabilityRuntime,
    types::{HealthEvent, HealthTarget},
};
use std::rc::Rc;
use worker::Context;

use super::{Body, account::CurrentLiveAccount};

pub(super) async fn response(
    store: crate::authority::RemoteAuthorityStore,
    account: &CurrentLiveAccount,
    response: &LiveResponse<Body>,
    context: Rc<Context>,
) {
    let expired = codex_access_expiry_ms(&account.source.access_token)
        .is_some_and(|expiry| expiry <= crate::storage::now_ms().unwrap_or(i64::MAX) as f64);
    let event = match response.status {
        401 => HealthEvent::AuthInvalid,
        403 if expired => HealthEvent::AuthInvalid,
        429 => HealthEvent::QuotaExhausted,
        500..=599 => HealthEvent::UpstreamError,
        200..=299 => HealthEvent::Success,
        _ => HealthEvent::Reachable,
    };
    let runtime = runtime(store);
    if response.status == 429 || (200..300).contains(&response.status) || response.status >= 500 {
        let background = runtime.clone();
        let status = response.status;
        context.wait_until(async move {
            if status >= 500
                && let Ok(now) = crate::storage::now_ms()
            {
                background
                    .record_capacity_downtime("upstream_error", Some(status), now)
                    .await;
            }
            let _ = background.trigger_capacity_sample().await;
        });
    }
    let request_id = ["x-request-id", "x-api-request-id", "x-oneapi-request-id"]
        .iter()
        .find_map(|name| response.headers.get(*name));
    let _ = runtime
        .observe_provider(
            HealthTarget::codex(account.account_id()),
            event,
            Some(response.status),
            request_id.map(String::as_str),
        )
        .await;
}

pub(super) async fn failure(
    store: crate::authority::RemoteAuthorityStore,
    account: &CurrentLiveAccount,
    failure: &LiveDispatchFailure<Body>,
    context: Rc<Context>,
) {
    let code = match &failure.response.body {
        Body::Bytes(bytes) => serde_json::from_slice::<serde_json::Value>(bytes)
            .ok()
            .and_then(|value| value["error"]["code"].as_str().map(str::to_owned)),
        _ => None,
    };
    if matches!(
        code.as_deref(),
        Some(
            "codex_auth_refresh_failed"
                | "refresh_token_reused"
                | "codex_auth_refresh_unreachable"
                | "codex_auth_owner_unavailable"
                | "codex_auth_owner_conflict"
        )
    ) {
        return;
    }
    let runtime = runtime(store);
    let _ = runtime
        .observe_provider(
            HealthTarget::codex(account.account_id()),
            HealthEvent::UpstreamError,
            None,
            None,
        )
        .await;
    if matches!(
        code.as_deref(),
        Some("gateway_timeout" | "codex_upstream_unreachable")
    ) {
        let status = (500..600)
            .contains(&failure.response.status)
            .then_some(failure.response.status);
        context.wait_until(async move {
            if let Ok(now) = crate::storage::now_ms() {
                runtime
                    .record_capacity_downtime("unreachable", status, now)
                    .await;
            }
            let _ = runtime.trigger_capacity_sample().await;
        });
    }
}

fn runtime(
    store: crate::authority::RemoteAuthorityStore,
) -> ObservabilityRuntime<crate::authority::RemoteAuthorityStore, crate::observability_host::Host> {
    ObservabilityRuntime::with_state(
        store,
        crate::observability_host::Host,
        crate::observability_host::shared_state(),
    )
}
