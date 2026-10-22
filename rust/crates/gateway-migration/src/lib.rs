//! Offline reversible source-state adoption through the one existing authority.
//! This library neither opens a source VM database nor grants runtime/publication ownership.
mod capture;
#[cfg(all(unix, not(target_arch = "wasm32")))]
mod core_state;
mod engine;
mod error;
pub mod graph_transport;
mod graph_tree;
mod indexes;
mod initial_owner;
mod inverse;
mod native_capture;
mod native_custody;
#[cfg(all(unix, not(target_arch = "wasm32")))]
mod native_history_reconcile;
mod native_inverse;
#[cfg(all(unix, not(target_arch = "wasm32")))]
mod native_latest;
#[cfg(all(unix, not(target_arch = "wasm32")))]
pub mod native_operator;
#[cfg(all(unix, not(target_arch = "wasm32")))]
mod native_spool;
#[cfg(all(unix, not(target_arch = "wasm32")))]
pub mod native_stage;
pub mod operational;
mod paid_controls;
mod profile_bindings;
mod profile_coupling;
mod profile_reset;
pub mod profile_runtime;
mod profile_validate;
mod projection;
mod rollup_source;
mod source_metadata;
pub mod staged;

pub use capture::{PrivateCapture, SourceEntry};
#[cfg(all(unix, not(target_arch = "wasm32")))]
pub use core_state::{
    CORE_STATE_DO_ROW_WRITE_LIMIT, CoreStateCapture, CoreStateManifest, CoreStateRuleCount,
};
pub use engine::{
    AdoptionReceipt, PreparedAdoption, adopt_empty, adopt_empty_with_initial_control_owner, prepare,
};
pub use error::MigrationError;
pub use gateway_admin_data::profile::{CanonicalDates, SourceDateHost};
pub use initial_owner::InitialControlOwnerAdoptionReceipt;
pub use inverse::{
    ArtifactContext, CustodyRecord, PrivateRollbackBundle, export_latest, export_rollback_bundle,
};
pub use native_capture::{NativeCapture, NativeEntry, NativeRevision, NativeValue, prepare_native};
pub use native_custody::{
    LocalNativeCapture, LocalNativeRollbackBundle, NativeCustody, OwnedNativeSnapshot,
    export_native_rollback_with_custody, export_native_with_custody, prepare_native_with_custody,
    sanitize_native_capture,
};
pub use native_inverse::{
    NativeRollbackBundle, export_native_latest, export_native_rollback_bundle,
};
pub use projection::known_source_family;

use gateway_core::source_json::SourceJson;
use gateway_core::{
    GatewayError,
    state::{RecordKey, StoredRecord},
    tuple_key::TupleKey,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Transform {
    Identity,
    CatalogBytes,
    ApiWindow,
    ApiRequest,
    KernelWindow,
    KernelRequest,
    PaidRequest,
    PaidPending,
    PaidGate,
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Mapping {
    #[serde(with = "source_storage")]
    source: SourceEntry,
    // Only non-secret transformed source rows need an original value sidecar.
    transform: Transform,
    baseline_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_origin: Option<native_capture::NativeOrigin>,
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Row {
    #[serde(with = "crate::staged::record_key_wire")]
    key: RecordKey,
    parts: Vec<Value>,
    record: StoredRecord,
    mapping: Mapping,
}
fn invalid(message: impl Into<String>) -> GatewayError {
    GatewayError::new(409, message, Some("migration_state_invalid"))
}
fn unavailable(message: impl Into<String>) -> GatewayError {
    GatewayError::unavailable(message, "migration_schema_unavailable")
}
fn key(parts: Value) -> RecordKey {
    gateway_auth::store::key(parts)
}
fn starts(parts: &[Value], prefix: &[&str]) -> bool {
    parts.len() >= prefix.len()
        && parts
            .iter()
            .zip(prefix)
            .all(|(a, b)| a.as_str() == Some(*b))
}
fn private_source_key(p: &[Value]) -> bool {
    starts(p, &["uos_ai", "migration"])
        || starts(p, &["uos_ai", "authority"])
        || starts(p, &["uos_ai", "auth", "session_revision_index"])
        || starts(p, &["uos_ai", "native_live"])
        || starts(p, &["uos_ai", "routing_runtime"])
        || starts(
            p,
            &["uos_ai", "codex_live_calls", "v1", "pending_retirement"],
        )
}
fn digest(record: &StoredRecord) -> Result<String, GatewayError> {
    Ok(gateway_auth::crypto::sha256_hex(
        &serde_json::to_vec(record).map_err(|_| invalid("Record cannot be encoded"))?,
    ))
}
fn json<T: Serialize>(value: &T) -> Result<Value, GatewayError> {
    serde_json::to_value(value).map_err(|_| invalid("State schema cannot be encoded"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, GatewayError> {
    serde_json::from_value(value.clone())
        .map_err(|_| invalid("Source state does not match its explicit schema"))
}
fn parts(key: &RecordKey) -> Result<Vec<Value>, GatewayError> {
    use gateway_core::tuple_key::DecodedKeyPart;
    TupleKey::from_record_key(key)?
        .decoded_parts()?
        .into_iter()
        .map(|part| match part {
            DecodedKeyPart::String(v) => Ok(match String::from_utf8(v) {
                Ok(value) => Value::String(value),
                Err(error) => serde_json::json!({"native_string_bytes":error.into_bytes()}),
            }),
            DecodedKeyPart::Number(v) if v.is_finite() => {
                let v = if v == 0.0 { 0.0 } else { v };
                gateway_core::value::PortableValue::number(v)
                    .to_json_lossless()
                    .ok_or_else(|| invalid("Finite source key number cannot be projected"))
            }
            DecodedKeyPart::Boolean(v) => Ok(Value::Bool(v)),
            DecodedKeyPart::Bytes(bytes)=>Ok(serde_json::json!({"type":"Uint8Array","value":gateway_admin_data::profile::encode_base64(&bytes)})),
            DecodedKeyPart::BigInt{negative,magnitude}=>Ok(serde_json::json!({"type":"bigint","value":crate::inverse::decimal_key(negative,&magnitude)})),
            DecodedKeyPart::Number(value)=>Ok(serde_json::json!({"type":"number","value":if value.is_nan(){"NaN"}else if value.is_sign_negative(){"-Infinity"}else{"Infinity"}})),
        })
        .collect()
}

// Private metadata stores source JSON as an explicit raw document string. It never
// treats a surrogate as scalar text or reinterprets a source object as codec tags.
mod source_storage {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        entry: &SourceEntry,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let raw = serde_json::to_string(entry).map_err(serde::ser::Error::custom)?;
        serializer.serialize_str(&raw)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<SourceEntry, D::Error> {
        let raw = String::deserialize(deserializer)?;
        serde_json::from_str(&raw).map_err(serde::de::Error::custom)
    }
}
