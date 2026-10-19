use std::collections::{BTreeMap, BTreeSet};

use gateway_core::GatewayError;
use gateway_core::state::{
    AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
    StoredRecord,
};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::{invalid, text, validate_time};

/// Platform-supplied cryptographically unique opaque tokens. Revisions are never parsed.
/// A reset owner or probe token must remain unpredictable to other callers.
pub trait TokenSource {
    fn next_token(&self) -> Result<String, GatewayError>;
}

/// Time-sensitive authority actions recheck time after awaited reads and before spending.
pub trait AuthorityClock: Send + Sync {
    fn now_ms(&self) -> Result<i64, GatewayError>;
}

pub struct Authority<S, I> {
    pub(crate) store: S,
    pub(crate) tokens: I,
    clock: Option<Box<dyn AuthorityClock>>,
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub fn new(store: S, tokens: I) -> Self {
        Self {
            store,
            tokens,
            clock: None,
        }
    }

    pub fn with_clock(store: S, tokens: I, clock: impl AuthorityClock + 'static) -> Self {
        Self {
            store,
            tokens,
            clock: Some(Box::new(clock)),
        }
    }

    pub(crate) fn fresh_time(&self, started_at: i64) -> Result<i64, GatewayError> {
        let now = self
            .clock
            .as_ref()
            .ok_or_else(|| {
                crate::unavailable(
                    "authority_clock_unavailable",
                    "Time-sensitive authority actions require a trusted current clock.",
                )
            })?
            .now_ms()?;
        validate_time(now)?;
        if now < started_at {
            return Err(crate::unavailable(
                "invalid_clock",
                "Authority clock moved backwards.",
            ));
        }
        Ok(now)
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    pub(crate) fn transaction(&self, now: i64) -> Result<Transaction<'_, S, I>, GatewayError> {
        validate_time(now)?;
        Ok(Transaction {
            store: &self.store,
            tokens: &self.tokens,
            now,
            reads: BTreeMap::new(),
            writes: BTreeMap::new(),
        })
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
    async fn cached_record(
        &mut self,
        key: &RecordKey,
    ) -> Result<Option<&StoredRecord>, GatewayError> {
        if !self.reads.contains_key(&key.0) {
            let record = self.store.read(key).await?;
            if let Some(value) = &record {
                value.validate_version()?;
                text(&value.revision)?;
                if let Some(expiry) = value.expires_at_ms {
                    validate_time(expiry)?;
                }
            }
            self.reads.insert(key.0.clone(), record);
        }
        let raw = self.reads.get(&key.0).and_then(Option::as_ref);
        if raw.is_some_and(|row| row.expires_at_ms.is_some_and(|expiry| expiry <= self.now)) {
            return Ok(None);
        }
        Ok(raw)
    }

    pub async fn read<T: DeserializeOwned>(
        &mut self,
        key: &RecordKey,
    ) -> Result<Option<T>, GatewayError> {
        self.cached_record(key)
            .await?
            .map(|row| {
                serde_json::from_value(row.json_value()?.clone())
                    .map_err(|_| invalid("Malformed authority record."))
            })
            .transpose()
    }

    pub async fn read_claude_quota(
        &mut self,
        account_id: &str,
        cohort_id: &str,
    ) -> Result<Option<serde_json::Value>, GatewayError> {
        let key = crate::keys::claude_quota(account_id, cohort_id);
        self.cached_record(&key)
            .await?
            .map(|row| match row.value_encoding {
                gateway_core::value::ValueEncoding::ProfileV2 => Ok(
                    crate::claude::quota_proof_metadata(&row.profile_v2_value()?),
                ),
                _ => row.json_value().cloned(),
            })
            .transpose()
    }

    pub fn revision(&self, key: &RecordKey) -> Option<String> {
        self.reads
            .get(&key.0)
            .and_then(Option::as_ref)
            .map(|row| row.revision.clone())
    }

    pub fn expiry(&self, key: &RecordKey) -> Option<i64> {
        self.reads
            .get(&key.0)
            .and_then(Option::as_ref)
            .and_then(|row| row.expires_at_ms)
    }

    pub fn expect(&self, key: &RecordKey, revision: &Option<String>) -> bool {
        self.reads.contains_key(&key.0) && &self.revision(key) == revision
    }

    pub fn checks(&self) -> Vec<RevisionCheck> {
        self.reads
            .iter()
            .map(|(key, record)| RevisionCheck {
                key: RecordKey(key.clone()),
                expected_revision: record.as_ref().map(|row| row.revision.clone()),
            })
            .collect()
    }

    pub fn post_checks(&self) -> Vec<RevisionCheck> {
        self.checks()
            .into_iter()
            .map(|mut check| {
                if let Some(mutation) = self.writes.get(&check.key.0) {
                    check.expected_revision = match mutation {
                        RecordMutation::Put { record, .. } => Some(record.revision.clone()),
                        RecordMutation::Delete { .. } => None,
                    };
                }
                check
            })
            .collect()
    }

    pub fn put<T: Serialize>(
        &mut self,
        key: &RecordKey,
        value: &T,
        expiry: Option<i64>,
    ) -> Result<(), GatewayError> {
        if !self.reads.contains_key(&key.0) {
            return Err(invalid(
                "A mutation is missing its strong-read precondition.",
            ));
        }
        if let Some(expiry) = expiry {
            validate_time(expiry)?;
        }
        let revision = self.tokens.next_token()?;
        text(&revision)?;
        if self
            .reads
            .values()
            .flatten()
            .any(|row| row.revision == revision)
        {
            return Err(invalid("Token source reused an existing revision."));
        }
        let record = StoredRecord::json(
            revision,
            serde_json::to_value(value).map_err(|_| invalid("Authority serialization failed."))?,
            expiry,
        );
        self.writes.insert(
            key.0.clone(),
            RecordMutation::Put {
                key: key.clone(),
                record,
            },
        );
        Ok(())
    }

    pub fn delete(&mut self, key: &RecordKey) -> Result<(), GatewayError> {
        if !self.reads.contains_key(&key.0) {
            return Err(invalid(
                "A deletion is missing its strong-read precondition.",
            ));
        }
        self.writes
            .insert(key.0.clone(), RecordMutation::Delete { key: key.clone() });
        Ok(())
    }

    pub async fn commit(self) -> Result<bool, GatewayError> {
        let checks = self.checks();
        let mut revisions = BTreeSet::new();
        for mutation in self.writes.values() {
            if let RecordMutation::Put { record, .. } = mutation
                && !revisions.insert(record.revision.clone())
            {
                return Err(invalid("Token source duplicated a mutation revision."));
            }
        }
        Ok(self
            .store
            .commit(AtomicTransition {
                checks,
                mutations: self.writes.into_values().collect(),
            })
            .await?
            == CommitOutcome::Committed)
    }
}
