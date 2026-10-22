use crate::*;
use gateway_core::{
    query::{QueryRequest, QuerySelector, QueryStore},
    state::{AtomicTransition, CommitOutcome, RecordMutation, RevisionCheck},
};
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Manifest {
    pub v: u32,
    pub capture_id: String,
    pub source_git_sha: String,
    pub captured_at_ms: i64,
    pub source_rows: usize,
    pub mapping_checksum: String,
    pub derived: BTreeMap<String, String>,
    pub native_revision: Option<crate::NativeRevision>,
}
pub struct PreparedAdoption {
    pub(crate) manifest: Manifest,
    pub(crate) rows: Vec<Row>,
    pub(crate) derived: Vec<(RecordKey, StoredRecord)>,
}
impl PreparedAdoption {
    pub fn source_rows(&self) -> usize {
        self.manifest.source_rows
    }
    pub fn derived_rows(&self) -> usize {
        self.derived.len()
    }
    pub fn expected_do_row_writes(&self) -> Option<u64> {
        (self.source_rows() as u64)
            .checked_mul(2)
            .and_then(|value| value.checked_add(self.derived_rows() as u64))
            .and_then(|value| value.checked_add(1))
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AdoptionReceipt {
    pub capture_id: String,
    pub source_git_sha: String,
    pub source_rows: usize,
    pub derived_rows: usize,
    pub atomic_committed: bool,
}
pub(crate) fn manifest_key() -> RecordKey {
    key(json!(["uos_ai", "migration", "v3", "manifest"]))
}
pub(crate) fn mapping_key(id: &str, source: &str) -> RecordKey {
    key(json!([
        "uos_ai",
        "migration",
        "v3",
        "row",
        id,
        gateway_auth::crypto::sha256_hex(source.as_bytes())
    ]))
}

pub(crate) fn mapping_record(row: &Row, capture_id: &str) -> Result<StoredRecord, GatewayError> {
    Ok(StoredRecord::json(
        format!("capture:{capture_id}"),
        json(&row.mapping)?,
        None,
    ))
}
pub(crate) fn mapping_checksum(
    records: impl IntoIterator<Item = (String, StoredRecord)>,
) -> Result<String, GatewayError> {
    let mut entries = records
        .into_iter()
        .map(|(key, record)| Ok((key, digest(&record)?)))
        .collect::<Result<Vec<_>, GatewayError>>()?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(gateway_auth::crypto::sha256_hex(
        &serde_json::to_vec(&entries).map_err(|_| invalid("Mapping checksum cannot be encoded"))?,
    ))
}

fn validate_source_inventories(
    rows: Vec<Row>,
    now: i64,
) -> Result<(Vec<Row>, gateway_admin_data::migration::audit::Audit), GatewayError> {
    use gateway_admin_data::migration::{ObservedRow, audit};
    // The SAME complete live cohort is owned by the existing global audit.
    // Move payloads instead of deep-cloning every expanded typed record.
    let mut observed = Vec::new();
    let mut mappings = Vec::new();
    let mut expired = Vec::new();
    let mut order = Vec::new();
    for row in rows {
        let live = row.record.expires_at_ms.is_none_or(|e| e > now);
        order.push(live);
        if live {
            mappings.push(row.mapping);
            observed.push(ObservedRow {
                key: row.key,
                parts: row.parts,
                record: row.record,
            });
        } else {
            expired.push(row);
        }
    }
    let findings = audit::inspect_inventory(&audit::SliceInventory(&observed), now)?;
    let mut live = observed
        .into_iter()
        .zip(mappings)
        .map(|(row, mapping)| Row {
            key: row.key,
            parts: row.parts,
            record: row.record,
            mapping,
        });
    let mut expired = expired.into_iter();
    let rows = order
        .into_iter()
        .map(|live_row| {
            if live_row {
                live.next()
            } else {
                expired.next()
            }
            .expect("exact retained audit order")
        })
        .collect();
    Ok((rows, findings))
}

pub fn prepare(
    capture: &PrivateCapture,
    host: &dyn SourceDateHost,
) -> Result<PreparedAdoption, MigrationError> {
    let capture_id = gateway_auth::crypto::sha256_hex(
        &serde_json::to_vec(capture).map_err(|_| invalid("Capture cannot be encoded"))?,
    );
    prepare_rows(
        capture.validate(host)?,
        capture_id,
        &capture.source_git_sha,
        capture.captured_at_ms,
        None,
    )
}

pub(crate) fn prepare_rows(
    rows: Vec<Row>,
    capture_id: String,
    source_git_sha: &str,
    captured_at_ms: i64,
    native_revision: Option<crate::NativeRevision>,
) -> Result<PreparedAdoption, MigrationError> {
    let (mut rows, audited) = validate_source_inventories(rows, captured_at_ms)?;
    if !audited.errors.is_empty() {
        return Err(MigrationError::SourceInventory(audited));
    }
    for row in &mut rows {
        crate::projection::forward(row)?;
    }
    let revision = format!("capture:{capture_id}");
    let derived = crate::indexes::bind(&mut rows, captured_at_ms, &revision)?;
    let mut derived_digests = BTreeMap::new();
    for (key, record) in &derived {
        if rows.iter().any(|r| r.key == *key)
            || derived_digests
                .insert(key.0.clone(), digest(record)?)
                .is_some()
        {
            return Err(MigrationError::from(invalid(
                "Derived schema key collides with source state",
            )));
        }
    }
    for row in &mut rows {
        row.mapping.baseline_digest = digest(&row.record)?;
        // Identity values already live once at the source key. Do not duplicate historical
        // provider/refresh/session secrets in rollback metadata.
        if row.mapping.transform == Transform::Identity {
            row.mapping.source.value = SourceJson::parse("null")?;
            row.mapping.source.key.clear();
        }
    }
    let manifest = Manifest {
        v: 4,
        capture_id: capture_id.clone(),
        source_git_sha: source_git_sha.to_owned(),
        captured_at_ms,
        native_revision,
        source_rows: rows.len(),
        mapping_checksum: mapping_checksum(
            rows.iter()
                .map(|row| {
                    Ok((
                        mapping_key(&capture_id, &row.key.0).0,
                        mapping_record(row, &capture_id)?,
                    ))
                })
                .collect::<Result<Vec<_>, GatewayError>>()?,
        )?,
        derived: derived_digests,
    };
    Ok(PreparedAdoption {
        manifest,
        rows,
        derived,
    })
}

/// Only for an actually isolated, empty target held quiescent by its existing host owner.
/// This API cannot prove process stoppage or fence arbitrary uncoordinated new-key writers.
/// No runtime/pubication capability is created by a committed capture.
pub async fn adopt_empty<S: QueryStore>(
    store: &S,
    prepared: &PreparedAdoption,
) -> Result<AdoptionReceipt, GatewayError> {
    let existing = store
        .query(QueryRequest {
            selector: QuerySelector::Prefix {
                prefix: TupleKey::from_parts(&[])?.to_record_key(),
                start: None,
                end: None,
            },
            reverse: false,
            limit: 1,
            cursor: None,
            now_ms: 0,
        })
        .await?;
    if !existing.entries.is_empty() || existing.next_cursor.is_some() {
        return Err(invalid("Adoption target is not empty"));
    }
    let mut writes = Vec::new();
    for row in &prepared.rows {
        writes.push((row.key.clone(), row.record.clone()));
        writes.push((
            mapping_key(&prepared.manifest.capture_id, &row.key.0),
            mapping_record(row, &prepared.manifest.capture_id)?,
        ));
    }
    writes.extend(prepared.derived.clone());
    writes.push((
        manifest_key(),
        StoredRecord::json(
            format!("capture:{}", prepared.manifest.capture_id),
            json(&prepared.manifest)?,
            None,
        ),
    ));
    let mut checks = Vec::new();
    let mut mutations = Vec::new();
    for (key, record) in writes {
        if store.read(&key).await?.is_some() {
            return Err(invalid("Adoption target changed before commit"));
        }
        checks.push(RevisionCheck {
            key: key.clone(),
            expected_revision: None,
        });
        mutations.push(RecordMutation::Put { key, record });
    }
    if store.commit(AtomicTransition { checks, mutations }).await? != CommitOutcome::Committed {
        return Err(invalid("Adoption conflicted; no partial data was accepted"));
    }
    Ok(AdoptionReceipt {
        capture_id: prepared.manifest.capture_id.clone(),
        source_git_sha: prepared.manifest.source_git_sha.clone(),
        source_rows: prepared.rows.len(),
        derived_rows: prepared.derived.len(),
        atomic_committed: true,
    })
}

/// Private initial installation only, using an independently prepared capability.
/// The host retains the ordinary empty-target, unpublished/quiescent obligation.
pub async fn adopt_empty_with_initial_control_owner<S: QueryStore>(
    store: &S,
    prepared: &PreparedAdoption,
    owner: &gateway_authority::initial_control_owner::PreparedInitialControlOwner,
    now_ms: i64,
) -> Result<crate::InitialControlOwnerAdoptionReceipt, GatewayError> {
    crate::initial_owner::adopt(store, prepared, owner, now_ms).await
}
