use gateway_core::state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck, StoredRecord, PORTABLE_STATE_VERSION};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::GatewayError;

pub fn key(parts: Value) -> RecordKey { RecordKey(parts.to_string()) }

pub fn decode<T: DeserializeOwned>(record: Option<&StoredRecord>, now: i64) -> Result<Option<T>, GatewayError> {
    let Some(record) = record else { return Ok(None); };
    record.validate_version()?;
    if record.expires_at_ms.is_some_and(|expiry| expiry <= now) { return Ok(None); }
    serde_json::from_value(record.value.clone()).map(Some).map_err(|_| GatewayError::unavailable("Authentication state is corrupt", "auth_state_corrupt"))
}

pub fn check(key: &RecordKey, record: Option<&StoredRecord>) -> RevisionCheck {
    RevisionCheck { key: key.clone(), expected_revision: record.map(|row| row.revision.clone()) }
}

pub fn put<T: Serialize>(key: RecordKey, value: &T, expiry: Option<i64>, revision: &str) -> Result<RecordMutation, GatewayError> {
    let value = serde_json::to_value(value).map_err(|_| GatewayError::unavailable("Authentication state cannot be encoded", "auth_state_corrupt"))?;
    Ok(RecordMutation::Put { key, record: StoredRecord { schema_version: PORTABLE_STATE_VERSION, revision: revision.to_owned(), value, expires_at_ms: expiry } })
}

pub async fn commit<S: AuthorityStore>(store: &S, checks: Vec<RevisionCheck>, mutations: Vec<RecordMutation>) -> Result<bool, GatewayError> {
    Ok(store.commit(AtomicTransition { checks, mutations }).await? == CommitOutcome::Committed)
}
