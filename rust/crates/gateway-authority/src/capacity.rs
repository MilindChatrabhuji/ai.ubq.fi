//! Fixed trusted sampler capability. Data-plane requests cannot construct its source fence.
use crate::capacity_rules::merge_capacity;
use crate::paid_control::PaidControlOwner;
use crate::routing::{
    CapacityAdditionalRateLimit, CapacityObservation, CapacityState, CapacityWindows,
    SubscriptionPool, apply_capacity_observation, parse_capacity_observation, parse_capacity_store,
    parse_routing_state,
};
use crate::store::Transaction;
use crate::{Authority, TokenSource, invalid, keys, text, unavailable};
use gateway_auth::provider_credentials::{
    CodexNativeOwner, codex_source_pool_key, read_codex_source_pool,
};
use gateway_core::model::ModelId;
use gateway_core::{
    GatewayError,
    identity::{CredentialVersion, RoutingAccountHash, SubscriptionSelectionHash},
    state::AuthorityStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Source sampler slots are one-based; storage slots are zero-based exactly once.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct CodexCapacityAccountRef {
    pub source_slot: u8,
    pub account_id: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CodexCapacitySample {
    pub account: CodexCapacityAccountRef,
    pub state: CapacityState,
    pub source_observed_at_ms: Option<i64>,
    pub snapshot_at_ms: i64,
    pub windows: CapacityWindows,
    pub additional_rate_limits: Vec<CapacityAdditionalRateLimit>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
struct AccountSource {
    account_id: String,
    hash: RoutingAccountHash,
    admin_hash: SubscriptionSelectionHash,
    credential: CredentialVersion,
    native_generation: String,
    native_owner: Option<CodexNativeOwner>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
struct SourceFacts {
    raw_revision: String,
    pool_revision: String,
    owner_revision: Option<String>,
    owner: Option<PaidControlOwner>,
    accounts: Vec<AccountSource>,
}
/// No caller deserializer, revision list, keys or public constructor.
/// ```compile_fail
/// use gateway_authority::capacity::CodexCapacityObservationFence;
/// let _: CodexCapacityObservationFence = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone)]
pub struct CodexCapacityObservationFence {
    facts: SourceFacts,
    requested: Vec<CodexCapacityAccountRef>,
    observed_at_ms: i64,
}
/// A borrowed fixed-GET identity, never a credential or an accepted outcome.
/// Only a successfully captured fence can construct these read-only views.
pub struct CodexCapacityFetchBinding<'a> {
    source_slot: u8,
    source: &'a AccountSource,
}
impl CodexCapacityFetchBinding<'_> {
    pub fn source_slot(&self) -> u8 {
        self.source_slot
    }
    pub fn account_id(&self) -> &str {
        &self.source.account_id
    }
    pub fn credential_version(&self) -> &CredentialVersion {
        &self.source.credential
    }
    pub fn native_generation_hash(&self) -> &str {
        &self.source.native_generation
    }
    pub fn native_owner(&self) -> Option<&CodexNativeOwner> {
        self.source.native_owner.as_ref()
    }
}
impl CodexCapacityObservationFence {
    pub fn observed_at_ms(&self) -> i64 {
        self.observed_at_ms
    }
    pub fn fetch_bindings(&self) -> impl ExactSizeIterator<Item = CodexCapacityFetchBinding<'_>> {
        self.requested
            .iter()
            .map(|account| CodexCapacityFetchBinding {
                source_slot: account.source_slot,
                source: &self.facts.accounts[usize::from(account.source_slot - 1)],
            })
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CapacityReconciliation {
    Unchanged,
    Applied { changed_slots: usize },
    NoRoutingState,
    Pending { code: &'static str },
}
/// Durable C acceptance is independent from the following R reconciliation.
pub struct AcceptedCodexCapacityObservations {
    capacity_revision: String,
    observed_at_ms: i64,
    reconciliation: CapacityReconciliation,
}
impl AcceptedCodexCapacityObservations {
    pub fn capacity_revision(&self) -> &str {
        &self.capacity_revision
    }
    pub fn observed_at_ms(&self) -> i64 {
        self.observed_at_ms
    }
    pub fn reconciliation(&self) -> &CapacityReconciliation {
        &self.reconciliation
    }
}
fn changed() -> GatewayError {
    unavailable(
        "codex_capacity_source_changed",
        "Capacity producer identity changed.",
    )
}
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    async fn capacity_sources(
        &self,
        tx: &mut Transaction<'_, S, I>,
        now: i64,
    ) -> Result<SourceFacts, GatewayError> {
        let snapshot = read_codex_source_pool(&self.store, now)
            .await?
            .ok_or_else(|| {
                unavailable(
                    "codex_capacity_source_missing",
                    "Current Codex source pool is unavailable.",
                )
            })?;
        let _: Option<Value> = tx.read(&codex_source_pool_key()).await?;
        if !tx.expect(&codex_source_pool_key(), &Some(snapshot.revision.clone())) {
            return Err(changed());
        }
        let pool: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(changed)?;
        pool.validate()?;
        if pool.pool_versionstamp.0 != snapshot.revision
            || pool.accounts.len() != snapshot.pool.accounts.len()
        {
            return Err(changed());
        }
        let owner: Option<PaidControlOwner> = tx.read(&keys::paid_control_owner()).await?;
        let owner_revision = tx.revision(&keys::paid_control_owner());
        if let Some(owner) = &owner {
            if owner.v != 1 || owner_revision.is_none() {
                return Err(changed());
            }
            text(&owner.owner_id)?;
            text(&owner.owner_epoch)?;
            text(&owner.key_fingerprint)?;
        } else if owner_revision.is_some()
            || snapshot.pool.accounts.iter().any(|source| {
                !source.refresh_token.expose().is_empty()
                    || source.native_owner.as_ref().is_none_or(|owner| {
                        owner.external_user_id.is_none() || owner.managed_source.is_some()
                    })
            })
        {
            return Err(unavailable(
                "codex_capacity_owner_missing",
                "Current registered native owner is unavailable.",
            ));
        }
        // The source sampler also serves access-only external owners. Their
        // exact per-account ownership/generation below and the checked global
        // owner absence fence this read-only observation without minting a
        // native writer, credential renewal or paid-control registration.
        let mut accounts = Vec::new();
        for (source, normalized) in snapshot.pool.accounts.iter().zip(&pool.accounts) {
            let id = source.identity();
            if normalized.account_id_hash != id.routing_account_hash
                || normalized.admin_account_hash != id.administrative_account_hash
                || normalized.credential_version != id.credential_version
            {
                return Err(changed());
            }
            if source
                .native_owner
                .as_ref()
                .is_some_and(|owner| owner.generation_hash != id.native_generation_hash)
            {
                return Err(changed());
            }
            accounts.push(AccountSource {
                account_id: source.account_id.clone(),
                hash: id.routing_account_hash,
                admin_hash: id.administrative_account_hash,
                credential: id.credential_version,
                native_generation: id.native_generation_hash,
                native_owner: source.native_owner.clone(),
            });
        }
        Ok(SourceFacts {
            raw_revision: snapshot.revision,
            pool_revision: tx.revision(&keys::pool()).ok_or_else(changed)?,
            owner_revision,
            owner,
            accounts,
        })
    }
    pub async fn begin_codex_capacity_observation(
        &self,
        accounts: &[CodexCapacityAccountRef],
    ) -> Result<CodexCapacityObservationFence, GatewayError> {
        if accounts.is_empty() || accounts.len() > 2 {
            return Err(invalid(
                "Capacity sampling requires one or two fixed source accounts.",
            ));
        }
        let mut slots = BTreeSet::new();
        for account in accounts {
            if !(1..=2).contains(&account.source_slot) || !slots.insert(account.source_slot) {
                return Err(invalid("Capacity sample slot is duplicated or invalid."));
            }
            text(&account.account_id)?;
        }
        let now = self.fresh_time(0)?;
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let facts = self.capacity_sources(&mut tx, now).await?;
            for reference in accounts {
                if facts
                    .accounts
                    .get(usize::from(reference.source_slot - 1))
                    .is_none_or(|a| a.account_id != reference.account_id)
                {
                    return Err(changed());
                }
            }
            self.fresh_time(now)?;
            if tx.commit().await? {
                return Ok(CodexCapacityObservationFence {
                    facts,
                    requested: accounts.to_vec(),
                    observed_at_ms: now,
                });
            }
        }
        Err(unavailable(
            "codex_capacity_conflict",
            "Capacity source capture changed concurrently.",
        ))
    }
    fn capacity_samples(
        &self,
        fence: &CodexCapacityObservationFence,
        samples: &[CodexCapacitySample],
    ) -> Result<Vec<CapacityObservation>, GatewayError> {
        if samples.is_empty() || samples.len() > fence.requested.len() {
            return Err(invalid(
                "Capacity batch is empty or exceeds its captured accounts.",
            ));
        }
        let mut slots = BTreeSet::new();
        let mut out = Vec::new();
        for sample in samples {
            if !fence.requested.contains(&sample.account)
                || !slots.insert(sample.account.source_slot)
                || sample.snapshot_at_ms != fence.observed_at_ms
            {
                return Err(invalid(
                    "Capacity sample does not match its original capture.",
                ));
            }
            let account = &fence.facts.accounts[usize::from(sample.account.source_slot - 1)];
            let value = json!({"slot":sample.account.source_slot-1,"account_id_hash":account.hash,"state":sample.state,"source_observed_at_ms":sample.source_observed_at_ms,"snapshot_at_ms":sample.snapshot_at_ms,"windows":sample.windows,"additional_rate_limits":sample.additional_rate_limits});
            out.push(parse_capacity_observation(&value)?);
        }
        Ok(out)
    }
    async fn reconcile_capacity_rows(
        &self,
        fence: &CodexCapacityObservationFence,
        observations: &[CapacityObservation],
    ) -> CapacityReconciliation {
        for _ in 0..3 {
            let result = async {
                let now = self.fresh_time(fence.observed_at_ms)?;
                let mut tx = self.transaction(now)?;
                if self.capacity_sources(&mut tx, now).await? != fence.facts {
                    return Err(changed());
                }
                let raw = tx.read::<Value>(&keys::routing()).await?;
                let Some(raw) = raw else {
                    return Ok::<_, GatewayError>(Some(CapacityReconciliation::NoRoutingState));
                };
                let mut state = parse_routing_state(&raw)?;
                let mut changed_slots = 0;
                for observation in observations {
                    if let Some(next) =
                        apply_capacity_observation(&state, observation, now, None, now)?
                    {
                        state = next;
                        changed_slots += 1;
                    }
                }
                if changed_slots > 0 {
                    tx.put(&keys::routing(), &state, None)?;
                }
                if tx.commit().await? {
                    Ok(Some(if changed_slots > 0 {
                        CapacityReconciliation::Applied { changed_slots }
                    } else {
                        CapacityReconciliation::Unchanged
                    }))
                } else {
                    Ok(None)
                }
            }
            .await;
            match result {
                Ok(Some(result)) => return result,
                Ok(None) => {}
                Err(_) => {
                    return CapacityReconciliation::Pending {
                        code: "codex_capacity_reconciliation_pending",
                    };
                }
            }
        }
        CapacityReconciliation::Pending {
            code: "codex_capacity_reconciliation_conflict",
        }
    }
    pub async fn record_codex_capacity_observations(
        &self,
        fence: &CodexCapacityObservationFence,
        samples: &[CodexCapacitySample],
    ) -> Result<AcceptedCodexCapacityObservations, GatewayError> {
        let observations = self.capacity_samples(fence, samples)?;
        for _ in 0..3 {
            let now = self.fresh_time(fence.observed_at_ms)?;
            let mut tx = self.transaction(now)?;
            if self.capacity_sources(&mut tx, now).await? != fence.facts {
                return Err(changed());
            }
            // C is a retryable destination, never frozen before upstream I/O.
            let current = tx
                .read::<Value>(&keys::capacity())
                .await?
                .as_ref()
                .map(parse_capacity_store)
                .transpose()?
                .unwrap_or_default();
            self.fresh_time(fence.observed_at_ms)?;
            let merged = merge_capacity(&current, &observations, fence.observed_at_ms);
            tx.put(&keys::capacity(), &merged, None)?;
            let revision = tx
                .post_checks()
                .into_iter()
                .find(|r| r.key == keys::capacity())
                .and_then(|r| r.expected_revision)
                .ok_or_else(|| invalid("Capacity commit has no revision."))?;
            self.fresh_time(fence.observed_at_ms)?;
            if tx.commit().await? {
                let reconciliation = self
                    .reconcile_capacity_rows(fence, &merged.observations)
                    .await;
                return Ok(AcceptedCodexCapacityObservations {
                    capacity_revision: revision,
                    observed_at_ms: fence.observed_at_ms,
                    reconciliation,
                });
            }
        }
        Err(unavailable(
            "codex_capacity_conflict",
            "Capacity observation merge changed concurrently.",
        ))
    }
    /// An existing event can retry the ordered R step after a restart. It reads
    /// already accepted durable C; callers cannot provide replacement evidence.
    pub async fn reconcile_codex_capacity_from_store(
        &self,
        fence: &CodexCapacityObservationFence,
    ) -> Result<CapacityReconciliation, GatewayError> {
        let now = self.fresh_time(fence.observed_at_ms)?;
        let mut tx = self.transaction(now)?;
        if self.capacity_sources(&mut tx, now).await? != fence.facts {
            return Err(changed());
        }
        let capacity = tx
            .read::<Value>(&keys::capacity())
            .await?
            .as_ref()
            .map(parse_capacity_store)
            .transpose()?
            .unwrap_or_default();
        if !tx.commit().await? {
            return Ok(CapacityReconciliation::Pending {
                code: "codex_capacity_reconciliation_conflict",
            });
        }
        Ok(self
            .reconcile_capacity_rows(fence, &capacity.observations)
            .await)
    }
    pub(crate) async fn reconcile_capacity_for_model(
        &self,
        model: &ModelId,
        now: i64,
    ) -> Result<(), GatewayError> {
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let mut view = crate::routing::read_view(&mut tx).await?;
            let mut changed = false;
            for row in &view.capacity.observations {
                if let Some(next) =
                    apply_capacity_observation(&view.state, row, now, Some(model), now)?
                {
                    view.state = next;
                    changed = true;
                }
            }
            if !changed {
                return Ok(());
            }
            tx.put(&keys::routing(), &view.state, None)?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        // Selection still has its coherent in-memory latest-capacity guard.
        Ok(())
    }
}
