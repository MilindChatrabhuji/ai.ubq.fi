#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_admin_data::profile::{CanonicalDates, SourceDateHost, to_source_profile};
use gateway_admin_runtime::capabilities::{
    Context, MigrationImport, MigrationProfile, MigrationRequest,
};
use gateway_auth::{AuthResponse, AuthResponseBody};
use gateway_core::{
    GatewayError,
    state::*,
    value::{PortableValue, ValueEncoding},
};
use gateway_migration::{
    profile_runtime::{ProfileHost, execute_profile},
    *,
};
use serde_json::{Value, json};
use std::cell::Cell;
use support::*;

struct Host(Cell<u64>);
impl SourceDateHost for Host {
    fn date_value(&self, value: Option<&Value>) -> Result<Option<i64>, GatewayError> {
        CanonicalDates.date_value(value)
    }
}
impl ProfileHost for Host {
    fn next_revision(&self) -> Result<String, GatewayError> {
        self.0.set(self.0.get() + 1);
        Ok(format!("profile-test-{}", self.0.get()))
    }
}
fn context() -> Context {
    Context {
        request_id: "profile-runtime-fixture".into(),
        now_ms: 2300,
    }
}
fn request(ndjson: String, dry_run: bool, overwrite: bool) -> MigrationRequest {
    MigrationRequest::Import(MigrationImport {
        ndjson,
        profile: MigrationProfile::Local,
        include_cache: false,
        include_legacy: true,
        overwrite,
        dry_run,
    })
}
fn body(response: AuthResponse) -> Value {
    let AuthResponseBody::Json(value) = response.body else {
        panic!("Expected JSON profile response")
    };
    value
}
fn line(parts: Value, value: Value) -> String {
    let keys = parts
        .as_array()
        .unwrap()
        .iter()
        .map(|v| to_source_profile(&PortableValue::from_json(v)).unwrap())
        .collect::<Vec<_>>();
    let value = to_source_profile(&PortableValue::from_json(&value)).unwrap();
    serde_json::to_string(&json!({"key":keys,"value":value})).unwrap()
}

#[test]
fn source_partial_errors_keep_valid_writes_and_return_422() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("profile.sqlite3"));
    let host = Host(Cell::new(0));
    let ndjson = format!(
        "{}\nnot-json\n",
        line(json!(["default", "model"]), json!("new-model"))
    );
    let response = run(execute_profile(
        &store,
        &host,
        request(ndjson, false, false),
        context(),
    ))
    .unwrap();
    assert_eq!(response.status, 422);
    let result = body(response);
    assert_eq!(result["imported"], 1);
    assert_eq!(result["errors"], 1);
    assert_eq!(
        run(store.read(&gateway_auth::store::key(json!(["default", "model"]))))
            .unwrap()
            .unwrap()
            .json_value()
            .unwrap(),
        "new-model"
    );
}

#[test]
fn dry_run_has_no_revision_or_store_effect_and_null_cas_does_not_overwrite_a_racer() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("dry-run.sqlite3"));
    let host = Host(Cell::new(0));
    let key = gateway_auth::store::key(json!(["default", "model"]));
    let ndjson = line(json!(["default", "model"]), json!("candidate"));
    let result = body(
        run(execute_profile(
            &store,
            &host,
            request(ndjson.clone(), true, false),
            context(),
        ))
        .unwrap(),
    );
    assert_eq!(result["imported"], 1);
    assert_eq!(host.0.get(), 0);
    assert!(run(store.read(&key)).unwrap().is_none());
    store.put(
        key.clone(),
        StoredRecord::json("null-source", Value::Null, None),
    );
    *store.before_commit.borrow_mut() = Some((
        key.clone(),
        StoredRecord::json("racer", json!("preserved"), None),
    ));
    let result = body(
        run(execute_profile(
            &store,
            &host,
            request(ndjson, false, false),
            context(),
        ))
        .unwrap(),
    );
    assert_eq!(result["skipped"], 1);
    assert_eq!(run(store.read(&key)).unwrap().unwrap().revision, "racer");
}

#[test]
fn malformed_import_invalidates_the_derived_policy_in_the_same_commit() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("malformed-policy.sqlite3"));
    let host = Host(Cell::new(0));
    let source: PrivateCapture =
        serde_json::from_str(include_str!("fixtures/offline-source.json")).unwrap();
    run(adopt_empty(
        &store,
        &prepare(&source, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let policy = gateway_authority::keys::api_policy("offline-key");
    assert!(run(store.read(&policy)).unwrap().is_some());
    let key = gateway_auth::api_keys::id_key("offline-key");
    let ndjson = line(
        json!(["ubq_ai", "api_keys", "id", "offline-key"]),
        json!({"id":"offline-key","broken":true}),
    );
    let response = run(execute_profile(
        &store,
        &host,
        request(ndjson, false, true),
        context(),
    ))
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(body(response)["imported"], 1);
    assert_eq!(
        run(store.read(&key))
            .unwrap()
            .unwrap()
            .json_value()
            .unwrap()["broken"],
        true
    );
    assert!(
        run(store.read(&policy)).unwrap().is_none(),
        "No stale dispatch authority may survive malformed source data"
    );
    let validated = body(
        run(execute_profile(
            &store,
            &host,
            MigrationRequest::Validate,
            context(),
        ))
        .unwrap(),
    );
    assert!(
        validated["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().contains("invalid core fields"))
    );
}

#[test]
fn raw_profile_utf16_remains_explicit_and_refresh_bearing_pool_never_enters_common_store() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("typed-profile.sqlite3"));
    let host = Host(Cell::new(0));
    let ndjson=r#"{"key":[{"type":"string","value":"default"},{"type":"string","value":"system_prompt"}],"value":{"type":"string","value":"\ud83d"}}"#.to_owned();
    let response = run(execute_profile(
        &store,
        &host,
        request(ndjson, false, false),
        context(),
    ))
    .unwrap();
    assert_eq!(response.status, 200);
    let value = run(store.read(&gateway_auth::store::key(json!([
        "default",
        "system_prompt"
    ]))))
    .unwrap()
    .unwrap();
    assert_eq!(value.value_encoding, ValueEncoding::ProfileV2);
    let PortableValue::StringUtf16(value) = value.portable_value().unwrap() else {
        panic!("UTF16 codec changed")
    };
    assert_eq!(value.as_units(), [0xd83d]);
    let ndjson = line(
        json!(["ubq_ai", "codex_auth"]),
        json!({"accounts":[{"account_id":"synthetic-account","refresh_token":"synthetic-local-refresh"}]}),
    );
    let response = run(execute_profile(
        &store,
        &host,
        request(ndjson, false, false),
        context(),
    ))
    .unwrap();
    assert_eq!(response.status, 422);
    assert!(
        run(store.read(&gateway_auth::provider_credentials::codex_source_pool_key()))
            .unwrap()
            .is_none()
    );
}
