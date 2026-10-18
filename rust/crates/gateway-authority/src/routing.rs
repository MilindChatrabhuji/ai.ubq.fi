//! Global serial subscription selection; source routing-serial.ts and routing-evaluation.ts.
use std::collections::{BTreeMap, BTreeSet};

use gateway_core::GatewayError;
use gateway_core::identity::{
    AccountBinding, ActiveSelection, ActiveTransitionReason, RoutingAccountHash,
};
use gateway_core::provider::{CodexQuotaClass, OveragePermission};
use gateway_core::state::AuthorityStore;

use crate::store::Transaction;
use crate::{
    Authority, TokenSource, generation, invalid, keys, next_generation, nonnegative, text,
    unavailable,
};

pub use crate::routing_types::*;

pub fn class_name(class: CodexQuotaClass) -> &'static str {
    match class {
        CodexQuotaClass::Spark => "spark",
        CodexQuotaClass::GptOss120b => "gpt_oss_120b",
        CodexQuotaClass::Reserve => "reserve",
        CodexQuotaClass::Standard => "standard",
        CodexQuotaClass::Unknown => "unknown",
    }
}

pub(crate) fn validate_binding(binding: &AccountBinding) -> Result<(), GatewayError> {
    text(&binding.account_id_hash.0)?;
    text(&binding.credential_version.0)?;
    text(&binding.pool_versionstamp.0)?;
    generation(binding.slot)?;
    generation(binding.routing_generation)?;
    Ok(())
}

impl SubscriptionPool {
    fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 1 || self.accounts.is_empty() {
            return Err(invalid("Codex subscription pool is missing or malformed."));
        }
        text(&self.pool_versionstamp.0)?;
        let mut identities = BTreeSet::new();
        for account in &self.accounts {
            text(&account.account_id_hash.0)?;
            text(&account.admin_account_hash.0)?;
            text(&account.credential_version.0)?;
            if !identities.insert(&account.account_id_hash.0) {
                return Err(invalid("Duplicate Codex account identity."));
            }
        }
        Ok(())
    }
}

fn normalize(
    pool: &SubscriptionPool,
    prior: Option<RoutingState>,
    now: i64,
) -> Result<RoutingState, GatewayError> {
    let prior = prior.unwrap_or(RoutingState {
        v: 2,
        updated_at_ms: now,
        legacy_identity_unresolved: false,
        slots: Vec::new(),
    });
    if prior.v != 2 {
        return Err(invalid("Unsupported Codex routing state."));
    }
    nonnegative(prior.updated_at_ms)?;
    let mut slots = Vec::new();
    for account in &pool.accounts {
        let existing = prior
            .slots
            .iter()
            .find(|slot| slot.account_id_hash == account.account_id_hash);
        let mut slot = existing.cloned().unwrap_or(RoutingSlot {
            account_id_hash: account.account_id_hash.clone(),
            credential_version: account.credential_version.clone(),
            generation: 0,
            invalid_credential_version: None,
            quota_blocks: BTreeMap::new(),
            probe_lease: None,
            retained_reset_at_ms: None,
            reset_identity_ambiguous: false,
        });
        generation(slot.generation)?;
        for block in slot.quota_blocks.values() {
            nonnegative(block.blocked_until_ms)?;
            nonnegative(block.observed_at_ms)?;
            if let Some(reset) = block.reset_at_ms {
                nonnegative(reset)?;
            }
        }
        if slot.credential_version != account.credential_version {
            slot.retained_reset_at_ms = slot
                .quota_blocks
                .values()
                .filter_map(|block| block.reset_at_ms)
                .max()
                .or(slot.retained_reset_at_ms);
            slot.reset_identity_ambiguous |= slot.retained_reset_at_ms.is_some();
            slot.credential_version = account.credential_version.clone();
            slot.generation = next_generation(slot.generation)?;
            slot.invalid_credential_version = None;
            slot.quota_blocks.clear();
            if let Some(lease) = &mut slot.probe_lease {
                lease.generation = slot.generation;
            }
        }
        slots.push(slot);
    }
    Ok(RoutingState { slots, ..prior })
}

fn headroom(windows: &[CapacityWindow]) -> Option<f64> {
    windows
        .iter()
        .filter_map(|window| window.used_percent)
        .filter(|percent| percent.is_finite())
        .map(|percent| (100.0 - percent).clamp(0.0, 100.0))
        .reduce(f64::min)
}

fn capacity_for<'a>(
    capacity: &'a CapacityStore,
    account: &RoutingAccountHash,
    model: &str,
    now: i64,
) -> Option<(&'a CapacityObservation, f64)> {
    let observation = capacity.observations.iter().find(|row| {
        &row.account_id_hash == account
            && row.available
            && row.snapshot_at_ms >= 0
            && row.snapshot_at_ms <= now
            && now - row.snapshot_at_ms <= 30 * crate::MINUTE_MS
    })?;
    let model_limits: Vec<_> = observation
        .additional
        .iter()
        .filter(|limit| limit.model.eq_ignore_ascii_case(model))
        .collect();
    let available = if model_limits.is_empty() {
        headroom(&observation.windows)
    } else {
        model_limits
            .into_iter()
            .filter_map(|limit| headroom(&limit.windows))
            .reduce(f64::max)
    }?;
    Some((observation, available))
}

fn unavailable_model(
    models: &ModelAvailability,
    pool: &SubscriptionPool,
    account: &RoutingAccountHash,
    model: &str,
    now: i64,
) -> Option<Option<String>> {
    if let Some(learned) = models
        .unsupported
        .get(&account.0)
        .and_then(|row| row.get(model))
        && learned.observed_at_ms > 0
        && learned.observed_at_ms <= now
        && now - learned.observed_at_ms <= 7 * crate::DAY_MS
    {
        return Some(Some(learned.detail.clone()));
    }
    let catalog = models.catalogs.get(&account.0)?;
    if catalog.models.iter().any(|slug| slug == model) {
        return None;
    }
    pool.accounts
        .iter()
        .filter(|other| other.enabled && &other.account_id_hash != account)
        .find_map(|other| {
            let sibling = models.catalogs.get(&other.account_id_hash.0)?;
            (sibling.client_version == catalog.client_version
                && sibling.models.iter().any(|slug| slug == model))
            .then_some(None)
        })
}

pub(crate) struct RoutingView {
    pub pool: SubscriptionPool,
    pub state: RoutingState,
    pub active: Option<ActiveSelection>,
    models: ModelAvailability,
    models_source: serde_json::Value,
    source_ids: BTreeMap<String, String>,
    capacity: CapacityStore,
    pub(crate) overage: BTreeMap<String, bool>,
}

pub(crate) async fn read_view<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
) -> Result<RoutingView, GatewayError> {
    let mut pool: SubscriptionPool = tx
        .read(&keys::pool())
        .await?
        .ok_or_else(|| unavailable("codex_routing_unavailable", "Codex pool is unavailable."))?;
    pool.validate()?;
    let state = normalize(&pool, tx.read(&keys::routing()).await?, tx.now)?;
    let active: Option<ActiveSelection> = tx.read(&keys::active()).await?;
    if let Some(active) = &active {
        validate_binding(&active.binding)?;
        if active.v != 1 || active.generation == 0 {
            return Err(invalid("Malformed active Codex selection."));
        }
        generation(active.generation)?;
    }
    let capacity = tx.read(&keys::capacity()).await?.unwrap_or_default();
    let source_models = crate::source_models::load(tx, &pool).await?;
    let selection: Option<serde_json::Value> = tx.read(&keys::provider_selection()).await?;
    let selection = selection.as_ref().filter(|value| !value.is_null()).map(|value| {
        gateway_schema::selection::ProviderSelection::normalize(value)
            .ok_or_else(|| invalid("Current source provider selection is malformed."))
    }).transpose()?;
    for account in &mut pool.accounts {
        // Source selection determines this cohort, never a stale normalized projection flag.
        // Current native credential invalidity/leases/quota remain separate evaluation rules.
        account.enabled = selection.as_ref().is_none_or(|selection| {
            selection.account_eligible(&account.admin_account_hash.0)
        });
    }
    let mut overage = BTreeMap::new();
    for account in &pool.accounts {
        let setting: Option<serde_json::Value> = tx
            .read(&keys::overage(&account.admin_account_hash.0))
            .await?;
        overage.insert(
            account.account_id_hash.0.clone(),
            OveragePermission::from_stored_record(setting.as_ref()).allows_dispatch(),
        );
    }
    Ok(RoutingView {
        pool,
        state,
        active,
        capacity,
        models: source_models.models,
        models_source: source_models.raw,
        source_ids: source_models.ids,
        overage,
    })
}

impl RoutingView {
    pub(crate) fn binding(&self, slot: usize) -> AccountBinding {
        AccountBinding {
            account_id_hash: self.pool.accounts[slot].account_id_hash.clone(),
            credential_version: self.pool.accounts[slot].credential_version.clone(),
            pool_versionstamp: self.pool.pool_versionstamp.clone(),
            slot: slot as u64,
            routing_generation: self.state.slots[slot].generation,
        }
    }

    pub(crate) fn matches(&self, admission: &AdmittedAccount) -> bool {
        let Ok(slot) = usize::try_from(admission.binding.slot) else {
            return false;
        };
        self.pool
            .accounts
            .get(slot)
            .is_some_and(|account| account.enabled)
            && slot < self.state.slots.len()
            && self.binding(slot) == admission.binding
            && self.active.as_ref().is_some_and(|active| {
                active.generation == admission.active_generation
                    && active.binding == admission.binding
            })
    }

    pub(crate) fn current_binding(&self, binding: &AccountBinding) -> bool {
        usize::try_from(binding.slot)
            .ok()
            .is_some_and(|slot| slot < self.state.slots.len() && self.binding(slot) == *binding)
    }
}

struct Evaluation {
    slot: usize,
    reason: Option<ActiveTransitionReason>,
    eligible: bool,
    probe: bool,
    retry: Option<i64>,
    detail: Option<String>,
}

fn evaluate(
    view: &RoutingView,
    slot: usize,
    model: &str,
    class: CodexQuotaClass,
    now: i64,
) -> Evaluation {
    let row = &view.state.slots[slot];
    let mut result = Evaluation {
        slot,
        reason: None,
        eligible: false,
        probe: false,
        retry: None,
        detail: None,
    };
    if row.invalid_credential_version.as_ref() == Some(&row.credential_version) {
        result.reason = Some(ActiveTransitionReason::CredentialInvalid);
        return result;
    }
    if let Some(detail) =
        unavailable_model(&view.models, &view.pool, &row.account_id_hash, model, now)
    {
        result.reason = Some(ActiveTransitionReason::ModelUnavailable);
        result.detail = detail;
        return result;
    }
    let block = row.quota_blocks.get(class_name(class));
    let observed = capacity_for(&view.capacity, &row.account_id_hash, model, now).filter(
        |(observation, _)| {
            block.is_none_or(|block| block.observed_at_ms < observation.snapshot_at_ms)
        },
    );
    let override_positive = observed.is_some_and(|(_, available)| available > 0.0);
    if let Some(block) = block
        && block.blocked_until_ms > now
        && !override_positive
    {
        result.reason = Some(ActiveTransitionReason::QuotaExhausted);
        result.retry = Some(block.blocked_until_ms);
        return result;
    }
    if let Some((observation, available)) = observed.filter(|(_, available)| *available == 0.0) {
        debug_assert_eq!(available, 0.0);
        if !view
            .overage
            .get(&row.account_id_hash.0)
            .copied()
            .unwrap_or(false)
            && let Some(reset) = observation
                .windows
                .first()
                .and_then(|window| window.reset_at_ms)
                .filter(|reset| *reset > now)
        {
            result.reason = Some(ActiveTransitionReason::QuotaExhausted);
            result.retry = Some(reset);
            return result;
        }
        result.probe = true;
    }
    if row
        .probe_lease
        .as_ref()
        .is_some_and(|lease| lease.expires_at_ms > now && lease.quota_class == class)
    {
        return result;
    }
    result.eligible = true;
    result.probe |= block.is_some() && !override_positive;
    result
}

pub(crate) async fn validate_cohort<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    proof: &CohortProof,
    quota_only: bool,
) -> Result<bool, GatewayError> {
    for check in &proof.checks {
        let _: Option<serde_json::Value> = tx.read(&check.key).await?;
        if !tx.expect(&check.key, &check.expected_revision) {
            return Ok(false);
        }
    }
    let view = read_view(tx).await?;
    let selected: Vec<_> = view
        .pool
        .accounts
        .iter()
        .enumerate()
        .filter(|(_, account)| account.enabled)
        .map(|(slot, _)| slot)
        .collect();
    if selected.is_empty()
        || selected
            .iter()
            .map(|slot| view.binding(*slot))
            .collect::<Vec<_>>()
            != proof.bindings
    {
        return Ok(false);
    }
    Ok(selected.iter().all(|slot| {
        let reason = evaluate(&view, *slot, &proof.model, proof.quota_class, tx.now).reason;
        reason == Some(ActiveTransitionReason::QuotaExhausted)
            || (!quota_only && reason == Some(ActiveTransitionReason::CredentialInvalid))
    }))
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    /// Event-owned reset preflight materializes capacity evidence before selecting new proof.
    pub async fn materialize_capacity_quota_blocks(
        &self,
        model: &str,
        class: CodexQuotaClass,
        now: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            let mut changed = false;
            for slot in 0..view.pool.accounts.len() {
                if !view.pool.accounts[slot].enabled {
                    continue;
                }
                let Some((observation, available)) = capacity_for(
                    &view.capacity,
                    &view.pool.accounts[slot].account_id_hash,
                    model,
                    now,
                ) else {
                    continue;
                };
                if available != 0.0 {
                    continue;
                }
                let Some(reset) = observation
                    .windows
                    .first()
                    .and_then(|window| window.reset_at_ms)
                    .filter(|reset| *reset > now)
                else {
                    continue;
                };
                let prior = view.state.slots[slot].quota_blocks.get(class_name(class));
                if prior.is_some_and(|block| {
                    block.blocked_until_ms > now
                        || block.observed_at_ms >= observation.snapshot_at_ms
                }) {
                    continue;
                }
                view.state.slots[slot].quota_blocks.insert(
                    class_name(class).to_owned(),
                    QuotaBlock {
                        blocked_until_ms: reset,
                        source: QuotaBlockSource::HeaderRetryAfter,
                        observed_at_ms: observation.snapshot_at_ms,
                        reset_at_ms: Some(reset),
                        reset_is_stable: true,
                        reset_ambiguous: false,
                        recovery_pending: false,
                    },
                );
                view.state.slots[slot].generation =
                    next_generation(view.state.slots[slot].generation)?;
                changed = true;
            }
            if changed {
                view.state.updated_at_ms = now;
                tx.put(&keys::routing(), &view.state, None)?;
            }
            if tx.commit().await? {
                return Ok(changed);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Capacity materialization changed concurrently.",
        ))
    }
    pub async fn select_account(
        &self,
        model: &str,
        class: CodexQuotaClass,
        now: i64,
    ) -> Result<RouteSelection, GatewayError> {
        text(model)?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            let prior: Option<RoutingState> = tx.read(&keys::routing()).await?;
            let evaluated: Vec<_> = view
                .pool
                .accounts
                .iter()
                .enumerate()
                .filter(|(_, account)| account.enabled)
                .map(|(slot, _)| evaluate(&view, slot, model, class, now))
                .collect();
            let active_slot = view.active.as_ref().and_then(|active| {
                evaluated.iter().find(|evaluation| {
                    view.pool.accounts[evaluation.slot].account_id_hash
                        == active.binding.account_id_hash
                })
            });
            if prior.as_ref() != Some(&view.state) {
                view.state.updated_at_ms = now;
                tx.put(&keys::routing(), &view.state, None)?;
            }
            let chosen = match (&view.active, active_slot) {
                (None, _) => evaluated.iter().find(|evaluation| evaluation.eligible),
                (Some(_), Some(active)) if active.eligible => Some(active),
                (Some(_), Some(active)) if active.reason.is_none() => {
                    if tx.commit().await? {
                        return Ok(RouteSelection::RoutingUnavailable);
                    } else {
                        continue;
                    }
                }
                _ => evaluated.iter().find(|evaluation| evaluation.eligible),
            };
            let result = if let Some(chosen) = chosen {
                let binding = view.binding(chosen.slot);
                let changed_identity = view.active.as_ref().is_some_and(|active| {
                    active.binding.account_id_hash != binding.account_id_hash
                });
                let (active_generation, reason) = match &view.active {
                    None => (1, None),
                    Some(active) if changed_identity => (
                        next_generation(active.generation)?,
                        active_slot
                            .and_then(|row| row.reason)
                            .or(Some(ActiveTransitionReason::AccountRemovedOrReplaced)),
                    ),
                    Some(active) => (active.generation, active.transition_reason),
                };
                let next = ActiveSelection {
                    v: 1,
                    binding: binding.clone(),
                    generation: active_generation,
                    transition_reason: reason,
                    updated_at_ms: now,
                };
                if view.active.as_ref().is_none_or(|active| {
                    active.binding != next.binding || active.generation != next.generation
                }) {
                    tx.put(&keys::active(), &next, None)?;
                }
                RouteSelection::Eligible(AdmittedAccount {
                    binding,
                    active_generation,
                    requested_model: model.to_owned(),
                    quota_class: class,
                    probe_required: chosen.probe,
                    probe: None,
                })
            } else {
                if let (Some(active), Some(active_slot)) = (&view.active, active_slot) {
                    let binding = view.binding(active_slot.slot);
                    if active.binding != binding {
                        let refreshed = ActiveSelection {
                            binding,
                            updated_at_ms: now,
                            ..active.clone()
                        };
                        tx.put(&keys::active(), &refreshed, None)?;
                    }
                }
                let proof = CohortProof {
                    checks: tx.post_checks(),
                    model: model.to_owned(),
                    quota_class: class,
                    exhausted: !evaluated.is_empty()
                        && evaluated
                            .iter()
                            .all(|row| row.reason == Some(ActiveTransitionReason::QuotaExhausted)),
                    unavailable: !evaluated.is_empty()
                        && evaluated.iter().all(|row| {
                            matches!(
                                row.reason,
                                Some(
                                    ActiveTransitionReason::QuotaExhausted
                                        | ActiveTransitionReason::CredentialInvalid
                                )
                            )
                        }),
                    bindings: evaluated.iter().map(|row| view.binding(row.slot)).collect(),
                };
                if evaluated
                    .iter()
                    .any(|row| row.reason == Some(ActiveTransitionReason::QuotaExhausted))
                {
                    RouteSelection::QuotaBlocked {
                        retry_at_ms: evaluated.iter().filter_map(|row| row.retry).min(),
                        proof,
                    }
                } else if let Some(row) = evaluated
                    .iter()
                    .find(|row| row.reason == Some(ActiveTransitionReason::ModelUnavailable))
                {
                    RouteSelection::ModelUnavailable {
                        model: model.to_owned(),
                        detail: row.detail.clone(),
                    }
                } else {
                    RouteSelection::CredentialsInvalid { proof }
                }
            };
            if tx.commit().await? {
                return Ok(result);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Codex routing changed concurrently.",
        ))
    }

    pub async fn ensure_admission_current(
        &self,
        admission: &AdmittedAccount,
        now: i64,
    ) -> Result<(), GatewayError> {
        validate_binding(&admission.binding)?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let view = read_view(&mut tx).await?;
            if !view.matches(admission)
                || view.state.slots[admission.binding.slot as usize]
                    .invalid_credential_version
                    .as_ref()
                    == Some(&admission.binding.credential_version)
            {
                return Err(unavailable(
                    "codex_routing_unavailable",
                    "Codex admission is stale.",
                ));
            }
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Codex admission changed concurrently.",
        ))
    }

    pub async fn record_quota_block(
        &self,
        admission: &AdmittedAccount,
        block: QuotaBlock,
        now: i64,
    ) -> Result<bool, GatewayError> {
        nonnegative(block.blocked_until_ms)?;
        nonnegative(block.observed_at_ms)?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            let slot_index = admission.binding.slot as usize;
            let foreign_probe = view.state.slots.get(slot_index).is_some_and(|slot| {
                slot.account_id_hash == admission.binding.account_id_hash
                    && slot.credential_version == admission.binding.credential_version
                    && view.pool.pool_versionstamp == admission.binding.pool_versionstamp
                    && slot
                        .probe_lease
                        .as_ref()
                        .is_some_and(|lease| lease.quota_class != admission.quota_class)
                    && admission.probe.is_none()
            });
            if !view.current_binding(&admission.binding) && !foreign_probe {
                return Ok(false);
            }
            let slot = &mut view.state.slots[admission.binding.slot as usize];
            let prior = slot.quota_blocks.get(class_name(admission.quota_class));
            if prior.is_some_and(|prior| prior.observed_at_ms > block.observed_at_ms) {
                return Ok(false);
            }
            let mut next = block.clone();
            if let Some(prior) = prior {
                next.blocked_until_ms = next.blocked_until_ms.max(prior.blocked_until_ms);
                next.reset_ambiguous |= prior.reset_ambiguous
                    || (prior.reset_is_stable && prior.reset_at_ms != next.reset_at_ms);
            }
            slot.quota_blocks
                .insert(class_name(admission.quota_class).to_owned(), next);
            if !foreign_probe {
                slot.probe_lease = None;
                slot.generation = next_generation(slot.generation)?;
            }
            view.state.updated_at_ms = now;
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Quota observation changed concurrently.",
        ))
    }

    pub async fn mark_credential_invalid(
        &self,
        admission: &AdmittedAccount,
        now: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            if !view.current_binding(&admission.binding) {
                return Ok(false);
            }
            let slot = &mut view.state.slots[admission.binding.slot as usize];
            slot.invalid_credential_version = Some(admission.binding.credential_version.clone());
            slot.retained_reset_at_ms = slot
                .quota_blocks
                .values()
                .filter_map(|block| block.reset_at_ms)
                .max()
                .or(slot.retained_reset_at_ms);
            slot.quota_blocks.clear();
            slot.probe_lease = None;
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Credential observation changed concurrently.",
        ))
    }

    pub async fn learn_model_unavailable(
        &self,
        admission: &AdmittedAccount,
        detail: &str,
        now: i64,
    ) -> Result<bool, GatewayError> {
        let expected = format!(
            "The '{}' model is not supported when using Codex with a ChatGPT account.",
            admission.requested_model
        );
        if detail != expected {
            return Ok(false);
        }
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let view = read_view(&mut tx).await?;
            if !view.matches(admission) {
                return Ok(false);
            }
            let id = view
                .source_ids
                .get(&admission.binding.account_id_hash.0)
                .ok_or_else(|| invalid("Current source account mapping is missing."))?;
            let models = crate::source_models::learn(
                &view.models_source,
                id,
                &admission.requested_model,
                now,
            )?;
            tx.put(&keys::models(), &models, None)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Model evidence changed concurrently.",
        ))
    }
}
