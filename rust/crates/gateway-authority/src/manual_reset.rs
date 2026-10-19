//! Explicit authenticated manual reset. Shares the existing redemption/day records.
//! Provider usage/inventory/consume I/O belongs to the fixed admin host, outside transactions.
use crate::native_control::actor::{self, NativeActorScope, NativeRenewalActor, StoredNativeActor};
use crate::reset::{
    self, AccountDayBudget, ResetClaim, ResetConfig, ResetInvocation, ResetMode, ResetRecord,
    ResetState,
};
use crate::routing::{self, CapacityObservation, CapacityState, RoutingView};
use crate::{Authority, TokenSource, keys, store::Transaction};
use gateway_auth::{
    AuthConfig,
    provider_credentials::{
        codex_access_expiry_ms, codex_source_pool_key, parse_codex_source_pool,
    },
};
use gateway_core::{
    GatewayError,
    identity::{AccountBinding, ActiveSelection, ActiveTransitionReason, MAX_SAFE_INTEGER},
    state::{AuthorityStore, RecordKey},
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn intent_key(hash: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("codex_manual_reset"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String(hash),
    ])
    .to_record_key()
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManualIntent {
    pub v: u8,
    pub account_id_hash: String,
    pub credential_version: String,
    pub quota_reset_at_ms: i64,
    pub routing_generation: u64,
    pub created_at_ms: i64,
    pub promoted_at_ms: Option<i64>,
    pub quota_signal_at_ms: Option<i64>,
}
pub fn parse_manual_intent(value: &Value) -> Result<ManualIntent, GatewayError> {
    if value.as_object().is_none_or(|v| v.len() != 8) {
        return Err(error(409, "codex_reset_intent_invalid"));
    }
    let row: ManualIntent = serde_json::from_value(value.clone())
        .map_err(|_| error(409, "codex_reset_intent_invalid"))?;
    let valid_hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if row.v != 1
        || !valid_hash(&row.account_id_hash)
        || !valid_hash(&row.credential_version)
        || !(0..=MAX_SAFE_INTEGER).contains(&row.quota_reset_at_ms)
        || !(0..=MAX_SAFE_INTEGER).contains(&row.created_at_ms)
        || row.routing_generation > MAX_SAFE_INTEGER as u64
        || row
            .promoted_at_ms
            .is_some_and(|v| v < row.created_at_ms || v > MAX_SAFE_INTEGER)
        || row
            .quota_signal_at_ms
            .is_some_and(|v| !(0..=MAX_SAFE_INTEGER).contains(&v))
    {
        return Err(error(409, "codex_reset_intent_invalid"));
    }
    Ok(row)
}
/// Minted only from a real admin actor. No serde/public constructor.
pub struct ManualResetTarget {
    actor: StoredNativeActor,
    account_id: String,
    hash: String,
    binding: AccountBinding,
}
impl ManualResetTarget {
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn credential_version(&self) -> &str {
        &self.binding.credential_version.0
    }
    pub fn binding(&self) -> &AccountBinding {
        &self.binding
    }
}
pub struct ManualResetAction {
    target: ManualResetTarget,
    intent: ManualIntent,
}
impl ManualResetAction {
    pub fn account_id(&self) -> &str {
        self.target.account_id()
    }
    pub fn credential_version(&self) -> &str {
        self.target.credential_version()
    }
    pub fn intent(&self) -> &ManualIntent {
        &self.intent
    }
    pub fn target(&self) -> &ManualResetTarget {
        &self.target
    }
    pub fn invocation(&self) -> Result<ResetInvocation, GatewayError> {
        reset::reset_invocation(
            &self.intent.account_id_hash,
            &self.intent.credential_version,
            self.intent.quota_reset_at_ms,
        )
    }
}
pub enum ManualResetPreparation {
    NeedsUsage(ManualResetTarget),
    Ready(ManualResetAction),
}
#[derive(Debug, Deserialize, Serialize)]
pub struct ManualResetPromotion {
    pub reset_status: String,
    pub active_account_id_hash: String,
}

async fn policy<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
) -> Result<(), GatewayError> {
    let policy: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
    let reason = if !policy.enabled {
        Some("feature_disabled")
    } else if policy.mode == ResetMode::Disabled {
        Some("mode_disabled")
    } else if policy.max_per_account_per_day != 1 {
        Some("per_account_day_limit_invalid")
    } else if policy.max_per_account_per_window != 1 {
        Some("per_account_window_limit_invalid")
    } else {
        None
    };
    if let Some(reason) = reason {
        return Err(error(409, reason));
    }
    Ok(())
}
async fn current<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    actor: &StoredNativeActor,
    config: &AuthConfig,
    hash: &str,
) -> Result<(RoutingView, String), GatewayError> {
    policy(tx).await?;
    if actor::read_current(tx, actor, config).await?.scope != NativeActorScope::Admin {
        return Err(error(403, "admin_auth_required"));
    }
    let raw: Value = tx
        .read(&codex_source_pool_key())
        .await?
        .ok_or_else(|| error(409, "codex_account_changed"))?;
    let source =
        parse_codex_source_pool(&raw)?.ok_or_else(|| error(409, "codex_account_changed"))?;
    let (slot, account) = source
        .accounts
        .iter()
        .enumerate()
        .find(|(_, a)| a.identity().administrative_account_hash.0 == hash)
        .ok_or_else(|| error(409, "codex_account_changed"))?;
    if codex_access_expiry_ms(&account.access_token).is_some_and(|v| v <= tx.now as f64) {
        return Err(error(409, "codex_auth_invalid"));
    }
    let view = routing::read_view(tx).await?;
    let identity = account.identity();
    if view.pool.pool_versionstamp.0
        != tx
            .revision(&codex_source_pool_key())
            .ok_or_else(|| error(409, "codex_account_changed"))?
        || view.pool.accounts.get(slot).is_none_or(|a| {
            a.account_id_hash != identity.routing_account_hash
                || a.credential_version != identity.credential_version
                || a.admin_account_hash != identity.administrative_account_hash
        })
    {
        return Err(error(409, "codex_account_changed"));
    }
    if !view.pool.accounts[slot].enabled {
        return Err(error(409, "codex_provider_disabled"));
    }
    Ok((view, account.account_id.clone()))
}
fn slot(view: &RoutingView, hash: &str) -> Result<usize, GatewayError> {
    view.pool
        .accounts
        .iter()
        .position(|a| a.admin_account_hash.0 == hash)
        .ok_or_else(|| error(409, "codex_account_changed"))
}
fn checked_target(
    view: &RoutingView,
    account: &str,
    target: &ManualResetTarget,
) -> Result<usize, GatewayError> {
    let index = slot(view, &target.hash)?;
    if account != target.account_id
        || view.pool.accounts[index].credential_version != target.binding.credential_version
    {
        return Err(error(409, "codex_account_changed"));
    }
    Ok(index)
}
async fn read_intent<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    hash: &str,
) -> Result<Option<ManualIntent>, GatewayError> {
    tx.read::<Value>(&intent_key(hash))
        .await?
        .as_ref()
        .map(parse_manual_intent)
        .transpose()
}
fn observation(
    row: &CapacityObservation,
    target: &ManualResetTarget,
    now: i64,
) -> Result<(), GatewayError> {
    if row.account_id_hash != target.binding.account_id_hash
        || u64::from(row.slot) != target.binding.slot
        || row.state != CapacityState::Available
        || row.source_observed_at_ms != Some(row.snapshot_at_ms)
        || row.snapshot_at_ms > now
        || row.snapshot_at_ms < 0
        || row.snapshot_at_ms < now.saturating_sub(30_000)
        || (row.windows.primary.is_none() && row.windows.secondary.is_none())
    {
        return Err(error(409, "codex_quota_unavailable"));
    }
    Ok(())
}
fn deadline(row: &CapacityObservation, now: i64) -> Result<i64, GatewayError> {
    let windows = [row.windows.primary.as_ref(), row.windows.secondary.as_ref()]
        .into_iter()
        .flatten()
        .filter(|w| w.reset_at_ms.is_some_and(|at| at > now))
        .collect::<Vec<_>>();
    let exhausted = windows.iter().any(|w| w.used_percent == Some(100.0));
    windows
        .into_iter()
        .filter(|w| !exhausted || w.used_percent == Some(100.0))
        .filter_map(|w| w.reset_at_ms)
        .max()
        .ok_or_else(|| error(409, "codex_quota_identity_unavailable"))
}
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn prepare_manual_reset(
        &self,
        actor: &NativeRenewalActor,
        config: &AuthConfig,
        hash: &str,
    ) -> Result<ManualResetPreparation, GatewayError> {
        if actor.scope() != NativeActorScope::Admin
            || hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(error(403, "admin_auth_required"));
        }
        for _ in 0..3 {
            let mut tx = self.transaction(self.fresh_time(0)?)?;
            let (view, account) = current(&mut tx, actor.stored(), config, hash).await?;
            let index = slot(&view, hash)?;
            let target = ManualResetTarget {
                actor: actor.stored().clone(),
                account_id: account,
                hash: hash.into(),
                binding: view.binding(index),
            };
            let prior = read_intent(&mut tx, hash).await?;
            let result = if let Some(intent) = prior.filter(|r| r.promoted_at_ms.is_none()) {
                if intent.credential_version != target.binding.credential_version.0 {
                    return Err(error(409, "codex_account_changed"));
                }
                ManualResetPreparation::Ready(ManualResetAction { target, intent })
            } else {
                let existing = read_intent(&mut tx, hash).await?;
                if existing.is_some_and(|r| {
                    reset::utc_day(r.created_at_ms).ok() == reset::utc_day(tx.now).ok()
                }) {
                    return Err(error(409, "codex_reset_already_completed"));
                }
                manual_budget(&mut tx, hash).await?;
                ManualResetPreparation::NeedsUsage(target)
            };
            actor.bind_preparation(&mut tx).await?;
            actor::validate_current_time(actor.stored(), self.fresh_time(tx.now)?)?;
            if tx.commit().await? {
                return Ok(result);
            }
        }
        Err(error(409, "codex_reset_concurrent_update"))
    }
    pub async fn begin_manual_reset(
        &self,
        target: &ManualResetTarget,
        config: &AuthConfig,
        usage: &CapacityObservation,
    ) -> Result<ManualResetAction, GatewayError> {
        let mut tx = self.transaction(self.fresh_time(0)?)?;
        let (view, account) = current(&mut tx, &target.actor, config, &target.hash).await?;
        let index = checked_target(&view, &account, target)?;
        let prior = read_intent(&mut tx, &target.hash).await?;
        if prior.as_ref().is_some_and(|r| r.promoted_at_ms.is_none()) {
            return Err(error(409, "codex_reset_concurrent_update"));
        }
        manual_budget(&mut tx, &target.hash).await?;
        observation(usage, target, self.fresh_time(tx.now)?)?;
        let quota = deadline(usage, tx.now)?;
        if prior.as_ref().is_some_and(|r| {
            r.quota_reset_at_ms == quota
                || reset::utc_day(r.created_at_ms).ok() == reset::utc_day(tx.now).ok()
        }) {
            return Err(error(409, "codex_reset_already_completed"));
        }
        let state = &view.state.slots[index];
        if state.invalid_credential_version.as_ref() == Some(&target.binding.credential_version) {
            return Err(error(409, "codex_auth_invalid"));
        }
        let intent = ManualIntent {
            v: 1,
            account_id_hash: target.hash.clone(),
            credential_version: target.binding.credential_version.0.clone(),
            quota_reset_at_ms: quota,
            routing_generation: state.generation,
            created_at_ms: self.fresh_time(tx.now)?,
            promoted_at_ms: None,
            quota_signal_at_ms: state.quota_signal_observed_at_ms,
        };
        tx.put(&intent_key(&target.hash), &intent, None)?;
        if !tx.commit().await? {
            return Err(error(409, "codex_reset_concurrent_update"));
        }
        Ok(ManualResetAction {
            target: ManualResetTarget {
                actor: target.actor.clone(),
                account_id: target.account_id.clone(),
                hash: target.hash.clone(),
                binding: view.binding(index),
            },
            intent,
        })
    }
    async fn manual_fences(
        &self,
        tx: &mut Transaction<'_, S, I>,
        action: &ManualResetAction,
        config: &AuthConfig,
        spending: bool,
    ) -> Result<(RoutingView, usize), GatewayError> {
        let (view, account) =
            current(tx, &action.target.actor, config, &action.target.hash).await?;
        let index = checked_target(&view, &account, &action.target)?;
        if read_intent(tx, &action.target.hash).await?.as_ref() != Some(&action.intent)
            || action.intent.promoted_at_ms.is_some()
        {
            return Err(error(409, "codex_reset_already_completed"));
        }
        let now = self.fresh_time(tx.now)?;
        actor::validate_current_time(&action.target.actor, now)?;
        tx.now = now;
        if spending {
            let state = &view.state.slots[index];
            if now < action.intent.created_at_ms
                || now - action.intent.created_at_ms >= 30_000
                || action.intent.quota_reset_at_ms <= now
                || state.generation != action.intent.routing_generation
                || state.quota_signal_observed_at_ms != action.intent.quota_signal_at_ms
                || u64::try_from(index).ok() != Some(action.target.binding.slot)
            {
                return Err(error(409, "codex_reset_concurrent_update"));
            }
        }
        Ok((view, index))
    }
    pub async fn claim_manual_reset(
        &self,
        action: &ManualResetAction,
        config: &AuthConfig,
    ) -> Result<ResetClaim, GatewayError> {
        for _ in 0..4 {
            let mut tx = self.transaction(self.fresh_time(0)?)?;
            self.manual_fences(&mut tx, action, config, false).await?;
            let invocation = action.invocation()?;
            let key =
                keys::reset_redemption(&action.target.hash, &invocation.identity.quota_generation);
            let existing: Option<ResetRecord> = tx.read(&key).await?;
            if let Some(row) = existing.as_ref() {
                if row.v != 1 || row.identity != invocation.identity {
                    return Err(error(409, "redemption_record_context_mismatch"));
                }
                match row.state {
                    ResetState::Verified => return Ok(ResetClaim::Verified(row.clone())),
                    ResetState::Rejected => return Ok(ResetClaim::Rejected(row.clone())),
                    ResetState::Submitted | ResetState::Unknown => {
                        return Ok(ResetClaim::InProgress(row.clone()));
                    }
                    ResetState::Claimed if row.lease_expires_at_ms > tx.now => {
                        return Ok(ResetClaim::InProgress(row.clone()));
                    }
                    _ => {}
                }
            }
            self.manual_fences(&mut tx, action, config, true).await?;
            let row = ResetRecord {
                v: 1,
                identity: invocation.identity.clone(),
                routing_generation: action.intent.routing_generation,
                state: ResetState::Claimed,
                owner_token: self.tokens.next_token()?,
                fence: existing
                    .as_ref()
                    .map_or(Ok(1), |r| crate::next_generation(r.fence))?,
                lease_expires_at_ms: crate::add(tx.now, crate::PROBE_LEASE_MS)?,
                provider_receipt_id: None,
                created_at_ms: existing.as_ref().map_or(tx.now, |r| r.created_at_ms),
                updated_at_ms: tx.now,
                submitted_at_ms: None,
                verified_at_ms: None,
                last_error_code: None,
            };
            tx.put(&key, &row, None)?;
            if tx.commit().await? {
                return Ok(ResetClaim::Submit {
                    record: row,
                    invocation,
                });
            }
        }
        Err(error(409, "codex_reset_concurrent_update"))
    }
    pub async fn prepare_manual_reset_submission(
        &self,
        action: &ManualResetAction,
        config: &AuthConfig,
        expected: &ResetRecord,
    ) -> Result<ResetRecord, GatewayError> {
        self.manual_submit(action, config, expected, false).await
    }
    pub async fn renew_manual_reset_before_redeem(
        &self,
        action: &ManualResetAction,
        config: &AuthConfig,
        expected: &ResetRecord,
    ) -> Result<ResetRecord, GatewayError> {
        self.manual_submit(action, config, expected, true).await
    }
    async fn manual_submit(
        &self,
        action: &ManualResetAction,
        config: &AuthConfig,
        expected: &ResetRecord,
        renew: bool,
    ) -> Result<ResetRecord, GatewayError> {
        for _ in 0..4 {
            let mut tx = self.transaction(self.fresh_time(0)?)?;
            self.manual_fences(&mut tx, action, config, true).await?;
            let invocation = action.invocation()?;
            let key =
                keys::reset_redemption(&action.target.hash, &invocation.identity.quota_generation);
            let mut row: ResetRecord = tx
                .read(&key)
                .await?
                .ok_or_else(|| error(409, "stale_owner"))?;
            reset::check_record(&row, expected)?;
            if row.identity != invocation.identity
                || row.state
                    != if renew {
                        ResetState::Submitted
                    } else {
                        ResetState::Claimed
                    }
                || row.lease_expires_at_ms <= tx.now
                || reset::utc_day(row.created_at_ms)? != reset::utc_day(tx.now)?
            {
                return Err(error(409, "stale_owner"));
            }
            if !renew {
                let mut budget = manual_budget(&mut tx, &action.target.hash).await?;
                budget.submission_count = 1;
                budget.updated_at_ms = tx.now;
                tx.put(
                    &keys::reset_day(&action.target.hash, &budget.day),
                    &budget,
                    None,
                )?;
                row.state = ResetState::Submitted;
                row.submitted_at_ms = Some(tx.now);
            }
            row.lease_expires_at_ms = crate::add(tx.now, crate::PROBE_LEASE_MS)?;
            row.updated_at_ms = tx.now;
            self.manual_fences(&mut tx, action, config, true).await?;
            tx.put(&key, &row, None)?;
            if tx.commit().await? {
                return Ok(row);
            }
        }
        Err(error(409, "codex_reset_concurrent_update"))
    }
    pub async fn promote_manual_reset(
        &self,
        action: &ManualResetAction,
        config: &AuthConfig,
        verified: &ResetRecord,
        usage: &CapacityObservation,
    ) -> Result<ManualResetPromotion, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(self.fresh_time(0)?)?;
            let (mut view, index) = self.manual_fences(&mut tx, action, config, false).await?;
            observation(usage, &action.target, tx.now)?;
            let mut current_usage = usage.clone();
            current_usage.slot =
                u8::try_from(index).map_err(|_| error(409, "codex_account_changed"))?;
            let invocation = action.invocation()?;
            let row: ResetRecord = tx
                .read(&keys::reset_redemption(
                    &action.target.hash,
                    &invocation.identity.quota_generation,
                ))
                .await?
                .ok_or_else(|| error(409, "codex_reset_unverified"))?;
            reset::check_record(&row, verified)?;
            if row.state != ResetState::Verified || row.identity != invocation.identity {
                return Err(error(409, "codex_reset_unverified"));
            }
            let mut models = Vec::new();
            if routing::capacity_headroom_for_observation(usage, None).unwrap_or(0.0) > 0.0 {
                models.push(gateway_core::model::ModelId::from_scalar("standard"));
            }
            for limit in &usage.additional_rate_limits {
                let model = gateway_core::model::ModelId::from_scalar(&limit.limit_name);
                if !matches!(
                    routing::model_quota_class(&model),
                    gateway_core::provider::CodexQuotaClass::Standard
                        | gateway_core::provider::CodexQuotaClass::Unknown
                ) && routing::capacity_headroom_for_observation(usage, Some(&model))
                    .unwrap_or(0.0)
                    > 0.0
                {
                    models.push(model);
                }
            }
            if models.is_empty() {
                return Err(error(409, "codex_reset_propagation_pending"));
            }
            let state = &view.state.slots[index];
            if state.invalid_credential_version.as_ref()
                == Some(&action.target.binding.credential_version)
                || state
                    .probe_lease
                    .as_ref()
                    .is_some_and(|l| l.expires_at_ms > tx.now)
                || state
                    .quota_signal_observed_at_ms
                    .is_some_and(|at| at >= usage.snapshot_at_ms)
                || view.capacity.observations.iter().any(|r| {
                    r.account_id_hash == usage.account_id_hash
                        && r.snapshot_at_ms > usage.snapshot_at_ms
                })
            {
                return Err(error(409, "codex_reset_concurrent_update"));
            }
            for model in &models {
                if let Some(next) = routing::apply_capacity_observation(
                    &view.state,
                    &current_usage,
                    tx.now,
                    Some(model),
                    tx.now,
                )? {
                    view.state = next;
                }
            }
            if models.iter().any(|model| {
                view.state.slots[index]
                    .quota_block_for(routing::model_quota_class(model))
                    .is_some_and(|b| b.blocked_until_ms > tx.now)
            }) {
                return Err(error(409, "codex_reset_concurrent_update"));
            }
            let capacity = crate::capacity_rules::plan_capacity_observation_store(
                tx.revision(&keys::capacity()),
                &view.capacity,
                std::slice::from_ref(&current_usage),
                tx.now,
            )
            .capacity;
            let active = ActiveSelection {
                v: 1,
                binding: view.binding(index),
                generation: crate::next_generation(
                    view.active.as_ref().map_or(0, |a| a.generation),
                )?,
                transition_reason: Some(ActiveTransitionReason::ManualReset),
                updated_at_ms: tx.now,
            };
            let mut intent = action.intent.clone();
            intent.promoted_at_ms = Some(tx.now);
            policy(&mut tx).await?;
            actor::validate_current_time(&action.target.actor, self.fresh_time(tx.now)?)?;
            tx.put(&keys::routing(), &view.state, None)?;
            tx.put(&keys::capacity(), &capacity, None)?;
            tx.put(&keys::active(), &active, None)?;
            tx.put(&intent_key(&action.target.hash), &intent, None)?;
            if tx.commit().await? {
                return Ok(ManualResetPromotion {
                    reset_status: "verified".into(),
                    active_account_id_hash: action.target.hash.clone(),
                });
            }
        }
        Err(error(409, "codex_reset_concurrent_update"))
    }
}
async fn manual_budget<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    hash: &str,
) -> Result<AccountDayBudget, GatewayError> {
    let day = reset::utc_day(tx.now)?;
    let budget: AccountDayBudget =
        tx.read(&keys::reset_day(hash, &day))
            .await?
            .unwrap_or(AccountDayBudget {
                v: 1,
                day: day.clone(),
                submission_count: 0,
                updated_at_ms: tx.now,
            });
    if budget.v != 1 || budget.day != day || budget.submission_count != 0 {
        return Err(error(429, "account_day_limit_reached"));
    }
    Ok(budget)
}
fn error(status: u16, code: &str) -> GatewayError {
    GatewayError::new(
        status,
        "Manual reset requires current account, policy and verified quota state.",
        Some(code),
    )
}
