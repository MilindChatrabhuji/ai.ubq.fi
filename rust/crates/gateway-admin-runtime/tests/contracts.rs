use gateway_admin::{AdminHost, AdminInput, AdminOperation};
use gateway_admin_runtime::{AdminRuntime, RuntimeConfig, capabilities::*};
use gateway_auth::{upstream::*, webauthn::*, *};
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, query::*,
    source_control::encode_source_control_record, source_json::SourceJson, state::*,
};
use gateway_schema::{
    catalog_store::*, runtime_config::build_runtime_config, snapshot::ModelSnapshot,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    task::{Context as TaskContext, Poll, Waker},
};

#[path = "contract_cases/manual_reset.rs"]
mod manual_reset;

// Assertions inspect the actual JSON wire of either explicit response arm.
trait WireBody {
    fn wire_json(&self) -> Value;
}
impl WireBody for AuthResponseBody {
    fn wire_json(&self) -> Value {
        serde_json::from_slice(&self.to_bytes().unwrap()).unwrap()
    }
}

fn run<F: Future>(future: F) -> F::Output {
    let mut cx = TaskContext::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::yield_now();
    }
}
#[derive(Default)]
struct Store {
    rows: RefCell<BTreeMap<String, StoredRecord>>,
    reads: Cell<usize>,
    conflicts: Cell<u32>,
}
impl Store {
    fn put(&self, parts: Value, value: Value) {
        let key = gateway_auth::store::key(parts);
        self.rows
            .borrow_mut()
            .insert(key.0, StoredRecord::json("fixture", value, None));
    }
    fn get(&self, parts: Value) -> Option<Value> {
        self.rows
            .borrow()
            .get(&gateway_auth::store::key(parts).0)
            .map(|r| r.value.clone())
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.reads.set(self.reads.get() + 1);
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if self.conflicts.get() > 0 {
            self.conflicts.set(self.conflicts.get() - 1);
            return Ok(CommitOutcome::Conflict);
        }
        let mut rows = self.rows.borrow_mut();
        for check in tx.checks {
            if rows.get(&check.key.0).map(|r| &r.revision) != check.expected_revision.as_ref() {
                return Ok(CommitOutcome::Conflict);
            }
        }
        for write in tx.mutations {
            match write {
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
                })
            }
        }
        entries
            .sort_by_key(|e| gateway_core::tuple_key::TupleKey::from_record_key(&e.key).unwrap());
        if request.reverse {
            entries.reverse()
        }
        let more = entries.len() > request.limit as usize;
        entries.truncate(request.limit as usize);
        let next_cursor = if more {
            Some(validated.cursor_after(&entries.last().unwrap().key)?)
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}
struct Host {
    now: Cell<i64>,
    serial: Cell<u64>,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            now: Cell::new(1_000_000),
            serial: Cell::new(0),
        }
    }
}
impl WebAuthnCrypto for Host {
    async fn validate_key(&self, _: &CosePublicKey) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "No cryptographic fixture",
            "fixture_missing",
        ))
    }
    async fn verify_signature(&self, _: SignatureInput) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "No cryptographic fixture",
            "fixture_missing",
        ))
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.serial.get() + 1;
        self.serial.set(n);
        Ok((0..len).map(|i| (n + i as u64) as u8).collect())
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "Network denied",
            "fixture_network_denied",
        ))
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(GatewayError::unavailable(
            "No kernel fixture",
            "fixture_missing",
        ))
    }
}
struct Capabilities;
impl RuntimeCapabilities for Capabilities {
    fn compare_admin_labels(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        // These legacy cases contain only empty/singleton lists. Unequal source
        // ordering requires the exact locale fixtures in source_controls.rs.
        if left == right {
            return Ok(std::cmp::Ordering::Equal);
        }
        Err(GatewayError::unavailable(
            "Uncovered legacy fixture comparison",
            "fixture_collation_missing",
        ))
    }
    async fn metered_diagnostics(&self) -> Result<Value, GatewayError> {
        Ok(json!({"state":"unavailable"}))
    }
    async fn provider_picker(&self, _: Context) -> Result<Value, GatewayError> {
        Ok(json!({"providers":[{"id":"codex"}],"tiers":[]}))
    }
    async fn error_diagnostics(&self, _: Context) -> Result<ErrorDiagnostics, GatewayError> {
        Ok(ErrorDiagnostics {
            retention: json!({"state":"unavailable"}),
            log_files: json!({"scope":"host_text_logs","total_bytes":null}),
        })
    }
    async fn pricing(&self, _: &[ModelId]) -> Result<PricingSnapshot, GatewayError> {
        Ok(PricingSnapshot {
            eligible_model_ids: vec!["gpt-source".into()],
            quota_per_credit: 1000,
            model_quota_coefficients: BTreeMap::from([("gpt-source".into(), 1.5)]),
            checked_at_ms: 900000,
        })
    }
}
fn input(body: Value) -> AdminInput {
    AdminInput {
        parameter: None,
        query: BTreeMap::new(),
        body: SourceJson::from_serializable(&body).unwrap(),
        actor: AuthPrincipal {
            token: None,
            method: AuthMethod::AdminAllowlist,
            is_admin: true,
            is_super_admin: false,
        },
        request_id: "admin-fixture".into(),
        now_ms: 1_000_000,
    }
}
fn snapshot(context: bool) -> ModelSnapshot {
    ModelSnapshot {
        models: vec![SourceJson::from_serializable(&if context {
            json!({"slug":"gpt-source","context_window":10000,"default_reasoning_level":null,"supported_reasoning_levels":[null,"future-tier"]})
        } else {
            json!({"slug":"gpt-source","default_reasoning_level":null,"supported_reasoning_levels":[null,"future-tier"]})
        }).unwrap()],
        source: "chatgpt_codex".into(),
        updated_at_ms: 900000,
        client_version: None,
    }
}
fn seed_catalog(store: &Store, context: bool) {
    let snapshot = snapshot(context);
    store.rows.borrow_mut().insert(
        codex_snapshot_key().0,
        StoredRecord::json("catalog", serde_json::to_value(&snapshot).unwrap(), None),
    );
    store.rows.borrow_mut().insert(
        runtime_config_key().0,
        encode_source_control_record(
            "runtime",
            &build_runtime_config(
                &snapshot,
                Some(&ModelId::from_scalar("gpt-source")),
                Some(&JsString16::from_utf8("medium")),
                900000,
            )
            .unwrap(),
            None,
        )
        .unwrap(),
    );
}
fn runtime<'a>(
    store: &'a Store,
    host: &'a Host,
    config: &'a RuntimeConfig,
) -> AdminRuntime<'a, Store, Host, Capabilities> {
    AdminRuntime {
        store,
        host,
        capabilities: &Capabilities,
        config,
    }
}

#[test]
fn authorization_precedes_state_reads_and_has_no_super_admin_tier() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    let mut denied = input(json!({"scenario":"codex_429"}));
    denied.actor.is_admin = false;
    assert_eq!(
        run(service.execute(AdminOperation::DebugSet, denied))
            .unwrap_err()
            .status,
        401
    );
    assert_eq!(store.reads.get(), 0);
    assert_eq!(
        run(service.execute(
            AdminOperation::DebugSet,
            input(json!({"scenario":"codex_429"}))
        ))
        .unwrap()
        .status,
        200
    );
}
#[test]
fn debug_expiry_and_unknown_scenarios_follow_source() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    let before = run(service.execute(
        AdminOperation::DebugSet,
        input(json!({"scenario":"codex_503","duration_ms":10})),
    ))
    .unwrap();
    assert_eq!(before.body.wire_json()["routing"]["expires_at_ms"], 1000010);
    host.now.set(1000020);
    let mut request = input(Value::Null);
    request.now_ms = 1000020;
    assert_eq!(
        run(service.execute(AdminOperation::DebugGet, request))
            .unwrap()
            .body
            .wire_json()["routing"]["scenario"],
        "normal"
    );
    assert_eq!(
        run(service.execute(
            AdminOperation::DebugSet,
            input(json!({"scenario":"invented"}))
        ))
        .unwrap_err()
        .status,
        400
    );
}
#[test]
fn provider_selection_is_ordered_and_codex_absorbs_subscriptions() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    let id = format!("codex:{}", "a".repeat(64));
    let response = run(service.execute(
        AdminOperation::ProviderSelectionSet,
        input(json!({"provider_ids":["openlux",id,"codex","codex","surplus"]})),
    ))
    .unwrap();
    assert_eq!(
        response.body.wire_json()["provider_ids"],
        json!(["codex", "surplus", "openlux"])
    );
    assert_eq!(
        run(service.execute(
            AdminOperation::ProviderSelectionSet,
            input(json!({"provider_ids":["new-provider"]}))
        ))
        .unwrap_err()
        .status,
        400
    );
    assert_eq!(
        store
            .get(json!(["uos_ai", "provider_selection", "v1"]))
            .unwrap()["provider_ids"],
        json!(["codex", "surplus", "openlux"])
    );
}
#[test]
fn claude_empty_access_is_authoritative_and_corruption_never_seeds() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig {
        claude_allowed_key_ids: vec!["owner-key".into()],
    };
    let service = runtime(&store, &host, &config);
    run(service.execute(
        AdminOperation::ClaudeAccessSet,
        input(json!({"allowed_key_ids":[]})),
    ))
    .unwrap();
    assert_eq!(
        run(service.execute(AdminOperation::ClaudeAccessGet, input(Value::Null)))
            .unwrap()
            .body
            .wire_json()["data"]["allowed_key_ids"],
        json!([])
    );
    store.put(
        json!(["uos_ai", "claude_code_access", "v1"]),
        json!({"v":2}),
    );
    assert_eq!(
        run(service.execute(AdminOperation::ClaudeAccessGet, input(Value::Null)))
            .unwrap_err()
            .status,
        503
    );
}
#[test]
fn defaults_keep_advertised_custom_reasoning_and_atomic_late_validation() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    seed_catalog(&store, true);
    let service = runtime(&store, &host, &config);
    let response=run(service.execute(AdminOperation::DefaultsSet,input(json!({"model":"gpt-source","reasoning_effort":"future-tier","kernel_policy_limit_requests":25})))).unwrap();
    assert_eq!(
        response.body.wire_json()["defaults"]["reasoning_effort"],
        "future-tier"
    );
    assert_eq!(
        store
            .get(json!(["uos_ai", "authority", "v1", "kernel_defaults"]))
            .unwrap()["usage_limit_requests"],
        25
    );
    let prior = store.rows.borrow().clone();
    assert_eq!(
        run(service.execute(
            AdminOperation::DefaultsSet,
            input(json!({"model":"gpt-source","kernel_policy_window_ms":0}))
        ))
        .unwrap_err()
        .status,
        400
    );
    assert_eq!(*store.rows.borrow(), prior);
    assert_eq!(
        run(service.execute(
            AdminOperation::DefaultsSet,
            input(json!({"model":"gpt-source"}))
        ))
        .unwrap()
        .body
        .wire_json()["defaults"]["reasoning_effort"],
        "none"
    );
}
fn kernel_window(store: &Store, expiry: i64, intent: Value) {
    store.put(json!(["uos_ai","kernel_quota","v2","org_window","owner"]),json!({"v":2,"owner":"owner","repo":null,"usage_requests":0,"reserved_requests":1,"created_at_ms":800000,"usage_reset_at_ms":2000000,"applied_window_ms":604800000,"updated_at_ms":900000,"reservations":{"request":expiry}}));
    store.put(json!(["uos_ai","kernel_quota","v2","org_reservation","owner",800000,"request"]),json!({"v":2,"owner":"owner","repo":null,"request_id":"request","route":"/v1/responses","window_created_at_ms":800000,"window_reset_at_ms":2000000,"reserved_at_ms":850000,"lease_expires_at_ms":expiry,"terminal_intent":intent,"state":null,"terminal_at_ms":null,"release_reason":null}));
}
#[test]
fn default_window_cutover_blocks_active_reservations_and_releases_its_claim() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    kernel_window(&store, 1500000, Value::Null);
    let service = runtime(&store, &host, &config);
    assert_eq!(
        run(service.execute(
            AdminOperation::DefaultsSet,
            input(json!({"kernel_policy_window_ms":200000}))
        ))
        .unwrap_err()
        .status,
        409
    );
    assert!(
        store
            .get(json!([
                "uos_ai",
                "kernel_quota",
                "v2",
                "default_window_cutover"
            ]))
            .is_none()
    );
    assert!(
        store
            .get(json!(["default", "kernel_policy_window_ms"]))
            .is_none()
    );
}
#[test]
fn expired_kernel_terminal_intent_is_committed_before_default_cutover() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    kernel_window(&store, 900000, json!("committed"));
    let service = runtime(&store, &host, &config);
    run(service.execute(
        AdminOperation::DefaultsSet,
        input(json!({"kernel_policy_window_ms":200000})),
    ))
    .unwrap();
    let window = store
        .get(json!([
            "uos_ai",
            "kernel_quota",
            "v2",
            "org_window",
            "owner"
        ]))
        .unwrap();
    assert_eq!(window["usage_requests"], 1);
    assert_eq!(window["reserved_requests"], 0);
}
#[test]
fn paid_policy_uses_full_context_exposure_and_never_compact_fallback() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    seed_catalog(&store, true);
    let fields = run(service.paid_key_policy(
        &input(json!({"paid_fallback_enabled":true,"paid_fallback_limit_credits":2.25})).body,
    ))
    .unwrap();
    assert_eq!(fields.limit_microcredits, 2250000);
    assert_eq!(
        fields.max_exposure_microcredits[&ModelId::from_scalar("gpt-source")],
        15000000
    );
    seed_catalog(&store, false);
    assert_eq!(
        run(service.paid_key_policy(
            &input(json!({"paid_fallback_enabled":true,"paid_fallback_limit_credits":-1})).body
        ))
        .unwrap_err()
        .status,
        503
    );
}
#[test]
fn deletion_refuses_pending_markers_and_returns_actual_guard_fences() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    store.put(
        json!(["ubq_ai", "api_keys", "id", "key"]),
        json!({"id":"key","name":"deletion fixture","prefix":"u_0000000000","hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","created_at_ms":800000,"expires_at_ms":-1,"revoked_at_ms":900000,"usage_limit_requests":-1,"usage_requests":0,"usage_reset_at_ms":2000000,"window_ms":604800000,"usage_quota_version":3,"paid_fallback_enabled":false,"paid_fallback_limit_microcredits":0,"paid_fallback_spent_microcredits":0,"paid_fallback_reserved_microcredits":0,"paid_fallback_reservation_request_id":null,"paid_fallback_model_ids":[],"paid_fallback_quota_per_credit":0,"paid_fallback_max_exposure_microcredits":{},"paid_fallback_pricing_checked_at_ms":null}),
    );
    store.put(
        json!(["uos_ai", "paid_fallback", "v3", "pending", "key", "attempt"]),
        json!({"created_at_ms":900000}),
    );
    assert_eq!(
        run(service.prepare_key_deletion("key")).unwrap_err().status,
        409
    );
    assert!(
        store
            .get(json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "deletion_guard",
                "key"
            ]))
            .is_some()
    );
    store.rows.borrow_mut().remove(
        &gateway_auth::store::key(json!([
            "uos_ai",
            "paid_fallback",
            "v3",
            "pending",
            "key",
            "attempt"
        ]))
        .0,
    );
    let fences = run(service.prepare_key_deletion("key")).unwrap();
    let guard = gateway_authority::keys::paid_deletion("key");
    assert!(
        fences
            .iter()
            .any(|f| f.key == guard && f.expected_revision.is_some())
    );
    let again = run(service.prepare_key_deletion("key")).unwrap();
    assert_eq!(again[0], fences[0]);
}
#[test]
fn migration_and_replay_preserve_raw_source_modes() {
    let mut request = input(json!("{\"v\":1}\n"));
    request.query.insert("profile".into(), vec!["local".into()]);
    let plan = gateway_admin_runtime::parse::migration(&request).unwrap();
    assert!(plan.dry_run && plan.include_legacy);
    request.query.insert("write".into(), vec!["true".into()]);
    request.query.insert("dry_run".into(), vec!["true".into()]);
    assert_eq!(
        gateway_admin_runtime::parse::migration(&request)
            .unwrap_err()
            .status,
        400
    );
    let mut request = input(Value::Null);
    request
        .query
        .insert("request_id".into(), vec!["request-1".into()]);
    request
        .query
        .insert("before_ms".into(), vec!["garbage".into()]);
    assert_eq!(
        gateway_admin_runtime::parse::capture(&request, false).unwrap(),
        CaptureRequest::Request {
            request_id: "request-1".into()
        }
    );
    request.query.insert(
        "incident_id".into(),
        vec!["provider-12345678-1234-4123-8123-123456789abc".into()],
    );
    assert_eq!(
        gateway_admin_runtime::parse::capture(&request, false)
            .unwrap_err()
            .status,
        400
    );
}
#[test]
fn missing_native_and_provider_bindings_cannot_return_success() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &UnboundCapabilities,
        config: &config,
    };
    for op in [
        AdminOperation::Providers,
        AdminOperation::ClaudeAuthGet,
        AdminOperation::ModelsRefresh,
        AdminOperation::SupervisorSessions,
    ] {
        assert_eq!(
            run(service.execute(op, input(Value::Null)))
                .unwrap_err()
                .status,
            503
        )
    }
    let mut request = input(Value::Null);
    request.query.insert("source".into(), vec!["source".into()]);
    request.query.insert("id".into(), vec!["thread".into()]);
    assert_eq!(
        run(service.execute(AdminOperation::SupervisorOutput, request))
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("admin_capability_unavailable")
    );
}
#[test]
fn errors_limit_does_not_truncate_five_xx_buckets() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    for i in 0..205 {
        store.put(json!(["uos_ai","admin_error_log","v1",900000+i,format!("req-{i}")]),json!({"version":1,"request_id":format!("req-{i}"),"route":"/v1/responses","status":502,"provider":"codex","model":null,"reasoning":null,"stream":true,"terminal_type":"error","failure_kind":"upstream","delivery_outcome":"unobserved","created_at_ms":900000+i,"latency_ms":100,"git_sha":null,"deno_revision":null}));
    }
    let mut request = input(Value::Null);
    request.query.insert("limit".into(), vec!["1".into()]);
    let response = run(service.execute(AdminOperation::Errors, request)).unwrap();
    assert_eq!(
        response.body.wire_json()["data"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        response.body.wire_json()["five_xx_buckets"][0]["count"],
        205
    );
}

#[test]
fn claude_roster_rotation_preserves_identity_and_fences_prior_generations() {
    use gateway_admin_runtime::claude::*;
    let store = Store::default();
    let host = Host::default();
    let seed = Bootstrap::default();
    let credential = parse_credential(
        &json!({"secret":"sk-ant-api-test-secret","kind":"api_key","updated_at_ms":900000}),
        "kv",
    )
    .unwrap();
    let first = run(update_account(
        &store,
        &host,
        &seed,
        &AccountUpdate {
            account_id: None,
            create_new: false,
            credential: Some(credential.clone()),
            workspace: None,
            activate: false,
            expected: None,
        },
    ))
    .unwrap();
    assert!(
        run(current_binding(&store, &first, host.now_ms()))
            .unwrap()
            .is_some()
    );
    let mut renamed = credential.clone();
    renamed.label = Some("renamed".into());
    let same = run(update_account(
        &store,
        &host,
        &seed,
        &AccountUpdate {
            account_id: Some(first.account_id.clone()),
            create_new: false,
            credential: Some(renamed),
            workspace: None,
            activate: false,
            expected: Some(first.clone()),
        },
    ))
    .unwrap();
    assert_eq!(first.account_cohort_id, same.account_cohort_id);
    assert_eq!(first.evidence_generation, same.evidence_generation);
    let mut rotated = credential;
    rotated.secret = std::sync::Arc::new(ClaudeSourceSecret::from_source(
        "sk-ant-api-rotated-secret".into(),
    ));
    let next = run(update_account(
        &store,
        &host,
        &seed,
        &AccountUpdate {
            account_id: Some(first.account_id.clone()),
            create_new: false,
            credential: Some(rotated),
            workspace: None,
            activate: false,
            expected: Some(first.clone()),
        },
    ))
    .unwrap();
    assert_eq!(first.account_id, next.account_id);
    assert_ne!(first.account_cohort_id, next.account_cohort_id);
    assert_ne!(first.evidence_generation, next.evidence_generation);
    assert!(
        run(current_binding(&store, &first, host.now_ms()))
            .unwrap()
            .is_none()
    );
    assert!(
        run(current_binding(&store, &next, host.now_ms()))
            .unwrap()
            .is_some()
    );
    let debug = format!("{next:?}");
    assert!(!debug.contains("sk-ant-api-rotated-secret"));
}

#[test]
fn claude_tombstone_refuses_legacy_or_environment_resurrection() {
    use gateway_admin_runtime::claude::*;
    let store = Store::default();
    let host = Host::default();
    let credential = parse_credential(
        &json!({"secret":"sk-ant-api-legacy-secret","kind":"api_key","updated_at_ms":900000}),
        "kv",
    )
    .unwrap();
    store.rows.borrow_mut().insert(
        gateway_auth::store::key(json!(["ubq_ai", "claude_code_auth"])).0,
        gateway_admin_runtime::claude::encode_credential_record("fixture", &credential, None)
            .unwrap(),
    );
    let seed = Bootstrap {
        credential: Some(credential),
        workspace: None,
    };
    let read = run(load_roster(&store, &host, &seed)).unwrap();
    let account = active_binding(&read.roster).unwrap();
    assert!(read.revision.is_some());
    assert!(
        run(remove_account(
            &store,
            &host,
            &seed,
            Some(&account.account_id)
        ))
        .unwrap()
    );
    let after = run(load_roster(&store, &host, &seed)).unwrap();
    assert!(after.roster.accounts.is_empty());
    assert!(after.roster.active_account_id.is_none());
    assert!(store.get(json!(["ubq_ai", "claude_code_auth"])).is_some());
    store.put(
        json!(["uos_ai", "claude_code_accounts", "v1"]),
        json!({"v":99}),
    );
    assert_eq!(
        run(load_roster(&store, &host, &seed)).unwrap_err().status,
        503
    );
}

#[test]
fn source_claude_submission_limits_and_workspace_parser_are_preserved() {
    let accepted = gateway_admin_runtime::parse::claude(
        &json!({"credential":"sk-ant-api-valid","workspace_id":"wrkspc_a.b-c"}),
    )
    .unwrap();
    assert_eq!(accepted.workspace_id, Some(Some("wrkspc_a.b-c".into())));
    assert_eq!(
        gateway_admin_runtime::parse::claude(
            &json!({"credential":format!("sk-ant-{}","x".repeat(507))})
        )
        .err()
        .unwrap()
        .status,
        400
    );
    assert_eq!(gateway_admin_runtime::parse::claude(&json!({"credential":"sk-ant-api-valid","create_new":true,"account_id":"12345678-1234-4123-8123-123456789abc"})).err().unwrap().status,400);
}

#[test]
fn kernel_usage_daily_series_uses_source_thirty_day_utc_window() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    store.put(
        json!(["ubq_ai", "kernel_auth", "org_usage", "owner"]),
        json!({"owner":"owner","total_requests":5,"last_seen_at_ms":900000}),
    );
    store.put(json!(["ubq_ai","kernel_auth","org_usage_daily","owner"]),json!({"owner":"owner","days":[{"day":"1970-01-01","request_count":5}],"updated_at_ms":900000}));
    let mut request = input(Value::Null);
    request.query.insert("scope".into(), vec!["org".into()]);
    request.query.insert("owner".into(), vec!["owner".into()]);
    request
        .query
        .insert("include_usage".into(), vec!["true".into()]);
    let result = run(service.execute(AdminOperation::KernelUsageGet, request)).unwrap();
    let body = result.body.wire_json();
    let series = body["usage"]["daily_requests"].as_array().unwrap();
    assert_eq!(series.len(), 30);
    assert_eq!(series[29], 5);
    assert_eq!(result.body.wire_json()["usage"]["input_tokens"], 0);
}

#[test]
fn supervisor_follow_dispatches_only_validated_finite_identifiers() {
    struct Follow(RefCell<Option<(String, String, String)>>);
    impl RuntimeCapabilities for Follow {
        async fn native(
            &self,
            request: NativeRequest,
            _: Context,
        ) -> Result<AuthResponse, GatewayError> {
            let NativeRequest::SupervisorOutput {
                source_id,
                thread_id,
                cursor,
            } = request
            else {
                panic!("wrong finite operation")
            };
            self.0
                .replace(Some((source_id, thread_id, cursor.unwrap_or_default())));
            Err(GatewayError::unavailable(
                "Native source is offline",
                "fixture_native_source_offline",
            ))
        }
    }
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let follow = Follow(RefCell::new(None));
    let service = AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &follow,
        config: &config,
    };
    let mut request = input(Value::Null);
    request
        .query
        .insert("source".into(), vec![" trusted-source ".into()]);
    request.query.insert("id".into(), vec!["thread-1".into()]);
    request
        .query
        .insert("cursor".into(), vec![format!(" {} ", "a".repeat(250))]);
    let error = run(service.execute(AdminOperation::SupervisorOutput, request)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("fixture_native_source_offline")
    );
    assert_eq!(
        *follow.0.borrow(),
        Some(("trusted-source".into(), "thread-1".into(), "a".repeat(240)))
    );
}

#[test]
fn defaults_work_from_runtime_catalog_without_optional_full_snapshot() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    seed_catalog(&store, true);
    store.rows.borrow_mut().remove(&codex_snapshot_key().0);
    let response = run(service.execute(
        AdminOperation::DefaultsSet,
        input(json!({"model":"gpt-source","reasoning_effort":"future-tier"})),
    ))
    .unwrap();
    assert_eq!(response.body.wire_json()["defaults"]["model"], "gpt-source");
    assert_eq!(
        run(service.paid_key_policy(
            &input(json!({"paid_fallback_enabled":true,"paid_fallback_limit_credits":1})).body
        ))
        .unwrap_err()
        .status,
        503
    );
}

#[test]
fn deletion_cleans_settled_state_then_owned_history_and_retains_ordinary_guard() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    store.put(
        json!(["ubq_ai", "api_keys", "id", "key"]),
        json!({"id":"key","name":"deletion fixture","prefix":"u_0000000000","hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","created_at_ms":800000,"expires_at_ms":-1,"revoked_at_ms":900000,"usage_limit_requests":-1,"usage_requests":0,"usage_reset_at_ms":2000000,"window_ms":604800000,"usage_quota_version":3,"paid_fallback_enabled":false,"paid_fallback_limit_microcredits":0,"paid_fallback_spent_microcredits":0,"paid_fallback_reserved_microcredits":0,"paid_fallback_reservation_request_id":null,"paid_fallback_model_ids":[],"paid_fallback_quota_per_credit":0,"paid_fallback_max_exposure_microcredits":{},"paid_fallback_pricing_checked_at_ms":null}),
    );
    store.put(json!(["uos_ai","paid_fallback","v3","request","key","attempt"]),json!({"v":3,"reservation":{"key_id":"key","request_id":"original","attempt_id":"attempt","provider":"metered","window_reset_at_ms":2000000,"created_at_ms":900000,"reserved_microcredits":20},"policy_version":"v3:week","model":"gpt-source","route":"responses","path":"/v1/responses","stream":true,"reasoning":null,"quota_per_credit":1000,"provider_request_id":"provider-request","dispatch_state":"dispatched","terminal_state":"completed","billing_state":"settled","provider_quota":1.0,"input_tokens":10,"cached_input_tokens":null,"output_tokens":1,"spend_microcredits":10,"transport_started":true,"reconciliation_attempts":0,"last_reconciliation_at_ms":null,"dispatched_at_ms":900000,"terminal_at_ms":900100,"settled_at_ms":900200,"updated_at_ms":900200,"usage_rollup_at_ms":900200}));
    store.put(json!(["uos_ai","paid_fallback","v3","window","key",2000000]),json!({"v":3,"key_id":"key","policy_version":"v3:week","window_reset_at_ms":2000000,"limit_microcredits":100,"settled_microcredits":10,"reserved_microcredits":0,"pending_count":0,"updated_at_ms":900200}));
    store.put(
        json!([
            "uos_ai",
            "paid_fallback",
            "v3",
            "reconciliation_lease",
            "key"
        ]),
        json!({"token":"lease","expires_at_ms":900001}),
    );
    for key in [
        json!(["ubq_ai", "api_keys", "usage", "key"]),
        json!(["ubq_ai", "api_keys", "usage_daily", "key"]),
        json!([
            "uos_ai",
            "paid_fallback",
            "ledger",
            "key",
            900000,
            "original"
        ]),
        json!(["ubq_ai", "api_keys", "request_log", "key", 900000, "legacy"]),
        json!(["uos_ai", "api_key_usage", "v2", "key", "bucket"]),
        json!([
            "uos_ai",
            "api_key_usage",
            "v3",
            "request",
            "key",
            "policy",
            1,
            "original"
        ]),
    ] {
        store.put(key, json!({"retained":true}));
    }
    store.put(
        json!([
            "uos_ai",
            "api_key_usage",
            "v3",
            "request",
            "foreign",
            "policy",
            1,
            "keep"
        ]),
        json!({"keep":true}),
    );
    let fences = run(service.prepare_key_deletion("key")).unwrap();
    assert!(
        store
            .get(json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "request",
                "key",
                "attempt"
            ]))
            .is_none()
    );
    assert!(
        store
            .get(json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "window",
                "key",
                2000000
            ]))
            .is_none()
    );
    let outcome = run(store.commit(AtomicTransition {
        checks: fences.clone(),
        mutations: vec![RecordMutation::Delete {
            key: gateway_auth::api_keys::id_key("key"),
        }],
    }))
    .unwrap();
    assert_eq!(outcome, CommitOutcome::Committed);
    run(service.finish_deletion("key", &fences)).unwrap();
    assert_eq!(
        store
            .get(json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "deletion_guard",
                "key"
            ]))
            .unwrap(),
        json!({"created_at_ms":1000000})
    );
    assert!(
        store
            .get(json!([
                "uos_ai",
                "api_key_usage",
                "v3",
                "request",
                "key",
                "policy",
                1,
                "original"
            ]))
            .is_none()
    );
    assert!(
        store
            .get(json!([
                "uos_ai",
                "api_key_usage",
                "v3",
                "request",
                "foreign",
                "policy",
                1,
                "keep"
            ]))
            .is_some()
    );
    assert_eq!(
        run(service.prepare_key_deletion("key")).unwrap_err().status,
        404
    );
}

#[test]
fn local_development_deletion_releases_only_owner_marker_and_completes_after_absent_id() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    let id = "local-development";
    store.put(
        json!(["ubq_ai", "api_keys", "id", id]),
        json!({"id":id,"name":"deletion fixture","prefix":"u_0000000000","hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","created_at_ms":800000,"expires_at_ms":-1,"revoked_at_ms":900000,"usage_limit_requests":-1,"usage_requests":0,"usage_reset_at_ms":2000000,"window_ms":604800000,"usage_quota_version":3,"paid_fallback_enabled":false,"paid_fallback_limit_microcredits":0,"paid_fallback_spent_microcredits":0,"paid_fallback_reserved_microcredits":0,"paid_fallback_reservation_request_id":null,"paid_fallback_model_ids":[],"paid_fallback_quota_per_credit":0,"paid_fallback_max_exposure_microcredits":{},"paid_fallback_pricing_checked_at_ms":null}),
    );
    store.put(
        json!(["uos_ai", "paid_fallback", "v3", "pending", id, "attempt"]),
        json!({"created_at_ms":900000}),
    );
    assert_eq!(
        run(service.prepare_key_deletion(id)).unwrap_err().status,
        409
    );
    let guard_key = json!(["uos_ai", "paid_fallback", "v3", "deletion_guard", id]);
    let guard = store.get(guard_key.clone()).unwrap();
    assert!(guard["local_deletion"]["owner"].is_null());
    assert!(guard["local_deletion"]["completed_at_ms"].is_null());
    store.rows.borrow_mut().remove(
        &gateway_auth::store::key(json!([
            "uos_ai",
            "paid_fallback",
            "v3",
            "pending",
            id,
            "attempt"
        ]))
        .0,
    );
    let first = run(service.prepare_key_deletion(id)).unwrap();
    assert_eq!(
        run(service.prepare_key_deletion(id)).unwrap_err().status,
        409
    );
    run(service.abort_deletion(id, &first)).unwrap();
    assert!(store.get(guard_key.clone()).unwrap()["local_deletion"]["owner"].is_null());
    let next = run(service.prepare_key_deletion(id)).unwrap();
    assert_eq!(
        run(service.finish_deletion(id, &next)).unwrap_err().status,
        409
    );
    run(store.commit(AtomicTransition {
        checks: next.clone(),
        mutations: vec![RecordMutation::Delete {
            key: gateway_auth::api_keys::id_key(id),
        }],
    }))
    .unwrap();
    run(service.finish_deletion(id, &next)).unwrap();
    let complete = store.get(guard_key).unwrap();
    assert_eq!(complete["local_deletion"]["completed_at_ms"], 1000000);
    assert!(complete["local_deletion"]["owner"].is_string());
}

#[test]
fn authenticated_admin_service_uses_runtime_deletion_completion_hooks() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let runtime = runtime(&store, &host, &config);
    let auth = AuthConfig {
        admin_tokens: vec![gateway_auth::crypto::Secret::new("fixture-admin".into())],
        ..AuthConfig::default()
    };
    let admin = gateway_admin::AdminService {
        store: &store,
        host: &host,
        capabilities: &runtime,
        config: &auth,
        release: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    let mut request = AuthRequest {
        method: "POST".into(),
        url: "https://ai.ubq.fi/admin/api-keys".into(),
        headers: BTreeMap::from([("authorization".into(), "Bearer fixture-admin".into())]),
        body: serde_json::to_vec(
            &json!({"name":"source lifecycle","expires_at_ms":-1,"usage_limit_requests":-1}),
        )
        .unwrap(),
        ..AuthRequest::default()
    };
    let created = run(admin.handle_route(&request, "create-key"))
        .unwrap()
        .unwrap();
    let id = created.body.wire_json()["id"].as_str().unwrap().to_owned();
    assert_eq!(created.status, 200);
    request.url = "https://ai.ubq.fi/admin/api-keys/revoke".into();
    request.body = serde_json::to_vec(&json!({"id":id})).unwrap();
    run(admin.handle_route(&request, "revoke-key"))
        .unwrap()
        .unwrap();
    store.put(
        json!(["uos_ai", "paid_fallback", "ledger", id, 900000, "record"]),
        json!({"retained":true}),
    );
    request.method = "DELETE".into();
    request.url = "https://ai.ubq.fi/admin/api-keys".into();
    let deleted = run(admin.handle_route(&request, "delete-key"))
        .unwrap()
        .unwrap();
    assert_eq!(deleted.status, 200);
    assert!(store.get(json!(["ubq_ai", "api_keys", "id", id])).is_none());
    assert!(
        store
            .get(json!([
                "uos_ai",
                "paid_fallback",
                "ledger",
                id,
                900000,
                "record"
            ]))
            .is_none()
    );
    assert!(
        store
            .get(json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "deletion_guard",
                id
            ]))
            .is_some()
    );
    let before = store.rows.borrow().clone();
    request.headers.clear();
    assert_eq!(
        run(admin.handle_route(&request, "unauthorized-delete"))
            .unwrap_err()
            .status,
        401
    );
    assert_eq!(*store.rows.borrow(), before);
}

#[test]
fn shared_native_follow_descriptor_is_preserved_and_json_success_is_rejected() {
    use gateway_auth::native::AuthStream;
    enum Reply {
        Prepared,
        JsonOnly,
        WrongSource,
    }
    struct Native(Reply);
    impl RuntimeCapabilities for Native {
        async fn native(
            &self,
            request: NativeRequest,
            _: Context,
        ) -> Result<AuthResponse, GatewayError> {
            let NativeRequest::SupervisorOutput {
                source_id,
                thread_id,
                cursor,
            } = request
            else {
                panic!("wrong finite operation")
            };
            let response = AuthResponse::json(200, Value::Null);
            Ok(match self.0 {
                Reply::Prepared => response.with_stream(AuthStream::SupervisorFollow {
                    source_id,
                    thread_id,
                    cursor,
                }),
                Reply::JsonOnly => response,
                Reply::WrongSource => response.with_stream(AuthStream::SupervisorFollow {
                    source_id: "unselected-source".into(),
                    thread_id,
                    cursor,
                }),
            })
        }
    }
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    for reply in [Reply::Prepared, Reply::JsonOnly, Reply::WrongSource] {
        let prepared = matches!(reply, Reply::Prepared);
        let native = Native(reply);
        let service = AdminRuntime {
            store: &store,
            host: &host,
            capabilities: &native,
            config: &config,
        };
        let mut request = input(Value::Null);
        request
            .query
            .insert("source".into(), vec!["trusted-source".into()]);
        request.query.insert("id".into(), vec!["thread".into()]);
        let result = run(service.execute(AdminOperation::SupervisorOutput, request));
        if prepared {
            assert_eq!(
                result.unwrap().stream,
                Some(AuthStream::SupervisorFollow {
                    source_id: "trusted-source".into(),
                    thread_id: "thread".into(),
                    cursor: None
                })
            );
        } else {
            assert_eq!(
                result.unwrap_err().envelope.error.code.as_deref(),
                Some("native_protocol_invalid")
            );
        }
    }
}

#[test]
fn admin_inputs_use_source_number_coercion_and_ecmascript_whitespace() {
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    let service = runtime(&store, &host, &config);
    let response = run(service.execute(
        AdminOperation::DebugSet,
        input(json!({"scenario":"\u{feff}codex_429\u{feff}","duration_ms":["16"]})),
    ))
    .unwrap();
    assert_eq!(
        response.body.wire_json()["routing"]["expires_at_ms"],
        1000016
    );
    let response = run(service.execute(
        AdminOperation::ClaudeAccessSet,
        input(json!({"allowed_key_ids":["\u{0085}key\u{0085}"]})),
    ))
    .unwrap();
    assert_eq!(
        response.body.wire_json()["data"]["allowed_key_ids"],
        json!(["\u{0085}key\u{0085}"])
    );
    let mut request = input(Value::Null);
    request
        .query
        .insert("after_ms".into(), vec![" \u{feff}0x10\u{feff} ".into()]);
    request
        .query
        .insert("before_ms".into(), vec!["0x20".into()]);
    request.query.insert("limit".into(), vec!["0b1".into()]);
    assert_eq!(
        gateway_admin_runtime::parse::capture(&request, false).unwrap(),
        CaptureRequest::Interval {
            after_ms: 16,
            before_ms: 32,
            cursor: None
        }
    );
    request
        .query
        .insert("after_ms".into(), vec!["\u{0085}16\u{0085}".into()]);
    assert_eq!(
        gateway_admin_runtime::parse::capture(&request, false)
            .unwrap_err()
            .status,
        400
    );
}

#[test]
fn public_supervisor_brief_uses_final_operation_and_never_leaks_native_context() {
    struct Brief {
        raw_context: bool,
    }
    impl RuntimeCapabilities for Brief {
        async fn supervisor_brief(
            &self,
            target: SupervisorBriefTarget,
            context: Context,
        ) -> Result<AuthResponse, GatewayError> {
            let body = if self.raw_context {
                json!({"sourceId":target.source_id,"threadId":target.thread_id,"turns":[{"text":"private recorded context"}]})
            } else {
                json!({"sourceId":target.source_id,"threadId":target.thread_id,"machine":"fixture machine","about":"No recorded transcript was available for this session.","status":"Current runtime state is active.","model":null,"effort":null,"state":"active","sampledAtMs":context.now_ms,"generatedAtMs":context.now_ms,"transcript":{"turns":0,"bytes":0,"truncated":false,"redactions":0,"available":false}})
            };
            Ok(AuthResponse::json(200, body))
        }
    }
    let store = Store::default();
    let host = Host::default();
    let config = RuntimeConfig::default();
    for raw_context in [false, true] {
        let capability = Brief { raw_context };
        let service = AdminRuntime {
            store: &store,
            host: &host,
            capabilities: &capability,
            config: &config,
        };
        let response = run(service.execute(
            AdminOperation::SupervisorBrief,
            input(json!({"source":"trusted-source","id":"thread"})),
        ));
        if raw_context {
            assert_eq!(
                response.unwrap_err().envelope.error.code.as_deref(),
                Some("supervisor_brief_invalid_response")
            );
        } else {
            let response = response.unwrap();
            assert_eq!(response.status, 200);
            assert_eq!(response.body.wire_json()["model"], Value::Null);
            assert!(response.body.wire_json().get("turns").is_none());
        }
    }
}

#[test]
fn shared_claude_access_loader_returns_exact_fence_and_does_not_reseed_explicit_deny() {
    use gateway_admin_runtime::claude_access::*;
    let store = Store::default();
    let host = Host::default();
    store.conflicts.set(2);
    let loaded = run(load_policy(
        &store,
        &host,
        &["trusted-seed".into()],
        &|a, b| Ok(a.cmp(b)),
    ))
    .unwrap();
    assert_eq!(loaded.policy.source, PolicySource::Env);
    assert_eq!(
        loaded.policy.allowed_key_ids,
        vec![JsString16::from_utf8("trusted-seed")]
    );
    let actual = run(store.read(&policy_key())).unwrap().unwrap();
    assert_eq!(loaded.check.expected_revision, Some(actual.revision));
    store.put(
        json!(["uos_ai", "claude_code_access", "v1"]),
        json!({"v":1,"source":"kv","allowed_key_ids":[],"updated_at_ms":100}),
    );
    let denied = run(load_policy(
        &store,
        &host,
        &["must-not-resurrect".into()],
        &|a, b| Ok(a.cmp(b)),
    ))
    .unwrap();
    assert!(denied.policy.allowed_key_ids.is_empty());
    assert_eq!(denied.policy.source, PolicySource::Kv);
    assert_eq!(
        run(store.commit(AtomicTransition {
            checks: vec![loaded.check],
            mutations: vec![]
        }))
        .unwrap(),
        CommitOutcome::Conflict
    );
    store.put(
        json!(["uos_ai", "claude_code_access", "v1"]),
        json!({"v":1,"source":"kv","allowed_key_ids":null,"updated_at_ms":100}),
    );
    assert!(
        run(load_policy(
            &store,
            &host,
            &["forbidden-fallback".into()],
            &|a, b| Ok(a.cmp(b))
        ))
        .is_err()
    );
}
#[test]
fn shared_claude_access_parser_preserves_stable_locale_ties_and_missing_host_refuses() {
    use gateway_admin_runtime::claude_access::*;
    let ids = parse_ids(&json!(["é", "e\u{0301}", "é"]), &|_, _| {
        Ok(std::cmp::Ordering::Equal)
    })
    .unwrap();
    assert_eq!(
        ids,
        vec![
            JsString16::from_utf8("é"),
            JsString16::from_utf8("e\u{0301}")
        ]
    );
    assert!(
        parse_policy(
            &json!({"v":1,"source":"kv","allowed_key_ids":[],"updated_at_ms":9007199254740992_i64}),
            &|a, b| Ok(a.cmp(b))
        )
        .is_err()
    );
    let store = Store::default();
    let host = Host::default();
    let error = run(load_policy(
        &store,
        &host,
        &["a".into(), "b".into()],
        &|_, _| {
            Err(GatewayError::unavailable(
                "locale host missing",
                "source_collation_unavailable",
            ))
        },
    ))
    .unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("source_collation_unavailable")
    );
    assert!(
        store
            .get(json!(["uos_ai", "claude_code_access", "v1"]))
            .is_none()
    );
    store.conflicts.set(8);
    assert_eq!(
        run(load_policy(&store, &host, &[], &|a, b| Ok(a.cmp(b))))
            .unwrap_err()
            .status,
        409
    );
    assert!(
        store
            .get(json!(["uos_ai", "claude_code_access", "v1"]))
            .is_none()
    );
}
