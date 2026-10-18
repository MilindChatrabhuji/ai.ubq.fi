//! Offline reversible source-state adoption through the one existing authority.
//! This library neither opens a source VM database nor grants runtime/publication ownership.
mod capture;
mod engine;
mod inverse;
mod projection;
mod indexes;
mod routing;

pub use capture::{PrivateCapture, SourceEntry};
pub use engine::{AdoptionReceipt, adopt_empty, prepare, PreparedAdoption};
pub use inverse::export_latest;
pub use gateway_admin_data::profile::{CanonicalDates, SourceDateHost};

use gateway_core::{GatewayError, state::{RecordKey, StoredRecord}, tuple_key::TupleKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all="snake_case")]
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
    Routing,
    Capacity,
}
#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Mapping {
    source: SourceEntry,
    // Only non-secret transformed source rows need an original value sidecar.
    transform: Transform,
    baseline_digest: String,
}
#[derive(Clone)]
pub(crate) struct Row {
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
fn key(parts: Value) -> RecordKey { gateway_auth::store::key(parts) }
fn starts(parts: &[Value], prefix: &[&str]) -> bool {
    parts.len()>=prefix.len() && parts.iter().zip(prefix).all(|(a,b)|a.as_str()==Some(*b))
}
fn digest(record: &StoredRecord) -> Result<String, GatewayError> {
    Ok(gateway_auth::crypto::sha256_hex(&serde_json::to_vec(record).map_err(|_|invalid("Record cannot be encoded"))?))
}
fn json<T: Serialize>(value: &T) -> Result<Value, GatewayError> {
    serde_json::to_value(value).map_err(|_|invalid("State schema cannot be encoded"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, GatewayError> {
    serde_json::from_value(value.clone()).map_err(|_|invalid("Source state does not match its explicit schema"))
}
fn parts(key: &RecordKey) -> Result<Vec<Value>, GatewayError> {
    use gateway_core::tuple_key::DecodedKeyPart;
    TupleKey::from_record_key(key)?.decoded_parts()?.into_iter().map(|part|match part {
        DecodedKeyPart::String(v)=>String::from_utf8(v).map(Value::String).map_err(|_|unavailable("Non-UTF8 source application keys require exact opaque export")),
        DecodedKeyPart::Number(v) if v.is_finite()=>Ok(serde_json::json!(v)),
        DecodedKeyPart::Boolean(v)=>Ok(Value::Bool(v)),
        _=>Err(unavailable("A new non-scalar application key requires its original typed mapping")),
    }).collect()
}
