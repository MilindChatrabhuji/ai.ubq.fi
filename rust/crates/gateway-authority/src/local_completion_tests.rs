use super::*;
use crate::kernel::KernelWindow;
use gateway_core::identity::{ApiKeyId, PrincipalId, RequestContext, RequestId};
use gateway_core::source_control::{decode_source_control_record, encode_source_control_record};
use gateway_core::state::{
    AtomicTransition, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
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
    commits: Rc<RefCell<Vec<AtomicTransition>>>,
    lose_ack: Rc<Cell<bool>>,
    race_key: Rc<RefCell<Option<RecordKey>>>,
    race_insert: Rc<RefCell<Option<(RecordKey, StoredRecord)>>>,
}
impl TokenSource for Store {
    fn next_token(&self) -> Result<String, GatewayError> {
        let next = self.sequence.get() + 1;
        self.sequence.set(next);
        Ok(format!("fresh-{next}"))
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut rows = self.rows.borrow_mut();
        if let Some(key) = self.race_key.borrow_mut().take() {
            rows.get_mut(&key.0).unwrap().revision = "racing-revision".into();
        }
        if let Some((key, record)) = self.race_insert.borrow_mut().take() {
            rows.insert(key.0, record);
        }
        self.commits.borrow_mut().push(transition.clone());
        if transition.checks.iter().any(|check| {
            rows.get(&check.key.0).map(|row| &row.revision) != check.expected_revision.as_ref()
        }) {
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
                "Lost commit acknowledgement.",
                "fixture_lost_ack",
            ));
        }
        Ok(CommitOutcome::Committed)
    }
}
fn run<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}
struct Fixture {
    store: Store,
    plan: LocalCompletedJournalPlan,
    api: Option<ApiReservation>,
    kernel: Option<KernelReservation>,
}
fn fixture(with_api: bool, with_kernel: bool) -> Fixture {
    let store = Store::default();
    let context = RequestContext {
        request_id: RequestId("local-original".into()),
        principal: PrincipalId("principal".into()),
        key_id: with_api.then(|| ApiKeyId("key".into())),
        route: "responses".into(),
        started_at_ms: 100,
    };
    let api = with_api.then(|| ApiReservation {
        key_id: ApiKeyId("key".into()),
        request_id: context.request_id.clone(),
        route: context.route.clone(),
        policy_version: "policy".into(),
        window_start_ms: 0,
        window_reset_at_ms: 10_000,
        deferred: false,
    });
    let kernel = with_kernel.then(|| KernelReservation {
        v: 2,
        owner: "owner".into(),
        repo: Some("repo".into()),
        request_id: context.request_id.clone(),
        route: context.route.clone(),
        window_created_at_ms: 100,
        window_reset_at_ms: 10_000,
        reserved_at_ms: 1_000,
        lease_expires_at_ms: 1_200,
        terminal_intent: None,
        state: None,
        terminal_at_ms: None,
        release_reason: None,
    });
    let document = SourceJson::from_serializable(&serde_json::json!({
        "v":2,"context":context,"input_digest":"digest","api":api,"kernel":kernel,
        "cursor":0,"attempts":[],"active":null,"model_sibling_retries":0,"refreshed_versions":[],
        "recovery_attempted":false,"claude_unavailable":false,"semantic_committed":false,"terminal_intent":null,
        "finished":false,"recovering":false,"lease_expires_at_ms":1_200,"updated_at_ms":1_000,
        "extras_family":null,"extras_child_count":null,"extras_dispatch":null,"children":[],"kernel_override":null,
        "local_work":{"kind":"codex_responses_compaction","owner_nonce":"nonce","binding_version":2,"phase":"running","terminal":null}
    })).unwrap();
    let record = encode_source_control_record("journal-original", &document, None).unwrap();
    let plan =
        LocalCompletedJournalPlan::prepare(&record, &context, "digest", "nonce", 1_100).unwrap();
    store.rows.borrow_mut().insert(plan.journal_key().0, record);
    store.rows.borrow_mut().insert(
        plan.pending_key().0,
        StoredRecord::json(
            "journal-original:pending",
            serde_json::json!({"request_id":context.request_id.0}),
            None,
        ),
    );
    if let Some(api) = &api {
        let row = ApiUsageRequest {
            v: 3,
            key_id: api.key_id.clone(),
            request_id: api.request_id.clone(),
            route: api.route.clone(),
            state: ApiUsageState::Reserved,
            reserved_at_ms: 1_000,
            lease_expires_at_ms: 1_200,
            provider: None,
            dispatched_at_ms: None,
            released_at_ms: None,
            release_reason: None,
            transport_started: false,
        };
        store.rows.borrow_mut().insert(
            api_key(api).0,
            StoredRecord::json(
                "api-original",
                serde_json::to_value(row).unwrap(),
                Some(700_000),
            ),
        );
    }
    if let Some(kernel) = &kernel {
        store.rows.borrow_mut().insert(
            kernel_key(kernel).0,
            StoredRecord::json(
                "kernel-original",
                serde_json::to_value(kernel).unwrap(),
                Some(700_000),
            ),
        );
        let window = KernelWindow {
            v: 2,
            owner: kernel.owner.clone(),
            repo: kernel.repo.clone(),
            usage_requests: 0,
            reserved_requests: 1,
            created_at_ms: 100,
            usage_reset_at_ms: 10_000,
            applied_window_ms: 9_900,
            updated_at_ms: 1_000,
            reservations: BTreeMap::from([(kernel.request_id.0.clone(), 1_200)]),
        };
        store.rows.borrow_mut().insert(
            keys::kernel_window(&kernel.owner, kernel.repo.as_deref()).0,
            StoredRecord::json(
                "window-original",
                serde_json::to_value(window).unwrap(),
                Some(700_000),
            ),
        );
    }
    Fixture {
        store,
        plan,
        api,
        kernel,
    }
}
fn api_key(api: &ApiReservation) -> RecordKey {
    keys::api_request(
        &api.key_id.0,
        &api.policy_version,
        api.window_start_ms,
        &api.request_id.0,
    )
}
fn kernel_key(kernel: &KernelReservation) -> RecordKey {
    keys::kernel_request(
        &kernel.owner,
        kernel.repo.as_deref(),
        kernel.window_created_at_ms,
        &kernel.request_id.0,
    )
}
fn apply(fixture: &Fixture) -> Result<LocalCompletedIntentOutcome, GatewayError> {
    run(
        Authority::new(fixture.store.clone(), fixture.store.clone()).record_local_completed_intent(
            &fixture.plan,
            fixture.api.as_ref(),
            fixture.kernel.as_ref(),
            2_000,
        ),
    )
}
fn local_semantic(fixture: &Fixture) -> String {
    let row = fixture
        .store
        .rows
        .borrow()
        .get(&fixture.plan.journal_key().0)
        .cloned()
        .unwrap();
    let value = decode_source_control_record(&row).unwrap();
    source::member(
        &source::member(&source::member(&value, "local_work").unwrap(), "terminal").unwrap(),
        "semantic",
    )
    .unwrap()
    .deserialize()
    .unwrap()
}

#[test]
fn delayed_first_marker_is_one_joint_transition_without_quota_or_delivery_invention() {
    let f = fixture(true, true);
    assert!(matches!(
        apply(&f).unwrap(),
        LocalCompletedIntentOutcome::Applied
    ));
    assert_eq!(local_semantic(&f), "completed");
    let rows = f.store.rows.borrow();
    let kernel: KernelReservation = serde_json::from_value(
        rows[&kernel_key(f.kernel.as_ref().unwrap()).0]
            .json_value()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!(kernel.terminal_intent, Some(KernelTerminal::Committed));
    assert_eq!(kernel.state, None);
    let window: KernelWindow = serde_json::from_value(
        rows[&keys::kernel_window("owner", Some("repo")).0]
            .json_value()
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert_eq!((window.usage_requests, window.reserved_requests), (0, 1));
    let journal = &rows[&f.plan.journal_key().0];
    let pending = &rows[&f.plan.pending_key().0];
    assert_eq!(pending.revision, format!("{}:pending", journal.revision));
    assert_eq!((journal.expires_at_ms, pending.expires_at_ms), (None, None));
    assert_eq!(f.store.commits.borrow().len(), 1);
    assert_eq!(f.store.commits.borrow()[0].mutations.len(), 4);
}

#[test]
fn lost_ack_retains_borrowed_plan_and_reconciles_without_reapplying() {
    let f = fixture(true, true);
    f.store.lose_ack.set(true);
    assert!(matches!(
        apply(&f).unwrap(),
        LocalCompletedIntentOutcome::Unconfirmed(_)
    ));
    assert_eq!(local_semantic(&f), "completed");
    assert!(matches!(
        apply(&f).unwrap(),
        LocalCompletedIntentOutcome::AlreadyApplied
    ));
    assert!(f.store.commits.borrow()[1].mutations.is_empty());
}

#[test]
fn already_released_unused_api_is_source_compatible_but_started_dispatch_is_not() {
    let f = fixture(true, true);
    let key = api_key(f.api.as_ref().unwrap());
    {
        let mut rows = f.store.rows.borrow_mut();
        let row = rows.get_mut(&key.0).unwrap();
        let mut value: ApiUsageRequest =
            serde_json::from_value(row.json_value().unwrap().clone()).unwrap();
        value.state = ApiUsageState::Released;
        value.released_at_ms = Some(1_500);
        value.release_reason = Some("unused".into());
        *row = StoredRecord::json(
            "api-released",
            serde_json::to_value(value).unwrap(),
            Some(700_000),
        );
    }
    assert!(matches!(
        apply(&f).unwrap(),
        LocalCompletedIntentOutcome::Applied
    ));
    let blocked = fixture(true, true);
    let key = api_key(blocked.api.as_ref().unwrap());
    {
        let mut rows = blocked.store.rows.borrow_mut();
        let row = rows.get_mut(&key.0).unwrap();
        let mut value: ApiUsageRequest =
            serde_json::from_value(row.json_value().unwrap().clone()).unwrap();
        value.transport_started = true;
        *row = StoredRecord::json(
            "api-started",
            serde_json::to_value(value).unwrap(),
            Some(700_000),
        );
    }
    assert!(matches!(
        apply(&blocked).unwrap(),
        LocalCompletedIntentOutcome::Conflict
    ));
    assert!(blocked.store.commits.borrow().is_empty());
}

#[test]
fn every_original_row_revision_is_fenced_without_partial_intent() {
    for family in ["journal", "pending", "api", "kernel", "window"] {
        let f = fixture(true, true);
        let key = match family {
            "journal" => f.plan.journal_key(),
            "pending" => f.plan.pending_key(),
            "api" => api_key(f.api.as_ref().unwrap()),
            "kernel" => kernel_key(f.kernel.as_ref().unwrap()),
            _ => keys::kernel_window("owner", Some("repo")),
        };
        *f.store.race_key.borrow_mut() = Some(key);
        assert!(
            matches!(apply(&f).unwrap(), LocalCompletedIntentOutcome::Conflict),
            "{family}"
        );
        let rows = f.store.rows.borrow();
        let document = decode_source_control_record(&rows[&f.plan.journal_key().0]).unwrap();
        assert!(
            source::member(
                &source::member(&document, "local_work").unwrap(),
                "terminal"
            )
            .unwrap()
            .as_str()
                == "null"
        );
        let kernel: KernelReservation = serde_json::from_value(
            rows[&kernel_key(f.kernel.as_ref().unwrap()).0]
                .json_value()
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(kernel.terminal_intent, None);
    }
}

#[test]
fn genuine_no_kernel_or_api_data_shapes_use_only_existing_journal_rows() {
    for (api, kernel) in [(false, false), (true, false), (false, true)] {
        let f = fixture(api, kernel);
        assert!(matches!(
            apply(&f).unwrap(),
            LocalCompletedIntentOutcome::Applied
        ));
        assert!(matches!(
            apply(&f).unwrap(),
            LocalCompletedIntentOutcome::AlreadyApplied
        ));
        assert_eq!(local_semantic(&f), "completed");
    }
}

#[test]
fn conflicting_released_kernel_and_mixed_intents_are_never_repaired() {
    for mixed in [false, true] {
        let f = fixture(false, true);
        let key = kernel_key(f.kernel.as_ref().unwrap());
        let mut actual = f.kernel.as_ref().unwrap().clone();
        actual.terminal_intent = Some(if mixed {
            KernelTerminal::Committed
        } else {
            KernelTerminal::Released
        });
        if !mixed {
            actual.state = Some(KernelTerminal::Released);
            actual.terminal_at_ms = Some(1_500);
            actual.release_reason = Some("lease_expired".into());
        }
        f.store.rows.borrow_mut().insert(
            key.0,
            StoredRecord::json(
                "kernel-other",
                serde_json::to_value(actual).unwrap(),
                Some(700_000),
            ),
        );
        assert!(matches!(
            apply(&f).unwrap(),
            LocalCompletedIntentOutcome::Conflict
        ));
        assert!(f.store.commits.borrow().is_empty());
    }
}

#[test]
fn journal_data_cannot_redirect_another_requests_kernel_reservation() {
    let mut f = fixture(false, true);
    let mut kernel = f.kernel.take().unwrap();
    let old_key = kernel_key(&kernel);
    kernel.request_id = RequestId("different-original".into());
    let record = f
        .store
        .rows
        .borrow()
        .get(&f.plan.journal_key().0)
        .cloned()
        .unwrap();
    let mut document: serde_json::Value = decode_source_control_record(&record)
        .unwrap()
        .deserialize()
        .unwrap();
    document["kernel"] = serde_json::to_value(&kernel).unwrap();
    let document = SourceJson::from_serializable(&document).unwrap();
    let record = encode_source_control_record("journal-original", &document, None).unwrap();
    let context = f.plan.context().clone();
    f.plan =
        LocalCompletedJournalPlan::prepare(&record, &context, "digest", "nonce", 1_100).unwrap();
    {
        let mut rows = f.store.rows.borrow_mut();
        rows.insert(f.plan.journal_key().0, record);
        rows.remove(&old_key.0);
        rows.insert(
            kernel_key(&kernel).0,
            StoredRecord::json(
                "kernel-other",
                serde_json::to_value(&kernel).unwrap(),
                Some(700_000),
            ),
        );
    }
    f.kernel = Some(kernel);
    assert!(matches!(
        apply(&f).unwrap(),
        LocalCompletedIntentOutcome::Conflict
    ));
    assert!(f.store.commits.borrow().is_empty());
}

// Real authority admission/dispatch records, not a fabricated release receipt.
// The local Journal data fixture still does not mint a genuine runtime owner.
fn fixture_with_real_api_reservation() -> Fixture {
    let mut f = fixture(true, true);
    f.store
        .rows
        .borrow_mut()
        .remove(&api_key(f.api.as_ref().unwrap()).0);
    let policy = crate::quota::ApiKeyPolicy {
        v: 3,
        key_id: ApiKeyId("key".into()),
        expires_at_ms: -1,
        usage_limit_requests: 5,
        window_ms: 10_000,
        usage_reset_at_ms: 10_000,
        paid_fallback_enabled: false,
        paid_fallback_limit_microcredits: 0,
        paid_fallback_quota_per_credit: 1,
        paid_fallback_pricing_checked_at_ms: 0,
        paid_fallback_models: Vec::new(),
        paid_fallback_max_exposure_microcredits: BTreeMap::new(),
    };
    f.store.rows.borrow_mut().insert(
        keys::api_policy("key").0,
        StoredRecord::json("policy-source", serde_json::to_value(policy).unwrap(), None),
    );
    let actual = run(
        Authority::new(f.store.clone(), f.store.clone()).reserve_api_key(
            &ApiKeyId("key".into()),
            &f.plan.context().request_id,
            &f.plan.context().route,
            1_000,
        ),
    )
    .unwrap();
    let record = f
        .store
        .rows
        .borrow()
        .get(&f.plan.journal_key().0)
        .cloned()
        .unwrap();
    let mut document: serde_json::Value = decode_source_control_record(&record)
        .unwrap()
        .deserialize()
        .unwrap();
    document["api"] = serde_json::to_value(&actual).unwrap();
    let record = encode_source_control_record(
        "journal-original",
        &SourceJson::from_serializable(&document).unwrap(),
        None,
    )
    .unwrap();
    let context = f.plan.context().clone();
    f.plan =
        LocalCompletedJournalPlan::prepare(&record, &context, "digest", "nonce", 1_100).unwrap();
    f.store
        .rows
        .borrow_mut()
        .insert(f.plan.journal_key().0, record);
    f.api = Some(actual);
    f.store.commits.borrow_mut().clear();
    f
}
fn api_window_key(api: &ApiReservation) -> RecordKey {
    keys::api_window(&api.key_id.0, &api.policy_version, api.window_start_ms)
}
#[test]
fn missing_original_api_is_noop_and_recreated_row_loses_the_absence_fence() {
    let f = fixture_with_real_api_reservation();
    let api = f.api.as_ref().unwrap();
    let key = api_key(api);
    let window_key = api_window_key(api);
    f.store.rows.borrow_mut().remove(&key.0);
    let before = f.store.rows.borrow().get(&window_key.0).cloned();
    assert!(matches!(
        apply(&f).unwrap(),
        LocalCompletedIntentOutcome::Applied
    ));
    assert_eq!(f.store.rows.borrow().get(&window_key.0).cloned(), before);
    let commit = f.store.commits.borrow()[0].clone();
    assert!(
        commit
            .checks
            .iter()
            .any(|check| check.key == key && check.expected_revision.is_none())
    );
    assert!(!commit.mutations.iter().any(|mutation| matches!(mutation,RecordMutation::Put{key:k,..}|RecordMutation::Delete{key:k} if k==&key||k==&window_key)));
    let raced = fixture_with_real_api_reservation();
    let key = api_key(raced.api.as_ref().unwrap());
    let mut original = raced.store.rows.borrow_mut().remove(&key.0).unwrap();
    original.revision = "recreated-original".into();
    *raced.store.race_insert.borrow_mut() = Some((key, original));
    assert!(matches!(
        apply(&raced).unwrap(),
        LocalCompletedIntentOutcome::Conflict
    ));
    let rows = raced.store.rows.borrow();
    let journal = decode_source_control_record(&rows[&raced.plan.journal_key().0]).unwrap();
    assert_eq!(
        source::member(&source::member(&journal, "local_work").unwrap(), "terminal")
            .unwrap()
            .as_str(),
        "null"
    );
    assert_eq!(
        rows[&kernel_key(raced.kernel.as_ref().unwrap()).0]
            .json_value()
            .unwrap()["terminal_intent"],
        serde_json::Value::Null
    );
}
#[test]
fn real_dispatched_original_is_noop_with_no_api_compensation() {
    for started in [false, true] {
        let f = fixture_with_real_api_reservation();
        let api = f.api.as_ref().unwrap();
        let authority = Authority::new(f.store.clone(), f.store.clone());
        assert!(
            run(authority.dispatch_api_key(
                api,
                gateway_core::provider::UpstreamProvider::Surplus,
                1_500
            ))
            .unwrap()
        );
        if started {
            run(authority.mark_api_transport_started(api, 1_501)).unwrap();
        }
        assert!(
            !run(authority.release_api_key(
                api,
                false,
                "route_completed_without_provider_dispatch",
                1_600
            ))
            .unwrap()
        );
        let key = api_key(api);
        let window = api_window_key(api);
        let before = (
            f.store.rows.borrow()[&key.0].clone(),
            f.store.rows.borrow()[&window.0].clone(),
        );
        f.store.commits.borrow_mut().clear();
        assert!(matches!(
            apply(&f).unwrap(),
            LocalCompletedIntentOutcome::Applied
        ));
        assert_eq!(
            (
                f.store.rows.borrow()[&key.0].clone(),
                f.store.rows.borrow()[&window.0].clone()
            ),
            before
        );
        assert!(f.store.commits.borrow()[0].mutations.iter().all(|mutation| !matches!(mutation,RecordMutation::Put{key:k,..}|RecordMutation::Delete{key:k} if k==&key||k==&window)));
    }
}
#[test]
fn dispatched_foreign_or_malformed_original_never_becomes_local_intent() {
    for malformed in [false, true] {
        let f = fixture_with_real_api_reservation();
        let api = f.api.as_ref().unwrap();
        run(
            Authority::new(f.store.clone(), f.store.clone()).dispatch_api_key(
                api,
                gateway_core::provider::UpstreamProvider::Surplus,
                1_500,
            ),
        )
        .unwrap();
        let key = api_key(api);
        let mut actual: ApiUsageRequest =
            serde_json::from_value(f.store.rows.borrow()[&key.0].json_value().unwrap().clone())
                .unwrap();
        if malformed {
            actual.provider = None;
        } else {
            actual.request_id = RequestId("foreign-original".into());
        }
        f.store.rows.borrow_mut().insert(
            key.0,
            StoredRecord::json(
                "invalid-dispatch",
                serde_json::to_value(actual).unwrap(),
                Some(700_000),
            ),
        );
        f.store.commits.borrow_mut().clear();
        let outcome = apply(&f);
        if malformed {
            assert!(outcome.is_err());
        } else {
            assert!(matches!(
                outcome.unwrap(),
                LocalCompletedIntentOutcome::Conflict
            ));
        }
        assert!(f.store.commits.borrow().is_empty());
    }
}
