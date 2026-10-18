use std::collections::{BTreeMap, BTreeSet};

use gateway_core::GatewayError;
use gateway_core::state::{AtomicTransition, AuthorityStore, CommitOutcome, PORTABLE_STATE_VERSION, RecordKey, RecordMutation, RevisionCheck, StoredRecord};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::{invalid, text, validate_time};

/// Platform-supplied cryptographically unique opaque tokens. Revisions are never parsed.
/// A reset owner or probe token must remain unpredictable to other callers.
pub trait TokenSource {
    fn next_token(&self) -> Result<String, GatewayError>;
}

pub struct Authority<S, I> {
    pub(crate) store: S,
    pub(crate) tokens: I,
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub fn new(store: S, tokens: I) -> Self { Self { store, tokens } }

    pub fn store(&self) -> &S { &self.store }

    pub(crate) fn transaction(&self, now: i64) -> Result<Transaction<'_, S, I>, GatewayError> {
        validate_time(now)?;
        Ok(Transaction { store: &self.store, tokens: &self.tokens, now, reads: BTreeMap::new(), writes: BTreeMap::new() })
    }
}

pub(crate) struct Transaction<'a, S, I> {
    store: &'a S,
    tokens: &'a I,
    pub now: i64,
    reads: BTreeMap<String, Option<StoredRecord>>,
    writes: BTreeMap<String, RecordMutation>,
}

impl<S: AuthorityStore, I: TokenSource> Transaction<'_, S, I> {
    pub async fn read<T: DeserializeOwned>(&mut self, key: &RecordKey) -> Result<Option<T>, GatewayError> {
        if !self.reads.contains_key(&key.0) {
            let record = self.store.read(key).await?;
            if let Some(value) = &record {
                value.validate_version()?;
                text(&value.revision)?;
                if let Some(expiry) = value.expires_at_ms { validate_time(expiry)?; }
            }
            self.reads.insert(key.0.clone(), record);
        }
        let raw = self.reads.get(&key.0).and_then(Option::as_ref);
        if raw.is_some_and(|row| row.expires_at_ms.is_some_and(|expiry| expiry <= self.now)) { return Ok(None); }
        raw.map(|row| serde_json::from_value(row.value.clone()).map_err(|_| invalid("Malformed authority record."))).transpose()
    }

    pub fn revision(&self, key: &RecordKey) -> Option<String> {
        self.reads.get(&key.0).and_then(Option::as_ref).map(|row| row.revision.clone())
    }

    pub fn expect(&self, key: &RecordKey, revision: &Option<String>) -> bool {
        self.reads.contains_key(&key.0) && &self.revision(key) == revision
    }

    pub fn checks(&self) -> Vec<RevisionCheck> {
        self.reads.iter().map(|(key, record)| RevisionCheck { key: RecordKey(key.clone()), expected_revision: record.as_ref().map(|row| row.revision.clone()) }).collect()
    }

    pub fn post_checks(&self) -> Vec<RevisionCheck> {
        self.checks().into_iter().map(|mut check| {
            if let Some(mutation) = self.writes.get(&check.key.0) {
                check.expected_revision = match mutation { RecordMutation::Put { record, .. } => Some(record.revision.clone()), RecordMutation::Delete { .. } => None };
            }
            check
        }).collect()
    }

    pub fn put<T: Serialize>(&mut self, key: &RecordKey, value: &T, expiry: Option<i64>) -> Result<(), GatewayError> {
        if !self.reads.contains_key(&key.0) { return Err(invalid("A mutation is missing its strong-read precondition.")); }
        if let Some(expiry) = expiry { validate_time(expiry)?; }
        let revision = self.tokens.next_token()?;
        text(&revision)?;
        if self.reads.values().flatten().any(|row| row.revision == revision) { return Err(invalid("Token source reused an existing revision.")); }
        let record = StoredRecord { schema_version: PORTABLE_STATE_VERSION, revision, value: serde_json::to_value(value).map_err(|_| invalid("Authority serialization failed."))?, expires_at_ms: expiry };
        self.writes.insert(key.0.clone(), RecordMutation::Put { key: key.clone(), record });
        Ok(())
    }

    pub fn delete(&mut self, key: &RecordKey) -> Result<(), GatewayError> {
        if !self.reads.contains_key(&key.0) { return Err(invalid("A deletion is missing its strong-read precondition.")); }
        self.writes.insert(key.0.clone(), RecordMutation::Delete { key: key.clone() });
        Ok(())
    }

    pub async fn commit(self) -> Result<bool, GatewayError> {
        let checks = self.checks();
        let mut revisions = BTreeSet::new();
        for mutation in self.writes.values() {
            if let RecordMutation::Put { record, .. } = mutation {
                if !revisions.insert(record.revision.clone()) { return Err(invalid("Token source duplicated a mutation revision.")); }
            }
        }
        Ok(self.store.commit(AtomicTransition { checks, mutations: self.writes.into_values().collect() }).await? == CommitOutcome::Committed)
    }
}
