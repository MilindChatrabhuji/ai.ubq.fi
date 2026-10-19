#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_admin_data::profile::{CanonicalDates, to_source_profile};
use gateway_core::{state::*, value::PortableValue};
use gateway_migration::*;
use serde_json::{Value, json};
use support::*;

fn source(parts: Value, value: Value) -> SourceEntry {
    SourceEntry {
        key: parts
            .as_array()
            .unwrap()
            .iter()
            .map(|v| to_source_profile(&PortableValue::from_json(v)).unwrap())
            .collect(),
        value: to_source_profile(&PortableValue::from_json(&value)).unwrap(),
        versionstamp: "source-control-fixture".into(),
        expires_at_ms: None,
    }
}
fn context() -> ArtifactContext {
    ArtifactContext {
        rust_git_sha: "a".repeat(40),
        rust_git_tree: "b".repeat(40),
        wasm_sha256: "c".repeat(64),
        native_sha256: "d".repeat(64),
        native_nonce_capture_sha256: None,
    }
}

#[test]
fn permanent_manual_source_intent_survives_restart_and_latest_inverse() {
    let directory = Directory::new();
    let path = directory.file("manual-intent.sqlite3");
    let store = SqliteStore::open(&path);
    let account = "a".repeat(64);
    let value = json!({"v":1,"account_id_hash":account,"credential_version":"b".repeat(64),"quota_reset_at_ms":5000,"routing_generation":1,"created_at_ms":2200,"promoted_at_ms":null,"quota_signal_at_ms":null});
    let row = source(
        json!(["uos_ai", "codex_manual_reset", "v1", account]),
        value.clone(),
    );
    let capture = PrivateCapture {
        v: 1,
        source_git_sha: "6d4d4790a7c06514b92938ff677dbfd52764461d".into(),
        captured_at_ms: 2300,
        entries: vec![row.clone()],
    };
    run(adopt_empty(
        &store,
        &prepare(&capture, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    let exported = run(export_latest(&store, 2400)).unwrap();
    assert_eq!(exported.entries.len(), 1);
    assert_eq!(exported.entries[0].value, row.value);
    assert_eq!(exported.entries[0].expires_at_ms, None);
    let mut invalid = capture;
    invalid.entries[0].expires_at_ms = Some(9000);
    assert!(prepare(&invalid, &CanonicalDates).is_err());
}

#[test]
fn native_live_connection_is_private_no_ttl_custody_and_cannot_be_adopted_as_source() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("live-custody.sqlite3"));
    let capture: PrivateCapture =
        serde_json::from_str(include_str!("fixtures/offline-source.json")).unwrap();
    run(adopt_empty(
        &store,
        &prepare(&capture, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let reference = "a".repeat(64);
    let parts = json!(["uos_ai", "native_live", "v1", "connection", reference]);
    let key = gateway_auth::store::key(parts.clone());
    let value = json!({"v":1,"action_ref":"b".repeat(64),"connection_id":reference,"authorization_ref":"c".repeat(64),"owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_fingerprint":"d".repeat(64),"call_id":"fixture-call","created_at_ms":2200,"upstream_status":null,"retired":false});
    store.put(
        key.clone(),
        StoredRecord::json("live-connection-current", value.clone(), None),
    );
    assert!(run(export_latest(&store, 2400)).is_err());
    let bundle = run(export_rollback_bundle(&store, 2400, context())).unwrap();
    assert!(
        bundle
            .rust_controls
            .iter()
            .any(|r| r.key == key.0 && r.record.json_value().unwrap() == &value)
    );
    assert!(
        bundle
            .source
            .entries
            .iter()
            .all(|r| r.key != source(parts.clone(), Value::Null).key)
    );
    let mut forged = capture;
    forged.entries.push(source(parts, value.clone()));
    assert!(prepare(&forged, &CanonicalDates).is_err());
    store.put(
        key,
        StoredRecord::json("live-connection-expiring", value, Some(9000)),
    );
    assert!(run(export_rollback_bundle(&store, 2400, context())).is_err());
}

#[test]
fn native_generation_and_unknown_operation_remain_private_across_restart() {
    let directory = Directory::new();
    let path = directory.file("native-control-custody.sqlite3");
    let store = SqliteStore::open(&path);
    let capture: PrivateCapture =
        serde_json::from_str(include_str!("fixtures/offline-source.json")).unwrap();
    run(adopt_empty(
        &store,
        &prepare(&capture, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let generation = gateway_auth::store::key(json!([
        "uos_ai",
        "authority",
        "native_owner_renewal",
        "v1",
        "generation",
        "a".repeat(64)
    ]));
    let operation = gateway_auth::store::key(json!([
        "uos_ai",
        "authority",
        "native_owner_renewal",
        "v1",
        "operation",
        "fixture-operation"
    ]));
    let rows = [
        (
            generation.clone(),
            json!({"v":1,"operation_id":"fixture-operation","claim_ref":"fixture-claim","publication_revision":null,"terminal":null}),
        ),
        (
            operation,
            json!({"v":1,"action_ref":"b".repeat(64),"operation_id":"fixture-operation","request_digest":"c".repeat(64),"claim_ref":"fixture-claim","start_digest":"d".repeat(64),"phase":"unknown","publication_revision":null,"native_source_generation":null,"access_generation":null,"terminal":null}),
        ),
    ];
    for (key, value) in &rows {
        store.put(
            key.clone(),
            StoredRecord::json("current-control-revision", value.clone(), None),
        );
    }
    drop(store);
    let store = SqliteStore::open(&path);
    assert!(run(export_latest(&store, 2400)).is_err());
    let bundle = run(export_rollback_bundle(&store, 2400, context())).unwrap();
    for (key, value) in &rows {
        let preserved = bundle
            .rust_controls
            .iter()
            .find(|r| r.key == key.0)
            .unwrap();
        assert_eq!(preserved.record.json_value().unwrap(), value);
        assert_eq!(preserved.record.expires_at_ms, None);
        assert_eq!(preserved.record.revision, "current-control-revision");
    }
    let unchanged = run(store.read(&generation)).unwrap().unwrap();
    store.put(
        generation.clone(),
        StoredRecord::json("expiring-control", rows[0].1.clone(), Some(9000)),
    );
    assert!(run(export_rollback_bundle(&store, 2400, context())).is_err());
    let mut stale = rows[0].1.clone();
    stale["v"] = json!(2);
    store.put(
        generation.clone(),
        StoredRecord::json("stale-control", stale, None),
    );
    assert!(run(export_rollback_bundle(&store, 2400, context())).is_err());
    store.put(generation.clone(), unchanged.clone());
    assert_eq!(run(store.read(&generation)).unwrap(), Some(unchanged));
    assert!(run(export_rollback_bundle(&store, 2400, context())).is_ok());
}
