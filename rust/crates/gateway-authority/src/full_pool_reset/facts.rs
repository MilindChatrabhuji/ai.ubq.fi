use super::{Facts, FullPoolFence, Member, declined, invalid};
use crate::{
    Authority, TokenSource, keys,
    reset::{ResetCandidate, ResetConfig, ResetMode, reset_invocation},
    routing::{CohortProof, read_view, validate_cohort},
    store::Transaction,
};
use gateway_auth::provider_credentials::{codex_source_pool_key, parse_codex_source_pool};
use gateway_core::{
    GatewayError,
    identity::{MAX_SAFE_INTEGER, RequestContext},
    state::AuthorityStore,
};
use serde_json::{Value, json};

fn marker_key() -> gateway_core::state::RecordKey {
    gateway_auth::store::key(json!([
        "uos_ai",
        "migrations",
        "codex_reset_usage_legacy_global_v1"
    ]))
}
fn legacy_key() -> gateway_core::state::RecordKey {
    gateway_auth::store::key(json!(["uos_ai", "codex_banked_reset_usage", "v1"]))
}
fn opt_out(value: Option<&Value>) -> bool {
    value.is_some_and(|value| *value == false || (!value.is_null() && !value.is_boolean()))
}
pub(super) fn policy(config: &ResetConfig) -> Result<(), GatewayError> {
    let reason = if !config.enabled {
        Some("feature_disabled")
    } else if config.mode == ResetMode::Disabled {
        Some("mode_disabled")
    } else if config.max_per_account_per_day <= 0 {
        Some("per_account_day_limit_invalid")
    } else if config.max_per_account_per_window != 1 {
        Some("per_account_window_limit_invalid")
    } else if config.mode == ResetMode::Live && config.max_per_account_per_day != 1 {
        Some("terminal_outcome_account_day_limit_must_be_one")
    } else if config.mode == ResetMode::Live
        && (!config.provider_approved || !config.redeem_outcome_is_final)
    {
        Some("provider_contract_unproven")
    } else {
        None
    };
    reason.map_or(Ok(()), |reason| Err(declined(reason)))
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    /// Existing one-way source reset-setting completion; no new state/key family.
    /// Other source settings readers may reuse this operation rather than duplicate it.
    pub async fn migrate_full_pool_reset_settings(&self) -> Result<bool, GatewayError> {
        for _ in 0..4 {
            let now = self.fresh_time(0)?;
            let mut tx = self.transaction(now)?;
            let marker = marker_key();
            if tx
                .read::<Value>(&marker)
                .await?
                .is_some_and(|value| !value.is_null())
            {
                return Ok(true);
            }
            let legacy = tx.read::<Value>(&legacy_key()).await?;
            let Some(raw) = tx.read::<Value>(&codex_source_pool_key()).await? else {
                return Ok(false);
            };
            let Some(pool) = parse_codex_source_pool(&raw).ok().flatten() else {
                return Ok(false);
            };
            if pool.accounts.is_empty() {
                return Ok(false);
            }
            let preserved = opt_out(legacy.as_ref());
            if preserved {
                for account in pool.accounts {
                    let hash = gateway_auth::crypto::sha256_hex(account.account_id.as_bytes());
                    let key = keys::reset_usage(&hash);
                    if tx
                        .read::<Value>(&key)
                        .await?
                        .is_none_or(|value| value.is_null())
                    {
                        tx.put(&key, &json!({"enabled":false}), None)?;
                    }
                }
            }
            tx.put(
                &marker,
                &json!({"completed_at_ms":now,"preserved_opt_out":preserved}),
                None,
            )?;
            tx.now = self.fresh_time(now)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

pub(super) async fn capture<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    proof: &CohortProof,
    original: &RequestContext,
) -> Result<Facts, GatewayError> {
    capture_for(tx, proof, original, CapturePurpose::NewSpend).await
}
pub(super) async fn capture_reconciliation<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    proof: &CohortProof,
    original: &RequestContext,
) -> Result<Facts, GatewayError> {
    capture_for(tx, proof, original, CapturePurpose::ExistingLedger).await
}
#[derive(Clone, Copy)]
enum CapturePurpose {
    NewSpend,
    ExistingLedger,
}
async fn capture_for<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    proof: &CohortProof,
    original: &RequestContext,
    purpose: CapturePurpose,
) -> Result<Facts, GatewayError> {
    if !proof.full_cohort_exhausted()
        || proof.account_bindings().is_empty()
        || !validate_cohort(tx, proof, true).await?
    {
        return Err(declined("routing_fence_stale"));
    }
    if original.request_id.0.trim().is_empty()
        || original.started_at_ms < 0
        || original.started_at_ms > tx.now
        || original.started_at_ms > MAX_SAFE_INTEGER
    {
        return Err(invalid());
    }
    let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
    policy(&config)?;
    if tx
        .read::<Value>(&marker_key())
        .await?
        .is_none_or(|value| value.is_null())
    {
        return Err(declined("configuration_unavailable"));
    }
    let view = read_view(tx).await?;
    if view.state.legacy_identity_unresolved {
        return Err(declined("invalid_quota_generation"));
    }
    let mut members = Vec::new();
    let mut fences = Vec::new();
    let mut versions = Vec::new();
    for binding in proof.account_bindings() {
        let index = usize::try_from(binding.slot).map_err(|_| invalid())?;
        let account = view.pool.accounts.get(index).ok_or_else(invalid)?;
        let state = view.state.slots.get(index).ok_or_else(invalid)?;
        if view.binding(index) != *binding || !account.enabled {
            return Err(declined("routing_fence_stale"));
        }
        let block = state
            .quota_block_for(proof.quota_class())
            .ok_or_else(|| declined("routing_fence_missing"))?;
        let reset = block
            .reset_at_ms
            .ok_or_else(|| declined("invalid_quota_generation"))?;
        let current = match purpose {
            CapturePurpose::NewSpend => {
                !block.reset_ambiguous
                    && !state.reset_identity_ambiguous
                    && reset == block.blocked_until_ms
                    && reset > tx.now
            }
            // Source staleVerifiedResetProbeEligible retains a stable old
            // observation beneath a newer block. This read-only path grants
            // no inventory, audit insertion or new-spend permission.
            CapturePurpose::ExistingLedger => block.blocked_until_ms >= reset,
        };
        if !block.reset_is_stable || !current {
            return Err(declined("invalid_quota_generation"));
        }
        let invocation = reset_invocation(
            &account.admin_account_hash.0,
            &binding.credential_version.0,
            reset,
        )?;
        let key = keys::reset_usage(&account.admin_account_hash.0);
        let setting: Option<Value> = tx.read(&key).await?;
        let enabled = setting.as_ref().is_none_or(|value| {
            value.is_null() || value.get("enabled").and_then(Value::as_bool) == Some(true)
        });
        versions.push(if setting.is_none() {
            "unset".into()
        } else {
            tx.revision(&key).unwrap_or_else(|| "unset".into())
        });
        fences.push(FullPoolFence {
            slot: binding.slot,
            account_id_hash: invocation.identity.account_id_hash,
            quota_generation: invocation.identity.quota_generation,
            routing_generation: binding.routing_generation,
            quota_reset_at_ms: reset,
        });
        members.push(Member {
            candidate: ResetCandidate {
                binding: binding.clone(),
                quota_reset_at_ms: reset,
                request_started_at_ms: tx.now,
                proof: proof.clone(),
            },
            administrative_hash: account.admin_account_hash.0.clone(),
            enabled,
        });
    }
    if !members.iter().any(|member| member.enabled) {
        return Err(declined("usage_disabled"));
    }
    let settings_version = versions.join(",");
    let episode_hash = super::audit::episode_hash(&settings_version, &fences);
    Ok(Facts {
        proof: proof.clone(),
        original: original.clone(),
        config,
        members,
        fences,
        settings_version,
        episode_hash,
    })
}

pub(super) fn same(left: &Facts, right: &Facts) -> bool {
    left.episode_hash == right.episode_hash
        && left.settings_version == right.settings_version
        && left.fences == right.fences
        && left.config == right.config
        && left
            .members
            .iter()
            .map(|member| (&member.candidate.binding, member.enabled))
            .eq(right
                .members
                .iter()
                .map(|member| (&member.candidate.binding, member.enabled)))
}
