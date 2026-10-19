use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use gateway_auth::{AuthMethod, AuthPrincipal, api_keys::ApiKeyPolicy, crypto::Secret};
use gateway_core::{
    GatewayError,
    identity::{ApiKeyId, PrincipalId, RequestContext, RequestId},
    lifecycle::SemanticTerminal,
    query::{QueryEntry, QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::TupleKey,
};
use gateway_extras_runtime::*;
use gateway_providers::types::PrepareOptions;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

fn poll<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}
fn run<F: Future>(future: F) -> F::Output {
    let mut f = Box::pin(future);
    for _ in 0..10_000 {
        if let Poll::Ready(result) = poll(f.as_mut()) {
            return result;
        }
    }
    panic!("fixture remained pending")
}
fn key(parts: Value) -> RecordKey {
    TupleKey::from_json_parts(parts.as_array().unwrap())
        .unwrap()
        .to_record_key()
}
fn error(code: &str) -> GatewayError {
    GatewayError::unavailable("fixture", code)
}
#[derive(Clone)]
struct Memory {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    clock: Rc<Cell<i64>>,
    rate_conflicts: Rc<Cell<usize>>,
    cache_quota: Rc<Cell<usize>>,
}
impl Memory {
    fn new(clock: Rc<Cell<i64>>) -> Self {
        Self {
            rows: Rc::new(RefCell::new(BTreeMap::new())),
            clock,
            rate_conflicts: Rc::new(Cell::new(0)),
            cache_quota: Rc::new(Cell::new(0)),
        }
    }
    fn seed(&self, parts: Value, value: Value, expiry: Option<i64>) {
        self.rows
            .borrow_mut()
            .insert(key(parts).0, StoredRecord::json("seed", value, expiry));
    }
    fn budget(&self, requests: u64, tokens: u64, window_start: i64) {
        self.seed(
            json!(["embeddings", "v1", "rate", "voyage"]),
            json!({"window_start_ms":window_start,"requests":requests,"tokens":tokens}),
            None,
        )
    }
    fn live(&self, key: &RecordKey) -> Option<StoredRecord> {
        self.rows
            .borrow()
            .get(&key.0)
            .filter(|r| r.expires_at_ms.is_none_or(|e| e > self.clock.get()))
            .cloned()
    }
}
impl AuthorityStore for Memory {
    async fn read(&self, k: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.live(k))
    }
    async fn commit(&self, t: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let rate = key(json!(["embeddings", "v1", "rate", "voyage"]));
        if t.checks.iter().any(|c| c.key == rate) && self.rate_conflicts.get() > 0 {
            self.rate_conflicts.set(self.rate_conflicts.get() - 1);
            return Ok(CommitOutcome::Conflict);
        }
        if self.cache_quota.get() > 0
            && t.mutations.iter().any(|m| match m {
                RecordMutation::Put { key, .. } => TupleKey::from_record_key(key)
                    .unwrap()
                    .is_strict_descendant_of(
                        &TupleKey::from_json_parts(&[
                            json!("embeddings"),
                            json!("v2"),
                            json!("cache"),
                        ])
                        .unwrap(),
                    ),
                _ => false,
            })
        {
            self.cache_quota.set(self.cache_quota.get() - 1);
            return Err(error("storage_quota"));
        }
        for c in &t.checks {
            if self.live(&c.key).map(|r| r.revision) != c.expected_revision {
                return Ok(CommitOutcome::Conflict);
            }
        }
        let mut rows = self.rows.borrow_mut();
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
impl QueryStore for Memory {
    async fn query(&self, r: QueryRequest) -> Result<QueryPage, GatewayError> {
        let validated = r.validate()?;
        let mut entries = Vec::new();
        for (key, row) in self.rows.borrow().iter() {
            let key = RecordKey(key.clone());
            if validated.accepts_record(&key, row)? {
                entries.push(QueryEntry {
                    key,
                    record: row.clone(),
                });
            }
        }
        entries.sort_by_key(|e| TupleKey::from_record_key(&e.key).unwrap());
        if r.reverse {
            entries.reverse()
        }
        let more = entries.len() > r.limit as usize;
        entries.truncate(r.limit as usize);
        let next_cursor = if more {
            entries
                .last()
                .map(|e| validated.cursor_after(&e.key))
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
#[derive(Clone)]
struct Host(Rc<HostState>);
struct HostState {
    clock: Rc<Cell<i64>>,
    rng: Cell<u64>,
    configured: Cell<bool>,
    cancelled: Cell<bool>,
    pending: Cell<bool>,
    calls: RefCell<Vec<(String, Value)>>,
    replies: RefCell<VecDeque<Result<UpstreamResponse, DispatchFailure>>>,
    sleeps: RefCell<Vec<u64>>,
    begins: Cell<usize>,
    finished: Cell<usize>,
    children: RefCell<Vec<usize>>,
    aborted: Cell<bool>,
    decrypts: Cell<usize>,
}
impl Host {
    fn new(clock: Rc<Cell<i64>>) -> Self {
        Self(Rc::new(HostState {
            clock,
            rng: Cell::new(1),
            configured: Cell::new(true),
            cancelled: Cell::new(false),
            pending: Cell::new(false),
            calls: RefCell::new(Vec::new()),
            replies: RefCell::new(VecDeque::new()),
            sleeps: RefCell::new(Vec::new()),
            begins: Cell::new(0),
            finished: Cell::new(0),
            children: RefCell::new(Vec::new()),
            aborted: Cell::new(false),
            decrypts: Cell::new(0),
        }))
    }
    fn reply(&self, status: u16, body: Value) {
        self.0.replies.borrow_mut().push_back(Ok(UpstreamResponse {
            status,
            headers: Headers::new(),
            body: serde_json::to_vec(&body).unwrap(),
            semantic_terminal: None,
            usage: None,
        }));
    }
    fn count(&self) -> usize {
        self.0.calls.borrow().len()
    }
}
impl ExtrasHost for Host {
    fn now_ms(&self) -> i64 {
        self.0.clock.get()
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.0.rng.get();
        self.0.rng.set(n + 1);
        Ok((0..len)
            .map(|i| ((n >> ((i % 8) * 8)) as u8).wrapping_add(i as u8))
            .collect())
    }
    fn cancelled(&self) -> bool {
        self.0.cancelled.get()
    }
    async fn sleep_ms(&self, ms: u64) -> Result<(), GatewayError> {
        self.0.sleeps.borrow_mut().push(ms);
        self.0.clock.set(self.now_ms() + ms as i64);
        Ok(())
    }
    async fn provider_options(
        &self,
        _: ExtrasProvider,
    ) -> Result<Option<PrepareOptions>, GatewayError> {
        Ok(self.0.configured.get().then(|| PrepareOptions {
            auth: gateway_providers::types::AuthMaterial {
                secret: "fixture-not-a-credential".into(),
                ..Default::default()
            },
            ..Default::default()
        }))
    }
    async fn image_base_model(&self) -> Result<Option<gateway_core::model::ModelId>, GatewayError> {
        Ok(Some("gpt-fixture-host".into()))
    }
    async fn dispatch(
        &self,
        operation: ExtrasDispatch,
    ) -> Result<UpstreamResponse, DispatchFailure> {
        let (label, body) = match &operation {
            ExtrasDispatch::Voyage(c) => (
                "voyage".into(),
                c.prepared()
                    .body
                    .deserialize::<Value>()
                    .expect("Generated scalar fixture request"),
            ),
            ExtrasDispatch::SystemOne(c) => (
                "systemone".into(),
                c.prepared()
                    .body
                    .deserialize::<Value>()
                    .expect("Generated scalar fixture request"),
            ),
            ExtrasDispatch::ImageChild {
                request_id, body, ..
            } => (
                request_id.clone(),
                body.deserialize::<Value>()
                    .expect("actual scalar fixture child body"),
            ),
        };
        self.0.calls.borrow_mut().push((label, body.clone()));
        if self.0.pending.get() {
            std::future::pending::<()>().await;
        }
        if let Some(reply) = self.0.replies.borrow_mut().pop_front() {
            return reply;
        }
        let (body, semantic) = match operation {
            ExtrasDispatch::Voyage(_) => {
                let count = body["input"].as_array().map_or(1, Vec::len);
                let dims = body["output_dimension"].as_u64().unwrap() as usize;
                (
                    json!({"data":(0..count).map(|i|json!({"embedding":vec![i as f64+1.0;dims]})).collect::<Vec<_>>(),"usage":{"total_tokens":count}}),
                    None,
                )
            }
            ExtrasDispatch::SystemOne(_) => (
                json!({"answers":{"go":true},"usage":{"input_tokens":2,"output_tokens":3,"cost":0.1}}),
                None,
            ),
            ExtrasDispatch::ImageChild { .. } => (
                json!({"created_at":123,"output":[{"type":"image_generation_call","result":"AA==","output_format":"png"}]}),
                Some(SemanticTerminal::Completed),
            ),
        };
        Ok(UpstreamResponse {
            status: 200,
            headers: Headers::from([("x-uos-upstream".into(), "fixture".into())]),
            body: serde_json::to_vec(&body).unwrap(),
            semantic_terminal: semantic,
            usage: None,
        })
    }
    async fn begin_image_fanout(&self, _: ImageKind, _: usize) -> Result<(), GatewayError> {
        self.0.begins.set(self.0.begins.get() + 1);
        Ok(())
    }
    fn abort_image_siblings(&self) {
        self.0.aborted.set(true)
    }
    async fn image_child_finished(&self, index: usize) -> Result<(), GatewayError> {
        self.0.children.borrow_mut().push(index);
        Ok(())
    }
    async fn finish_image_fanout(&self) -> Result<(), GatewayError> {
        self.0.finished.set(self.0.finished.get() + 1);
        Ok(())
    }
    async fn aes_gcm_encrypt(
        &self,
        key: &[u8; 32],
        iv: &[u8; 12],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, GatewayError> {
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| error("crypto"))?;
        let nonce = Nonce::from(*iv);
        cipher
            .encrypt(&nonce, plaintext)
            .map_err(|_| error("crypto"))
    }
    async fn aes_gcm_decrypt(
        &self,
        key: &[u8; 32],
        iv: &[u8],
        data: &[u8],
    ) -> Result<Vec<u8>, GatewayError> {
        self.0.decrypts.set(self.0.decrypts.get() + 1);
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| error("crypto"))?;
        let iv: [u8; 12] = iv.try_into().map_err(|_| error("crypto"))?;
        let nonce = Nonce::from(iv);
        cipher.decrypt(&nonce, data).map_err(|_| error("crypto"))
    }
}
fn principal(id: &str) -> AuthPrincipal {
    AuthPrincipal {
        token: Some(Secret::new("rotating-bearer".into())),
        method: AuthMethod::KvApiKey {
            key_id: id.into(),
            policy: ApiKeyPolicy {
                token_hash: "fixture".into(),
                key_id: id.into(),
                expires_at_ms: 0,
                usage_limit_requests: -1,
                window_ms: 60_000,
                window_start_ms: 0,
                usage_reset_at_ms: 0,
                policy_version: "v1".into(),
                paid_fallback_enabled: false,
                paid_fallback_limit_microcredits: 0,
                paid_fallback_spent_microcredits: 0,
                paid_fallback_reserved_microcredits: 0,
                paid_fallback_reservation_request_id: None,
            },
        },
        is_admin: false,
        is_super_admin: false,
    }
}
fn context(id: &str) -> RequestContext {
    RequestContext {
        request_id: RequestId("original".into()),
        principal: PrincipalId(format!("api-key:{id}")),
        key_id: Some(ApiKeyId(id.into())),
        route: "fixture".into(),
        started_at_ms: 1_000_000,
    }
}
fn request<'a>(
    route: ExtrasRoute,
    body: Value,
    auth: &'a AuthPrincipal,
    ctx: &'a RequestContext,
) -> ExtrasRequest<'a> {
    ExtrasRequest {
        route,
        body: gateway_core::source_json::SourceJson::from_serializable(&body).unwrap(),
        multipart: None,
        raw_body_bytes: 1,
        idempotency_key: None,
        principal: auth,
        context: ctx,
    }
}
fn embedding(input: Value) -> Value {
    json!({"model":"voyage-4-large","input":input,"dimensions":256})
}
fn setup() -> (Memory, Host, AuthPrincipal, RequestContext) {
    let clock = Rc::new(Cell::new(1_000_000));
    (
        Memory::new(clock.clone()),
        Host::new(clock),
        principal("a"),
        context("a"),
    )
}

#[test]
fn sync_deduplicates_orders_cache_hits_and_measures_only_actual_voyage_usage() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store.clone(), host.clone());
    let r = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!(["a", "a", "b"])),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(
        scalar_source(&r.body)["data"][0]["embedding"],
        scalar_source(&r.body)["data"][1]["embedding"]
    );
    assert_eq!(host.count(), 1);
    assert_eq!(host.0.calls.borrow()[0].1["input"], json!(["a", "b"]));
    assert_eq!(scalar_source(&r.body)["usage"]["total_tokens"], 2);
    let cached = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!(["b", "a"])),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(host.count(), 1);
    assert_eq!(scalar_source(&cached.body)["usage"]["total_tokens"], 0);
    assert!(cached.usage.is_none());
    assert_eq!(cached.kernel, KernelDisposition::Completed);
}

#[test]
fn idempotency_replays_without_credentials_and_conflict_never_redispatches() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("a")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    let first = run(rt.handle(q)).unwrap();
    host.0.configured.set(false);
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("a")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    let replay = run(rt.handle(q)).unwrap();
    assert_eq!(replay.body, first.body);
    assert_eq!(replay.headers["x-uos-idempotency-replayed"], "true");
    assert_eq!(
        replay.kernel,
        KernelDisposition::Incomplete("idempotency_replay")
    );
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("b")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    let conflict = run(rt.handle(q)).unwrap();
    assert_eq!(conflict.status, 409);
    assert_eq!(
        scalar_source(&conflict.body)["error"]["code"],
        "embedding_idempotency_conflict"
    );
    assert_eq!(host.count(), 1);
}

#[test]
fn dispatched_expired_idempotency_is_indeterminate_and_cannot_steal_the_lease() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.0.pending.set(true);
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("a")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    let mut pending = Box::pin(rt.handle(q));
    assert!(poll(pending.as_mut()).is_pending());
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("a")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    let busy = run(rt.handle(q)).unwrap();
    assert_eq!(
        scalar_source(&busy.body)["error"]["code"],
        "embedding_idempotency_in_progress"
    );
    host.0.clock.set(host.now_ms() + 60_001);
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("a")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    let retired = run(rt.handle(q)).unwrap();
    assert_eq!(
        scalar_source(&retired.body)["error"]["code"],
        "embedding_idempotency_indeterminate"
    );
    assert_eq!(host.count(), 1);
    drop(pending);
}

#[test]
fn explicit_failure_releases_idempotency_but_unknown_transport_never_retries() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.reply(400, json!({"private":"not echoed"}));
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("a")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    assert_eq!(run(rt.handle(q)).unwrap().status, 502);
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("a")), &auth, &ctx);
    q.idempotency_key = Some("key".into());
    assert_eq!(run(rt.handle(q)).unwrap().status, 200);
    assert_eq!(host.count(), 2);
    host.0
        .replies
        .borrow_mut()
        .push_back(Err(DispatchFailure::transport(error("network"))));
    let mut q = request(ExtrasRoute::Embeddings, embedding(json!("b")), &auth, &ctx);
    q.idempotency_key = Some("unknown".into());
    let r = run(rt.handle(q)).unwrap();
    assert_eq!(
        scalar_source(&r.body)["error"]["code"],
        "embedding_idempotency_indeterminate"
    );
    assert_eq!(host.count(), 3);
}

#[test]
fn partial_chunk_success_is_not_replayed_after_global_token_budget_exhaustion() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    let mut q = request(
        ExtrasRoute::Embeddings,
        embedding(json!([
            "a".repeat(20_000),
            "b".repeat(20_000),
            "c".repeat(20_000)
        ])),
        &auth,
        &ctx,
    );
    q.idempotency_key = Some("partial".into());
    let r = run(rt.handle(q)).unwrap();
    assert_eq!(
        scalar_source(&r.body)["error"]["code"],
        "embedding_idempotency_indeterminate"
    );
    assert_eq!(host.count(), 1);
}

#[test]
fn budget_retries_cas_then_waits_only_inside_the_twenty_second_deadline() {
    let (store, host, auth, ctx) = setup();
    store.rate_conflicts.set(2);
    let rt = ExtrasRuntime::new(store.clone(), host.clone());
    assert_eq!(
        run(rt.handle(request(
            ExtrasRoute::Embeddings,
            embedding(json!("a")),
            &auth,
            &ctx
        )))
        .unwrap()
        .status,
        200
    );
    assert_eq!(&host.0.sleeps.borrow()[..2], &[5, 10]);
    store.budget(3, 0, host.now_ms() - 59_000);
    assert_eq!(
        run(rt.handle(request(
            ExtrasRoute::Embeddings,
            embedding(json!("b")),
            &auth,
            &ctx
        )))
        .unwrap()
        .status,
        200
    );
    assert!(host.0.sleeps.borrow().contains(&1000));
    store.budget(3, 0, host.now_ms());
    let r = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!("c")),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(r.status, 429);
    assert_eq!(r.headers["Retry-After"], "60");
    assert_eq!(host.count(), 2);
}

#[test]
fn quota_driven_cache_eviction_crosses_profiles_and_drops_the_oldest_pointer() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store.clone(), host.clone());
    let mut a = embedding(json!("a"));
    a["input_type"] = json!("query");
    assert_eq!(
        run(rt.handle(request(ExtrasRoute::Embeddings, a, &auth, &ctx)))
            .unwrap()
            .status,
        200
    );
    host.0.clock.set(host.now_ms() + 1);
    store.cache_quota.set(1);
    assert_eq!(
        run(rt.handle(request(
            ExtrasRoute::Embeddings,
            embedding(json!("b")),
            &auth,
            &ctx
        )))
        .unwrap()
        .status,
        200
    );
    let rows = store.rows.borrow();
    let caches: Vec<_> = rows
        .iter()
        .filter(|(k, _)| {
            TupleKey::from_record_key(&RecordKey((*k).clone()))
                .unwrap()
                .is_strict_descendant_of(
                    &TupleKey::from_json_parts(&[json!("embeddings"), json!("v2"), json!("cache")])
                        .unwrap(),
                )
        })
        .collect();
    assert_eq!(caches.len(), 1);
    assert!(caches[0].1.value["embedding"].is_array());
}

#[test]
fn cancelled_sync_never_dispatches_and_returns_distinct_499() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.0.cancelled.set(true);
    let r = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!("a")),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(r.status, 499);
    assert_eq!(host.count(), 0);
}

fn queued_job(
    store: &Memory,
    host: &Host,
    auth: &AuthPrincipal,
    ctx: &RequestContext,
) -> (ExtrasRuntime<Memory, Host>, String) {
    store.budget(3, 0, host.now_ms());
    let rt = ExtrasRuntime::new(store.clone(), host.clone());
    let mut body = embedding(json!("sensitive-text-for-encryption"));
    body["input_type"] = json!("document");
    let r = run(rt.handle(request(ExtrasRoute::JobCreate, body, auth, ctx))).unwrap();
    assert_eq!(r.status, 202);
    assert_eq!(r.kernel, KernelDisposition::Completed);
    (
        rt,
        scalar_source(&r.body)["id"].as_str().unwrap().to_owned(),
    )
}
#[test]
fn retained_jobs_encrypt_inputs_and_owner_survives_bearer_rotation() {
    let (store, host, mut auth, ctx) = setup();
    let (rt, id) = queued_job(&store, &host, &auth, &ctx);
    assert!(
        !serde_json::to_string(
            &store
                .rows
                .borrow()
                .values()
                .map(|r| &r.value)
                .collect::<Vec<_>>()
        )
        .unwrap()
        .contains("sensitive-text")
    );
    assert_eq!(host.count(), 0);
    let other = principal("other");
    let other_ctx = context("other");
    assert_eq!(
        run(rt.handle(request(
            ExtrasRoute::JobGet(id.clone()),
            Value::Null,
            &other,
            &other_ctx
        )))
        .unwrap()
        .status,
        404
    );
    auth.token = Some(Secret::new("new-bearer".into()));
    host.0.clock.set(host.now_ms() + 60_001);
    let r = run(rt.handle(request(ExtrasRoute::JobGet(id), Value::Null, &auth, &ctx))).unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(scalar_source(&r.body)["status"], "succeeded");
    assert_eq!(
        r.kernel,
        KernelDisposition::Incomplete("embedding_job_read_not_counted")
    );
    assert_eq!(host.count(), 1);
    assert!(host.0.decrypts.get() >= 2);
}

#[test]
fn real_aes_gcm_tamper_is_a_failed_job_without_upstream_dispatch() {
    let (store, host, auth, ctx) = setup();
    let (rt, id) = queued_job(&store, &host, &auth, &ctx);
    for row in store.rows.borrow_mut().values_mut() {
        if row.value.get("data_b64").is_some() {
            let value = row.value["data_b64"].as_str().unwrap();
            let mut bytes = value.as_bytes().to_vec();
            bytes[0] = if bytes[0] == b'A' { b'B' } else { b'A' };
            row.value["data_b64"] = json!(String::from_utf8(bytes).unwrap());
        }
    }
    host.0.clock.set(host.now_ms() + 60_001);
    let r = run(rt.handle(request(ExtrasRoute::JobGet(id), Value::Null, &auth, &ctx))).unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(scalar_source(&r.body)["status"], "failed");
    assert_eq!(
        scalar_source(&r.body)["error"]["code"],
        "embeddings_job_input_decrypt_failed"
    );
    assert_eq!(r.semantic_terminal, Some(SemanticTerminal::Error));
    assert_eq!(host.count(), 0);
}

#[test]
fn live_job_lease_refuses_a_second_runner_and_input_expiry_is_not_refreshed() {
    let (store, host, auth, ctx) = setup();
    let (rt, id) = queued_job(&store, &host, &auth, &ctx);
    host.0.clock.set(host.now_ms() + 60_001);
    host.0.pending.set(true);
    let mut first = Box::pin(rt.handle(request(
        ExtrasRoute::JobGet(id.clone()),
        Value::Null,
        &auth,
        &ctx,
    )));
    assert!(poll(first.as_mut()).is_pending());
    let second =
        run(rt.handle(request(ExtrasRoute::JobGet(id), Value::Null, &auth, &ctx))).unwrap();
    assert_eq!(second.status, 202);
    assert_eq!(second.headers["Retry-After"], "30");
    assert_eq!(host.count(), 1);
    drop(first);
}

#[test]
fn expired_input_fails_after_a_poll_extended_only_the_job_and_lookup_ttls() {
    let (store, host, auth, ctx) = setup();
    let (rt, id) = queued_job(&store, &host, &auth, &ctx);
    host.0.clock.set(1_000_000 + 86_400_000 - 1000);
    store.budget(3, 0, host.now_ms());
    assert_eq!(
        run(rt.handle(request(
            ExtrasRoute::JobGet(id.clone()),
            Value::Null,
            &auth,
            &ctx
        )))
        .unwrap()
        .status,
        202
    );
    host.0.clock.set(host.now_ms() + 2000);
    let r = run(rt.handle(request(ExtrasRoute::JobGet(id), Value::Null, &auth, &ctx))).unwrap();
    assert_eq!(
        scalar_source(&r.body)["error"]["code"],
        "embeddings_job_input_missing"
    );
    assert_eq!(host.count(), 0);
}

#[test]
fn systemone_uses_authoritative_provider_selection_and_normalizes_actual_usage() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store.clone(), host.clone());
    let body = json!({"state":{},"questions":{"go":{"type":"noul"}}});
    store.seed(
        json!(["uos_ai", "provider_selection", "v1"]),
        json!({"provider_ids":["codex"],"updated_at_ms":host.now_ms()}),
        None,
    );
    let disabled =
        run(rt.handle(request(ExtrasRoute::SystemOne, body.clone(), &auth, &ctx))).unwrap();
    assert_eq!(
        scalar_source(&disabled.body)["error"]["code"],
        "systemone_provider_disabled"
    );
    assert_eq!(host.count(), 0);
    store.seed(
        json!(["uos_ai", "provider_selection", "v1"]),
        json!({"provider_ids":[],"updated_at_ms":host.now_ms()}),
        None,
    );
    let r = run(rt.handle(request(ExtrasRoute::SystemOne, body, &auth, &ctx))).unwrap();
    assert_eq!(scalar_source(&r.body)["answers"]["go"], true);
    assert_eq!(r.usage.unwrap()["input_tokens_details"]["cached_tokens"], 0);
    assert_eq!(r.health[0].kind, HealthKind::Success);
}

#[test]
fn systemone_maps_actual_upstream_errors_and_does_not_echo_private_bodies() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.reply(401, json!({"private":"never_echo"}));
    let r = run(rt.handle(request(
        ExtrasRoute::SystemOne,
        json!({"state":{},"questions":{"go":{"type":"noul"}}}),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(r.status, 502);
    assert_eq!(r.health[0].kind, HealthKind::AuthInvalid);
    assert_eq!(r.health[0].upstream_status, Some(401));
    assert!(!r.body.as_str().contains("never_echo"));
    assert!(!r.upstream_errors.is_empty());
}

#[test]
fn image_fanout_uses_one_original_scope_exact_child_ids_and_common_output_metadata() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    let mut q = request(
        ExtrasRoute::Images(ImageKind::Generations),
        json!({"prompt":"image","n":3}),
        &auth,
        &ctx,
    );
    q.idempotency_key = Some("outer-not-forwarded".into());
    let r = run(rt.handle(q)).unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(scalar_source(&r.body)["data"].as_array().unwrap().len(), 3);
    assert_eq!(scalar_source(&r.body)["output_format"], "png");
    assert_eq!(r.semantic_terminal, Some(SemanticTerminal::Completed));
    assert_eq!(host.0.begins.get(), 1);
    assert_eq!(host.0.finished.get(), 1);
    assert_eq!(&*host.0.children.borrow(), &[0, 1, 2]);
    let ids: Vec<_> = host
        .0
        .calls
        .borrow()
        .iter()
        .map(|(id, _)| id.clone())
        .collect();
    assert_eq!(
        ids,
        [
            "original",
            "original:image:generations:2",
            "original:image:generations:3"
        ]
    );
    assert!(
        host.0
            .calls
            .borrow()
            .iter()
            .all(|(_, b)| b["model"] == "gpt-fixture-host")
    );
}

#[test]
fn image_failure_aborts_siblings_but_settles_every_logical_child_once() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.reply(
        200,
        json!({"output":[{"type":"image_generation_call","result":"AA=="}]}),
    );
    host.reply(429, json!({"error":{"code":"codex_quota_blocked"}}));
    let r = run(rt.handle(request(
        ExtrasRoute::Images(ImageKind::Generations),
        json!({"prompt":"image","n":3}),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(r.status, 429);
    assert_eq!(
        scalar_source(&r.body)["error"]["code"],
        "codex_quota_blocked"
    );
    assert!(r.semantic_terminal.is_none());
    assert!(host.0.aborted.get());
    assert_eq!(host.0.children.borrow().len(), 3);
    assert_eq!(host.0.finished.get(), 1);
}

#[test]
fn sync_retries_only_explicit_retryable_statuses_with_bounded_backoff() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.reply(429, json!({}));
    host.reply(503, json!({}));
    let r = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!("a")),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(host.count(), 3);
    assert_eq!(&*host.0.sleeps.borrow(), &[250, 500]);
}

#[test]
fn job_retry_is_poll_driven_and_does_not_schedule_a_hidden_request() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.reply(429, json!({}));
    let mut body = embedding(json!("a"));
    body["input_type"] = json!("document");
    let queued = run(rt.handle(request(ExtrasRoute::JobCreate, body, &auth, &ctx))).unwrap();
    assert_eq!(queued.status, 202);
    assert_eq!(queued.headers["Retry-After"], "60");
    assert_eq!(host.count(), 1);
    assert!(host.0.sleeps.borrow().is_empty());
    let id = scalar_source(&queued.body)["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let r = run(rt.handle(request(ExtrasRoute::JobGet(id), Value::Null, &auth, &ctx))).unwrap();
    assert_eq!(scalar_source(&r.body)["status"], "succeeded");
    assert_eq!(host.count(), 2);
}

#[test]
fn base64_vectors_use_source_little_endian_float32_output_without_forwarding_the_encoding_option() {
    use base64::Engine;
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    let mut body = embedding(json!("a"));
    body["encoding_format"] = json!("base64");
    let r = run(rt.handle(request(ExtrasRoute::Embeddings, body, &auth, &ctx))).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(
            scalar_source(&r.body)["data"][0]["embedding"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    assert_eq!(bytes.len(), 256 * 4);
    assert_eq!(&bytes[..4], &1.0f32.to_le_bytes());
    assert!(host.0.calls.borrow()[0].1.get("encoding_format").is_none());
}

#[test]
fn provider_configuration_and_invalid_vector_statuses_stay_distinct() {
    let (store, host, auth, ctx) = setup();
    let rt = ExtrasRuntime::new(store, host.clone());
    host.0.configured.set(false);
    let missing = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!("a")),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(missing.status, 503);
    assert_eq!(host.count(), 0);
    host.0.configured.set(true);
    host.reply(200, json!({"data":[{"embedding":vec![1.0;255]}]}));
    let malformed = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!("a")),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(malformed.status, 502);
    assert_eq!(
        scalar_source(&malformed.body)["error"]["code"],
        "upstream_dimension_mismatch"
    );
}

#[test]
fn cache_timestamp_projection_preserves_source_negative_zero_key_identity() {
    let (store, host, auth, ctx) = setup();
    let profile = json!([
        "voyage-profile-v2",
        "voyage-4-large",
        "document",
        256,
        "float",
        "float",
        true
    ])
    .to_string();
    let hash = gateway_auth::crypto::sha256_hex(b"zero");
    store.seed(
        json!(["embeddings", "v2", "cache_index_by_hash", profile, hash]),
        json!(-0.0),
        None,
    );
    store.seed(
        json!(["embeddings", "v2", "cache_index", profile, -0.0, hash]),
        json!(1),
        None,
    );
    store.seed(
        json!([
            "embeddings",
            "v2",
            "cache_index_global",
            -0.0,
            profile,
            hash
        ]),
        json!(1),
        None,
    );
    store.seed(
        json!(["embeddings", "v2", "cache", profile, hash]),
        json!({"embedding":vec![1.0;255],"created_at":"1970-01-01T00:00:00.000Z"}),
        None,
    );
    let rt = ExtrasRuntime::new(store.clone(), host);
    let r = run(rt.handle(request(
        ExtrasRoute::Embeddings,
        embedding(json!("zero")),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(r.status, 200);
    let prefix = TupleKey::from_json_parts(&[
        json!("embeddings"),
        json!("v2"),
        json!("cache_index_global"),
    ])
    .unwrap();
    let rows = store.rows.borrow();
    let indexes: Vec<_> = rows
        .keys()
        .map(|k| TupleKey::from_record_key(&RecordKey(k.clone())).unwrap())
        .filter(|k| k.is_strict_descendant_of(&prefix))
        .collect();
    assert_eq!(indexes.len(), 1);
    let parts = indexes[0].decoded_parts().unwrap();
    let gateway_core::tuple_key::DecodedKeyPart::Number(at) = parts[3] else {
        panic!("timestamp")
    };
    assert_eq!(at.to_bits(), (-0.0f64).to_bits());
}

#[test]
fn gateway_origin_preserves_admission_and_started_ledger_failures_without_provider_health() {
    for before_transport in [true, false] {
        let (store, host, auth, ctx) = setup();
        let mut failure = DispatchFailure::gateway(
            GatewayError::unavailable("ledger unavailable", "ledger_unavailable"),
            before_transport,
        );
        failure.headers.insert("Retry-After".into(), "3".into());
        host.0.replies.borrow_mut().push_back(Err(failure));
        let result = run(ExtrasRuntime::new(store, host).handle(request(
            ExtrasRoute::SystemOne,
            json!({"state":{},"questions":{"go":{"type":"noul"}}}),
            &auth,
            &ctx,
        )))
        .unwrap();
        assert_eq!(result.status, 503);
        assert_eq!(result.headers["Retry-After"], "3");
        assert!(result.health.is_empty());
        assert_eq!(
            result.upstream_errors[0].origin,
            DispatchFailureOrigin::Gateway
        );
        assert_eq!(result.upstream_errors[0].before_transport, before_transport);
        assert!(!result.upstream_errors[0].quota_refusal);
    }
}

#[test]
fn actual_local_quota_transport_fault_and_upstream_refusal_keep_separate_origins() {
    let (store, host, auth, ctx) = setup();
    let mut quota = DispatchFailure::gateway(
        GatewayError::new(429, "quota", Some("api_key_quota_exceeded")),
        true,
    );
    quota.quota_refusal = true;
    host.0.replies.borrow_mut().push_back(Err(quota));
    let result = run(ExtrasRuntime::new(store, host).handle(request(
        ExtrasRoute::SystemOne,
        json!({"state":{},"questions":{"go":{"type":"noul"}}}),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(result.status, 429);
    assert!(result.health.is_empty());
    assert!(result.upstream_errors[0].quota_refusal);
    let (store, host, auth, ctx) = setup();
    host.0
        .replies
        .borrow_mut()
        .push_back(Err(DispatchFailure::transport(error("network"))));
    let result = run(ExtrasRuntime::new(store, host).handle(request(
        ExtrasRoute::SystemOne,
        json!({"state":{},"questions":{"go":{"type":"noul"}}}),
        &auth,
        &ctx,
    )))
    .unwrap();
    assert_eq!(result.status, 502);
    assert_eq!(result.health[0].kind, HealthKind::UpstreamError);
    assert_eq!(
        result.upstream_errors[0].origin,
        DispatchFailureOrigin::Transport
    );
}

fn scalar_source(value: &gateway_core::source_json::SourceJson) -> serde_json::Value {
    value.deserialize().expect("actual scalar fixture output")
}
