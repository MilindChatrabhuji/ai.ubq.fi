//! Source class-fallback and capacity reconciliation rules, separate from producer custody.
use crate::capacity_rules::{capacity_headroom_for_observation, capacity_observation_is_fresh};
use crate::routing_codec::CLASSES;
use crate::{
    next_generation,
    routing::{CapacityObservation, QuotaBlock, RoutingSlot, RoutingState, class_name},
};
use gateway_core::{GatewayError, model::ModelId, provider::CodexQuotaClass};
use std::collections::BTreeMap;

impl RoutingSlot {
    pub fn effective_quota_blocks(&self) -> BTreeMap<String, QuotaBlock> {
        let mut blocks = self.quota_blocks.clone();
        if let (Some(until), Some(source)) = (self.quota_blocked_until_ms, self.quota_block_source)
        {
            let classes: Vec<_> = self
                .quota_blocked_classes
                .iter()
                .filter(|name| CLASSES.contains(&name.as_str()))
                .map(String::as_str)
                .collect();
            let classes = if classes.is_empty() {
                CLASSES.to_vec()
            } else {
                classes
            };
            for class in classes {
                blocks.entry(class.into()).or_insert_with(|| QuotaBlock {
                    blocked_until_ms: until,
                    source,
                    legacy_fallback: true,
                    observed_at_ms: self.quota_signal_observed_at_ms,
                    reset_at_ms: self.retained_reset_at_ms,
                    reset_is_stable: self.reset_identity_stable,
                    reset_ambiguous: self.reset_identity_ambiguous,
                    recovery_pending: self.recovery_pending,
                });
            }
        }
        blocks
    }
    pub fn quota_block_for(&self, class: CodexQuotaClass) -> Option<QuotaBlock> {
        let name = class_name(class);
        let legacy = self
            .quota_blocked_until_ms
            .zip(self.quota_block_source)
            .filter(|_| self.quota_blocks.is_empty())
            .filter(|_| {
                let known: Vec<_> = self
                    .quota_blocked_classes
                    .iter()
                    .filter(|c| CLASSES.contains(&c.as_str()))
                    .collect();
                known.is_empty()
                    || class == CodexQuotaClass::Unknown
                    || known
                        .iter()
                        .any(|c| c.as_str() == "unknown" || c.as_str() == name)
            })
            .map(|(until, source)| QuotaBlock {
                blocked_until_ms: until,
                source,
                legacy_fallback: true,
                observed_at_ms: self.quota_signal_observed_at_ms,
                reset_at_ms: self.retained_reset_at_ms,
                reset_is_stable: self.reset_identity_stable,
                reset_ambiguous: self.reset_identity_ambiguous,
                recovery_pending: self.recovery_pending,
            });
        [
            self.quota_blocks.get(name).cloned(),
            if class == CodexQuotaClass::Unknown {
                None
            } else {
                self.quota_blocks.get("unknown").cloned()
            },
            legacy,
        ]
        .into_iter()
        .flatten()
        .reduce(|a, b| {
            if b.blocked_until_ms > a.blocked_until_ms {
                b
            } else {
                a
            }
        })
    }
    pub fn quota_signal_for(&self, class: CodexQuotaClass) -> Option<i64> {
        let blocks = self.effective_quota_blocks();
        let name = class_name(class);
        [
            blocks.get(name),
            if class == CodexQuotaClass::Unknown {
                None
            } else {
                blocks.get("unknown")
            },
        ]
        .into_iter()
        .flatten()
        .filter_map(|b| b.observed_at_ms.or(self.quota_signal_observed_at_ms))
        .max()
        .or(self.quota_signal_observed_at_ms)
    }
    fn effective_block_order(&self) -> Vec<String> {
        let mut order: Vec<_> = CLASSES
            .into_iter()
            .filter(|class| self.quota_blocks.contains_key(*class))
            .map(str::to_owned)
            .collect();
        if self.quota_blocked_until_ms.is_some() && self.quota_block_source.is_some() {
            let named: Vec<_> = self
                .quota_blocked_classes
                .iter()
                .filter(|class| CLASSES.contains(&class.as_str()))
                .cloned()
                .collect();
            let legacy = if named.is_empty() {
                CLASSES.into_iter().map(str::to_owned).collect()
            } else {
                named
            };
            for class in legacy {
                if !order.contains(&class) {
                    order.push(class);
                }
            }
        }
        order
    }
    fn synchronize_class_facts(&mut self, order: Vec<String>) {
        self.quota_blocked_classes = order
            .into_iter()
            .filter(|class| self.quota_blocks.contains_key(class))
            .collect();
        let latest = self
            .quota_blocked_classes
            .iter()
            .filter_map(|class| self.quota_blocks.get(class))
            .reduce(|a, b| {
                if b.blocked_until_ms > a.blocked_until_ms {
                    b
                } else {
                    a
                }
            });
        self.quota_blocked_until_ms = latest.map(|b| b.blocked_until_ms);
        self.quota_block_source = latest.map(|b| b.source);
        self.quota_signal_observed_at_ms = self
            .quota_blocks
            .values()
            .filter_map(|b| b.observed_at_ms)
            .max()
            .or(self.quota_signal_observed_at_ms);
        self.retained_reset_at_ms = latest.and_then(|b| b.reset_at_ms);
        self.reset_identity_stable = latest.is_some_and(|b| b.reset_is_stable);
        self.reset_identity_ambiguous = self.quota_blocks.values().any(|b| b.reset_ambiguous);
        self.recovery_pending = self.quota_blocks.values().any(|b| b.recovery_pending);
    }
    pub(crate) fn insert_quota_block(&mut self, class: CodexQuotaClass, block: QuotaBlock) {
        let mut order = self.effective_block_order();
        let name = class_name(class).to_owned();
        if !order.contains(&name) {
            order.push(name.clone());
        }
        self.quota_blocks = self.effective_quota_blocks();
        self.quota_blocks.insert(name, block.clone());
        self.synchronize_class_facts(order);
        // Source insertion seeds the reducer with the newly written class, so
        // that class owns slot-wide reset metadata when deadlines tie.
        if self.quota_blocked_until_ms == Some(block.blocked_until_ms) {
            self.quota_block_source = Some(block.source);
            self.retained_reset_at_ms = block.reset_at_ms;
            self.reset_identity_stable = block.reset_is_stable;
        }
    }
    pub(crate) fn remove_quota_class(&mut self, class: CodexQuotaClass) {
        let order = self.effective_block_order();
        let selected = self.quota_block_for(class);
        self.quota_blocks = self.effective_quota_blocks();
        let key = if self.quota_blocks.get(class_name(class)) == selected.as_ref() {
            class_name(class)
        } else if class != CodexQuotaClass::Unknown
            && self.quota_blocks.get("unknown") == selected.as_ref()
            && selected.as_ref().is_some_and(|b| b.legacy_fallback)
        {
            "unknown"
        } else {
            class_name(class)
        };
        self.quota_blocks.remove(key);
        if key != "unknown"
            && self
                .quota_blocks
                .get("unknown")
                .is_some_and(|b| b.legacy_fallback)
        {
            self.quota_blocks.remove("unknown");
        }
        self.synchronize_class_facts(order);
    }
    /// Materialize the requested class from a fresh capacity exhaustion
    /// observation. The usage read describes the current provider window, so
    /// it supersedes a retained future deadline whose reset identity became
    /// ambiguous. The caller has already proved that no live quota signal is
    /// newer than this sample.
    pub(crate) fn capacity_quota_block(
        &self,
        class: CodexQuotaClass,
        reset: i64,
        observed_at_ms: i64,
    ) -> QuotaBlock {
        let prior = self.quota_block_for(class);
        QuotaBlock {
            blocked_until_ms: reset,
            source: crate::routing::QuotaBlockSource::HeaderRetryAfter,
            legacy_fallback: false,
            observed_at_ms: Some(observed_at_ms),
            reset_at_ms: Some(reset),
            reset_is_stable: true,
            reset_ambiguous: false,
            recovery_pending: self.recovery_pending
                || prior.as_ref().is_some_and(|block| block.recovery_pending),
        }
    }
    pub(crate) fn clear_quota_blocks(&mut self) {
        self.quota_blocks.clear();
        self.quota_blocked_classes.clear();
        self.quota_blocked_until_ms = None;
        self.quota_block_source = None;
    }
}
pub fn apply_capacity_observation(
    state: &RoutingState,
    row: &CapacityObservation,
    now: i64,
    model: Option<&ModelId>,
    updated_at_ms: i64,
) -> Result<Option<RoutingState>, GatewayError> {
    if row.snapshot_at_ms > now {
        return Ok(None);
    }
    let Some(current) = state.slots.get(usize::from(row.slot)) else {
        return Ok(None);
    };
    if current.account_id_hash.as_ref() != Some(&row.account_id_hash)
        || current
            .capacity_observed_at_ms
            .is_some_and(|at| row.snapshot_at_ms < at)
    {
        return Ok(None);
    }
    let class = model
        .map(crate::routing::model_quota_class)
        .unwrap_or(CodexQuotaClass::Unknown);
    let positive = capacity_observation_is_fresh(row, now)
        && capacity_headroom_for_observation(row, model).is_some_and(|h| h > 0.0);
    let newer = current
        .quota_signal_for(class)
        .is_some_and(|at| at >= row.snapshot_at_ms);
    let clear = positive && !newer;
    let mut slot = current.clone();
    if clear {
        slot.remove_quota_class(class);
    }
    slot.primary_used_percent = row.windows.primary.as_ref().and_then(|w| w.used_percent);
    slot.secondary_used_percent = row.windows.secondary.as_ref().and_then(|w| w.used_percent);
    slot.capacity_observed_at_ms = Some(row.snapshot_at_ms);
    if clear {
        if current.reset_identity_ambiguous
            || current.recovery_pending
            || current.probe_lease.is_some()
        {
            slot.retained_reset_at_ms = current.retained_reset_at_ms;
            slot.reset_identity_stable = current.reset_identity_stable;
            slot.reset_identity_ambiguous = current.reset_identity_ambiguous;
            slot.recovery_pending = current.recovery_pending;
            slot.probe_lease = current.probe_lease.clone();
        } else if slot.quota_blocks.is_empty() {
            slot.retained_reset_at_ms = None;
            slot.reset_identity_stable = false;
            slot.reset_identity_ambiguous = false;
            slot.recovery_pending = false;
            slot.generation = next_generation(current.generation)?;
            slot.probe_lease = None;
        }
    }
    if &slot == current {
        return Ok(None);
    }
    let mut next = state.clone();
    next.slots[usize::from(row.slot)] = slot;
    next.updated_at_ms = updated_at_ms;
    Ok(Some(next))
}
