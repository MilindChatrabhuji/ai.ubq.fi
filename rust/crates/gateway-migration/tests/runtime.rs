#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_admin_data::profile::{
    from_source_profile as from_profile, to_source_profile as to_profile,
};
use gateway_auth::{crypto::sha256_base64url, store::key};
use gateway_core::source_json::SourceJson;
use gateway_core::value::PortableValue;
use gateway_core::{
    GatewayError,
    identity::{ApiKeyId, RequestId},
    state::*,
};
use gateway_migration::*;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use support::{fixture::*, sqlite_store::*};

fn raw(value: Value) -> SourceJson {
    SourceJson::from_serializable(&value).unwrap()
}
const SOURCE: &str = "6d4d4790a7c06514b92938ff677dbfd52764461d";
fn source(parts: Value, value: Value, revision: &str, expires: Option<i64>) -> SourceEntry {
    SourceEntry {
        key: parts
            .as_array()
            .unwrap()
            .iter()
            .map(|p| to_profile(&PortableValue::from_json(p)).unwrap())
            .collect(),
        value: to_profile(&PortableValue::from_json(&value)).unwrap(),
        versionstamp: revision.into(),
        expires_at_ms: expires,
    }
}
fn capture(entries: Vec<SourceEntry>) -> PrivateCapture {
    PrivateCapture {
        v: 1,
        source_git_sha: SOURCE.into(),
        captured_at_ms: 2200,
        entries,
    }
}
fn fixture() -> (PrivateCapture, String) {
    let token = format!("u_{}", "1".repeat(64));
    let hash = sha256_base64url(token.as_bytes());
    let hash_record = json!({"id":"fixture-key","expires_at_ms":-1,"revoked_at_ms":null,"usage_limit_requests":2,"usage_requests":1,"usage_reset_at_ms":3000,"window_ms":1000,"usage_quota_version":3,"paid_fallback_enabled":false,"paid_fallback_limit_microcredits":0,"paid_fallback_spent_microcredits":0,"paid_fallback_reserved_microcredits":0,"paid_fallback_reservation_request_id":null});
    let mut id = hash_record.clone();
    for (k,v) in json!({"name":"Synthetic fixture","prefix":&token[..12],"hash":hash,"created_at_ms":1000,"paid_fallback_model_ids":[],"paid_fallback_quota_per_credit":0,"paid_fallback_max_exposure_microcredits":{},"paid_fallback_pricing_checked_at_ms":null}).as_object().unwrap(){id[k]=v.clone();}
    let window = json!({"v":3,"key_id":"fixture-key","policy_version":"v3:1000","window_start_ms":2000,"window_reset_at_ms":3000,"committed_requests":1,"reserved_requests":1,"updated_at_ms":2100});
    let request = |id: &str, state: &str| json!({"v":3,"key_id":"fixture-key","request_id":id,"route":"responses","state":state,"reserved_at_ms":2000,"lease_expires_at_ms":2100,"provider":if state=="dispatched"{json!("deepseek")}else{Value::Null},"dispatched_at_ms":if state=="dispatched"{json!(2050)}else{Value::Null},"released_at_ms":null,"release_reason":null});
    (
        capture(vec![
            source(
                json!(["ubq_ai", "api_keys", "id", "fixture-key"]),
                id,
                "id-original",
                None,
            ),
            source(
                json!(["ubq_ai", "api_keys", "hash", hash]),
                hash_record,
                "hash-original",
                None,
            ),
            source(
                json!([
                    "uos_ai",
                    "api_key_usage",
                    "v3",
                    "window",
                    "fixture-key",
                    "v3:1000",
                    2000
                ]),
                window,
                "window-original",
                Some(6000),
            ),
            source(
                json!([
                    "uos_ai",
                    "api_key_usage",
                    "v3",
                    "request",
                    "fixture-key",
                    "v3:1000",
                    2000,
                    "old-reserved"
                ]),
                request("old-reserved", "reserved"),
                "reserved-original",
                Some(6000),
            ),
            source(
                json!([
                    "uos_ai",
                    "api_key_usage",
                    "v3",
                    "request",
                    "fixture-key",
                    "v3:1000",
                    2000,
                    "old-dispatched"
                ]),
                request("old-dispatched", "dispatched"),
                "dispatched-original",
                Some(6000),
            ),
            source(
                json!(["uos_ai", "debug_routing", "v1"]),
                json!({"scenario":"codex_429","expires_at_ms":5000,"updated_at_ms":2000}),
                "debug-original",
                Some(5000),
            ),
        ]),
        token,
    )
}
struct Tokens(AtomicU64);
impl gateway_authority::TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "fixture-revision-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
struct Clock;
impl gateway_authority::AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(2300)
    }
}

#[test]
fn actual_sqlite_adoption_restart_auth_admission_mutation_and_latest_inverse() {
    let directory = Directory::new();
    let path = directory.file("one-authority.sqlite3");
    let (original, token) = fixture();
    let prepared = prepare(&original, &CanonicalDates).unwrap();
    let store = SqliteStore::open(&path);
    let receipt = run(adopt_empty(&store, &prepared)).unwrap();
    assert_eq!(receipt.source_rows, 6);
    drop(store);
    let store = SqliteStore::open(&path);
    let policy = run(gateway_auth::api_keys::authenticate(&store, &token, 2300)).unwrap();
    assert_eq!(policy.key_id, "fixture-key");
    let authority =
        gateway_authority::Authority::with_clock(store.clone(), Tokens(AtomicU64::new(1)), Clock);
    assert!(
        run(authority.reserve_api_key(
            &ApiKeyId("fixture-key".into()),
            &RequestId("old-dispatched".into()),
            "responses",
            2300
        ))
        .is_err()
    );
    let consumed = gateway_authority::quota::ApiReservation {
        key_id: ApiKeyId("fixture-key".into()),
        request_id: RequestId("old-dispatched".into()),
        route: "responses".into(),
        policy_version: "v3:1000".into(),
        window_start_ms: 2000,
        window_reset_at_ms: 3000,
        deferred: false,
    };
    assert!(
        !run(authority.release_api_key(&consumed, false, "unknown source transport", 2300))
            .unwrap()
    );
    assert_eq!(
        run(store.read(&gateway_authority::keys::api_request(
            "fixture-key",
            "v3:1000",
            2000,
            "old-dispatched"
        )))
        .unwrap()
        .unwrap()
        .value["state"],
        "dispatched"
    );
    let reservation = run(authority.reserve_api_key(
        &ApiKeyId("fixture-key".into()),
        &RequestId("new-request".into()),
        "responses",
        2300,
    ))
    .unwrap();
    let old = run(store.read(&gateway_authority::keys::api_request(
        "fixture-key",
        "v3:1000",
        2000,
        "old-reserved",
    )))
    .unwrap()
    .unwrap();
    assert_eq!(old.value["state"], "released");
    let current = run(store.read(&gateway_authority::keys::api_request(
        "fixture-key",
        "v3:1000",
        2000,
        "new-request",
    )))
    .unwrap()
    .unwrap();
    assert_eq!(current.value["state"], "reserved");
    assert_eq!(reservation.request_id.0, "new-request");
    drop(authority);
    // Real same-authority write after restart; deleting an adopted row must not resurrect it.
    let debug = key(json!(["uos_ai", "debug_routing", "v1"]));
    let old = run(store.read(&debug)).unwrap().unwrap();
    run(store.commit(AtomicTransition {
        checks: vec![RevisionCheck {
            key: debug.clone(),
            expected_revision: Some(old.revision),
        }],
        mutations: vec![RecordMutation::Delete { key: debug }],
    }))
    .unwrap();
    let exported = run(export_latest(&store, 2300)).unwrap();
    assert!(
        !exported
            .entries
            .iter()
            .any(|e| e.versionstamp == "debug-original")
    );
    let request = exported
        .entries
        .iter()
        .find(|e| e.key.last() == Some(&raw(json!({"type":"string","value":"new-request"}))))
        .unwrap();
    let value = from_profile(&request.value)
        .unwrap()
        .to_json_lossless()
        .unwrap();
    assert_eq!(value["request_id"], "new-request");
    assert!(value.get("transport_started").is_none());
    assert_eq!(request.expires_at_ms, current.expires_at_ms);
    assert_ne!(request.versionstamp, "reserved-original");
    let rollback = SqliteStore::open(&directory.file("inverse-new-destination.sqlite3"));
    let replay = prepare(&exported, &CanonicalDates).unwrap();
    run(adopt_empty(&rollback, &replay)).unwrap();
    assert!(
        run(gateway_auth::api_keys::authenticate(
            &rollback, &token, 2300
        ))
        .is_ok()
    );
    let again = run(export_latest(&rollback, 2300)).unwrap();
    assert_eq!(
        serde_json::to_value(&exported).unwrap(),
        serde_json::to_value(&again).unwrap()
    );
}

#[test]
fn adoption_conflict_never_partially_writes_and_keeps_foreign_state() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("conflict.sqlite3"));
    let (capture, _) = fixture();
    let prepared = prepare(&capture, &CanonicalDates).unwrap();
    let foreign_key = key(json!(["ubq_ai", "api_keys", "id", "fixture-key"]));
    *store.before_commit.borrow_mut() = Some((
        foreign_key.clone(),
        StoredRecord::json("foreign-owner", json!({"preserved":true}), None),
    ));
    assert!(run(adopt_empty(&store, &prepared)).is_err());
    assert_eq!(
        run(store.read(&foreign_key)).unwrap().unwrap().revision,
        "foreign-owner"
    );
    assert!(
        run(store.read(&key(json!(["uos_ai", "migration", "v3", "manifest"]))))
            .unwrap()
            .is_none()
    );
    assert!(
        run(store.read(&gateway_authority::keys::api_policy("fixture-key")))
            .unwrap()
            .is_none()
    );
}

#[test]
fn typed_values_revision_expiry_and_deleted_rows_survive_inverse() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("typed.sqlite3"));
    let value = PortableValue::Map(vec![(
        PortableValue::BigInt("123456789012345678901234567890".into()),
        PortableValue::Set(vec![
            PortableValue::number(-0.0),
            PortableValue::Date {
                epoch_ms: Some(12345),
            },
        ]),
    )]);
    let mut row = source(
        json!(["default", "typed-fixture"]),
        Value::Null,
        "typed-source-revision",
        Some(9900),
    );
    row.value = to_profile(&value).unwrap();
    let input = capture(vec![row]);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    drop(store);
    let store = SqliteStore::open(&directory.file("typed.sqlite3"));
    let result = run(export_latest(&store, 2300)).unwrap();
    assert_eq!(result.entries[0].versionstamp, "typed-source-revision");
    assert_eq!(result.entries[0].expires_at_ms, Some(9900));
    assert_eq!(
        from_profile(&result.entries[0].value).unwrap(),
        from_profile(&input.entries[0].value).unwrap()
    );
}

#[test]
fn wrong_indexes_unknown_state_and_duplicates_refuse_before_writes() {
    let (mut input, _) = fixture();
    let mut bad: Value = input.entries[2].value.deserialize().unwrap();
    bad["value"]["reserved_requests"] = json!({"type":"number","value":2});
    input.entries[2].value = raw(bad);
    assert!(prepare(&input, &CanonicalDates).is_err());
    let (mut input, _) = fixture();
    input.entries.push(input.entries[0].clone());
    assert!(prepare(&input, &CanonicalDates).is_err());
    let input = capture(vec![source(
        json!(["unknown", "arbitrary"]),
        json!({}),
        "x",
        None,
    )]);
    assert!(prepare(&input, &CanonicalDates).is_err());
}

#[test]
fn pending_paid_exposure_and_rollup_marker_survive_restart_and_deferral_inverse() {
    let directory = Directory::new();
    let path = directory.file("paid.sqlite3");
    let attempt = |id: &str, pending: bool| json!({"v":3,"key_id":"fixture-key","request_id":id,"policy_version":"paid:v3","route":"responses","path":"/v1/responses","model":"gpt-fixture","stream":false,"reasoning":null,"provider":"surplus","window_reset_at_ms":3000,"reserved_microcredits":100,"quota_per_credit":1000,"provider_request_id":if pending{Value::Null}else{json!("provider-settled")},"provider_quota":if pending{Value::Null}else{json!(0.05)},"input_tokens":if pending{Value::Null}else{json!(10)},"cached_input_tokens":null,"output_tokens":if pending{Value::Null}else{json!(20)},"dispatch_state":"dispatched","terminal_state":if pending{"ambiguous"}else{"completed"},"spend_microcredits":if pending{Value::Null}else{json!(50)},"billing_state":if pending{"unresolved"}else{"settled"},"reconciliation_attempts":0,"last_reconciliation_at_ms":null,"dispatched_at_ms":2005,"terminal_at_ms":2100,"settled_at_ms":if pending{Value::Null}else{json!(2100)},"created_at_ms":2000,"updated_at_ms":2100,"usage_rollup_at_ms":if pending{Value::Null}else{json!(2100)}});
    let input = capture(vec![
        source(
            json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "window",
                "fixture-key",
                3000
            ]),
            json!({"v":3,"key_id":"fixture-key","policy_version":"paid:v3","window_reset_at_ms":3000,"limit_microcredits":1000,"settled_microcredits":50,"reserved_microcredits":100,"pending_count":1,"updated_at_ms":2100}),
            "paid-window",
            Some(9000),
        ),
        source(
            json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "request",
                "fixture-key",
                "pending-attempt"
            ]),
            attempt("pending-attempt", true),
            "pending-attempt-source",
            Some(9000),
        ),
        source(
            json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "request",
                "fixture-key",
                "settled-attempt"
            ]),
            attempt("settled-attempt", false),
            "settled-attempt-source",
            Some(9000),
        ),
        source(
            json!([
                "uos_ai",
                "paid_fallback",
                "v3",
                "pending",
                "fixture-key",
                "pending-attempt"
            ]),
            json!({"created_at_ms":2000,"next_reconciliation_at_ms":2200}),
            "pending-marker-source",
            None,
        ),
        source(
            json!(["uos_ai", "paid_fallback", "v3", "reconciliation_gate"]),
            json!({"next_due_at_ms":2200}),
            "gate-source",
            None,
        ),
    ]);
    let mut input = input;
    let (keys, _) = fixture();
    input.entries.extend(keys.entries.into_iter().take(2));
    let store = SqliteStore::open(&path);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    let authority =
        gateway_authority::Authority::with_clock(store.clone(), Tokens(AtomicU64::new(1)), Clock);
    let due = run(authority.due_paid(2300, 10)).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].attempt_id.0, "pending-attempt");
    let row = run(store.read(&gateway_authority::keys::paid_attempt(
        "fixture-key",
        "pending-attempt",
    )))
    .unwrap()
    .unwrap();
    let row: gateway_authority::paid::PaidAttempt = serde_json::from_value(row.value).unwrap();
    assert_eq!(row.reservation.request_id.0, "pending-attempt");
    assert_eq!(row.reservation.attempt_id.0, "pending-attempt");
    assert!(row.spend_microcredits.is_none());
    assert!(!row.transport_started);
    assert_eq!(
        run(authority.defer_paid(&row.reservation, 2300)).unwrap(),
        Some(5000)
    );
    let result = run(export_latest(&store, 2300)).unwrap();
    let next = result
        .entries
        .iter()
        .find(|e| {
            e.key.last() == Some(&raw(json!({"type":"string","value":"pending-attempt"})))
                && from_profile(&e.value)
                    .unwrap()
                    .to_json_lossless()
                    .unwrap()
                    .get("billing_state")
                    .is_some()
        })
        .unwrap();
    let next_value = from_profile(&next.value)
        .unwrap()
        .to_json_lossless()
        .unwrap();
    assert_eq!(next_value["billing_state"], "unresolved");
    assert_eq!(next_value["spend_microcredits"], Value::Null);
    assert_eq!(next_value["reconciliation_attempts"], 1);
    assert!(next_value.get("reservation").is_none());
    let settled = result
        .entries
        .iter()
        .find(|e| e.versionstamp == "settled-attempt-source")
        .unwrap();
    assert_eq!(settled.value, input.entries[2].value);
    let rollback = SqliteStore::open(&directory.file("paid-inverse.sqlite3"));
    run(adopt_empty(
        &rollback,
        &prepare(&result, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let next = run(rollback.read(&gateway_authority::keys::paid_pending(
        "fixture-key",
        "pending-attempt",
    )))
    .unwrap()
    .unwrap();
    assert_eq!(next.value["next_reconciliation_at_ms"], 7300);
}

#[test]
fn captured_uint8_catalog_is_usable_after_sqlite_restart_and_inverts_exactly() {
    use gateway_schema::{
        catalog_cache::prepare_catalog,
        catalog_store::{chunk_key, load_catalog, metadata_key},
    };
    let directory = Directory::new();
    let path = directory.file("catalog.sqlite3");
    let catalog = prepare_catalog(
        "0.163.0",
        "auth-fixture",
        "body-fixture",
        r#"{"models":[{"slug":"gpt-fixture","display_name":"Fixture"}]}"#,
        Some("etag-fixture"),
        Some("application/json"),
        2100,
        &Default::default(),
    )
    .unwrap();
    let mut rows = vec![source(
        json!(["ubq_ai", "codex_catalog", "0.163.0"]),
        serde_json::to_value(&catalog.metadata).unwrap(),
        "catalog-meta-source",
        Some(9999),
    )];
    for (is_source, chunks) in [(false, &catalog.chunks), (true, &catalog.source_chunks)] {
        for (index, bytes) in chunks.iter().enumerate() {
            let key = chunk_key("0.163.0", "body-fixture", index, is_source);
            let decoded = gateway_core::tuple_key::TupleKey::from_record_key(&key)
                .unwrap()
                .decoded_parts()
                .unwrap();
            let parts = Value::Array(
                decoded
                    .into_iter()
                    .map(|p| match p {
                        gateway_core::tuple_key::DecodedKeyPart::String(v) => {
                            json!(String::from_utf8(v).unwrap())
                        }
                        gateway_core::tuple_key::DecodedKeyPart::Number(v) => json!(v),
                        _ => panic!("fixture key"),
                    })
                    .collect(),
            );
            let mut row = source(
                parts,
                Value::Null,
                &format!("catalog-chunk-{is_source}-{index}"),
                Some(9999),
            );
            row.value = to_profile(&PortableValue::Binary {
                kind: "Uint8Array".into(),
                bytes: bytes.clone(),
                byte_offset: 0,
                byte_length: bytes.len() as u64,
            })
            .unwrap();
            rows.push(row);
        }
    }
    let input = capture(rows);
    let store = SqliteStore::open(&path);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    let loaded = run(load_catalog(&store, "0.163.0", "auth-fixture", 2300))
        .unwrap()
        .unwrap();
    let parsed: Value = loaded.parsed.deserialize().expect("scalar catalog fixture");
    assert_eq!(parsed["models"][0]["slug"], "gpt-fixture");
    assert!(loaded.source_body.is_some());
    assert!(
        run(load_catalog(
            &store,
            "0.163.0",
            "wrong-current-auth-generation",
            2300
        ))
        .unwrap()
        .is_none()
    );
    let metadata = run(store.read(&metadata_key("0.163.0"))).unwrap().unwrap();
    assert_eq!(metadata.revision, "catalog-meta-source");
    let result = run(export_latest(&store, 2300)).unwrap();
    for original in &input.entries {
        let restored = result
            .entries
            .iter()
            .find(|e| e.key == original.key)
            .unwrap();
        assert_eq!(restored.value, original.value);
        assert_eq!(restored.expires_at_ms, original.expires_at_ms);
        assert_eq!(restored.versionstamp, original.versionstamp);
    }
}

struct AdminHost;
impl gateway_auth::webauthn::WebAuthnCrypto for AdminHost {
    async fn validate_key(
        &self,
        _: &gateway_auth::webauthn::CosePublicKey,
    ) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "not used in fixture",
            "unused_crypto",
        ))
    }
    async fn verify_signature(
        &self,
        _: gateway_auth::webauthn::SignatureInput,
    ) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "not used in fixture",
            "unused_crypto",
        ))
    }
}
impl gateway_auth::AuthHost for AdminHost {
    fn now_ms(&self) -> i64 {
        2300
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        Ok(vec![7; length])
    }
    async fn fetch_auth(
        &self,
        _: gateway_auth::upstream::AuthUpstreamRequest,
    ) -> Result<gateway_auth::upstream::AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "no network in fixture",
            "unused_network",
        ))
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(GatewayError::unavailable("not used", "unused_kernel"))
    }
}
struct Capabilities;
impl gateway_admin_runtime::capabilities::RuntimeCapabilities for Capabilities {}
fn admin_input(body: Value) -> gateway_admin::AdminInput {
    gateway_admin::AdminInput {
        parameter: None,
        query: Default::default(),
        body: gateway_core::source_json::SourceJson::from_serializable(&body).unwrap(),
        actor: gateway_auth::AuthPrincipal {
            token: None,
            method: gateway_auth::AuthMethod::AdminAllowlist,
            is_admin: true,
            is_super_admin: false,
        },
        request_id: "isolated-admin".into(),
        now_ms: 2300,
    }
}
#[test]
fn actual_admin_reads_and_writes_adopted_state_then_inverse_uses_new_revision() {
    use gateway_admin::AdminHost;
    let directory = Directory::new();
    let path = directory.file("admin.sqlite3");
    let (input, _) = fixture();
    let store = SqliteStore::open(&path);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    let host = crate::AdminHost;
    let capabilities = Capabilities;
    let config = gateway_admin_runtime::RuntimeConfig::default();
    let runtime = gateway_admin_runtime::AdminRuntime {
        store: &store,
        host: &host,
        capabilities: &capabilities,
        config: &config,
    };
    let response = run(runtime.execute(
        gateway_admin::AdminOperation::DebugGet,
        admin_input(Value::Null),
    ))
    .unwrap();
    assert_eq!(
        response.body.as_json().unwrap()["routing"]["scenario"],
        "codex_429"
    );
    run(runtime.execute(
        gateway_admin::AdminOperation::DebugSet,
        admin_input(json!({"scenario":"normal","duration_ms":0})),
    ))
    .unwrap();
    let inverse = run(export_latest(&store, 2300)).unwrap();
    let row = inverse
        .entries
        .iter()
        .find(|e| e.key == input.entries[5].key)
        .unwrap();
    assert_ne!(row.versionstamp, "debug-original");
    assert_eq!(
        from_profile(&row.value)
            .unwrap()
            .to_json_lossless()
            .unwrap()["scenario"],
        "normal"
    );
}

#[test]
fn source_date_host_is_explicit_and_nested_values_keep_the_selected_realm() {
    struct RecordedRealm(Value);
    impl SourceDateHost for RecordedRealm {
        fn date_value(&self, input: Option<&Value>) -> Result<Option<i64>, GatewayError> {
            let text = input.and_then(Value::as_str).ok_or_else(|| {
                GatewayError::unavailable(
                    "Date input not in source oracle",
                    "source_date_host_missing",
                )
            })?;
            let row = self.0["dates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["input"] == text)
                .ok_or_else(|| {
                    GatewayError::unavailable(
                        "Date source realm unavailable",
                        "source_date_host_missing",
                    )
                })?;
            Ok(row["epochMs"].as_i64())
        }
    }
    let utc: Value = serde_json::from_str(include_str!("fixtures/normalization-utc.json")).unwrap();
    let ny: Value =
        serde_json::from_str(include_str!("fixtures/normalization-new-york.json")).unwrap();
    let input = json!({"type":"object","value":{"when":{"type":"Array","value":[{"type":"Date","value":"2024-01-02T03:04:05"}]}}});
    assert!(gateway_admin_data::profile::from_profile(&input).is_err());
    let first =
        gateway_admin_data::profile::from_profile_with_host(&input, &RecordedRealm(utc)).unwrap();
    let second =
        gateway_admin_data::profile::from_profile_with_host(&input, &RecordedRealm(ny)).unwrap();
    assert_ne!(first, second);
    let original = from_profile(&to_profile(&first).unwrap()).unwrap();
    assert_eq!(first, original);
}

#[test]
fn source_shaped_routing_capacity_keep_timeout_legacy_probe_and_named_limits_as_data() {
    let directory = Directory::new();
    let path = directory.file("source-routing.sqlite3");
    let routing = json!({"v":2,"updated_at_ms":2100,"banked_reset_legacy_identity_unresolved":true,"slots":[{"account_id_hash":null,"credential_version":"fixture-generation","quota_blocked_until_ms":9000,"quota_block_source":"header_retry_after","quota_blocked_classes":["spark"],"quota_blocks_by_class":{"spark":{"blocked_until_ms":9000,"source":"header_retry_after","legacy_fallback":true,"quota_signal_observed_at_ms":2000,"observed_reset_at_ms":9000,"observed_reset_at_is_stable":false,"banked_reset_generation_ambiguous":true,"banked_reset_recovery_probe_pending":true}},"invalid_credential_version":null,"primary_used_percent":100,"secondary_used_percent":20,"quota_signal_observed_at_ms":2000,"capacity_observed_at_ms":2050,"upstream_timeout_blocked_until_ms":8000,"observed_reset_at_ms":9000,"observed_reset_at_is_stable":false,"banked_reset_generation_ambiguous":true,"banked_reset_recovery_probe_pending":true,"generation":3,"probe_lease":{"token":"fixture-probe","expires_at_ms":7000,"generation":3,"circuit":"upstream_timeout","quota_class":null}}]});
    let capacity = json!({"v":1,"updated_at_ms":2100,"observations":[{"slot":0,"account_id_hash":"fixture-hash","state":"stale","source_observed_at_ms":1990,"snapshot_at_ms":2000,"windows":{"primary":{"limit_window_seconds":18000,"used_percent":100,"reset_at_ms":9000},"secondary":null},"additional_rate_limits":[{"limit_name":"GPT-5.3-Codex-Spark","metered_feature":"spark","windows":{"primary":{"limit_window_seconds":300,"used_percent":23,"reset_at_ms":8000},"secondary":null}}]}]});
    let input = capture(vec![
        source(
            json!(["uos_ai", "codex_account_routing", "v2"]),
            routing.clone(),
            "routing-source",
            None,
        ),
        source(
            json!(["uos_ai", "codex_capacity_routing", "v1", "observations"]),
            capacity.clone(),
            "capacity-source",
            None,
        ),
    ]);
    let store = SqliteStore::open(&path);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    assert_eq!(
        run(store.read(&gateway_authority::keys::routing()))
            .unwrap()
            .unwrap()
            .value,
        routing
    );
    assert_eq!(
        run(store.read(&gateway_authority::keys::capacity()))
            .unwrap()
            .unwrap()
            .value,
        capacity
    );
    // Data adoption never creates an enabled normalized pool or current publication proof.
    assert!(
        run(store.read(&gateway_authority::keys::pool()))
            .unwrap()
            .is_none()
    );
    let result = run(export_latest(&store, 2300)).unwrap();
    for original in &input.entries {
        let actual = result
            .entries
            .iter()
            .find(|e| e.key == original.key)
            .unwrap();
        assert_eq!(actual.value, original.value);
        assert_eq!(actual.versionstamp, original.versionstamp);
    }
}

#[test]
fn reviewed_complete_source_key_inventory_has_no_silent_unknown_omissions() {
    let inventory: Value =
        serde_json::from_str(include_str!("../source-key-inventory.json")).unwrap();
    assert_eq!(inventory["source_git_sha"], SOURCE);
    for family in inventory["families"].as_array().unwrap() {
        let mut parts = vec![family["namespace"].clone()];
        if family["family"] != "*" {
            parts.push(family["family"].clone());
        }
        assert!(
            known_source_family(&parts),
            "unmapped reviewed source family {parts:?}"
        );
    }
    assert!(!known_source_family(&[
        json!("uos_ai"),
        json!("invented_new_authority")
    ]));
}

#[test]
fn identity_sidecars_retain_neither_deleted_session_token_nor_provider_secret() {
    use gateway_core::query::QueryStore;
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("private-sidecars.sqlite3"));
    let token = "synthetic-session-secret-do-not-retain";
    let input = capture(vec![
        source(
            json!(["uos_ai", "auth", "users", "user-fixture"]),
            json!({"id":"user-fixture","handle":"fixture","is_admin":true,"credential_ids":[],"created_at_ms":1000,"updated_at_ms":2000}),
            "user-source",
            None,
        ),
        source(
            json!(["uos_ai", "auth", "handles", "fixture"]),
            json!("user-fixture"),
            "handle-source",
            None,
        ),
        source(
            json!(["uos_ai", "auth", "sessions", token]),
            json!({"token":token,"user_id":"user-fixture","created_at_ms":2000,"expires_at_ms":9000}),
            "session-source",
            Some(9000),
        ),
    ]);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let session = key(json!(["uos_ai", "auth", "sessions", token]));
    let fence = run(gateway_auth::session_index::read_current(
        &store,
        &gateway_auth::session_index::digest(token),
        2300,
    ))
    .unwrap()
    .unwrap();
    assert_eq!(fence.fence.session_revision, "session-source");
    assert_eq!(fence.fence.user_id, "user-fixture");
    run(store.commit(AtomicTransition {
        checks: vec![RevisionCheck {
            key: session.clone(),
            expected_revision: Some("session-source".into()),
        }],
        mutations: vec![
            RecordMutation::Delete { key: session },
            RecordMutation::Delete {
                key: gateway_auth::session_index::index_key(&gateway_auth::session_index::digest(
                    token,
                ))
                .unwrap(),
            },
        ],
    }))
    .unwrap();
    let metadata = run(store.query(gateway_core::query::QueryRequest {
        selector: gateway_core::query::QuerySelector::Prefix {
            prefix: key(json!(["uos_ai", "migration"])),
            start: None,
            end: None,
        },
        reverse: false,
        limit: 100,
        cursor: None,
        now_ms: 2300,
    }))
    .unwrap();
    for row in metadata.entries {
        assert!(!serde_json::to_string(&row.record).unwrap().contains(token));
        assert!(
            !row.key.0.contains(
                &token
                    .bytes()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            )
        );
    }
    let inverse = run(export_latest(&store, 2300)).unwrap();
    assert_eq!(inverse.entries.len(), 2);
    assert!(!serde_json::to_string(&inverse).unwrap().contains(token));
}

#[test]
fn source_kernel_defaults_feed_actual_admission_and_new_org_rows_invert() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("kernel-defaults.sqlite3"));
    let input = capture(vec![
        source(
            json!(["default", "kernel_policy_limit_requests"]),
            json!(1),
            "default-limit",
            None,
        ),
        source(
            json!(["default", "kernel_policy_window_ms"]),
            json!(1000),
            "default-window",
            None,
        ),
    ]);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let authority =
        gateway_authority::Authority::with_clock(store.clone(), Tokens(AtomicU64::new(1)), Clock);
    let reservation = run(authority.reserve_kernel(
        "fixture-owner",
        "fixture-repo",
        &RequestId("one-kernel-request".into()),
        "responses",
        2300,
    ))
    .unwrap();
    assert!(reservation.repo.is_none());
    assert_eq!(
        run(authority.reserve_kernel(
            "fixture-owner",
            "fixture-repo",
            &RequestId("two-kernel-request".into()),
            "responses",
            2300
        ))
        .unwrap_err()
        .status,
        429
    );
    let generated_window = run(store.read(&gateway_authority::keys::kernel_window(
        "fixture-owner",
        None,
    )))
    .unwrap()
    .unwrap();
    let generated = generated_window.json_value().unwrap();
    assert_eq!(generated["reserved_requests"], 1);
    assert_eq!(generated["reservations"].as_object().unwrap().len(), 1);
    let inverse = run(export_latest(&store, 2300)).unwrap();
    let window = inverse
        .entries
        .iter()
        .find(|e| e.key.get(3) == Some(&raw(json!({"type":"string","value":"org_window"}))))
        .unwrap();
    let value = from_profile(&window.value)
        .unwrap()
        .to_json_lossless()
        .unwrap();
    assert_eq!(value["scope"], "org");
    assert!(value.get("repo").is_none());
    assert_eq!(value["reserved_requests"], 1);
    assert!(value.get("reservations").is_none());
    assert_eq!(window.versionstamp, generated_window.revision);
    assert_eq!(window.expires_at_ms, generated_window.expires_at_ms);
    let mut missing_reservation = inverse.clone();
    missing_reservation.entries.retain(|entry| {
        entry.key.get(3) != Some(&raw(json!({"type":"string","value":"org_reservation"})))
    });
    assert!(matches!(
        prepare(&missing_reservation, &CanonicalDates),
        Err(MigrationError::SourceInventory(_))
    ));
    let rollback = SqliteStore::open(&directory.file("kernel-inverse-new.sqlite3"));
    run(adopt_empty(
        &rollback,
        &prepare(&inverse, &CanonicalDates).unwrap(),
    ))
    .unwrap();
}

#[test]
fn identity_mapping_reconstructs_all_source_supported_typed_tuple_parts() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("typed-key.sqlite3"));
    let entry = SourceEntry {
        key: vec![
            json!({"type":"string","value":"default"}),
            json!({"type":"string","value":"typed-key"}),
            json!({"type":"boolean","value":true}),
            json!({"type":"bigint","value":"-123456789012345678901234567890"}),
            json!({"type":"Uint8Array","value":"AAH_AA","byteLength":4}),
            json!({"type":"number","value":"-0"}),
        ]
        .into_iter()
        .map(raw)
        .collect(),
        value: raw(json!({"type":"string","value":"typed tuple payload"})),
        versionstamp: "typed-key-source".into(),
        expires_at_ms: Some(9000),
    };
    let input = capture(vec![entry]);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let output = run(export_latest(&store, 2300)).unwrap();
    let before = gateway_admin_data::profile::normalize_import_line(
        &serde_json::to_string(&input.entries[0]).unwrap(),
    )
    .unwrap()
    .unwrap();
    let after = gateway_admin_data::profile::normalize_import_line(
        &serde_json::to_string(&output.entries[0]).unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(before.key, after.key);
    assert_eq!(before.value, after.value);
    assert_eq!(output.entries[0].versionstamp, "typed-key-source");
}

#[test]
fn a_profile_row_without_explicit_expiry_is_not_a_full_capture() {
    let (capture, _) = fixture();
    let mut json = serde_json::to_value(&capture).unwrap();
    json["entries"][0]
        .as_object_mut()
        .unwrap()
        .remove("expires_at_ms");
    assert!(
        serde_json::from_str::<PrivateCapture>(&serde_json::to_string(&json).unwrap()).is_err()
    );
}

#[test]
fn rust_control_nonce_custody_is_separate_and_source_only_export_cannot_drop_it() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("control-custody.sqlite3"));
    let (input, _) = fixture();
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let nonce = gateway_auth::native_replay::native_nonce_key();
    let nonce_value =
        json!({"v":1,"nonces":{"fixture-key:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA":9000}});
    store.put(
        nonce.clone(),
        StoredRecord::json("current-replay-fence", nonce_value.clone(), None),
    );
    let owner = gateway_authority::keys::paid_control_owner();
    store.put(owner.clone(),StoredRecord::json("current-owner-revision",json!({"v":1,"owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_fingerprint":"f".repeat(64)}),None));
    assert_eq!(
        run(export_latest(&store, 2300)).unwrap_err().code(),
        Some("migration_control_custody_required")
    );
    let context = ArtifactContext {
        rust_git_sha: "a".repeat(40),
        rust_git_tree: "b".repeat(40),
        wasm_sha256: "c".repeat(64),
        native_sha256: "d".repeat(64),
        native_nonce_capture_sha256: Some("e".repeat(64)),
    };
    let bundle = run(export_rollback_bundle(&store, 2300, context)).unwrap();
    assert_eq!(bundle.rust_controls.len(), 2);
    let replay = bundle
        .rust_controls
        .iter()
        .find(|r| r.key == nonce.0)
        .unwrap();
    assert_eq!(replay.record.revision, "current-replay-fence");
    assert_eq!(replay.record.value, nonce_value);
    assert!(replay.record.expires_at_ms.is_none());
    assert!(!bundle.source.entries.iter().any(|e| e.key.get(1)
        == Some(&raw(
            json!({"type":"string","value":"native_nonce_registry"})
        ))));
    // No restore API consumes these rows. Current transport ownership/replay must be reconciled externally.
    let rollback = SqliteStore::open(&directory.file("source-only-new-destination.sqlite3"));
    run(adopt_empty(
        &rollback,
        &prepare(&bundle.source, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    assert!(run(rollback.read(&nonce)).unwrap().is_none());
    assert!(run(rollback.read(&owner)).unwrap().is_none());
}

#[test]
fn inverse_refuses_to_drop_derived_kernel_policy_without_matching_source_defaults() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("kernel-defaults-drift.sqlite3"));
    let input = capture(vec![source(
        json!(["default", "kernel_policy_limit_requests"]),
        json!(1),
        "source-limit",
        None,
    )]);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let key = gateway_authority::keys::kernel_defaults();
    let mut changed = run(store.read(&key)).unwrap().unwrap();
    changed.revision = "independent-runtime-write".into();
    changed.value["usage_limit_requests"] = json!(17);
    store.put(key, changed);
    assert_eq!(
        run(export_latest(&store, 2300)).unwrap_err().code(),
        Some("migration_state_invalid")
    );
    store.put(
        crate::key(json!(["default", "kernel_policy_limit_requests"])),
        StoredRecord::json("matching-current-source", json!(17), None),
    );
    let result = run(export_latest(&store, 2300)).unwrap();
    assert_eq!(
        from_profile(&result.entries[0].value)
            .unwrap()
            .to_json_lossless(),
        Some(json!(17))
    );
    assert_eq!(result.entries[0].versionstamp, "matching-current-source");
}

#[test]
fn inverse_refuses_changed_or_missing_private_mapping_metadata() {
    use gateway_core::query::{QueryRequest, QuerySelector, QueryStore};
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("mapping-integrity.sqlite3"));
    let input = capture(vec![source(
        json!(["default", "fixture"]),
        json!("retained current data"),
        "original",
        None,
    )]);
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let page = run(store.query(QueryRequest {
        selector: QuerySelector::Prefix {
            prefix: key(json!(["uos_ai", "migration", "v3", "row"])),
            start: None,
            end: None,
        },
        reverse: false,
        limit: 10,
        cursor: None,
        now_ms: 2300,
    }))
    .unwrap();
    let mapping = page.entries.first().unwrap();
    let mut corrupt = mapping.record.clone();
    corrupt.value["baseline_digest"] = json!("tampered baseline");
    store.put(mapping.key.clone(), corrupt);
    assert!(run(export_latest(&store, 2300)).is_err());
    store.put(mapping.key.clone(), mapping.record.clone());
    assert!(run(export_latest(&store, 2300)).is_ok());
    run(store.commit(AtomicTransition {
        checks: vec![RevisionCheck {
            key: mapping.key.clone(),
            expected_revision: Some(mapping.record.revision.clone()),
        }],
        mutations: vec![RecordMutation::Delete {
            key: mapping.key.clone(),
        }],
    }))
    .unwrap();
    assert!(run(export_latest(&store, 2300)).is_err());
    assert_eq!(
        run(store.read(&key(json!(["default", "fixture"]))))
            .unwrap()
            .unwrap()
            .value,
        "retained current data"
    );
}
