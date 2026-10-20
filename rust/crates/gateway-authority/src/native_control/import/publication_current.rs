//! Recognize only the exact already-published group owned by this original import.
//! This private issuer never accepts arbitrary revisions, flags or ignored keys.
use super::super::rows::{GenerationEffect, OperationRow, Phase, TerminalPublication};
use super::*;
use crate::{
    keys,
    paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig},
    routing::SubscriptionPool,
    store::Transaction,
};
use gateway_auth::provider_credentials::{
    MANAGED_NATIVE_SOURCE_VERSION, codex_source_pool_key, parse_codex_source_pool,
};
use gateway_schema::{catalog_store, snapshot::ModelSnapshot};
use serde_json::Value;

/// Response DATA only. No serializer, permission constructor or stored schema.
#[derive(Debug, PartialEq)]
pub(crate) struct NativeImportModelsProjection {
    pub(crate) count: usize,
    pub(crate) source: gateway_core::js_string::JsString16,
    pub(crate) updated_at_ms: i64,
    pub(crate) client_version: Option<String>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct NativeImportCompletionProjection {
    pub(crate) account_count: usize,
    pub(crate) account_ids: Vec<String>,
    pub(crate) updated_at_ms: f64,
    pub(crate) models: NativeImportModelsProjection,
}

/// Derive only from the same checked publication transaction. The wire owner
/// must preserve the nullable version and source UTF16 when serializing DATA.
pub(super) async fn completion_metadata<
    S: AuthorityStore,
    I: TokenSource,
    C: NativeRenewalCancellation,
>(
    control: &NativeRenewalAuthority<'_, S, I, C>,
    tx: &mut Transaction<'_, S, I>,
    row: &ImportActionRow,
    publication: &ImportPublicationDataV1,
) -> Result<NativeImportCompletionProjection, GatewayError> {
    verify(control, tx, row, publication).await?;
    // Match Worker storage::prepare_transition's persisted-row invariant, not
    // a new scalar cap. Matching immutable revision/expiry fences this raw
    // reread to the same cached row; the transaction still commits its checks.
    for key in [codex_source_pool_key(), catalog_store::codex_snapshot_key()] {
        let record = control
            .authority
            .store
            .read(&key)
            .await?
            .ok_or_else(unavailable)?;
        if tx.revision(&key).as_deref() != Some(record.revision.as_str())
            || tx.expiry(&key) != record.expires_at_ms
        {
            return Err(unavailable());
        }
        record.validate_version()?;
        let sort_key = gateway_core::tuple_key::TupleKey::from_record_key(&key)?;
        let payload = serde_json::to_string(&record.value).map_err(|_| unavailable())?;
        let encoding = serde_json::to_value(record.value_encoding).map_err(|_| unavailable())?;
        let encoding = encoding.as_str().ok_or_else(unavailable)?;
        let bytes = key
            .0
            .len()
            .checked_add(sort_key.sort_bytes().len())
            .and_then(|size| size.checked_add(record.revision.len()))
            .and_then(|size| size.checked_add(payload.len()))
            .and_then(|size| size.checked_add(encoding.len()))
            .and_then(|size| size.checked_add(48));
        if bytes.is_none_or(|size| size > 2_000_000) {
            return Err(unavailable());
        }
    }
    let source = tx
        .read(&codex_source_pool_key())
        .await?
        .ok_or_else(unavailable)?;
    let source = parse_codex_source_pool(&source)?.ok_or_else(unavailable)?;
    let selected = source
        .accounts
        .get(usize::try_from(row.facts.slot).map_err(|_| unavailable())?)
        .ok_or_else(unavailable)?;
    let catalog: ModelSnapshot = tx
        .read_source_control(&catalog_store::codex_snapshot_key())
        .await?
        .ok_or_else(super::publication_source::missing_catalog)?;
    Ok(NativeImportCompletionProjection {
        account_count: source.accounts.len(),
        account_ids: source
            .accounts
            .iter()
            .map(|account| account.account_id.clone())
            .collect(),
        updated_at_ms: selected.updated_at_ms,
        models: NativeImportModelsProjection {
            count: catalog.models.len(),
            source: catalog.source,
            updated_at_ms: catalog.updated_at_ms,
            client_version: catalog.client_version,
        },
    })
}

#[cfg(test)]
impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    // Bounded real-transaction test entry; never a production proof constructor.
    pub(in crate::native_control) async fn completion_metadata_fixture(
        &self,
        action_ref: &str,
    ) -> Result<NativeImportCompletionProjection, GatewayError> {
        let mut tx = self.authority.transaction(self.time(0)?)?;
        let row: ImportActionRow = tx
            .read_source_control(&rows::key("action", action_ref))
            .await?
            .ok_or_else(unavailable)?;
        let publication = row.publication.as_ref().ok_or_else(unavailable)?;
        let result = completion_metadata(self, &mut tx, &row, publication).await?;
        if !tx.commit().await? {
            return Err(unavailable());
        }
        Ok(result)
    }
}

pub(in crate::native_control) struct VerifiedImportActorRevisions {
    actor: StoredNativeActor,
    config_revision: Option<String>,
    runtime_revision: Option<String>,
    control_digest: String,
    disposition: ImportCatalogDisposition,
}
impl VerifiedImportActorRevisions {
    pub(in crate::native_control) fn original_actor(&self) -> &StoredNativeActor {
        &self.actor
    }
    pub(in crate::native_control) fn config_revision(&self) -> &Option<String> {
        &self.config_revision
    }
    pub(in crate::native_control) fn runtime_revision(&self) -> &Option<String> {
        &self.runtime_revision
    }
    pub(in crate::native_control) fn control_digest(&self) -> &str {
        &self.control_digest
    }
    pub(in crate::native_control) fn changes_configuration(&self) -> bool {
        matches!(
            self.disposition,
            ImportCatalogDisposition::Normalized { .. }
        )
    }
}
fn matches_terminal(terminal: &TerminalPublication, publication: &ImportPublicationDataV1) -> bool {
    terminal.publication_revision == publication.publication_revision
        && terminal.source_revision == publication.source_revision
        && terminal.normalized_revision == publication.normalized_revision
        && terminal.native_source_generation == publication.native_source_generation
        && terminal.access_generation == publication.access_generation
        && terminal.credential_version == publication.credential_version
        && terminal.publication_request_digest.as_deref()
            == Some(publication.publication_request_digest.as_str())
}
pub(super) async fn verify<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>(
    control: &NativeRenewalAuthority<'_, S, I, C>,
    tx: &mut Transaction<'_, S, I>,
    row: &ImportActionRow,
    publication: &ImportPublicationDataV1,
) -> Result<(), GatewayError> {
    publication.validate()?;
    tx.now = control.time(row.created_at_ms)?;
    if row.v != 3
        || row.publication.as_ref() != Some(publication)
        || row.metadata.operation_id != publication.operation_id
        || tx.now >= row.deadline_ms
        || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
        || tx
            .revision(&rows::key("action", &row.metadata.action_ref))
            .as_deref()
            != Some(publication.publication_revision.as_str())
    {
        return Err(unavailable());
    }
    let op: OperationRow = tx
        .read(&rows::key("operation", &publication.operation_id))
        .await?
        .ok_or_else(unavailable)?;
    let generation_key = effects::generation_key(row)?;
    let generation: GenerationEffect = tx.read(&generation_key).await?.ok_or_else(unavailable)?;
    if op.v != 1
        || op.phase != Phase::Published
        || op.operation_id != row.metadata.operation_id
        || op.action_ref != row.metadata.action_ref
        || op.claim_ref != publication.claim_ref
        || op.request_digest != super::publication::effect_digest(row)?
        || op.publication_revision.as_deref() != Some(publication.publication_revision.as_str())
        || op.native_source_generation.as_deref()
            != Some(publication.native_source_generation.as_str())
        || op.access_generation.as_deref() != Some(publication.access_generation.as_str())
        || op
            .terminal
            .as_ref()
            .is_none_or(|value| !matches_terminal(value, publication))
        || generation.v != 1
        || generation.operation_id != op.operation_id
        || generation.claim_ref != op.claim_ref
        || generation.publication_revision != op.publication_revision
        || generation
            .terminal
            .as_ref()
            .is_none_or(|value| !matches_terminal(value, publication))
        || tx
            .revision(&rows::key("operation", &op.operation_id))
            .as_deref()
            != Some(publication.publication_revision.as_str())
        || tx.revision(&generation_key).as_deref()
            != Some(publication.publication_revision.as_str())
    {
        return Err(unavailable());
    }
    let source_key = codex_source_pool_key();
    let raw: Value = tx.read(&source_key).await?.ok_or_else(unavailable)?;
    let source = parse_codex_source_pool(&raw)?.ok_or_else(unavailable)?;
    let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(unavailable)?;
    normalized.validate()?;
    if tx.revision(&source_key).as_deref() != Some(publication.source_revision.as_str())
        || tx.revision(&keys::pool()).as_deref() != Some(publication.normalized_revision.as_str())
        || publication.source_revision != publication.publication_revision
        || publication.normalized_revision != publication.publication_revision
        || normalized.pool_versionstamp.0 != publication.source_revision
        || source.accounts.len() != row.facts.account_digests.len()
        || source.accounts.len() != normalized.accounts.len()
    {
        return Err(unavailable());
    }
    let slot = usize::try_from(row.facts.slot).map_err(|_| unavailable())?;
    for (index, account) in source.accounts.iter().enumerate() {
        let identity = account.identity();
        let projected = &normalized.accounts[index];
        if identity.routing_account_hash != projected.account_id_hash
            || identity.administrative_account_hash != projected.admin_account_hash
            || identity.credential_version != projected.credential_version
        {
            return Err(unavailable());
        }
        if index != slot
            && super::super::facts::digest(&account.private_source_value())?
                != row.facts.account_digests[index]
        {
            return Err(unavailable());
        }
    }
    let account = source.accounts.get(slot).ok_or_else(unavailable)?;
    let identity = account.identity();
    let native = account.native_owner.as_ref().ok_or_else(unavailable)?;
    if identity.routing_account_hash.0 != row.facts.account_id_hash
        || identity.credential_version.0 != publication.credential_version
        || identity.native_generation_hash != publication.access_generation
        || native.generation_hash != publication.access_generation
        || native.codex_home != control.registered.home
        || native.external_user_id.is_some()
        || !account.refresh_token.expose().is_empty()
        || native.managed_source.as_ref().is_none_or(|value| {
            value.v != MANAGED_NATIVE_SOURCE_VERSION
                || value.generation_hash != publication.native_source_generation
        })
    {
        return Err(unavailable());
    }
    let catalog: Option<ModelSnapshot> = tx
        .read_source_control(&catalog_store::codex_snapshot_key())
        .await?;
    let _: Option<gateway_core::source_json::SourceJson> = tx
        .read_source_control(&catalog_store::runtime_config_key())
        .await?;
    let generation_value: Option<String> = tx.read(&catalog_store::auth_generation_key()).await?;
    let config: PaidControlConfig = tx
        .read(&keys::paid_control_config())
        .await?
        .ok_or_else(unavailable)?;
    if config.v != PAID_CONTROL_CONFIG_VERSION
        || config.owner_id != row.facts.owner_id
        || config.owner_epoch != row.facts.owner_epoch
        || config.source_checks.len() != 1
        || config.source_checks[0].key != catalog_store::runtime_config_key().0
        || config.source_checks[0].expected_revision != publication.runtime_revision
        || tx.revision(&catalog_store::codex_snapshot_key()) != publication.catalog_revision
        || tx.revision(&catalog_store::runtime_config_key()) != publication.runtime_revision
        || tx.revision(&catalog_store::auth_generation_key())
            != publication.auth_generation_revision
        || tx.revision(&keys::paid_control_config()) != publication.paid_control_config_revision
    {
        return Err(unavailable());
    }
    match &publication.catalog_disposition {
        ImportCatalogDisposition::Normalized { client_version, .. } => {
            if [
                &publication.catalog_revision,
                &publication.runtime_revision,
                &publication.auth_generation_revision,
                &publication.paid_control_config_revision,
            ]
            .into_iter()
            .any(|value| value.as_deref() != Some(publication.publication_revision.as_str()))
                || catalog.as_ref().is_none_or(|value| {
                    value.client_version.as_deref() != Some(client_version.as_str())
                })
                || generation_value
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
            {
                return Err(unavailable());
            }
        }
        ImportCatalogDisposition::AuthenticatedLimited {
            upstream_status: 429,
        } => {
            if catalog.is_none() {
                return Err(super::publication_source::missing_catalog());
            }
        }
        _ => return Err(unavailable()),
    }
    // Only this verifier can construct the actor's exact owned-revision adapter.
    let revisions = VerifiedImportActorRevisions {
        actor: row.actor.clone(),
        config_revision: publication.paid_control_config_revision.clone(),
        runtime_revision: publication.runtime_revision.clone(),
        control_digest: row.facts.control_checks_digest.clone(),
        disposition: publication.catalog_disposition.clone(),
    };
    let current = actor::read_current_after_import_publication(
        tx,
        &row.actor,
        control.current_config,
        &revisions,
    )
    .await?;
    if current.scope != NativeActorScope::Admin {
        return Err(unavailable());
    }
    tx.now = control.time(tx.now)?;
    actor::validate_current_time(&row.actor, tx.now)?;
    if tx.now >= row.deadline_ms {
        return Err(unavailable());
    }
    Ok(())
}
