use crate::{host::*, providers};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_schema::{
    catalog::{CatalogInput, ProviderCatalog},
    catalog_cache::{PreparedCatalog, REFRESH_LEASE_MS},
    catalog_store::{self, RefreshLease},
    runtime_config::normalize_runtime_config,
    selection::{AccountModelCatalog, AccountModelsStore, ModelWhitelist, ProviderSelection},
    snapshot::ModelSnapshot,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct CatalogState {
    pub input: CatalogInput,
    pub runtime: Option<Value>,
    /// The adapter may schedule these through its existing request-owned wait_until.
    /// No cron, alarm, detached task or timer is created by this crate.
    pub refresh_due: Vec<CatalogProvider>,
}
pub fn source_key(parts: &[&str]) -> RecordKey {
    TupleKey::from_scalar_parts(
        &parts
            .iter()
            .map(|p| ScalarKeyPart::String(p))
            .collect::<Vec<_>>(),
    )
    .to_record_key()
}
pub fn selection_key() -> RecordKey {
    source_key(&["uos_ai", "provider_selection", "v1"])
}
pub fn whitelist_key() -> RecordKey {
    source_key(&["uos_ai", "codex_models_whitelist"])
}
pub fn account_models_key() -> RecordKey {
    source_key(&["uos_ai", "codex_account_models", "v1"])
}
pub async fn read_json<S: AuthorityStore>(
    store: &S,
    key: &RecordKey,
) -> Result<Option<StoredRecord>, GatewayError> {
    let record = store.read(key).await?;
    if let Some(record) = &record {
        record.json_value()?;
    }
    Ok(record)
}
/// Validate the stored full snapshot without normalizing its model records.
/// Callers that need source Get semantics retain their original raw value/revision.
pub fn parse_full_snapshot(value: &Value) -> Option<ModelSnapshot> {
    let models = value.get("models")?.as_array()?;
    let source = value.get("source")?.as_str()?;
    let updated = value.get("updated_at_ms")?.as_f64()?;
    if models.is_empty()
        || !models.iter().all(gateway_schema::util::is_record)
        || gateway_schema::util::js_trim(source).is_empty()
        || !updated.is_finite()
        || updated.fract() != 0.0
        || updated <= 0.0
        || updated > gateway_core::identity::MAX_SAFE_INTEGER as f64
    {
        return None;
    }
    Some(ModelSnapshot {
        models: models.clone(),
        source: source.into(),
        updated_at_ms: updated as i64,
        client_version: value.get("client_version").and_then(Value::as_str).map(str::to_owned),
    })
}
pub(crate) async fn load_exact_catalog<S: AuthorityStore>(
    store: &S,
    version: &str,
    generation: &str,
    now: i64,
) -> Result<Option<gateway_schema::catalog_cache::LoadedCatalog>, GatewayError> {
    let loaded = catalog_store::load_catalog(store, version, generation, now).await?;
    if loaded
        .as_ref()
        .is_some_and(|c| c.metadata.client_version != version)
    {
        return Err(unavailable(
            "Stored Codex catalog belongs to another exact client version",
        ));
    }
    Ok(loaded)
}
pub(crate) fn check(key: RecordKey, record: Option<&StoredRecord>) -> RevisionCheck {
    RevisionCheck {
        key,
        expected_revision: record.map(|r| r.revision.clone()),
    }
}
fn mutation(key: RecordKey, value: Value, revision: &str, expires: Option<i64>) -> RecordMutation {
    RecordMutation::Put {
        key,
        record: StoredRecord::json(revision, value, expires),
    }
}
pub async fn checks_current<S: AuthorityStore>(
    store: &S,
    checks: &[RevisionCheck],
) -> Result<bool, GatewayError> {
    for fence in checks {
        if store.read(&fence.key).await?.as_ref().map(|r| &r.revision)
            != fence.expected_revision.as_ref()
        {
            return Ok(false);
        }
    }
    Ok(true)
}
pub(crate) async fn generation_current<S: AuthorityStore>(
    store: &S,
    generation: &str,
) -> Result<bool, GatewayError> {
    Ok(read_json(store, &catalog_store::auth_generation_key())
        .await?
        .as_ref()
        .and_then(|r| r.value.as_str())
        == Some(generation))
}
pub(crate) async fn load_state<S: QueryStore>(
    store: &S,
    publication: &CredentialPublication,
    observations: BTreeMap<CatalogProvider, ProviderCatalog>,
    now: i64,
) -> Result<CatalogState, GatewayError> {
    publication.validate()?;
    let runtime = read_json(store, &catalog_store::runtime_config_key())
        .await?
        .as_ref()
        .and_then(|r| normalize_runtime_config(&r.value));
    let snapshot = runtime
        .as_ref()
        .and_then(|r| r.get("codex_models"))
        .and_then(|v| serde_json::from_value::<ModelSnapshot>(v.clone()).ok());
    let full_snapshot = read_json(store, &catalog_store::codex_snapshot_key())
        .await
        .ok()
        .flatten()
        .and_then(|r| parse_full_snapshot(&r.value));
    let selection = read_json(store, &selection_key())
        .await?
        .as_ref()
        .and_then(|r| ProviderSelection::normalize(&r.value));
    let whitelist = read_json(store, &whitelist_key())
        .await?
        .as_ref()
        .and_then(|r| ModelWhitelist::normalize(&r.value));
    let mut input = CatalogInput {
        snapshot,
        full_snapshot,
        selection,
        whitelist,
        ..CatalogInput::default()
    };
    let mut refresh_due = Vec::new();
    for provider in [
        CatalogProvider::Openlux,
        CatalogProvider::Surplus,
        CatalogProvider::Lithos,
        CatalogProvider::Openrouter,
        CatalogProvider::ClaudeCode,
        CatalogProvider::Deepseek,
        CatalogProvider::Cerebras,
    ] {
        let configured = publication.providers.contains_key(&provider);
        let mut observation = observations.get(&provider).cloned().unwrap_or_default();
        observation.configured = configured;
        if provider != CatalogProvider::Openrouter && !configured {
            observation = ProviderCatalog::default();
        }
        if provider.discovery()
            && (configured || provider == CatalogProvider::Openrouter)
            && observation
                .updated_at_ms
                .is_none_or(|at| now.saturating_sub(at) >= 300_000)
        {
            refresh_due.push(provider);
        }
        input.providers.insert(provider.id().into(), observation);
    }
    // Public OpenRouter enrichment is usable even without a routing credential.
    let mut ids = input
        .providers
        .values()
        .flat_map(|p| p.models.iter())
        .chain(input.codex().into_iter().flat_map(|s| s.models.iter()))
        .filter_map(gateway_schema::util::identifier)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for provider in ["deepseek", "lithos", "cerebras", "ubiquity"] {
        ids.extend(
            gateway_schema::provider_catalog::provider_ids(provider)
                .iter()
                .map(|id| (*id).to_owned()),
        );
    }
    let openrouter = input.rows("openrouter").to_vec();
    for id in ids {
        if let Some(row) = providers::match_openrouter(&openrouter, &id) {
            input.enrichment.insert(
                id,
                gateway_schema::metadata::MetadataHint::from_openrouter(row),
            );
        }
    }
    Ok(CatalogState {
        input,
        runtime,
        refresh_due,
    })
}

/// Existing catalog rows only. Chunks are private until one atomic metadata publication
/// checks the source generation, lease owner/revision/expiry and exact credential rows.
pub(crate) async fn publish_fenced<S: AuthorityStore, H: CatalogHost>(
    store: &S,
    prepared: &PreparedCatalog,
    owner: &str,
    source_checks: &[RevisionCheck],
    host: &H,
) -> Result<bool, GatewayError> {
    let m = &prepared.metadata;
    let generation = read_json(store, &catalog_store::auth_generation_key()).await?;
    let lease = read_json(store, &catalog_store::lease_key(&m.client_version)).await?;
    let current_lease = lease
        .as_ref()
        .and_then(|r| serde_json::from_value::<RefreshLease>(r.value.clone()).ok());
    if generation.as_ref().and_then(|r| r.value.as_str()) != Some(&m.auth_generation)
        || !current_lease.is_some_and(|l| l.owner == owner && l.lease_until_ms > host.now_ms())
        || !checks_current(store, source_checks).await?
    {
        return Ok(false);
    }
    let mut chunk_checks = Vec::new();
    let mut chunk_mutations = Vec::new();
    for (source, chunks) in [(false, &prepared.chunks), (true, &prepared.source_chunks)] {
        for (index, bytes) in chunks.iter().enumerate() {
            let key =
                catalog_store::chunk_key(&m.client_version, &m.body_generation, index, source);
            chunk_checks.push(check(key.clone(), None));
            chunk_mutations.push(mutation(
                key,
                json!(bytes),
                &m.body_generation,
                Some(prepared.expires_at_ms),
            ));
        }
    }
    if store
        .commit(AtomicTransition {
            checks: chunk_checks,
            mutations: chunk_mutations,
        })
        .await?
        != CommitOutcome::Committed
    {
        return Ok(false);
    }
    if !current_lease_matches(store, &m.client_version, owner, host.now_ms()).await? {
        catalog_store::delete_catalog_chunks(store, m).await?;
        return Ok(false);
    }
    let key = catalog_store::metadata_key(&m.client_version);
    let previous = read_json(store, &key).await?;
    let mut checks = source_checks.to_vec();
    checks.extend([
        check(catalog_store::auth_generation_key(), generation.as_ref()),
        check(catalog_store::lease_key(&m.client_version), lease.as_ref()),
        check(key.clone(), previous.as_ref()),
    ]);
    let committed = store
        .commit(AtomicTransition {
            checks,
            mutations: vec![mutation(
                key,
                serde_json::to_value(m)
                    .map_err(|_| unavailable("Catalog metadata could not be encoded"))?,
                &m.body_generation,
                Some(prepared.expires_at_ms),
            )],
        })
        .await?
        == CommitOutcome::Committed;
    if !committed {
        catalog_store::delete_catalog_chunks(store, m).await?;
        return Ok(false);
    }
    if let Some(old) = previous
        .and_then(|r| {
            serde_json::from_value::<gateway_schema::catalog_cache::CatalogMetadata>(r.value).ok()
        })
        .filter(|old| old.body_generation != m.body_generation)
    {
        catalog_store::delete_catalog_chunks(store, &old).await?;
    }
    Ok(true)
}

pub(crate) struct PublicationContext<'a> {
    pub version: &'a str,
    pub publication: &'a CredentialPublication,
    pub generation: &'a str,
    pub revision: &'a str,
    pub now: i64,
}
pub(crate) async fn current_lease_matches<S: AuthorityStore>(
    store: &S,
    version: &str,
    owner: &str,
    now: i64,
) -> Result<bool, GatewayError> {
    let lease = read_json(store, &catalog_store::lease_key(version)).await?;
    Ok(lease
        .and_then(|r| serde_json::from_value::<RefreshLease>(r.value).ok())
        .is_some_and(|l| l.owner == owner && l.lease_until_ms > now))
}
pub(crate) async fn publish_account_models<S: AuthorityStore>(
    store: &S,
    entries: &[(String, Vec<String>)],
    context: &PublicationContext<'_>,
) -> Result<(), GatewayError> {
    if entries.is_empty() {
        return Ok(());
    }
    let PublicationContext {
        version,
        publication,
        generation,
        revision,
        now,
    } = context;
    for _ in 0..3 {
        let auth = read_json(store, &catalog_store::auth_generation_key()).await?;
        if auth.as_ref().and_then(|r| r.value.as_str()) != Some(*generation) {
            return Ok(());
        }
        let old = read_json(store, &account_models_key()).await?;
        let data = old
            .as_ref()
            .and_then(|r| AccountModelsStore::parse(&r.value))
            .unwrap_or_default();
        let entries = entries
            .iter()
            .map(|(id, slugs)| {
                (
                    id.clone(),
                    AccountModelCatalog {
                        slugs: slugs.clone(),
                        client_version: (*version).into(),
                        updated_at_ms: *now,
                    },
                )
            })
            .collect::<Vec<_>>();
        let next = data.record_catalogs(&entries);
        let mut checks = publication.source_checks.clone();
        checks.extend([
            check(catalog_store::auth_generation_key(), auth.as_ref()),
            check(account_models_key(), old.as_ref()),
        ]);
        if store
            .commit(AtomicTransition {
                checks,
                mutations: vec![mutation(account_models_key(), json!(next), revision, None)],
            })
            .await?
            == CommitOutcome::Committed
        {
            break;
        }
    }
    Ok(())
}

pub(crate) async fn publish_snapshot<S: AuthorityStore>(
    store: &S,
    parsed: &Value,
    context: &PublicationContext<'_>,
) -> Result<(), GatewayError> {
    let PublicationContext {
        version,
        publication,
        generation,
        revision,
        now,
    } = context;
    for _ in 0..3 {
        let auth = read_json(store, &catalog_store::auth_generation_key()).await?;
        if auth.as_ref().and_then(|r| r.value.as_str()) != Some(*generation) {
            return Ok(());
        }
        let snapshot = read_json(store, &catalog_store::codex_snapshot_key()).await?;
        let runtime = read_json(store, &catalog_store::runtime_config_key()).await?;
        let current = snapshot
            .as_ref()
            .map(|r| {
                serde_json::from_value::<ModelSnapshot>(r.value.clone())
                    .map_err(|_| unavailable("Stored Codex model snapshot is corrupt"))
            })
            .transpose()?;
        let Some((next, next_runtime)) = catalog_store::normalized_snapshot_plan(
            parsed,
            version,
            current.as_ref(),
            runtime.as_ref().map(|r| &r.value).unwrap_or(&Value::Null),
            *now,
        ) else {
            return Ok(());
        };
        let mut checks = publication.source_checks.clone();
        checks.extend([
            check(catalog_store::auth_generation_key(), auth.as_ref()),
            check(catalog_store::codex_snapshot_key(), snapshot.as_ref()),
            check(catalog_store::runtime_config_key(), runtime.as_ref()),
        ]);
        if store
            .commit(AtomicTransition {
                checks,
                mutations: vec![
                    mutation(
                        catalog_store::codex_snapshot_key(),
                        json!(next),
                        revision,
                        None,
                    ),
                    mutation(
                        catalog_store::runtime_config_key(),
                        next_runtime,
                        revision,
                        None,
                    ),
                ],
            })
            .await?
            == CommitOutcome::Committed
        {
            return Ok(());
        }
    }
    Ok(())
}
/// Renew only request-owned leases; no independent periodic maintenance exists.
pub(crate) const HEARTBEAT_MS: u32 = (REFRESH_LEASE_MS / 3) as u32;
