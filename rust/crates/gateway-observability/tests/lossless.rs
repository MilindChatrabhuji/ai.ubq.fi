mod support;
use gateway_admin_runtime::capabilities::{AnalyticsRequest, Context};
use gateway_core::{
    js_string::JsString16,
    lifecycle::DeliveryOutcome,
    source_json::SourceJson,
    state::StoredRecord,
    tuple_key::{DecodedKeyPart, TupleKey},
    value::{PortableValue, ValueEncoding},
};
use gateway_observability::{
    ObservabilityRuntime, ledger::ErrorObservation, records::record_source_json,
};
use serde_json::{Value, json};
use support::{Host, Memory, run};
fn field(value: &SourceJson, name: &str) -> SourceJson {
    value
        .object_entries()
        .unwrap()
        .into_iter()
        .find(|(key, _)| key.try_utf8().ok().as_deref() == Some(name))
        .unwrap()
        .1
}
fn units(value: &SourceJson, name: &str) -> Vec<u16> {
    field(value, name)
        .deserialize::<JsString16>()
        .unwrap()
        .into_units()
}
#[test]
fn split_surrogate_model_survives_cas_update_restart_and_actual_raw_response_bytes() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock.clone());
    let model = format!("{}😀", "a".repeat(119));
    run(runtime.record_request_log(
        "fixture-key",
        &json!({"id":"fixture-request","route":"responses","created_at_ms":1000,"model":model}),
    ))
    .unwrap();
    assert_eq!(
        memory.rows.borrow().values().next().unwrap().value_encoding,
        ValueEncoding::ProfileV2
    );
    run(runtime.update_request_log(
        "fixture-key",
        1000,
        "fixture-request",
        &json!({"status_code":503}),
    ))
    .unwrap();
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    let rows = run(runtime.request_logs("fixture-key", 20)).unwrap();
    let model = units(&rows[0], "model");
    assert_eq!(model.len(), 120);
    assert_eq!(model[119], 0xd83d);
    assert!(rows[0].deserialize::<Value>().is_err());
    let response = run(runtime.analytics(
        AnalyticsRequest::PaidHistory {
            key_id: "fixture-key".into(),
            limit: 20,
        },
        Context {
            request_id: "admin-fixture".into(),
            now_ms: 1000,
        },
    ))
    .unwrap();
    assert!(response.body.as_json().is_none());
    let bytes = response.body.to_bytes().unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.contains("\\ud83d"));
    assert!(!text.contains("\\\\ud83d"));
    let document = SourceJson::parse_bytes(&bytes).unwrap();
    let data = field(&document, "data").array_items().unwrap();
    assert_eq!(units(&data[0], "model"), model);
}
#[test]
fn source_tuple_uses_usv_key_bytes_while_the_logical_request_id_keeps_its_units() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    let id = format!("{}😀", "a".repeat(119));
    run(runtime.record_request_log(
        "fixture-key",
        &json!({"id":id,"route":"responses","created_at_ms":1000}),
    ))
    .unwrap();
    let row = memory
        .rows
        .borrow()
        .iter()
        .next()
        .map(|(key, value)| (key.clone(), value.clone()))
        .unwrap();
    let parts = TupleKey::from_record_key(&gateway_core::state::RecordKey(row.0))
        .unwrap()
        .decoded_parts()
        .unwrap();
    let DecodedKeyPart::String(bytes) = parts.last().unwrap() else {
        panic!("source string key")
    };
    assert!(bytes.ends_with("�".as_bytes()));
    let document = record_source_json(&row.1).unwrap();
    let id = units(&document, "id");
    assert_eq!(id.len(), 120);
    assert_eq!(id[119], 0xd83d);
}
#[test]
fn error_terminal_and_failure_use_profile_v2_without_changing_other_record_encodings() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    let observation = ErrorObservation {
        request_id: "fixture-error".into(),
        route: "responses".into(),
        status: 502,
        provider: "surplus".into(),
        model: None,
        reasoning: None,
        stream: Some(false),
        terminal_type: Some(format!("{}😀", "t".repeat(159))),
        failure_kind: Some(format!("{}😀", "f".repeat(159))),
        delivery_outcome: DeliveryOutcome::Unobserved,
        created_at_ms: 1000,
        latency_ms: 10,
        git_sha: Some("a".repeat(40)),
        deno_revision: Some("fixture-release".into()),
    };
    assert!(run(runtime.record_admin_error(&observation)).unwrap());
    let row = memory.rows.borrow().values().next().unwrap().clone();
    assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
    assert!(row.json_value().is_err());
    let document = record_source_json(&row).unwrap();
    for name in ["terminal_type", "failure_kind"] {
        let text = units(&document, name);
        assert_eq!(text.len(), 160);
        assert_eq!(text[159], 0xd83d)
    }
    memory.rows.borrow_mut().clear();
    run(runtime.record_request_log(
        "fixture-key",
        &json!({"id":"scalar-request","route":"responses","created_at_ms":1000,"model":"scalar"}),
    ))
    .unwrap();
    assert_eq!(
        memory.rows.borrow().values().next().unwrap().value_encoding,
        ValueEncoding::Json
    );
}
#[test]
fn a_profile_v1_record_is_never_guessed_or_rewritten_as_a_source_record() {
    let row = StoredRecord::profile(
        "fixture",
        PortableValue::String("private-profile".into()),
        None,
    )
    .unwrap();
    assert!(record_source_json(&row).is_err());
    assert_eq!(row.value_encoding, ValueEncoding::ProfileV1);
}
#[test]
fn source_created_time_signed_zero_keeps_two_distinct_tuple_keys() {
    let memory = Memory::default();
    let clock = Host::default();
    clock.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), clock);
    for created in [0.0, -0.0] {
        run(runtime.record_request_log(
            "fixture-key",
            &json!({"id":"same-id","created_at_ms":created,"route":"responses"}),
        ))
        .unwrap();
    }
    assert_eq!(memory.rows.borrow().len(), 2);
    let mut signs = Vec::new();
    for (key, record) in memory.rows.borrow().iter() {
        let parts = TupleKey::from_record_key(&gateway_core::state::RecordKey(key.clone()))
            .unwrap()
            .decoded_parts()
            .unwrap();
        let DecodedKeyPart::Number(created) = parts[4] else {
            panic!("source timestamp")
        };
        signs.push(created.is_sign_negative());
        assert_eq!(
            record.expires_at_ms,
            Some(gateway_observability::ledger::REQUEST_RETENTION_MS)
        );
    }
    signs.sort();
    assert_eq!(signs, vec![false, true]);
}
