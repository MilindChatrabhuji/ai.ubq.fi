#![cfg(not(target_arch = "wasm32"))]
//! Source-shaped stopped input exercises M20's real projection/reader/inverse.
//! This does not replace the separately required actual M19 writer fixture.
mod support;
use gateway_admin_data::profile::{CanonicalDates, from_source_profile, to_source_profile};
use gateway_core::{
    js_string::JsString16,
    model::ModelId,
    source_control::{encode_source_control_record, source_json_tree},
    source_json::SourceJson,
    source_serialization as source,
    value::PortableValue,
};
use gateway_migration::*;
use serde_json::{Value, json};
use support::{fixture::*, sqlite_store::*};

fn entry(parts: Value, document: SourceJson) -> SourceEntry {
    SourceEntry {
        key: parts
            .as_array()
            .unwrap()
            .iter()
            .map(|part| to_source_profile(&PortableValue::from_json(part)).unwrap())
            .collect(),
        value: to_source_profile(&source_json_tree(&document).unwrap()).unwrap(),
        versionstamp: "source-paid-control".into(),
        expires_at_ms: None,
    }
}

#[test]
fn latest_paid_projection_preserves_current_model_effort_and_source_only_fields() {
    let mut capture: PrivateCapture =
        serde_json::from_str(include_str!("fixtures/offline-source.json")).unwrap();
    let key_id = "offline-key";
    let attempt_id = "source-model-attempt";
    let finite = json!({"v":3,"key_id":key_id,"request_id":attempt_id,"policy_version":"v3:1000","route":"responses","path":"/v1/responses","stream":false,"window_reset_at_ms":10000,"reserved_microcredits":5,"quota_per_credit":1,"provider":"surplus","provider_request_id":null,"provider_quota":null,"input_tokens":null,"output_tokens":null,"spend_microcredits":null,"dispatch_state":"reserved","terminal_state":"pending","billing_state":"pending","reconciliation_attempts":0,"last_reconciliation_at_ms":null,"dispatched_at_ms":null,"terminal_at_ms":null,"settled_at_ms":null,"created_at_ms":2000,"updated_at_ms":2000,"source_only_fixture_field":"retained"});
    let mut fields = SourceJson::from_serializable(&finite)
        .unwrap()
        .object_entries()
        .unwrap();
    fields.push((
        JsString16::from_utf8("model"),
        SourceJson::parse(r#""\ud800""#).unwrap(),
    ));
    fields.push((
        JsString16::from_utf8("reasoning"),
        SourceJson::parse(r#""\udc00""#).unwrap(),
    ));
    capture.entries.push(entry(
        json!([
            "uos_ai",
            "paid_fallback",
            "v3",
            "request",
            key_id,
            attempt_id
        ]),
        source::object_keys(fields).unwrap(),
    ));
    capture.entries.push(entry(json!(["uos_ai","paid_fallback","v3","window",key_id,10000]), SourceJson::from_serializable(&json!({"v":3,"key_id":key_id,"policy_version":"v3:1000","window_reset_at_ms":10000,"limit_microcredits":100,"settled_microcredits":0,"reserved_microcredits":5,"pending_count":1,"updated_at_ms":2000})).unwrap()));
    capture.entries.push(entry(
        json!([
            "uos_ai",
            "paid_fallback",
            "v3",
            "pending",
            key_id,
            attempt_id
        ]),
        SourceJson::parse(r#"{"created_at_ms":2000,"next_reconciliation_at_ms":2200}"#).unwrap(),
    ));
    let directory = Directory::new();
    let path = directory.file("paid-source.sqlite3");
    let store = SqliteStore::open(&path);
    run(adopt_empty(
        &store,
        &prepare(&capture, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    let key = gateway_authority::keys::paid_attempt(key_id, attempt_id);
    let original = run(gateway_core::state::AuthorityStore::read(&store, &key))
        .unwrap()
        .unwrap();
    let mut current = gateway_authority::paid::decode_paid_attempt_record(&key, &original).unwrap();
    assert_eq!(current.model.as_js_string().as_units(), &[0xd800]);
    assert_eq!(current.reasoning.as_ref().unwrap().as_units(), &[0xdc00]);
    // Controlled post-capture state mutation, not a claim of an M19 writer run.
    current.model = ModelId::from_source(JsString16::from_units(vec![0xdc00]));
    current.reasoning = Some(JsString16::from_units(vec![0xd800]));
    let changed = encode_source_control_record(
        "post-capture-current",
        &SourceJson::from_serializable(&current).unwrap(),
        original.expires_at_ms,
    )
    .unwrap();
    store.put(key.clone(), changed.clone());
    let latest = run(export_latest(&store, 2400)).unwrap();
    let request_key = capture
        .entries
        .iter()
        .find(|row| {
            row.versionstamp == "source-paid-control"
                && from_source_profile(&row.value)
                    .unwrap()
                    .to_source_json()
                    .unwrap()
                    .as_str()
                    .contains("source_only_fixture_field")
        })
        .unwrap()
        .key
        .clone();
    let exported = latest
        .entries
        .iter()
        .find(|row| row.key == request_key)
        .unwrap();
    let document = from_source_profile(&exported.value)
        .unwrap()
        .to_source_json()
        .unwrap();
    assert_eq!(
        source::member(&document, "model")
            .unwrap()
            .deserialize::<JsString16>()
            .unwrap()
            .as_units(),
        &[0xdc00]
    );
    assert_eq!(
        source::member(&document, "reasoning")
            .unwrap()
            .deserialize::<JsString16>()
            .unwrap()
            .as_units(),
        &[0xd800]
    );
    assert_eq!(
        source::member(&document, "source_only_fixture_field")
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
        "retained"
    );
    assert_eq!(exported.versionstamp, "post-capture-current");
    assert_eq!(exported.expires_at_ms, original.expires_at_ms);
    assert_eq!(
        run(gateway_core::state::AuthorityStore::read(&store, &key)).unwrap(),
        Some(changed)
    );
}
