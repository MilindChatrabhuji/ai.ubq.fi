//! One source full-pool evaluation. Only shared opaque permits reach a consume.
use super::{
    manual,
    source_inventory::{self, SourceRuntime},
};
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformHost, PlatformTokens},
    storage::now_ms,
    transport::outbound::{PinnedDestination, send_http},
};
use gateway_auth::{
    AuthConfig, AuthMethod, AuthRequest, AuthService,
    provider_credentials::{CodexSourceAccount, read_codex_source_pool},
};
use gateway_authority::{
    Authority,
    full_pool_reset::{
        AutomaticResetPermit, FullPoolEvaluation, FullPoolPreparation, SourceResetInventory,
    },
    reset::{FullPoolResetReconciliation, ResetClaim, ResetState},
    routing::{AdmittedAccount, CohortProof},
};
use gateway_core::{
    GatewayError,
    identity::{AccountBinding, RequestContext},
};
use gateway_routing_runtime::types::CodexRecovery;
use std::cell::RefCell;
use worker::Method;
type RuntimeAuthority = Authority<RemoteAuthorityStore, PlatformTokens>;

fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The original reset request or its current fences changed.",
        "codex_reset_request_changed",
    )
}
fn original_route_matches(method: &str, path: &str, route: &str) -> bool {
    matches!(
        (method, crate::normalized_path(path), route),
        ("POST", "/v1/responses", "responses")
            | ("POST", "/v1/chat/completions", "chat.completions")
    )
}
pub(crate) async fn check_client(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    original: &AuthRequest,
    config: &AuthConfig,
    request: &RequestContext,
) -> Result<(), GatewayError> {
    let principal = AuthService::new(store, platform, config)
        .authenticate_client(original)
        .await?;
    let key = match &principal.method {
        AuthMethod::KvApiKey { key_id, .. } => Some(key_id.as_str()),
        _ => None,
    };
    let url = worker::Url::parse(&original.url).map_err(|_| unavailable())?;
    if request.principal.0 != crate::lifecycle::principal_id(&principal)
        || request.key_id.as_ref().map(|id| id.0.as_str()) != key
        || !original_route_matches(&original.method, url.path(), &request.route)
    {
        return Err(GatewayError::new(
            401,
            "The original reset client is no longer authorized.",
            Some("unauthorized"),
        ));
    }
    Ok(())
}
async fn account(
    store: &RemoteAuthorityStore,
    binding: &AccountBinding,
) -> Result<CodexSourceAccount, GatewayError> {
    let source = read_codex_source_pool(store, now_ms()?)
        .await?
        .ok_or_else(unavailable)?;
    if source.revision != binding.pool_versionstamp.0 {
        return Err(unavailable());
    }
    let account = source
        .pool
        .accounts
        .into_iter()
        .nth(usize::try_from(binding.slot).map_err(|_| unavailable())?)
        .ok_or_else(unavailable)?;
    let identity = account.identity();
    if identity.routing_account_hash != binding.account_id_hash
        || identity.credential_version != binding.credential_version
    {
        return Err(unavailable());
    }
    Ok(account)
}

/// Does not reserve another request, create inference, refresh credentials or choose paid fallback.
pub async fn recover_full_pool(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    original: &AuthRequest,
    config: &AuthConfig,
    request: &RequestContext,
    proof: &CohortProof,
    model: &gateway_core::model::ModelId,
) -> Result<CodexRecovery, GatewayError> {
    check_client(store, platform, original, config, request).await?;
    if proof.model() != model {
        return Err(unavailable());
    }
    let authority = Authority::with_clock(store.clone(), PlatformTokens, PlatformClock);
    match authority.reconcile_full_pool_reset(proof, request).await {
        Ok(FullPoolResetReconciliation::Recovered(admission)) => {
            return Ok(CodexRecovery::Recovered(admission));
        }
        Ok(FullPoolResetReconciliation::NoExisting) => {}
        Ok(FullPoolResetReconciliation::Blocked { .. }) | Err(_) => {
            return Ok(CodexRecovery::Declined);
        }
    }
    let plan = match authority.prepare_full_pool_reset(proof, request).await {
        Ok(FullPoolPreparation::Observe(plan)) => *plan,
        Ok(FullPoolPreparation::Declined { .. } | FullPoolPreparation::Cached { .. }) | Err(_) => {
            return Ok(CodexRecovery::Declined);
        }
    };
    let bindings: Vec<_> = plan.bindings().cloned().collect();
    let observations = futures_util::future::join_all(bindings.iter().map(|binding| {
        let authority = &authority;
        async move {
            let current = account(store, binding).await?;
            let (url, _) = manual::endpoints(platform)?;
            let document = manual::get_source(platform, &url, &current, Some(5000), || async {
                check_client(store, platform, original, config, request).await?;
                account(store, binding).await?;
                match authority.prepare_full_pool_reset(proof, request).await? {
                    FullPoolPreparation::Declined { .. } => Err(unavailable()),
                    FullPoolPreparation::Observe(_) | FullPoolPreparation::Cached { .. } => Ok(()),
                }
            })
            .await?;
            source_inventory::parse_inventory(&document, binding, now_ms()?, |value| {
                SourceRuntime.date(value)
            })
        }
    }))
    .await;
    let inventories = match observations
        .into_iter()
        .collect::<Result<Vec<SourceResetInventory>, GatewayError>>()
    {
        Ok(inventories) => inventories,
        Err(error) if matches!(error.status, 401 | 403) => return Err(error),
        Err(_) => return Ok(CodexRecovery::Declined),
    };
    let permit = match authority
        .finish_full_pool_reset(plan, &inventories, &SourceRuntime)
        .await
    {
        Ok(FullPoolEvaluation::Ready(permit)) => permit,
        Ok(FullPoolEvaluation::Declined { .. } | FullPoolEvaluation::Shadow { .. }) | Err(_) => {
            return Ok(CodexRecovery::Declined);
        }
    };
    let recovered = match submit(&authority, store, platform, original, config, &permit).await {
        Ok(recovered) => recovered,
        Err(error) if matches!(error.status, 401 | 403) => return Err(error),
        Err(_) => return Ok(CodexRecovery::Declined),
    };
    Ok(recovered.map_or(CodexRecovery::Declined, CodexRecovery::Recovered))
}

async fn submit(
    authority: &RuntimeAuthority,
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    original: &AuthRequest,
    config: &AuthConfig,
    permit: &AutomaticResetPermit,
) -> Result<Option<AdmittedAccount>, GatewayError> {
    let verified = match authority.claim_full_pool_reset(permit).await? {
        ResetClaim::Verified(record) => record,
        ResetClaim::InProgress(_)
        | ResetClaim::Reconcile { .. }
        | ResetClaim::Rejected(_)
        | ResetClaim::Disabled(_) => return Ok(None),
        ResetClaim::Submit { record, .. } => {
            let record = authority
                .prepare_full_pool_reset_submission(permit, &record)
                .await?;
            let current = account(store, permit.binding()).await?;
            let (_, url) = manual::endpoints(platform)?;
            let destination = PinnedDestination::new(url.as_str())?;
            let cancellation = platform.cancellation.child()?;
            let headers = manual::headers(&current, true);
            let body = permit.consume_body()?;
            let latest = RefCell::new(record);
            let response = send_http(
                &destination,
                Method::Post,
                &headers,
                body.as_bytes(),
                &cancellation,
                || async {
                    check_client(store, platform, original, config, permit.original()).await?;
                    account(store, permit.binding()).await?;
                    let expected = latest.borrow().clone();
                    let renewed = authority
                        .renew_full_pool_reset_before_redeem(permit, &expected)
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
                    .and_then(|body| manual::consume_code(&body)),
                Ok(mut response) => {
                    crate::transport::body::discard_response(&mut response);
                    None
                }
                Err(failure) if matches!(failure.error.status, 401 | 403) => {
                    return Err(failure.error);
                }
                Err(_) => None,
            };
            let (state, receipt, error) = match code.as_deref() {
                Some("reset") => (ResetState::Verified, Some("upstream-reset"), None),
                Some("already_redeemed") => (
                    ResetState::Verified,
                    Some("upstream-already-redeemed"),
                    None,
                ),
                Some("nothing_to_reset") => (ResetState::Rejected, None, Some("nothing_to_reset")),
                Some("no_credit") => (ResetState::Rejected, None, Some("no_credit")),
                _ => (ResetState::Unknown, None, Some("provider_outcome_unknown")),
            };
            let record = authority
                .record_reset_outcome(&latest.into_inner(), state, receipt, error, now_ms()?)
                .await?;
            if state != ResetState::Verified {
                return Ok(None);
            }
            record
        }
    };
    authority.elect_full_pool_reset(permit, &verified).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn original_route_matches_only_normalized_post_inference() {
        for (method, path, route, expected) in [
            ("POST", "/v1/responses", "responses", true),
            ("POST", "/v1/chat/completions", "chat.completions", true),
            ("POST", "/v1/responses///", "responses", true),
            ("POST", "/v1/chat/completions/", "chat.completions", true),
            ("GET", "/v1/responses", "responses", false),
            ("PUT", "/v1/chat/completions", "chat.completions", false),
            ("post", "/v1/responses", "responses", false),
            ("POST", "/v1/responses", "chat.completions", false),
            ("POST", "/v1/chat/completions", "responses", false),
            ("POST", "/v1/responses", "/v1/responses", false),
            ("POST", "/v1/images/generations", "responses", false),
            ("POST", "/v1/%72esponses", "responses", false),
            ("POST", "//v1/responses", "responses", false),
            ("POST", "/", "responses", false),
        ] {
            assert_eq!(
                super::original_route_matches(method, path, route),
                expected,
                "{method} {path} with route {route}"
            );
        }
    }
}
