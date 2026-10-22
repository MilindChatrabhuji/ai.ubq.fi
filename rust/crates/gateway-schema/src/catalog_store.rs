//! Strong catalog persistence against the shared authority; no independent ledger or timers.
use crate::{
    catalog_cache::*,
    snapshot::{ModelSnapshot, SnapshotOverrides, compare_client_versions, normalize_snapshot},
};
use gateway_core::{
    GatewayError,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
};
use gateway_core::{
    query::{QueryRequest, QuerySelector, QueryStore},
    tuple_key::{KeyPart, ScalarKeyPart, TupleKey},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
fn string_tuple(parts: &[&str]) -> RecordKey {
    TupleKey::from_scalar_parts(
        &parts
            .iter()
            .map(|part| ScalarKeyPart::String(part))
            .collect::<Vec<_>>(),
    )
    .to_record_key()
}
pub fn auth_generation_key() -> RecordKey {
    string_tuple(&["ubq_ai", "codex_catalog_auth_generation"])
}
pub fn metadata_key(version: &str) -> RecordKey {
    string_tuple(&["ubq_ai", "codex_catalog", version])
}
pub fn metadata_prefix() -> RecordKey {
    string_tuple(&["ubq_ai", "codex_catalog"])
}
pub fn chunk_key(version: &str, generation: &str, index: usize, source: bool) -> RecordKey {
    TupleKey::from_parts(&[
        KeyPart::String("ubq_ai".into()),
        KeyPart::String(
            if source {
                "codex_catalog_source_chunk"
            } else {
                "codex_catalog_chunk"
            }
            .into(),
        ),
        KeyPart::String(version.into()),
        KeyPart::String(generation.into()),
        KeyPart::Number(index as f64),
    ])
    .expect("catalog chunk indices are finite numbers")
    .to_record_key()
}
pub fn lease_key(version: &str) -> RecordKey {
    string_tuple(&["ubq_ai", "codex_catalog_refresh_lease", version])
}
fn cache_error(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("codex_catalog_unavailable"))
}
/// This read view exists only after the shared accessor has checked the JSON encoding tag.
struct JsonRecord {
    revision: String,
    value: Value,
}
async fn read<S: AuthorityStore>(
    store: &S,
    key: &RecordKey,
) -> Result<Option<JsonRecord>, GatewayError> {
    store
        .read(key)
        .await?
        .map(|record| {
            let value = record.json_value()?.clone();
            Ok(JsonRecord {
                revision: record.revision,
                value,
            })
        })
        .transpose()
}
fn check(key: RecordKey, record: Option<&JsonRecord>) -> RevisionCheck {
    RevisionCheck {
        key,
        expected_revision: record.map(|r| r.revision.clone()),
    }
}
fn put(key: RecordKey, value: Value, revision: &str, expires_at_ms: Option<i64>) -> RecordMutation {
    RecordMutation::Put {
        key,
        record: StoredRecord::json(revision, value, expires_at_ms),
    }
}
pub async fn load_catalog<S: AuthorityStore>(
    store: &S,
    version: &str,
    auth_generation: &str,
    now_ms: i64,
) -> Result<Option<LoadedCatalog>, GatewayError> {
    let Some(record) = read(store, &metadata_key(version)).await? else {
        return Ok(None);
    };
    let Ok(metadata) = serde_json::from_value::<CatalogMetadata>(record.value) else {
        return Ok(None);
    };
    if !metadata.retained(auth_generation, now_ms) {
        return Ok(None);
    }
    async fn chunks<S: AuthorityStore>(
        store: &S,
        metadata: &CatalogMetadata,
        source: bool,
        count: usize,
    ) -> Result<Option<Vec<Vec<u8>>>, GatewayError> {
        let mut chunks = Vec::new();
        for index in 0..count {
            let Some(record) = read(
                store,
                &chunk_key(
                    &metadata.client_version,
                    &metadata.body_generation,
                    index,
                    source,
                ),
            )
            .await?
            else {
                return Ok(None);
            };
            let Ok(bytes) = serde_json::from_value::<Vec<u8>>(record.value) else {
                return Ok(None);
            };
            chunks.push(bytes);
        }
        Ok(Some(chunks))
    }
    let Some(body_chunks) = chunks(store, &metadata, false, metadata.chunk_count).await? else {
        return Ok(None);
    };
    let Some(body) = decode_chunks(
        &body_chunks,
        metadata.compressed_bytes,
        metadata.body_bytes,
        &metadata.sha256,
    ) else {
        return Ok(None);
    };
    let Some(parsed) = parse_catalog(&body) else {
        return Ok(None);
    };
    let source_body = if let Some(count) = metadata.source_chunk_count {
        if let Some(chunks) = chunks(store, &metadata, true, count).await? {
            decode_chunks(
                &chunks,
                metadata.source_compressed_bytes.unwrap_or(0),
                metadata.source_body_bytes.unwrap_or(0),
                metadata.source_sha256.as_deref().unwrap_or(""),
            )
            .filter(|s| parse_catalog(s).is_some())
        } else {
            None
        }
    } else {
        None
    };
    Ok(Some(LoadedCatalog {
        metadata,
        body,
        parsed,
        source_body,
    }))
}
pub async fn delete_catalog_chunks<S: AuthorityStore>(
    store: &S,
    metadata: &CatalogMetadata,
) -> Result<(), GatewayError> {
    let mut checks = Vec::new();
    let mut mutations = Vec::new();
    for (source, count) in [
        (false, metadata.chunk_count),
        (true, metadata.source_chunk_count.unwrap_or(0)),
    ] {
        for index in 0..count {
            let key = chunk_key(
                &metadata.client_version,
                &metadata.body_generation,
                index,
                source,
            );
            let record = read(store, &key).await?;
            if record
                .as_ref()
                .is_some_and(|r| r.revision == metadata.body_generation)
            {
                checks.push(check(key.clone(), record.as_ref()));
                mutations.push(RecordMutation::Delete { key });
            }
        }
    }
    if !mutations.is_empty() {
        store.commit(AtomicTransition { checks, mutations }).await?;
    }
    Ok(())
}
pub async fn publish_catalog<S: AuthorityStore>(
    store: &S,
    prepared: &PreparedCatalog,
) -> Result<bool, GatewayError> {
    let m = &prepared.metadata;
    let mut checks = Vec::new();
    let mut mutations = Vec::new();
    for (source, chunks) in [(false, &prepared.chunks), (true, &prepared.source_chunks)] {
        for (index, bytes) in chunks.iter().enumerate() {
            let key = chunk_key(&m.client_version, &m.body_generation, index, source);
            checks.push(check(key.clone(), None));
            mutations.push(put(
                key,
                json!(bytes),
                &m.body_generation,
                Some(prepared.expires_at_ms),
            ));
        }
    }
    if store.commit(AtomicTransition { checks, mutations }).await? != CommitOutcome::Committed {
        return Ok(false);
    }
    let key = metadata_key(&m.client_version);
    let previous = read(store, &key).await?;
    let generation = read(store, &auth_generation_key()).await?;
    if generation.as_ref().and_then(|r| r.value.as_str()) != Some(&m.auth_generation) {
        delete_catalog_chunks(store, m).await?;
        return Ok(false);
    }
    let committed = store
        .commit(AtomicTransition {
            checks: vec![
                check(auth_generation_key(), generation.as_ref()),
                check(key.clone(), previous.as_ref()),
            ],
            mutations: vec![put(
                key,
                serde_json::to_value(m).map_err(|_| {
                    cache_error("Codex model catalog metadata could not be encoded")
                })?,
                &m.body_generation,
                Some(prepared.expires_at_ms),
            )],
        })
        .await?
        == CommitOutcome::Committed;
    if !committed {
        delete_catalog_chunks(store, m).await?;
        return Ok(false);
    }
    if let Some(old) = previous
        .and_then(|r| serde_json::from_value::<CatalogMetadata>(r.value).ok())
        .filter(|old| old.body_generation != m.body_generation)
    {
        delete_catalog_chunks(store, &old).await?;
    }
    Ok(true)
}
pub async fn get_auth_generation<S: AuthorityStore>(
    store: &S,
    candidate: &str,
) -> Result<String, GatewayError> {
    for _ in 0..3 {
        let existing = read(store, &auth_generation_key()).await?;
        if let Some(value) = existing
            .as_ref()
            .and_then(|r| r.value.as_str())
            .filter(|s| !s.is_empty())
        {
            return Ok(value.into());
        }
        if store
            .commit(AtomicTransition {
                checks: vec![check(auth_generation_key(), existing.as_ref())],
                mutations: vec![put(
                    auth_generation_key(),
                    json!(candidate),
                    candidate,
                    None,
                )],
            })
            .await?
            == CommitOutcome::Committed
        {
            return Ok(candidate.into());
        }
    }
    read(store, &auth_generation_key())
        .await?
        .and_then(|r| r.value.as_str().map(str::to_owned))
        .ok_or_else(|| cache_error("Codex model catalog cache is unavailable"))
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RefreshLease {
    pub owner: String,
    pub lease_until_ms: i64,
}
pub async fn acquire_refresh_lease<S: AuthorityStore>(
    store: &S,
    version: &str,
    owner: &str,
    now_ms: i64,
) -> Result<bool, GatewayError> {
    let key = lease_key(version);
    let existing = read(store, &key).await?;
    if existing
        .as_ref()
        .and_then(|r| serde_json::from_value::<RefreshLease>(r.value.clone()).ok())
        .is_some_and(|l| l.lease_until_ms > now_ms)
    {
        return Ok(false);
    }
    Ok(store
        .commit(AtomicTransition {
            checks: vec![check(key.clone(), existing.as_ref())],
            mutations: vec![put(
                key,
                json!(RefreshLease {
                    owner: owner.into(),
                    lease_until_ms: now_ms + REFRESH_LEASE_MS
                }),
                owner,
                Some(now_ms + REFRESH_LEASE_MS * 2),
            )],
        })
        .await?
        == CommitOutcome::Committed)
}
pub async fn renew_refresh_lease<S: AuthorityStore>(
    store: &S,
    version: &str,
    owner: &str,
    now_ms: i64,
) -> Result<bool, GatewayError> {
    let key = lease_key(version);
    let existing = read(store, &key).await?;
    if existing
        .as_ref()
        .and_then(|r| r.value.get("owner"))
        .and_then(Value::as_str)
        != Some(owner)
    {
        return Ok(false);
    }
    Ok(store
        .commit(AtomicTransition {
            checks: vec![check(key.clone(), existing.as_ref())],
            mutations: vec![put(
                key,
                json!(RefreshLease {
                    owner: owner.into(),
                    lease_until_ms: now_ms + REFRESH_LEASE_MS
                }),
                owner,
                Some(now_ms + REFRESH_LEASE_MS * 2),
            )],
        })
        .await?
        == CommitOutcome::Committed)
}
pub async fn release_refresh_lease<S: AuthorityStore>(
    store: &S,
    version: &str,
    owner: &str,
) -> Result<bool, GatewayError> {
    let key = lease_key(version);
    let existing = read(store, &key).await?;
    if existing
        .as_ref()
        .and_then(|r| r.value.get("owner"))
        .and_then(Value::as_str)
        != Some(owner)
    {
        return Ok(false);
    }
    Ok(store
        .commit(AtomicTransition {
            checks: vec![check(key.clone(), existing.as_ref())],
            mutations: vec![RecordMutation::Delete { key }],
        })
        .await?
        == CommitOutcome::Committed)
}
/// Full listing is an explicit authority input: never infer absence from a partial page.
pub async fn prune_catalog_versions<S: AuthorityStore>(
    store: &S,
    all_metadata: &[CatalogMetadata],
    current_version: &str,
) -> Result<(), GatewayError> {
    for metadata in prune_versions(all_metadata, current_version) {
        let key = metadata_key(&metadata.client_version);
        let existing = read(store, &key).await?;
        if existing
            .as_ref()
            .and_then(|r| r.value.get("body_generation"))
            .and_then(Value::as_str)
            != Some(&metadata.body_generation)
        {
            continue;
        }
        if store
            .commit(AtomicTransition {
                checks: vec![check(key.clone(), existing.as_ref())],
                mutations: vec![RecordMutation::Delete { key }],
            })
            .await?
            == CommitOutcome::Committed
        {
            delete_catalog_chunks(store, &metadata).await?;
        }
    }
    Ok(())
}
/// Normalized publication plan must be committed with generation, snapshot and runtime revision checks.
pub fn normalized_snapshot_plan(
    parsed: &SourceJson,
    version: &str,
    current: Option<&ModelSnapshot>,
    runtime: &SourceJson,
    updated_at_ms: i64,
) -> Option<(ModelSnapshot, SourceJson)> {
    if let Some(current_version) = current
        .and_then(|s| s.client_version.as_deref())
        .filter(|s| !s.is_empty())
        && compare_client_versions(version, current_version).is_none_or(|c| c.is_lt())
    {
        return None;
    }
    let next = normalize_snapshot(
        parsed,
        &SnapshotOverrides {
            source: Some("chatgpt_codex".into()),
            client_version: Some(version.into()),
            updated_at_ms: Some(updated_at_ms),
        },
        updated_at_ms,
    )?
    .merge_prompt_cache(current);
    let current_runtime = crate::runtime_config::normalize_runtime_config(runtime);
    let previous_model = current_runtime
        .as_ref()
        .and_then(crate::runtime_config::default_model);
    let previous_effort = current_runtime
        .as_ref()
        .and_then(crate::runtime_config::default_reasoning_effort);
    let default = next.preserve_default(previous_model.as_ref());
    let runtime = crate::runtime_config::build_runtime_config(
        &next,
        default.as_ref(),
        previous_effort.as_ref(),
        updated_at_ms,
    )
    .ok()?;
    Some((next, runtime))
}

pub fn codex_snapshot_key() -> RecordKey {
    string_tuple(&["ubq_ai", "codex_models"])
}
pub fn runtime_config_key() -> RecordKey {
    string_tuple(&["uos_ai", "runtime_config", "v2"])
}
/// A rich refresh can update the compact runtime only through the same authority transaction.
pub async fn publish_normalized_snapshot<S: AuthorityStore>(
    store: &S,
    parsed: &SourceJson,
    version: &str,
    expected_generation: &str,
    revision: &str,
    updated_at_ms: i64,
) -> Result<Option<SourceJson>, GatewayError> {
    for _ in 0..3 {
        let generation = read(store, &auth_generation_key()).await?;
        if generation.as_ref().and_then(|r| r.value.as_str()) != Some(expected_generation) {
            return Ok(None);
        }
        let snapshot_record = store.read(&codex_snapshot_key()).await?;
        let runtime_record = store.read(&runtime_config_key()).await?;
        let current = match &snapshot_record {
            Some(record) => Some(
                decode_source_control_record(record)?
                    .deserialize::<ModelSnapshot>()
                    .map_err(|_| cache_error("Stored Codex model snapshot is corrupt"))?,
            ),
            None => None,
        };
        let runtime_source = runtime_record
            .as_ref()
            .map(decode_source_control_record)
            .transpose()?;
        let empty_runtime = SourceJson::parse("null")?;
        let runtime = runtime_source.as_ref().unwrap_or(&empty_runtime);
        let Some((next, next_runtime)) =
            normalized_snapshot_plan(parsed, version, current.as_ref(), runtime, updated_at_ms)
        else {
            return Ok(None);
        };
        let transition = AtomicTransition {
            checks: vec![
                check(auth_generation_key(), generation.as_ref()),
                RevisionCheck {
                    key: codex_snapshot_key(),
                    expected_revision: snapshot_record.as_ref().map(|r| r.revision.clone()),
                },
                RevisionCheck {
                    key: runtime_config_key(),
                    expected_revision: runtime_record.as_ref().map(|r| r.revision.clone()),
                },
            ],
            mutations: vec![
                RecordMutation::Put {
                    key: codex_snapshot_key(),
                    record: encode_source_control_record(
                        revision,
                        &SourceJson::from_serializable(&next)?,
                        None,
                    )?,
                },
                RecordMutation::Put {
                    key: runtime_config_key(),
                    record: encode_source_control_record(revision, &next_runtime, None)?,
                },
            ],
        };
        if store.commit(transition).await? == CommitOutcome::Committed {
            return Ok(Some(next_runtime));
        }
    }
    Ok(None)
}

/// Follow the shared opaque continuation to terminal pagination before choosing old versions.
pub async fn prune_stored_catalog_versions<S: QueryStore>(
    store: &S,
    current_version: &str,
    now_ms: i64,
) -> Result<(), GatewayError> {
    let mut cursor = None;
    let mut all_metadata = Vec::new();
    let mut seen_cursors = std::collections::BTreeSet::new();
    loop {
        let request = QueryRequest {
            selector: QuerySelector::Prefix {
                prefix: metadata_prefix(),
                start: None,
                end: None,
            },
            reverse: false,
            limit: 100,
            cursor: cursor.clone(),
            now_ms,
        };
        let page = store.query(request).await?;
        for entry in page.entries {
            let metadata =
                serde_json::from_value::<CatalogMetadata>(entry.record.json_value()?.clone())
                    .map_err(|_| cache_error("Stored Codex catalog metadata is corrupt"))?;
            if !metadata.valid() {
                return Err(cache_error("Stored Codex catalog metadata is corrupt"));
            }
            all_metadata.push(metadata);
        }
        match page.next_cursor {
            Some(next) => {
                if !seen_cursors.insert(next.clone()) {
                    return Err(cache_error("Codex catalog query repeated its continuation"));
                }
                cursor = Some(next);
            }
            None => break,
        }
    }
    prune_catalog_versions(store, &all_metadata, current_version).await
}
