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
use gateway_core::{
    model::ModelId,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
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
    pub runtime: Option<SourceJson>,
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
pub fn parse_full_snapshot(value: &SourceJson) -> Option<ModelSnapshot> {
    let models = source::member(value, "models")
        .as_ref()
        .and_then(source::array)?;
    let source_name = source::member(value, "source")
        .as_ref()
        .and_then(source::string)?;
    let updated = source::member(value, "updated_at_ms")
        .as_ref()
        .and_then(source::number)?;
    if models.is_empty()
        || !models
            .iter()
            .all(|v| v.as_str().starts_with('{') || v.as_str().starts_with('['))
        || gateway_schema::reasoning::js_trim_source(&source_name)
            .as_units()
            .is_empty()
        || !updated.is_finite()
        || updated.fract() != 0.0
        || updated <= 0.0
        || updated > gateway_core::identity::MAX_SAFE_INTEGER as f64
    {
        return None;
    }
    Some(ModelSnapshot {
        models,
        source: source_name,
        updated_at_ms: updated as i64,
        client_version: source::member(value, "client_version")
            .as_ref()
            .and_then(source::string)
            .and_then(|s| s.try_utf8().ok()),
    })
}
/// Explicit opt-in for named model/default/whitelist records; generic read_json is unchanged.
pub(crate) struct SourceControlRow {
    pub record: StoredRecord,
    pub document: SourceJson,
}
pub(crate) async fn read_source_control<S: AuthorityStore>(
    store: &S,
    key: &RecordKey,
) -> Result<Option<SourceControlRow>, GatewayError> {
    store
        .read(key)
        .await?
        .map(|record| {
            let document = decode_source_control_record(&record)?;
            Ok(SourceControlRow { record, document })
        })
        .transpose()
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
fn source_mutation(
    key: RecordKey,
    value: &SourceJson,
    revision: &str,
    expires: Option<i64>,
) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key,
        record: encode_source_control_record(revision, value, expires)?,
    })
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
    public: bool,
) -> Result<CatalogState, GatewayError> {
    publication.validate()?;
    let runtime = read_source_control(store, &catalog_store::runtime_config_key())
        .await?
        .as_ref()
        .and_then(|r| normalize_runtime_config(&r.document));
    let snapshot = runtime
        .as_ref()
        .and_then(|r| source::member(r, "codex_models"))
        .as_ref()
        .and_then(|v| v.deserialize::<ModelSnapshot>().ok());
    let full_snapshot = read_source_control(store, &catalog_store::codex_snapshot_key())
        // Source loadFullCodexModelsSnapshot catches this optional read only.
        .await
        .ok()
        .flatten()
        .and_then(|r| parse_full_snapshot(&r.document));
    let selection = read_json(store, &selection_key())
        .await?
        .as_ref()
        .and_then(|r| ProviderSelection::normalize(&r.value));
    let whitelist = read_source_control(store, &whitelist_key())
        .await?
        .as_ref()
        .and_then(|r| ModelWhitelist::normalize(&r.document));
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
        if provider != CatalogProvider::Openrouter
            && !configured
            && !(public && provider == CatalogProvider::Surplus)
        {
            observation = ProviderCatalog::default();
        }
        if provider.discovery()
            && (configured
                || provider == CatalogProvider::Openrouter
                || public && provider == CatalogProvider::Surplus)
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
        .filter_map(|row| {
            ["slug", "id", "model", "name"]
                .iter()
                .find_map(|key| source::member(row, key).as_ref().and_then(source::string))
        })
        .map(ModelId::from_source)
        .collect::<Vec<_>>();
    for provider in ["deepseek", "lithos", "cerebras", "ubiquity"] {
        ids.extend(
            gateway_schema::provider_catalog::provider_ids(provider)
                .iter()
                .map(|id| ModelId::from_scalar(id)),
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
    entries: &[(String, Vec<ModelId>)],
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
        let old = read_source_control(store, &account_models_key()).await?;
        let data = old
            .as_ref()
            .and_then(|r| AccountModelsStore::parse(&r.document))
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
            check(account_models_key(), old.as_ref().map(|r| &r.record)),
        ]);
        if store
            .commit(AtomicTransition {
                checks,
                mutations: vec![source_mutation(
                    account_models_key(),
                    &next.to_source_json(),
                    revision,
                    None,
                )?],
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
    parsed: &SourceJson,
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
        let snapshot = read_source_control(store, &catalog_store::codex_snapshot_key()).await?;
        let runtime = read_source_control(store, &catalog_store::runtime_config_key()).await?;
        let current = snapshot
            .as_ref()
            .map(|r| {
                r.document
                    .deserialize::<ModelSnapshot>()
                    .map_err(|_| unavailable("Stored Codex model snapshot is corrupt"))
            })
            .transpose()?;
        let Some((next, next_runtime)) = catalog_store::normalized_snapshot_plan(
            parsed,
            version,
            current.as_ref(),
            runtime
                .as_ref()
                .map(|r| &r.document)
                .unwrap_or(&SourceJson::parse("null").expect("fixed null")),
            *now,
        ) else {
            return Ok(());
        };
        let mut checks = publication.source_checks.clone();
        checks.extend([
            check(catalog_store::auth_generation_key(), auth.as_ref()),
            check(
                catalog_store::codex_snapshot_key(),
                snapshot.as_ref().map(|r| &r.record),
            ),
            check(
                catalog_store::runtime_config_key(),
                runtime.as_ref().map(|r| &r.record),
            ),
        ]);
        if store
            .commit(AtomicTransition {
                checks,
                mutations: vec![
                    source_mutation(
                        catalog_store::codex_snapshot_key(),
                        &SourceJson::from_serializable(&next)?,
                        revision,
                        None,
                    )?,
                    source_mutation(
                        catalog_store::runtime_config_key(),
                        &next_runtime,
                        revision,
                        None,
                    )?,
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

/// Provider observations are durable inputs, not the assembled final body.
/// Keys include the auth generation and credential binding so rotation and
/// key changes cannot reuse stale rows.
pub(crate) fn provider_observation_key(
    generation: &str,
    provider: CatalogProvider,
    binding: Option<&ProviderBinding>,
) -> RecordKey {
    let identity = binding
        .map(|binding| gateway_schema::util::sha256(binding.identity.as_bytes()))
        .unwrap_or_else(|| "anonymous".into());
    source_key(&[
        "ubq_ai",
        "provider_catalog_v1",
        generation,
        provider.id(),
        &identity,
    ])
}

pub(crate) async fn auth_generation<S: AuthorityStore>(
    store: &S,
) -> Result<Option<String>, GatewayError> {
    Ok(read_json(store, &catalog_store::auth_generation_key())
        .await?
        .and_then(|record| record.value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty()))
}

#[derive(serde::Deserialize, serde::Serialize)]
struct ProviderObservationWire {
    models: Vec<String>,
    updated_at_ms: Option<i64>,
    configured: bool,
    available: bool,
    stale: bool,
}

fn observation_wire(snapshot: &ProviderCatalog) -> Result<ProviderObservationWire, GatewayError> {
    Ok(ProviderObservationWire {
        models: snapshot
            .models
            .iter()
            .map(|model| {
                gateway_core::source_serialization::canonical(model)
                    .map(|value| value.as_str().to_owned())
                    .map_err(|_| unavailable("Provider catalog observation could not be encoded"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        updated_at_ms: snapshot.updated_at_ms,
        configured: snapshot.configured,
        available: snapshot.available,
        stale: snapshot.stale,
    })
}

pub(crate) async fn load_provider_observation<S: AuthorityStore>(
    store: &S,
    generation: &str,
    provider: CatalogProvider,
    binding: Option<&ProviderBinding>,
    now: i64,
) -> Result<Option<ProviderCatalog>, GatewayError> {
    let key = provider_observation_key(generation, provider, binding);
    let Some(record) = store.read(&key).await? else {
        return Ok(None);
    };
    record.validate_version()?;
    let Ok(wire) = serde_json::from_value::<ProviderObservationWire>(record.json_value()?.clone())
    else {
        return Ok(None);
    };
    let mut snapshot = ProviderCatalog {
        models: wire
            .models
            .iter()
            .map(|model| gateway_core::source_json::SourceJson::parse(model))
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_default(),
        updated_at_ms: wire.updated_at_ms,
        configured: wire.configured,
        available: wire.available,
        stale: wire.stale,
    };
    if snapshot
        .updated_at_ms
        .is_none_or(|updated| updated <= 0 || updated > now.saturating_add(60_000))
    {
        return Ok(None);
    }
    snapshot.stale = snapshot
        .updated_at_ms
        .is_some_and(|updated| now.saturating_sub(updated) >= 300_000);
    Ok(Some(snapshot))
}

pub(crate) async fn persist_provider_observation<S: AuthorityStore>(
    store: &S,
    generation: &str,
    provider: CatalogProvider,
    binding: Option<&ProviderBinding>,
    snapshot: &ProviderCatalog,
    revision: &str,
    now: i64,
) -> Result<(), GatewayError> {
    let key = provider_observation_key(generation, provider, binding);
    let value = serde_json::to_value(observation_wire(snapshot)?)
        .map_err(|_| unavailable("Provider catalog observation could not be encoded"))?;
    for _ in 0..3 {
        let row = store.read(&key).await?;
        if store
            .commit(AtomicTransition {
                checks: vec![check(key.clone(), row.as_ref())],
                mutations: vec![mutation(
                    key.clone(),
                    value.clone(),
                    revision,
                    Some(now.saturating_add(gateway_schema::catalog_cache::RETENTION_MS)),
                )],
            })
            .await?
            == CommitOutcome::Committed
        {
            return Ok(());
        }
    }
    Ok(())
}
