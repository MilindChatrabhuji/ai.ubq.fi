#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_auth::store::key;
use gateway_core::{state::AuthorityStore, tuple_key::TupleKey};
use gateway_migration::{native_stage::Captured, *};
use serde_json::{Value, json};
use support::{fixture::*, sqlite_store::*};

const SOURCE: &str = "6d4d4790a7c06514b92938ff677dbfd52764461d";

fn atom(value: Value, nodes: &mut Vec<Value>) -> Value {
    match value {
        Value::Null => json!({"type":"null","value":null}),
        Value::Bool(value) => json!({"type":"boolean","value":value}),
        Value::String(value) => json!({"type":"string","value":value}),
        Value::Number(value) => json!({"type":"number","value":value}),
        Value::Object(fields) => {
            let id = nodes.len();
            nodes.push(json!({"type":"object","entries":[]}));
            let entries = fields
                .into_iter()
                .map(|(name, value)| json!([name, atom(value, nodes)]))
                .collect::<Vec<_>>();
            nodes[id] = json!({"type":"object","entries":entries});
            json!({"type":"ref","ref":id})
        }
        Value::Array(items) => {
            let id = nodes.len();
            let length = items.len();
            nodes.push(json!({"type":"Array","length":length,"entries":[]}));
            let entries = items
                .into_iter()
                .enumerate()
                .map(|(index, value)| json!([index.to_string(), atom(value, nodes)]))
                .collect::<Vec<_>>();
            nodes[id] = json!({"type":"Array","length":length,"entries":entries});
            json!({"type":"ref","ref":id})
        }
    }
}

fn graph(value: Value) -> NativeValue {
    let mut nodes = Vec::new();
    let root = atom(value, &mut nodes);
    NativeValue::SourceGraphV1(
        gateway_core::source_json::SourceJson::from_serializable(&json!({
            "root": root,
            "nodes": nodes
        }))
        .unwrap(),
    )
}

fn entry(key_parts: Value, value: Value, revision: &str, expiration_ms: i64) -> NativeEntry {
    let raw_key = TupleKey::from_json_parts(key_parts.as_array().unwrap())
        .unwrap()
        .sort_bytes()
        .to_vec();
    NativeEntry {
        raw_key,
        value: graph(value),
        revision: NativeRevision {
            version: revision.into(),
            sequence: "0".into(),
        },
        expiration_ms,
    }
}

fn capture(entries: Vec<NativeEntry>) -> NativeCapture {
    NativeCapture {
        v: 2,
        source_git_sha: SOURCE.into(),
        captured_at_ms: 2200,
        source_codec: "bun-jsc-v1".into(),
        native_schema_version: 3,
        data_revision: NativeRevision {
            version: "50".into(),
            sequence: "0".into(),
        },
        queue_entries: 0,
        running_queue_entries: 0,
        entries,
    }
}

fn key_records(token: &str) -> (Value, Value) {
    let hash = gateway_auth::crypto::sha256_base64url(token.as_bytes());
    let hash_record = json!({
        "id":"core-key","expires_at_ms":-1,"revoked_at_ms":null,
        "usage_limit_requests":-1,"usage_requests":0,"usage_reset_at_ms":3000,
        "window_ms":1000,"usage_quota_version":3,
        "paid_fallback_enabled":false,"paid_fallback_limit_microcredits":-1,
        "paid_fallback_spent_microcredits":0,"paid_fallback_reserved_microcredits":0,
        "paid_fallback_reservation_request_id":null
    });
    let mut id = hash_record.clone();
    for (name, value) in json!({
        "name":"Core key","prefix":&token[..12],"hash":hash,"created_at_ms":1000,
        "paid_fallback_model_ids":[],"paid_fallback_quota_per_credit":0,
        "paid_fallback_max_exposure_microcredits":{},"paid_fallback_pricing_checked_at_ms":null
    })
    .as_object()
    .unwrap()
    {
        id[name] = value.clone();
    }
    (id, hash_record)
}

fn current_api_window() -> Value {
    json!({"v":3,"key_id":"core-key","policy_version":"v3:1000","window_start_ms":2000,"window_reset_at_ms":3000,"committed_requests":42,"reserved_requests":0,"updated_at_ms":2100})
}

fn paid_request(request: &str, reset: i64, state: &str) -> Value {
    json!({
        "v":3,"key_id":"core-key","request_id":request,"policy_version":"v3:1000",
        "route":"responses","path":"/v1/responses","stream":false,
        "model":"gpt-6.1-sol","reasoning":null,
        "window_reset_at_ms":reset,"reserved_microcredits":if state=="unresolved"{5}else{0},
        "quota_per_credit":1,"provider":"surplus","provider_request_id":null,"provider_quota":null,
        "input_tokens":null,"output_tokens":null,
        "spend_microcredits":if state=="settled"{Value::from(5)}else{Value::Null},
        "dispatch_state":if state=="settled"{"dispatched"}else{"reserved"},
        "terminal_state":if state=="settled"{"completed"}else{"pending"},
        "billing_state":state,"reconciliation_attempts":0,"last_reconciliation_at_ms":null,
        "dispatched_at_ms":if state=="settled"{Value::from(2050)}else{Value::Null},
        "terminal_at_ms":if state=="settled"{Value::from(2100)}else{Value::Null},
        "settled_at_ms":if state=="settled"{Value::from(2100)}else{Value::Null},
        "created_at_ms":2000,"updated_at_ms":if state=="settled"{2100}else{2000}
    })
}

fn valid_core_entries() -> Vec<NativeEntry> {
    let token = format!("u_{}", "2".repeat(64));
    let (id, hash) = key_records(&token);
    let hash_key = gateway_auth::crypto::sha256_base64url(token.as_bytes());
    vec![
        entry(
            json!(["ubq_ai", "api_keys", "id", "core-key"]),
            id,
            "49",
            -1,
        ),
        entry(
            json!(["ubq_ai", "api_keys", "hash", hash_key]),
            hash,
            "49",
            -1,
        ),
        entry(
            json!([
                "uos_ai",
                "api_key_usage",
                "v3",
                "window",
                "core-key",
                "v3:1000",
                2000
            ]),
            current_api_window(),
            "49",
            10_000,
        ),
        entry(
            json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "request",
                "core-key",
                "current"
            ]),
            paid_request("current", 3000, "unresolved"),
            "49",
            -1,
        ),
        entry(
            json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "pending",
                "core-key",
                "current"
            ]),
            json!({"created_at_ms":2000,"next_reconciliation_at_ms":2300}),
            "49",
            -1,
        ),
        entry(
            json!(["default", "kernel_policy_limit_requests"]),
            json!(-1),
            "49",
            -1,
        ),
        entry(
            json!(["default", "kernel_policy_window_ms"]),
            json!(604800000),
            "49",
            -1,
        ),
    ]
}

#[test]
fn current_core_excludes_histories_and_proves_the_free_write_budget() {
    let token = format!("u_{}", "2".repeat(64));
    let (id, hash) = key_records(&token);
    let hash_key = gateway_auth::crypto::sha256_base64url(token.as_bytes());
    let mut entries = valid_core_entries();
    entries[0] = entry(
        json!(["ubq_ai", "api_keys", "id", "core-key"]),
        id,
        "49",
        -1,
    );
    entries[1] = entry(
        json!(["ubq_ai", "api_keys", "hash", hash_key]),
        hash,
        "49",
        -1,
    );
    entries.extend([
        entry(
            json!(["uos_ai", "api_key_usage", "v3", "window", "core-key", "v3:1000", 1000]),
            json!({"v":3,"key_id":"core-key","policy_version":"v3:1000","window_start_ms":1000,"window_reset_at_ms":2000,"committed_requests":41,"reserved_requests":0,"updated_at_ms":1900}),
            "48",
            9000,
        ),
        entry(
            json!(["uos_ai", "api_key_usage", "v3", "request", "core-key", "v3:1000", 2000, "request-history"]),
            json!({"v":3,"key_id":"core-key","request_id":"request-history","route":"responses","state":"released","reserved_at_ms":2000,"lease_expires_at_ms":2100,"provider":null,"dispatched_at_ms":null,"released_at_ms":2100,"release_reason":"fixture"}),
            "48",
            9000,
        ),
        entry(
            json!(["uos_ai", "paid_fallback", "v3", "request", "core-key", "old"]),
            paid_request("old", 2000, "settled"),
            "48",
            -1,
        ),
        entry(
            json!(["uos_ai", "paid_fallback", "v3", "pending", "core-key", "old"]),
            json!({"created_at_ms":1000,"next_reconciliation_at_ms":1200}),
            "48",
            -1,
        ),
        entry(
            json!(["uos_ai", "paid_fallback", "v3", "reconciliation_gate"]),
            json!({"created_at_ms":1000,"next_reconciliation_at_ms":2300}),
            "48",
            -1,
        ),
        entry(json!(["uos_ai", "admin_error_log", "v1", "x"]), json!({}), "48", -1),
        entry(json!(["uos_ai", "sentinel_replay", "v1", "x"]), json!({}), "48", -1),
        entry(json!(["uos_ai", "sentinel_incident", "v1", "x"]), json!({}), "48", -1),
        entry(json!(["uos_ai", "prompt_cache_analytics", "v1", "x"]), json!({}), "48", -1),
        entry(json!(["uos_ai", "prompt_cache_telemetry_gate", "v1", "x"]), json!({}), "48", -1),
        entry(json!(["uos_ai", "provider_capacity", "v1", "history", 1000]), json!({}), "48", -1),
        entry(json!(["uos_ai", "metered_quota", "v1", "balance_history", 1000]), json!({}), "48", -1),
        entry(json!(["uos_ai", "api_keys", "change", 1]), json!({}), "48", -1),
    ]);
    let directory = Directory::new();
    let spool = directory.file("spool");
    std::fs::create_dir(&spool).unwrap();
    let core = Captured::owned(capture(entries), &spool)
        .unwrap()
        .core_capture()
        .unwrap();
    assert_eq!(core.manifest.source_rows, 20);
    assert_eq!(core.manifest.selected_rows, 7);
    assert_eq!(core.manifest.excluded_rows, 13);
    assert_eq!(core.manifest.current_api_windows, 1);
    assert_eq!(core.manifest.current_paid_requests, 1);
    assert_eq!(core.manifest.current_paid_unresolved, 1);
    assert_eq!(core.manifest.current_paid_pending, 1);
    assert!(
        core.manifest
            .excluded
            .iter()
            .any(|rule| rule.rule == "historical_observability" && rule.rows == 4)
    );
    assert!(
        core.manifest
            .excluded
            .iter()
            .any(|rule| rule.rule == "historical_error_log" && rule.rows == 1)
    );
    assert!(
        core.manifest
            .excluded
            .iter()
            .any(|rule| rule.rule == "historical_paid_fallback" && rule.rows == 2)
    );
    assert!(
        core.manifest
            .excluded
            .iter()
            .any(|rule| rule.rule == "historical_provider_capacity" && rule.rows == 1)
    );
    assert!(
        core.manifest
            .excluded
            .iter()
            .any(|rule| rule.rule == "historical_metered_balance" && rule.rows == 1)
    );
    assert!(
        core.manifest
            .excluded
            .iter()
            .any(|rule| rule.rule == "recomputed_paid_fallback_gate" && rule.rows == 1)
    );
    assert!(core.manifest.do_row_writes < CORE_STATE_DO_ROW_WRITE_LIMIT);
    assert_eq!(core.manifest.derived_rows, 4);
    assert_eq!(core.manifest.do_row_writes, 19);
    assert!(
        !serde_json::to_string(&core.manifest)
            .unwrap()
            .contains("request-history")
    );
}

#[test]
fn unknown_source_family_is_refused_before_any_adoption_plan() {
    let mut entries = valid_core_entries();
    entries.push(entry(
        json!(["unknown_namespace", "record"]),
        json!({}),
        "49",
        -1,
    ));
    let directory = Directory::new();
    let spool = directory.file("spool");
    std::fs::create_dir(&spool).unwrap();
    assert!(
        Captured::owned(capture(entries), &spool)
            .unwrap()
            .core_capture()
            .is_err()
    );
}

#[test]
fn selected_core_adopts_restarts_reads_quota_and_round_trips_current_accounting() {
    let token = format!("u_{}", "2".repeat(64));
    let directory = Directory::new();
    let path = directory.file("core.sqlite3");
    let spool = directory.file("spool");
    std::fs::create_dir(&spool).unwrap();
    let core = Captured::owned(capture(valid_core_entries()), &spool)
        .unwrap()
        .core_capture()
        .unwrap();
    let prepared = match prepare_native(&core.capture) {
        Ok(prepared) => prepared,
        Err(gateway_migration::MigrationError::SourceInventory(audit)) => panic!(
            "prepare_native failed: {:?}",
            audit
                .errors
                .iter()
                .map(|error| error.try_utf8().unwrap_or_else(|_| "<non-utf8>".into()))
                .collect::<Vec<_>>()
        ),
        Err(error) => panic!("prepare_native failed: {error:?}"),
    };
    assert_eq!(prepared.source_rows(), core.manifest.selected_rows);
    assert_eq!(prepared.derived_rows(), core.manifest.derived_rows);
    assert_eq!(
        prepared.expected_do_row_writes(),
        Some(core.manifest.do_row_writes)
    );
    assert_eq!(core.manifest.do_row_writes, 19);
    let store = SqliteStore::open(&path);
    let receipt = run(adopt_empty(&store, &prepared)).unwrap();
    assert_eq!(receipt.source_rows, core.manifest.selected_rows);
    assert_eq!(receipt.derived_rows, core.manifest.derived_rows);
    drop(store);

    let store = SqliteStore::open(&path);
    assert_eq!(
        run(gateway_auth::api_keys::authenticate(&store, &token, 2300))
            .unwrap()
            .key_id,
        "core-key"
    );
    let listed = run(gateway_admin::reads::api_keys(&store, 2300)).unwrap();
    assert_eq!(listed.status, 200);
    let body = String::from_utf8(listed.body.to_bytes().unwrap()).unwrap();
    assert!(body.contains("core-key"));
    assert!(body.contains("42"));
    let listed: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        listed["data"][0]["paid_fallback_reserved_credits"].as_f64(),
        Some(0.000005)
    );
    let authority = gateway_authority::Authority::with_clock(
        store.clone(),
        support_clock::Tokens(std::sync::atomic::AtomicU64::new(1)),
        support_clock::Clock,
    );
    let reservation = run(authority.reserve_api_key(
        &gateway_core::identity::ApiKeyId("core-key".into()),
        &gateway_core::identity::RequestId("post-restart".into()),
        "responses",
        2300,
    ))
    .unwrap();
    assert_eq!(reservation.request_id.0, "post-restart");
    drop(authority);
    let paid_key = gateway_authority::keys::paid_attempt("core-key", "current");
    let paid = run(store.read(&paid_key)).unwrap().unwrap();
    let paid = gateway_authority::paid::decode_paid_attempt_record(&paid_key, &paid).unwrap();
    assert_eq!(
        paid.billing_state,
        gateway_core::lifecycle::BillingState::Unresolved
    );
    assert_eq!(paid.reservation.reserved_microcredits, 5);
    let gate = run(store.read(&gateway_authority::keys::paid_gate()))
        .unwrap()
        .unwrap();
    assert_eq!(
        gate.json_value().unwrap()["pending"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
    let latest = run(export_native_latest(&store, 2300)).unwrap();
    let paid_sort = TupleKey::from_record_key(&paid_key)
        .unwrap()
        .sort_bytes()
        .to_vec();
    assert!(
        latest
            .entries
            .iter()
            .any(|entry| entry.raw_key == paid_sort)
    );
    let paid_window = gateway_authority::keys::paid_window("core-key", 3000);
    let paid_window_sort = TupleKey::from_record_key(&paid_window)
        .unwrap()
        .sort_bytes()
        .to_vec();
    assert!(
        !latest
            .entries
            .iter()
            .any(|entry| entry.raw_key == paid_window_sort),
        "derived paid window must not become source state"
    );
    let inverse = SqliteStore::open(&directory.file("inverse.sqlite3"));
    let inverse_prepared = prepare_native(&latest).unwrap();
    run(adopt_empty(&inverse, &inverse_prepared)).unwrap();
    assert_eq!(
        run(gateway_auth::api_keys::authenticate(&inverse, &token, 2300))
            .unwrap()
            .key_id,
        "core-key"
    );
    assert!(
        run(inverse.read(&key(json!(["uos_ai", "admin_error_log"]))))
            .unwrap()
            .is_none()
    );
}

#[test]
fn bounded_core_staging_uses_the_same_spool_and_write_budget() {
    let directory = Directory::new();
    let spool = directory.file("spool");
    std::fs::create_dir(&spool).unwrap();
    let (manifest, mut plan) = run(Captured::owned(capture(valid_core_entries()), &spool)
        .unwrap()
        .prepare_core(&NoCustody))
    .unwrap();
    let summary = plan.summary();
    assert_eq!(summary.source_rows, manifest.selected_rows);
    assert_eq!(summary.derived_rows, manifest.derived_rows);
    assert_eq!(summary.records as u64 + 1, manifest.do_row_writes);
    let store = SqliteStore::open(&directory.file("staged.sqlite3"));
    run(gateway_migration::staged::execute_staged(
        &store,
        plan.begin(),
    ))
    .unwrap();
    while let Some(batch) = plan.next_batch().unwrap() {
        run(gateway_migration::staged::execute_staged(&store, batch)).unwrap();
    }
    let receipt = run(gateway_migration::staged::execute_staged(
        &store,
        plan.seal(),
    ))
    .unwrap();
    assert!(receipt.sealed);
    assert!(!receipt.activation_authorized);
    assert_eq!(receipt.accepted_records as u64 + 1, manifest.do_row_writes);
}

struct NoCustody;
impl NativeCustody for NoCustody {
    async fn observe(&self, _: &str) -> Result<OwnedNativeSnapshot, gateway_core::GatewayError> {
        Err(gateway_core::GatewayError::unavailable(
            "no native custody in synthetic core-state fixture",
            "migration_native_custody_required",
        ))
    }
}

mod support_clock {
    use gateway_core::GatewayError;
    pub struct Tokens(pub std::sync::atomic::AtomicU64);
    impl gateway_authority::TokenSource for Tokens {
        fn next_token(&self) -> Result<String, GatewayError> {
            Ok(format!(
                "core-fixture-{}",
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            ))
        }
    }
    pub struct Clock;
    impl gateway_authority::AuthorityClock for Clock {
        fn now_ms(&self) -> Result<i64, GatewayError> {
            Ok(2300)
        }
    }
}
