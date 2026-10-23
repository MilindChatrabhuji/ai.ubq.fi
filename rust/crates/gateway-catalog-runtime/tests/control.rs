mod original_request_fixture;
mod support;

use support::source_catalog;
type MemoryStore = Store;
type TestAuthority = gateway_authority::Authority<Store, Tokens>;
use gateway_authority::{keys, paid_control::*};
use gateway_catalog_runtime::{state, *};
use gateway_core::{
    GatewayError,
    provider::PaidProvider,
    query::{QueryPage, QueryRequest, QueryStore},
    source_control::decode_source_control_record,
    source_json::SourceJson,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
};
use gateway_schema::{
    catalog_store, runtime_config::build_runtime_config, snapshot::ModelSnapshot,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    future::{Future, poll_fn},
    rc::Rc,
    sync::Arc,
    task::{Context, Poll, Waker},
};
fn run<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
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
    before_policy: Rc<RefCell<Option<Callback>>>,
}
impl Store {
    fn new() -> Self {
        Self {
            rows: Rc::default(),
            now: Rc::new(Cell::new(1_800_000_000_000)),
            before_policy: Rc::default(),
        }
    }
    fn put(&self, key: RecordKey, revision: &str, value: Value) {
        self.rows
            .borrow_mut()
            .insert(key.0, StoredRecord::json(revision, value, None));
    }
    fn get(&self, key: &RecordKey) -> Option<StoredRecord> {
        self.rows
            .borrow()
            .get(&key.0)
            .filter(|row| row.expires_at_ms.is_none_or(|until| until > self.now.get()))
            .cloned()
    }
    fn config(&self, generation: &str, revision: &str, surplus: bool, openlux: bool) {
        self.put(
            keys::paid_control_config(),
            revision,
            json!(PaidControlConfig {
                v: PAID_CONTROL_CONFIG_VERSION,
                owner_id: "fixture-owner".into(),
                owner_epoch: "epoch-1".into(),
                generation: generation.into(),
                configuration_fingerprint: format!("configuration-{generation}"),
                surplus_binding: surplus.then(|| "surplus-credential".into()),
                openlux_discovery_binding: openlux.then(|| "openlux-discovery-credential".into()),
                openlux_binding: openlux.then(|| "openlux-credential".into()),
                source_checks: Vec::new()
            }),
        );
    }
    fn install(&self, surplus: bool, openlux: bool) {
        self.put(
            keys::paid_control_owner(),
            "owner-rev",
            json!(PaidControlOwner {
                v: 1,
                owner_id: "fixture-owner".into(),
                owner_epoch: "epoch-1".into(),
                key_fingerprint: "ephemeral-fixture-carrier-fingerprint".into()
            }),
        );
        self.config("generation-1", "config-rev", surplus, openlux);
        let snapshot = ModelSnapshot {
            models: vec![source_catalog::json(
                &json!({"slug":"gpt-known","context_window":128000,"supported_reasoning_levels":[{"effort":null},{"effort":"custom-tier"}]}),
            )],
            source: "chatgpt_codex".into(),
            updated_at_ms: self.now.get(),
            client_version: Some("0.163.0".into()),
        };
        self.put(
            catalog_store::runtime_config_key(),
            "runtime-rev",
            build_runtime_config(&snapshot, None, None, self.now.get())
                .unwrap()
                .deserialize::<Value>()
                .unwrap(),
        );
        self.put(
            catalog_store::codex_snapshot_key(),
            "full-rev",
            json!(snapshot),
        );
        self.put(
            catalog_store::auth_generation_key(),
            "catalog-generation-rev",
            json!("catalog-generation"),
        );
    }
    // Reuse the established authority fixture's full journal writer and actual
    // reserve_api_key/bind_paid_original_request flow; do not clone its DTO.
    fn row(&self, key: &RecordKey) -> Option<StoredRecord> {
        self.get(key)
    }
    fn seed(&self, key: RecordKey, value: &Value) {
        self.put(key, "original-fixture", value.clone());
    }
    fn projection(&self) -> PaidRoutingProjection {
        decode_source_control_record(&self.get(&keys::paid_routing()).unwrap())
            .unwrap()
            .deserialize()
            .unwrap()
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.get(key))
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if transition.mutations.iter().any(
            |mutation| matches!(mutation,RecordMutation::Put{key,..}if *key==keys::paid_routing()),
        ) {
            let callback = self.before_policy.borrow_mut().take();
            if let Some(callback) = callback {
                callback();
            }
        }
        if transition.checks.iter().any(|check| {
            self.get(&check.key).as_ref().map(|row| &row.revision)
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
        request.validate()?;
        Err(GatewayError::unavailable(
            "This fixed-key publisher must not scan state",
            "unexpected_query",
        ))
    }
}
struct Fetch {
    body: SourceJson,
    status: u16,
    ticks: u32,
    after: Option<Callback>,
}
struct Host {
    store: Store,
    publication: RefCell<CredentialPublication>,
    responses: RefCell<VecDeque<Fetch>>,
    requests: RefCell<Vec<CatalogFetch>>,
    sequence: Cell<u32>,
}
impl Host {
    fn new(store: &Store, surplus: bool, openlux: bool) -> Self {
        let mut providers = BTreeMap::new();
        if surplus {
            providers.insert(
                CatalogProvider::Surplus,
                ProviderBinding {
                    identity: "surplus-credential".into(),
                },
            );
        }
        if openlux {
            providers.insert(
                CatalogProvider::Openlux,
                ProviderBinding {
                    identity: "openlux-discovery-credential".into(),
                },
            );
        }
        Self {
            store: store.clone(),
            publication: RefCell::new(CredentialPublication {
                providers,
                ..CredentialPublication::default()
            }),
            responses: RefCell::default(),
            requests: RefCell::default(),
            sequence: Cell::new(0),
        }
    }
    fn queue(&self, body: Value) {
        self.queue_source(source_catalog::json(&body));
    }
    fn queue_source(&self, body: SourceJson) {
        self.responses.borrow_mut().push_back(Fetch {
            body,
            status: 200,
            ticks: 0,
            after: None,
        });
    }
}
impl CatalogHost for Host {
    fn source_string_collator(&self) -> Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        Arc::new(source_catalog::Collator::captured())
    }
    fn now_ms(&self) -> i64 {
        self.store.now.get()
    }
    fn unique_id(&self) -> String {
        let sequence = self.sequence.get() + 1;
        self.sequence.set(sequence);
        format!("observation-{sequence}")
    }
    async fn wait(&self, milliseconds: u32) -> Result<(), GatewayError> {
        self.store
            .now
            .set(self.store.now.get() + i64::from(milliseconds));
        Ok(())
    }
    async fn publication(&self) -> Result<CredentialPublication, GatewayError> {
        Ok(self.publication.borrow().clone())
    }
    async fn fetch(&self, request: CatalogFetch) -> Result<CatalogFetchResponse, GatewayError> {
        self.requests.borrow_mut().push(request);
        let response = self
            .responses
            .borrow_mut()
            .pop_front()
            .expect("unexpected provider discovery");
        let mut ticks = response.ticks;
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
        if let Some(callback) = response.after {
            callback();
        }
        Ok(CatalogFetchResponse::json(
            response.status,
            response.body.as_str().to_owned(),
        ))
    }
}
fn surplus(id: &str) -> Value {
    json!({"data":[{"id":id,"supported_parameters":["tools","tool_choice"],"supported_features":["tools"],"pricing":{"prompt":"0.001","completion":"0.002"}}]})
}
fn openlux(id: &str) -> Value {
    json!({"data":[{"id":id,"supported_endpoint_types":["openai-response","openai"]}]})
}

#[test]
fn missing_authenticated_control_owner_refuses_without_fetch_or_policy_write() {
    let store = Store::new();
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    assert_eq!(
        run(runtime.publish_paid_routing(&store, &host))
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("paid_control_unavailable")
    );
    assert!(host.requests.borrow().is_empty());
    assert!(store.get(&keys::paid_routing()).is_none());
}
#[test]
fn openlux_spend_identity_cannot_substitute_for_discovery_identity() {
    let store = Store::new();
    store.install(false, true);
    let host = Host::new(&store, false, true);
    host.publication
        .borrow_mut()
        .providers
        .get_mut(&CatalogProvider::Openlux)
        .unwrap()
        .identity = "openlux-credential".into();
    assert!(run(CatalogRuntime::new().publish_paid_routing(&store, &host)).is_err());
    assert!(host.requests.borrow().is_empty());
    assert!(store.get(&keys::paid_routing()).is_none());
}
#[test]
fn one_fact_legacy_configuration_is_rejected_before_discovery() {
    let store = Store::new();
    store.install(false, true);
    let mut record = store.get(&keys::paid_control_config()).unwrap();
    record.value["v"] = json!(1);
    record
        .value
        .as_object_mut()
        .unwrap()
        .remove("openlux_discovery_binding");
    store.put(keys::paid_control_config(), "legacy-config", record.value);
    let host = Host::new(&store, false, true);
    assert!(run(CatalogRuntime::new().publish_paid_routing(&store, &host)).is_err());
    assert!(host.requests.borrow().is_empty());
}
#[test]
fn real_fixed_publisher_captures_provider_facts_and_all_six_source_fences() {
    let store = Store::new();
    store.install(true, true);
    let host = Host::new(&store, true, true);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("gpt-known"));
    host.queue(openlux("gpt-known"));
    let receipt = run(runtime.publish_paid_routing(&store, &host)).unwrap();
    let policy = store.projection();
    assert_eq!(policy.policy.v, 2);
    assert_eq!(
        policy.policy.models[&"gpt-known".into()],
        vec![PaidProvider::Surplus, PaidProvider::Metered]
    );
    assert_eq!(
        receipt.revision(),
        store.get(&keys::paid_routing()).unwrap().revision
    );
    assert_eq!(policy.provenance.source_checks.len(), 6);
    assert!(policy.provenance.source_valid_until_ms.is_none());
    assert!(
        store
            .get(&keys::paid_routing())
            .unwrap()
            .expires_at_ms
            .is_none()
    );
    let observation: PaidProviderObservation = decode_source_control_record(
        &store
            .get(&keys::paid_control_observation(PaidProvider::Surplus))
            .unwrap(),
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(
        observation.models[0].deserialize::<Value>().unwrap()["input_price_per_token"],
        0.001
    );
    assert_eq!(
        observation.models[0].deserialize::<Value>().unwrap()["supports_tools"],
        true
    );
    assert!(observation.source_checks.is_empty());
    let openlux: PaidProviderObservation = decode_source_control_record(
        &store
            .get(&keys::paid_control_observation(PaidProvider::Metered))
            .unwrap(),
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(openlux.credential_binding, "openlux-discovery-credential");
}
#[test]
fn retained_stale_catalog_is_usable_without_invented_refresh_expiry() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("paid-only"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    store.now.set(store.now.get() + 10 * 86_400_000);
    let count = host.requests.borrow().len();
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert_eq!(host.requests.borrow().len(), count);
    assert_eq!(
        store.projection().policy.models[&"paid-only".into()],
        vec![PaidProvider::Surplus]
    );
    assert!(
        store
            .projection()
            .provenance
            .source_valid_until_ms
            .is_none()
    );
}
#[test]
fn failed_openlux_discovery_preserves_explicit_known_codex_missing_catalog_fallback() {
    let store = Store::new();
    store.install(false, true);
    let host = Host::new(&store, false, true);
    let runtime = CatalogRuntime::new();
    host.responses.borrow_mut().push_back(Fetch {
        body: source_catalog::json(&json!({})),
        status: 503,
        ticks: 0,
        after: None,
    });
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    let projection = store.projection();
    assert_eq!(
        projection.policy.models[&"gpt-known".into()],
        vec![PaidProvider::Metered]
    );
    assert!(projection.provenance.openlux_observation_revision.is_none());
    assert!(
        store
            .get(&keys::paid_control_observation(PaidProvider::Metered))
            .is_none()
    );
}
#[test]
fn failed_surplus_discovery_cannot_manufacture_a_priced_route() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.responses.borrow_mut().push_back(Fetch {
        body: source_catalog::json(&json!({})),
        status: 500,
        ticks: 0,
        after: None,
    });
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert!(store.projection().policy.models.is_empty());
}
#[test]
fn empty_openlux_catalog_is_distinct_from_missing_and_disables_fallback() {
    let store = Store::new();
    store.install(false, true);
    let host = Host::new(&store, false, true);
    let runtime = CatalogRuntime::new();
    host.queue(json!({"data":[]}));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert!(store.projection().policy.models.is_empty());
    assert!(
        store
            .projection()
            .provenance
            .openlux_observation_revision
            .is_some()
    );
}
#[test]
fn superseded_configuration_during_fetch_cannot_publish_an_observation() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    let other = store.clone();
    host.responses.borrow_mut().push_back(Fetch {
        body: source_catalog::json(&surplus("old")),
        status: 200,
        ticks: 0,
        after: Some(Rc::new(move || {
            other.config("generation-2", "new-config-rev", true, false)
        })),
    });
    assert!(
        run(runtime.publish_paid_observation(&store, &host, PaidProvider::Surplus, true)).is_err()
    );
    assert!(
        store
            .get(&keys::paid_control_observation(PaidProvider::Surplus))
            .is_none()
    );
}
#[test]
fn source_selection_change_across_await_fails_the_original_projection_cas() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    let other = store.clone();
    host.responses.borrow_mut().push_back(Fetch {
        body: source_catalog::json(&surplus("old")),
        status: 200,
        ticks: 0,
        after: Some(Rc::new(move || {
            other.put(
                state::selection_key(),
                "selection-changed",
                json!({"provider_ids":["codex"],"updated_at_ms":other.now.get()}),
            )
        })),
    });
    assert!(run(runtime.publish_paid_routing(&store, &host)).is_err());
    assert!(store.get(&keys::paid_routing()).is_none());
    assert!(
        store
            .get(&keys::paid_control_observation(PaidProvider::Surplus))
            .is_none()
    );
}
#[test]
fn control_change_immediately_before_policy_commit_refuses_atomically() {
    let store = Store::new();
    store.install(false, false);
    let host = Host::new(&store, false, false);
    let runtime = CatalogRuntime::new();
    let other = store.clone();
    store.before_policy.replace(Some(Rc::new(move || {
        other.put(
            catalog_store::auth_generation_key(),
            "new-generation",
            json!("new-generation"),
        )
    })));
    assert!(run(runtime.publish_paid_routing(&store, &host)).is_err());
    assert!(store.get(&keys::paid_routing()).is_none());
}
#[test]
fn newer_observation_wins_and_older_awaited_producer_cannot_roll_it_back() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.responses.borrow_mut().push_back(Fetch {
        body: source_catalog::json(&surplus("older")),
        status: 200,
        ticks: 1,
        after: None,
    });
    host.queue(surplus("newer"));
    let mut first = std::pin::pin!(runtime.publish_paid_observation(
        &store,
        &host,
        PaidProvider::Surplus,
        true
    ));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(first.as_mut().poll(&mut cx).is_pending());
    let second =
        run(runtime.publish_paid_observation(&store, &host, PaidProvider::Surplus, true)).unwrap();
    assert!(run(first).is_err());
    let row = store
        .get(&keys::paid_control_observation(PaidProvider::Surplus))
        .unwrap();
    assert_eq!(Some(row.revision.as_str()), second.revision());
    assert_eq!(row.value["models"][0]["id"], "newer");
}
#[test]
fn publication_replaces_full_model_map_and_never_retains_removed_permissions() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("old-paid-model"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    host.queue(surplus("new-paid-model"));
    run(runtime.publish_paid_observation(&store, &host, PaidProvider::Surplus, true)).unwrap();
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert!(
        !store
            .projection()
            .policy
            .models
            .contains_key(&"old-paid-model".into())
    );
    assert!(
        store
            .projection()
            .policy
            .models
            .contains_key(&"new-paid-model".into())
    );
}
#[test]
fn selection_update_does_not_expire_unrelated_provider_observation() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("paid-only"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    store.put(
        state::selection_key(),
        "selection2",
        json!({"provider_ids":["codex"],"updated_at_ms":store.now.get()}),
    );
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert!(store.projection().policy.models.is_empty());
    assert_eq!(host.requests.borrow().len(), 1);
}
#[test]
fn current_binding_mismatch_refuses_instead_of_trusting_a_caller_fingerprint() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    host.publication.borrow_mut().providers.insert(
        CatalogProvider::Surplus,
        ProviderBinding {
            identity: "wrong-binding".into(),
        },
    );
    let runtime = CatalogRuntime::new();
    assert!(run(runtime.publish_paid_routing(&store, &host)).is_err());
    assert!(host.requests.borrow().is_empty());
}
#[test]
fn advertised_whitelist_does_not_become_an_extra_paid_runtime_allowlist() {
    let store = Store::new();
    store.install(true, false);
    store.put(
        state::whitelist_key(),
        "whitelist",
        json!({"model_ids":["different-advertised-model"],"updated_at_ms":store.now.get()}),
    );
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("paid-only"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert!(
        store
            .projection()
            .policy
            .models
            .contains_key(&"paid-only".into())
    );
}
#[test]
fn synthetic_possible_index_does_not_change_ordinary_provider_selection() {
    let store = Store::new();
    store.install(true, false);
    store.put(
        state::selection_key(),
        "selection",
        json!({"provider_ids":["ubiquity"],"updated_at_ms":store.now.get()}),
    );
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("deepseek-v4.1-flash"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert_eq!(
        store.projection().policy.models[&"deepseek-v4.1-flash".into()],
        vec![PaidProvider::Surplus]
    );
    assert!(!store.projection().policy.codex_enabled);
    let selection = store.get(&state::selection_key()).unwrap();
    assert_eq!(selection.value["provider_ids"], json!(["ubiquity"]));
}

#[test]
fn only_actual_source_deadlines_constrain_a_projection() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    let source_key = state::source_key(&["uos_ai", "fixture_owned_paid_credential"]);
    let until = store.now.get() + 10000;
    store.rows.borrow_mut().insert(
        source_key.0.clone(),
        StoredRecord::json(
            "credential-rev",
            json!({"fixture_owner":"fixture-owner"}),
            Some(until),
        ),
    );
    let mut config: PaidControlConfig =
        serde_json::from_value(store.get(&keys::paid_control_config()).unwrap().value).unwrap();
    config.source_checks = vec![PaidSourceCheck {
        key: source_key.0,
        expected_revision: Some("credential-rev".into()),
    }];
    store.put(
        keys::paid_control_config(),
        "config-with-source-deadline",
        json!(config),
    );
    host.queue(surplus("paid-only"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert_eq!(
        store.projection().provenance.source_valid_until_ms,
        Some(until)
    );
    let observation: PaidProviderObservation = decode_source_control_record(
        &store
            .get(&keys::paid_control_observation(PaidProvider::Surplus))
            .unwrap(),
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(observation.source_valid_until_ms, Some(until));
    store.now.set(until + 1);
    assert!(run(runtime.publish_paid_routing(&store, &host)).is_err());
}

#[test]
fn malformed_absolute_source_expiry_fails_closed() {
    let store = Store::new();
    store.install(false, false);
    let host = Host::new(&store, false, false);
    let runtime = CatalogRuntime::new();
    store
        .rows
        .borrow_mut()
        .get_mut(&keys::paid_control_owner().0)
        .unwrap()
        .expires_at_ms = Some(i64::MAX);
    assert!(run(runtime.publish_paid_routing(&store, &host)).is_err());
    assert!(store.get(&keys::paid_routing()).is_none());
}

#[test]
fn custody_metadata_contains_only_the_observed_routing_fields() {
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    let mut response = surplus("paid-only");
    response["data"][0]["description"] = json!("unrelated provider prose");
    response["data"][0]["created"] = json!(12345);
    host.queue(response);
    run(runtime.publish_paid_observation(&store, &host, PaidProvider::Surplus, true)).unwrap();
    let observation = store
        .get(&keys::paid_control_observation(PaidProvider::Surplus))
        .unwrap()
        .value;
    assert!(observation["models"][0].get("description").is_none());
    assert_eq!(observation["models"][0]["created"], 12345);
    assert_eq!(observation["models"][0]["input_price_per_token"], 0.001);
    let cached = runtime
        .cached_provider(&host.publication.borrow(), CatalogProvider::Surplus)
        .unwrap();
    assert_eq!(
        cached.models[0].deserialize::<Value>().unwrap()["description"],
        "unrelated provider prose"
    );
}

struct Tokens(Cell<u64>);
impl gateway_authority::TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        let n = self.0.get() + 1;
        self.0.set(n);
        Ok(format!("authority-{n}"))
    }
}
struct Clock(i64);
impl gateway_authority::AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(self.0)
    }
}
fn paid_request(
    store: &Store,
    provider: PaidProvider,
    model: &str,
) -> gateway_authority::paid::PaidRequest {
    use gateway_core::identity::{ApiKeyId, PaidAttemptId, RequestId};
    gateway_authority::paid::PaidRequest {
        key_id: ApiKeyId("fixture-key".into()),
        request_id: RequestId("fixture-request".into()),
        attempt_id: PaidAttemptId("fixture-attempt".into()),
        provider,
        model: model.into(),
        route: "responses".into(),
        path: "/v1/responses".into(),
        stream: false,
        reasoning: None,
        created_at_ms: store.now.get(),
    }
}
fn set_source_field(body: &mut SourceJson, key: &str, value: SourceJson) {
    let mut fields = gateway_core::source_serialization::entries(body).unwrap();
    let key = gateway_core::js_string::JsString16::from_utf8(key);
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == &key) {
        *old = value;
    } else {
        fields.push((key, value));
    }
    *body = gateway_core::source_serialization::object_keys(fields).unwrap();
}
fn context(model: &str) -> PaidRequestContext {
    PaidRequestContext {
        original_model: model.into(),
        body: SourceJson::from_serializable(
            &json!({"model":model,"input":"controlled fixture","stream":false,"tools":[]}),
        )
        .unwrap(),
        surface: gateway_providers::ClientSurface::Responses,
        synthetic_hop: None,
    }
}

#[test]
fn actual_publisher_receipt_and_reservation_share_one_authority_and_reject_stale_existing() {
    use gateway_authority::{
        Authority,
        paid::{PaidAdmission, PaidAuthorization},
        quota::ApiKeyPolicy,
    };
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("paid-only"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    let request = paid_request(&store, PaidProvider::Surplus, "paid-only");
    store.put(
        keys::api_policy(&request.key_id.0),
        "key-policy",
        json!(ApiKeyPolicy {
            v: 3,
            key_id: request.key_id.clone(),
            expires_at_ms: -1,
            usage_limit_requests: -1,
            window_ms: 86400000,
            usage_reset_at_ms: store.now.get() + 86400000,
            paid_fallback_enabled: true,
            paid_fallback_limit_microcredits: 1000000,
            paid_fallback_quota_per_credit: 1000,
            paid_fallback_pricing_checked_at_ms: store.now.get(),
            paid_fallback_models: vec!["paid-only".into()],
            paid_fallback_max_exposure_microcredits: BTreeMap::from([("paid-only".into(), 1000)])
        }),
    );
    let authority =
        Authority::with_clock(store.clone(), Tokens(Cell::new(0)), Clock(store.now.get()));
    let receipt = run(original_request_fixture::authorize(
        &authority,
        &request,
        &context("paid-only"),
        store.now.get(),
    ))
    .unwrap();
    assert!(matches!(
        run(authority.reserve_paid(
            &request,
            &PaidAuthorization::DirectPaidModel,
            &receipt,
            store.now.get()
        ))
        .unwrap(),
        PaidAdmission::Reserved(_)
    ));
    assert!(matches!(
        run(authority.reserve_paid(
            &request,
            &PaidAuthorization::DirectPaidModel,
            &receipt,
            store.now.get()
        ))
        .unwrap(),
        PaidAdmission::Existing(_)
    ));
    store.put(
        state::selection_key(),
        "changed-after-reservation",
        json!({"provider_ids":["codex"],"updated_at_ms":store.now.get()}),
    );
    assert!(
        run(authority.reserve_paid(
            &request,
            &PaidAuthorization::DirectPaidModel,
            &receipt,
            store.now.get()
        ))
        .is_err()
    );
    assert!(
        store
            .get(&keys::paid_attempt(
                &request.key_id.0,
                &request.attempt_id.0
            ))
            .is_some()
    );
}

#[test]
fn coarse_union_never_authorizes_the_wrong_client_endpoint() {
    use gateway_authority::Authority;
    let store = Store::new();
    store.install(false, true);
    let host = Host::new(&store, false, true);
    let runtime = CatalogRuntime::new();
    host.queue(json!({"data":[{"id":"paid-only","supported_endpoint_types":["openai"]}]}));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert!(
        store
            .projection()
            .policy
            .models
            .contains_key(&"paid-only".into())
    );
    let request = paid_request(&store, PaidProvider::Metered, "paid-only");
    let authority =
        Authority::with_clock(store.clone(), Tokens(Cell::new(0)), Clock(store.now.get()));
    assert!(
        run(authority.authorize_paid_route(&request, &context("paid-only"), store.now.get()))
            .is_err()
    );
}

#[test]
fn ordinary_tool_request_cannot_use_a_coarse_non_tool_surplus_permission() {
    use gateway_authority::Authority;
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    let mut response = surplus("paid-only");
    response["data"][0]["supported_features"] = json!([]);
    host.queue(response);
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    assert!(
        store
            .projection()
            .policy
            .models
            .contains_key(&"paid-only".into())
    );
    let request = paid_request(&store, PaidProvider::Surplus, "paid-only");
    let authority =
        Authority::with_clock(store.clone(), Tokens(Cell::new(0)), Clock(store.now.get()));
    let mut context = context("paid-only");
    set_source_field(
        &mut context.body,
        "tools",
        source_catalog::json(&json!([{"type":"function","name":"actual-tool"}])),
    );
    assert!(run(authority.authorize_paid_route(&request, &context, store.now.get())).is_err());
}

#[test]
fn synthetic_override_requires_the_server_owned_hop_not_a_body_shortcut() {
    use gateway_authority::Authority;
    let store = Store::new();
    store.install(true, false);
    store.put(
        state::selection_key(),
        "selection",
        json!({"provider_ids":["ubiquity"],"updated_at_ms":store.now.get()}),
    );
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    host.queue(surplus("deepseek-v4.1-flash"));
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    let request = paid_request(&store, PaidProvider::Surplus, "deepseek-v4.1-flash");
    let authority =
        Authority::with_clock(store.clone(), Tokens(Cell::new(0)), Clock(store.now.get()));
    let mut ordinary = context("deepseek-v4.1-flash");
    set_source_field(
        &mut ordinary.body,
        "synthetic_hop",
        source_catalog::json("surplus"),
    );
    assert!(run(authority.authorize_paid_route(&request, &ordinary, store.now.get())).is_err());
    let mut synthetic = context("ubiquity/deepseek-flash");
    synthetic.synthetic_hop = Some(PaidSyntheticHop::Surplus);
    assert!(run(authority.authorize_paid_route(&request, &synthetic, store.now.get())).is_ok());
}

#[cfg(not(target_arch = "wasm32"))]
mod native_configuration {
    use super::*;
    use gateway_auth::{
        crypto::{Secret, base64url},
        native::NATIVE_RPC_PATH,
        native_auth::{
            AuthenticatedNativeOwner, NativeAuthHeaders, NativeAuthenticator, NativeCapability,
            NativeNonceAuthority, NativeTransportIdentity,
        },
    };
    use gateway_native::control_publication::{
        ConfiguredPaidInputs, PreparedConfigurationPublication, bootstrap_fixture_owner,
        fixture_owner_statement,
    };
    use std::collections::BTreeSet;

    struct Nonces<'a>(&'a Store);
    impl NativeNonceAuthority for Nonces<'_> {
        async fn consume_nonce(
            &self,
            key_id: &str,
            nonce: &str,
            valid_through_ms: i64,
            now_ms: i64,
        ) -> Result<(), GatewayError> {
            let key = state::source_key(&["uos_ai", "fixture_native_nonce", key_id, nonce]);
            if self.0.get(&key).is_some() {
                return Err(GatewayError::new(
                    401,
                    "Fixture native nonce replay",
                    Some("native_replay"),
                ));
            }
            let result = self
                .0
                .commit(AtomicTransition {
                    checks: vec![gateway_core::state::RevisionCheck {
                        key: key.clone(),
                        expected_revision: None,
                    }],
                    mutations: vec![RecordMutation::Put {
                        key,
                        record: StoredRecord::json(
                            format!("nonce-{nonce}"),
                            json!({"observed_at_ms":now_ms}),
                            Some(valid_through_ms + 1),
                        ),
                    }],
                })
                .await?;
            if result != CommitOutcome::Committed {
                return Err(GatewayError::new(
                    401,
                    "Fixture native nonce race",
                    Some("native_replay"),
                ));
            }
            Ok(())
        }
    }
    async fn proof(
        store: &Store,
        identity: &NativeTransportIdentity,
        body: &[u8],
        sequence: u8,
    ) -> AuthenticatedNativeOwner {
        let now = store.now.get();
        let nonce = base64url(&[sequence; 32]);
        let mac = identity.sign(NATIVE_RPC_PATH, now, &nonce, body).unwrap();
        let stamp = now.to_string();
        NativeAuthenticator::new(identity, &Nonces(store))
            .authenticate(
                NATIVE_RPC_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: identity.key_id(),
                    time_ms: &stamp,
                    nonce: &nonce,
                    mac: &mac,
                },
                body,
                now,
            )
            .await
            .unwrap()
    }
    #[test]
    fn actual_authenticated_owner_configuration_publisher_drives_the_catalog_bridge() {
        run(async {
            let store = Store::new();
            let template = Store::new();
            template.install(false, false);
            for key in [
                catalog_store::runtime_config_key(),
                catalog_store::codex_snapshot_key(),
                catalog_store::auth_generation_key(),
            ] {
                let row = template.get(&key).unwrap();
                store.put(key, &row.revision, row.value);
            }
            let identity = NativeTransportIdentity::new(
                "fixture-m11-key".into(),
                "fixture-m11-owner".into(),
                "fixture-m11-epoch".into(),
                [19; 32],
                BTreeSet::from([NativeCapability::ConfigurationPublish]),
            )
            .unwrap();
            let statement = fixture_owner_statement(&identity).unwrap();
            let verified = proof(&store, &identity, &statement, 1).await;
            bootstrap_fixture_owner(
                &store,
                &identity,
                &verified,
                store.now.get(),
                "actual-owner",
            )
            .await
            .unwrap();
            let inputs = ConfiguredPaidInputs::new(
                Some(Secret::new("fixture-actual-surplus-secret".into())),
                None,
                None,
                json!({"candidate":"controlled-fixture"}),
            )
            .unwrap();
            let prepared = PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &inputs,
                "configuration-1",
                store.now.get(),
            )
            .await
            .unwrap();
            let verified = proof(&store, &identity, prepared.statement(), 2).await;
            let config = prepared
                .publish(&store, &verified, store.now.get(), "actual-config")
                .await
                .unwrap();
            let host = Host::new(&store, false, false);
            host.publication.borrow_mut().providers.insert(
                CatalogProvider::Surplus,
                ProviderBinding {
                    identity: inputs.binding(PaidProvider::Surplus).unwrap(),
                },
            );
            assert_eq!(
                config.surplus_binding,
                inputs.binding(PaidProvider::Surplus)
            );
            let runtime = CatalogRuntime::new();
            host.queue(surplus("actual-owned-model"));
            runtime.publish_paid_routing(&store, &host).await.unwrap();
            assert_eq!(
                store.projection().policy.models[&"actual-owned-model".into()],
                vec![PaidProvider::Surplus]
            );
            let retained = serde_json::to_string(&*store.rows.borrow()).unwrap();
            assert!(!retained.contains("fixture-actual-surplus-secret"));
            let next = ConfiguredPaidInputs::new(
                Some(Secret::new("fixture-rotated-surplus-secret".into())),
                None,
                None,
                json!({"candidate":"controlled-fixture"}),
            )
            .unwrap();
            let prepared = PreparedConfigurationPublication::capture(
                &store,
                &identity,
                &next,
                "configuration-2",
                store.now.get(),
            )
            .await
            .unwrap();
            let verified = proof(&store, &identity, prepared.statement(), 3).await;
            prepared
                .publish(&store, &verified, store.now.get(), "actual-config-2")
                .await
                .unwrap();
            assert!(
                store
                    .get(&keys::paid_control_observation(PaidProvider::Surplus))
                    .is_none()
            );
            assert!(runtime.publish_paid_routing(&store, &host).await.is_err());
            host.publication.borrow_mut().providers.insert(
                CatalogProvider::Surplus,
                ProviderBinding {
                    identity: next.binding(PaidProvider::Surplus).unwrap(),
                },
            );
            host.queue(surplus("new-owned-model"));
            // Surplus discovery is public and shares its TTL cache across key changes.
            // A configuration rotation changes spend custody; an explicit metadata refresh
            // is the source operation that replaces a still-fresh public model snapshot.
            runtime
                .publish_paid_observation(&store, &host, PaidProvider::Surplus, true)
                .await
                .unwrap();
            runtime.publish_paid_routing(&store, &host).await.unwrap();
            assert!(
                !store
                    .projection()
                    .policy
                    .models
                    .contains_key(&"actual-owned-model".into())
            );
            assert!(
                store
                    .projection()
                    .policy
                    .models
                    .contains_key(&"new-owned-model".into())
            );
        });
    }
}

#[test]
fn source_paid_observation_and_projection_preserve_opaque_models_without_new_authority() {
    use gateway_core::{js_string::JsString16, model::ModelId, value::ValueEncoding};
    let store = Store::new();
    store.install(true, false);
    let host = Host::new(&store, true, false);
    let runtime = CatalogRuntime::new();
    let model = ModelId::from_source(JsString16::from_units(vec![0xd800]));
    host.queue_source(SourceJson::parse(r#"{"data":[{"id":"\ud800","supported_parameters":["tools","tool_choice"],"supported_features":["tools"],"pricing":{"prompt":"0.001","completion":"0.002"}}]}"#).unwrap());
    run(runtime.publish_paid_routing(&store, &host)).unwrap();
    let observation = store
        .get(&keys::paid_control_observation(PaidProvider::Surplus))
        .unwrap();
    assert_eq!(observation.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(
        store.projection().policy.models.get(&model),
        Some(&vec![PaidProvider::Surplus])
    );
    assert!(
        !store
            .projection()
            .policy
            .models
            .contains_key(&ModelId::from_scalar(r"\ud800"))
    );
    let row = store.get(&keys::paid_routing()).unwrap();
    assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
    println!(
        "M42_PAID_PROJECTION_WRITER_FIXTURE={}",
        serde_json::to_string(&(keys::paid_routing().0, row)).unwrap()
    );
}
