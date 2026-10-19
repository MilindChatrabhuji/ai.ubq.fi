//! Source v3 campaign/evidence CAS, using the one existing authority store.
use super::{
    model::*,
    target::{key, resolve},
};
use crate::{Authority, TokenSource, store::Transaction};
use gateway_core::{
    GatewayError,
    state::{AuthorityStore, RecordKey},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) fn record_key(kind: &str, target: &TargetBinding) -> RecordKey {
    let mut parts = vec![
        "uos_ai",
        "prompt_cache_scope_experiment",
        "v5",
        kind,
        target.provider.as_str(),
        target.telemetry_provider.as_str(),
    ];
    if kind != "campaign" {
        parts.push(&target.topology_kind);
    }
    parts.push(&target.probe_profile);
    if kind != "campaign" {
        parts.push(&target.model);
    }
    key(&parts)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
struct CycleLease {
    owner: String,
    lease_until_ms: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
struct CampaignLease {
    owner: String,
    target_id: String,
    inventory_fingerprint: String,
    lease_until_ms: i64,
}
fn active(value: &Option<Value>, now: i64) -> bool {
    value
        .as_ref()
        .and_then(|v| v["lease_until_ms"].as_f64())
        .is_some_and(|v| v.fract() == 0.0 && v > now as f64 && v <= 9_007_199_254_740_991.0)
}
pub(super) fn owns(value: &Option<Value>, owner: &str, now: i64) -> bool {
    active(value, now) && value.as_ref().is_some_and(|v| v["owner"] == owner)
}
pub(super) fn campaign_owned(value: &Option<Value>, state: &State, now: i64) -> bool {
    owns(value, &state.campaign_owner, now)
        && value.as_ref().is_some_and(|v| {
            v["target_id"] == state.target.id
                && v["inventory_fingerprint"] == state.target.inventory_fingerprint
        })
}
fn parse<T: serde::de::DeserializeOwned>(
    raw: Option<Value>,
    valid: impl FnOnce(&T) -> bool,
    label: &str,
) -> Result<Option<T>, GatewayError> {
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let value = serde_json::from_value(value).map_err(|_| unavailable(label))?;
            if !valid(&value) {
                return Err(unavailable(label));
            }
            Ok(Some(value))
        }
    }
}
pub(super) async fn records<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    target: &TargetBinding,
) -> Result<(Option<State>, Option<Evidence>), GatewayError> {
    let state = tx.read::<Value>(&record_key("state", target)).await?;
    let evidence = tx.read::<Value>(&record_key("evidence", target)).await?;
    let state = parse(
        state,
        |s: &State| s.valid(tx.now),
        "Prompt-cache scope experiment has malformed target-scoped state.",
    )?;
    let evidence = parse(
        evidence,
        |e: &Evidence| e.valid(tx.now),
        "Prompt-cache scope experiment has malformed target-scoped evidence.",
    )?;
    if let Some(state) = &state {
        let coherent = if state.classifications.is_empty() {
            evidence.is_none()
        } else {
            evidence.as_ref().is_some_and(|e| e.consistent_with(state))
        };
        if !coherent {
            return Err(unavailable(
                "Prompt-cache scope experiment has inconsistent target-scoped durable evidence.",
            ));
        }
    }
    Ok((state, evidence))
}
pub(super) async fn select_target<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    targets: Vec<TargetBinding>,
) -> Result<TargetBinding, GatewayError> {
    if targets.is_empty() {
        return Err(unavailable(
            "Prompt-cache scope experiment has no probeable Codex target in the current inventory.",
        ));
    }
    let mut all = Vec::new();
    for target in targets {
        let (state, evidence) = records(tx, &target).await?;
        all.push((target, state, evidence));
    }
    let active = all
        .iter()
        .filter(|(_, s, _)| s.as_ref().is_some_and(|s| s.expires_at_ms > tx.now))
        .collect::<Vec<_>>();
    if active.len() > 1 {
        return Err(unavailable(
            "Prompt-cache scope experiment found more than one active provider campaign.",
        ));
    }
    if let Some((target, Some(state), _)) = active.first().copied() {
        if !state.target.same_core(target) {
            return Err(unavailable(
                "Prompt-cache scope experiment target changed while its campaign was active.",
            ));
        }
        if state.target.inventory_fingerprint != target.inventory_fingerprint {
            return Err(unavailable(
                "Prompt-cache scope experiment inventory changed while its campaign was active.",
            ));
        }
        return Ok(target.clone());
    }
    for (target, _, evidence) in all {
        if !evidence
            .is_some_and(|e| e.outcome == Outcome::Completed && e.target.same_definition(&target))
        {
            return Ok(target);
        }
    }
    Err(unavailable(
        "Prompt-cache scope experiment has no nonterminal probeable Codex target in the current inventory.",
    ))
}
pub(super) struct CyclePermit {
    pub state: State,
    pub cycle_owner: String,
}
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub(super) async fn acquire_cache_cycle(
        &self,
        target: &TargetBinding,
        pool_revision: &str,
        now: i64,
    ) -> Result<CyclePermit, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let (existing, evidence) = records(&mut tx, target).await?;
            let cycle_key = record_key("cycle_lease", target);
            let campaign_key = record_key("campaign", target);
            let cycle = tx.read::<Value>(&cycle_key).await?;
            let campaign = tx.read::<Value>(&campaign_key).await?;
            let current = self.fresh_time(now)?;
            tx.now = current;
            if active(&cycle, current) {
                return Err(busy());
            }
            let resetting = existing.as_ref().is_none_or(|s| s.expires_at_ms <= current);
            let state = if let Some(mut state) = existing.filter(|s| s.expires_at_ms > current) {
                if !state.target.same_core(target)
                    || state.target.inventory_fingerprint != target.inventory_fingerprint
                {
                    return Err(unavailable(
                        "Prompt-cache scope experiment target changed while its campaign was active.",
                    ));
                }
                if !campaign_owned(&campaign, &state, current) {
                    return Err(if active(&campaign, current) {
                        busy()
                    } else {
                        unavailable(
                            "Prompt-cache scope experiment lost its provider campaign lease.",
                        )
                    });
                }
                state.target = target.clone();
                state
            } else {
                if active(&campaign, current) {
                    return Err(busy());
                }
                State {
                    v: 3,
                    target: target.clone(),
                    campaign_owner: self.tokens.next_token()?,
                    started_at_ms: current,
                    expires_at_ms: crate::add(current, SESSION_MS)?,
                    auth_pool_versionstamp: pool_revision.into(),
                    next_cycle: 1,
                    classifications: vec![],
                    pending_scope: None,
                }
            };
            let owner = self.tokens.next_token()?;
            tx.put(
                &cycle_key,
                &CycleLease {
                    owner: owner.clone(),
                    lease_until_ms: crate::add(current, LEASE_MS)?,
                },
                Some(crate::add(current, LEASE_MS * 2)?),
            )?;
            tx.put(
                &campaign_key,
                &CampaignLease {
                    owner: state.campaign_owner.clone(),
                    target_id: state.target.id.clone(),
                    inventory_fingerprint: state.target.inventory_fingerprint.clone(),
                    lease_until_ms: state.expires_at_ms,
                },
                Some(state.expires_at_ms),
            )?;
            tx.put(
                &record_key("state", target),
                &state,
                Some(state.expires_at_ms),
            )?;
            if resetting && evidence.is_some() {
                tx.delete(&record_key("evidence", target))?;
            }
            if tx.commit().await? {
                return Ok(CyclePermit {
                    state,
                    cycle_owner: owner,
                });
            }
        }
        Err(busy())
    }
    pub(super) async fn renew_cache_cycle(
        &self,
        permit: &CyclePermit,
        now: i64,
    ) -> Result<(), GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let state = &permit.state;
            let cycle_key = record_key("cycle_lease", &state.target);
            let campaign_key = record_key("campaign", &state.target);
            let cycle = tx.read::<Value>(&cycle_key).await?;
            let campaign = tx.read::<Value>(&campaign_key).await?;
            let current = self.fresh_time(now)?;
            if !owns(&cycle, &permit.cycle_owner, current)
                || !campaign_owned(&campaign, state, current)
            {
                return Err(failed("Prompt-cache scope experiment lost its lease."));
            }
            tx.put(
                &cycle_key,
                &CycleLease {
                    owner: permit.cycle_owner.clone(),
                    lease_until_ms: crate::add(current, LEASE_MS)?,
                },
                Some(crate::add(current, LEASE_MS * 2)?),
            )?;
            tx.put(
                &campaign_key,
                &CampaignLease {
                    owner: state.campaign_owner.clone(),
                    target_id: state.target.id.clone(),
                    inventory_fingerprint: state.target.inventory_fingerprint.clone(),
                    lease_until_ms: state.expires_at_ms,
                },
                Some(state.expires_at_ms),
            )?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(failed(
            "Prompt-cache scope experiment could not renew its lease.",
        ))
    }
    async fn cache_transition(
        &self,
        permit: &CyclePermit,
        next: Option<&State>,
        outcome: Outcome,
        cycle: Option<&Cycle>,
        reason: Option<Reason>,
        now: i64,
    ) -> Result<Value, GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let state = &permit.state;
            let (persisted, prior) = records(&mut tx, &state.target)
                .await
                .map_err(|e| failed(&e.envelope.error.message))?;
            let cycle_key = record_key("cycle_lease", &state.target);
            let campaign_key = record_key("campaign", &state.target);
            let lease = tx.read::<Value>(&cycle_key).await?;
            let campaign = tx.read::<Value>(&campaign_key).await?;
            let current = self.fresh_time(now)?;
            if !owns(&lease, &permit.cycle_owner, current)
                || !campaign_owned(&campaign, state, current)
            {
                return Err(failed("Prompt-cache scope experiment lost its lease."));
            }
            let persisted = persisted.ok_or_else(|| {
                failed("Prompt-cache scope experiment state changed concurrently.")
            })?;
            if persisted.started_at_ms != state.started_at_ms
                || persisted.campaign_owner != state.campaign_owner
                || !persisted.target.same_definition(&state.target)
                || (next.is_some() && persisted.next_cycle != state.next_cycle)
            {
                return Err(failed(
                    "Prompt-cache scope experiment state changed concurrently.",
                ));
            }
            let mut cycles = prior.map(|e| e.cycles).unwrap_or_default();
            if let Some(cycle) = cycle {
                cycles.push(cycle.clone());
            }
            let evidence = Evidence {
                v: 3,
                target: next.unwrap_or(state).target.clone(),
                outcome,
                started_at_ms: state.started_at_ms,
                verified_at_ms: current,
                cycles,
                inconclusive_reason: reason,
            };
            let expiry = next.map(|s| s.expires_at_ms);
            tx.put(&record_key("evidence", &state.target), &evidence, expiry)?;
            if let Some(next) = next {
                tx.put(&record_key("state", &state.target), next, expiry)?;
                if next.next_cycle <= 3 {
                    tx.delete(&cycle_key)?;
                }
            } else {
                tx.delete(&record_key("state", &state.target))?;
                tx.delete(&cycle_key)?;
                tx.delete(&campaign_key)?;
            }
            if tx.commit().await? {
                let count = state.classifications.len()
                    + usize::from(cycle.is_some_and(|c| c.classification.is_some()));
                let mut result = json!({"provider":PROVIDER,"telemetry_provider":TELEMETRY_PROVIDER,"target_id":state.target.id,"model":state.target.model,"status":if next.is_some(){"in_progress"}else if outcome==Outcome::Completed{"completed"}else{"inconclusive"},"completed_cycles":count,"verified_at_ms":current});
                if let Some(reason) = reason {
                    result["inconclusive_reason"] = json!(reason);
                }
                if outcome == Outcome::Completed {
                    result["scope"] = json!(state.pending_scope);
                }
                return Ok(result);
            }
        }
        Err(failed(if next.is_some() {
            "Prompt-cache scope experiment evidence could not be persisted."
        } else {
            "Prompt-cache scope experiment final result could not be persisted."
        }))
    }
    pub(super) async fn persist_cache_cycle(
        &self,
        permit: &CyclePermit,
        next: &State,
        cycle: &Cycle,
        now: i64,
    ) -> Result<Value, GatewayError> {
        self.cache_transition(
            permit,
            Some(next),
            if next.next_cycle == 4 {
                Outcome::ReadyToPromote
            } else {
                Outcome::InProgress
            },
            Some(cycle),
            None,
            now,
        )
        .await
    }
    pub(super) async fn finalize_cache_cycle(
        &self,
        permit: &CyclePermit,
        outcome: Outcome,
        cycle: Option<&Cycle>,
        reason: Option<Reason>,
        now: i64,
    ) -> Result<Value, GatewayError> {
        self.cache_transition(permit, None, outcome, cycle, reason, now)
            .await
    }
    pub(super) async fn current_cache_target(
        &self,
        expected: &TargetBinding,
        now: i64,
    ) -> Result<Result<TargetBinding, Reason>, GatewayError> {
        resolve(&mut self.transaction(now)?, expected).await
    }
}
