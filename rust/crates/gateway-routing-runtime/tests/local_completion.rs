mod support;
use gateway_auth::AuthMethod;
use gateway_authority::{
    Authority, AuthorityClock, REQUEST_LEASE_MS, TokenSource, keys,
    quota::{ApiReservation, KernelPolicy, KernelReservation, KernelTerminal},
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
use gateway_routing_runtime::{RoutingSession, local_work::*, recover_pending};
use gateway_schema::source_request::SourceRequestDocument;
use serde_json::json;
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
};
use support::*;
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
            KernelPolicy {
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
fn ready<S: QueryStore + Clone, I: TokenSource + Clone, C: AuthorityClock + Clone + 'static>(
    pending: &mut PendingLocalCompletion<S, I, C, Host>,
) -> LocalDeliveryHandle<S, I, C, Host> {
    match run(pending.advance()).unwrap() {
        LocalCompletionAdvance::Ready(handle) => handle,
        _ => panic!("same chosen completion must confirm"),
    }
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
#[test]
fn genuine_success_is_owned_before_first_await_and_delayed_marker_preserves_completion() {
    let store = Store::new();
    let host = Host::new(&store);
    let local = begin(&store, host.clone(), "delayed", true);
    let mut pending = local.mark_local_completed().unwrap();
    assert_eq!(
        store.value(key("delayed"))["local_work"]["phase"],
        "running"
    );
    store.advance(REQUEST_LEASE_MS + 1);
    host.cancelled.store(true, Ordering::SeqCst);
    let mut delivery = ready(&mut pending);
    let marker = store.value(key("delayed"));
    assert_eq!(marker["local_work"]["terminal"]["semantic"], "completed");
    assert!(marker["local_work"]["terminal"]["body"].is_null());
    assert_eq!(
        kernel_row(&store, "delayed")["terminal_intent"],
        "committed"
    );
    let result = run(delivery.finish_delivery(
        Some(ReaderTermination::Cancelled),
        Some(BodyOutcome::Interrupted),
        DeliveryOutcome::Unobserved,
    ))
    .unwrap();
    assert!(result.settled);
    assert_eq!(result.observation.delivery, DeliveryOutcome::Unobserved);
    assert_eq!(kernel_row(&store, "delayed")["state"], "committed");
    assert!(
        store.value(key("delayed"))["attempts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn observed_abort_before_success_never_chooses_completion_or_fallback() {
    let store = Store::new();
    let host = Host::new(&store);
    let local = begin(&store, host.clone(), "abort", true);
    store.advance(REQUEST_LEASE_MS + 1);
    host.cancelled.store(true, Ordering::SeqCst);
    let refusal = match local.mark_local_completed() {
        Err(refusal) => refusal,
        Ok(_) => panic!("observed abort must refuse"),
    };
    assert_eq!(refusal.error().error.status, 499);
    run(refusal.cleanup()).unwrap();
    run(refusal.cleanup()).unwrap();
    assert_eq!(kernel_row(&store, "abort")["state"], "released");
    assert_eq!(
        store.value(key("abort"))["local_work"]["terminal"]["semantic"],
        "cancelled"
    );
}
#[test]
fn postchoice_unused_api_release_remains_compatible_and_transport_refinement_is_idempotent() {
    let store = Store::new();
    let local = begin(&store, Host::new(&store), "api-release", false);
    let api: ApiReservation =
        serde_json::from_value(store.value(key("api-release"))["api"].clone()).unwrap();
    let mut pending = local.mark_local_completed().unwrap();
    run(
        Authority::with_clock(store.clone(), store.clone(), store.clone()).release_api_key(
            &api,
            true,
            "source-unused-release",
            NOW,
        ),
    )
    .unwrap();
    let mut delivery = ready(&mut pending);
    run(delivery.finish_delivery(None, None, DeliveryOutcome::Unobserved)).unwrap();
    run(delivery.finish_delivery(
        Some(ReaderTermination::Eof),
        Some(BodyOutcome::Drained),
        DeliveryOutcome::Unobserved,
    ))
    .unwrap();
    run(delivery.finish_delivery(
        Some(ReaderTermination::Eof),
        Some(BodyOutcome::Drained),
        DeliveryOutcome::Unobserved,
    ))
    .unwrap();
    assert!(
        run(delivery.finish_delivery(
            Some(ReaderTermination::ReadError),
            None,
            DeliveryOutcome::Unobserved
        ))
        .is_err()
    );
    assert_eq!(window(&store)["committed_requests"], 0);
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(
        store.value(key("api-release"))["local_work"]["terminal"]["delivery"],
        "unobserved"
    );
}
#[test]
fn actual_reclaim_or_changed_original_refuses_without_overwriting_the_chosen_result() {
    for field in ["reclaim", "nonce", "digest", "context"] {
        let store = Store::new();
        let local = begin(&store, Host::new(&store), "conflict", true);
        let mut pending = local.mark_local_completed().unwrap();
        let mut row = store.value(key("conflict"));
        match field {
            "reclaim" => {
                let kernel: KernelReservation =
                    serde_json::from_value(row["kernel"].clone()).unwrap();
                run(
                    Authority::with_clock(store.clone(), store.clone(), store.clone())
                        .settle_kernel(&kernel, KernelTerminal::Released, "fixture-reclaim", NOW),
                )
                .unwrap();
            }
            "nonce" => {
                row["local_work"]["owner_nonce"] = json!("foreign");
                store.seed(key("conflict"), row);
            }
            "digest" => {
                row["input_digest"] = json!("foreign");
                store.seed(key("conflict"), row);
            }
            _ => {
                row["context"]["route"] = json!("foreign");
                store.seed(key("conflict"), row);
            }
        }
        let outcome = run(pending.advance());
        assert!(!matches!(outcome, Ok(LocalCompletionAdvance::Ready(_))));
        assert_eq!(
            kernel_row(&store, "conflict")["state"],
            if field == "reclaim" {
                json!("released")
            } else {
                json!(null)
            }
        );
    }
}
#[derive(Clone)]
struct FaultStore {
    inner: Store,
    armed: Arc<AtomicBool>,
    pause: bool,
}
impl AuthorityStore for FaultStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.inner.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let choice = transition.mutations.iter().any(|m| match m {
            RecordMutation::Put { record, .. } => record
                .json_value()
                .ok()
                .is_some_and(|row| row["local_work"]["terminal"]["semantic"] == "completed"),
            _ => false,
        });
        if choice && self.armed.swap(false, Ordering::SeqCst) {
            let result = self.inner.commit(transition).await?;
            assert_eq!(result, CommitOutcome::Committed);
            if self.pause {
                std::future::pending::<()>().await;
            }
            return Err(GatewayError::unavailable(
                "fixture lost ack",
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
fn fault_pending(
    store: &Store,
    id: &str,
    pause: bool,
) -> PendingLocalCompletion<FaultStore, Store, Store, Host> {
    let input = admission(store, id, true);
    let fault = FaultStore {
        inner: store.clone(),
        armed: Arc::new(AtomicBool::new(false)),
        pause,
    };
    let local = run(RoutingSession::begin_local_compaction(
        input,
        fault.clone(),
        Host::new(store),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    fault.armed.store(true, Ordering::SeqCst);
    local.mark_local_completed().unwrap()
}
#[test]
fn lost_ack_retry_keeps_same_original_intent_and_settles_once() {
    let store = Store::new();
    let mut pending = fault_pending(&store, "lost-ack", false);
    assert!(matches!(
        run(pending.advance()).unwrap(),
        LocalCompletionAdvance::Unconfirmed(_)
    ));
    assert_eq!(
        store.value(key("lost-ack"))["local_work"]["terminal"]["semantic"],
        "completed"
    );
    let mut delivery = ready(&mut pending);
    run(delivery.finish_delivery(None, None, DeliveryOutcome::Unobserved)).unwrap();
    run(delivery.finish_delivery(None, None, DeliveryOutcome::Unobserved)).unwrap();
    assert_eq!(kernel_row(&store, "lost-ack")["state"], "committed");
    let window = store.value(keys::kernel_window("owner", Some("repo")));
    assert_eq!(window["usage_requests"], 1);
    assert_eq!(window["reserved_requests"], 0);
}
#[test]
fn cancelled_advance_future_retains_owned_pending_and_reconciles_after_event_recovery() {
    let store = Store::new();
    let mut pending = fault_pending(&store, "cancelled-await", true);
    {
        let future = pending.advance();
        let mut future = std::pin::pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
    }
    let recovered = run(recover_pending(
        store.clone(),
        Host::new(&store),
        store.clone(),
        store.clone(),
        10,
    ))
    .unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(
        recovered[0].observation.delivery,
        DeliveryOutcome::Unobserved
    );
    let mut delivery = ready(&mut pending);
    run(delivery.finish_delivery(
        Some(ReaderTermination::Eof),
        Some(BodyOutcome::Drained),
        DeliveryOutcome::Unobserved,
    ))
    .unwrap();
    assert_eq!(kernel_row(&store, "cancelled-await")["state"], "committed");
}
