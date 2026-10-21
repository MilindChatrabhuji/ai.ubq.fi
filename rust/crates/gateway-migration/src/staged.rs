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
pub(crate) mod record_key_wire {
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
    rows: StageRows,
    sequence: u64,
    digest: String,
    emission_failed: bool,
    #[cfg(all(unix, not(target_arch = "wasm32")))]
    last_emitted_key: Option<String>,
}
enum StageRows {
    Memory(VecDeque<(CanonicalRecord, usize)>),
    #[cfg(all(unix, not(target_arch = "wasm32")))]
    Disk {
        spool: crate::native_spool::Spool<CanonicalRecord>,
        order: VecDeque<(usize, usize)>,
    },
}
impl StageRows {
    fn front_size(&self) -> Option<usize> {
        match self {
            Self::Memory(rows) => rows.front().map(|(_, size)| *size),
            #[cfg(all(unix, not(target_arch = "wasm32")))]
            Self::Disk { order, .. } => order.front().map(|(_, size)| *size),
        }
    }
    fn pop(&mut self) -> Result<(CanonicalRecord, usize), GatewayError> {
        match self {
            Self::Memory(rows) => Ok(rows.pop_front().expect("front checked")),
            #[cfg(all(unix, not(target_arch = "wasm32")))]
            Self::Disk { spool, order } => {
                let (index, size) = order.pop_front().expect("front checked");
                Ok((spool.get(index)?, size))
            }
        }
    }
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
            rows: StageRows::Memory(encoded),
            sequence: 0,
            emission_failed: false,
            #[cfg(all(unix, not(target_arch = "wasm32")))]
            last_emitted_key: None,
        })
    }
    #[cfg(all(unix, not(target_arch = "wasm32")))]
    pub(crate) fn from_spool(
        manifest: crate::engine::Manifest,
        spool: crate::native_spool::Spool<CanonicalRecord>,
    ) -> Result<Self, GatewayError> {
        let mut keys = std::collections::BTreeMap::new();
        for (index, position) in (0..spool.len()).enumerate() {
            if keys
                .insert(
                    spool.key(position)?.to_owned(),
                    (index, spool.encoded_size(position)),
                )
                .is_some()
            {
                return Err(invalid("Staged canonical inventory has duplicate keys"));
            }
        }
        let order: VecDeque<_> = keys.into_values().collect();
        let mut digest = initial(&manifest.capture_id);
        for (index, size) in &order {
            if size + 1024 > STAGED_BATCH_MAX_BYTES {
                return Err(invalid("Staged row does not fit one bounded append"));
            }
            digest = extend_raw(&digest, &spool.raw(*index)?)?;
        }
        spool.verify_end()?;
        let header = StageHeader {
            manifest,
            records: order.len(),
            digest,
        };
        bounded(&StageRequest::Begin(header.clone()))?;
        Ok(Self {
            digest: initial(&header.manifest.capture_id),
            header,
            rows: StageRows::Disk { spool, order },
            sequence: 0,
            emission_failed: false,
            last_emitted_key: None,
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
        if self.emission_failed {
            return Err(invalid("Private staged emission already failed"));
        }
        if self.rows.front_size().is_none() {
            return Ok(None);
        }
        let previous_digest = self.digest.clone();
        let mut records = Vec::new();
        let mut size = 1024usize;
        while let Some(next) = self.rows.front_size() {
            if !records.is_empty() && size + next + 1 > PREFERRED_BATCH_BYTES {
                break;
            }
            let (row, next) = self.rows.pop()?;
            self.digest = extend(&self.digest, &row)?;
            #[cfg(all(unix, not(target_arch = "wasm32")))]
            {
                self.last_emitted_key = Some(row.key.0.clone());
            }
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

    /// Native operator output only. The sealed spool comes exclusively from the
    /// complete genuine-row audit; this accepts neither caller JSON nor an inventory.
    #[cfg(all(unix, not(target_arch = "wasm32")))]
    pub fn write_next_batch<W: std::io::Write>(
        &mut self,
        sink: &mut W,
    ) -> Result<bool, GatewayError> {
        if self.emission_failed {
            return Err(invalid("Private staged emission already failed"));
        }
        let result = self.next_native_frame().and_then(|frame| {
            let Some(frame) = frame else {
                return Ok(false);
            };
            sink.write_all(&frame)
                .map_err(|_| invalid("Private staged frame sink failed"))?;
            Ok(true)
        });
        if result.is_err() {
            // A partial write has an unknown delivery outcome. Neither another
            // sink call nor the typed adapter may continue this operator plan.
            self.emission_failed = true;
        }
        result
    }

    #[cfg(all(unix, not(target_arch = "wasm32")))]
    fn next_native_frame(&mut self) -> Result<Option<Vec<u8>>, GatewayError> {
        if matches!(&self.rows, StageRows::Memory(_)) {
            return self
                .next_batch()?
                .map(|batch| {
                    serde_json::to_vec(&batch)
                        .map_err(|_| invalid("Private staged frame cannot be encoded"))
                })
                .transpose();
        }
        let StageRows::Disk { spool, order } = &self.rows else {
            unreachable!("memory adapter returned above");
        };
        spool.verify_end()?;
        if spool.len() != self.header.records || order.len() > self.header.records {
            return Err(invalid("Staged canonical count changed"));
        }
        if order.is_empty() {
            if self.digest != self.header.digest {
                return Err(invalid("Staged canonical digest changed"));
            }
            return Ok(None);
        }
        let next_sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| invalid("Stage sequence overflow"))?;
        let mut digest = self.digest.clone();
        let mut last_key = self.last_emitted_key.clone();
        let mut records = vec![b'['];
        let mut count = 0;
        let mut size = 1024usize;
        for (index, encoded_size) in order {
            if count != 0 && size + encoded_size + 1 > PREFERRED_BATCH_BYTES {
                break;
            }
            if *encoded_size != spool.encoded_size(*index)
                || encoded_size + 1024 > STAGED_BATCH_MAX_BYTES
            {
                return Err(invalid("Staged canonical frame length changed"));
            }
            let key = spool.key(*index)?;
            if last_key.as_deref().is_some_and(|previous| previous >= key) {
                return Err(invalid("Staged canonical order changed"));
            }
            let raw = spool.raw(*index)?;
            digest = extend_raw(&digest, &raw)?;
            if count != 0 {
                records.push(b',');
            }
            records.extend_from_slice(&raw);
            last_key = Some(key.to_owned());
            size += encoded_size + 1;
            count += 1;
        }
        records.push(b']');
        spool.verify_end()?;
        if count == order.len() && digest != self.header.digest {
            return Err(invalid("Staged canonical digest changed"));
        }
        // These bytes were serialized from actual validated CanonicalRecords and
        // authenticated above. RawValue checks only the unchanged JSON grammar;
        // it never substitutes for the complete semantic audit or grants authority.
        let records = serde_json::value::RawValue::from_string(
            String::from_utf8(records).map_err(|_| invalid("Staged canonical bytes changed"))?,
        )
        .map_err(|_| invalid("Staged canonical bytes changed"))?;
        #[derive(Serialize)]
        struct WireBatch<'a> {
            capture_id: &'a str,
            sequence: u64,
            previous_digest: &'a str,
            records: &'a serde_json::value::RawValue,
            digest: &'a str,
        }
        #[derive(Serialize)]
        struct WireFrame<'a> {
            stage: &'static str,
            data: WireBatch<'a>,
        }
        let frame = serde_json::to_vec(&WireFrame {
            stage: "append",
            data: WireBatch {
                capture_id: &self.header.manifest.capture_id,
                sequence: self.sequence,
                previous_digest: &self.digest,
                records: &records,
                digest: &digest,
            },
        })
        .map_err(|_| invalid("Private staged frame cannot be encoded"))?;
        if frame.len() > STAGED_BATCH_MAX_BYTES {
            return Err(invalid("Private staged frame exceeds its bound"));
        }
        let StageRows::Disk { order, .. } = &mut self.rows else {
            unreachable!("disk frame was verified above");
        };
        order.drain(..count);
        self.sequence = next_sequence;
        self.digest = digest;
        self.last_emitted_key = last_key;
        Ok(Some(frame))
    }
}

#[cfg(all(unix, not(target_arch = "wasm32")))]
fn extend_raw(previous: &str, record: &[u8]) -> Result<String, GatewayError> {
    let mut bytes =
        serde_json::to_vec(previous).map_err(|_| invalid("Staged digest cannot be encoded"))?;
    bytes.insert(0, b'[');
    bytes.push(b',');
    bytes.extend_from_slice(record);
    bytes.push(b']');
    Ok(gateway_auth::crypto::sha256_hex(&bytes))
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
