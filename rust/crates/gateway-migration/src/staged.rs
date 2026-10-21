//! Private offline operator data, never an HTTP/admin capability. The host must
//! hold a NEW empty target unpublished and quiescent until seal and reconciliation.
use crate::*;
use gateway_core::{
    query::{QueryRequest, QuerySelector, QueryStore},
    state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck},
};
use std::collections::VecDeque;

pub const STAGED_BATCH_MAX_BYTES: usize = crate::operational::PRIVATE_WIRE_MAX_BYTES;
const PREFERRED_BATCH_BYTES: usize = 4 * 1024 * 1024;
mod record_key_wire {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        key: &RecordKey,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&key.0)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<RecordKey, D::Error> {
        let key = RecordKey(String::deserialize(deserializer)?);
        TupleKey::from_record_key(&key)
            .and_then(|key| key.validate_stored_key())
            .map_err(serde::de::Error::custom)?;
        Ok(key)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalRecord {
    #[serde(with = "record_key_wire")]
    pub key: RecordKey,
    pub record: StoredRecord,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StageHeader {
    manifest: crate::engine::Manifest,
    records: usize,
    digest: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StageBatch {
    pub capture_id: String,
    pub sequence: u64,
    pub previous_digest: String,
    pub records: Vec<CanonicalRecord>,
    pub digest: String,
}
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "stage",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum StageRequest {
    Begin(StageHeader),
    Append(StageBatch),
    Seal { capture_id: String },
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StageReceipt {
    pub capture_id: String,
    pub source_rows: usize,
    pub derived_rows: usize,
    pub accepted_records: usize,
    pub atomic_batches: u64,
    pub sealed: bool,
    /// Data readiness is not a grant to activate a service or restore an owner.
    pub activation_authorized: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    header: StageHeader,
    sequence: u64,
    received: usize,
    digest: String,
    last_key: Option<String>,
}
fn progress_key() -> RecordKey {
    key(serde_json::json!(["uos_ai", "migration", "v3", "staged"]))
}
fn initial(id: &str) -> String {
    gateway_auth::crypto::sha256_hex(format!("private-staged-v1:{id}").as_bytes())
}
fn extend(previous: &str, item: &CanonicalRecord) -> Result<String, GatewayError> {
    Ok(gateway_auth::crypto::sha256_hex(
        &serde_json::to_vec(&(previous, item))
            .map_err(|_| invalid("Staged row cannot be encoded"))?,
    ))
}
fn bounded<T: Serialize>(value: &T) -> Result<usize, GatewayError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| invalid("Private staged frame cannot be encoded"))?;
    if bytes.len() > STAGED_BATCH_MAX_BYTES {
        return Err(invalid("Private staged frame exceeds its bound"));
    }
    Ok(bytes.len())
}
/// Only constructed from a complete audited PreparedAdoption. No Deserialize.
/// Native preparation may retain the full capture; WASM receives bounded frames.
pub struct StagePlan {
    header: StageHeader,
    rows: VecDeque<(CanonicalRecord, usize)>,
    sequence: u64,
    digest: String,
}
impl StagePlan {
    pub fn from_prepared(prepared: PreparedAdoption) -> Result<Self, GatewayError> {
        if prepared.manifest.native_revision.is_none() {
            return Err(invalid(
                "Staged adoption requires a complete native capture",
            ));
        }
        let mut rows = Vec::new();
        for row in prepared.rows {
            rows.push(CanonicalRecord {
                key: crate::engine::mapping_key(&prepared.manifest.capture_id, &row.key.0),
                record: crate::engine::mapping_record(&row, &prepared.manifest.capture_id)?,
            });
            rows.push(CanonicalRecord {
                key: row.key,
                record: row.record,
            });
        }
        rows.extend(
            prepared
                .derived
                .into_iter()
                .map(|(key, record)| CanonicalRecord { key, record }),
        );
        rows.sort_by(|a, b| a.key.0.cmp(&b.key.0));
        if rows.windows(2).any(|p| p[0].key == p[1].key) {
            return Err(invalid("Staged canonical inventory has duplicate keys"));
        }
        let mut digest = initial(&prepared.manifest.capture_id);
        let mut encoded = VecDeque::new();
        for row in rows {
            let size = bounded(&row)?;
            if size + 1024 > STAGED_BATCH_MAX_BYTES {
                return Err(invalid("Staged row does not fit one bounded append"));
            }
            digest = extend(&digest, &row)?;
            encoded.push_back((row, size));
        }
        let header = StageHeader {
            manifest: prepared.manifest,
            records: encoded.len(),
            digest,
        };
        bounded(&StageRequest::Begin(header.clone()))?;
        Ok(Self {
            digest: initial(&header.manifest.capture_id),
            header,
            rows: encoded,
            sequence: 0,
        })
    }
    pub fn begin(&self) -> StageRequest {
        StageRequest::Begin(self.header.clone())
    }
    pub fn seal(&self) -> StageRequest {
        StageRequest::Seal {
            capture_id: self.header.manifest.capture_id.clone(),
        }
    }
    pub fn next_batch(&mut self) -> Result<Option<StageRequest>, GatewayError> {
        if self.rows.is_empty() {
            return Ok(None);
        }
        let previous_digest = self.digest.clone();
        let mut records = Vec::new();
        let mut size = 1024usize;
        while let Some((_, next)) = self.rows.front() {
            if !records.is_empty() && size + next + 1 > PREFERRED_BATCH_BYTES {
                break;
            }
            let (row, next) = self.rows.pop_front().expect("front checked");
            self.digest = extend(&self.digest, &row)?;
            size += next + 1;
            records.push(row);
        }
        let batch = StageRequest::Append(StageBatch {
            capture_id: self.header.manifest.capture_id.clone(),
            sequence: self.sequence,
            previous_digest,
            records,
            digest: self.digest.clone(),
        });
        bounded(&batch)?;
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| invalid("Stage sequence overflow"))?;
        Ok(Some(batch))
    }
}
pub fn decode_stage_request(bytes: &[u8]) -> Result<StageRequest, GatewayError> {
    if bytes.len() > STAGED_BATCH_MAX_BYTES {
        return Err(invalid("Private staged input exceeds its bound"));
    }
    serde_json::from_slice(bytes).map_err(|_| invalid("Private staged input is invalid"))
}
async fn transition<S: AuthorityStore>(
    store: &S,
    checks: Vec<RevisionCheck>,
    mutations: Vec<RecordMutation>,
) -> Result<(), GatewayError> {
    if store.commit(AtomicTransition { checks, mutations }).await? != CommitOutcome::Committed {
        return Err(invalid("Private staged adoption conflicted"));
    }
    Ok(())
}
fn check(key: RecordKey, expected_revision: Option<String>) -> RevisionCheck {
    RevisionCheck {
        key,
        expected_revision,
    }
}
fn progress_record(progress: &Progress) -> Result<StoredRecord, GatewayError> {
    Ok(StoredRecord::json(
        format!(
            "stage:{}:{}",
            progress.header.manifest.capture_id, progress.sequence
        ),
        json(progress)?,
        None,
    ))
}
fn receipt(p: &Progress, sealed: bool) -> StageReceipt {
    StageReceipt {
        capture_id: p.header.manifest.capture_id.clone(),
        source_rows: p.header.manifest.source_rows,
        derived_rows: p.header.manifest.derived.len(),
        accepted_records: p.received,
        atomic_batches: p.sequence,
        sealed,
        activation_authorized: false,
    }
}
/// Caller must be the existing trusted private host with exclusive unpublished
/// target custody. A deserialized frame grants no public/live authority.
pub async fn execute_staged<S: QueryStore>(
    store: &S,
    request: StageRequest,
) -> Result<StageReceipt, GatewayError> {
    bounded(&request)?;
    let manifest_key = crate::engine::manifest_key();
    if store.read(&manifest_key).await?.is_some() {
        return Err(invalid("Target already adopted"));
    }
    if let StageRequest::Begin(header) = request {
        if header.manifest.v != 4
            || header.manifest.native_revision.is_none()
            || header.records
                != header
                    .manifest
                    .source_rows
                    .checked_mul(2)
                    .and_then(|v| v.checked_add(header.manifest.derived.len()))
                    .ok_or_else(|| invalid("Stage count overflow"))?
            || header.digest.len() != 64
        {
            return Err(invalid("Private staged header is inconsistent"));
        }
        let page = store
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
        if !page.entries.is_empty() || page.next_cursor.is_some() {
            return Err(invalid("Staged target is not empty"));
        }
        let progress = Progress {
            digest: initial(&header.manifest.capture_id),
            header,
            sequence: 0,
            received: 0,
            last_key: None,
        };
        transition(
            store,
            vec![check(progress_key(), None), check(manifest_key, None)],
            vec![RecordMutation::Put {
                key: progress_key(),
                record: progress_record(&progress)?,
            }],
        )
        .await?;
        return Ok(receipt(&progress, false));
    }
    let previous = store
        .read(&progress_key())
        .await?
        .ok_or_else(|| invalid("No private staged target"))?;
    let mut progress: Progress = decode(previous.json_value()?)?;
    let mut checks = vec![
        check(progress_key(), Some(previous.revision)),
        check(manifest_key.clone(), None),
    ];
    let mut mutations = Vec::new();
    match request {
        StageRequest::Append(batch) => {
            if batch.capture_id != progress.header.manifest.capture_id
                || batch.sequence != progress.sequence
                || batch.previous_digest != progress.digest
                || batch.records.is_empty()
                || progress
                    .received
                    .checked_add(batch.records.len())
                    .is_none_or(|n| n > progress.header.records)
            {
                return Err(invalid("Private staged batch sequence/count differs"));
            }
            for item in batch.records {
                TupleKey::from_record_key(&item.key)?.validate_stored_key()?;
                item.record.validate_version()?;
                if item.key == manifest_key
                    || item.key == progress_key()
                    || progress
                        .last_key
                        .as_ref()
                        .is_some_and(|last| last >= &item.key.0)
                {
                    return Err(invalid("Private staged key order/collision differs"));
                }
                progress.digest = extend(&progress.digest, &item)?;
                progress.last_key = Some(item.key.0.clone());
                progress.received += 1;
                checks.push(check(item.key.clone(), None));
                mutations.push(RecordMutation::Put {
                    key: item.key,
                    record: item.record,
                });
            }
            if progress.digest != batch.digest {
                return Err(invalid("Private staged batch digest differs"));
            }
            progress.sequence = progress
                .sequence
                .checked_add(1)
                .ok_or_else(|| invalid("Stage sequence overflow"))?;
            mutations.push(RecordMutation::Put {
                key: progress_key(),
                record: progress_record(&progress)?,
            });
            transition(store, checks, mutations).await?;
            Ok(receipt(&progress, false))
        }
        StageRequest::Seal { capture_id } => {
            if capture_id != progress.header.manifest.capture_id
                || progress.received != progress.header.records
                || progress.digest != progress.header.digest
            {
                return Err(invalid("Private staged target is incomplete or corrupt"));
            }
            mutations.push(RecordMutation::Put {
                key: manifest_key,
                record: StoredRecord::json(
                    format!("capture:{capture_id}"),
                    json(&progress.header.manifest)?,
                    None,
                ),
            });
            mutations.push(RecordMutation::Delete {
                key: progress_key(),
            });
            transition(store, checks, mutations).await?;
            Ok(receipt(&progress, true))
        }
        StageRequest::Begin(_) => unreachable!("begin handled above"),
    }
}
