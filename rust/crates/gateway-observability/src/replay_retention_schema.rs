//! Source capture-owned budget/accounting rows. This is unrelated to paid accounting.
use crate::{
    replay_model as model,
    replay_values::{self, SourceObject},
    store,
    types::ObservabilityHost,
};
use gateway_core::{
    GatewayError,
    source_json::SourceJson,
    state::{AuthorityStore, RecordKey, RecordMutation, StoredRecord},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;
pub const OVERHEAD: f64 = 8192.0;
pub const MAX_RECORDS: f64 = 50_000.0;
pub const RESERVATION_MS: i64 = 120_000;
pub const ATTEMPTS: usize = 5;
#[derive(Clone, Copy)]
pub struct RetentionLimits {
    pub(crate) budget: f64,
}
impl Default for RetentionLimits {
    fn default() -> Self {
        Self {
            budget: 1_073_741_824.0,
        }
    }
}
impl RetentionLimits {
    /// Source's injectable test seam; the public runtime always uses Default.
    pub fn for_fixture(bytes: u64) -> Self {
        Self {
            budget: bytes.clamp(65_536, gateway_core::identity::MAX_SAFE_INTEGER as u64) as f64,
        }
    }
    pub(crate) fn reserve(self) -> f64 {
        (self.budget / 16.0).floor().min(67_108_864.0)
    }
    pub(crate) fn payload(self) -> f64 {
        self.budget - self.reserve()
    }
}
pub(crate) fn accounting_key(at: f64, id: &str) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "sentinel_replay",
        "v1",
        "accounting",
        at,
        id
    ]))
}
pub(crate) fn dedupe_key(fingerprint: &str) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "sentinel_replay",
        "v1",
        "dedupe",
        fingerprint
    ]))
}
pub(crate) fn charge(ciphertext: usize, metadata: usize) -> f64 {
    (ciphertext.div_ceil(3) * 4 + metadata) as f64 + OVERHEAD
}
pub(crate) fn reservation_charge(plaintext: usize, metadata: usize) -> f64 {
    charge(
        plaintext
            .saturating_add(65_536 + 16)
            .min(crate::replay_crypto::MAX_CIPHERTEXT_BYTES),
        metadata,
    )
}
pub(crate) fn metadata_charge(document: &SourceJson) -> f64 {
    document.as_bytes().len() as f64 + OVERHEAD
}
pub(crate) fn row_metadata_charge(row: Option<&StoredRecord>) -> Result<f64, GatewayError> {
    row.map(|r| replay_values::read_json_record(r).map(|s| metadata_charge(&s)))
        .transpose()
        .map(|v| v.unwrap_or(0.0))
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Ledger {
    pub version: f64,
    pub budget_bytes: f64,
    pub stored_bytes: f64,
    pub reserved_bytes: f64,
    pub records: f64,
    pub status_records: f64,
    pub metadata_bytes: f64,
    pub evicted_bytes: f64,
    pub evicted_records: f64,
    pub expired_bytes: f64,
    pub expired_records: f64,
    pub status_pruned_records: f64,
    #[serde(deserialize_with = "model::nullable")]
    pub last_eviction_at_ms: Option<f64>,
    #[serde(deserialize_with = "model::nullable")]
    pub last_warning_at_ms: Option<f64>,
    #[serde(deserialize_with = "model::nullable")]
    pub last_full_at_ms: Option<f64>,
    #[serde(deserialize_with = "model::nullable")]
    pub last_skip_reason: Option<String>,
    pub bootstrap_complete: bool,
    #[serde(deserialize_with = "model::nullable")]
    pub bootstrap_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap_sweep: Option<String>,
    #[serde(deserialize_with = "model::nullable")]
    pub accounting_error: Option<String>,
    pub over_budget: bool,
}
const LEDGER_FIELDS: &[&str] = &[
    "version",
    "budget_bytes",
    "stored_bytes",
    "reserved_bytes",
    "records",
    "status_records",
    "metadata_bytes",
    "evicted_bytes",
    "evicted_records",
    "expired_bytes",
    "expired_records",
    "status_pruned_records",
    "last_eviction_at_ms",
    "last_warning_at_ms",
    "last_full_at_ms",
    "last_skip_reason",
    "bootstrap_complete",
    "bootstrap_cursor",
    "bootstrap_sweep",
    "accounting_error",
    "over_budget",
];
impl Ledger {
    pub fn empty(limits: RetentionLimits) -> Self {
        Self {
            version: 1.0,
            budget_bytes: limits.budget,
            stored_bytes: 0.0,
            reserved_bytes: 0.0,
            records: 0.0,
            status_records: 0.0,
            metadata_bytes: 0.0,
            evicted_bytes: 0.0,
            evicted_records: 0.0,
            expired_bytes: 0.0,
            expired_records: 0.0,
            status_pruned_records: 0.0,
            last_eviction_at_ms: None,
            last_warning_at_ms: None,
            last_full_at_ms: None,
            last_skip_reason: None,
            bootstrap_complete: false,
            bootstrap_cursor: None,
            bootstrap_sweep: None,
            accounting_error: None,
            over_budget: false,
        }
    }
    pub fn valid(&self) -> bool {
        self.version == 1.0
            && [
                self.budget_bytes,
                self.stored_bytes,
                self.reserved_bytes,
                self.records,
                self.status_records,
                self.metadata_bytes,
                self.evicted_bytes,
                self.evicted_records,
                self.expired_bytes,
                self.expired_records,
                self.status_pruned_records,
            ]
            .into_iter()
            .all(model::counter)
            && [
                self.last_eviction_at_ms,
                self.last_warning_at_ms,
                self.last_full_at_ms,
            ]
            .into_iter()
            .all(|v| v.is_none_or(model::counter))
    }
    pub fn ready(&self) -> bool {
        self.bootstrap_complete && self.accounting_error.is_none()
    }
}
#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccountingState {
    Reserved,
    Stored,
    Evicting,
    Revoked,
}
#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ClaimKind {
    Evicted,
    Expired,
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Accounting {
    pub version: f64,
    pub capture_id: String,
    pub request_id: String,
    pub fingerprint: String,
    pub bytes: f64,
    pub state: AccountingState,
    pub fence: f64,
    pub created_at_ms: f64,
    pub expires_at_ms: f64,
    pub status_expires_at_ms: f64,
    pub stage: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "model::optional_nonnull"
    )]
    pub claim_kind: Option<ClaimKind>,
}
const ACCOUNT_FIELDS: &[&str] = &[
    "version",
    "capture_id",
    "request_id",
    "fingerprint",
    "bytes",
    "state",
    "fence",
    "created_at_ms",
    "expires_at_ms",
    "status_expires_at_ms",
    "stage",
    "claim_kind",
];
impl Accounting {
    pub fn valid(&self) -> bool {
        self.version == 1.0
            && !self.capture_id.is_empty()
            && self.capture_id.encode_utf16().count() <= 128
            && model::digest(&self.fingerprint)
            && self.bytes > 0.0
            && self.fence >= 1.0
            && [
                self.bytes,
                self.fence,
                self.created_at_ms,
                self.expires_at_ms,
                self.status_expires_at_ms,
                self.stage,
            ]
            .into_iter()
            .all(model::counter)
    }
    pub fn matches(&self, key: &RecordKey) -> bool {
        accounting_key(self.created_at_ms, &self.capture_id) == *key
    }
}
pub(crate) fn decode<T: DeserializeOwned>(
    row: &StoredRecord,
    names: &[&str],
) -> Result<T, GatewayError> {
    SourceObject::parse(&replay_values::read_json_record(row)?)?
        .select(names)?
        .deserialize()
}
pub(crate) fn accounting(row: &StoredRecord, key: &RecordKey) -> Result<Accounting, GatewayError> {
    let value: Accounting = decode(row, ACCOUNT_FIELDS)?;
    if !value.valid() || !value.matches(key) {
        return Err(store::error("Sentinel replay accounting row is invalid"));
    }
    Ok(value)
}
pub(crate) async fn read_ledger<S: AuthorityStore>(
    store: &S,
    limits: RetentionLimits,
) -> Result<(Ledger, Option<StoredRecord>), GatewayError> {
    let row = store.read(&model::key("budget")).await?;
    let value = if let Some(row) = row.as_ref() {
        decode(row, LEDGER_FIELDS)?
    } else {
        Ledger::empty(limits)
    };
    if !value.valid() {
        return Err(store::error("Sentinel replay budget ledger is invalid"));
    }
    Ok((
        Ledger {
            budget_bytes: limits.budget,
            ..value
        },
        row,
    ))
}
pub(crate) fn mutation<H: ObservabilityHost, T: Serialize>(
    host: &H,
    key: RecordKey,
    previous: Option<&StoredRecord>,
    value: &T,
    expiry: Option<i64>,
) -> Result<RecordMutation, GatewayError> {
    let fresh = SourceJson::from_serializable(value)?;
    let document = if let Some(row) = previous {
        let mut document = SourceObject::parse(&replay_values::read_json_record(row)?)?;
        for (name, value) in fresh.object_entries()? {
            document.set(&name.try_utf8()?, &value)?;
        }
        document.source_json()?
    } else {
        fresh
    };
    replay_values::put_json(host, key, &document, expiry)
}
pub(crate) fn ledger_mutation<H: ObservabilityHost>(
    host: &H,
    previous: Option<&StoredRecord>,
    value: &Ledger,
) -> Result<RecordMutation, GatewayError> {
    if !value.valid() {
        return Err(store::error("Sentinel replay budget counter overflow"));
    }
    mutation(host, model::key("budget"), previous, value, None)
}
