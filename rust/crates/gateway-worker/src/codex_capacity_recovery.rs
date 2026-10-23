//! Request-owned observation only. The existing journal owns the single recovery
//! attempt; this module cannot reset, refresh credentials or select paid hops.
use gateway_auth::provider_credentials::{CodexSourceSnapshot, read_codex_source_pool};
use gateway_authority::{
    Authority, TokenSource,
    capacity::{CodexCapacityAccountRef, CodexCapacitySample},
    routing::{CapacityState, CohortProof, RouteSelection},
};
use gateway_core::{GatewayError, model::ModelId, state::AuthorityStore};
use gateway_observability::{
    capacity_shapes,
    host_types::{CapacityAccountRef, CapacityProbe},
    types::ObservabilityHost,
};
use std::future::Future;

fn changed() -> GatewayError {
    GatewayError::unavailable(
        "The original capacity recovery source changed.",
        "codex_capacity_source_changed",
    )
}
fn matches_proof(snapshot: &CodexSourceSnapshot, proof: &CohortProof) -> bool {
    proof.account_bindings().iter().all(|binding| {
        snapshot.revision == binding.pool_versionstamp.0
            && usize::try_from(binding.slot)
                .ok()
                .and_then(|slot| snapshot.pool.accounts.get(slot))
                .is_some_and(|account| {
                    let id = account.identity();
                    id.routing_account_hash == binding.account_id_hash
                        && id.credential_version == binding.credential_version
                })
    })
}
async fn current<S: AuthorityStore>(
    store: &S,
    proof: &CohortProof,
    now: i64,
) -> Result<CodexSourceSnapshot, GatewayError> {
    read_codex_source_pool(store, now)
        .await?
        .filter(|snapshot| matches_proof(snapshot, proof))
        .ok_or_else(changed)
}

/// Existing observation ports retain actual clock/GET/parse/atomic publication
/// ownership. No stored observation is restamped as a new upstream result.
pub(super) async fn observe<S, I, H, F, C>(
    store: &S,
    authority: &Authority<S, I>,
    host: &H,
    proof: &CohortProof,
    model: &ModelId,
    check_original: F,
) -> Result<Option<RouteSelection>, GatewayError>
where
    S: AuthorityStore,
    I: TokenSource,
    H: ObservabilityHost,
    F: Fn() -> C,
    C: Future<Output = Result<(), GatewayError>>,
{
    check_original().await?;
    if proof.model() != model
        || !proof.full_cohort_exhausted()
        || !proof.full_cohort_unavailable()
        || !(1..=2).contains(&proof.selected_count())
    {
        return Err(changed());
    }
    let snapshot = current(store, proof, host.now_ms()).await?;
    let accounts: Vec<_> = proof
        .account_bindings()
        .iter()
        .map(|binding| {
            let slot = usize::try_from(binding.slot).map_err(|_| changed())?;
            let source_slot = u8::try_from(slot + 1).map_err(|_| changed())?;
            Ok(CapacityAccountRef {
                slot: source_slot,
                account_id: snapshot.pool.accounts[slot].account_id.clone(),
                label: None,
            })
        })
        .collect::<Result<_, GatewayError>>()?;
    let fence = host.begin_codex_capacity_observation(&accounts).await?;
    // All selected GETs share the existing eight-second observational phase and
    // inherit the parent platform cancellation/deadline, not an inference retry.
    let at = fence.observed_at_ms();
    let deadline = at.checked_add(8000).ok_or_else(changed)?;
    let mut samples = Vec::with_capacity(accounts.len());
    for account in accounts {
        check_original().await?;
        current(store, proof, host.now_ms()).await?;
        let probe = host
            .probe_codex_capacity(&account, &fence, deadline)
            .await?;
        check_original().await?;
        if host.now_ms() >= deadline {
            return Ok(None);
        }
        let CapacityProbe::Http {
            status: 200..=299,
            json: Some(json),
        } = probe
        else {
            return Ok(None);
        };
        let Some(windows) = capacity_shapes::parse_codex_usage(&json) else {
            return Ok(None);
        };
        samples.push(CodexCapacitySample {
            account: CodexCapacityAccountRef {
                source_slot: account.slot,
                account_id: account.account_id,
            },
            state: CapacityState::Available,
            source_observed_at_ms: Some(at),
            snapshot_at_ms: at,
            windows: serde_json::from_value(windows.clone()).map_err(|_| changed())?,
            additional_rate_limits: serde_json::from_value(serde_json::json!(
                capacity_shapes::additional_for_routing(&windows["additional_rate_limits"], at)
            ))
            .map_err(|_| changed())?,
        });
    }
    check_original().await?;
    current(store, proof, host.now_ms()).await?;
    host.accept_capacity_observations(&fence, &samples).await?;
    check_original().await?;
    // Reconcile each exhausted account's class block from this current sample
    // before reselecting. Otherwise a retained ambiguous deadline can leave the
    // full-pool reset fence stale even though the provider window is current.
    authority
        .materialize_capacity_quota_blocks(model, proof.quota_class(), host.now_ms())
        .await?;
    check_original().await?;
    // New C and the materialized class blocks invalidate the original proof.
    // Preserve genuine exhaustion through a new ordinary selection/proof.
    Ok(Some(
        authority
            .select_account(model, proof.quota_class(), host.now_ms())
            .await?,
    ))
}

#[cfg(test)]
#[path = "codex_capacity_recovery_tests.rs"]
mod tests;
