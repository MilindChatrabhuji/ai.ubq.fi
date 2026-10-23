use crate::input::NOW;
use gateway_authority::{AuthorityClock, TokenSource};
use gateway_core::{
    GatewayError,
    query::{QueryEntry, QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::TupleKey,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};
#[derive(Clone)]
pub struct Store {
    pub(crate) rows: Arc<Mutex<BTreeMap<String, StoredRecord>>>,
    now: Arc<AtomicI64>,
    sequence: Arc<AtomicU64>,
}
impl Default for Store {
    fn default() -> Self {
        Self::new()
    }
}
impl Store {
    pub fn new() -> Self {
        Self {
            rows: Arc::new(Mutex::new(BTreeMap::new())),
            now: Arc::new(AtomicI64::new(NOW)),
            sequence: Arc::new(AtomicU64::new(1)),
        }
    }
    pub fn seed<T: Serialize>(&self, key: RecordKey, value: T) {
        let revision = self.next_token().unwrap();
        self.rows.lock().unwrap().insert(
            key.0,
            StoredRecord::json(revision, serde_json::to_value(value).unwrap(), None),
        );
    }
    pub fn value(&self, key: RecordKey) -> Value {
        self.rows
            .lock()
            .unwrap()
            .get(&key.0)
            .map(|r| r.json_value().unwrap().clone())
            .unwrap_or(Value::Null)
    }
    pub fn advance(&self, by: i64) {
        self.now.fetch_add(by, Ordering::SeqCst);
    }
}
impl AuthorityClock for Store {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(self.now.load(Ordering::SeqCst))
    }
}
impl TokenSource for Store {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "fixture-{}",
            self.sequence.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        TupleKey::from_record_key(key)?.validate_stored_key()?;
        Ok(self
            .rows
            .lock()
            .unwrap()
            .get(&key.0)
            .filter(|r| {
                r.expires_at_ms
                    .is_none_or(|e| e > self.now.load(Ordering::SeqCst))
            })
            .cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut rows = self.rows.lock().unwrap();
        let now = self.now.load(Ordering::SeqCst);
        let mut checks = BTreeSet::new();
        for check in transition.checks {
            assert!(checks.insert(check.key.0.clone()), "duplicate CAS key");
            if rows
                .get(&check.key.0)
                .filter(|r| r.expires_at_ms.is_none_or(|e| e > now))
                .map(|r| r.revision.clone())
                != check.expected_revision
            {
                return Ok(CommitOutcome::Conflict);
            }
        }
        let mut keys = BTreeSet::new();
        for mutation in &transition.mutations {
            let key = match mutation {
                RecordMutation::Put { key, record } => {
                    record.validate_version()?;
                    key
                }
                RecordMutation::Delete { key } => key,
            };
            TupleKey::from_record_key(key)?.validate_stored_key()?;
            assert!(keys.insert(key.0.clone()), "duplicate mutation");
        }
        for mutation in transition.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        Ok(CommitOutcome::Committed)
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let query = request.validate()?;
        let mut rows: Vec<_> = self
            .rows
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| QueryEntry {
                key: RecordKey(k.clone()),
                record: v.clone(),
            })
            .collect();
        rows.sort_by_key(|r| {
            TupleKey::from_record_key(&r.key)
                .unwrap()
                .sort_bytes()
                .to_vec()
        });
        if request.reverse {
            rows.reverse();
        }
        let mut accepted = vec![];
        for row in rows {
            if query.accepts_record(&row.key, &row.record)? {
                accepted.push(row);
            }
        }
        let more = accepted.len() > request.limit as usize;
        accepted.truncate(request.limit as usize);
        let next_cursor = if more {
            accepted
                .last()
                .map(|r| query.cursor_after(&r.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries: accepted,
            next_cursor,
        })
    }
}
