use gateway_auth::AuthMethod;
use gateway_authority::{
    Authority, REQUEST_LEASE_MS, keys,
    quota::{ApiReservation, KernelPolicy},
};
use gateway_core::{
    GatewayError,
    lifecycle::{BodyOutcome, DeliveryOutcome, ReaderTermination},
    query::{QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_routing_runtime::{
    local_work::completion::response::{
        LocalAccountingProgress, LocalSelectedResponse, LocalWireKind,
    },
    local_work::*,
    session::RoutingSession,
    settlement::recover_pending,
};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use gateway_schema::source_request::SourceRequestDocument;
use serde_json::json;
use std::{
    future::Future,
    sync::{Arc, atomic::Ordering},
    task::{Context, Waker},
};
fn key(id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
fn admission(store: &Store, id: &str, kernel: bool) -> LocalAdmissionInput {
    seed_pool(store);
    seed_key(store);
    let mut fixture = input(id, "gpt-test", &[]);
    if kernel {
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
        fixture.context.key_id = None;
        fixture.principal.method = AuthMethod::GithubToken {
            owner: "owner".into(),
            repo: "repo".into(),
            state_id: "fixture".into(),
            limit_scope: "repo".into(),
        };
    }
    LocalAdmissionInput {
        metadata: LocalRequestMetadata {
            context: fixture.context,
            principal: fixture.principal,
            catalog: fixture.catalog,
            runtime: fixture.runtime,
            client_version: fixture.client_version,
            native_session_id: fixture.native_session_id,
            retry_prohibited: fixture.retry_prohibited,
        },
        original: SourceRequestDocument::new(fixture.raw).unwrap(),
    }
}
fn begin(
    store: &Store,
    host: Host,
    id: &str,
    kernel: bool,
) -> LocalWorkHandle<Store, Store, Store, Host> {
    run(RoutingSession::begin_local_compaction(
        admission(store, id, kernel),
        store.clone(),
        host,
        store.clone(),
        store.clone(),
    ))
    .unwrap()
}
fn kernel_row(store: &Store, id: &str) -> serde_json::Value {
    let row = store.value(key(id));
    store.value(keys::kernel_request(
        "owner",
        Some("repo"),
        row["kernel"]["window_created_at_ms"].as_i64().unwrap(),
        id,
    ))
}
fn api(store: &Store, id: &str) -> ApiReservation {
    serde_json::from_value(store.value(key(id))["api"].clone()).unwrap()
}
fn api_key(api: &ApiReservation) -> RecordKey {
    keys::api_request(
        &api.key_id.0,
        &api.policy_version,
        api.window_start_ms,
        &api.request_id.0,
    )
}
fn selected(
    store: &Store,
    host: Host,
    id: &str,
    kernel: bool,
) -> LocalSelectedResponse<Store, Store, Store, Host> {
    let mut built = begin(store, host, id, kernel)
        .retain_built_response()
        .unwrap();
    run(built.select_response()).unwrap()
}
fn confirmed(progress: LocalAccountingProgress) {
    match progress {
        LocalAccountingProgress::Confirmed(result) => assert!(result.settled),
        _ => panic!("expected confirmed same-original callback"),
    }
}
#[test]
fn genuine_built_owner_precedes_release_and_selected_wire_never_waits_for_marker() {
    let store = Store::new();
    let host = Host::new(&store);
    let local = begin(&store, host.clone(), "built", true);
    let mut built = local.retain_built_response().unwrap();
    assert_eq!(store.value(key("built"))["local_work"]["phase"], "running");
    assert!(kernel_row(&store, "built")["terminal_intent"].is_null());
    store.advance(REQUEST_LEASE_MS + 1);
    host.cancelled.store(true, Ordering::SeqCst);
    let mut selected = run(built.select_response()).unwrap();
    assert_eq!(
        selected.take_wire_decision().unwrap().kind(),
        LocalWireKind::OriginalSuccess
    );
    assert!(selected.take_wire_decision().is_none());
    assert!(kernel_row(&store, "built")["terminal_intent"].is_null());
    selected
        .observation_sink()
        .observe(
            Some(ReaderTermination::Cancelled),
            Some(BodyOutcome::Interrupted),
            DeliveryOutcome::Unobserved,
        )
        .unwrap();
    confirmed(run(selected.attempt_terminal()));
    assert_eq!(kernel_row(&store, "built")["state"], "committed");
    assert_eq!(
        store.value(key("built"))["local_work"]["terminal"]["delivery"],
        "unobserved"
    );
}
#[test]
fn observed_abort_selects_cancel_response_only_after_the_same_api_release_gate() {
    let store = Store::new();
    let host = Host::new(&store);
    let local = begin(&store, host.clone(), "abort", true);
    host.cancelled.store(true, Ordering::SeqCst);
    let mut refusal = match local.retain_built_response() {
        Err(refusal) => refusal,
        Ok(_) => panic!("abort must retain cancellation owner"),
    };
    assert_eq!(refusal.error().error.status, 499);
    let mut selected = run(refusal.select_cancelled_response()).unwrap();
    assert_eq!(
        selected.take_wire_decision().unwrap().kind(),
        LocalWireKind::OriginalCancellation
    );
    confirmed(run(selected.attempt_terminal()));
    confirmed(run(selected.attempt_terminal()));
    assert_eq!(kernel_row(&store, "abort")["state"], "released");
}
#[derive(Clone, Copy)]
enum Fault {
    ApiRead,
    ApiConflict,
    ApiLostAck,
    ApiPause,
    TerminalConflict,
    TerminalLostAck,
    TerminalPause,
}
#[derive(Clone)]
struct FaultStore {
    inner: Store,
    mode: Arc<std::sync::Mutex<Option<Fault>>>,
}
impl AuthorityStore for FaultStore {
    async fn read(&self, row_key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        if matches!(*self.mode.lock().unwrap(), Some(Fault::ApiRead)) {
            let bound: ApiReservation =
                serde_json::from_value(self.inner.value(key("quota"))["api"].clone()).unwrap();
            if *row_key == api_key(&bound) {
                return Err(GatewayError::new(
                    400,
                    "internal detail must not become source400",
                    Some("internal"),
                ));
            }
        }
        self.inner.read(row_key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let api_release=transition.mutations.iter().any(|m|matches!(m,RecordMutation::Put{record,..} if record.json_value().ok().is_some_and(|v|v["state"]=="released"&&v["key_id"].is_string())));
        let terminal=transition.mutations.iter().any(|m|matches!(m,RecordMutation::Put{record,..} if record.json_value().ok().is_some_and(|v|v["local_work"]["terminal"]["semantic"]=="completed")));
        let mode = *self.mode.lock().unwrap();
        if api_release && matches!(mode, Some(Fault::ApiConflict))
            || terminal && matches!(mode, Some(Fault::TerminalConflict))
        {
            return Ok(CommitOutcome::Conflict);
        }
        if (api_release && matches!(mode, Some(Fault::ApiLostAck | Fault::ApiPause)))
            || (terminal && matches!(mode, Some(Fault::TerminalLostAck | Fault::TerminalPause)))
        {
            *self.mode.lock().unwrap() = None;
            let result = self.inner.commit(transition).await?;
            assert_eq!(result, CommitOutcome::Committed);
            if matches!(mode, Some(Fault::ApiPause | Fault::TerminalPause)) {
                std::future::pending::<()>().await;
            }
            return Err(GatewayError::unavailable(
                "fixture unknown acknowledgement",
                "fixture_unknown_ack",
            ));
        }
        self.inner.commit(transition).await
    }
}
impl QueryStore for FaultStore {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.inner.query(request).await
    }
}
fn fault_local(
    store: &Store,
    id: &str,
    kernel: bool,
) -> (LocalWorkHandle<FaultStore, Store, Store, Host>, FaultStore) {
    let input = admission(store, id, kernel);
    let backend = FaultStore {
        inner: store.clone(),
        mode: Arc::new(std::sync::Mutex::new(None)),
    };
    let local = run(RoutingSession::begin_local_compaction(
        input,
        backend.clone(),
        Host::new(store),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    (local, backend)
}
#[test]
fn closed_three_release_errors_replace_built_success_with_exact_source_envelope() {
    for (fault, message) in [
        (
            Some(Fault::ApiRead),
            "API key quota reservation is unavailable",
        ),
        (
            Some(Fault::ApiConflict),
            "API key quota reservation changed concurrently",
        ),
        (None, "API key quota reservation is malformed"),
    ] {
        let store = Store::new();
        let (local, backend) = fault_local(&store, "quota", false);
        let reservation = api(&store, "quota");
        let mut built = local.retain_built_response().unwrap();
        if let Some(fault) = fault {
            *backend.mode.lock().unwrap() = Some(fault);
        } else {
            let mut row = store.value(api_key(&reservation));
            row["state"] = json!("malformed");
            store.seed(api_key(&reservation), row);
        }
        let mut selected = run(built.select_response()).unwrap();
        let wire = selected.take_wire_decision().unwrap();
        assert_eq!(wire.kind(), LocalWireKind::QuotaReplacement);
        let error = wire.quota_error().unwrap();
        assert_eq!(error.error.status, 503);
        assert_eq!(
            error.error.envelope.error.code.as_deref(),
            Some("api_key_quota_reservation_unavailable")
        );
        assert_eq!(error.error.envelope.error.error_type, "server_error");
        assert_eq!(error.error.envelope.error.message, message);
        assert!(error.headers.is_empty());
        *backend.mode.lock().unwrap() = None;
        confirmed(run(selected.attempt_terminal()));
        assert_eq!(
            store.value(key("quota"))["local_work"]["terminal"]["semantic"],
            "incomplete"
        );
        assert_eq!(window(&store)["committed_requests"], 0);
    }
}
#[test]
fn a_returned_unknown_release_error_freezes_replacement_instead_of_restoring_success() {
    let store = Store::new();
    let (local, backend) = fault_local(&store, "release-ack", false);
    let mut built = local.retain_built_response().unwrap();
    *backend.mode.lock().unwrap() = Some(Fault::ApiLostAck);
    let mut selected = run(built.select_response()).unwrap();
    assert_eq!(
        selected.take_wire_decision().unwrap().kind(),
        LocalWireKind::QuotaReplacement
    );
    assert!(run(built.select_response()).is_err());
    confirmed(run(selected.attempt_terminal()));
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(window(&store)["committed_requests"], 0);
}
#[test]
fn cancelled_release_await_retains_original_without_fabricating_an_error_result() {
    let store = Store::new();
    let (local, backend) = fault_local(&store, "release-pause", false);
    let mut built = local.retain_built_response().unwrap();
    *backend.mode.lock().unwrap() = Some(Fault::ApiPause);
    {
        let future = built.select_response();
        let mut future = std::pin::pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        assert!(future.as_mut().poll(&mut context).is_pending());
    }
    let mut selected = run(built.select_response()).unwrap();
    assert_eq!(
        selected.take_wire_decision().unwrap().kind(),
        LocalWireKind::OriginalSuccess
    );
    confirmed(run(selected.attempt_terminal()));
    assert_eq!(window(&store)["committed_requests"], 0);
}
#[test]
fn buffered_and_sse_wire_order_do_not_turn_accounting_conflict_into_a_new_response() {
    for sse in [false, true] {
        let store = Store::new();
        let (local, backend) = fault_local(&store, "wire-order", true);
        let mut built = local.retain_built_response().unwrap();
        let mut selected = run(built.select_response()).unwrap();
        *backend.mode.lock().unwrap() = Some(Fault::TerminalConflict);
        let mut events = Vec::new();
        if sse {
            assert_eq!(
                selected.take_wire_decision().unwrap().kind(),
                LocalWireKind::OriginalSuccess
            );
            events.push("wire");
        }
        let sink = selected.observation_sink();
        sink.observe(
            Some(ReaderTermination::Eof),
            Some(BodyOutcome::Drained),
            DeliveryOutcome::Unobserved,
        )
        .unwrap();
        for _ in 0..3 {
            assert!(matches!(
                run(selected.attempt_terminal()),
                LocalAccountingProgress::Conflict
            ));
            events.push("attempt");
        }
        if !sse {
            assert_eq!(
                selected.take_wire_decision().unwrap().kind(),
                LocalWireKind::OriginalSuccess
            );
            events.push("wire");
        }
        assert_eq!(events[0], if sse { "wire" } else { "attempt" });
        assert_eq!(events.len(), 4);
        assert!(kernel_row(&store, "wire-order")["state"].is_null());
        assert!(kernel_row(&store, "wire-order")["terminal_intent"].is_null());
    }
}
#[test]
fn observations_during_unknown_terminal_ack_are_folded_without_wire_replay_or_double_charge() {
    for pause in [false, true] {
        let store = Store::new();
        let (local, backend) = fault_local(&store, "terminal-ack", true);
        let mut built = local.retain_built_response().unwrap();
        let mut selected = run(built.select_response()).unwrap();
        let sink = selected.observation_sink();
        assert!(selected.take_wire_decision().is_some());
        *backend.mode.lock().unwrap() = Some(if pause {
            Fault::TerminalPause
        } else {
            Fault::TerminalLostAck
        });
        if pause {
            let future = selected.attempt_terminal();
            let mut future = std::pin::pin!(future);
            let mut context = Context::from_waker(Waker::noop());
            assert!(future.as_mut().poll(&mut context).is_pending());
            sink.observe(
                Some(ReaderTermination::Eof),
                Some(BodyOutcome::Drained),
                DeliveryOutcome::Unobserved,
            )
            .unwrap();
        } else {
            assert!(matches!(
                run(selected.attempt_terminal()),
                LocalAccountingProgress::Unconfirmed(_)
            ));
            sink.observe(
                Some(ReaderTermination::Eof),
                Some(BodyOutcome::Drained),
                DeliveryOutcome::Unobserved,
            )
            .unwrap();
        }
        if pause {
            let recovered = run(recover_pending(
                store.clone(),
                Host::new(&store),
                store.clone(),
                store.clone(),
                10,
            ))
            .unwrap();
            assert_eq!(recovered.len(), 1);
        }
        confirmed(run(selected.attempt_terminal()));
        confirmed(run(selected.attempt_terminal()));
        assert!(selected.take_wire_decision().is_none());
        assert_eq!(kernel_row(&store, "terminal-ack")["state"], "committed");
        assert_eq!(
            store.value(key("terminal-ack"))["local_work"]["terminal"]["body"],
            "drained"
        );
        assert_eq!(
            store.value(keys::kernel_window("owner", Some("repo")))["usage_requests"],
            1
        );
    }
}
#[test]
fn source_release_noops_do_not_refund_dispatched_or_require_a_missing_request_row() {
    for mode in ["missing", "released", "dispatched"] {
        let store = Store::new();
        let local = begin(&store, Host::new(&store), "noop", false);
        let reservation = api(&store, "noop");
        let authority = Authority::with_clock(store.clone(), store.clone(), store.clone());
        match mode {
            "missing" => {
                let record = run(store.read(&api_key(&reservation))).unwrap().unwrap();
                run(store.commit(AtomicTransition {
                    checks: vec![gateway_core::state::RevisionCheck {
                        key: api_key(&reservation),
                        expected_revision: Some(record.revision),
                    }],
                    mutations: vec![RecordMutation::Delete {
                        key: api_key(&reservation),
                    }],
                }))
                .unwrap();
            }
            "released" => {
                run(authority.release_api_key(&reservation, false, "fixture", NOW)).unwrap();
            }
            _ => {
                run(authority.dispatch_api_key(
                    &reservation,
                    gateway_core::provider::UpstreamProvider::ChatgptCodex,
                    NOW,
                ))
                .unwrap();
                run(authority.mark_api_transport_started(&reservation, NOW)).unwrap();
            }
        }
        let mut built = local.retain_built_response().unwrap();
        let mut selected = run(built.select_response()).unwrap();
        assert_eq!(
            selected.take_wire_decision().unwrap().kind(),
            LocalWireKind::OriginalSuccess
        );
        confirmed(run(selected.attempt_terminal()));
        if mode == "dispatched" {
            assert_eq!(window(&store)["committed_requests"], 1);
        }
    }
}
#[test]
fn actual_wrapper_failure_before_callback_is_incomplete_but_late_body_error_is_not() {
    for wrapper in [false, true] {
        let store = Store::new();
        let mut selected = selected(&store, Host::new(&store), "wrapper", true);
        if wrapper {
            selected.note_wrapper_failure().unwrap();
        } else {
            selected
                .observation_sink()
                .observe(
                    Some(ReaderTermination::ReadError),
                    Some(BodyOutcome::Failed),
                    DeliveryOutcome::Unobserved,
                )
                .unwrap();
        }
        confirmed(run(selected.attempt_terminal()));
        assert_eq!(
            kernel_row(&store, "wrapper")["state"],
            if wrapper { "released" } else { "committed" }
        );
        assert!(selected.note_wrapper_failure().is_err());
    }
}

#[test]
fn genuinely_deferred_inactive_release_does_not_reserve_again() {
    let store = Store::new();
    let input = admission(&store, "deferred", false);
    let mut policy = store.value(keys::api_policy("key-a"));
    policy["usage_limit_requests"] = json!(0);
    store.seed(keys::api_policy("key-a"), policy);
    let local = run(RoutingSession::begin_local_compaction(
        input,
        store.clone(),
        Host::new(&store),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    assert!(api(&store, "deferred").deferred);
    let mut built = local.retain_built_response().unwrap();
    let mut selected = run(built.select_response()).unwrap();
    assert_eq!(
        selected.take_wire_decision().unwrap().kind(),
        LocalWireKind::OriginalSuccess
    );
    confirmed(run(selected.attempt_terminal()));
    assert_eq!(store.value(key("deferred"))["attempts"], json!([]));
}

#[test]
fn release_failure_overrides_the_original_observed_cancellation_response() {
    let store = Store::new();
    let input = admission(&store, "quota", false);
    let host = Host::new(&store);
    let backend = FaultStore {
        inner: store.clone(),
        mode: Arc::new(std::sync::Mutex::new(None)),
    };
    let local = run(RoutingSession::begin_local_compaction(
        input,
        backend.clone(),
        host.clone(),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    host.cancelled.store(true, Ordering::SeqCst);
    let mut refusal = match local.retain_built_response() {
        Err(refusal) => refusal,
        Ok(_) => panic!("actual abort required"),
    };
    assert_eq!(refusal.error().error.status, 499);
    *backend.mode.lock().unwrap() = Some(Fault::ApiRead);
    let mut selected = run(refusal.select_cancelled_response()).unwrap();
    let wire = selected.take_wire_decision().unwrap();
    assert_eq!(wire.kind(), LocalWireKind::QuotaReplacement);
    assert_eq!(wire.quota_error().unwrap().error.status, 503);
}
