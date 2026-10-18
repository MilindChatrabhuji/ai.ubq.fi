//! Bounded routing and scoped overage probe transitions.
use crate::routing::{
    AdmittedAccount, CohortProof, ProbeLease, QuotaBlock, ScopedOverageProbe, class_name,
    read_view, validate_cohort,
};
use crate::{
    Authority, PROBE_LEASE_MS, TokenSource, add, invalid, keys, next_generation, nonnegative, text,
    unavailable,
};
use gateway_core::GatewayError;
use gateway_core::identity::RoutingAccountHash;
use gateway_core::state::AuthorityStore;

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    /// Called only by the bounded probe/overage route; permission is strongly checked here.
    pub async fn claim_probe(
        &self,
        admission: &AdmittedAccount,
        overage_reason: Option<&str>,
        now: i64,
    ) -> Result<Option<AdmittedAccount>, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            if !view.matches(admission) {
                return Ok(None);
            }
            let allowed = view
                .overage
                .get(&admission.binding.account_id_hash.0)
                .copied()
                .unwrap_or(false);
            if let Some(reason) = overage_reason {
                if !allowed
                    || !matches!(
                        reason,
                        "no_eligible_credit"
                            | "inventory_empty"
                            | "inventory_no_eligible_codex_credit"
                            | "inventory_response_invalid_or_expired"
                            | "inventory_unavailable"
                            | "account_day_limit_reached"
                    )
                {
                    return Ok(None);
                }
            }
            let slot = &mut view.state.slots[admission.binding.slot as usize];
            if slot
                .probe_lease
                .as_ref()
                .is_some_and(|lease| lease.expires_at_ms > now)
            {
                return Ok(None);
            }
            if overage_reason.is_none()
                && slot
                    .quota_blocks
                    .get(class_name(admission.quota_class))
                    .is_some_and(|block| block.blocked_until_ms > now)
                && !allowed
            {
                return Ok(None);
            }
            let next_generation = next_generation(slot.generation)?;
            let lease = ProbeLease {
                token: self.tokens.next_token()?,
                generation: next_generation,
                quota_class: admission.quota_class,
                expires_at_ms: add(now, PROBE_LEASE_MS)?,
            };
            text(&lease.token)?;
            slot.generation = next_generation;
            slot.probe_lease = Some(lease.clone());
            let mut admitted = admission.clone();
            admitted.binding.routing_generation = next_generation;
            admitted.probe = Some(lease);
            admitted.probe_required = false;
            let mut active = view
                .active
                .ok_or_else(|| invalid("Probe is missing its active selection."))?;
            active.binding = admitted.binding.clone();
            active.updated_at_ms = now;
            tx.put(&keys::routing(), &view.state, None)?;
            tx.put(&keys::active(), &active, None)?;
            if tx.commit().await? {
                return Ok(Some(admitted));
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Probe claim changed concurrently.",
        ))
    }

    pub async fn finish_probe(
        &self,
        admission: &AdmittedAccount,
        recovered: bool,
        now: i64,
    ) -> Result<bool, GatewayError> {
        let Some(expected) = &admission.probe else {
            return Ok(false);
        };
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            if !view.current_binding(&admission.binding) {
                return Ok(false);
            }
            let slot = &mut view.state.slots[admission.binding.slot as usize];
            if slot.probe_lease.as_ref() != Some(expected) {
                return Ok(false);
            }
            slot.probe_lease = None;
            if recovered {
                slot.quota_blocks.remove(class_name(admission.quota_class));
                if slot.quota_blocks.is_empty() {
                    slot.retained_reset_at_ms = None;
                    slot.reset_identity_ambiguous = false;
                }
            }
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Probe completion changed concurrently.",
        ))
    }

    /// An explicitly permitted overage probe has a narrow lease, not a new global election.
    pub async fn claim_overage_probe(
        &self,
        proof: &CohortProof,
        preferred: Option<&RoutingAccountHash>,
        reason: &str,
        now: i64,
    ) -> Result<Option<ScopedOverageProbe>, GatewayError> {
        if !matches!(
            reason,
            "no_eligible_credit"
                | "inventory_empty"
                | "inventory_no_eligible_codex_credit"
                | "inventory_response_invalid_or_expired"
                | "inventory_unavailable"
                | "account_day_limit_reached"
        ) {
            return Ok(None);
        }
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            if !validate_cohort(&mut tx, proof, true).await? {
                return Ok(None);
            }
            let mut view = read_view(&mut tx).await?;
            let selected = preferred
                .and_then(|hash| {
                    view.pool
                        .accounts
                        .iter()
                        .position(|account| account.enabled && &account.account_id_hash == hash)
                })
                .or_else(|| {
                    view.active.as_ref().and_then(|active| {
                        view.pool.accounts.iter().position(|account| {
                            account.enabled
                                && account.account_id_hash == active.binding.account_id_hash
                        })
                    })
                })
                .or_else(|| {
                    view.pool
                        .accounts
                        .iter()
                        .position(|account| account.enabled)
                });
            let Some(slot_index) = selected else {
                return Ok(None);
            };
            let account = &view.pool.accounts[slot_index];
            if !view
                .overage
                .get(&account.account_id_hash.0)
                .copied()
                .unwrap_or(false)
            {
                return Ok(None);
            }
            let slot = &mut view.state.slots[slot_index];
            if slot
                .probe_lease
                .as_ref()
                .is_some_and(|lease| lease.expires_at_ms > now)
            {
                return Ok(None);
            }
            slot.generation = next_generation(slot.generation)?;
            let lease = ProbeLease {
                token: self.tokens.next_token()?,
                generation: slot.generation,
                quota_class: proof.quota_class,
                expires_at_ms: add(now, PROBE_LEASE_MS)?,
            };
            text(&lease.token)?;
            slot.probe_lease = Some(lease.clone());
            let probe = ScopedOverageProbe {
                binding: view.binding(slot_index),
                requested_model: proof.model.clone(),
                quota_class: proof.quota_class,
                probe: lease,
            };
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(Some(probe));
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Overage probe changed concurrently.",
        ))
    }

    pub async fn ensure_overage_probe_current(
        &self,
        probe: &ScopedOverageProbe,
        now: i64,
    ) -> Result<(), GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let view = read_view(&mut tx).await?;
            let slot = probe.binding.slot as usize;
            if slot >= view.state.slots.len()
                || view.binding(slot) != probe.binding
                || view.state.slots[slot].probe_lease.as_ref() != Some(&probe.probe)
                || probe.probe.expires_at_ms <= now
            {
                return Err(unavailable(
                    "codex_routing_unavailable",
                    "Overage lease is no longer current.",
                ));
            }
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Overage dispatch changed concurrently.",
        ))
    }

    pub async fn finish_overage_probe(
        &self,
        probe: &ScopedOverageProbe,
        recovered: bool,
        now: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            let slot = probe.binding.slot as usize;
            if slot >= view.state.slots.len()
                || view.binding(slot) != probe.binding
                || view.state.slots[slot].probe_lease.as_ref() != Some(&probe.probe)
            {
                return Ok(false);
            }
            view.state.slots[slot].probe_lease = None;
            if recovered {
                view.state.slots[slot]
                    .quota_blocks
                    .remove(class_name(probe.quota_class));
            }
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Overage completion changed concurrently.",
        ))
    }

    pub async fn record_overage_quota_block(
        &self,
        probe: &ScopedOverageProbe,
        block: QuotaBlock,
        now: i64,
    ) -> Result<bool, GatewayError> {
        nonnegative(block.blocked_until_ms)?;
        nonnegative(block.observed_at_ms)?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = read_view(&mut tx).await?;
            let slot = probe.binding.slot as usize;
            if !view.current_binding(&probe.binding)
                || view.state.slots[slot].probe_lease.as_ref() != Some(&probe.probe)
            {
                return Ok(false);
            }
            let row = &mut view.state.slots[slot];
            row.quota_blocks
                .insert(class_name(probe.quota_class).to_owned(), block.clone());
            row.probe_lease = None;
            row.generation = next_generation(row.generation)?;
            view.state.updated_at_ms = now;
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "codex_routing_unavailable",
            "Overage quota evidence changed concurrently.",
        ))
    }
}
