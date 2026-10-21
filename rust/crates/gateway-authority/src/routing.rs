//! Global serial subscription selection; source routing-serial.ts and routing-evaluation.ts.
use gateway_core::{js_string::JsString16, model::ModelId};
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

use crate::capacity_rules::capacity_for;
pub use crate::capacity_rules::{
    CapacityObservationStorePlan, capacity_headroom_for_observation, capacity_observation_is_fresh,
    normalize_capacity_window, parse_capacity_observation, parse_capacity_store,
    plan_capacity_observation_store,
};
use crate::routing_codec::normalize;
pub use crate::routing_codec::{normalize as normalize_routing_state, parse_routing_state};
pub use crate::routing_rules::apply_capacity_observation;
pub use crate::routing_types::*;

pub fn model_quota_class(model: &ModelId) -> CodexQuotaClass {
    let trimmed = gateway_schema::reasoning::js_trim_source(model.as_js_string());
    let lower = lower_control_units(trimmed.as_units());
    let same = |s: &str| lower.iter().copied().eq(s.encode_utf16());
    if same("gpt-5.3-codex-spark") {
        CodexQuotaClass::Spark
    } else if same("gpt-oss-120b") {
        CodexQuotaClass::GptOss120b
    } else if model_quota_label(model) == "gptreserve" {
        CodexQuotaClass::Reserve
    } else if lower.is_empty() {
        CodexQuotaClass::Unknown
    } else {
        CodexQuotaClass::Standard
    }
}
// Only finite ASCII class comparisons consume this projection; original model data is untouched.
fn lower_control_units(units: &[u16]) -> Vec<u16> {
    gateway_core::js_string_case::lowercase_source(&JsString16::from_units(units.to_vec()))
        .as_units()
        .to_vec()
}
pub(crate) fn model_quota_label(model: &ModelId) -> String {
    lower_control_units(model.as_js_string().as_units())
        .into_iter()
        .filter_map(|u| {
            u8::try_from(u)
                .ok()
                .filter(u8::is_ascii_alphanumeric)
                .map(char::from)
        })
        .collect()
}

/// Non-inference account identity. The source model remains optional UTF16 and is never replaced.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveAccountSelection {
    pub binding: AccountBinding,
    pub active_generation: u64,
    pub quota_class: CodexQuotaClass,
    pub probe_required: bool,
    pub model: Option<gateway_core::js_string::JsString16>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum LiveRouteSelection {
    Eligible(LiveAccountSelection),
    QuotaBlocked { retry_at_ms: Option<i64> },
    CredentialsInvalid,
    ModelUnavailable { detail: Option<JsString16> },
    RoutingUnavailable,
}

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
    pub(crate) fn validate(&self) -> Result<(), GatewayError> {
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

fn unavailable_model(
    models: &ModelAvailability,
    pool: &SubscriptionPool,
    account: &RoutingAccountHash,
    model: &ModelId,
    now: i64,
) -> Option<Option<JsString16>> {
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
    models_source: gateway_core::source_json::SourceJson,
    source_ids: BTreeMap<String, String>,
    pub(crate) capacity: CapacityStore,
    pub(crate) overage: BTreeMap<String, bool>,
}

pub(crate) async fn read_view<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
) -> Result<RoutingView, GatewayError> {
    read_view_for(tx, true).await
}

/// Source slot-pinned callers hydrate the same state without consulting the global election.
pub(crate) async fn read_pinned_view<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
) -> Result<RoutingView, GatewayError> {
    read_view_for(tx, false).await
}

async fn read_view_for<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    read_active: bool,
) -> Result<RoutingView, GatewayError> {
    let mut pool: SubscriptionPool = tx
        .read(&keys::pool())
        .await?
        .ok_or_else(|| unavailable("codex_routing_unavailable", "Codex pool is unavailable."))?;
    pool.validate()?;
    let state = normalize(
        &pool,
        tx.read::<serde_json::Value>(&keys::routing())
            .await?
            .as_ref()
            .map(parse_routing_state)
            .transpose()?,
        tx.now,
    )?;
    let active: Option<ActiveSelection> = if read_active {
        tx.read(&keys::active()).await?
    } else {
        None
    };
    if let Some(active) = &active {
        validate_binding(&active.binding)?;
        if active.v != 1 || active.generation == 0 {
            return Err(invalid("Malformed active Codex selection."));
        }
        generation(active.generation)?;
    }
    let capacity = tx
        .read::<serde_json::Value>(&keys::capacity())
        .await?
        .as_ref()
        .map(parse_capacity_store)
        .transpose()?
        .unwrap_or_default();
    let source_models = crate::source_models::load(tx, &pool).await?;
    let selection: Option<serde_json::Value> = tx.read(&keys::provider_selection()).await?;
    let selection = selection
        .as_ref()
        .filter(|value| !value.is_null())
        .map(|value| {
            gateway_schema::selection::ProviderSelection::normalize(value)
                .ok_or_else(|| invalid("Current source provider selection is malformed."))
        })
        .transpose()?;
    for account in &mut pool.accounts {
        // Source selection determines this cohort, never a stale normalized projection flag.
        // Current native credential invalidity/leases/quota remain separate evaluation rules.
        account.enabled = selection
            .as_ref()
            .is_none_or(|selection| selection.account_eligible(&account.admin_account_hash.0));
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

pub(crate) struct Evaluation {
    pub(crate) slot: usize,
    pub(crate) reason: Option<ActiveTransitionReason>,
    pub(crate) eligible: bool,
    pub(crate) probe: bool,
    pub(crate) retry: Option<i64>,
    pub(crate) detail: Option<JsString16>,
}

pub(crate) fn evaluate(
    view: &RoutingView,
    slot: usize,
    model: &ModelId,
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
    if let Some(detail) = unavailable_model(
        &view.models,
        &view.pool,
        &view.pool.accounts[slot].account_id_hash,
        model,
        now,
    ) {
        result.reason = Some(ActiveTransitionReason::ModelUnavailable);
        result.detail = detail;
        return result;
    }
    let block = row.quota_block_for(class);
    let observed = capacity_for(
        &view.capacity,
        &view.pool.accounts[slot].account_id_hash,
        model,
        now,
    );
    let newer_signal = observed.is_some_and(|(observation, _)| {
        row.quota_signal_for(class)
            .is_some_and(|at| at >= observation.snapshot_at_ms)
    });
    let override_positive = !newer_signal && observed.is_some_and(|(_, available)| available > 0.0);
    if let Some(block) = &block
        && block.blocked_until_ms > now
        && !override_positive
    {
        result.reason = Some(ActiveTransitionReason::QuotaExhausted);
        result.retry = Some(block.blocked_until_ms);
        return result;
    }
    if let Some((observation, available)) =
        observed.filter(|(_, available)| *available == 0.0 && !newer_signal)
    {
        debug_assert_eq!(available, 0.0);
        if !view
            .overage
            .get(&view.pool.accounts[slot].account_id_hash.0)
            .copied()
            .unwrap_or(false)
            && let Some(reset) = observation
                .windows
                .primary
                .as_ref()
                .and_then(|window| window.reset_at_ms)
                .filter(|reset| *reset > now)
        {
            result.reason = Some(ActiveTransitionReason::QuotaExhausted);
            result.retry = Some(reset);
            return result;
        }
        result.probe = true;
        result.eligible = true;
        return result;
    }
    if row.probe_lease.as_ref().is_some_and(|lease| {
        lease.expires_at_ms > now
            && lease.circuit == ProbeCircuit::Quota
            && lease.quota_class.is_none_or(|c| c == class)
    }) {
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
        model: &ModelId,
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
                    .primary
                    .as_ref()
                    .and_then(|window| window.reset_at_ms)
                    .filter(|reset| *reset > now)
                else {
                    continue;
                };
                let prior = view.state.slots[slot].quota_block_for(class);
                // A live quota signal observed after this sample remains newer
                // and authoritative. An older but still-future block must not
                // suppress reconciliation of a changed provider window.
                if prior
                    .as_ref()
                    .and_then(|block| block.observed_at_ms)
                    .is_some_and(|at| at >= observation.snapshot_at_ms)
                {
                    continue;
                }
                let current = &mut view.state.slots[slot];
                let foreign_probe = current.probe_lease.as_ref().is_some_and(|lease| {
                    lease.circuit == ProbeCircuit::Quota
                        && lease.quota_class.is_some_and(|c| c != class)
                });
                if current.probe_lease.is_some() && !foreign_probe {
                    continue;
                }
                let block = current.capacity_quota_block(class, reset, observation.snapshot_at_ms);
                current.insert_quota_block(class, block);
                if !foreign_probe {
                    current.generation = next_generation(current.generation)?;
                }
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
        model: &ModelId,
        class: CodexQuotaClass,
        now: i64,
    ) -> Result<RouteSelection, GatewayError> {
        if gateway_schema::reasoning::js_trim_source(model.as_js_string())
            .as_units()
            .is_empty()
        {
            return Err(invalid("Missing or oversized authority identity."));
        }
        self.select_account_source(model, class, now).await
    }

    /// Live preserves the source optional model and never mints an inference/quota/paid proof.
    pub async fn select_live_account(
        &self,
        model: Option<&gateway_core::js_string::JsString16>,
        now: i64,
    ) -> Result<LiveRouteSelection, GatewayError> {
        let lexical = model
            .cloned()
            .map(ModelId::from_source)
            .unwrap_or_else(|| ModelId::from_scalar(""));
        let class = model_quota_class(&lexical);
        Ok(
            match self.select_account_source(&lexical, class, now).await? {
                RouteSelection::Eligible(a) => LiveRouteSelection::Eligible(LiveAccountSelection {
                    binding: a.binding,
                    active_generation: a.active_generation,
                    quota_class: class,
                    probe_required: a.probe_required,
                    model: model.cloned(),
                }),
                RouteSelection::QuotaBlocked { retry_at_ms, .. } => {
                    LiveRouteSelection::QuotaBlocked { retry_at_ms }
                }
                RouteSelection::CredentialsInvalid { .. } => LiveRouteSelection::CredentialsInvalid,
                RouteSelection::ModelUnavailable { detail, .. } => {
                    LiveRouteSelection::ModelUnavailable { detail }
                }
                RouteSelection::RoutingUnavailable => LiveRouteSelection::RoutingUnavailable,
            },
        )
    }

    pub async fn ensure_live_account_current(
        &self,
        selection: &LiveAccountSelection,
        now: i64,
    ) -> Result<(), GatewayError> {
        validate_binding(&selection.binding)?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let view = read_view(&mut tx).await?;
            let slot = usize::try_from(selection.binding.slot)
                .map_err(|_| invalid("Invalid live slot."))?;
            if !view.current_binding(&selection.binding)
                || view.active.as_ref().is_none_or(|active| {
                    active.binding != selection.binding
                        || active.generation != selection.active_generation
                })
                || view.state.slots[slot].invalid_credential_version.as_ref()
                    == Some(&selection.binding.credential_version)
            {
                return Err(unavailable(
                    "codex_routing_unavailable",
                    "Live selection changed.",
                ));
            }
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Live selection changed concurrently.",
        ))
    }

    pub async fn mark_live_credential_invalid(
        &self,
        selection: &LiveAccountSelection,
        now: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            if !view.current_binding(&selection.binding) {
                return Ok(false);
            }
            let slot = &mut view.state.slots[selection.binding.slot as usize];
            slot.invalid_credential_version = Some(selection.binding.credential_version.clone());
            slot.upstream_timeout_blocked_until_ms = None;
            slot.quota_signal_observed_at_ms = Some(now);
            slot.retained_reset_at_ms = slot
                .quota_blocks
                .values()
                .filter_map(|block| block.reset_at_ms)
                .max()
                .or(slot.retained_reset_at_ms);
            slot.clear_quota_blocks();
            slot.probe_lease = None;
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Live credential changed concurrently.",
        ))
    }

    async fn select_account_source(
        &self,
        model: &ModelId,
        class: CodexQuotaClass,
        now: i64,
    ) -> Result<RouteSelection, GatewayError> {
        self.reconcile_capacity_for_model(model, now).await?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            let prior = tx
                .read::<serde_json::Value>(&keys::routing())
                .await?
                .as_ref()
                .map(parse_routing_state)
                .transpose()?;
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
            if prior.as_ref().is_none_or(|p| {
                p.slots != view.state.slots
                    || p.legacy_identity_unresolved != view.state.legacy_identity_unresolved
            }) {
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
            if let Some(probe) = &admission.probe {
                let slot = &view.state.slots[admission.binding.slot as usize];
                if slot.probe_lease.as_ref() != Some(probe)
                    || probe.expires_at_ms <= self.fresh_time(now)?
                {
                    return Err(unavailable(
                        "codex_routing_unavailable",
                        "Codex probe lease is stale.",
                    ));
                }
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
        self.record_bound_quota_block(
            &admission.binding,
            admission.quota_class,
            admission.probe.as_ref(),
            block,
            now,
        )
        .await
    }

    /// Shared source writer; non-inference callers retain their own sealed physical dispatch.
    pub(crate) async fn record_bound_quota_block(
        &self,
        binding: &AccountBinding,
        class: CodexQuotaClass,
        probe: Option<&ProbeLease>,
        block: QuotaBlock,
        now: i64,
    ) -> Result<bool, GatewayError> {
        nonnegative(block.blocked_until_ms)?;
        if let Some(at) = block.observed_at_ms {
            nonnegative(at)?;
        }
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_pinned_view(&mut tx).await?;
            let slot_index = binding.slot as usize;
            let foreign_probe = view.state.slots.get(slot_index).is_some_and(|slot| {
                slot.account_id_hash.as_ref() == Some(&binding.account_id_hash)
                    && slot.credential_version == binding.credential_version
                    && view.pool.pool_versionstamp == binding.pool_versionstamp
                    && slot
                        .probe_lease
                        .as_ref()
                        .is_some_and(|lease| lease.quota_class.is_some_and(|c| c != class))
                    && probe.is_none()
            });
            if !view.current_binding(binding) && !foreign_probe {
                return Ok(false);
            }
            let slot = &mut view.state.slots[binding.slot as usize];
            let prior = slot.quota_blocks.get(class_name(class));
            if prior.is_some_and(|prior| prior.observed_at_ms > block.observed_at_ms) {
                return Ok(false);
            }
            let mut next = block.clone();
            if let Some(prior) = prior {
                next.blocked_until_ms = next.blocked_until_ms.max(prior.blocked_until_ms);
                next.reset_ambiguous |= prior.reset_ambiguous
                    || (prior.reset_is_stable && prior.reset_at_ms != next.reset_at_ms);
            }
            slot.insert_quota_block(class, next);
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
            slot.upstream_timeout_blocked_until_ms = None;
            slot.quota_signal_observed_at_ms = Some(now);
            slot.retained_reset_at_ms = slot
                .quota_blocks
                .values()
                .filter_map(|block| block.reset_at_ms)
                .max()
                .or(slot.retained_reset_at_ms);
            slot.clear_quota_blocks();
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
        detail: &JsString16,
        now: i64,
    ) -> Result<bool, GatewayError> {
        let expected = crate::source_models::unsupported_detail(&admission.requested_model);
        if detail != &expected {
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
                self.source_string_collator(),
            )?;
            tx.put_source_control(&keys::models(), &models, None)?;
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
