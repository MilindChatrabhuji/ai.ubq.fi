#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_admin_data::profile::{CanonicalDates, to_source_profile};
use gateway_core::{
    source_control::decode_source_control_record,
    source_json::SourceJson,
    state::{AuthorityStore, RecordKey, StoredRecord},
    tuple_key::TupleKey,
    value::PortableValue,
};
use gateway_migration::*;
use serde_json::{Value, json};
use support::{fixture::*, sqlite_store::*};

fn key(kind: &str, reference: &str) -> RecordKey {
    gateway_auth::store::key(json!([
        "uos_ai",
        "authority",
        "native_owner_renewal",
        "v1",
        kind,
        reference
    ]))
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
fn native() -> NativeCapture {
    serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap()
}
fn action(version: u8) -> Value {
    let hash = "a".repeat(64);
    let principal = "passkey-user:fixture-user-😀";
    let mut row = json!({
        "v":version,"kind":"codex_auth",
        "metadata":{"v":1,"operation_id":"fixture-import","action_ref":hash},
        "target":{"kind":"existing_account","account_id_hash":"b".repeat(64)},
        "actor":{"v":1,"principal":principal,"scope":"admin","config_digest":"c".repeat(64),
            "owner_revision":"owner-before","config_revision":"config-before","runtime_revision":null,
            "source_valid_until_ms":null,"source":{"kind":"session","digest":"d".repeat(64),
                "index_revision":"index-before","session_revision":"session-before","user_id":"fixture-user-😀",
                "user_revision":"user-before","expires_at_ms":9000}},
        "context":{"request_id":"fixture-request-😀","principal":principal,"key_id":null,
            "route":"native-import","started_at_ms":2200},
        "created_at_ms":2200,"deadline_ms":47200,
        "facts":{"owner_id":"owner-😀","owner_epoch":"epoch","native_owner_id":"native-owner-😀", "slot":0,
            "account_id_hash":"b".repeat(64),"credential_version":"c".repeat(64),
            "access_generation":"d".repeat(64),"source_native_generation":"e".repeat(64),
            "owner_revision":"owner-before","source_revision":"source-before","normalized_revision":"pool-before",
            "runtime_revision":null,"control_checks_digest":"f".repeat(64),
            "account_digests":["1".repeat(64)],"checks_digest":"2".repeat(64)}
    });
    if version == 1 {
        row["facts"] = json!({"owner_id":"owner-😀","owner_epoch":"epoch","native_owner_id":"native-owner-😀",
            "slot":0,"account_id_hash":"b".repeat(64),"credential_version":"c".repeat(64),
            "native_generation":"e".repeat(64),"checks_digest":"2".repeat(64)});
    }
    if version == 3 {
        row["publication"] = Value::Null;
    }
    row
}
fn generation(action: &Value) -> RecordKey {
    let hash = gateway_auth::crypto::sha256_hex(
        &serde_json::to_vec(&(
            "uos-native-renewal-generation-v1",
            &action["facts"]["native_owner_id"],
            &action["facts"]["account_id_hash"],
            &action["facts"]["source_native_generation"],
        ))
        .unwrap(),
    );
    key("generation", &hash)
}
fn rows(case: &str) -> Vec<(RecordKey, StoredRecord)> {
    let version = match case {
        "v1" => 1,
        "v2" => 2,
        _ => 3,
    };
    let mut action = action(version);
    let mut values = vec![];
    let revision = if matches!(case, "normalized" | "limited") {
        "published-😀"
    } else {
        "retained-😀"
    };
    if matches!(case, "normalized" | "limited") {
        let normalized = case == "normalized";
        action["publication"] = json!({"v":1,"operation_id":"fixture-import","claim_ref":"fixture-claim",
            "publication_revision":revision,"native_receipt_ref":"native-receipt-😀",
            "native_source_generation":"3".repeat(64),"access_generation":"4".repeat(64),
            "credential_version":"5".repeat(64),"source_revision":revision,"normalized_revision":revision,
            "catalog_revision":if normalized {Some(revision)} else {None},
            "runtime_revision":if normalized {Some(revision)} else {None},
            "auth_generation_revision":if normalized {Some(revision)} else {None},
            "paid_control_config_revision":if normalized {Some(revision)} else {None},
            "publication_request_digest":"6".repeat(64),
            "catalog_disposition":if normalized {json!({"kind":"normalized","client_version":"0.163.0","upstream_status":200})}
                else {json!({"kind":"authenticated_limited","upstream_status":429})}});
        let terminal = json!({"publication_revision":revision,"source_revision":revision,"normalized_revision":revision,
            "native_source_generation":"3".repeat(64),"access_generation":"4".repeat(64),
            "credential_version":"5".repeat(64),"publication_request_digest":"6".repeat(64)});
        values.push((key("operation", "fixture-import"), json!({"v":1,"action_ref":"a".repeat(64),
            "operation_id":"fixture-import","request_digest":"7".repeat(64),"claim_ref":"fixture-claim",
            "start_digest":"8".repeat(64),"phase":"published","publication_revision":revision,
            "native_source_generation":"3".repeat(64),"access_generation":"4".repeat(64),"terminal":terminal})));
        values.push((
            generation(&action),
            json!({"v":1,"operation_id":"fixture-import","claim_ref":"fixture-claim",
            "publication_revision":revision,"terminal":terminal}),
        ));
    }
    values.insert(0, (key("action", &"a".repeat(64)), action));
    values
        .into_iter()
        .map(|(key, value)| {
            let record = if case == "normalized" && key == self::key("action", &"a".repeat(64)) {
                StoredRecord::profile_v2(revision, PortableValue::from_json(&value), None).unwrap()
            } else {
                StoredRecord::json(revision, value, None)
            };
            (key, record)
        })
        .collect()
}
fn seed(store: &SqliteStore, rows: &[(RecordKey, StoredRecord)]) {
    for (key, record) in rows {
        store.put(key.clone(), record.clone());
    }
}

#[test]
fn exact_v1_v2_v3_null_normalized_and_limited_survive_real_restart_latest_inverse() {
    for case in ["v1", "v2", "null", "normalized", "limited"] {
        let directory = Directory::new();
        let path = directory.file("native-custody.sqlite3");
        let store = SqliteStore::open(&path);
        run(adopt_empty(&store, &prepare_native(&native()).unwrap())).unwrap();
        let before = run(export_native_latest(&store, 2400)).unwrap();
        let expected = rows(case);
        seed(&store, &expected);
        drop(store);
        let store = SqliteStore::open(&path);
        assert_eq!(
            run(export_native_latest(&store, 2400)).unwrap_err().code(),
            Some("migration_control_custody_required")
        );
        let bundle = run(export_native_rollback_bundle(&store, 2400, context())).unwrap();
        assert_eq!(
            SourceJson::from_serializable(&bundle.source).unwrap(),
            SourceJson::from_serializable(&before).unwrap(),
            "{case}"
        );
        for (key, record) in &expected {
            let retained = bundle
                .rust_controls
                .iter()
                .find(|row| row.key == key.0)
                .unwrap();
            assert_eq!(retained.record, *record, "{case}");
            assert_eq!(
                TupleKey::from_record_key(&RecordKey(retained.key.clone()))
                    .unwrap()
                    .sort_bytes(),
                TupleKey::from_record_key(key).unwrap().sort_bytes()
            );
            assert_eq!(run(store.read(key)).unwrap(), Some(record.clone()));
        }
        let serialized = serde_json::to_string(&bundle.rust_controls).unwrap();
        for forbidden in [
            "refresh_token",
            "original_body_digest",
            "native_document_digest",
        ] {
            assert!(!serialized.contains(forbidden));
        }
        let restore = SqliteStore::open(&directory.file("inverse-source.sqlite3"));
        run(adopt_empty(
            &restore,
            &prepare_native(&bundle.source).unwrap(),
        ))
        .unwrap();
        assert_eq!(
            SourceJson::from_serializable(&run(export_native_latest(&restore, 2400)).unwrap())
                .unwrap(),
            SourceJson::from_serializable(&bundle.source).unwrap()
        );
        assert!(
            expected
                .iter()
                .all(|(key, _)| run(restore.read(key)).unwrap().is_none()),
            "private DATA is not restored as authority"
        );
    }
}

#[test]
fn both_source_capture_adapters_refuse_private_import_data_without_changing_source() {
    for case in ["v1", "v2", "null", "normalized", "limited"] {
        let (key, record) = rows(case).remove(0);
        let value: Value = decode_source_control_record(&record)
            .unwrap()
            .deserialize()
            .unwrap();
        let path = json!([
            "uos_ai",
            "authority",
            "native_owner_renewal",
            "v1",
            "action",
            "a".repeat(64)
        ]);
        let private = PrivateCapture {
            v: 1,
            source_git_sha: "a".repeat(40),
            captured_at_ms: 2300,
            entries: vec![SourceEntry {
                key: path
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|part| to_source_profile(&PortableValue::from_json(part)).unwrap())
                    .collect(),
                value: to_source_profile(&PortableValue::from_json(&value)).unwrap(),
                versionstamp: record.revision,
                expires_at_ms: None,
            }],
        };
        assert!(prepare(&private, &CanonicalDates).is_err());
        let mut input = native();
        input.entries.push(NativeEntry {
            raw_key: TupleKey::from_record_key(&key)
                .unwrap()
                .sort_bytes()
                .to_vec(),
            value: NativeValue::Bytes(b"private-control-data".to_vec()),
            revision: input.data_revision.clone(),
            expiration_ms: -1,
        });
        assert!(
            prepare_native(&input).is_err(),
            "{case}: raw private key is never source adoption"
        );
    }
}

#[test]
fn missing_nullable_unknown_fields_and_terminal_pair_mismatches_refuse_without_writes() {
    for changed in [
        "publication_missing",
        "catalog_revision_missing",
        "runtime_revision_missing",
        "auth_generation_revision_missing",
        "paid_control_config_revision_missing",
        "v1_publication",
        "v2_publication",
        "unknown",
        "publication_unknown",
        "disposition_unknown",
        "operation_missing",
        "generation_missing",
        "operation_claim",
        "operation_action",
        "generation_claim",
        "generation_digest",
        "publication_digest",
        "operation_revision",
        "null_operation",
        "null_generation",
        "expiry",
    ] {
        let directory = Directory::new();
        let store = SqliteStore::open(&directory.file("refusal.sqlite3"));
        let input: PrivateCapture =
            serde_json::from_str(include_str!("fixtures/offline-source.json")).unwrap();
        run(adopt_empty(
            &store,
            &prepare(&input, &CanonicalDates).unwrap(),
        ))
        .unwrap();
        let mut fixture = rows("limited");
        match changed {
            "publication_missing" => {
                fixture[0]
                    .1
                    .value
                    .as_object_mut()
                    .unwrap()
                    .remove("publication");
            }
            name if name.ends_with("_revision_missing") => {
                fixture[0].1.value["publication"]
                    .as_object_mut()
                    .unwrap()
                    .remove(name.strip_suffix("_missing").unwrap());
            }
            "v1_publication" | "v2_publication" => {
                fixture = rows(if changed == "v1_publication" {
                    "v1"
                } else {
                    "v2"
                });
                fixture[0].1.value["publication"] = Value::Null;
            }
            "unknown" => fixture[0].1.value["unknown"] = json!(true),
            "publication_unknown" => fixture[0].1.value["publication"]["unknown"] = json!(true),
            "disposition_unknown" => {
                fixture[0].1.value["publication"]["catalog_disposition"]["unknown"] = json!(true)
            }
            "operation_missing" => {
                fixture.remove(1);
            }
            "generation_missing" => {
                fixture.remove(2);
            }
            "operation_claim" => fixture[1].1.value["claim_ref"] = json!("other"),
            "operation_action" => fixture[1].1.value["action_ref"] = json!("9".repeat(64)),
            "generation_claim" => fixture[2].1.value["claim_ref"] = json!("other"),
            "generation_digest" => {
                fixture[2].1.value["terminal"]["publication_request_digest"] = json!("9".repeat(64))
            }
            "publication_digest" => {
                fixture[0].1.value["publication"]["publication_request_digest"] =
                    json!("9".repeat(64))
            }
            "operation_revision" => fixture[1].1.revision = "foreign-same-bytes".into(),
            "null_operation" => fixture[0].1.value["publication"] = Value::Null,
            "null_generation" => {
                fixture[0].1.value["publication"] = Value::Null;
                fixture.remove(1);
            }
            _ => fixture[0].1.expires_at_ms = Some(9000),
        }
        seed(&store, &fixture);
        assert!(
            run(export_rollback_bundle(&store, 2400, context())).is_err(),
            "{changed}"
        );
        for (key, record) in &fixture {
            assert_eq!(
                run(store.read(key)).unwrap(),
                Some(record.clone()),
                "{changed}"
            );
        }
    }
}

#[test]
fn unfinished_v3_does_not_require_missing_rows_or_reject_unrelated_generation_history() {
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("unfinished.sqlite3"));
    let input: PrivateCapture =
        serde_json::from_str(include_str!("fixtures/offline-source.json")).unwrap();
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let fixture = rows("null");
    seed(&store, &fixture);
    assert!(run(export_rollback_bundle(&store, 2400, context())).is_ok());
    let mut prior = rows("limited").remove(2);
    prior.1.value["operation_id"] = json!("different-retained-operation");
    store.put(prior.0, prior.1);
    assert!(run(export_rollback_bundle(&store, 2400, context())).is_ok());
}

#[test]
fn valid_legacy_renewal_utf16_models_are_untouched_by_v3_terminal_dispatch() {
    use gateway_authority::native_control::{
        NativeRenewalContext, NativeRenewalFence, validate_native_control_custody,
    };
    use gateway_core::{
        js_string::JsString16, model::ModelId, source_control::encode_source_control_record,
        source_serialization as source,
    };
    #[derive(serde::Serialize)]
    struct LegacyRenewalData {
        v: u8,
        action_ref: String,
        actor: Value,
        created_at_ms: i64,
        deadline_ms: i64,
        fence: NativeRenewalFence,
        checks_digest: String,
        control_checks_digest: String,
        account_digests: Vec<String>,
        operation_id: Option<String>,
    }
    // These are the existing renewal_v2::native_action_source_custody_is_lossless_data
    // vectors, carried by the actual ModelId/NativeRenewalContext types.
    for units in [
        vec![0xd800],
        vec![0xdc00],
        "fixture-model".encode_utf16().collect(),
        vec![0xfffd],
        vec![0xd83d, 0xde80],
        vec![0, 10, 34, 92],
        r"\ud800".encode_utf16().collect(),
        vec![u16::from(b'm'); 4097],
    ] {
        let fence = NativeRenewalFence {
            v: 2,
            owner_id: "fixture-owner".into(),
            owner_epoch: "fixture-epoch".into(),
            owner_revision: "owner-before".into(),
            native_owner_id: "native-owner".into(),
            source_revision: "source-before".into(),
            normalized_revision: "normalized-before".into(),
            account_id_hash: "b".repeat(64),
            credential_version: "c".repeat(64),
            source_native_generation: "d".repeat(64),
            access_generation: "e".repeat(64),
            access_expires_at_ms: None,
            native_refreshed_at: None,
            principal: "passkey-user:fixture-user-😀".into(),
            principal_policy_digest: "f".repeat(64),
            original_request_id: "source-custody-request".into(),
            context: NativeRenewalContext::Inference {
                attempt_id: "source-custody-attempt".into(),
                original_admission_digest: "f".repeat(64),
                model: ModelId::from_source(JsString16::from_units(units.clone())),
                slot: 0,
            },
        };
        let reference = gateway_auth::crypto::sha256_hex(
            &serde_json::to_vec(&(
                "uos-native-renewal-action-v2",
                &fence.original_request_id,
                &fence.context,
                &fence.source_native_generation,
            ))
            .unwrap(),
        );
        let document = SourceJson::from_serializable(&LegacyRenewalData {
            v: 2,
            action_ref: reference.clone(),
            actor: action(2)["actor"].clone(),
            created_at_ms: 2200,
            deadline_ms: 47200,
            fence,
            checks_digest: "1".repeat(64),
            control_checks_digest: "2".repeat(64),
            account_digests: vec!["3".repeat(64)],
            operation_id: None,
        })
        .unwrap();
        let control_key = key("action", &reference);
        let record =
            encode_source_control_record("legacy-model-revision", &document, None).unwrap();
        validate_native_control_custody(&control_key, &record)
            .expect("actual existing renewal schema must accept the source model before export");
        println!("VALID_EXISTING_RENEWAL_SCHEMA_BEFORE_REAL_EXPORT");
        let directory = Directory::new();
        let path = directory.file("legacy-model.sqlite3");
        let store = SqliteStore::open(&path);
        let input: PrivateCapture =
            serde_json::from_str(include_str!("fixtures/offline-source.json")).unwrap();
        run(adopt_empty(
            &store,
            &prepare(&input, &CanonicalDates).unwrap(),
        ))
        .unwrap();
        store.put(control_key.clone(), record.clone());
        drop(store);
        let store = SqliteStore::open(&path);
        let bundle = run(export_rollback_bundle(&store, 2400, context())).expect(
            "real exporter must preserve valid legacy source models without scalar projection",
        );
        let retained = bundle
            .rust_controls
            .iter()
            .find(|row| row.key == control_key.0)
            .unwrap();
        assert_eq!(retained.record, record);
        let reopened = decode_source_control_record(&retained.record).unwrap();
        let fence = source::member(&reopened, "fence").unwrap();
        let context = source::member(&fence, "context").unwrap();
        let model: ModelId = source::member(&context, "model")
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(model.as_js_string().as_units(), units);
    }
}
