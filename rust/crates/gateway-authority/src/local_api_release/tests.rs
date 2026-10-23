use super::*;
use crate::{
    keys,
    quota::{ApiKeyPolicy, ApiUsageRequest, ApiUsageState},
};
use gateway_core::{
    identity::{ApiKeyId, RequestId},
    provider::UpstreamProvider,
    state::{AtomicTransition, CommitOutcome, RecordKey, RecordMutation, StoredRecord},
};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};
#[derive(Clone, Default)]
struct Store {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    sequence: Rc<Cell<u64>>,
    attempts: Rc<Cell<usize>>,
    reads: Rc<RefCell<Vec<RecordKey>>>,
    conflict: Rc<Cell<bool>>,
    read_error: Rc<RefCell<Option<GatewayError>>>,
    lose_ack: Rc<Cell<bool>>,
}
impl TokenSource for Store {
    fn next_token(&self) -> Result<String, GatewayError> {
        let n = self.sequence.get() + 1;
        self.sequence.set(n);
        Ok(format!("release-{n}"))
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.reads.borrow_mut().push(key.clone());
        if let Some(error) = self.read_error.borrow().as_ref() {
            return Err(error.clone());
        }
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.attempts.set(self.attempts.get() + 1);
        if self.conflict.get() {
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
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        if self.lose_ack.replace(false) {
            return Err(GatewayError::unavailable(
                "Synthetic lost acknowledgement",
                "fixture_lost_ack",
            ));
        }
        Ok(CommitOutcome::Committed)
    }
}
fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
            return v;
        }
    }
}
struct Fixture {
    store: Store,
    authority: Authority<Store, Store>,
    reservation: ApiReservation,
}
fn fixture(deferred: bool) -> Fixture {
    let store = Store::default();
    let authority = Authority::new(store.clone(), store.clone());
    let policy = ApiKeyPolicy {
        v: 3,
        key_id: ApiKeyId("key".into()),
        expires_at_ms: -1,
        usage_limit_requests: if deferred { 0 } else { 5 },
        window_ms: 10_000,
        usage_reset_at_ms: 10_000,
        paid_fallback_enabled: false,
        paid_fallback_limit_microcredits: 0,
        paid_fallback_quota_per_credit: 1,
        paid_fallback_pricing_checked_at_ms: 0,
        paid_fallback_models: Vec::new(),
        paid_fallback_max_exposure_microcredits: BTreeMap::new(),
    };
    store.rows.borrow_mut().insert(
        keys::api_policy("key").0,
        StoredRecord::json("policy", serde_json::to_value(policy).unwrap(), None),
    );
    let reservation = if deferred {
        run(authority.reserve_api_key_deferred(
            &ApiKeyId("key".into()),
            &RequestId("original".into()),
            "responses",
            1_000,
        ))
        .unwrap()
    } else {
        run(authority.reserve_api_key(
            &ApiKeyId("key".into()),
            &RequestId("original".into()),
            "responses",
            1_000,
        ))
        .unwrap()
    };
    store.attempts.set(0);
    store.reads.borrow_mut().clear();
    Fixture {
        store,
        authority,
        reservation,
    }
}
fn request(f: &Fixture) -> RecordKey {
    let r = &f.reservation;
    keys::api_request(
        &r.key_id.0,
        &r.policy_version,
        r.window_start_ms,
        &r.request_id.0,
    )
}
fn window(f: &Fixture) -> RecordKey {
    let r = &f.reservation;
    keys::api_window(&r.key_id.0, &r.policy_version, r.window_start_ms)
}
fn local_error(f: &Fixture) -> GatewayError {
    match run(f
        .authority
        .release_local_response_api(&f.reservation, 2_000))
    {
        Err(error) => error.as_gateway_error(),
        Ok(_) => panic!("expected actual release failure"),
    }
}
fn expected(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "api_key_quota_reservation_unavailable")
}
#[test]
fn local_malformed_preserves_public_diagnostic_without_exposing_generic_400() {
    for bad_decode in [false, true] {
        let f = fixture(false);
        let key = request(&f);
        if bad_decode {
            f.store.rows.borrow_mut().insert(
                key.0,
                StoredRecord::json("malformed", serde_json::Value::Null, None),
            );
        } else {
            f.store.rows.borrow_mut().remove(&window(&f).0);
        }
        let old = run(f.authority.release_api_key(
            &f.reservation,
            false,
            "route_completed_without_provider_dispatch",
            2_000,
        ))
        .unwrap_err();
        assert_eq!(
            old,
            crate::invalid(if bad_decode {
                "Malformed authority record."
            } else {
                "API quota aggregate is missing."
            })
        );
        assert_eq!(
            local_error(&f),
            expected("API key quota reservation is malformed")
        );
        assert_eq!(f.store.attempts.get(), 0);
    }
}
#[test]
fn exact_five_conflicts_keep_old_public_error_and_new_source_message() {
    let f = fixture(false);
    let before = f.store.rows.borrow().clone();
    f.store.conflict.set(true);
    assert_eq!(
        run(f
            .authority
            .release_api_key(&f.reservation, false, "same", 2_000))
        .unwrap_err(),
        GatewayError::unavailable(
            "API quota release changed concurrently.",
            "api_key_quota_reservation_unavailable"
        )
    );
    assert_eq!(f.store.attempts.get(), 5);
    f.store.attempts.set(0);
    assert_eq!(
        local_error(&f),
        expected("API key quota reservation changed concurrently")
    );
    assert_eq!(f.store.attempts.get(), 5);
    assert_eq!(*f.store.rows.borrow(), before);
}
#[test]
fn backend_origin_and_lost_ack_are_unavailable_not_an_invented_quota_400() {
    let f = fixture(false);
    let diagnostic =
        GatewayError::new(400, "Synthetic backend diagnostic", Some("fixture_backend"));
    *f.store.read_error.borrow_mut() = Some(diagnostic.clone());
    assert_eq!(
        run(f
            .authority
            .release_api_key(&f.reservation, false, "same", 2_000))
        .unwrap_err(),
        diagnostic
    );
    assert_eq!(
        local_error(&f),
        expected("API key quota reservation is unavailable")
    );
    let lost = fixture(false);
    lost.store.lose_ack.set(true);
    assert_eq!(
        local_error(&lost),
        expected("API key quota reservation is unavailable")
    );
    let row: ApiUsageRequest = serde_json::from_value(
        lost.store.rows.borrow()[&request(&lost).0]
            .json_value()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(row.state, ApiUsageState::Released);
    assert_eq!(lost.store.attempts.get(), 1);
}
#[test]
fn dispatched_missing_deferred_and_released_noops_never_compensate() {
    for branch in ["missing", "deferred", "released", "dispatched", "started"] {
        let f = fixture(branch == "deferred");
        match branch {
            "missing" => {
                f.store.rows.borrow_mut().remove(&request(&f).0);
            }
            "released" => {
                run(f
                    .authority
                    .release_api_key(&f.reservation, false, "prior", 1_100))
                .unwrap();
            }
            "dispatched" | "started" => {
                run(f
                    .authority
                    .dispatch_api_key(&f.reservation, UpstreamProvider::Surplus, 1_100))
                .unwrap();
                if branch == "started" {
                    run(f
                        .authority
                        .mark_api_transport_started(&f.reservation, 1_101))
                    .unwrap();
                }
            }
            _ => {}
        }
        let before = f.store.rows.borrow().clone();
        f.store.attempts.set(0);
        f.store.reads.borrow_mut().clear();
        assert!(
            !run(f
                .authority
                .release_local_response_api(&f.reservation, 2_000))
            .unwrap()
            .was_released()
        );
        assert_eq!(*f.store.rows.borrow(), before);
        assert_eq!(f.store.attempts.get(), 0);
        if branch == "deferred" {
            assert!(f.store.reads.borrow().is_empty());
        }
    }
}
#[test]
fn classified_release_reuses_the_same_reads_and_old_compensation_caller_is_unchanged() {
    let f = fixture(false);
    assert!(
        run(f
            .authority
            .release_local_response_api(&f.reservation, 2_000))
        .unwrap()
        .was_released()
    );
    let reads = f.store.reads.borrow();
    assert_eq!(reads.iter().filter(|k| **k == request(&f)).count(), 1);
    assert_eq!(reads.iter().filter(|k| **k == window(&f)).count(), 1);
    assert_eq!(f.store.attempts.get(), 1);
    let compensate = fixture(false);
    run(compensate.authority.dispatch_api_key(
        &compensate.reservation,
        UpstreamProvider::Surplus,
        1_100,
    ))
    .unwrap();
    assert!(
        run(compensate.authority.release_api_key(
            &compensate.reservation,
            true,
            "known-before-transport",
            1_200
        ))
        .unwrap()
    );
    let row: ApiUsageRequest = serde_json::from_value(
        compensate.store.rows.borrow()[&request(&compensate).0]
            .json_value()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(row.state, ApiUsageState::Released);
}
