mod support;
use gateway_admin_runtime::capabilities::{Context, ProviderRequest};
use gateway_auth::crypto::sha256_hex;
use gateway_core::{
    GatewayError,
    source_json::SourceJson,
    state::{RecordKey, StoredRecord},
    tuple_key::TupleKey,
};
use gateway_observability::{
    ObservabilityRuntime,
    api::*,
    capacity_shapes::{history_point, unavailable_snapshot},
    host_types::*,
    types::ObservabilityHost,
};
use serde_json::{Value, json};
use support::{Host, Memory, run};

fn key(parts: Value) -> RecordKey {
    TupleKey::from_json_parts(parts.as_array().unwrap())
        .unwrap()
        .to_record_key()
}
fn put(memory: &Memory, parts: Value, value: Value) {
    memory
        .rows
        .borrow_mut()
        .insert(key(parts).0, StoredRecord::json("fixture", value, None));
}
fn context() -> Context {
    Context {
        request_id: "request-one".into(),
        now_ms: 0,
    }
}
struct AdminHost {
    base: Host,
    raw: Vec<u8>,
}
impl ObservabilityHost for AdminHost {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        self.base.source_string_collator()
    }
    fn now_ms(&self) -> i64 {
        self.base.now_ms()
    }
    fn random_bytes(&self, n: usize) -> Result<Vec<u8>, GatewayError> {
        self.base.random_bytes(n)
    }
    fn compare_labels(&self, a: &str, b: &str) -> Result<std::cmp::Ordering, GatewayError> {
        Ok(a.cmp(b))
    }
    async fn wait_ms(&self, n: u32) -> Result<(), GatewayError> {
        self.base.wait_ms(n).await
    }
    async fn capacity_observation_body(&self, c: &Context) -> Result<Vec<u8>, GatewayError> {
        assert_eq!(c.request_id, "request-one");
        Ok(self.raw.clone())
    }
    async fn codex_capacity_accounts(&self) -> Result<Vec<CapacityAccountRef>, GatewayError> {
        Ok(vec![CapacityAccountRef {
            slot: 1,
            account_id: "fixture-account".into(),
            label: None,
        }])
    }
    async fn metered_balance_fingerprint(&self) -> Result<Option<String>, GatewayError> {
        Ok(Some("fixture-balance".into()))
    }
    async fn metered_quota_snapshot(
        &self,
        _force: bool,
        _deadline: i64,
    ) -> Result<Option<Value>, GatewayError> {
        Ok(None)
    }
}
#[test]
fn legacy_reset_opt_out_seeds_until_complete_and_preserves_explicit_accounts() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(100);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    put(
        &memory,
        json!(["uos_ai", "codex_banked_reset_usage", "v1"]),
        json!(false),
    );
    assert!(!run(runtime.reset_usage_allowed("unknown-environment-account")).unwrap());
    assert!(
        !memory.rows.borrow().contains_key(
            &key(json!([
                "uos_ai",
                "migrations",
                "codex_reset_usage_legacy_global_v1"
            ]))
            .0
        )
    );
    let explicit = sha256_hex(b"explicit");
    let seeded = sha256_hex(b"seeded");
    put(
        &memory,
        json!(["uos_ai", "codex_reset_usage", "account", "v1", explicit]),
        json!({"enabled":true}),
    );
    put(
        &memory,
        json!(["ubq_ai", "codex_auth"]),
        json!({"updated_at_ms":1,"accounts":[{"account_id":"explicit","access_token":"fixture-access-a","refresh_token":"fixture-refresh-a","updated_at_ms":1},{"account_id":"seeded","access_token":"fixture-access-b","refresh_token":"fixture-refresh-b","updated_at_ms":1}]}),
    );
    assert!(run(runtime.migrate_legacy_reset_opt_out()).unwrap());
    assert!(run(runtime.reset_usage_allowed(&explicit)).unwrap());
    assert!(!run(runtime.reset_usage_allowed(&seeded)).unwrap());
    assert!(run(runtime.reset_usage_allowed("configured-after-marker")).unwrap());
    assert_eq!(
        memory.rows.borrow()[&key(json!(["uos_ai", "codex_banked_reset_usage", "v1"])).0]
            .json_value()
            .unwrap(),
        &json!(false)
    );
}
#[test]
fn reset_settings_reject_an_old_account_without_a_write_and_show_unknown_diagnostics_as_null() {
    let memory = Memory::default();
    let host = AdminHost {
        base: Host::default(),
        raw: vec![],
    };
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    assert_eq!(
        run(runtime.reset_settings_response(Some(
            &SourceJson::from_serializable(&json!({"account_id_hash":"retired","enabled":true}))
                .unwrap()
        )))
        .unwrap_err()
        .status,
        409
    );
    assert_eq!(memory.commits.get(), 0);
    let hash = sha256_hex(b"fixture-account");
    let response = run(runtime.reset_settings_response(Some(
        &SourceJson::from_serializable(&json!({"account_id_hash":hash,"enabled":false})).unwrap(),
    )))
    .unwrap();
    assert_eq!(response.body.as_json().unwrap()["enabled"], false);
    let response = run(runtime.reset_settings_response(None)).unwrap();
    assert_eq!(
        response.body.as_json().unwrap()["data"][0]["enabled"],
        false
    );
    assert!(response.body.as_json().unwrap()["data"][0]["available_count"].is_null());
    assert!(response.body.as_json().unwrap()["data"][0]["credits"].is_null());
}
#[test]
fn raw_capacity_body_limit_cannot_be_replaced_by_a_small_reserialization() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(900000);
    let document =
        json!({"host":"neighbour","history":[history_point(&unavailable_snapshot(900000))]});
    let mut raw = serde_json::to_vec(&document).unwrap();
    raw.resize(4 * 1024 * 1024 + 1, b' ');
    let runtime = ObservabilityRuntime::new(memory.clone(), AdminHost { base: clock, raw });
    let response = run(runtime.provider(
        ProviderRequest::Observations {
            document: SourceJson::from_serializable(&document).unwrap(),
        },
        context(),
    ))
    .unwrap_err();
    assert_eq!(response.status, 413);
    assert_eq!(memory.commits.get(), 0);
}
#[test]
fn malformed_late_capacity_observation_is_rejected_before_any_batch_write() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(900000);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    let body =
        json!({"host":"neighbour","history":[history_point(&unavailable_snapshot(900000)),{}]});
    let raw = serde_json::to_vec(&body).unwrap();
    assert_eq!(
        run(runtime.capacity_observation_response(&raw, context()))
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(memory.commits.get(), 0);
}
#[test]
fn request_body_binding_rejects_a_different_document() {
    let memory = Memory::default();
    let clock = Host::default();
    let raw = serde_json::to_vec(&json!({"host":"one","history":[]})).unwrap();
    let runtime = ObservabilityRuntime::new(memory.clone(), AdminHost { base: clock, raw });
    assert_eq!(
        run(runtime.provider(
            ProviderRequest::Observations {
                document: SourceJson::from_serializable(&json!({"host":"two","history":[]}))
                    .unwrap()
            },
            context()
        ))
        .unwrap_err()
        .status,
        400
    );
    assert_eq!(memory.commits.get(), 0);
}
#[test]
fn projection_distinguishes_failed_scans_and_retains_both_ends_of_long_balance_history() {
    let memory = Memory::default();
    let clock = Host::default();
    let at = 366 * 86400000 + 1234;
    clock.at.set(at);
    let runtime = ObservabilityRuntime::new(
        memory.clone(),
        AdminHost {
            base: clock,
            raw: vec![],
        },
    );
    for (i, t) in [at - 365 * 86400000, at].into_iter().enumerate() {
        let sample = json!({"v":1,"bucket_start_at_ms":t/3600000*3600000,"observed_at_ms":t,"balance_quota":100-i,"baseline_quota":100,"quota_per_credit":1,"remaining_percent":null});
        put(
            &memory,
            json!([
                "uos_ai",
                "metered_quota",
                "v1",
                "balance_history",
                "fixture-balance",
                t / 3600000 * 3600000
            ]),
            sample,
        );
    }
    let response = run(runtime.quota_projection_response(30, 365)).unwrap();
    let body: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(body["balance_history"].as_array().unwrap().len(), 2);
    assert_eq!(body["balance_history_scan"], "ok");
    assert_eq!(body["retention"]["balance_history_bucket_ms"], 25 * 3600000);
    memory.unavailable.set(true);
    let response = run(runtime.quota_projection_response(30, 365)).unwrap();
    let body: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(body["rollup_scan"], "unavailable");
    assert_eq!(body["balance_history_scan"], "unavailable");
    assert_eq!(body["ledger_growth"]["scan"], "unavailable");
}
#[test]
fn resampling_keeps_newest_observation_without_changing_its_time() {
    let samples = vec![
        json!({"observed_at_ms":10,"bucket_start_at_ms":0}),
        json!({"observed_at_ms":20,"bucket_start_at_ms":1}),
        json!({"observed_at_ms":20,"bucket_start_at_ms":2}),
    ];
    let points = resample_balance(&samples, 100, 365);
    assert_eq!(
        points,
        vec![json!({"observed_at_ms":20,"bucket_start_at_ms":0})]
    );
}
