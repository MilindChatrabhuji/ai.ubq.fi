//! Source banked-reset-pool.ts. Shadow audits are data; live selection is direct and fail-closed.
mod audit;
mod facts;
mod selection;
mod types;

use crate::{
    Authority, TokenSource, keys,
    reset::{ResetConfig, ResetMode},
    routing::CohortProof,
    store::Transaction,
};
use gateway_core::{
    GatewayError, identity::RequestContext, source_json::SourceJson, state::AuthorityStore,
    value::ValueEncoding,
};
pub use types::{
    AutomaticResetPermit, FullPoolEvaluation, FullPoolFence, FullPoolPreparation,
    FullPoolResetPlan, FullPoolShadowDecision, SourceCreditCollation, SourceResetCredit,
    SourceResetInventory,
};
use types::{Facts, Member};

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Full-pool reset shadow schema or custody is invalid.",
        "codex_reset_shadow_schema_invalid",
    )
}
fn declined(reason: &str) -> GatewayError {
    GatewayError::unavailable("Automatic banked reset is not authorized.", reason)
}
fn reason(error: GatewayError) -> String {
    error
        .envelope
        .error
        .code
        .unwrap_or_else(|| "configuration_unavailable".into())
}

async fn read_audit<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    episode_hash: &str,
) -> Result<(bool, Option<FullPoolShadowDecision>), GatewayError> {
    let key = keys::reset_shadow(episode_hash);
    let row = tx.read_full_pool_reset_audit(episode_hash).await?;
    let present = match row.as_ref() {
        None => false,
        Some(row) => match row.value_encoding {
            ValueEncoding::Json => !row.json_value()?.is_null(),
            ValueEncoding::ProfileV2 => {
                SourceJson::from_portable_json(&row.profile_v2_value()?)?.as_str() != "null"
            }
            _ => true,
        },
    };
    let parsed = if present {
        row.as_ref()
            .and_then(|row| FullPoolShadowDecision::validate_record(&key, row).ok())
    } else {
        None
    };
    Ok((present, parsed))
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn prepare_full_pool_reset(
        &self,
        proof: &CohortProof,
        original: &RequestContext,
    ) -> Result<FullPoolPreparation, GatewayError> {
        let at = self.fresh_time(0)?;
        let mut initial = self.transaction(at)?;
        let config: ResetConfig = initial
            .read(&keys::reset_config())
            .await?
            .unwrap_or_default();
        if let Err(error) = facts::policy(&config) {
            return Ok(FullPoolPreparation::Declined {
                reason: reason(error),
            });
        }
        if !self.migrate_full_pool_reset_settings().await? {
            return Ok(FullPoolPreparation::Declined {
                reason: "configuration_unavailable".into(),
            });
        }
        for _ in 0..4 {
            let now = self.fresh_time(at)?;
            let mut tx = self.transaction(now)?;
            let facts = match facts::capture(&mut tx, proof, original).await {
                Ok(facts) => facts,
                Err(error) => {
                    return Ok(FullPoolPreparation::Declined {
                        reason: reason(error),
                    });
                }
            };
            let audit_present = if facts.config.mode == ResetMode::Shadow {
                let (present, prior) = read_audit(&mut tx, &facts.episode_hash).await?;
                if let Some(decision) = prior.as_ref() {
                    let matches = decision.episode_hash == facts.episode_hash
                        && decision.fences == facts.fences;
                    if matches && decision.expires_at_ms > now {
                        let decision = decision.clone();
                        tx.now = self.fresh_time(now)?;
                        if decision.expires_at_ms <= tx.now {
                            continue;
                        }
                        if tx.commit().await? {
                            return Ok(FullPoolPreparation::Cached { decision });
                        }
                        continue;
                    }
                }
                present
            } else {
                false
            };
            tx.now = self.fresh_time(now)?;
            if tx.commit().await? {
                return Ok(FullPoolPreparation::Observe(Box::new(FullPoolResetPlan {
                    facts,
                    audit_present,
                })));
            }
        }
        Ok(FullPoolPreparation::Declined {
            reason: "routing_fence_stale".into(),
        })
    }

    pub async fn finish_full_pool_reset<H: SourceCreditCollation>(
        &self,
        plan: FullPoolResetPlan,
        inventories: &[SourceResetInventory],
        collation: &H,
    ) -> Result<FullPoolEvaluation, GatewayError> {
        let now = self.fresh_time(plan.facts.original.started_at_ms)?;
        let selection = match selection::select(&plan.facts, inventories, collation, now) {
            Ok(selection) => selection,
            Err(error) => {
                return Ok(FullPoolEvaluation::Declined {
                    reason: reason(error),
                });
            }
        };
        let selected = selection.selected.as_ref();
        let expires = plan
            .facts
            .fences
            .iter()
            .map(|fence| fence.quota_reset_at_ms)
            .chain(selected.and_then(|selected| selected.credit.expires_at_ms))
            .min()
            .ok_or_else(invalid)?;
        if expires <= now {
            return Ok(FullPoolEvaluation::Declined {
                reason: "shadow_decision_expired".into(),
            });
        }
        let decision = FullPoolShadowDecision {
            v: 1,
            episode_hash: plan.facts.episode_hash.clone(),
            created_at_ms: now,
            expires_at_ms: expires,
            decision_reason: selection.reason.into(),
            selected_account_id_hash: selected.map(|selected| {
                plan.facts.members[selected.member]
                    .administrative_hash
                    .clone()
            }),
            selected_credit_id_hash: selected
                .map(|selected| audit::credit_hash(&selected.credit.credit_id)),
            selected_credit_expires_at_ms: selected
                .and_then(|selected| selected.credit.expires_at_ms),
            fences: plan.facts.fences.clone(),
        };
        if plan.facts.config.mode == ResetMode::Live && selected.is_none() {
            return Ok(FullPoolEvaluation::Declined {
                reason: selection.reason.into(),
            });
        }
        for _ in 0..4 {
            let at = self.fresh_time(now)?;
            let mut tx = self.transaction(at)?;
            let current =
                match facts::capture(&mut tx, &plan.facts.proof, &plan.facts.original).await {
                    Ok(current) => current,
                    Err(error) => {
                        return Ok(FullPoolEvaluation::Declined {
                            reason: reason(error),
                        });
                    }
                };
            if !facts::same(&plan.facts, &current) {
                return Ok(FullPoolEvaluation::Declined {
                    reason: "routing_fence_stale".into(),
                });
            }
            if current.config.mode == ResetMode::Live {
                let selected = selected.ok_or_else(invalid)?;
                let permit = AutomaticResetPermit {
                    candidate: current.members[selected.member].candidate.clone(),
                    facts: current,
                    decision: decision.clone(),
                    credit: selected.credit.clone(),
                    observed_at_ms: selected.observed,
                };
                tx.now = self.fresh_time(at)?;
                permit.check_deadline(tx.now)?;
                if tx.commit().await? {
                    return Ok(FullPoolEvaluation::Ready(Box::new(permit)));
                }
                continue;
            }
            let key = keys::reset_shadow(&current.episode_hash);
            let (present, stored) = read_audit(&mut tx, &current.episode_hash).await?;
            if present || plan.audit_present {
                let Some(stored) = stored.filter(|stored| {
                    stored.episode_hash == decision.episode_hash && stored.expires_at_ms > at
                }) else {
                    return Ok(FullPoolEvaluation::Declined {
                        reason: "shadow_decision_unavailable".into(),
                    });
                };
                tx.now = self.fresh_time(at)?;
                if tx.commit().await? {
                    return Ok(FullPoolEvaluation::Shadow {
                        decision: stored,
                        duplicate: true,
                    });
                }
                continue;
            }
            tx.now = self.fresh_time(at)?;
            if decision.expires_at_ms <= tx.now {
                return Ok(FullPoolEvaluation::Declined {
                    reason: "shadow_decision_expired".into(),
                });
            }
            tx.put(&key, &decision, None)?;
            if tx.commit().await? {
                return Ok(FullPoolEvaluation::Shadow {
                    decision,
                    duplicate: false,
                });
            }
        }
        Ok(FullPoolEvaluation::Declined {
            reason: "shadow_decision_unavailable".into(),
        })
    }
}

/// Existing-ledger reconciliation can read these exact source fences without
/// an inventory, audit insertion, reset claim or new account/day reservation.
pub(crate) async fn capture_reconciliation_candidates<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    proof: &CohortProof,
    original: &RequestContext,
) -> Result<Vec<crate::reset::ResetCandidate>, GatewayError> {
    Ok(facts::capture_reconciliation(tx, proof, original)
        .await?
        .members
        .into_iter()
        .filter(|member| member.enabled)
        .map(|member| member.candidate)
        .collect())
}

/// Shared claim/submission/physical-send primitives call this inside their one
/// existing transaction. No deserialized source row can construct the permit.
pub(crate) async fn validate_automatic_permit<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    permit: &AutomaticResetPermit,
    now: i64,
) -> Result<(), GatewayError> {
    permit.check_deadline(now)?;
    tx.now = now;
    let current = facts::capture(tx, &permit.facts.proof, &permit.facts.original).await?;
    if current.config.mode != ResetMode::Live || !facts::same(&current, &permit.facts) {
        return Err(declined("routing_fence_stale"));
    }
    Ok(())
}
