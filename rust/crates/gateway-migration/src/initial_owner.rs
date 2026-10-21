//! Finite private initial-owner consumer. Physical custody is a local attestation,
//! never reconstructed from captured records or reread by this portable module.
use crate::*;
use gateway_authority::initial_control_owner::{
    InitialAdoptionAccountFacts, InitialAdoptionFacts, InitialControlOwnerReceipt,
    PreparedInitialControlOwner,
};
use gateway_core::{
    query::{QueryRequest, QueryStore},
    state::{AtomicTransition, AuthorityStore, CommitOutcome},
};
use std::cell::Cell;

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum InitialControlOwnerAdoptionReceipt {
    Installed {
        adoption: AdoptionReceipt,
        initial_control_owner: InitialControlOwnerReceipt,
    },
    /// Only the named current fences matched. This makes no claim that this call
    /// committed, that unrelated history is unchanged, or that authority was live.
    Reconciled {
        capture_id: String,
        source_git_sha: String,
        initial_control_owner: InitialControlOwnerReceipt,
    },
}

fn refused() -> GatewayError {
    GatewayError::unavailable(
        "The prepared initial adoption facts or installed fences differ",
        "initial_control_owner_refused",
    )
}

fn pool_records(
    prepared: &PreparedAdoption,
) -> Result<(&StoredRecord, &StoredRecord), GatewayError> {
    let source_key = gateway_auth::provider_credentials::codex_source_pool_key();
    let normalized_key = gateway_authority::keys::pool();
    let source = prepared
        .rows
        .iter()
        .find(|row| row.key == source_key)
        .ok_or_else(refused)?;
    let normalized = prepared
        .derived
        .iter()
        .find(|(key, _)| *key == normalized_key)
        .ok_or_else(refused)?;
    Ok((&source.record, &normalized.1))
}

fn actual_facts(prepared: &PreparedAdoption) -> Result<InitialAdoptionFacts, GatewayError> {
    let native = prepared
        .manifest
        .native_revision
        .as_ref()
        .ok_or_else(refused)?;
    let (source, normalized) = pool_records(prepared)?;
    let pool = gateway_auth::provider_credentials::parse_codex_source_pool(source.json_value()?)?
        .ok_or_else(refused)?;
    let routing: gateway_authority::routing::SubscriptionPool = decode(normalized.json_value()?)?;
    if routing.v != 1
        || routing.pool_versionstamp.0 != source.revision
        || routing.accounts.len() != pool.accounts.len()
    {
        return Err(refused());
    }
    let mut accounts = Vec::new();
    for (account, projection) in pool.accounts.iter().zip(&routing.accounts) {
        if !account.refresh_token.expose().is_empty() {
            return Err(refused());
        }
        let owner = account.native_owner.as_ref().ok_or_else(refused)?;
        // identity() recomputes these values from account + actual access token
        // + the required empty refresh field; it does not echo the stored marker.
        let identity = account.identity();
        if projection.account_id_hash != identity.routing_account_hash
            || projection.admin_account_hash != identity.administrative_account_hash
            || projection.credential_version != identity.credential_version
            || !projection.enabled
        {
            return Err(refused());
        }
        accounts.push(InitialAdoptionAccountFacts {
            account_id_hash: identity.routing_account_hash.0,
            projection_generation: owner.generation_hash.clone(),
            access_generation: identity.native_generation_hash,
        });
    }
    Ok(InitialAdoptionFacts {
        capture_id: prepared.manifest.capture_id.clone(),
        source_git_sha: prepared.manifest.source_git_sha.clone(),
        source_captured_at_ms: prepared.manifest.captured_at_ms,
        source_native_version: native.version.clone(),
        source_native_sequence: native.sequence.clone(),
        source_pool_revision: source.revision.clone(),
        normalized_pool_revision: normalized.revision.clone(),
        accounts,
    })
}

struct OwnerStore<'a, S> {
    store: &'a S,
    owner: &'a PreparedInitialControlOwner,
    facts: &'a InitialAdoptionFacts,
    now_ms: i64,
    committed: Cell<bool>,
}
impl<S: QueryStore> AuthorityStore for OwnerStore<'_, S> {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.store.read(key).await
    }
    async fn commit(
        &self,
        mut transition: AtomicTransition,
    ) -> Result<CommitOutcome, GatewayError> {
        if self.committed.replace(true) {
            return Err(refused());
        }
        self.owner.require_adoption_facts(self.facts, self.now_ms)?;
        // This is the exact complete transition produced by ordinary adopt_empty.
        // The capability adds only its fixed owner absent-check and Put.
        self.owner.bind_empty_adoption(&mut transition)?;
        self.store.commit(transition).await
    }
}
impl<S: QueryStore> QueryStore for OwnerStore<'_, S> {
    async fn query(
        &self,
        request: QueryRequest,
    ) -> Result<gateway_core::query::QueryPage, GatewayError> {
        self.store.query(request).await
    }
}

async fn matching_fences<S: QueryStore>(
    store: &S,
    prepared: &PreparedAdoption,
    owner: &PreparedInitialControlOwner,
    facts: &InitialAdoptionFacts,
    now_ms: i64,
) -> Result<(), GatewayError> {
    let (source, normalized) = pool_records(prepared)?;
    let expected_manifest = StoredRecord::json(
        format!("capture:{}", prepared.manifest.capture_id),
        json(&prepared.manifest)?,
        None,
    );
    // The target's existing host still holds it unpublished and quiescent. These
    // rereads are exact named fences, not a namespace snapshot or range CAS.
    for _ in 0..2 {
        owner.require_adoption_facts(facts, now_ms)?;
        if !owner.matches_current_owner(
            store
                .read(&gateway_authority::keys::paid_control_owner())
                .await?
                .as_ref(),
        ) || store.read(&crate::engine::manifest_key()).await?.as_ref()
            != Some(&expected_manifest)
            || store
                .read(&gateway_auth::provider_credentials::codex_source_pool_key())
                .await?
                .as_ref()
                != Some(source)
            || store.read(&gateway_authority::keys::pool()).await?.as_ref() != Some(normalized)
        {
            return Err(refused());
        }
    }
    Ok(())
}

pub(crate) async fn adopt<S: QueryStore>(
    store: &S,
    prepared: &PreparedAdoption,
    owner: &PreparedInitialControlOwner,
    now_ms: i64,
) -> Result<InitialControlOwnerAdoptionReceipt, GatewayError> {
    let facts = actual_facts(prepared)?;
    owner.require_adoption_facts(&facts, now_ms)?;
    if store.read(&crate::engine::manifest_key()).await?.is_some() {
        matching_fences(store, prepared, owner, &facts, now_ms).await?;
        return Ok(InitialControlOwnerAdoptionReceipt::Reconciled {
            capture_id: prepared.manifest.capture_id.clone(),
            source_git_sha: prepared.manifest.source_git_sha.clone(),
            initial_control_owner: owner.receipt(),
        });
    }
    let fenced = OwnerStore {
        store,
        owner,
        facts: &facts,
        now_ms,
        committed: Cell::new(false),
    };
    let adoption = crate::adopt_empty(&fenced, prepared).await?;
    matching_fences(store, prepared, owner, &facts, now_ms).await?;
    Ok(InitialControlOwnerAdoptionReceipt::Installed {
        adoption,
        initial_control_owner: owner.receipt(),
    })
}
