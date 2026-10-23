use gateway_auth::AuthMethod;
use gateway_authority::{
    Authority, AuthorityClock, REQUEST_LEASE_MS, keys,
    quota::{ApiReservation, KernelPolicy, KernelReservation},
};
use gateway_core::{
    lifecycle::{DeliveryOutcome, SemanticTerminal, TransportObservation},
    state::RecordKey,
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_routing_runtime::{
    currentness::RoutingLeaseState,
    local_work::{LocalAdmissionInput, LocalRequestMetadata},
    session::RoutingSession,
    types::AttemptUsage,
};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use gateway_schema::source_request::SourceRequestDocument;
use serde_json::json;
use std::sync::atomic::Ordering;

type Session = RoutingSession<Store, Store, Store, Host>;
fn journal_key(id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
fn kernel_input(store: &Store, id: &str) -> gateway_routing_runtime::types::RoutingInput {
    seed_pool(store);
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
    let mut request = input(id, "gpt-test", &[]);
    request.context.key_id = None;
    request.principal.method = AuthMethod::GithubToken {
        owner: "owner".into(),
        repo: "repo".into(),
        state_id: "fixture".into(),
        limit_scope: "repo".into(),
    };
    request
}
fn begin_kernel(store: &Store, id: &str, host: Host) -> Session {
    run(Session::begin(
        kernel_input(store, id),
        store.clone(),
        host,
        store.clone(),
        store.clone(),
    ))
    .unwrap()
}
#[test]
fn checkpoint_reads_actual_kernel_expiry_without_rewriting_the_original_journal() {
    let store = Store::new();
    let session = begin_kernel(&store, "observed", Host::new(&store));
    let before = store.value(journal_key("observed"));
    let first = run(session.currentness().checkpoint()).unwrap();
    assert_eq!(first.state(), RoutingLeaseState::Live);
    assert_eq!(first.observed_at_ms(), NOW);
    assert_eq!(first.request_expires_at_ms(), NOW + REQUEST_LEASE_MS);
    assert_eq!(first.kernel_expires_at_ms(), Some(NOW + REQUEST_LEASE_MS));
    let original: KernelReservation = serde_json::from_value(before["kernel"].clone()).unwrap();
    store.advance(1000);
    let actual = run(
        Authority::with_clock(store.clone(), store.clone(), store.clone())
            .renew_kernel(&original, store.now_ms().unwrap()),
    )
    .unwrap();
    let observed = run(session.currentness().checkpoint()).unwrap();
    assert_eq!(observed.kernel_expires_at_ms(), Some(actual));
    assert_eq!(
        observed.request_expires_at_ms(),
        first.request_expires_at_ms()
    );
    assert_eq!(store.value(journal_key("observed")), before);
}
#[test]
fn expired_or_cancelled_live_snapshot_refuses_without_extending_the_lease() {
    for expired in [false, true] {
        let store = Store::new();
        let host = Host::new(&store);
        let session = begin_kernel(&store, "expired", host.clone());
        let before = store.value(journal_key("expired"));
        if expired {
            store.advance(REQUEST_LEASE_MS);
        } else {
            host.cancelled.store(true, Ordering::SeqCst);
        }
        assert!(run(session.currentness().checkpoint()).is_err());
        assert_eq!(store.value(journal_key("expired")), before);
    }
}
#[test]
fn changed_original_context_digest_or_kernel_identity_never_becomes_a_snapshot() {
    for field in ["context", "input_digest", "kernel"] {
        let store = Store::new();
        let session = begin_kernel(&store, "changed", Host::new(&store));
        let mut row = store.value(journal_key("changed"));
        match field {
            "context" => row["context"]["route"] = json!("foreign-route"),
            "input_digest" => row["input_digest"] = json!("foreign-digest"),
            _ => row["kernel"]["owner"] = json!("foreign-owner"),
        }
        store.seed(journal_key("changed"), row.clone());
        assert!(run(session.currentness().checkpoint()).is_err());
        assert_eq!(store.value(journal_key("changed")), row);
    }
}
#[test]
fn live_session_refuses_a_released_actual_kernel_despite_an_unchanged_journal() {
    let store = Store::new();
    let session = begin_kernel(&store, "released", Host::new(&store));
    let before = store.value(journal_key("released"));
    let kernel: KernelReservation = serde_json::from_value(before["kernel"].clone()).unwrap();
    run(
        Authority::with_clock(store.clone(), store.clone(), store.clone()).settle_kernel(
            &kernel,
            gateway_authority::quota::KernelTerminal::Released,
            "fixture",
            NOW,
        ),
    )
    .unwrap();
    assert!(run(session.currentness().checkpoint()).is_err());
    assert_eq!(store.value(journal_key("released")), before);
}
#[test]
fn terminal_continuation_is_not_a_live_grant_and_unobserved_delivery_stays_independent() {
    let store = Store::new();
    let host = Host::new(&store);
    let session = begin_kernel(&store, "terminal", host.clone());
    let attempt = run(session.next_attempt()).unwrap().unwrap();
    run(session.before_dispatch(&attempt)).unwrap();
    run(session.transport_started(&attempt)).unwrap();
    let observation = TransportObservation {
        semantic_terminal: Some(SemanticTerminal::Completed),
        ..Default::default()
    };
    run(session.observe_terminal(&attempt, observation, AttemptUsage::default())).unwrap();
    store.advance(REQUEST_LEASE_MS + 1);
    host.cancelled.store(true, Ordering::SeqCst);
    let terminal = run(session.currentness().checkpoint()).unwrap();
    assert_eq!(terminal.state(), RoutingLeaseState::TerminalSettlement);
    let result = run(session.finish(observation)).unwrap();
    assert_eq!(result.observation.delivery, DeliveryOutcome::Unobserved);
    assert_eq!(
        run(session.currentness().checkpoint()).unwrap().state(),
        RoutingLeaseState::Settled
    );
}
#[test]
fn actual_attempt_identity_is_bound_to_the_session_that_created_it() {
    let store = Store::new();
    let session = begin_kernel(&store, "attempt", Host::new(&store));
    run(session.next_attempt()).unwrap().unwrap();
    let mut row = store.value(journal_key("attempt"));
    row["attempts"][0]["id"] = json!("foreign-attempt");
    row["active"] = json!("foreign-attempt");
    store.seed(journal_key("attempt"), row);
    assert!(run(session.currentness().checkpoint()).is_err());
}
#[test]
fn source_local_fallback_transfers_the_real_original_nonce_and_reservations() {
    let store = Store::new();
    let request = kernel_input(&store, "local-original");
    let source = SourceRequestDocument::new(request.raw.clone()).unwrap();
    let local = run(Session::begin_local_compaction(
        LocalAdmissionInput {
            metadata: LocalRequestMetadata {
                context: request.context,
                principal: request.principal,
                catalog: request.catalog,
                runtime: request.runtime,
                client_version: request.client_version,
                native_session_id: request.native_session_id,
                retry_prohibited: request.retry_prohibited,
            },
            original: source,
        },
        store.clone(),
        Host::new(&store),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    let session = run(Session::from_local_admission(
        run(local.resume_original()).unwrap(),
    ))
    .unwrap();
    assert_eq!(
        run(session.currentness().checkpoint()).unwrap().state(),
        RoutingLeaseState::Live
    );
    let mut row = store.value(journal_key("local-original"));
    row["local_work"]["owner_nonce"] = json!("foreign-nonce");
    store.seed(journal_key("local-original"), row);
    assert!(run(session.currentness().checkpoint()).is_err());
}

#[test]
fn changed_original_or_actual_api_reservation_is_not_current() {
    for actual in [false, true] {
        let store = Store::new();
        seed_key(&store);
        seed_pool(&store);
        let session = run(Session::begin(
            input("api-identity", "gpt-test", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        ))
        .unwrap();
        let attempt = run(session.next_attempt()).unwrap().unwrap();
        run(session.before_dispatch(&attempt)).unwrap();
        assert_eq!(
            run(session.currentness().checkpoint()).unwrap().state(),
            RoutingLeaseState::Live
        );
        let mut row = store.value(journal_key("api-identity"));
        if actual {
            let api: ApiReservation = serde_json::from_value(row["api"].clone()).unwrap();
            let key = keys::api_request(
                &api.key_id.0,
                &api.policy_version,
                api.window_start_ms,
                &api.request_id.0,
            );
            let mut reservation = store.value(key.clone());
            reservation["route"] = json!("foreign-route");
            store.seed(key, reservation);
        } else {
            row["api"]["policy_version"] = json!("foreign-policy");
            store.seed(journal_key("api-identity"), row);
        }
        assert!(run(session.currentness().checkpoint()).is_err());
        assert_eq!(window(&store)["committed_requests"], 1);
    }
}

#[test]
fn renewal_returns_actual_confirmed_deadline_and_refuses_expired_original_without_revival() {
    let store = Store::new();
    let host = Host::new(&store);
    let session = begin_kernel(&store, "actual-renew", host.clone());
    let old = run(session.currentness().checkpoint()).unwrap();
    store.advance(1000);
    let renewed = run(session.currentness().renew_kernel()).unwrap();
    assert_eq!(
        renewed.kernel_expires_at_ms(),
        Some(NOW + 1000 + REQUEST_LEASE_MS)
    );
    assert_eq!(
        renewed.request_expires_at_ms(),
        renewed.kernel_expires_at_ms().unwrap()
    );
    assert!(renewed.request_expires_at_ms() > old.request_expires_at_ms());
    store.advance(REQUEST_LEASE_MS);
    let before = store.value(journal_key("actual-renew"));
    assert!(run(session.currentness().renew_kernel()).is_err());
    assert_eq!(store.value(journal_key("actual-renew")), before);
    host.cancelled.store(true, Ordering::SeqCst);
    assert!(run(session.renew()).is_err());
    assert!(host.cancelled.load(Ordering::SeqCst));
}
