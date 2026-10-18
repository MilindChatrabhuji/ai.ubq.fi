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
}
pub struct PreparedAdoption {
    pub(crate) manifest: Manifest,
    pub(crate) rows: Vec<Row>,
    pub(crate) derived: Vec<(RecordKey, StoredRecord)>,
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
    key(json!(["uos_ai", "migration", "v2", "manifest"]))
}
pub(crate) fn mapping_key(id: &str, source: &str) -> RecordKey {
    key(json!(["uos_ai", "migration", "v2", "row", id, gateway_auth::crypto::sha256_hex(source.as_bytes())]))
}

pub(crate) fn mapping_record(row:&Row,capture_id:&str)->Result<StoredRecord,GatewayError>{
    Ok(StoredRecord::json(format!("capture:{capture_id}"),json(&row.mapping)?,None))
}
pub(crate) fn mapping_checksum(records:impl IntoIterator<Item=(String,StoredRecord)>)->Result<String,GatewayError>{
    let mut entries=records.into_iter().map(|(key,record)|Ok((key,digest(&record)?))).collect::<Result<Vec<_>,GatewayError>>()?;entries.sort_by(|a,b|a.0.cmp(&b.0));
    Ok(gateway_auth::crypto::sha256_hex(&serde_json::to_vec(&entries).map_err(|_|invalid("Mapping checksum cannot be encoded"))?))
}

fn validate_source_inventories(rows:&[Row],now:i64)->Result<(),GatewayError>{
    use gateway_admin_data::migration::{ObservedRow,audit};
    let observed:Vec<_>=rows.iter().filter(|r|r.record.expires_at_ms.is_none_or(|e|e>now)).map(|r|ObservedRow{key:r.key.clone(),parts:r.parts.clone(),record:r.record.clone()}).collect();
    let (pairs,mut findings)=audit::inspect_key_pairs(&observed)?;
    let known=pairs.iter().filter_map(|(id,_)|id.get("id").and_then(Value::as_str).map(str::to_owned)).collect();
    let unlimited=pairs.iter().filter(|(id,_)|id["paid_fallback_limit_microcredits"]==-1).filter_map(|(id,_)|id["id"].as_str().map(str::to_owned)).collect();
    findings.merge(audit::inspect_api_usage(&observed,&known)?);
    findings.merge(audit::inspect_kernel(&observed)?);
    findings.merge(audit::inspect_paid(&observed,&known,&unlimited,now)?);
    findings.merge(audit::inspect_reset_usage(&observed)?);
    findings.errors.extend(audit::inspect_model_snapshot(&observed)?);
    if findings.errors.is_empty(){Ok(())}else{Err(invalid(format!("Complete source inventory validation failed: {}",findings.errors.join("; "))))}
}

pub fn prepare(
    capture: &PrivateCapture,
    host: &dyn SourceDateHost,
) -> Result<PreparedAdoption, GatewayError> {
    let capture_id = gateway_auth::crypto::sha256_hex(
        &serde_json::to_vec(capture).map_err(|_| invalid("Capture cannot be encoded"))?,
    );
    let mut rows = capture.validate(host)?;
    validate_source_inventories(&rows,capture.captured_at_ms)?;
    for row in &mut rows {
        crate::projection::forward(row)?;
    }
    let revision = format!("capture:{capture_id}");
    let derived = crate::indexes::bind(&mut rows, capture.captured_at_ms, &revision)?;
    let mut derived_digests = BTreeMap::new();
    for (key, record) in &derived {
        if rows.iter().any(|r| r.key == *key)
            || derived_digests
                .insert(key.0.clone(), digest(record)?)
                .is_some()
        {
            return Err(invalid("Derived schema key collides with source state"));
        }
    }
    for row in &mut rows {
        row.mapping.baseline_digest = digest(&row.record)?;
        // Identity values already live once at the source key. Do not duplicate historical
        // provider/refresh/session secrets in rollback metadata.
        if row.mapping.transform == Transform::Identity {
            row.mapping.source.value = Value::Null;
            row.mapping.source.key.clear();
        }
    }
    let manifest = Manifest {
        v: 2,
        capture_id: capture_id.clone(),
        source_git_sha: capture.source_git_sha.clone(),
        captured_at_ms: capture.captured_at_ms,
        source_rows: rows.len(),
        mapping_checksum: mapping_checksum(rows.iter().map(|row|Ok((mapping_key(&capture_id,&row.key.0).0,mapping_record(row,&capture_id)?))).collect::<Result<Vec<_>,GatewayError>>()?)?,
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
            mapping_record(row,&prepared.manifest.capture_id)?,
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
