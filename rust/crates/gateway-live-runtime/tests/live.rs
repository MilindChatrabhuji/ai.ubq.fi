use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

use gateway_auth::{AuthMethod, AuthPrincipal, crypto::Secret};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
};
use gateway_live_runtime::{
    mapping::{LiveRuntime, RetirementOutcome, mapping_key, retirement_key},
    protocol::{
        LiveRoute, call_id_from_location, encode_call_id, live_route, principal_id,
        validate_body_read, validate_declared_length,
    },
    runtime::SidebandParts,
    types::{
        LIVE_CALL_CAPTURED_ERROR_MAX_BYTES, LiveAccount, LiveCreateInput, LiveCreateRequest,
        LiveDispatchAttempt, LiveDispatchFailure, LiveHost, LiveResponse,
    },
};
use serde_json::{Value, json};

fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
}

type ReadHook = (RecordKey, Box<dyn Fn()>);
#[derive(Default)]
struct Store {
    rows: RefCell<BTreeMap<String, StoredRecord>>,
    revision: Cell<u64>,
    fail_reads: Cell<bool>,
    fail_put: Cell<bool>,
    fail_delete: Cell<bool>,
    unknown_put: Cell<bool>,
    after_read: RefCell<Option<ReadHook>>,
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        if self.fail_reads.get() {
            return Err(unavailable());
        }
        let result = self.rows.borrow().get(&key.0).cloned();
        let hook = if self
            .after_read
            .borrow()
            .as_ref()
            .is_some_and(|(target, _)| target == key)
        {
            self.after_read.borrow_mut().take()
        } else {
            None
        };
        if let Some((_, hook)) = hook {
            hook();
        }
        Ok(result)
    }
    async fn commit(&self, change: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let put = change
            .mutations
            .iter()
            .any(|m| matches!(m, RecordMutation::Put { .. }));
        if (put && self.fail_put.get()) || (!put && self.fail_delete.get()) {
            return Err(unavailable());
        }
        if change.mutations.iter().any(|mutation| matches!(mutation, RecordMutation::Put { record, .. } if record.revision.is_empty())) {
            return Err(unavailable());
        }
        let mut rows = self.rows.borrow_mut();
        if change.checks.iter().any(|check| {
            rows.get(&check.key.0).map(|v| &v.revision) != check.expected_revision.as_ref()
        }) {
            return Ok(CommitOutcome::Conflict);
        }
        for mutation in change.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        if put && self.unknown_put.replace(false) {
            return Err(unavailable());
        }
        Ok(CommitOutcome::Committed)
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable("synthetic storage unavailable", "fixture_unavailable")
}

#[derive(Clone)]
struct Account {
    id: String,
    generation: u32,
}
impl LiveAccount for Account {
    fn account_id(&self) -> &str {
        &self.id
    }
}
type UpstreamResult = Result<LiveResponse<Vec<u8>>, LiveDispatchFailure<Vec<u8>>>;
type CapturedRequest = (String, String, BTreeMap<String, String>);
struct Host {
    now: Cell<i64>,
    selected: RefCell<VecDeque<Result<Account, LiveResponse<Vec<u8>>>>>,
    upstream: RefCell<VecDeque<UpstreamResult>>,
    requests: RefCell<Vec<CapturedRequest>>,
    events: RefCell<Vec<String>>,
    generation: Cell<u32>,
    removed: Cell<bool>,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            now: Cell::new(10_000),
            selected: RefCell::new(VecDeque::new()),
            upstream: RefCell::new(VecDeque::new()),
            requests: RefCell::new(Vec::new()),
            events: RefCell::new(Vec::new()),
            generation: Cell::new(1),
            removed: Cell::new(false),
        }
    }
}
impl LiveHost for Host {
    type Account = Account;
    type Body = Vec<u8>;
    type Cancellation = bool;
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn user_agent(&self) -> String {
        "fixture-user-agent".into()
    }
    fn body_from_bytes(&self, body: Vec<u8>) -> Vec<u8> {
        body
    }
    async fn select_account(
        &self,
        _model: Option<&JsString16>,
        attempted: &[String],
        _cancel: &bool,
    ) -> Result<Account, LiveResponse<Vec<u8>>> {
        self.events
            .borrow_mut()
            .push(format!("select:{}", attempted.len()));
        self.selected
            .borrow_mut()
            .pop_front()
            .unwrap_or_else(|| Ok(account("a", self.generation.get())))
    }
    async fn current_account(&self, id: &str) -> Result<Account, LiveResponse<Vec<u8>>> {
        self.events.borrow_mut().push(format!("current:{id}"));
        if self.removed.get() {
            Err(response(404, "missing account", None))
        } else {
            Ok(account(id, self.generation.get()))
        }
    }
    async fn dispatch_create(
        &self,
        account: &Account,
        request: LiveCreateRequest,
        cancel: &bool,
    ) -> Result<LiveResponse<Vec<u8>>, LiveDispatchFailure<Vec<u8>>> {
        if *cancel {
            return Err(LiveDispatchFailure {
                response: response(502, "cancelled", None),
                attempt: LiveDispatchAttempt::NotStarted,
            });
        }
        self.requests.borrow_mut().push((
            account.id.clone(),
            request.body.as_str().into(),
            request.headers,
        ));
        self.upstream.borrow_mut().pop_front().unwrap_or_else(|| {
            Ok(response(
                201,
                "answer-sdp",
                Some("https://upstream/v1/realtime/calls/rtc_created?secret=removed"),
            ))
        })
    }
    async fn invalidate_credential(&self, account: &Account) -> Result<(), GatewayError> {
        self.events
            .borrow_mut()
            .push(format!("invalid:{}", account.id));
        Ok(())
    }
    async fn response_health(&self, account: &Account, response: &LiveResponse<Vec<u8>>) {
        self.events
            .borrow_mut()
            .push(format!("health:{}:{}", account.id, response.status));
    }
    async fn transport_health(&self, _account: &Account, failure: &LiveDispatchFailure<Vec<u8>>) {
        self.events
            .borrow_mut()
            .push(format!("transport:{:?}", failure.attempt));
    }
    async fn await_routing_transition(&self) {
        self.events.borrow_mut().push("transition".into());
    }
    async fn capture_retry(
        &self,
        mut response: LiveResponse<Vec<u8>>,
        _cancel: &bool,
    ) -> LiveResponse<Vec<u8>> {
        self.events.borrow_mut().push("capture".into());
        response.body.truncate(LIVE_CALL_CAPTURED_ERROR_MAX_BYTES);
        response.headers.retain(|name, _| name == "content-type");
        response
    }
}
fn account(id: &str, generation: u32) -> Account {
    Account {
        id: id.into(),
        generation,
    }
}
fn response(status: u16, text: &str, location: Option<&str>) -> LiveResponse<Vec<u8>> {
    let mut headers = BTreeMap::from([
        ("content-type".into(), "application/sdp".into()),
        ("x-provider-private".into(), "not-relayed".into()),
    ]);
    if let Some(location) = location {
        headers.insert("location".into(), location.into());
    }
    LiveResponse {
        status,
        status_text: Some("source status".into()),
        headers,
        body: text.as_bytes().into(),
    }
}
fn principal() -> AuthPrincipal {
    AuthPrincipal {
        token: None,
        method: AuthMethod::AuthTokensAllowlist,
        is_admin: false,
        is_super_admin: false,
    }
}
fn input() -> LiveCreateInput {
    LiveCreateInput {
        content_type: "multipart/form-data; boundary=fixture".into(),
        sdp: Some("sdp-offer".into()),
        session: Some(r#"{"model":"voice-model","unknown":{"keep":true}}"#.into()),
        headers: BTreeMap::new(),
    }
}
fn fixture() -> (Rc<Store>, LiveRuntime<Store>, Host) {
    let store = Rc::new(Store::default());
    let runtime = runtime_for(store.clone());
    (store, runtime, Host::default())
}

fn runtime_for(store: Rc<Store>) -> LiveRuntime<Store> {
    let counter = store.clone();
    LiveRuntime::new(
        store,
        Rc::new(move || {
            let next = counter.revision.get() + 1;
            counter.revision.set(next);
            Ok(format!("live-fixture-{next}"))
        }),
    )
}
fn create(runtime: &LiveRuntime<Store>, host: &Host) {
    assert_eq!(
        run(runtime.create_call(&principal(), input(), host, &false)).status,
        201
    );
}
fn prepared(runtime: &LiveRuntime<Store>, host: &Host) -> SidebandParts<Store, Account> {
    run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", host))
        .unwrap()
        .into_parts()
}

#[test]
fn source_routes_location_and_byte_limits() {
    assert_eq!(live_route("POST", "/v1/live///"), Some(LiveRoute::Create));
    assert_eq!(
        live_route("GET", "/v1/live/rtc_a%2Fb"),
        Some(LiveRoute::Sideband("rtc_a/b".into()))
    );
    for path in [
        "/v1/live/%",
        "/v1/live/%ED%A0%80",
        "/v1/live/..",
        "/v1/live/%2e",
        "/v1/live/a/b",
    ] {
        assert_eq!(live_route("GET", path), None);
    }
    assert_eq!(encode_call_id("rtc_a/b !'()"), "rtc_a%2Fb%20!'()");
    assert_eq!(
        call_id_from_location(
            "https://host/rtc_first/other/00000000-0000-0000-0000-000000000000?x"
        ),
        Some("00000000-0000-0000-0000-000000000000".into())
    );
    assert_eq!(call_id_from_location("https://host/rtc_/bad"), None);
    for bad in ["01", "-1", "+1", "1.0", "1e3", ""] {
        assert_eq!(validate_declared_length(Some(bad)).unwrap_err().status, 400);
    }
    assert!(validate_declared_length(Some(" 1048576 ")).is_ok());
    assert_eq!(
        validate_declared_length(Some("1048577"))
            .unwrap_err()
            .status,
        413
    );
    assert_eq!(
        validate_body_read(1_048_577, false).unwrap_err().status,
        413
    );
    assert_eq!(validate_body_read(1, false).unwrap_err().status, 400);
}

#[test]
fn source_creation_preserves_session_and_fixed_header_allowlist() {
    let (store, runtime, host) = fixture();
    let mut request = input();
    request.headers = BTreeMap::from([
        ("authorization".into(), "client-bearer-not-provider".into()),
        ("openai-alpha".into(), "  source-alpha  ".into()),
        ("x-session-id".into(), "session".into()),
        ("thread-id".into(), "  ".into()),
        ("x-oai-attestation".into(), "attestation".into()),
    ]);
    let result = run(runtime.create_call(&principal(), request, &host, &false));
    assert_eq!(result.body, b"answer-sdp");
    assert_eq!(result.status_text.as_deref(), Some("source status"));
    assert_eq!(
        result.headers.get("location").map(String::as_str),
        Some("/v1/live/rtc_created")
    );
    assert!(!result.headers.contains_key("x-provider-private"));
    let requests = host.requests.borrow();
    let (_, body, headers) = &requests[0];
    assert_eq!(
        serde_json::from_str::<Value>(body).unwrap(),
        json!({"sdp":"sdp-offer","session":{"model":"voice-model","unknown":{"keep":true}}})
    );
    assert!(!headers.contains_key("authorization"));
    assert_eq!(headers["openai-alpha"], "  source-alpha  ");
    assert_eq!(headers["originator"], "codex_cli_rs");
    assert!(!headers.contains_key("thread-id"));
    let row = run(store.read(&mapping_key("rtc_created")))
        .unwrap()
        .unwrap();
    assert_eq!(
        row.value,
        json!({"account_id":"a","principal_id":"auth-method:auth_tokens_allowlist","created_at_ms":10000})
    );
    assert_eq!(row.expires_at_ms, Some(3_610_000));
}

#[test]
fn source_js_json_duplicate_numbers_order_and_lone_surrogates_are_lossless() {
    let (_, runtime, host) = fixture();
    let mut request = input();
    request.session = Some(r#"{"z":1,"2":"two","0":"zero","z":9007199254740993,"negative":-0,"infinity":1e400,"text":"\ud800"}"#.into());
    assert_eq!(
        run(runtime.create_call(&principal(), request, &host, &false)).status,
        201
    );
    assert_eq!(
        host.requests.borrow()[0].1,
        r#"{"sdp":"sdp-offer","session":{"0":"zero","2":"two","z":9007199254740992,"negative":0,"infinity":null,"text":"\ud800"}}"#
    );
}

#[test]
fn missing_parts_and_nonobject_session_never_dispatch() {
    let (_, runtime, host) = fixture();
    for session in [
        None,
        Some("[]".into()),
        Some("null".into()),
        Some("{".into()),
    ] {
        let mut request = input();
        request.session = session;
        assert_eq!(
            run(runtime.create_call(&principal(), request, &host, &false)).status,
            400
        );
    }
    let mut request = input();
    request.sdp = Some(String::new());
    let error = run(runtime.create_call(&principal(), request, &host, &false));
    assert_eq!(
        serde_json::from_slice::<Value>(&error.body).unwrap()["error"]["param"],
        "sdp"
    );
    assert!(host.requests.borrow().is_empty());
}

#[test]
fn only_credential_failures_retry_and_fence_before_health_then_transition() {
    let (_, runtime, host) = fixture();
    host.selected
        .borrow_mut()
        .extend([Ok(account("a", 1)), Ok(account("b", 1))]);
    host.upstream.borrow_mut().extend([
        Ok(response(401, "first failure", None)),
        Ok(response(201, "answer", Some("/rtc_second"))),
    ]);
    assert_eq!(
        run(runtime.create_call(&principal(), input(), &host, &false)).status,
        201
    );
    assert_eq!(
        *host.events.borrow(),
        [
            "select:0",
            "invalid:a",
            "health:a:401",
            "transition",
            "capture",
            "select:1",
            "health:b:201"
        ]
    );
    assert_eq!(
        host.requests
            .borrow()
            .iter()
            .map(|r| r.0.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
    for status in [429, 500, 502, 504] {
        let (_, runtime, host) = fixture();
        host.upstream
            .borrow_mut()
            .push_back(Ok(response(status, "source failure", None)));
        assert_eq!(
            run(runtime.create_call(&principal(), input(), &host, &false)).status,
            status
        );
        assert_eq!(host.requests.borrow().len(), 1);
        assert!(!host.events.borrow().iter().any(|e| e == "capture"));
    }
}

#[test]
fn captured_first_failure_wins_over_second_selection_or_unknown_dispatch() {
    for transport in [false, true] {
        let (_, runtime, host) = fixture();
        host.selected.borrow_mut().push_back(Ok(account("a", 1)));
        host.upstream
            .borrow_mut()
            .push_back(Ok(response(403, "captured-first", None)));
        if transport {
            host.selected.borrow_mut().push_back(Ok(account("b", 2)));
            host.upstream
                .borrow_mut()
                .push_back(Err(LiveDispatchFailure {
                    response: response(502, "unknown-second-call", None),
                    attempt: LiveDispatchAttempt::Started,
                }));
        } else {
            host.selected
                .borrow_mut()
                .push_back(Err(response(429, "no capacity", None)));
        }
        let result = run(runtime.create_call(&principal(), input(), &host, &false));
        assert_eq!(result.status, 403);
        assert_eq!(result.body, b"captured-first");
        if transport {
            assert!(host.events.borrow().contains(&"transport:Started".into()));
        }
    }
}

#[test]
fn cancelled_before_dispatch_and_unknown_after_dispatch_never_retry() {
    let (store, runtime, host) = fixture();
    assert_eq!(
        run(runtime.create_call(&principal(), input(), &host, &true)).status,
        502
    );
    assert!(host.requests.borrow().is_empty());
    assert!(
        host.events
            .borrow()
            .contains(&"transport:NotStarted".into())
    );
    host.upstream
        .borrow_mut()
        .push_back(Err(LiveDispatchFailure {
            response: response(502, "unknown created call", None),
            attempt: LiveDispatchAttempt::Started,
        }));
    assert_eq!(
        run(runtime.create_call(&principal(), input(), &host, &false)).status,
        502
    );
    assert!(
        run(store.read(&mapping_key("rtc_created")))
            .unwrap()
            .is_none()
    );
    assert!(host.events.borrow().contains(&"transport:Started".into()));
}

#[test]
fn failed_mapping_write_preserves_success_and_location() {
    let (store, runtime, host) = fixture();
    store.fail_put.set(true);
    let result = run(runtime.create_call(&principal(), input(), &host, &false));
    assert_eq!(result.status, 201);
    assert_eq!(result.headers["location"], "/v1/live/rtc_created");
    assert!(store.rows.borrow().is_empty());
    assert_eq!(
        run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
}

#[test]
fn mapping_persists_across_runtime_restart_and_expires_absolutely() {
    let (store, runtime, host) = fixture();
    create(&runtime, &host);
    let restarted = runtime_for(store);
    assert!(
        run(restarted.prepare_sideband(&principal(), "rtc_created", " WebSocket ", &host)).is_ok()
    );
    host.now.set(3_610_000);
    assert_eq!(
        run(restarted.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
}

#[test]
fn principal_mismatch_legacy_corruption_and_removed_account_fail_before_dial() {
    let (store, runtime, host) = fixture();
    create(&runtime, &host);
    let other = AuthPrincipal {
        method: AuthMethod::AdminAllowlist,
        ..principal()
    };
    assert_eq!(
        run(runtime.prepare_sideband(&other, "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        403
    );
    host.removed.set(true);
    assert_eq!(
        run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
    host.removed.set(false);
    store
        .rows
        .borrow_mut()
        .get_mut(&mapping_key("rtc_created").0)
        .unwrap()
        .value = json!({"account_id":"a"});
    assert_eq!(
        run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        403
    );
    store
        .rows
        .borrow_mut()
        .get_mut(&mapping_key("rtc_created").0)
        .unwrap()
        .value = json!({"account_id":7});
    assert_eq!(
        run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
}

#[test]
fn reconnects_use_same_account_current_credentials_and_no_exclusive_claim() {
    let (_, runtime, host) = fixture();
    create(&runtime, &host);
    let first = prepared(&runtime, &host);
    host.generation.set(2);
    let second = prepared(&runtime, &host);
    assert_eq!(first.account.id, second.account.id);
    assert_eq!(
        (first.account.generation, second.account.generation),
        (1, 2)
    );
    assert_eq!(
        first.target.url(),
        "wss://api.openai.com/v1/live/rtc_created"
    );
    assert_eq!(
        run(runtime.prepare_sideband(&principal(), "rtc_created", "", &host))
            .err()
            .unwrap()
            .status,
        426
    );
}

#[test]
fn actual_terminal_handshake_retires_but_normal_failures_do_not() {
    for terminal in [404, 410] {
        let (store, runtime, host) = fixture();
        create(&runtime, &host);
        let part = prepared(&runtime, &host);
        for status in [101, 401, 403, 429, 500, 1011] {
            assert_eq!(
                run(part
                    .retirement
                    .on_handshake_rejection(status, host.now.get())),
                RetirementOutcome::NotTerminal
            );
        }
        assert!(
            run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", &host)).is_ok()
        );
        assert_eq!(
            run(part
                .retirement
                .on_handshake_rejection(terminal, host.now.get())),
            RetirementOutcome::Retired
        );
        assert!(
            run(store.read(&mapping_key("rtc_created")))
                .unwrap()
                .is_none()
        );
        assert!(
            run(store.read(&retirement_key("rtc_created")))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
                .err()
                .unwrap()
                .status,
            404
        );
    }
}

#[test]
fn delete_failure_marker_survives_restart_and_related_event_resumes_it() {
    let (store, runtime, host) = fixture();
    create(&runtime, &host);
    let part = prepared(&runtime, &host);
    store.fail_delete.set(true);
    assert_eq!(
        run(part.retirement.on_handshake_rejection(410, host.now.get())),
        RetirementOutcome::Unknown
    );
    let marker = run(store.read(&retirement_key("rtc_created")))
        .unwrap()
        .unwrap();
    assert_eq!(marker.expires_at_ms, None);
    let restarted = runtime_for(store.clone());
    assert_eq!(
        run(restarted.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
    // A successful reused-ID creation must not clear pending retirement.
    create(&runtime, &host);
    assert!(
        run(store.read(&retirement_key("rtc_created")))
            .unwrap()
            .is_some()
    );
    store.fail_delete.set(false);
    assert_eq!(
        run(restarted.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
    assert!(
        run(store.read(&mapping_key("rtc_created")))
            .unwrap()
            .is_none()
    );
    assert!(
        run(store.read(&retirement_key("rtc_created")))
            .unwrap()
            .is_none()
    );
}

#[test]
fn marker_unknown_write_never_becomes_false_retired_and_restart_stays_closed() {
    let (store, runtime, host) = fixture();
    create(&runtime, &host);
    let part = prepared(&runtime, &host);
    store.unknown_put.set(true);
    assert_eq!(
        run(part.retirement.on_handshake_rejection(404, host.now.get())),
        RetirementOutcome::Unknown
    );
    let restarted = runtime_for(store.clone());
    assert_eq!(
        run(restarted.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
    assert!(
        run(store.read(&mapping_key("rtc_created")))
            .unwrap()
            .is_none()
    );
}

#[test]
fn retirement_during_awaited_mapping_read_suppresses_stale_snapshot() {
    let (store, runtime, host) = fixture();
    create(&runtime, &host);
    let part = prepared(&runtime, &host);
    let other_store = store.clone();
    *store.after_read.borrow_mut() = Some((
        mapping_key("rtc_created"),
        Box::new(move || {
            other_store.fail_delete.set(true);
            assert_eq!(
                run(part.retirement.on_handshake_rejection(404, 10000)),
                RetirementOutcome::Unknown
            );
        }),
    ));
    assert_eq!(
        run(runtime.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
}

#[test]
fn authenticated_principal_methods_match_source() {
    let mut p = principal();
    p.method = AuthMethod::GithubToken {
        owner: "Owner".into(),
        repo: "REPO".into(),
        state_id: "irrelevant".into(),
        limit_scope: "repo".into(),
    };
    assert_eq!(principal_id(&p), "github-repo:owner/repo");
    p.method = AuthMethod::PasskeySession {
        user_id: "u".into(),
        handle: "h".into(),
        is_admin: false,
        credential_count: 1,
    };
    assert_eq!(principal_id(&p), "passkey-user:u");
    p.method = AuthMethod::Disabled;
    assert_eq!(principal_id(&p), "local-auth-disabled");
    p.token = Some(Secret::new("synthetic-bearer".into()));
    assert_eq!(
        principal_id(&p),
        format!(
            "bearer-sha256:{}",
            gateway_auth::crypto::sha256_hex(b"synthetic-bearer")
        )
    );
}

#[test]
fn caller_mints_revisions_and_failed_revision_source_never_claims_retirement() {
    let (store, runtime, host) = fixture();
    create(&runtime, &host);
    let key = mapping_key("rtc_created");
    let original = run(store.read(&key)).unwrap().unwrap();
    assert_eq!(original.revision, "live-fixture-1");
    assert!(
        run(store.commit(AtomicTransition {
            checks: vec![],
            mutations: vec![RecordMutation::Put {
                key: key.clone(),
                record: StoredRecord::json("", json!({}), None)
            }]
        }))
        .is_err()
    );
    assert_eq!(run(store.read(&key)).unwrap().unwrap(), original);
    let broken = LiveRuntime::new(store.clone(), Rc::new(|| Ok(String::new())));
    let part = prepared(&broken, &host);
    assert_eq!(
        run(part.retirement.on_handshake_rejection(404, 10_000)),
        RetirementOutcome::Unknown
    );
    assert!(
        run(store.read(&retirement_key("rtc_created")))
            .unwrap()
            .is_none()
    );
    assert_eq!(run(store.read(&key)).unwrap().unwrap(), original);
    assert_eq!(
        run(broken.prepare_sideband(&principal(), "rtc_created", "websocket", &host))
            .err()
            .unwrap()
            .status,
        404
    );
    assert_eq!(
        run(broken.create_call(&principal(), input(), &host, &false)).status,
        201
    );
    assert_eq!(run(store.read(&key)).unwrap().unwrap(), original);
}

#[test]
fn executed_pinned_bun_source_golden_vectors_match_portable_runtime() {
    let golden: Value = serde_json::from_str(include_str!("fixtures/source-golden.json")).unwrap();
    for row in golden["routes"].as_array().unwrap() {
        let result = live_route(
            row["method"].as_str().unwrap(),
            row["path"].as_str().unwrap(),
        );
        let projected = match result {
            None => Value::Null,
            Some(LiveRoute::Create) => json!({"kind":"call"}),
            Some(LiveRoute::Sideband(call_id)) => json!({"kind":"sideband","callId":call_id}),
        };
        assert_eq!(projected, row["result"]);
    }
    for row in golden["locations"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(call_id_from_location(row["location"].as_str().unwrap())).unwrap(),
            row["id"]
        );
    }
    for row in golden["sessions"].as_array().unwrap() {
        let (_, runtime, host) = fixture();
        let mut request = input();
        request.session = Some(row["session"].as_str().unwrap().into());
        assert_eq!(
            run(runtime.create_call(&principal(), request, &host, &false)).status,
            201
        );
        assert_eq!(host.requests.borrow()[0].1, row["body"].as_str().unwrap());
    }
    for row in golden["headers"].as_array().unwrap() {
        let (_, runtime, host) = fixture();
        let mut request = input();
        // The source fixture uses real Request/Headers: its getter already strips HTTP whitespace.
        request.headers = row["input"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().trim().into()))
            .collect();
        assert_eq!(
            run(runtime.create_call(&principal(), request, &host, &false)).status,
            201
        );
        assert_eq!(
            serde_json::to_value(&host.requests.borrow()[0].2).unwrap(),
            row["result"]
        );
    }
}
