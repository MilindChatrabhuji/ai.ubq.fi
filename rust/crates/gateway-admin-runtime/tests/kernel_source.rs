//! Real Rust administrative operations over a deterministic atomic test store;
//! these records are not live-runtime, signed-issuer or backend acceptance.
use gateway_admin::{AdminHost, AdminInput, AdminOperation, source_input as body};
use gateway_admin_runtime::{AdminRuntime, RuntimeConfig, capabilities::UnboundCapabilities};
use gateway_auth::{
    AuthHost, AuthMethod, AuthPrincipal, AuthResponse,
    upstream::{AuthUpstreamRequest, AuthUpstreamResponse},
    webauthn::{CosePublicKey, SignatureInput, WebAuthnCrypto},
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::*,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::*,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};
const NOW: i64 = 1_800_000_000_000;

#[derive(Clone, Default)]
struct Store {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    reject: Rc<Cell<usize>>,
    serial: Rc<Cell<u64>>,
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, t: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if self.reject.get() > 0 {
            self.reject.set(self.reject.get() - 1);
            return Ok(CommitOutcome::Conflict);
        }
        let mut rows = self.rows.borrow_mut();
        if t.checks
            .iter()
            .any(|c| rows.get(&c.key.0).map(|r| &r.revision) != c.expected_revision.as_ref())
        {
            return Ok(CommitOutcome::Conflict);
        }
        for m in t.mutations {
            match m {
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
        let validated = request.validate()?;
        let mut entries = Vec::new();
        for (key, record) in self.rows.borrow().iter() {
            let key = RecordKey(key.clone());
            if validated.accepts_record(&key, record)? {
                entries.push(QueryEntry {
                    key,
                    record: record.clone(),
                });
            }
        }
        if request.reverse {
            entries.reverse();
        }
        let more = entries.len() > request.limit as usize;
        entries.truncate(request.limit as usize);
        let next_cursor = if more {
            Some(validated.cursor_after(&entries.last().expect("positive bounded page").key)?)
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}
struct Clock;
impl gateway_authority::AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(NOW)
    }
}
impl gateway_authority::TokenSource for Store {
    fn next_token(&self) -> Result<String, GatewayError> {
        let n = self.serial.get() + 1;
        self.serial.set(n);
        Ok(format!("actual-authority-operation-{n}"))
    }
}
#[derive(Default)]
struct Host(Cell<u64>);
impl WebAuthnCrypto for Host {
    async fn validate_key(&self, _: &CosePublicKey) -> Result<(), GatewayError> {
        Err(unavailable())
    }
    async fn verify_signature(&self, _: SignatureInput) -> Result<bool, GatewayError> {
        Err(unavailable())
    }
}
fn error(value: Result<AuthResponse, GatewayError>) -> GatewayError {
    match value {
        Err(e) => e,
        Ok(_) => panic!("expected source operation failure"),
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Unrequested authentication/network fixture",
        "fixture_unavailable",
    )
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        NOW
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.0.get() + 1;
        self.0.set(n);
        Ok((0..len).map(|i| (n + i as u64) as u8).collect())
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(unavailable())
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(unavailable())
    }
}
fn run<F: Future>(future: F) -> F::Output {
    let mut cx = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::yield_now();
    }
}
fn input(document: SourceJson) -> AdminInput {
    AdminInput {
        parameter: None,
        query: BTreeMap::new(),
        body: document,
        actor: AuthPrincipal {
            token: None,
            method: AuthMethod::AdminAllowlist,
            is_admin: true,
            is_super_admin: false,
        },
        request_id: "kernel-source-data-fixture".into(),
        now_ms: NOW,
    }
}
fn wire(response: AuthResponse) -> SourceJson {
    assert_eq!(response.status, 200);
    SourceJson::parse_bytes(&response.body.to_bytes().unwrap()).unwrap()
}
fn equal(actual: &SourceJson, expected: &SourceJson) {
    assert_eq!(
        source::canonical(actual).unwrap(),
        source::canonical(expected).unwrap()
    );
}
#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Label {
    owner: JsString16,
    repo: Option<JsString16>,
}
#[derive(Deserialize)]
struct Response {
    status: u16,
    body: SourceJson,
}
#[derive(Deserialize)]
struct Lookup {
    query: BTreeMap<String, String>,
    status: u16,
    body: SourceJson,
}
#[derive(Deserialize)]
struct Delete {
    status: u16,
    body: SourceJson,
    window: SourceJson,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    scope: String,
    labels: Vec<Label>,
    writes: Vec<Response>,
    policy: SourceJson,
    window: SourceJson,
    policy_key: String,
    window_key: String,
    list: SourceJson,
    lookups: Vec<Lookup>,
    deletes: Vec<Delete>,
}
fn selector(label: &Label, scope: &str, set: bool) -> SourceJson {
    let mut fields = vec![
        ("scope", body::json(scope)),
        ("owner", body::json(&label.owner)),
    ];
    if let Some(repo) = &label.repo {
        fields.push(("repo", body::json(repo)));
    }
    if set {
        fields.extend([
            ("usage_limit_requests", body::json(&7)),
            ("window_ms", body::json(&60000)),
            ("reset_usage", body::json(&true)),
        ]);
    }
    body::object(fields)
}

#[test]
fn actual_source_kernel_admin_twelve_families_preserve_writer_records_envelopes_and_collisions() {
    let fixture: Fixture = SourceJson::parse(include_str!("fixtures/kernel-source-admin.json"))
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(fixture.cases.len(), 12);
    for case in fixture.cases {
        let store = Store::default();
        let host = Host::default();
        let config = RuntimeConfig::default();
        let runtime = AdminRuntime {
            store: &store,
            host: &host,
            capabilities: &UnboundCapabilities,
            config: &config,
        };
        let mut first = None;
        for (i, label) in case.labels.iter().enumerate() {
            let result = run(runtime.execute(
                AdminOperation::KernelUsageSet,
                input(selector(label, &case.scope, true)),
            ));
            if case.writes[i].status == 200 {
                equal(&wire(result.unwrap()), &case.writes[i].body);
                first = Some(store.rows.borrow().clone());
            } else {
                let failure = error(result);
                assert_eq!(failure.status, case.writes[i].status);
                equal(&body::json(&failure.envelope), &case.writes[i].body);
                assert_eq!(*store.rows.borrow(), first.clone().unwrap());
            }
        }
        let rows = store.rows.borrow().clone();
        assert_eq!(rows.len(), 2);
        for (key, expected) in [
            (&case.policy_key, &case.policy),
            (&case.window_key, &case.window),
        ] {
            let record = &rows[key];
            assert_eq!(record.expires_at_ms, None);
            equal(&decode_source_control_record(record).unwrap(), expected);
        }
        let mut listed = input(body::json(&json!({})));
        listed.query = BTreeMap::from([
            ("scope".into(), vec![case.scope.clone()]),
            ("list".into(), vec!["1".into()]),
        ]);
        equal(
            &wire(run(runtime.execute(AdminOperation::KernelUsageGet, listed)).unwrap()),
            &case.list,
        );
        for lookup in case.lookups {
            let mut request = input(body::json(&json!({})));
            request.query = lookup
                .query
                .into_iter()
                .map(|(k, v)| (k, vec![v]))
                .collect();
            let result = run(runtime.execute(AdminOperation::KernelUsageGet, request));
            if lookup.status == 200 {
                equal(&wire(result.unwrap()), &lookup.body);
            } else {
                let failure = error(result);
                assert_eq!(failure.status, lookup.status);
                equal(&body::json(&failure.envelope), &lookup.body);
            }
        }
        // This artifact is emitted from real named Rust operations only after all
        // source value/key/revision/expiry and exact response assertions above.
        println!(
            "M47_ACTUAL_ADMIN_SOURCE_WRITER_FIXTURE={}",
            serde_json::to_string(&(case.id.clone(), &rows)).unwrap()
        );
        for (i, deleted) in case.deletes.into_iter().enumerate() {
            let result = run(runtime.execute(
                AdminOperation::KernelUsageDelete,
                input(selector(&case.labels[i], &case.scope, false)),
            ));
            if deleted.status == 200 {
                equal(&wire(result.unwrap()), &deleted.body);
                let rows = store.rows.borrow();
                assert_eq!(rows.len(), 1);
                let row = &rows[&case.window_key];
                assert_eq!(row.expires_at_ms, None);
                equal(&decode_source_control_record(row).unwrap(), &deleted.window);
            } else {
                let failure = error(result);
                assert_eq!(failure.status, deleted.status);
                equal(&body::json(&failure.envelope), &deleted.body);
            }
        }
    }
}

#[test]
fn nonreset_admin_preserves_actual_index_and_cas_while_live_retention_remains_original() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &UnboundCapabilities,
        config: &config,
    };
    let label = Label {
        owner: "owner".into(),
        repo: Some("repo".into()),
    };
    run(runtime.execute(
        AdminOperation::KernelUsageSet,
        input(selector(&label, "repo", true)),
    ))
    .unwrap();
    let authority = gateway_authority::Authority::with_clock(store.clone(), store.clone(), Clock);
    let reservation = run(authority.reserve_kernel(
        "owner",
        "repo",
        &gateway_core::identity::RequestId("real-reservation".into()),
        "responses",
        NOW,
    ))
    .unwrap();
    let key = gateway_authority::keys::kernel_window("owner", Some("repo"));
    let live = store.rows.borrow()[&key.0].clone();
    assert_eq!(
        live.expires_at_ms,
        Some(NOW + 60000 + gateway_authority::QUOTA_RETENTION_MS)
    );
    let index = live.value["reservations"].clone();
    let mut change = selector(&label, "repo", false);
    body::set(&mut change, "usage_limit_requests", body::json(&8));
    run(runtime.execute(AdminOperation::KernelUsageSet, input(change.clone()))).unwrap();
    let edited = store.rows.borrow()[&key.0].clone();
    assert_eq!(edited.expires_at_ms, None);
    assert_eq!(edited.value["reservations"], index);
    for op in [
        AdminOperation::KernelUsageSet,
        AdminOperation::KernelUsageDelete,
    ] {
        let before = store.rows.borrow().clone();
        let request = if op == AdminOperation::KernelUsageSet {
            selector(&label, "repo", true)
        } else {
            selector(&label, "repo", false)
        };
        assert_eq!(error(run(runtime.execute(op, input(request)))).status, 409);
        assert_eq!(*store.rows.borrow(), before);
    }
    let before = store.rows.borrow().clone();
    store.reject.set(3);
    assert_eq!(
        error(run(
            runtime.execute(AdminOperation::KernelUsageSet, input(change))
        ))
        .status,
        409
    );
    assert_eq!(*store.rows.borrow(), before);
    run(authority.record_kernel_terminal_intent(
        &reservation,
        gateway_authority::quota::KernelTerminal::Committed,
        NOW,
    ))
    .unwrap();
    assert_eq!(
        store.rows.borrow()[&key.0].expires_at_ms,
        Some(NOW + 60000 + gateway_authority::QUOTA_RETENTION_MS)
    );
}

#[test]
fn positive_mapless_source_view_is_not_a_writable_or_live_bound_window() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &UnboundCapabilities,
        config: &config,
    };
    let label = Label {
        owner: "owner".into(),
        repo: Some("repo".into()),
    };
    run(runtime.execute(
        AdminOperation::KernelUsageSet,
        input(selector(&label, "repo", true)),
    ))
    .unwrap();
    let key = gateway_authority::keys::kernel_window("owner", Some("repo"));
    let before = store.rows.borrow()[&key.0].clone();
    let mut document = decode_source_control_record(&before).unwrap();
    body::set(&mut document, "reserved_requests", body::json(&1));
    store.rows.borrow_mut().insert(
        key.0.clone(),
        encode_source_control_record("unbound-source", &document, None).unwrap(),
    );
    let mut request = input(body::json(&json!({})));
    request.query = BTreeMap::from([
        ("owner".into(), vec!["owner".into()]),
        ("repo".into(), vec!["repo".into()]),
    ]);
    let public = wire(run(runtime.execute(AdminOperation::KernelUsageGet, request)).unwrap());
    let limit = body::member(&public, "limit").unwrap();
    assert!(body::member(&limit, "reservations").is_none());
    let state = store.rows.borrow().clone();
    let authority = gateway_authority::Authority::with_clock(store.clone(), store.clone(), Clock);
    assert!(
        run(authority.reserve_kernel(
            "owner",
            "repo",
            &gateway_core::identity::RequestId("unbound".into()),
            "responses",
            NOW
        ))
        .is_err()
    );
    assert_eq!(*store.rows.borrow(), state);
    assert_eq!(
        error(run(runtime.execute(
            AdminOperation::KernelUsageDelete,
            input(selector(&label, "repo", false))
        )))
        .status,
        409
    );
    assert_eq!(*store.rows.borrow(), state);
}

#[test]
fn queue_keeps_original_broader_labels_and_actual_source_presence_filter() {
    #[derive(Deserialize)]
    struct QueueFixture {
        input_rows: SourceJson,
        initial_response: Response,
        policy_owner: JsString16,
        policy_value: SourceJson,
        filtered_response: Response,
    }
    let fixture: QueueFixture =
        SourceJson::parse(include_str!("fixtures/kernel-source-queue.json"))
            .unwrap()
            .deserialize()
            .unwrap();
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &UnboundCapabilities,
        config: &config,
    };
    let key = gateway_auth::store::key(json!(["uos_ai", "kernel_policy_queue"]));
    store.rows.borrow_mut().insert(
        key.0,
        encode_source_control_record("actual-queue-input", &fixture.input_rows, None).unwrap(),
    );
    equal(
        &wire(
            run(runtime.execute(AdminOperation::KernelQueue, input(body::json(&json!({})))))
                .unwrap(),
        ),
        &fixture.initial_response.body,
    );
    let key = gateway_authority::keys::kernel_policy_source(&fixture.policy_owner, None).unwrap();
    store.rows.borrow_mut().insert(
        key.0,
        encode_source_control_record("source-presence-only", &fixture.policy_value, None).unwrap(),
    );
    equal(
        &wire(
            run(runtime.execute(AdminOperation::KernelQueue, input(body::json(&json!({})))))
                .unwrap(),
        ),
        &fixture.filtered_response.body,
    );
}

#[test]
fn source_policy_list_comparison_failure_publishes_no_partial_or_lexical_result() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &UnboundCapabilities,
        config: &config,
    };
    for owner in ["z", "a"] {
        let label = Label {
            owner: owner.into(),
            repo: Some("repo".into()),
        };
        run(runtime.execute(
            AdminOperation::KernelUsageSet,
            input(selector(&label, "repo", true)),
        ))
        .unwrap();
    }
    let before = store.rows.borrow().clone();
    let mut query = input(body::json(&json!({})));
    query.query = BTreeMap::from([("list".into(), vec!["1".into()])]);
    let failure = error(run(runtime.execute(AdminOperation::KernelUsageGet, query)));
    assert_eq!(failure.status, 503);
    assert_eq!(*store.rows.borrow(), before);
}

#[test]
fn admin_selector_boundary_is_not_the_queue_predicate_and_source_expiry_stays_a_number() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &UnboundCapabilities,
        config: &config,
    };
    let label = Label {
        owner: JsString16::from_utf8(&"x".repeat(100)),
        repo: Some("repo".into()),
    };
    let mut request = selector(&label, "repo", true);
    body::set(&mut request, "scope", body::json(&serde_json::Value::Null));
    body::set(
        &mut request,
        "expires_at_ms",
        SourceJson::parse("1e100").unwrap(),
    );
    let response =
        wire(run(runtime.execute(AdminOperation::KernelUsageSet, input(request))).unwrap());
    let limit = body::member(&response, "limit").unwrap();
    assert_eq!(
        body::number(&body::member(&limit, "expires_at_ms").unwrap()),
        Some(1e100)
    );
    for owner in [
        "x".repeat(101),
        "owner/repo".into(),
        "owner with space".into(),
        " ".into(),
    ] {
        let bad = Label {
            owner: JsString16::from_utf8(&owner),
            repo: Some("repo".into()),
        };
        assert_eq!(
            error(run(runtime.execute(
                AdminOperation::KernelUsageSet,
                input(selector(&bad, "repo", true))
            )))
            .status,
            400
        );
    }
}

#[test]
fn inherited_active_org_index_is_not_discarded_by_source_repo_policy_creation() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let runtime = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &UnboundCapabilities,
        config: &config,
    };
    let org = Label {
        owner: "owner".into(),
        repo: None,
    };
    run(runtime.execute(
        AdminOperation::KernelUsageSet,
        input(selector(&org, "org", true)),
    ))
    .unwrap();
    let authority = gateway_authority::Authority::with_clock(store.clone(), store.clone(), Clock);
    let reservation = run(authority.reserve_kernel(
        "owner",
        "repo",
        &gateway_core::identity::RequestId("actual-org-reservation".into()),
        "responses",
        NOW,
    ))
    .unwrap();
    assert!(reservation.repo.is_none());
    let before = store.rows.borrow().clone();
    let repo = Label {
        owner: "owner".into(),
        repo: Some("repo".into()),
    };
    assert_eq!(
        error(run(runtime.execute(
            AdminOperation::KernelUsageSet,
            input(selector(&repo, "repo", true))
        )))
        .status,
        409
    );
    assert_eq!(*store.rows.borrow(), before);
}
