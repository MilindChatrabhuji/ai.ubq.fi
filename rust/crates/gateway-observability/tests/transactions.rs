mod support;
use gateway_core::{
    GatewayError,
    lifecycle::DeliveryOutcome,
    query::{QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::TupleKey,
};
use gateway_observability::{
    ObservabilityRuntime,
    ledger::ErrorObservation,
    types::{HealthEvent, HealthProvider, HealthTarget, HealthWrite},
};
use std::{cell::Cell, rc::Rc};
use support::{Host, Memory, run};
#[derive(Clone, Copy)]
enum Race {
    Destination,
    Source,
    Unknown,
}
#[derive(Clone)]
struct Store {
    memory: Memory,
    mode: Race,
    first: Rc<Cell<bool>>,
    attempts: Rc<Cell<u32>>,
    source: RecordKey,
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.memory.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.attempts.set(self.attempts.get() + 1);
        if self.first.replace(false) {
            match self.mode {
                Race::Destination => {
                    assert!(transition.checks.is_empty());
                    let RecordMutation::Put { key, record } = transition.mutations.first().unwrap()
                    else {
                        panic!("source error write")
                    };
                    let mut raced = record.clone();
                    raced.revision = "concurrent-destination".into();
                    self.memory.rows.borrow_mut().insert(key.0.clone(), raced);
                }
                Race::Source => {
                    self.memory
                        .rows
                        .borrow_mut()
                        .get_mut(&self.source.0)
                        .unwrap()
                        .revision = "changed-source".into();
                }
                Race::Unknown => {
                    assert_eq!(
                        self.memory.commit(transition).await?,
                        CommitOutcome::Committed
                    );
                    return Err(GatewayError::unavailable(
                        "Fixture lost the receipt after durable commit",
                        "fixture_unknown_commit",
                    ));
                }
            }
        }
        self.memory.commit(transition).await
    }
}
impl QueryStore for Store {
    async fn query(&self, q: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.memory.query(q).await
    }
}
fn error() -> ErrorObservation {
    ErrorObservation {
        request_id: "fixture".into(),
        route: "/v1/responses".into(),
        status: 502,
        provider: "deepseek".into(),
        model: None,
        reasoning: None,
        stream: Some(false),
        terminal_type: Some("http.error".into()),
        failure_kind: Some("upstream_error".into()),
        delivery_outcome: DeliveryOutcome::Unobserved,
        created_at_ms: 1000,
        latency_ms: 3,
        git_sha: None,
        deno_revision: None,
    }
}
fn fixture(mode: Race) -> (Store, Host) {
    let memory = Memory::default();
    let source =
        TupleKey::from_scalar_parts(&[gateway_core::tuple_key::ScalarKeyPart::String("source")])
            .to_record_key();
    memory.rows.borrow_mut().insert(
        source.0.clone(),
        StoredRecord::json("current-source", serde_json::json!({"v":1}), None),
    );
    let clock = Host::default();
    clock.at.set(1000);
    (
        Store {
            memory,
            mode,
            first: Rc::new(Cell::new(true)),
            attempts: Rc::new(Cell::new(0)),
            source,
        },
        clock,
    )
}
#[test]
fn source_unconditional_write_overwrites_a_concurrent_destination_without_an_added_read_guard() {
    let (store, host) = fixture(Race::Destination);
    let runtime = ObservabilityRuntime::new(store.clone(), host);
    assert!(run(runtime.record_admin_error(&error())).unwrap());
    assert_eq!(store.attempts.get(), 1);
    assert_eq!(store.memory.reads.get(), 0);
    assert!(store.memory.rows.borrow().values().any(|row| {
        row.revision != "concurrent-destination"
            && row
                .json_value()
                .ok()
                .is_some_and(|v| v["request_id"] == "fixture")
    }));
}
#[test]
fn changed_explicit_source_fence_never_becomes_an_observation_write() {
    let (store, host) = fixture(Race::Source);
    let runtime = ObservabilityRuntime::new(store.clone(), host);
    let target = HealthTarget {
        provider: HealthProvider::ClaudeCode,
        identity: "fixture-account:cohort:generation".into(),
        source_checks: vec![RevisionCheck {
            key: store.source.clone(),
            expected_revision: Some("current-source".into()),
        }],
    };
    assert_eq!(
        run(runtime.observe_provider(target, HealthEvent::Success, Some(200), None)),
        HealthWrite::BindingChanged
    );
    assert_eq!(store.memory.rows.borrow().len(), 1);
}
#[test]
fn unknown_commit_receipt_is_not_replayed_or_reported_as_no_effect() {
    let (store, host) = fixture(Race::Unknown);
    let runtime = ObservabilityRuntime::new(store.clone(), host);
    assert_eq!(
        run(runtime.record_admin_error(&error()))
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("fixture_unknown_commit")
    );
    assert_eq!(store.attempts.get(), 1);
    assert_eq!(store.memory.commits.get(), 1);
    assert_eq!(store.memory.rows.borrow().len(), 2);
}
