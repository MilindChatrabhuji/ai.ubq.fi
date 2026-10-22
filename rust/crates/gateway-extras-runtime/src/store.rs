use crate::types::ExtrasHost;
use gateway_auth::crypto::{sha256_hex, uuid_from_random};
use gateway_core::{
    GatewayError,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::TupleKey,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

pub(crate) fn key(parts: Value) -> RecordKey {
    TupleKey::from_json_parts(parts.as_array().expect("source tuple array"))
        .expect("source scalar tuple")
        .to_record_key()
}
pub(crate) fn invalid_state() -> GatewayError {
    GatewayError::unavailable(
        "Embeddings durable state is invalid.",
        "embeddings_state_invalid",
    )
}
pub(crate) fn invalid(message: impl Into<String>, param: Option<&str>) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error")).with_param(param)
}
pub(crate) fn server(message: impl Into<String>, code: &str) -> GatewayError {
    GatewayError::new(502, message, Some(code))
        .with_type("server_error")
        .with_param(None)
}
pub(crate) fn now<H: ExtrasHost>(host: &H) -> Result<i64, GatewayError> {
    let n = host.now_ms();
    if (0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&n) {
        Ok(n)
    } else {
        Err(invalid_state())
    }
}
pub(crate) fn uuid<H: ExtrasHost>(host: &H) -> Result<String, GatewayError> {
    uuid_from_random(&host.random_bytes(16)?)
}
pub(crate) fn hash(text: &str) -> String {
    sha256_hex(text.as_bytes())
}
pub(crate) fn decoded<T: DeserializeOwned>(
    row: Option<&StoredRecord>,
    at: i64,
) -> Result<Option<T>, GatewayError> {
    let Some(row) = row else { return Ok(None) };
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|x| x <= at) {
        return Ok(None);
    }
    serde_json::from_value(row.json_value()?.clone())
        .map(Some)
        .map_err(|_| invalid_state())
}
pub(crate) fn check(key: &RecordKey, row: Option<&StoredRecord>) -> RevisionCheck {
    RevisionCheck {
        key: key.clone(),
        expected_revision: row.map(|r| r.revision.clone()),
    }
}
pub(crate) fn put<H: ExtrasHost, T: Serialize>(
    host: &H,
    key: RecordKey,
    value: &T,
    expiry: Option<i64>,
) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key,
        record: StoredRecord::json(
            uuid(host)?,
            serde_json::to_value(value).map_err(|_| invalid_state())?,
            expiry,
        ),
    })
}
pub(crate) async fn commit<S: AuthorityStore>(
    store: &S,
    checks: Vec<RevisionCheck>,
    mutations: Vec<RecordMutation>,
) -> Result<bool, GatewayError> {
    Ok(store.commit(AtomicTransition { checks, mutations }).await? == CommitOutcome::Committed)
}
pub(crate) fn retry_seconds(ms: u64) -> u64 {
    ms.div_ceil(1000).max(1)
}
pub(crate) fn cancelled() -> GatewayError {
    GatewayError::new(499, "Request was cancelled.", Some("request_cancelled"))
        .with_type("server_error")
        .with_param(None)
}
pub(crate) fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}

/// Existing source TextEncoder boundary for hashes/encrypted embedding input, not a payload projection.
pub(crate) fn source_utf8(text: &gateway_core::js_string::JsString16) -> String {
    String::from_utf16_lossy(text.as_units())
}
pub(crate) fn hash_source(text: &gateway_core::js_string::JsString16) -> String {
    hash(&source_utf8(text))
}
