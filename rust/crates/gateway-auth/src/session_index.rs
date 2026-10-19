//! Private source-session revision metadata, never a bearer or authorization proof.
use gateway_core::state::{AuthorityStore, RecordKey, StoredRecord};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{GatewayError, crypto::sha256_hex, passkeys::PasskeySession, store};

pub const SESSION_DIGEST_DOMAIN: &[u8] = b"uos_ai:auth:session_revision_index:v1\0";

/// Call only with the exact source session token selected by authentication or creation.
/// A digest is a selector, not permission to act for the selected session.
pub fn digest(token: &str) -> String {
    let mut bytes = Vec::with_capacity(SESSION_DIGEST_DOMAIN.len() + token.len());
    bytes.extend_from_slice(SESSION_DIGEST_DOMAIN);
    bytes.extend_from_slice(token.as_bytes());
    sha256_hex(&bytes)
}

pub fn index_key(session_digest: &str) -> Result<RecordKey, GatewayError> {
    if session_digest.len() != 64
        || !session_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid());
    }
    Ok(store::key(json!([
        "uos_ai",
        "auth",
        "session_revision_index",
        "v1",
        session_digest
    ])))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionRevisionFence {
    pub v: u32,
    pub session_digest: String,
    pub user_id: String,
    pub session_revision: String,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionIndexSnapshot {
    pub fence: SessionRevisionFence,
    pub revision: String,
}

fn validate(fence: &SessionRevisionFence) -> Result<(), GatewayError> {
    index_key(&fence.session_digest)?;
    if fence.v != 1 || fence.user_id.trim().is_empty() || fence.session_revision.trim().is_empty() {
        return Err(invalid());
    }
    Ok(())
}

/// Data-only validation of one exact stored custody row, including expired data.
/// This does not check currentness, read a store, authenticate or mint a permission.
pub fn validate_custody_record(key: &RecordKey, record: &StoredRecord) -> Result<(), GatewayError> {
    record.validate_version()?;
    let value = record.json_value()?;
    let fence: SessionRevisionFence =
        serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    validate(&fence)?;
    if serde_json::to_value(&fence).map_err(|_| invalid())? != *value
        || *key != index_key(&fence.session_digest)?
        || record.revision != fence.session_revision
        || record.expires_at_ms != Some(fence.expires_at_ms)
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&fence.expires_at_ms)
    {
        return Err(invalid());
    }
    Ok(())
}

/// Data-only constructor for source creation and controlled migration. Publish it in the
/// same atomic transition as the source session; this function grants no authorization.
pub fn record_for_session(
    session: &PasskeySession,
    session_revision: &str,
    source_expires_at_ms: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    if session.token.is_empty() {
        return Err(invalid());
    }
    let expires_at_ms = source_expires_at_ms.map_or(session.expires_at_ms, |expiry| {
        expiry.min(session.expires_at_ms)
    });
    let fence = SessionRevisionFence {
        v: 1,
        session_digest: digest(&session.token),
        user_id: session.user_id.clone(),
        session_revision: session_revision.into(),
        expires_at_ms,
    };
    validate(&fence)?;
    let value = serde_json::to_value(fence).map_err(|_| invalid())?;
    Ok(StoredRecord::json(
        session_revision,
        value,
        Some(expires_at_ms),
    ))
}

/// Strong source facts at the supplied time, not an authentication capability.
/// Callers must recheck their authoritative clock after awaits and include the
/// returned index revision plus current user revision in their final CAS.
pub async fn read_current<S: AuthorityStore>(
    store: &S,
    session_digest: &str,
    now_ms: i64,
) -> Result<Option<SessionIndexSnapshot>, GatewayError> {
    let key = index_key(session_digest)?;
    let Some(record) = store.read(&key).await? else {
        return Ok(None);
    };
    validate_custody_record(&key, &record)?;
    let fence: SessionRevisionFence =
        serde_json::from_value(record.json_value()?.clone()).map_err(|_| invalid())?;
    if fence.expires_at_ms <= now_ms {
        return Ok(None);
    }
    Ok(Some(SessionIndexSnapshot {
        fence,
        revision: record.revision,
    }))
}

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "The current-session revision index is missing required metadata or is malformed.",
        "session_index_invalid",
    )
}
