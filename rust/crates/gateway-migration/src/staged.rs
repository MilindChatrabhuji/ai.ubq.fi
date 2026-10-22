//! Private offline operator data, never an HTTP/admin capability. The host must
//! hold a NEW empty target unpublished and quiescent until seal and reconciliation.
use crate::*;
use gateway_authority::initial_control_owner::{InitialAdoptionAccountFacts, InitialAdoptionFacts};
use gateway_authority::paid_control::PaidControlOwner;
use gateway_core::{
    query::{QueryRequest, QuerySelector, QueryStore},
    state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck},
};
use std::collections::{BTreeSet, VecDeque};

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
    Seal {
        capture_id: String,
    },
    /// Private post-seal control-owner binding. It proves the sealed target's
    /// exact manifest/source/projection facts and the absent-owner fence before
    /// one CAS. It never marks the target active or rewrites sealed data.
    BindOwner(StageOwnerBinding),
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StageOwnerAccount {
    pub account_id_hash: String,
    pub access_generation: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StageOwnerBinding {
    pub capture_id: String,
    pub source_git_sha: String,
    pub source_captured_at_ms: i64,
    pub source_native_version: String,
    pub source_native_sequence: String,
    pub source_pool_revision: String,
    pub normalized_pool_revision: String,
    pub accounts: Vec<StageOwnerAccount>,
    pub custody_observed_at_ms: i64,
    pub valid_through_ms: i64,
    pub bound_at_ms: i64,
    pub owner_id: String,
    pub owner_epoch: String,
    pub key_fingerprint: String,
    pub owner_revision: String,
}
#[derive(Debug, Serialize)]
pub struct StagePlanSummary {
    pub capture_id: String,
    pub source_git_sha: String,
    pub captured_at_ms: i64,
    pub source_rows: usize,
    pub derived_rows: usize,
    pub records: usize,
    pub digest: String,
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
    pub owner_bound: bool,
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
        reader: crate::native_spool::Reader<CanonicalRecord>,
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
            Self::Disk { reader, order } => {
                let (index, size) = order.pop_front().expect("front checked");
                Ok((reader.read(index)?, size))
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
        let mut reader = spool.reader()?;
        let mut keys = std::collections::BTreeMap::new();
        let mut ordinal = 0usize;
        while reader.next_raw()?.is_some() {
            if keys
                .insert(
                    spool.key(ordinal)?.to_owned(),
                    (ordinal, spool.encoded_size(ordinal)),
                )
                .is_some()
            {
                return Err(invalid("Staged canonical inventory has duplicate keys"));
            }
            ordinal += 1;
        }
        reader.verify_end()?;
        if ordinal != spool.len() {
            return Err(invalid("Staged canonical count changed"));
        }
        let order: VecDeque<_> = keys.into_values().collect();
        let mut digest = initial(&manifest.capture_id);
        for (index, size) in &order {
            if size + 1024 > STAGED_BATCH_MAX_BYTES {
                return Err(invalid("Staged row does not fit one bounded append"));
            }
            digest = extend_raw(&digest, &reader.read_raw(*index)?)?;
        }
        reader.verify_file_end()?;
        let header = StageHeader {
            manifest,
            records: order.len(),
            digest,
        };
        bounded(&StageRequest::Begin(header.clone()))?;
        Ok(Self {
            digest: initial(&header.manifest.capture_id),
            header,
            rows: StageRows::Disk { reader, order },
            sequence: 0,
            emission_failed: false,
            last_emitted_key: None,
        })
    }
    pub fn summary(&self) -> StagePlanSummary {
        StagePlanSummary {
            capture_id: self.header.manifest.capture_id.clone(),
            source_git_sha: self.header.manifest.source_git_sha.clone(),
            captured_at_ms: self.header.manifest.captured_at_ms,
            source_rows: self.header.manifest.source_rows,
            derived_rows: self.header.manifest.derived.len(),
            records: self.header.records,
            digest: self.header.digest.clone(),
        }
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
        let StageRows::Disk { reader, order } = &mut self.rows else {
            unreachable!("memory adapter returned above");
        };
        reader.verify_file_end()?;
        if reader.spool().len() != self.header.records || order.len() > self.header.records {
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
        for (index, encoded_size) in order.iter() {
            if count != 0 && size + encoded_size + 1 > PREFERRED_BATCH_BYTES {
                break;
            }
            if *encoded_size != reader.spool().encoded_size(*index)
                || *encoded_size + 1024 > STAGED_BATCH_MAX_BYTES
            {
                return Err(invalid("Staged canonical frame length changed"));
            }
            let key = reader.spool().key(*index)?.to_owned();
            if last_key
                .as_deref()
                .is_some_and(|previous| previous >= key.as_str())
            {
                return Err(invalid("Staged canonical order changed"));
            }
            let raw = reader.read_raw(*index)?;
            digest = extend_raw(&digest, &raw)?;
            if count != 0 {
                records.push(b',');
            }
            records.extend_from_slice(&raw);
            last_key = Some(key);
            size += encoded_size + 1;
            count += 1;
        }
        records.push(b']');
        reader.verify_file_end()?;
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
        owner_bound: false,
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
    if let StageRequest::BindOwner(binding) = &request {
        return bind_owner(store, binding).await;
    }
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
        StageRequest::Begin(_) | StageRequest::BindOwner(_) => {
            unreachable!("begin/owner handled above")
        }
    }
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}
fn decimal(value: &str) -> bool {
    value
        .parse::<i64>()
        .ok()
        .is_some_and(|number| number >= 0 && number.to_string() == value)
}
fn opaque(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096
}
fn owner_refused() -> GatewayError {
    invalid("Private staged control-owner binding is inconsistent or stale")
}
fn validate_owner_binding(binding: &StageOwnerBinding) -> Result<(), GatewayError> {
    let mut accounts = BTreeSet::new();
    if !hex(&binding.capture_id, 64)
        || !hex(&binding.source_git_sha, 40)
        || !decimal(&binding.source_native_version)
        || !decimal(&binding.source_native_sequence)
        || !opaque(&binding.source_pool_revision)
        || !opaque(&binding.normalized_pool_revision)
        || !(1..=2).contains(&binding.accounts.len())
        || binding.accounts.iter().any(|account| {
            !hex(&account.account_id_hash, 64)
                || !hex(&account.access_generation, 64)
                || !accounts.insert(account.account_id_hash.clone())
        })
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&binding.source_captured_at_ms)
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&binding.custody_observed_at_ms)
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&binding.valid_through_ms)
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&binding.bound_at_ms)
        || binding.source_captured_at_ms > binding.custody_observed_at_ms
        || binding.valid_through_ms < binding.custody_observed_at_ms
        || binding.bound_at_ms < binding.custody_observed_at_ms
        || binding.bound_at_ms > binding.valid_through_ms
        || !identifier(&binding.owner_id, 128)
        || !identifier(&binding.owner_epoch, 128)
        || !hex(&binding.key_fingerprint, 64)
        || !opaque(&binding.owner_revision)
    {
        return Err(owner_refused());
    }
    Ok(())
}
fn owner_from_binding(binding: &StageOwnerBinding) -> PaidControlOwner {
    PaidControlOwner {
        v: 1,
        owner_id: binding.owner_id.clone(),
        owner_epoch: binding.owner_epoch.clone(),
        key_fingerprint: binding.key_fingerprint.clone(),
    }
}
async fn sealed_owner_facts<S: QueryStore>(
    store: &S,
    binding: &StageOwnerBinding,
) -> Result<
    (
        crate::engine::Manifest,
        StoredRecord,
        StoredRecord,
        StoredRecord,
    ),
    GatewayError,
> {
    let manifest_record = store
        .read(&crate::engine::manifest_key())
        .await?
        .ok_or_else(owner_refused)?;
    if manifest_record.revision != format!("capture:{}", binding.capture_id) {
        return Err(owner_refused());
    }
    let manifest: crate::engine::Manifest = decode(manifest_record.json_value()?)?;
    let native = manifest
        .native_revision
        .as_ref()
        .ok_or_else(owner_refused)?;
    if manifest.v != 4
        || manifest.capture_id != binding.capture_id
        || manifest.source_git_sha != binding.source_git_sha
        || manifest.captured_at_ms != binding.source_captured_at_ms
        || native.version != binding.source_native_version
        || native.sequence != binding.source_native_sequence
        || binding.bound_at_ms < manifest.captured_at_ms
    {
        return Err(owner_refused());
    }
    let source = store
        .read(&gateway_auth::provider_credentials::codex_source_pool_key())
        .await?
        .ok_or_else(owner_refused)?;
    let normalized = store
        .read(&gateway_authority::keys::pool())
        .await?
        .ok_or_else(owner_refused)?;
    if source.revision != binding.source_pool_revision
        || normalized.revision != binding.normalized_pool_revision
    {
        return Err(owner_refused());
    }
    let pool = gateway_auth::provider_credentials::parse_codex_source_pool(source.json_value()?)?
        .ok_or_else(owner_refused)?;
    let routing: gateway_authority::routing::SubscriptionPool = decode(normalized.json_value()?)?;
    if routing.v != 1
        || routing.pool_versionstamp.0 != source.revision
        || routing.accounts.len() != pool.accounts.len()
    {
        return Err(owner_refused());
    }
    let mut accounts = Vec::new();
    for (account, projection) in pool.accounts.iter().zip(&routing.accounts) {
        if !account.refresh_token.expose().is_empty() {
            return Err(owner_refused());
        }
        let owner = account.native_owner.as_ref().ok_or_else(owner_refused)?;
        let identity = account.identity();
        if projection.account_id_hash != identity.routing_account_hash
            || projection.admin_account_hash != identity.administrative_account_hash
            || projection.credential_version != identity.credential_version
            || !projection.enabled
        {
            return Err(owner_refused());
        }
        accounts.push(InitialAdoptionAccountFacts {
            account_id_hash: identity.routing_account_hash.0,
            projection_generation: owner.generation_hash.clone(),
            access_generation: identity.native_generation_hash,
        });
    }
    let actual = InitialAdoptionFacts {
        capture_id: manifest.capture_id.clone(),
        source_git_sha: manifest.source_git_sha.clone(),
        source_captured_at_ms: manifest.captured_at_ms,
        source_native_version: native.version.clone(),
        source_native_sequence: native.sequence.clone(),
        source_pool_revision: source.revision.clone(),
        normalized_pool_revision: normalized.revision.clone(),
        accounts,
    };
    let expected = InitialAdoptionFacts {
        capture_id: binding.capture_id.clone(),
        source_git_sha: binding.source_git_sha.clone(),
        source_captured_at_ms: binding.source_captured_at_ms,
        source_native_version: binding.source_native_version.clone(),
        source_native_sequence: binding.source_native_sequence.clone(),
        source_pool_revision: binding.source_pool_revision.clone(),
        normalized_pool_revision: binding.normalized_pool_revision.clone(),
        accounts: binding
            .accounts
            .iter()
            .map(|account| InitialAdoptionAccountFacts {
                account_id_hash: account.account_id_hash.clone(),
                projection_generation: account.access_generation.clone(),
                access_generation: account.access_generation.clone(),
            })
            .collect(),
    };
    if actual != expected {
        return Err(owner_refused());
    }
    Ok((manifest, manifest_record, source, normalized))
}
fn owner_receipt(
    binding: &StageOwnerBinding,
    manifest: &crate::engine::Manifest,
) -> Result<StageReceipt, GatewayError> {
    Ok(StageReceipt {
        capture_id: binding.capture_id.clone(),
        source_rows: manifest.source_rows,
        derived_rows: manifest.derived.len(),
        accepted_records: manifest
            .source_rows
            .checked_mul(2)
            .and_then(|value| value.checked_add(manifest.derived.len()))
            .ok_or_else(owner_refused)?,
        atomic_batches: 1,
        sealed: true,
        owner_bound: true,
        activation_authorized: false,
    })
}
async fn bind_owner<S: QueryStore>(
    store: &S,
    binding: &StageOwnerBinding,
) -> Result<StageReceipt, GatewayError> {
    validate_owner_binding(binding)?;
    let (manifest, manifest_record, source, normalized) =
        sealed_owner_facts(store, binding).await?;
    let owner_key = gateway_authority::keys::paid_control_owner();
    let expected =
        serde_json::to_value(owner_from_binding(binding)).map_err(|_| owner_refused())?;
    let exact = |record: &StoredRecord| {
        record.revision == binding.owner_revision
            && record.expires_at_ms.is_none()
            && record.json_value().is_ok_and(|value| value == &expected)
    };
    if let Some(current) = store.read(&owner_key).await? {
        if exact(&current) {
            // Exact retry after a lost response reconciles the already-bound row.
            return owner_receipt(binding, &manifest);
        }
        return Err(invalid("Target already has a different control owner"));
    }
    let record = StoredRecord::json(&binding.owner_revision, expected.clone(), None);
    let transition = AtomicTransition {
        checks: vec![
            check(
                crate::engine::manifest_key(),
                Some(manifest_record.revision),
            ),
            check(
                gateway_auth::provider_credentials::codex_source_pool_key(),
                Some(source.revision),
            ),
            check(gateway_authority::keys::pool(), Some(normalized.revision)),
            check(owner_key.clone(), None),
        ],
        mutations: vec![RecordMutation::Put {
            key: owner_key.clone(),
            record,
        }],
    };
    if store.commit(transition).await? != CommitOutcome::Committed {
        return Err(invalid("Private staged owner binding conflicted"));
    }
    let bound = store
        .read(&owner_key)
        .await?
        .ok_or_else(|| invalid("Private staged owner binding did not settle"))?;
    if !exact(&bound) {
        return Err(invalid("Private staged owner binding differs after commit"));
    }
    owner_receipt(binding, &manifest)
}
