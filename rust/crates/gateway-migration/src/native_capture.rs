//! Closed native interchange; no runtime VM bytes or source database are opened here.
use crate::*;
use gateway_core::{
    source_graph::SourceGraph,
    value::{PortableValue, ValueEncoding},
};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRevision {
    /// Decimal SQLite integers remain strings across the JavaScript boundary.
    pub version: String,
    pub sequence: String,
}
impl NativeRevision {
    pub(crate) fn numbers(&self) -> Result<(i64, i64), GatewayError> {
        fn number(value: &str) -> Result<i64, GatewayError> {
            let number = value
                .parse::<i64>()
                .map_err(|_| invalid("Native revision is not an SQLite integer"))?;
            if number < 0 || number.to_string() != value {
                return Err(invalid("Native revision is not canonical"));
            }
            Ok(number)
        }
        Ok((number(&self.version)?, number(&self.sequence)?))
    }
    pub(crate) fn record_revision(&self) -> Result<String, GatewayError> {
        self.numbers()?;
        Ok(format!("native-v1:{}:{}", self.version, self.sequence))
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "encoding",
    content = "value",
    rename_all = "kebab-case",
    deny_unknown_fields
)]
pub enum NativeValue {
    SourceGraphV1(SourceJson),
    /// Native v_encoding=2, exactly eight little-endian bytes.
    CounterLe64(Vec<u8>),
    /// Native v_encoding=3; this is a byte payload, not a JSC/V8 document.
    Bytes(Vec<u8>),
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeEntry {
    pub raw_key: Vec<u8>,
    pub value: NativeValue,
    pub revision: NativeRevision,
    /// Exact SQLite source expiration, with -1 meaning no expiry.
    pub expiration_ms: i64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeCapture {
    pub v: u32,
    pub source_git_sha: String,
    pub captured_at_ms: i64,
    pub source_codec: String,
    pub native_schema_version: u32,
    pub data_revision: NativeRevision,
    pub queue_entries: u64,
    pub running_queue_entries: u64,
    pub entries: Vec<NativeEntry>,
}
impl std::fmt::Debug for NativeCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeCapture")
            .field("entries", &self.entries.len())
            .field("values", &"[private]")
            .finish()
    }
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeKind {
    Graph,
    Counter,
    Bytes,
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct NativeOrigin {
    pub kind: NativeKind,
    pub revision: NativeRevision,
}

pub(crate) fn tree_record(
    value: PortableValue,
    revision: &str,
    expiry: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    if let Some(value) = value.to_json_lossless() {
        Ok(StoredRecord::json(revision, value, expiry))
    } else if value.validate_for_storage().is_ok() {
        StoredRecord::profile(revision, value, expiry)
    } else {
        StoredRecord::profile_v2(revision, value, expiry)
    }
}
fn graph_record(
    graph: SourceGraph,
    p: &[Value],
    revision: &str,
    expiry: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    // Retained data stays a graph even when this particular value is a tree, so
    // post-adoption writes cannot erase supported identity or backing coordinates.
    let generic = p
        .first()
        .and_then(Value::as_str)
        .is_some_and(|v| ["default", "key", "agent_messages", "embeddings"].contains(&v));
    let kernel_default = p.first().and_then(Value::as_str) == Some("default")
        && p.get(1).and_then(Value::as_str).is_some_and(|v| {
            ["kernel_policy_limit_requests", "kernel_policy_window_ms"].contains(&v)
        });
    if generic && !kernel_default {
        return StoredRecord::source_graph(revision, graph, expiry);
    }
    let value = graph
        .try_identity_free_tree()?
        .ok_or_else(|| unavailable("This business schema has no graph-aware runtime binding"))?;
    let mut record = tree_record(value, revision, expiry)?;
    if crate::projection::quota_family(p) && record.value_encoding != ValueEncoding::Json {
        record.value_encoding = ValueEncoding::ProfileV2;
    }
    Ok(record)
}
impl NativeCapture {
    pub(crate) fn validate(&self) -> Result<Vec<Row>, GatewayError> {
        let version = self.validate_header()?;
        let mut seen = BTreeSet::new();
        self.entries
            .iter()
            .map(|entry| {
                let key = TupleKey::from_sort_bytes(entry.raw_key.clone())?.to_record_key();
                if !seen.insert(key.0) {
                    return Err(invalid(
                        "Native source key is duplicated or attempts to mint private state",
                    ));
                }
                validate_entry(entry, version)
            })
            .collect()
    }
    pub(crate) fn validate_header(&self) -> Result<i64, GatewayError> {
        if self.v != 2
            || self.source_codec != "bun-jsc-v1"
            || self.native_schema_version != 3
            || self.queue_entries != 0
            || self.running_queue_entries != 0
            || self.source_git_sha.len() != 40
            || !self
                .source_git_sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&self.captured_at_ms)
        {
            return Err(invalid(
                "Native capture source, schema, queues or clock is unsupported",
            ));
        }
        let (version, _) = self.data_revision.numbers()?;
        Ok(version)
    }
}
pub(crate) fn validate_entry(entry: &NativeEntry, version: i64) -> Result<Row, GatewayError> {
    let tuple = TupleKey::from_sort_bytes(entry.raw_key.clone())?;
    tuple.validate_stored_key()?;
    let key = tuple.to_record_key();
    let p = parts(&key)?;
    if private_source_key(&p) {
        return Err(invalid(
            "Native source key is duplicated or attempts to mint private state",
        ));
    }
    if entry.revision.numbers()?.0 > version || entry.expiration_ms < -1 {
        return Err(invalid(
            "Native row revision or absolute expiration is invalid",
        ));
    }
    let revision = entry.revision.record_revision()?;
    let expiry = (entry.expiration_ms != -1).then_some(entry.expiration_ms);
    let (record, kind) = match &entry.value {
        NativeValue::SourceGraphV1(value) => (
            graph_record(
                crate::graph_transport::from_source_graph(value)?,
                &p,
                &revision,
                expiry,
            )?,
            NativeKind::Graph,
        ),
        NativeValue::CounterLe64(bytes) => {
            let bytes: [u8; 8] = bytes
                .as_slice()
                .try_into()
                .map_err(|_| invalid("Native counter must contain exactly eight bytes"))?;
            (
                StoredRecord::profile(
                    &revision,
                    PortableValue::KvU64(u64::from_le_bytes(bytes).to_string()),
                    expiry,
                )?,
                NativeKind::Counter,
            )
        }
        NativeValue::Bytes(bytes) => {
            let record = StoredRecord::profile(
                &revision,
                PortableValue::Binary {
                    kind: "Uint8Array".into(),
                    bytes: bytes.clone(),
                    byte_offset: 0,
                    byte_length: bytes.len() as u64,
                },
                expiry,
            )?;
            (record, NativeKind::Bytes)
        }
    };
    let source_value = if record.value_encoding == ValueEncoding::SourceGraphV1 {
        SourceJson::parse("null")?
    } else {
        gateway_admin_data::profile::to_source_profile(&record.portable_value()?)?
    };
    Ok(Row {
        key,
        parts: p,
        record,
        mapping: Mapping {
            source: SourceEntry {
                key: vec![],
                value: source_value,
                versionstamp: revision,
                expires_at_ms: expiry,
            },
            transform: Transform::Identity,
            baseline_digest: String::new(),
            native_origin: Some(NativeOrigin {
                kind,
                revision: entry.revision.clone(),
            }),
        },
    })
}
pub fn prepare_native(capture: &NativeCapture) -> Result<PreparedAdoption, MigrationError> {
    let id = gateway_auth::crypto::sha256_hex(
        &serde_json::to_vec(capture).map_err(|_| invalid("Native capture cannot be encoded"))?,
    );
    crate::engine::prepare_rows(
        capture.validate()?,
        id,
        &capture.source_git_sha,
        capture.captured_at_ms,
        Some(capture.data_revision.clone()),
    )
}
