use gateway_catalog_runtime::{
    state::{self, source_key},
    *,
};
use gateway_core::{
    GatewayError,
    query::{QueryEntry, QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::TupleKey,
};
use gateway_schema::{
    catalog_cache::{self, CatalogResponse},
    catalog_store,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    future::{Future, poll_fn},
    rc::Rc,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};
struct Noop;
impl Wake for Noop {
    fn wake(self: Arc<Self>) {}
}
fn run<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::from(Arc::new(Noop));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(result) = future.as_mut().poll(&mut cx) {
            return result;
        }
    }
}
type Callback = Rc<dyn Fn()>;
#[derive(Clone)]
struct Store {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    now: Rc<Cell<i64>>,
    after_chunks: Rc<RefCell<Option<Callback>>>,
    fail_query: Rc<Cell<bool>>,
}
impl Store {
    fn new() -> Self {
        Self {
            rows: Rc::default(),
            now: Rc::new(Cell::new(1_800_000_000_000)),
            after_chunks: Rc::default(),
            fail_query: Rc::default(),
        }
    }
    fn put(&self, key: RecordKey, revision: &str, value: Value) {
        self.rows
            .borrow_mut()
            .insert(key.0, StoredRecord::json(revision, value, None));
    }
    fn live(&self, key: &RecordKey) -> Option<StoredRecord> {
        self.rows
            .borrow()
            .get(&key.0)
            .filter(|r| r.expires_at_ms.is_none_or(|at| at > self.now.get()))
            .cloned()
    }
    fn seed(&self, version: &str, fetched: i64, body: &str, upstream_etag: Option<&str>) {
        self.put(catalog_store::auth_generation_key(), "g", "g".into());
        let prepared = catalog_cache::prepare_catalog(
            version,
            "g",
            &format!("seed-{version}-{fetched}"),
            body,
            upstream_etag,
            None,
            fetched,
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(run(catalog_store::publish_catalog(self, &prepared)).unwrap());
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.live(key))
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if transition.checks.iter().any(|c| {
            self.live(&c.key).as_ref().map(|r| &r.revision) != c.expected_revision.as_ref()
        }) {
            return Ok(CommitOutcome::Conflict);
        }
        let chunks = transition.mutations.iter().any(|mutation| {
            let RecordMutation::Put { key, .. } = mutation else {
                return false;
            };
            let tuple = TupleKey::from_record_key(key).unwrap();
            ["codex_catalog_chunk", "codex_catalog_source_chunk"]
                .iter()
                .any(|prefix| {
                    tuple.is_strict_descendant_of(
                        &TupleKey::from_record_key(&source_key(&["ubq_ai", prefix])).unwrap(),
                    )
                })
        });
        for mutation in transition.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    self.rows.borrow_mut().insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    self.rows.borrow_mut().remove(&key.0);
                }
            }
        }
        if chunks {
            let callback = self.after_chunks.borrow_mut().take();
            if let Some(callback) = callback {
                callback();
            }
        }
        Ok(CommitOutcome::Committed)
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        if self.fail_query.get() { return Err(GatewayError::unavailable("Query unavailable", "test_query_unavailable")); }
        let validated = request.validate()?;
        let mut rows = Vec::new();
        for (key, record) in self.rows.borrow().iter() {
            let key = RecordKey(key.clone());
            if validated.accepts_record(&key, record)? {
                rows.push(QueryEntry {
                    key,
                    record: record.clone(),
                });
            }
        }
        rows.sort_by_key(|row| TupleKey::from_record_key(&row.key).unwrap());
        if request.reverse {
            rows.reverse();
        }
        let more = rows.len() > request.limit as usize;
        rows.truncate(request.limit as usize);
        let next_cursor = if more {
            rows.last()
                .map(|row| validated.cursor_after(&row.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries: rows,
            next_cursor,
        })
    }
}
struct Outcome {
    response: Result<CatalogFetchResponse, GatewayError>,
    ticks: u32,
    callback: Option<Callback>,
}
impl Outcome {
    fn json(body: Value) -> Self {
        Self {
            response: Ok(CatalogFetchResponse::json(200, body.to_string())),
            ticks: 0,
            callback: None,
        }
    }
}
struct Host {
    store: Store,
    published: RefCell<CredentialPublication>,
    responses: RefCell<VecDeque<Outcome>>,
    requests: RefCell<Vec<CatalogFetch>>,
    sequence: Cell<u32>,
    on_wait: RefCell<Option<Callback>>,
    renewal: RefCell<Option<CodexAccount>>,
    observations: RefCell<Vec<CatalogObservation>>,
}
impl Host {
    fn new(store: &Store) -> Self {
        let pool = source_key(&["ubq_ai", "codex_auth"]);
        store.put(pool.clone(), "p1", json!({"test":"nonsecret-publication"}));
        store.put(
            state::selection_key(),
            "selection",
            json!({"provider_ids":["codex"],"updated_at_ms":store.now.get()}),
        );
        Self {
            store: store.clone(),
            published: RefCell::new(CredentialPublication {
                codex_accounts: vec![CodexAccount {
                    account_id: "account-a".into(),
                    credential_fingerprint: "credential-a".into(),
                }],
                source_checks: vec![RevisionCheck {
                    key: pool,
                    expected_revision: Some("p1".into()),
                }],
                providers: BTreeMap::new(),
            }),
            responses: RefCell::default(),
            requests: RefCell::default(),
            sequence: Cell::new(0),
            on_wait: RefCell::default(),
            renewal: RefCell::default(),
            observations: RefCell::default(),
        }
    }
    fn queue(&self, response: Outcome) {
        self.responses.borrow_mut().push_back(response);
    }
    fn provider(&self, provider: CatalogProvider, identity: &str) {
        self.published.borrow_mut().providers.insert(
            provider,
            ProviderBinding {
                identity: identity.into(),
            },
        );
    }
}
impl CatalogHost for Host {
    fn now_ms(&self) -> i64 {
        self.store.now.get()
    }
    fn unique_id(&self) -> String {
        let n = self.sequence.get() + 1;
        self.sequence.set(n);
        format!("uuid-{n}")
    }
    async fn wait(&self, milliseconds: u32) -> Result<(), GatewayError> {
        self.store
            .now
            .set(self.store.now.get() + i64::from(milliseconds));
        let callback = self.on_wait.borrow_mut().take();
        if let Some(callback) = callback {
            callback();
        }
        Ok(())
    }
    async fn publication(&self) -> Result<CredentialPublication, GatewayError> {
        Ok(self.published.borrow().clone())
    }
    async fn fetch(&self, request: CatalogFetch) -> Result<CatalogFetchResponse, GatewayError> {
        self.requests.borrow_mut().push(request);
        let outcome = self
            .responses
            .borrow_mut()
            .pop_front()
            .expect("unexpected catalog fetch");
        let mut ticks = outcome.ticks;
        poll_fn(|cx| {
            if ticks == 0 {
                Poll::Ready(())
            } else {
                ticks -= 1;
                cx.waker().wake_by_ref();
                Poll::Pending
            }
        })
        .await;
        if let Some(callback) = outcome.callback {
            callback();
        }
        outcome.response
    }
    async fn observe(&self, observation: CatalogObservation) -> Result<(), GatewayError> {
        self.observations.borrow_mut().push(observation);
        Ok(())
    }
    async fn refresh_codex(&self, expected: &CodexAccount) -> Result<CodexAccount, GatewayError> {
        let replacement = self.renewal.borrow_mut().take().ok_or_else(|| {
            GatewayError::unavailable(
                "Native credential owner unavailable",
                "catalog_credential_owner_unavailable",
            )
        })?;
        assert_eq!(expected.account_id, replacement.account_id);
        let mut published = self.published.borrow_mut();
        for account in &mut published.codex_accounts {
            if account.account_id == replacement.account_id {
                *account = replacement.clone();
            }
        }
        for fence in &mut published.source_checks {
            fence.expected_revision = Some("p2".into());
            self.store
                .put(fence.key.clone(), "p2", json!({"test":"renewed"}));
        }
        Ok(replacement)
    }
}
fn body(response: &CatalogResponse) -> Value {
    serde_json::from_str(response.body.as_ref().unwrap()).unwrap()
}
fn ids(response: &CatalogResponse) -> Vec<String> {
    body(response)["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|r| r["slug"].as_str())
        .map(str::to_owned)
        .collect()
}
fn catalog(id: &str) -> Value {
    json!({"models":[{"slug":id,"supported_reasoning_levels":[{"effort":null},{"effort":"ultra"},{"effort":"custom-tier"}],"default_reasoning_level":null}]})
}

#[test]
fn exact_versions_do_not_share_catalog_bodies_or_validators() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.queue(Outcome::json(catalog("old")));
    host.queue(Outcome::json(catalog("new")));
    let old = run(runtime.versioned_models(&store, &host, "0.162.1", None)).unwrap();
    let new = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(ids(&old), ["old"]);
    assert_eq!(ids(&new), ["new"]);
    assert_ne!(old.headers["ETag"], new.headers["ETag"]);
    let conditional =
        run(runtime.versioned_models(&store, &host, "0.162.1", Some(&old.headers["ETag"])))
            .unwrap();
    assert_eq!(conditional.status, 304);
    assert!(conditional.body.is_none());
    assert_eq!(host.requests.borrow().len(), 2);
    assert_eq!(
        body(&old)["models"][0]["supported_reasoning_levels"][2]["effort"],
        "custom-tier"
    );
    let runtime_record = store.live(&catalog_store::runtime_config_key()).unwrap();
    assert_eq!(
        runtime_record.value["codex_models"]["client_version"],
        "0.163.0"
    );
}
#[test]
fn invalid_or_duplicate_version_never_dispatches() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    for version in ["", "0.163", "v0.163.0", "0.163.0&client_version=0.162.0"] {
        assert_eq!(
            run(runtime.versioned_models(&store, &host, version, None))
                .unwrap_err()
                .status,
            400
        );
    }
    assert!(host.requests.borrow().is_empty());
}
#[test]
fn single_account_304_revalidates_source_and_hashes_final_client_bytes() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    let old_time = store.now.get() - catalog_cache::FRESH_MS - 1;
    let source = catalog("one").to_string();
    store.seed("0.163.0", old_time, &source, Some("\"upstream\""));
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(304, "")),
        ticks: 0,
        callback: None,
    });
    let response =
        run(runtime.versioned_models(&store, &host, "0.163.0", Some("\"upstream\""))).unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.headers["x-uos-cache"], "revalidated");
    assert_ne!(response.headers["ETag"], "\"upstream\"");
    assert!(
        matches!(&host.requests.borrow()[0],CatalogFetch::Codex{if_none_match:Some(etag),..} if etag=="\"upstream\"")
    );
    let loaded = run(catalog_store::load_catalog(
        &store,
        "0.163.0",
        "g",
        store.now.get(),
    ))
    .unwrap()
    .unwrap();
    assert!(loaded.metadata.fresh(store.now.get()));
    assert_eq!(loaded.source_body, Some(source));
}
#[test]
fn pool_union_keeps_first_metadata_and_never_sends_one_accounts_etag() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.published
        .borrow_mut()
        .codex_accounts
        .push(CodexAccount {
            account_id: "account-b".into(),
            credential_fingerprint: "credential-b".into(),
        });
    host.queue(Outcome::json(json!({"top":"first","models":[{"slug":"shared","display_name":"first","supported_reasoning_levels":[{"effort":"none"}]},{"slug":"a"}]})));
    host.queue(Outcome::json(
        json!({"top":"second","models":[{"slug":"shared","display_name":"second"},{"slug":"b"}]}),
    ));
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(ids(&response), ["shared", "a", "b"]);
    assert_eq!(body(&response)["top"], "first");
    assert_eq!(body(&response)["models"][0]["display_name"], "first");
    assert!(host.requests.borrow().iter().all(|r| matches!(
        r,
        CatalogFetch::Codex {
            if_none_match: None,
            ..
        }
    )));
    let evidence = store.live(&state::account_models_key()).unwrap().value;
    assert_eq!(
        evidence["accounts"]["account-a"]["slugs"],
        json!(["shared", "a"])
    );
    assert_eq!(
        evidence["accounts"]["account-b"]["slugs"],
        json!(["shared", "b"])
    );
}
#[test]
fn union_survives_one_account_transport_failure_without_quota_writes() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.published
        .borrow_mut()
        .codex_accounts
        .push(CodexAccount {
            account_id: "account-b".into(),
            credential_fingerprint: "credential-b".into(),
        });
    host.queue(Outcome {
        response: Err(GatewayError::unavailable(
            "transport failed",
            "codex_upstream_unreachable",
        )),
        ticks: 0,
        callback: None,
    });
    host.queue(Outcome::json(catalog("b")));
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(ids(&response), ["b"]);
    assert!(host.observations.borrow().iter().any(|event|matches!(event,CatalogObservation::CodexTransportFailure{account,..} if account.account_id=="account-a")));
    assert_eq!(
        host.observations
            .borrow()
            .iter()
            .filter(|event| matches!(event, CatalogObservation::ProviderDegradation { .. }))
            .count(),
        1
    );
}
#[test]
fn failed_refresh_serves_retained_stale_body_and_releases_lease() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    store.seed(
        "0.163.0",
        store.now.get() - catalog_cache::FRESH_MS - 1,
        &catalog("stale").to_string(),
        None,
    );
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(503, "{}")),
        ticks: 0,
        callback: None,
    });
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(ids(&response), ["stale"]);
    assert_eq!(response.headers["x-uos-cache"], "stale");
    assert!(store.live(&catalog_store::lease_key("0.163.0")).is_none());
}
#[test]
fn cold_wait_observes_existing_refresh_without_duplicate_fetch() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    store.put(catalog_store::auth_generation_key(), "g", json!("g"));
    assert!(
        run(catalog_store::acquire_refresh_lease(
            &store,
            "0.163.0",
            "other",
            store.now.get()
        ))
        .unwrap()
    );
    let shared = store.clone();
    host.on_wait.replace(Some(Rc::new(move || {
        shared.seed(
            "0.163.0",
            shared.now.get(),
            &catalog("shared").to_string(),
            None,
        )
    })));
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(response.headers["x-uos-cache"], "wait");
    assert_eq!(ids(&response), ["shared"]);
    assert!(host.requests.borrow().is_empty());
}
#[test]
fn lost_lease_cannot_publish_or_delete_successors_lease() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    let shared = store.clone();
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(
            200,
            catalog("loser").to_string(),
        )),
        ticks: 0,
        callback: Some(Rc::new(move || {
            shared.put(
                catalog_store::lease_key("0.163.0"),
                "successor",
                json!({"owner":"successor","lease_until_ms":shared.now.get()+15000}),
            )
        })),
    });
    assert_eq!(
        run(runtime.versioned_models(&store, &host, "0.163.0", None))
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("codex_catalog_unavailable")
    );
    assert!(
        store
            .live(&catalog_store::metadata_key("0.163.0"))
            .is_none()
    );
    assert_eq!(
        store
            .live(&catalog_store::lease_key("0.163.0"))
            .unwrap()
            .value["owner"],
        "successor"
    );
}
#[test]
fn auth_generation_change_returns_current_catalog_and_never_publishes_old_fetch() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    let shared = store.clone();
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(200, catalog("old").to_string())),
        ticks: 0,
        callback: Some(Rc::new(move || {
            shared.put(catalog_store::auth_generation_key(), "new", json!("new"))
        })),
    });
    assert!(run(runtime.versioned_models(&store, &host, "0.163.0", None)).is_err());
    assert!(
        store
            .live(&catalog_store::metadata_key("0.163.0"))
            .is_none()
    );
}
#[test]
fn credential_revision_change_between_chunks_and_metadata_cannot_publish() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    let shared = store.clone();
    store.after_chunks.replace(Some(Rc::new(move || {
        shared.put(
            source_key(&["ubq_ai", "codex_auth"]),
            "rotated",
            json!({"test":"rotated"}),
        )
    })));
    host.queue(Outcome::json(catalog("old")));
    assert!(run(runtime.versioned_models(&store, &host, "0.163.0", None)).is_err());
    assert!(
        store
            .live(&catalog_store::metadata_key("0.163.0"))
            .is_none()
    );
    assert_eq!(store.rows.borrow().len(), 3); // source pool, selection and auth generation; all private chunks were removed
}
#[test]
fn in_flight_heartbeat_renews_only_the_request_lease() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(200, catalog("slow").to_string())),
        ticks: 4,
        callback: None,
    });
    let before = store.now.get();
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(ids(&response), ["slow"]);
    assert_eq!(store.now.get() - before, 20000);
    assert!(store.live(&catalog_store::lease_key("0.163.0")).is_none());
}
#[test]
fn owned_401_refresh_requires_durable_exact_publication() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(401, "{}")),
        ticks: 0,
        callback: None,
    });
    host.queue(Outcome::json(catalog("renewed")));
    host.renewal.replace(Some(CodexAccount {
        account_id: "account-a".into(),
        credential_fingerprint: "new-credential".into(),
    }));
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(ids(&response), ["renewed"]);
    assert!(
        matches!(&host.requests.borrow()[1],CatalogFetch::Codex{account,..} if account.credential_fingerprint=="new-credential")
    );
}
#[test]
fn cold_failure_uses_configured_static_fallback_without_inventing_codex_rows() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.published.borrow_mut().codex_accounts.clear();
    host.provider(CatalogProvider::Deepseek, "source-deepseek");
    store.put(
        state::selection_key(),
        "selection2",
        json!({"provider_ids":["deepseek"],"updated_at_ms":store.now.get()}),
    );
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert!(ids(&response).contains(&"deepseek-flash".into()));
    assert_eq!(response.headers["x-uos-upstream"], "metered");
    assert!(host.requests.borrow().is_empty());
}
#[test]
fn expired_catalog_from_another_version_is_not_fallback() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    store.seed(
        "0.162.0",
        store.now.get(),
        &catalog("other-version").to_string(),
        None,
    );
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(500, "{}")),
        ticks: 0,
        callback: None,
    });
    assert!(run(runtime.versioned_models(&store, &host, "0.163.0", None)).is_err());
}
#[test]
fn claude_failure_retains_ids_and_withdraws_reasoning_permissions() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.provider(CatalogProvider::ClaudeCode, "claude-owner-1");
    host.queue(Outcome::json(json!({"data":[{"id":"claude-sonnet-5","created_at":"2026-10-01T00:00:00Z","capabilities":{"thinking":{"types":{"disabled":{"supported":true},"adaptive":{"supported":true}}},"effort":{"supported":true,"high":{"supported":true},"arbitrary":{"supported":true}}}}],"has_more":false})));
    let first = run(runtime.refresh_provider(&store, &host, CatalogProvider::ClaudeCode, false))
        .unwrap()
        .unwrap();
    assert_eq!(first.models[0]["supports_disabled_thinking"], true);
    assert_eq!(
        first.models[0]["supported_reasoning_levels"],
        json!(["high", "arbitrary"])
    );
    store.now.set(store.now.get() + 300001);
    host.queue(Outcome {
        response: Ok(CatalogFetchResponse::json(503, "{}")),
        ticks: 0,
        callback: None,
    });
    let stale = run(runtime.refresh_provider(&store, &host, CatalogProvider::ClaudeCode, false))
        .unwrap()
        .unwrap();
    assert!(stale.stale);
    assert_eq!(stale.models[0]["id"], "claude-sonnet-5");
    assert!(stale.models[0].get("supports_disabled_thinking").is_none());
    assert!(stale.models[0].get("supported_reasoning_levels").is_none());
    host.provider(CatalogProvider::ClaudeCode, "claude-owner-2");
    let published = host.published.borrow().clone();
    assert!(
        runtime
            .cached_provider(&published, CatalogProvider::ClaudeCode)
            .is_none()
    );
}
#[test]
fn provider_pages_are_bounded_and_repeated_cursors_fail_closed() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.provider(CatalogProvider::ClaudeCode, "claude-owner");
    for _ in 0..2 {
        host.queue(Outcome::json(
            json!({"data":[{"id":"claude-observed"}],"has_more":true,"last_id":"repeat"}),
        ));
    }
    assert!(
        run(runtime.refresh_provider(&store, &host, CatalogProvider::ClaudeCode, false))
            .unwrap()
            .is_none()
    );
    assert_eq!(host.requests.borrow().len(), 2);
}
#[test]
fn public_openrouter_enrichment_does_not_require_routing_credentials() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.queue(Outcome::json(json!({"data":[{"id":"vendor/model","context_length":123456,"top_provider":{"context_length":200000},"reasoning":{"supported_efforts":["custom","none"],"default_effort":"custom"}}]})));
    run(runtime.refresh_provider(&store, &host, CatalogProvider::Openrouter, false)).unwrap();
    store.seed(
        "0.163.0",
        store.now.get(),
        &catalog("vendor/model").to_string(),
        None,
    );
    let state = run(runtime.load_state(&store, &host.published.borrow(), store.now.get())).unwrap();
    assert!(!state.input.configured("openrouter"));
    assert_eq!(
        state.input.enrichment["vendor/model"].max_context_window_tokens,
        Some(200000)
    );
}
#[test]
fn openrouter_empty_failure_retains_cache_and_ambiguous_matches_are_unknown() {
    let rows = vec![
        json!({"id":"a/model","context_window_tokens":1}),
        json!({"id":"b/model","context_window_tokens":2}),
    ];
    assert!(providers::match_openrouter(&rows, "model").is_none());
    assert_eq!(
        providers::match_openrouter(&rows, "a/model").unwrap()["context_window_tokens"],
        1
    );
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.queue(Outcome::json(json!({"data":[{"id":"a/model"}]})));
    run(runtime.refresh_provider(&store, &host, CatalogProvider::Openrouter, false)).unwrap();
    store.now.set(store.now.get() + 300001);
    host.queue(Outcome::json(json!({"data":[]})));
    let retained = run(runtime.refresh_provider(&store, &host, CatalogProvider::Openrouter, false))
        .unwrap()
        .unwrap();
    assert_eq!(retained.models[0]["id"], "a/model");
    run(runtime.refresh_provider(&store, &host, CatalogProvider::Openrouter, false)).unwrap();
    assert_eq!(host.requests.borrow().len(), 2);
}

#[test]
fn client_validator_changes_when_whitelist_changes_final_bytes() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.queue(Outcome::json(
        json!({"models":[{"slug":"one"},{"slug":"two"}]}),
    ));
    let initial = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    store.put(
        state::whitelist_key(),
        "whitelist",
        json!({"model_ids":["one"],"updated_at_ms":store.now.get()}),
    );
    let narrowed =
        run(runtime.versioned_models(&store, &host, "0.163.0", Some(&initial.headers["ETag"])))
            .unwrap();
    assert_eq!(narrowed.status, 200);
    assert_eq!(ids(&narrowed), ["one"]);
    assert_ne!(narrowed.headers["ETag"], initial.headers["ETag"]);
    assert_eq!(host.requests.borrow().len(), 1);
}

#[test]
fn runtime_catalog_body_is_not_capped_by_the_single_account_observation_limit() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    host.queue(Outcome::json(
        json!({"models":[{"slug":"large","opaque_source_metadata":"x".repeat(4 * 1024 * 1024)}]}),
    ));
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap();
    assert_eq!(ids(&response), ["large"]);
    assert!(response.body.as_ref().unwrap().len() > 4 * 1024 * 1024);
    assert!(store.live(&state::account_models_key()).is_none());
}

#[test]
fn complete_empty_account_observation_survives_invalid_rich_catalog() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    let mut observed = CatalogFetchResponse::json(200, "{\"models\":[]}");
    observed.single_account_observation_complete = true;
    host.queue(Outcome {
        response: Ok(observed),
        ticks: 0,
        callback: None,
    });
    assert!(run(runtime.versioned_models(&store, &host, "0.163.0", None)).is_err());
    assert_eq!(
        store.live(&state::account_models_key()).unwrap().value["accounts"]["account-a"]["slugs"],
        json!([])
    );
}

#[test]
fn logical_lease_expiry_between_chunk_and_metadata_publication_fails_closed() {
    let store = Store::new();
    let host = Host::new(&store);
    let runtime = CatalogRuntime::new();
    let shared = store.clone();
    store.after_chunks.replace(Some(Rc::new(move || {
        shared.now.set(shared.now.get() + 30001)
    })));
    host.queue(Outcome::json(catalog("late")));
    assert!(run(runtime.versioned_models(&store, &host, "0.163.0", None)).is_err());
    assert!(
        store
            .live(&catalog_store::metadata_key("0.163.0"))
            .is_none()
    );
}

#[test]
fn wrong_version_metadata_never_serves_another_versions_rows() {
    let store = Store::new(); let host = Host::new(&store); let runtime = CatalogRuntime::new();
    store.seed("0.162.0", store.now.get(), &catalog("other").to_string(), None);
    let other = store.live(&catalog_store::metadata_key("0.162.0")).unwrap();
    store.put(catalog_store::metadata_key("0.163.0"), "corrupt", other.value);
    assert!(run(runtime.versioned_models(&store, &host, "0.163.0", None)).is_err()); assert!(host.requests.borrow().is_empty());
}

#[test]
fn overlapping_forced_provider_refreshes_keep_the_newer_publication() {
    let store = Store::new(); let host = Host::new(&store); let runtime = CatalogRuntime::new(); host.provider(CatalogProvider::Openlux, "openlux-owner");
    let mut slow = Outcome::json(json!({"data":[{"id":"older"}]})); slow.ticks = 1; host.queue(slow);
    host.queue(Outcome::json(json!({"data":[{"id":"newer"}]})));
    let mut first = std::pin::pin!(runtime.refresh_provider(&store, &host, CatalogProvider::Openlux, true));
    let waker = Waker::from(Arc::new(Noop)); let mut cx = Context::from_waker(&waker);
    assert!(first.as_mut().poll(&mut cx).is_pending());
    let second = run(runtime.refresh_provider(&store, &host, CatalogProvider::Openlux, true)).unwrap().unwrap();
    let first = run(first).unwrap().unwrap(); assert_eq!(second.models[0]["id"], "newer"); assert_eq!(first.models[0]["id"], "newer");
}

#[test]
fn version_pruning_failure_is_observed_without_discarding_the_catalog_answer() {
    let store = Store::new(); let host = Host::new(&store); let runtime = CatalogRuntime::new(); store.fail_query.set(true);
    host.queue(Outcome::json(catalog("served")));
    let response = run(runtime.versioned_models(&store, &host, "0.163.0", None)).unwrap(); assert_eq!(ids(&response), ["served"]);
    assert!(host.observations.borrow().iter().any(|event| matches!(event, CatalogObservation::MaintenanceFailure { operation: CatalogMaintenance::VersionPruning, .. })));
}
