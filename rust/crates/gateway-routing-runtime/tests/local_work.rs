use gateway_auth::AuthMethod;
use gateway_authority::{
    Authority, AuthorityClock, REQUEST_LEASE_MS, TokenSource, keys,
    quota::{ApiReservation, KernelPolicy},
};
use gateway_core::{
    GatewayError,
    lifecycle::{BodyOutcome, DeliveryOutcome, ReaderTermination},
    local_work::{LocalSemanticOutcome, LocalTerminalObservation},
    query::{QueryPage, QueryRequest, QuerySelector, QueryStore},
    source_json::SourceJson,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_routing_runtime::local_work::completion::response::{
    LocalAccountingProgress, LocalWireKind,
};
use gateway_routing_runtime::{
    custody, local_work::*, policy, session::RoutingSession, settlement::recover_pending,
    types::RoutingHost,
};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use gateway_schema::source_request::SourceRequestDocument;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

const ORIGINAL: &str = r#"{"input":"original\ud800","stream":false,"max_output_tokens":2048,"model":"unavailable-model"}"#;
type LocalHandle = LocalWorkHandle<Store, Store, Store, Host>;

fn key(kind: &str, id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String(kind),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}

fn local_input(id: &str) -> LocalAdmissionInput {
    let original = input(id, "unavailable-model", &[]);
    LocalAdmissionInput {
        metadata: LocalRequestMetadata {
            context: original.context,
            principal: original.principal,
            catalog: original.catalog,
            runtime: original.runtime,
            client_version: original.client_version,
            native_session_id: original.native_session_id,
            retry_prohibited: original.retry_prohibited,
        },
        original: SourceRequestDocument::new(SourceJson::parse(ORIGINAL).unwrap()).unwrap(),
    }
}

fn begin_local(store: &Store, id: &str) -> LocalHandle {
    run(RoutingSession::begin_local_compaction(
        local_input(id),
        store.clone(),
        Host::new(store),
        store.clone(),
        store.clone(),
    ))
    .unwrap()
}

fn finish_built(local: LocalHandle) -> gateway_routing_runtime::types::RecoveredSession {
    let mut built = local.retain_built_response().unwrap();
    let mut selected = run(built.select_response()).unwrap();
    assert_eq!(
        selected.take_wire_decision().unwrap().kind(),
        LocalWireKind::OriginalSuccess
    );
    selected
        .observation_sink()
        .observe(
            Some(ReaderTermination::Eof),
            Some(BodyOutcome::Drained),
            DeliveryOutcome::Unobserved,
        )
        .unwrap();
    match run(selected.attempt_terminal()) {
        LocalAccountingProgress::Confirmed(result) => result,
        _ => panic!("genuine source terminal callback must confirm"),
    }
}

fn observation(semantic: LocalSemanticOutcome) -> LocalTerminalObservation {
    LocalTerminalObservation {
        semantic,
        reader_termination: Some(ReaderTermination::Eof),
        body: Some(BodyOutcome::Drained),
        delivery: DeliveryOutcome::Unobserved,
    }
}

fn assert_custody(store: &Store) {
    let prefix = TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
    ])
    .to_record_key();
    let rows = run(store.query(QueryRequest {
        selector: QuerySelector::Prefix {
            prefix,
            start: None,
            end: None,
        },
        reverse: false,
        limit: 1000,
        cursor: None,
        now_ms: store.now_ms().unwrap(),
    }))
    .unwrap();
    assert!(rows.next_cursor.is_none());
    custody::validate_journal_rows(rows.entries.iter().map(|row| (&row.key, &row.record))).unwrap();
}

#[test]
fn local_success_reserves_before_any_ordinary_plan_and_releases_only_unused_dispatch() {
    let store = Store::new();
    seed_key(&store);
    seed_pool(&store);
    let original_pool = store.value(source_key());
    assert!(
        policy::plan(
            &input("unplanned", "unavailable-model", &[]),
            NOW,
            Host::new(&store).source_string_collator().as_ref()
        )
        .is_err()
    );
    let local = begin_local(&store, "unplanned");
    assert_eq!(local.original_source().as_str(), ORIGINAL);
    assert_eq!(window(&store)["reserved_requests"], 1);
    assert_eq!(window(&store)["committed_requests"], 0);
    let journal = store.value(key("session", "unplanned"));
    assert_eq!(journal["local_work"]["phase"], "running");
    assert_eq!(journal["attempts"], json!([]));
    assert!(journal["active"].is_null());
    assert_custody(&store);
    let settled = finish_built(local);
    assert!(settled.settled);
    assert_eq!(settled.observation.delivery, DeliveryOutcome::Unobserved);
    assert!(settled.observation.semantic_terminal.is_none());
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(window(&store)["committed_requests"], 0);
    let journal = store.value(key("session", "unplanned"));
    assert_eq!(journal["finished"], true);
    assert_eq!(journal["semantic_committed"], false);
    assert_eq!(journal["attempts"], json!([]));
    assert_eq!(journal["local_work"]["terminal"]["semantic"], "completed");
    assert!(store.value(key("pending", "unplanned")).is_null());
    assert_custody(&store);
    assert_eq!(store.value(source_key()), original_pool);
}

#[test]
fn duplicate_admission_is_refused_and_resume_retains_exact_original_and_same_reservation() {
    let store = Store::new();
    seed_key(&store);
    let local = begin_local(&store, "one-lifetime");
    let before = store.value(key("session", "one-lifetime"));
    assert!(
        run(RoutingSession::begin_local_compaction(
            local_input("one-lifetime"),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        ))
        .is_err()
    );
    let admission = run(local.resume_original()).unwrap();
    assert_eq!(admission.original_source().as_str(), ORIGINAL);
    assert_eq!(admission.original_context().request_id.0, "one-lifetime");
    let after = store.value(key("session", "one-lifetime"));
    assert_eq!(after["local_work"]["phase"], "planning");
    for field in ["input_digest", "context", "api", "kernel", "attempts"] {
        assert_eq!(before[field], after[field], "{field}");
    }
    assert_eq!(window(&store)["reserved_requests"], 1);
    assert_eq!(window(&store)["committed_requests"], 0);
    assert_custody(&store);
}

#[test]
fn caller_cancelled_before_admission_has_no_durable_or_quota_effect() {
    let store = Store::new();
    seed_key(&store);
    let host = Host::new(&store);
    host.cancelled.store(true, Ordering::SeqCst);
    assert!(
        run(RoutingSession::begin_local_compaction(
            local_input("cancelled-before"),
            store.clone(),
            host,
            store.clone(),
            store.clone(),
        ))
        .is_err()
    );
    assert!(store.value(key("session", "cancelled-before")).is_null());
    assert!(window(&store).is_null());
}

#[test]
fn caller_cancellation_and_expiry_forbid_resume_and_settle_the_original_once() {
    for expired in [false, true] {
        let store = Store::new();
        seed_key(&store);
        let host = Host::new(&store);
        let local = run(RoutingSession::begin_local_compaction(
            local_input("cancelled-after"),
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        ))
        .unwrap();
        if expired {
            store.advance(REQUEST_LEASE_MS + 1);
        } else {
            host.cancelled.store(true, Ordering::SeqCst);
        }
        assert!(run(local.checkpoint()).is_err());
        assert!(run(local.resume_original()).is_err());
        let row = store.value(key("session", "cancelled-after"));
        assert_eq!(row["finished"], true);
        assert_eq!(row["local_work"]["terminal"]["semantic"], "cancelled");
        assert_eq!(row["attempts"], json!([]));
        assert_eq!(window(&store)["reserved_requests"], 0);
        assert_eq!(window(&store)["committed_requests"], 0);
        assert_custody(&store);
    }
}

#[test]
fn changed_owner_or_released_api_cannot_reuse_a_local_handle() {
    for changed_owner in [false, true] {
        let store = Store::new();
        seed_key(&store);
        let local = begin_local(&store, "fenced");
        let mut row = store.value(key("session", "fenced"));
        if changed_owner {
            row["local_work"]["owner_nonce"] = json!("different-owner");
            store.seed(key("session", "fenced"), row);
        } else {
            let api: ApiReservation = serde_json::from_value(row["api"].clone()).unwrap();
            run(
                Authority::with_clock(store.clone(), store.clone(), store.clone()).release_api_key(
                    &api,
                    true,
                    "fixture-before-dispatch",
                    NOW,
                ),
            )
            .unwrap();
        }
        assert!(run(local.checkpoint()).is_err());
        assert!(run(local.resume_original()).is_err());
        assert_eq!(window(&store)["committed_requests"], 0);
        assert_eq!(
            window(&store)["reserved_requests"],
            if changed_owner { 1 } else { 0 }
        );
    }
}

fn kernel_input(store: &Store, id: &str) -> LocalAdmissionInput {
    store.seed(
        keys::kernel_policy("owner", Some("repo")),
        KernelPolicy::<String, i64> {
            v: 2,
            owner: "owner".into(),
            repo: Some("repo".into()),
            usage_limit_requests: 10,
            window_ms: gateway_authority::DAY_MS,
            expires_at_ms: -1,
        },
    );
    let mut input = local_input(id);
    input.metadata.context.key_id = None;
    input.metadata.principal.method = AuthMethod::GithubToken {
        owner: "owner".into(),
        repo: "repo".into(),
        state_id: "source-state".into(),
        limit_scope: "repo".into(),
    };
    input
}

#[test]
fn genuine_local_completion_commits_kernel_without_provider_usage_or_native_delivery() {
    let store = Store::new();
    let local = run(RoutingSession::begin_local_compaction(
        kernel_input(&store, "local-kernel"),
        store.clone(),
        Host::new(&store),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    let lease = run(local.checkpoint()).unwrap();
    assert_eq!(lease.kernel_expires_at_ms(), Some(NOW + REQUEST_LEASE_MS));
    finish_built(local);
    let row = store.value(key("session", "local-kernel"));
    let kernel = store.value(keys::kernel_request(
        "owner",
        Some("repo"),
        row["kernel"]["window_created_at_ms"].as_i64().unwrap(),
        "local-kernel",
    ));
    assert_eq!(kernel["state"], "committed");
    assert_eq!(row["attempts"], json!([]));
    assert_eq!(row["semantic_committed"], false);
    assert_eq!(row["local_work"]["terminal"]["delivery"], "unobserved");
    assert_custody(&store);
}

#[test]
fn kernel_renewal_reports_actual_expiry_and_never_revives_an_expired_owner() {
    let store = Store::new();
    let local = run(RoutingSession::begin_local_compaction(
        kernel_input(&store, "renew-local"),
        store.clone(),
        Host::new(&store),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    store.advance(KERNEL_RENEWAL_INTERVAL_MS);
    let lease = run(local.currentness().renew_kernel()).unwrap();
    assert_eq!(
        lease.kernel_expires_at_ms(),
        Some(NOW + KERNEL_RENEWAL_INTERVAL_MS + REQUEST_LEASE_MS)
    );
    store.advance(REQUEST_LEASE_MS + 1);
    assert!(run(local.currentness().renew_kernel()).is_err());
    assert!(run(local.resume_original()).is_err());
}

#[test]
fn crashed_running_and_planning_rows_are_cleanup_only_after_expiry() {
    for planning in [false, true] {
        let store = Store::new();
        seed_key(&store);
        let local = begin_local(&store, "crashed-local");
        if planning {
            drop(run(local.resume_original()).unwrap());
        } else {
            drop(local);
        }
        store.advance(REQUEST_LEASE_MS + 1);
        let recovered = run(recover_pending(
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            10,
        ))
        .unwrap();
        assert_eq!(recovered.len(), 1);
        assert!(recovered[0].settled);
        let row = store.value(key("session", "crashed-local"));
        assert_eq!(row["local_work"]["terminal"]["semantic"], "incomplete");
        assert_eq!(row["attempts"], json!([]));
        assert_eq!(window(&store)["reserved_requests"], 0);
        assert_eq!(window(&store)["committed_requests"], 0);
        assert_custody(&store);
    }
}

#[test]
fn original_binding_matches_actual_bun_stringify_and_keeps_all_utf16_controls() {
    // Executed Bun 1.4.0 oracle: m34-source-binding-v2, receipt e793a381-7c23-404d-b702-e48ecee4b6cf.
    for (source, expected) in [
        (
            r#"{"10":"ten","2":"two","repeat":"first","repeat":"last","\ud800":"\udfff","s":"\ud83d\ude00","n":-0}"#,
            "65fc8e7cd0cb150ca34436f6f205baf63cdadf72c6d277ace83623c8d609cda5",
        ),
        (
            ORIGINAL,
            "6c92602ea4c13aa7dd297fd69f8e9aa85de2db98d7f370a3f741f37b19df561e",
        ),
    ] {
        let source = SourceJson::parse(source).unwrap();
        assert_eq!(original_source_digest(&source).unwrap(), expected);
    }
}

#[test]
fn a_crashed_local_terminal_replays_the_same_intent_without_provider_or_duplicate_charge() {
    let store = Store::new();
    seed_key(&store);
    drop(begin_local(&store, "crashed-terminal"));
    let mut row = store.value(key("session", "crashed-terminal"));
    row["local_work"]["phase"] = json!("terminal_pending");
    row["local_work"]["terminal"] =
        serde_json::to_value(observation(LocalSemanticOutcome::Completed)).unwrap();
    store.seed(key("session", "crashed-terminal"), row);
    for count in [1, 0] {
        let recovered = run(recover_pending(
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            10,
        ))
        .unwrap();
        assert_eq!(recovered.len(), count);
        assert_eq!(window(&store)["reserved_requests"], 0);
        assert_eq!(window(&store)["committed_requests"], 0);
    }
    let row = store.value(key("session", "crashed-terminal"));
    assert_eq!(row["local_work"]["terminal"]["semantic"], "completed");
    assert_eq!(row["local_work"]["terminal"]["delivery"], "unobserved");
    assert_eq!(row["attempts"], json!([]));
    assert_custody(&store);
}

#[derive(Clone)]
struct FailBindingStore {
    inner: Store,
    fail: Arc<AtomicBool>,
}

impl AuthorityClock for FailBindingStore {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        self.inner.now_ms()
    }
}

impl TokenSource for FailBindingStore {
    fn next_token(&self) -> Result<String, GatewayError> {
        self.inner.next_token()
    }
}

impl AuthorityStore for FailBindingStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.inner.read(key).await
    }

    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let binds_api = transition.mutations.iter().any(|mutation| {
            matches!(mutation, RecordMutation::Put { key: row_key, record }
                if *row_key == key("session", "failed-binding") && record.value["api"].is_object())
        });
        if binds_api && self.fail.swap(false, Ordering::SeqCst) {
            return Err(GatewayError::unavailable(
                "fixture binding failure",
                "fixture_binding_failed",
            ));
        }
        self.inner.commit(transition).await
    }
}

impl QueryStore for FailBindingStore {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.inner.query(request).await
    }
}

#[test]
fn reservation_returned_before_a_failed_journal_binding_is_still_released() {
    let store = Store::new();
    seed_key(&store);
    let fault = FailBindingStore {
        inner: store.clone(),
        fail: Arc::new(AtomicBool::new(true)),
    };
    assert!(
        run(RoutingSession::begin_local_compaction(
            local_input("failed-binding"),
            fault.clone(),
            Host::new(&store),
            fault.clone(),
            fault,
        ))
        .is_err()
    );
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(window(&store)["committed_requests"], 0);
    assert_eq!(
        store.value(key("session", "failed-binding"))["finished"],
        true
    );
    assert_custody(&store);
}
