mod support;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use gateway_core::{
    state::{RecordKey, StoredRecord},
    tuple_key::TupleKey,
    value::PortableValue,
};
use gateway_observability::{
    ObservabilityRuntime, incidents::IncidentObservation, replay_model as model,
};
use serde_json::{Value, json};
use support::{Host, Memory, run};
fn key(value: Value) -> RecordKey {
    TupleKey::from_json_parts(value.as_array().unwrap())
        .unwrap()
        .to_record_key()
}
fn row(store: &Memory, key: RecordKey, value: Value, expiry: Option<i64>) {
    store
        .rows
        .borrow_mut()
        .insert(key.0, StoredRecord::json("fixture", value, expiry));
}
fn manifest(at: i64) -> model::Manifest {
    model::Manifest {
        version: 1.0,
        capture_id: "capture-1".into(),
        fingerprint: "a".repeat(64),
        case_group_digest: "b".repeat(64),
        captured_at_ms: at as f64,
        expires_at_ms: (at + model::PAYLOAD_TTL) as f64,
        algorithm: "AES-256-GCM".into(),
        compression: "gzip".into(),
        iv: URL_SAFE_NO_PAD.encode([0; 12]),
        chunk_count: 1.0,
        ciphertext_bytes: 16.0,
        stored_bytes: Some(8192.0),
        request_id: Some("request-1".into()),
    }
}
fn capture(store: &Memory, at: i64) -> model::Manifest {
    let m = manifest(at);
    let mk = model::manifest_key(m.captured_at_ms, &m.fingerprint, &m.capture_id).unwrap();
    let parts = json!([
        "uos_ai",
        "sentinel_replay",
        "v1",
        "manifest",
        at,
        m.fingerprint,
        m.capture_id
    ]);
    row(
        store,
        mk,
        serde_json::to_value(&m).unwrap(),
        Some(at + model::PAYLOAD_TTL),
    );
    row(
        store,
        model::request_key("request-1"),
        json!({"version":1,"request_id":"request-1","status":"ready","reason":null,"captured_at_ms":at,"manifest_key":parts,"fingerprint":m.fingerprint,"expires_at_ms":at+model::PAYLOAD_TTL,"future":{"safe":true}}),
        Some(at + model::STATUS_TTL),
    );
    let mut bytes = vec![255];
    bytes.extend([3; 16]);
    bytes.push(254);
    store.rows.borrow_mut().insert(
        model::chunk_key(&m.capture_id, 0).0,
        StoredRecord::profile_v2(
            "chunk",
            PortableValue::Binary {
                kind: "Uint8Array".into(),
                bytes,
                byte_offset: 1,
                byte_length: 16,
            },
            Some(at + model::PAYLOAD_TTL),
        )
        .unwrap(),
    );
    m
}
#[test]
fn restart_exports_only_frozen_manifest_fields_and_the_actual_binary_view() {
    let store = Memory::default();
    let host = Host::default();
    host.at.set(100);
    let m = capture(&store, 100);
    let runtime = ObservabilityRuntime::new(store.clone(), host.clone());
    let response = run(runtime.export_capture_request("request-1")).unwrap();
    let body: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(
        body["data"][0]["chunks"][0],
        URL_SAFE_NO_PAD.encode([3; 16])
    );
    assert!(body["data"][0]["manifest"].get("stored_bytes").is_none());
    assert!(body["data"][0]["manifest"].get("request_id").is_none());
    assert_eq!(body["capture_status"]["future"]["safe"], true);
    drop(runtime);
    host.at.set(101);
    let runtime = ObservabilityRuntime::new(store.clone(), host);
    assert_eq!(
        run(runtime.export_capture_request("request-1"))
            .unwrap()
            .status,
        200
    );
    store
        .rows
        .borrow_mut()
        .remove(&model::chunk_key(&m.capture_id, 0).0);
    assert_eq!(
        run(runtime.export_capture_request("request-1"))
            .unwrap_err()
            .status,
        503
    );
}
#[test]
fn status_expiry_remains_truthful_and_unknown_has_no_capture() {
    let store = Memory::default();
    let host = Host::default();
    host.at.set(100);
    capture(&store, 100);
    host.at.set(101 + model::PAYLOAD_TTL);
    let runtime = ObservabilityRuntime::new(store, host);
    let response = run(runtime.export_capture_request("request-1")).unwrap();
    let body: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(body["capture_status"]["status"], "expired");
    assert!(body["data"].as_array().unwrap().is_empty());
    let response = run(runtime.export_capture_request("request-absent")).unwrap();
    let body: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(body["capture_status"]["status"], "unknown");
    assert_eq!(
        run(runtime.export_capture_request("not/a/request"))
            .unwrap_err()
            .status,
        400
    );
}
#[test]
fn interval_cursor_is_bounded_and_selector_bound() {
    let store = Memory::default();
    let host = Host::default();
    host.at.set(100);
    capture(&store, 100);
    let runtime = ObservabilityRuntime::new(store, host);
    let response = run(runtime.export_capture_interval(0, 100, None)).unwrap();
    let body: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    let cursor = body["cursor"].as_str().unwrap();
    assert!(model::cursor_shape(cursor));
    assert!(!cursor.contains(':'));
    assert_eq!(
        run(runtime.export_capture_interval(1, 100, Some(cursor)))
            .unwrap_err()
            .status,
        503
    );
    assert_eq!(
        run(runtime.export_capture_interval(-1, 100, None))
            .unwrap_err()
            .status,
        400
    );
    assert_eq!(
        run(runtime.export_capture_interval(0, 100, Some("query-v1:00")))
            .unwrap_err()
            .status,
        400
    );
}
fn observation(at: i64) -> IncidentObservation {
    IncidentObservation {
        endpoint: "/v1/responses?private=yes".into(),
        method: "POST".into(),
        git_sha: "c".repeat(40),
        observed_at_ms: at,
        status: 502,
        stream: true,
        completed: false,
        framing_valid: false,
        terminal_type: Some("secret body".into()),
        provider: Some("deepseek".into()),
        model: Some("contains private text".into()),
        reasoning: Some("max".into()),
        failure_kind: Some("http://private".into()),
    }
}
#[test]
fn safe_incident_group_retries_preserves_first_identity_and_surrogate_extensions() {
    let store = Memory::default();
    let host = Host::default();
    host.at.set(100);
    store.conflicts.set(2);
    let runtime = ObservabilityRuntime::new(store.clone(), host.clone());
    let input = observation(100);
    let expected=gateway_auth::crypto::sha256_hex(br#"{"endpoint":"/v1/responses","method":"POST","status":502,"stream":true,"completed":false,"framing_valid":false,"terminal":"stream_framing"}"#);
    assert_eq!(input.fingerprint().unwrap(), expected);
    let first = run(runtime.record_incident_index(&input)).unwrap();
    let document = gateway_core::source_json::SourceJson::parse(&format!(
        "{},\"future\":{{\"text\":\"\\ud800\"}}}}",
        first
            .record
            .json_value()
            .unwrap()
            .to_string()
            .strip_suffix('}')
            .unwrap()
    ))
    .unwrap();
    let mut fields = Vec::new();
    for (name, value) in document.object_entries().unwrap() {
        let v = if name.try_utf8().unwrap() == "future" {
            PortableValue::Object(vec![(
                "text".into(),
                PortableValue::string_utf16(vec![0xd800]),
            )])
        } else {
            PortableValue::from_json(&value.deserialize::<Value>().unwrap())
        };
        fields.push((name.try_utf8().unwrap(), v));
    }
    store.rows.borrow_mut().insert(
        first.key.0.clone(),
        StoredRecord::profile_v2("extension", PortableValue::Object(fields), None).unwrap(),
    );
    let second = run(runtime.record_incident_index(&observation(90))).unwrap();
    assert_eq!(first.incident_id, second.incident_id);
    let document = second.record.profile_v2_source_json().unwrap();
    assert!(document.as_str().contains("\\ud800"));
    let response = run(runtime.list_incidents(None, None, 20)).unwrap();
    let bytes = response.body.to_bytes().unwrap();
    let text = std::str::from_utf8(&bytes).unwrap();
    assert!(text.contains("\\ud800"));
    assert!(!text.contains("secret body"));
    assert!(!text.contains("private=yes"));
    let mut p = observation(200);
    p.endpoint = "/v1/chat/completions".into();
    run(runtime.record_incident_index(&p)).unwrap();
    let response = run(runtime.list_incidents(Some(&first.incident_id), None, 1)).unwrap();
    let source =
        gateway_core::source_json::SourceJson::parse_bytes(&response.body.to_bytes().unwrap())
            .unwrap();
    let cursor = source
        .object_entries()
        .unwrap()
        .into_iter()
        .find(|(name, _)| name.try_utf8().unwrap() == "cursor")
        .unwrap()
        .1
        .deserialize::<Option<String>>()
        .unwrap();
    assert!(cursor.is_some());
}
#[test]
fn malformed_or_miskeyed_incident_is_never_a_successful_empty_page() {
    let store = Memory::default();
    let host = Host::default();
    host.at.set(100);
    row(
        &store,
        key(json!(["uos_ai", "sentinel_incident", "v1", "index", "bad"])),
        json!({"version":1}),
        None,
    );
    let runtime = ObservabilityRuntime::new(store, host);
    assert_eq!(
        run(runtime.list_incidents(None, None, 20))
            .unwrap_err()
            .status,
        503
    );
    assert_eq!(
        run(runtime.list_incidents(None, None, 0))
            .unwrap_err()
            .status,
        400
    );
}
