use gateway_catalog_runtime::{admin::*, state, *};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::{QueryEntry, QueryPage, QueryRequest, QueryStore},
    source_json::SourceJson,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::TupleKey,
};
use gateway_schema::{
    aliases::SourceStringCollator,
    catalog::{ordinary_models as ordinary_models_source, public_catalog as public_catalog_source},
    catalog_store,
    runtime_config::build_runtime_config as build_runtime_config_source,
    snapshot::{ModelSnapshot, SnapshotOverrides, normalize_snapshot as normalize_snapshot_source},
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    cmp::Ordering,
    collections::{BTreeMap, VecDeque},
    future::{Future, poll_fn},
    rc::Rc,
    sync::Arc,
    task::{Context, Poll, Waker},
};

// Explicit scalar observations of these unchanged frozen scalar fixtures, not a runtime fallback.
fn lift(value: &Value) -> SourceJson {
    SourceJson::from_serializable(value).unwrap()
}
fn scalar(value: &SourceJson) -> Value {
    value.deserialize().expect("frozen scalar fixture")
}
fn normalize_snapshot(
    value: &Value,
    overrides: &SnapshotOverrides,
    now: i64,
) -> Option<ModelSnapshot> {
    normalize_snapshot_source(&lift(value), overrides, now)
}
fn build_runtime_config(
    snapshot: &ModelSnapshot,
    model: Option<&str>,
    effort: Option<&str>,
    now: i64,
) -> Result<Value, gateway_schema::source_request::SourceRequestError> {
    build_runtime_config_source(
        snapshot,
        model.map(Into::into).as_ref(),
        effort.map(Into::into).as_ref(),
        now,
    )
    .map(|value| scalar(&value))
}
fn ordinary_models(input: &gateway_schema::catalog::CatalogInput) -> Value {
    scalar(&ordinary_models_source(input))
}
fn public_catalog(input: &gateway_schema::catalog::CatalogInput) -> Value {
    scalar(&public_catalog_source(input, Host::new().source_string_collator().as_ref()).unwrap())
}
struct ScalarResponse {
    body: Value,
    headers: BTreeMap<String, String>,
}
fn scalar_response(response: AdminCatalogResponse) -> ScalarResponse {
    ScalarResponse {
        body: scalar(&response.body),
        headers: response.headers,
    }
}
struct FixtureCollator {
    order: Vec<String>,
    failed: bool,
}
impl SourceStringCollator for FixtureCollator {
    fn compare(&self, left: &JsString16, right: &JsString16) -> Result<Ordering, GatewayError> {
        if self.failed {
            return Err(GatewayError::unavailable(
                "Locale comparator unavailable",
                "fixture_collation",
            ));
        }
        let rank = |value: &JsString16| {
            self.order
                .iter()
                .position(|id| value.as_units().iter().copied().eq(id.encode_utf16()))
                .expect("locale case absent from source oracle")
        };
        Ok(rank(left).cmp(&rank(right)))
    }
}
fn run<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    for _ in 0..10_000 {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
    }
    panic!("test future did not settle");
}
type Hook = Rc<dyn Fn()>;
#[derive(Clone, Default)]
struct Store {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    fail_key: Rc<RefCell<Option<RecordKey>>>,
    before_commit: Rc<RefCell<Option<Hook>>>,
    forced_conflicts: Rc<Cell<u32>>,
    attempts: Rc<Cell<u32>>,
}
impl Store {
    fn put(&self, key: RecordKey, revision: &str, value: Value) {
        self.rows
            .borrow_mut()
            .insert(key.0, StoredRecord::json(revision, value, None));
    }
    fn value(&self, key: &RecordKey) -> Value {
        self.rows
            .borrow()
            .get(&key.0)
            .map(|r| r.value.clone())
            .unwrap_or(Value::Null)
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        if self.fail_key.borrow().as_ref() == Some(key) {
            return Err(GatewayError::unavailable(
                "Fixture read unavailable",
                "fixture_read",
            ));
        }
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.attempts.set(self.attempts.get() + 1);
        let hook = self.before_commit.borrow_mut().take();
        if let Some(hook) = hook {
            hook();
        }
        if self.forced_conflicts.get() > 0 {
            self.forced_conflicts.set(self.forced_conflicts.get() - 1);
            return Ok(CommitOutcome::Conflict);
        }
        if transition.checks.iter().any(|check| {
            self.rows.borrow().get(&check.key.0).map(|r| &r.revision)
                != check.expected_revision.as_ref()
        }) {
            return Ok(CommitOutcome::Conflict);
        }
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
        Ok(CommitOutcome::Committed)
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
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
    body: Result<Value, GatewayError>,
    gate: Option<Rc<Cell<bool>>>,
    hook: Option<Hook>,
}
impl Outcome {
    fn json(body: Value) -> Self {
        Self {
            body: Ok(body),
            gate: None,
            hook: None,
        }
    }
}
struct Host {
    now: Cell<i64>,
    sequence: Cell<u32>,
    publication: RefCell<CredentialPublication>,
    responses: RefCell<BTreeMap<CatalogProvider, VecDeque<Outcome>>>,
    codex: RefCell<VecDeque<Outcome>>,
    requests: RefCell<Vec<CatalogFetch>>,
    order: Vec<String>,
    fail_compare: Cell<bool>,
    fail_publication: Cell<bool>,
    warmed: Cell<u32>,
}
impl Host {
    fn new() -> Self {
        let golden: Value =
            serde_json::from_str(include_str!("fixtures/admin-catalog-golden.json")).unwrap();
        Self {
            now: Cell::new(1_800_000_000_000),
            sequence: Cell::new(0),
            publication: RefCell::default(),
            responses: RefCell::default(),
            codex: RefCell::default(),
            requests: RefCell::default(),
            order: golden["locale_order"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect(),
            fail_compare: Cell::new(false),
            fail_publication: Cell::new(false),
            warmed: Cell::new(0),
        }
    }
    fn configure(&self, provider: CatalogProvider, identity: &str) {
        self.publication.borrow_mut().providers.insert(
            provider,
            ProviderBinding {
                identity: identity.into(),
            },
        );
    }
    fn queue(&self, provider: CatalogProvider, body: Value) {
        self.responses
            .borrow_mut()
            .entry(provider)
            .or_default()
            .push_back(Outcome::json(body));
    }
    fn seed(&self, store: &Store, model: &str, version: &str) {
        let snapshot = normalize_snapshot(
            &json!({"models":[{"slug":model}],"client_version":version}),
            &SnapshotOverrides::default(),
            self.now.get(),
        )
        .unwrap();
        store.put(catalog_store::codex_snapshot_key(), "seed", json!(snapshot));
        store.put(
            catalog_store::runtime_config_key(),
            "runtime",
            build_runtime_config(&snapshot, None, Some("max"), self.now.get()).unwrap(),
        );
        store.put(
            catalog_store::auth_generation_key(),
            "generation",
            json!("generation"),
        );
    }
}
impl CatalogHost for Host {
    fn source_string_collator(&self) -> Arc<dyn SourceStringCollator> {
        Arc::new(FixtureCollator {
            order: self.order.clone(),
            failed: self.fail_compare.get(),
        })
    }
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn unique_id(&self) -> String {
        let id = self.sequence.get() + 1;
        self.sequence.set(id);
        format!("m24-{id}")
    }
    async fn wait(&self, milliseconds: u32) -> Result<(), GatewayError> {
        let mut yielded = false;
        poll_fn(|context| {
            if yielded {
                Poll::Ready(())
            } else {
                yielded = true;
                context.waker().wake_by_ref();
                Poll::Pending
            }
        })
        .await;
        self.now.set(self.now.get() + i64::from(milliseconds));
        Ok(())
    }
    async fn publication(&self) -> Result<CredentialPublication, GatewayError> {
        if self.fail_publication.get() {
            return Err(GatewayError::unavailable(
                "Publication unavailable",
                "fixture_publication",
            ));
        }
        Ok(self.publication.borrow().clone())
    }
    async fn fetch(&self, request: CatalogFetch) -> Result<CatalogFetchResponse, GatewayError> {
        let outcome = match &request {
            CatalogFetch::Provider { provider, .. } => self
                .responses
                .borrow_mut()
                .get_mut(provider)
                .and_then(VecDeque::pop_front),
            CatalogFetch::Codex { .. } => self.codex.borrow_mut().pop_front(),
            CatalogFetch::AnonymousSurplus => self
                .responses
                .borrow_mut()
                .get_mut(&CatalogProvider::Surplus)
                .and_then(VecDeque::pop_front),
        }
        .expect("unexpected metadata fetch");
        self.requests.borrow_mut().push(request);
        if let Some(hook) = outcome.hook {
            hook();
        }
        if let Some(gate) = outcome.gate {
            poll_fn(|context| {
                if gate.get() {
                    Poll::Ready(())
                } else {
                    context.waker().wake_by_ref();
                    Poll::Pending
                }
            })
            .await;
        }
        Ok(CatalogFetchResponse::json(200, outcome.body?.to_string()))
    }
}
impl AdminCatalogHost for Host {
    fn warm_openrouter(&self) {
        self.warmed.set(self.warmed.get() + 1);
    }
}
fn invoke(
    runtime: &CatalogRuntime,
    store: &Store,
    host: &Host,
    operation: AdminCatalogOperation,
) -> ScalarResponse {
    scalar_response(run(runtime.admin_catalog(store, host, operation)).unwrap())
}

#[test]
fn models_get_retains_raw_extensions_and_contains_only_optional_read_failures() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    host.fail_publication.set(true);
    let raw = json!({"models":[{"slug":"x","untouched":true}],"source":" cli ","updated_at_ms":7,"client_version":23,"extension":{"exact":true}});
    store.put(catalog_store::codex_snapshot_key(), "full", raw.clone());
    assert_eq!(
        invoke(
            &runtime,
            &store,
            &host,
            AdminCatalogOperation::CodexModelsGet
        )
        .body,
        json!({"ok":true,"data":raw})
    );
    *store.fail_key.borrow_mut() = Some(catalog_store::codex_snapshot_key());
    assert_eq!(
        invoke(
            &runtime,
            &store,
            &host,
            AdminCatalogOperation::CodexModelsGet
        )
        .body,
        json!({"ok":true,"data":null})
    );
    *store.fail_key.borrow_mut() = Some(state::whitelist_key());
    assert_eq!(
        run(runtime.admin_catalog(&store, &host, AdminCatalogOperation::WhitelistGet))
            .unwrap_err()
            .body()
            .deserialize::<Value>()
            .unwrap()["error"]["code"]
            .as_str(),
        Some("fixture_read")
    );
}

#[test]
fn source_upload_and_whitelist_vectors_match_handler_responses_and_state() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/admin-catalog-golden.json")).unwrap();
    for case in golden["operations"].as_array().unwrap() {
        let runtime = CatalogRuntime::new();
        let store = Store::default();
        let host = Host::new();
        let operation = if case["operation"] == "models" {
            AdminCatalogOperation::CodexModelsSet {
                document: lift(&case["input"].clone()),
            }
        } else {
            AdminCatalogOperation::WhitelistSet {
                document: lift(&case["input"].clone()),
            }
        };
        let actual = match run(runtime.admin_catalog(&store, &host, operation)) {
            Ok(response) => json!({"status":response.status,"body":response.body}),
            Err(error) => json!({"status":error.status,"body":scalar(error.body())}),
        };
        assert_eq!(actual, case["expected"], "{}", case["name"]);
        if actual["status"].as_u64().unwrap() >= 400 {
            assert!(store.rows.borrow().is_empty(), "{}", case["name"]);
        }
        if let Some(snapshot) = case.get("snapshot") {
            assert_eq!(
                store.value(&catalog_store::codex_snapshot_key()),
                *snapshot,
                "{}",
                case["name"]
            );
        }
        if let Some(expected) = case.get("runtime") {
            assert_eq!(
                store.value(&catalog_store::runtime_config_key()),
                *expected,
                "{}",
                case["name"]
            );
        }
    }
}

#[test]
fn two_key_save_retries_real_cas_and_retains_concurrent_runtime_default_without_generation_rotation()
 {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    host.seed(&store, "a", "1.0.0");
    let race_store = store.clone();
    let now = host.now.get();
    *store.before_commit.borrow_mut() = Some(Rc::new(move || {
        let snapshot = normalize_snapshot(
            &json!({"models":[{"slug":"b"},{"slug":"a"}]}),
            &SnapshotOverrides::default(),
            now,
        )
        .unwrap();
        race_store.put(
            catalog_store::codex_snapshot_key(),
            "refresh",
            json!(snapshot),
        );
        race_store.put(
            catalog_store::runtime_config_key(),
            "refresh-runtime",
            build_runtime_config(&snapshot, Some("b"), Some("ultra"), now).unwrap(),
        );
    }));
    let result = invoke(
        &runtime,
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet {
            document: lift(&json!({"models":[{"slug":"a"},{"slug":"b"}],"client_version":"2.0.0"})),
        },
    );
    assert_eq!(result.body["count"], 2);
    assert_eq!(store.attempts.get(), 2);
    let config = store.value(&catalog_store::runtime_config_key());
    assert_eq!(config["default_model"], "b");
    assert_eq!(config["default_reasoning_effort"], "ultra");
    assert_eq!(
        store.value(&catalog_store::auth_generation_key()),
        "generation"
    );
    let rows = store.rows.borrow();
    assert_eq!(
        rows[&catalog_store::codex_snapshot_key().0].revision,
        rows[&catalog_store::runtime_config_key().0].revision
    );
}

#[test]
fn exhausted_conflicts_leave_both_original_rows_and_report_source_failure() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    host.seed(&store, "a", "1.0.0");
    let original = store.value(&catalog_store::codex_snapshot_key());
    let config = store.value(&catalog_store::runtime_config_key());
    store.forced_conflicts.set(3);
    let error = run(runtime.admin_catalog(
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet {
            document: lift(&json!({"models":[{"slug":"b"}]})),
        },
    ))
    .unwrap_err();
    assert_eq!(error.status, 500);
    assert_eq!(store.attempts.get(), 3);
    assert_eq!(store.value(&catalog_store::codex_snapshot_key()), original);
    assert_eq!(store.value(&catalog_store::runtime_config_key()), config);
}

#[test]
fn replacement_upload_preserves_verified_negative_prompt_cache_evidence() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    invoke(
        &runtime,
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet {
            document: lift(&json!({"models":[{"slug":"a","prompt_cache":false}]})),
        },
    );
    invoke(
        &runtime,
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet {
            document: lift(&json!({"models":[{"slug":"a"}]})),
        },
    );
    assert_eq!(
        store.value(&catalog_store::codex_snapshot_key())["models"][0]["prompt_cache"],
        false
    );
    assert_eq!(
        store.value(&catalog_store::runtime_config_key())["codex_models"]["models"][0]["prompt_cache"],
        false
    );
}

#[test]
fn whitelist_source_write_is_unconditional_retains_unknown_ids_and_empty_list_clears_filter() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    let raced = store.clone();
    *store.fail_key.borrow_mut() = Some(state::whitelist_key());
    *store.before_commit.borrow_mut() = Some(Rc::new(move || {
        raced.put(
            state::whitelist_key(),
            "other",
            json!({"model_ids":["other"],"updated_at_ms":1}),
        )
    }));
    let result = invoke(
        &runtime,
        &store,
        &host,
        AdminCatalogOperation::WhitelistSet {
            document: lift(&json!({"model_ids":[" missing ","missing",""]})),
        },
    );
    assert_eq!(result.body["model_ids"], json!(["missing"]));
    assert_eq!(store.attempts.get(), 1);
    *store.fail_key.borrow_mut() = None;
    assert_eq!(
        invoke(&runtime, &store, &host, AdminCatalogOperation::WhitelistGet).body["data"]["model_ids"],
        json!(["missing"])
    );
    invoke(
        &runtime,
        &store,
        &host,
        AdminCatalogOperation::WhitelistSet {
            document: lift(&json!({"model_ids":[]})),
        },
    );
    assert_eq!(
        invoke(&runtime, &store, &host, AdminCatalogOperation::WhitelistGet).body["data"]["model_ids"],
        json!([])
    );
}

#[test]
fn picker_is_unfiltered_uses_actual_host_order_and_keeps_runtime_when_optional_snapshot_fails() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    host.queue(CatalogProvider::Surplus, json!({"data":[]}));
    invoke(
        &runtime,
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet {
            document: lift(
                &json!({"models":[{"slug":"z"},{"slug":"A"},{"slug":"a"},{"slug":"ä"}]}),
            ),
        },
    );
    store.put(
        state::whitelist_key(),
        "whitelist",
        json!({"model_ids":["z"],"updated_at_ms":1}),
    );
    store.put(
        state::selection_key(),
        "selection",
        json!({"provider_ids":["surplus"],"updated_at_ms":1}),
    );
    *store.fail_key.borrow_mut() = Some(catalog_store::codex_snapshot_key());
    let response = invoke(&runtime, &store, &host, AdminCatalogOperation::Catalog);
    assert_eq!(
        response.body["data"]["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a", "A", "ä", "z"]
    );
    assert_eq!(response.body["data"]["filter_active"], true);
    assert_eq!(response.headers["cache-control"], "no-store");
    let input = run(runtime.load_state(&store, &host.publication.borrow(), host.now.get()))
        .unwrap()
        .input;
    assert!(
        ordinary_models(&input)["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        public_catalog(&input)["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    host.fail_compare.set(true);
    assert_eq!(
        run(runtime.admin_catalog(&store, &host, AdminCatalogOperation::Catalog))
            .unwrap_err()
            .body()
            .deserialize::<Value>()
            .unwrap()["error"]["code"]
            .as_str(),
        Some("fixture_collation")
    );
}

#[test]
fn aggregate_refresh_forces_fixed_providers_preserves_last_good_and_marks_stale_claude() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    for provider in [
        CatalogProvider::Openlux,
        CatalogProvider::Surplus,
        CatalogProvider::Lithos,
        CatalogProvider::ClaudeCode,
    ] {
        host.configure(provider, provider.id());
    }
    host.queue(
        CatalogProvider::Openrouter,
        json!({"data":[{"id":"a","context_length":1000}]}),
    );
    host.queue(
        CatalogProvider::Openlux,
        json!({"data":[{"id":"a","supported_endpoint_types":["openai"]}]}),
    );
    host.queue(
        CatalogProvider::Surplus,
        json!({"data":[{"id":"b","supported_endpoint_types":["openai-response"]}]}),
    );
    host.queue(CatalogProvider::Lithos, json!({"data":[{"id":"c"}]}));
    host.queue(CatalogProvider::ClaudeCode,json!({"data":[{"id":"claude-observed","type":"model","display_name":"Observed","created_at":"2026-01-01T00:00:00Z"}],"has_more":false}));
    let first = invoke(&runtime, &store, &host, AdminCatalogOperation::Refresh);
    assert_eq!(host.requests.borrow().len(), 5);
    assert_eq!(first.body["data"]["openrouter"]["refreshed"], true);
    assert_eq!(first.body["data"]["claude_code"]["status"], "available");
    host.now.set(host.now.get() + 1);
    for provider in [
        CatalogProvider::Openrouter,
        CatalogProvider::Openlux,
        CatalogProvider::Surplus,
        CatalogProvider::Lithos,
        CatalogProvider::ClaudeCode,
    ] {
        host.responses
            .borrow_mut()
            .entry(provider)
            .or_default()
            .push_back(Outcome {
                body: Err(GatewayError::unavailable(
                    "offline fixture",
                    "fixture_offline",
                )),
                gate: None,
                hook: None,
            });
    }
    let failed = invoke(&runtime, &store, &host, AdminCatalogOperation::Refresh);
    assert_eq!(host.requests.borrow().len(), 10);
    assert_eq!(failed.body["data"]["openrouter"]["refreshed"], false);
    assert_eq!(failed.body["data"]["lithos"]["refreshed"], false);
    for provider in ["openrouter", "openlux", "surplus", "lithos"] {
        assert_eq!(
            failed.body["data"][provider],
            first.body["data"][provider]
                .clone()
                .as_object()
                .map(|row| {
                    let mut row = row.clone();
                    if row.contains_key("refreshed") {
                        row.insert("refreshed".into(), json!(false));
                    }
                    Value::Object(row)
                })
                .unwrap()
        );
    }
    assert_eq!(failed.body["data"]["claude_code"]["models"], 1);
    assert_eq!(failed.body["data"]["claude_code"]["stale"], true);
    assert_eq!(failed.body["data"]["claude_code"]["status"], "unavailable");
}

#[test]
fn replacement_during_pending_refresh_cannot_return_old_identity_snapshot() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    host.configure(CatalogProvider::Openlux, "first");
    let gate = Rc::new(Cell::new(false));
    host.queue(CatalogProvider::Openrouter, json!({"data":[]}));
    host.queue(CatalogProvider::Surplus, json!({"data":[]}));
    host.responses
        .borrow_mut()
        .entry(CatalogProvider::Openlux)
        .or_default()
        .push_back(Outcome {
            body: Ok(json!({"data":[{"id":"old","supported_endpoint_types":["openai"]}]})),
            gate: Some(gate.clone()),
            hook: None,
        });
    let mut pending =
        std::pin::pin!(runtime.admin_catalog(&store, &host, AdminCatalogOperation::Refresh));
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    assert!(pending.as_mut().poll(&mut context).is_pending());
    assert_eq!(host.requests.borrow().len(), 3);
    host.configure(CatalogProvider::Openlux, "replacement");
    gate.set(true);
    let result = scalar_response(run(pending).unwrap());
    assert_eq!(
        result.body["data"]["openlux"],
        json!({"models":0,"updated_at_ms":null})
    );
}

#[test]
fn cold_picker_starts_three_normal_discoveries_concurrently_and_only_schedules_enrichment() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    let gate = Rc::new(Cell::new(false));
    store.put(
        state::selection_key(),
        "disabled",
        json!({"provider_ids":["codex"],"updated_at_ms":1}),
    );
    for (provider, body) in [
        (
            CatalogProvider::Openlux,
            json!({"data":[{"id":"z","supported_endpoint_types":["openai"]}]}),
        ),
        (CatalogProvider::Surplus, json!({"data":[{"id":"a"}]})),
        (
            CatalogProvider::ClaudeCode,
            json!({"data":[{"id":"claude-a","type":"model","created_at":"2026-01-01T00:00:00Z"}],"has_more":false}),
        ),
    ] {
        host.configure(provider, provider.id());
        host.responses
            .borrow_mut()
            .entry(provider)
            .or_default()
            .push_back(Outcome {
                body: Ok(body),
                gate: Some(gate.clone()),
                hook: None,
            });
    }
    let mut pending =
        std::pin::pin!(runtime.admin_catalog(&store, &host, AdminCatalogOperation::Catalog));
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    assert!(pending.as_mut().poll(&mut context).is_pending());
    assert_eq!(host.warmed.get(), 1);
    assert_eq!(host.requests.borrow().len(), 3);
    assert!(host.requests.borrow().iter().all(|request| !matches!(
        request,
        CatalogFetch::Provider {
            provider: CatalogProvider::Openrouter,
            ..
        }
    )));
    gate.set(true);
    let result = scalar_response(run(pending).unwrap());
    let ids = result.body["data"]["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["a", "claude-a", "ubiquity/deepseek-flash", "z"]);
    invoke(&runtime, &store, &host, AdminCatalogOperation::Catalog);
    assert_eq!(host.warmed.get(), 2);
    assert_eq!(host.requests.borrow().len(), 3);
}

#[test]
fn anonymous_surplus_is_publicly_visible_without_enabling_ordinary_or_paid_routing() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    host.queue(
        CatalogProvider::Surplus,
        json!({"data":[{"id":"a"},{"id":"z"}]}),
    );
    let admin = invoke(&runtime, &store, &host, AdminCatalogOperation::Catalog);
    assert_eq!(admin.body["data"]["models"].as_array().unwrap().len(), 2);
    assert!(matches!(
        host.requests.borrow()[0],
        CatalogFetch::AnonymousSurplus
    ));
    let publication = host.publication.borrow();
    assert!(publication.providers.is_empty());
    let public_state =
        run(runtime.load_public_state(&store, &publication, host.now.get())).unwrap();
    assert!(!public_state.input.configured("surplus"));
    assert_eq!(public_state.input.rows("surplus").len(), 2);
    let ordinary = run(runtime.load_state(&store, &publication, host.now.get())).unwrap();
    assert!(ordinary.input.rows("surplus").is_empty());
    assert!(
        ordinary_models(&ordinary.input)["data"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    drop(publication);
    store.put(
        state::whitelist_key(),
        "only-z",
        json!({"model_ids":["z"],"updated_at_ms":1}),
    );
    let public = scalar_response(run(runtime.public_catalog(&store, &host)).unwrap());
    assert_eq!(public.body["object"], "uos.model_catalog");
    assert_eq!(public.body["data"].as_array().unwrap().len(), 1);
    assert_eq!(public.body["data"][0]["id"], "z");
    assert!(public.body.get("ok").is_none());
    assert!(public.body.get("whitelist").is_none());
    store.put(
        state::selection_key(),
        "disabled",
        json!({"provider_ids":["codex"],"updated_at_ms":1}),
    );
    let disabled = scalar_response(run(runtime.public_catalog(&store, &host)).unwrap());
    assert!(disabled.body["data"].as_array().unwrap().is_empty());
    assert_eq!(host.requests.borrow().len(), 1);
}

#[test]
fn save_while_versioned_discovery_waits_cannot_be_replaced_by_older_version() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    host.seed(&store, "a", "1.0.0");
    host.publication
        .borrow_mut()
        .codex_accounts
        .push(CodexAccount {
            account_id: "fixture-account".into(),
            credential_fingerprint: "fixture-fingerprint".into(),
        });
    let gate = Rc::new(Cell::new(false));
    host.codex.borrow_mut().push_back(Outcome{body:Ok(json!({"models":[{"slug":"old-upstream","supported_reasoning_levels":[{"effort":"none"}]}]})),gate:Some(gate.clone()),hook:None});
    let mut refresh = std::pin::pin!(runtime.versioned_models(&store, &host, "1.1.0", None));
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    assert!(refresh.as_mut().poll(&mut context).is_pending());
    invoke(
        &runtime,
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet {
            document: lift(
                &json!({"models":[{"slug":"new-upload","supported_reasoning_levels":[{"effort":"none"},{"effort":"ultra"},{"effort":"future-tier"}]}],"client_version":"2.0.0"}),
            ),
        },
    );
    gate.set(true);
    let versioned = run(refresh).unwrap();
    let body: Value = serde_json::from_str(versioned.body.as_ref().unwrap()).unwrap();
    assert_eq!(body["models"][0]["slug"], "old-upstream");
    assert_eq!(
        store.value(&catalog_store::codex_snapshot_key())["models"][0]["slug"],
        "new-upload"
    );
    let input = run(runtime.load_state(&store, &host.publication.borrow(), host.now.get()))
        .unwrap()
        .input;
    assert_eq!(ordinary_models(&input)["data"][0]["id"], "new-upload");
    assert_eq!(
        store.value(&catalog_store::auth_generation_key()),
        "generation"
    );
}

#[test]
fn actual_admin_source_documents_publish_opaque_models_source_labels_and_whitelist_units() {
    use gateway_core::{
        source_control::decode_source_control_record, source_serialization as source,
        value::ValueEncoding,
    };
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    let document=SourceJson::parse(r#"{"models":[{"slug":"\ud800","supported_reasoning_levels":["\udc00"],"default_reasoning_level":"\udc00"}],"source":"label\ud800"}"#).unwrap();
    let saved = run(runtime.admin_catalog(
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet {
            document: document.clone(),
        },
    ))
    .unwrap();
    assert_eq!(saved.status, 200);
    assert_eq!(
        source::member(&saved.body, "source"),
        Some(SourceJson::parse(r#""label\ud800""#).unwrap())
    );
    let snapshot = store
        .rows
        .borrow()
        .get(&catalog_store::codex_snapshot_key().0)
        .unwrap()
        .clone();
    let config = store
        .rows
        .borrow()
        .get(&catalog_store::runtime_config_key().0)
        .unwrap()
        .clone();
    assert_eq!(snapshot.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(config.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(snapshot.revision, config.revision);
    assert_eq!(snapshot.expires_at_ms, None);
    assert_eq!(config.expires_at_ms, None);
    let fetched =
        run(runtime.admin_catalog(&store, &host, AdminCatalogOperation::CodexModelsGet)).unwrap();
    assert_eq!(
        source::member(&fetched.body, "data"),
        Some(decode_source_control_record(&snapshot).unwrap())
    );
    let whitelist = SourceJson::parse(r#"{"model_ids":["\ud800","\udc00","\\ud800"]}"#).unwrap();
    let saved = run(runtime.admin_catalog(
        &store,
        &host,
        AdminCatalogOperation::WhitelistSet {
            document: whitelist.clone(),
        },
    ))
    .unwrap();
    assert_eq!(
        source::member(&saved.body, "model_ids"),
        source::member(&whitelist, "model_ids")
    );
    let fetched =
        run(runtime.admin_catalog(&store, &host, AdminCatalogOperation::WhitelistGet)).unwrap();
    let data = source::member(&fetched.body, "data").unwrap();
    assert_eq!(
        source::member(&data, "model_ids"),
        source::member(&whitelist, "model_ids")
    );
    assert_eq!(
        store
            .rows
            .borrow()
            .get(&state::whitelist_key().0)
            .unwrap()
            .value_encoding,
        ValueEncoding::ProfileV2
    );
    assert!(host.requests.borrow().is_empty());
    println!(
        "M42_ADMIN_SOURCE_WRITER_FIXTURE={}",
        serde_json::to_string(&(catalog_store::codex_snapshot_key().0, snapshot)).unwrap()
    );
}

#[test]
fn blank_source_label_is_rejected_before_admin_publication_mutates_rows() {
    let runtime = CatalogRuntime::new();
    let store = Store::default();
    let host = Host::new();
    let document = SourceJson::parse(r#"{"models":[{"slug":"a"}],"source":""}"#).unwrap();
    let error = run(runtime.admin_catalog(
        &store,
        &host,
        AdminCatalogOperation::CodexModelsSet { document },
    ))
    .unwrap_err();
    assert_eq!(error.status, 409);
    assert!(store.rows.borrow().is_empty());
    assert!(host.requests.borrow().is_empty());
}
