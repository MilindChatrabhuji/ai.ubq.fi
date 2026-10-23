use gateway_core::{
    GatewayError,
    query::{QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
};
use gateway_observability::types::ObservabilityHost;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    pin::pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

pub fn run<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("fixture unexpectedly pending"),
    }
}
#[derive(Clone, Default)]
pub struct Memory {
    pub rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    pub reads: Rc<Cell<usize>>,
    pub commits: Rc<Cell<usize>>,
    pub conflicts: Rc<Cell<usize>>,
    pub unavailable: Rc<Cell<bool>>,
    pub pause: Rc<Cell<bool>>,
}
impl AuthorityStore for Memory {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        std::future::poll_fn(|_| {
            if self.pause.get() {
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        })
        .await;
        self.reads.set(self.reads.get() + 1);
        if self.unavailable.get() {
            return Err(GatewayError::unavailable(
                "fixture unavailable",
                "fixture_unavailable",
            ));
        }
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut checks = std::collections::BTreeSet::new();
        if transition
            .checks
            .iter()
            .any(|check| !checks.insert(check.key.0.clone()))
        {
            return Err(GatewayError::unavailable(
                "Fixture rejects duplicate checks like the actual Worker store",
                "fixture_invalid_transition",
            ));
        }
        let mut writes = std::collections::BTreeSet::new();
        if transition.mutations.iter().any(|mutation| {
            let key = match mutation {
                RecordMutation::Put { key, .. } | RecordMutation::Delete { key } => key,
            };
            !writes.insert(key.0.clone())
        }) {
            return Err(GatewayError::unavailable(
                "Fixture requires one final mutation per key like the actual Worker store",
                "fixture_invalid_transition",
            ));
        }
        std::future::poll_fn(|_| {
            if self.pause.get() {
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        })
        .await;
        self.commits.set(self.commits.get() + 1);
        if self.unavailable.get() {
            return Err(GatewayError::unavailable(
                "fixture unavailable",
                "fixture_unavailable",
            ));
        }
        if self.conflicts.get() > 0 {
            self.conflicts.set(self.conflicts.get() - 1);
            return Ok(CommitOutcome::Conflict);
        }
        let mut rows = self.rows.borrow_mut();
        if transition
            .checks
            .iter()
            .any(|c| rows.get(&c.key.0).map(|r| &r.revision) != c.expected_revision.as_ref())
        {
            return Ok(CommitOutcome::Conflict);
        }
        for mutation in transition.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    record.validate_version()?;
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
impl QueryStore for Memory {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        if self.unavailable.get() {
            return Err(GatewayError::unavailable(
                "fixture unavailable",
                "fixture_unavailable",
            ));
        }
        let validated = request.validate()?;
        let mut entries = Vec::new();
        for (key, record) in self.rows.borrow().iter() {
            let key = RecordKey(key.clone());
            if validated.accepts_record(&key, record)? {
                entries.push(gateway_core::query::QueryEntry {
                    key,
                    record: record.clone(),
                })
            }
        }
        if request.reverse {
            entries.reverse()
        }
        let more = entries.len() > request.limit as usize;
        entries.truncate(request.limit as usize);
        let next_cursor = if more {
            entries
                .last()
                .map(|entry| validated.cursor_after(&entry.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}
#[derive(Clone, Default)]
pub struct Host {
    pub at: Rc<Cell<i64>>,
    counter: Rc<Cell<u64>>,
}
// Non-comparison fixture only: unexpected source ordering must fail, never guess.
struct MissingSourceCollator;
impl gateway_schema::aliases::SourceStringCollator for MissingSourceCollator {
    fn compare(
        &self,
        _left: &gateway_core::js_string::JsString16,
        _right: &gateway_core::js_string::JsString16,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture has no captured source ordering.",
            "fixture_collation_missing",
        ))
    }
}
impl ObservabilityHost for Host {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        std::sync::Arc::new(MissingSourceCollator)
    }
    fn now_ms(&self) -> i64 {
        self.at.get()
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        let next = self.counter.get() + 1;
        self.counter.set(next);
        let mut bytes = vec![0; length];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (next.rotate_right((i as u32 % 8) * 8) & 255) as u8
        }
        Ok(bytes)
    }
    async fn wait_ms(&self, milliseconds: u32) -> Result<(), GatewayError> {
        self.at.set(self.at.get() + i64::from(milliseconds));
        Ok(())
    }
}
