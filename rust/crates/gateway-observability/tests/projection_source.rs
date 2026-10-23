mod support;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::QueryStore,
    source_control::encode_source_control_record,
    source_json::SourceJson,
    source_serialization as source,
    source_usage::extract_usage_tokens,
    state::{RecordKey, StoredRecord},
    tuple_key::{KeyPart, TupleKey},
    value::{PortableValue, ValueEncoding},
};
use gateway_observability::{
    ObservabilityRuntime, ledger::terminal_rollup::TerminalUsageRollup,
    records::usage_rollup_record_source, types::ObservabilityHost,
};
use gateway_observability_test_support::source_fixture::{
    CapturedCollator, assert_source_eq, fixture,
};
use gateway_schema::aliases::SourceStringCollator;
use serde_json::{Value, json};
use std::sync::Arc;
use support::{Host, Memory, run};
struct ProjectionHost {
    base: Host,
    collator: Arc<dyn SourceStringCollator>,
}
impl ObservabilityHost for ProjectionHost {
    fn source_string_collator(&self) -> Arc<dyn SourceStringCollator> {
        self.collator.clone()
    }
    fn now_ms(&self) -> i64 {
        self.base.now_ms()
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        self.base.random_bytes(length)
    }
    async fn wait_ms(&self, ms: u32) -> Result<(), GatewayError> {
        self.base.wait_ms(ms).await
    }
    async fn metered_balance_fingerprint(&self) -> Result<Option<String>, GatewayError> {
        Ok(Some("projection-fixture".into()))
    }
    async fn metered_quota_snapshot(
        &self,
        _force: bool,
        _deadline: i64,
    ) -> Result<Option<Value>, GatewayError> {
        Ok(None)
    }
}
fn host(now: i64) -> ProjectionHost {
    let base = Host::default();
    base.at.set(now);
    ProjectionHost {
        collator: base.source_string_collator(),
        base,
    }
}
fn units(row: &SourceJson, name: &str) -> Vec<u16> {
    source::member(row, name)
        .unwrap()
        .deserialize::<JsString16>()
        .unwrap()
        .into_units()
}
fn response_source(response: &gateway_auth::AuthResponse) -> SourceJson {
    SourceJson::parse_bytes(&response.body.to_bytes().unwrap()).unwrap()
}
fn model_rows(body: &SourceJson) -> Vec<SourceJson> {
    source::member(body, "models")
        .unwrap()
        .array_items()
        .unwrap()
}
fn write<S: QueryStore, H: ObservabilityHost>(
    runtime: &ObservabilityRuntime<S, H>,
    model: &JsString16,
    request: &str,
) {
    let usage = extract_usage_tokens(Some(
        &json!({"input_tokens":10,"output_tokens":3,"input_tokens_details":{"cached_tokens":2}}),
    ))
    .unwrap();
    assert!(
        run(runtime.record_terminal_usage_rollup(TerminalUsageRollup {
            model: Some(model),
            provider: Some(" chatgpt_codex "),
            request_id: request,
            request_created_at_ms: Some(1000.9),
            usage: Some(&usage)
        }))
        .unwrap()
    );
}
#[test]
fn actual_terminal_writer_first_label_profile_survives_named_reader_restart_and_response_bytes() {
    let memory = Memory::default();
    let runtime = ObservabilityRuntime::new(memory.clone(), host(1000));
    for label in [vec![0xfeff, 0xd800, 32], vec![0xdc00], vec![0xfffd]] {
        write(&runtime, &JsString16::from_units(label), "same-shard");
    }
    let (key, before) = {
        let rows = memory.rows.borrow();
        assert_eq!(rows.len(), 1);
        let (key, row) = rows.iter().next().unwrap();
        (key.clone(), row.clone())
    };
    assert_eq!(before.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(before.expires_at_ms, None);
    let restored: StoredRecord =
        serde_json::from_slice(&serde_json::to_vec(&before).unwrap()).unwrap();
    memory.rows.borrow_mut().insert(key.clone(), restored);
    let runtime = ObservabilityRuntime::new(memory.clone(), host(1000));
    let rows = run(runtime.paid_usage_rollups(0, 1000)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(units(&rows[0], "model"), [0xd800]);
    let response = run(runtime.quota_projection_response(30, 365)).unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.headers["cache-control"], "no-store");
    assert!(response.body.as_json().is_none());
    let wire = response.body.to_bytes().unwrap();
    assert!(serde_json::from_slice::<Value>(&wire).is_err());
    let body = response_source(&response);
    let models = model_rows(&body);
    assert_eq!(models.len(), 1);
    assert_eq!(units(&models[0], "model"), [0xd800]);
    assert_eq!(
        units(&models[0], "provider"),
        "chatgpt_codex".encode_utf16().collect::<Vec<_>>()
    );
    let usage = source::member(&models[0], "usage")
        .unwrap()
        .array_items()
        .unwrap();
    assert_eq!(
        source::number(&source::member(&usage[0], "request_count").unwrap()),
        Some(3.0)
    );
    assert_eq!(
        source::number(&source::member(&usage[0], "input_tokens").unwrap()),
        Some(30.0)
    );
    assert!(
        source::member(&models[0], "estimates")
            .unwrap()
            .array_items()
            .unwrap()
            .is_empty()
    );
    assert_eq!(memory.rows.borrow().get(&key), Some(&before));
    println!(
        "M41_TERMINAL_PROJECTION_WIRE_FIXTURE={}",
        serde_json::to_string(&(key, before, wire)).unwrap()
    );
}
fn key(bucket: i64, model: &JsString16, provider: &JsString16, shard: u8) -> RecordKey {
    TupleKey::from_parts(&[
        KeyPart::String("uos_ai".into()),
        KeyPart::String("paid_fallback".into()),
        KeyPart::String("v3".into()),
        KeyPart::String("usage_rollup".into()),
        KeyPart::Number(bucket as f64),
        KeyPart::source_string_utf16(model.as_units()),
        KeyPart::source_string_utf16(provider.as_units()),
        KeyPart::Number(f64::from(shard)),
    ])
    .unwrap()
    .to_record_key()
}
#[test]
fn named_reader_skips_bad_shape_codec_and_expired_rows_but_keeps_scan_failure_unknown() {
    let memory = Memory::default();
    let runtime = ObservabilityRuntime::new(memory.clone(), host(1000));
    write(
        &runtime,
        &JsString16::from_units(vec![0xd800]),
        "same-shard",
    );
    write(&runtime, &JsString16::from_utf8("expired"), "expired");
    let expired = {
        let rows = memory.rows.borrow();
        rows.iter()
            .find_map(|(key, row)| {
                (units(&usage_rollup_record_source(row).unwrap(), "model")
                    == "expired".encode_utf16().collect::<Vec<_>>())
                .then_some(key.clone())
            })
            .unwrap()
    };
    memory
        .rows
        .borrow_mut()
        .get_mut(&expired)
        .unwrap()
        .expires_at_ms = Some(999);
    let bad = key(0, &"bad".into(), &"custom".into(), 0);
    memory.rows.borrow_mut().insert(
        bad.0,
        StoredRecord::json("bad-shape", json!({"v":999}), None),
    );
    let bad = key(0, &"bad-codec".into(), &"custom".into(), 0);
    memory.rows.borrow_mut().insert(
        bad.0,
        StoredRecord::profile("bad-codec", PortableValue::Null, None).unwrap(),
    );
    let rows = run(runtime.paid_usage_rollups(0, 1000)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(units(&rows[0], "model"), [0xd800]);
    assert_eq!(memory.rows.borrow()[&expired].expires_at_ms, Some(999));
    let body = response_source(&run(runtime.quota_projection_response(30, 365)).unwrap());
    assert_eq!(
        source::member(&body, "rollup_scan")
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
        "ok"
    );
    assert_eq!(model_rows(&body).len(), 1);
    memory.unavailable.set(true);
    let body = response_source(&run(runtime.quota_projection_response(30, 365)).unwrap());
    assert_eq!(
        source::member(&body, "rollup_scan")
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
        "unavailable"
    );
    assert_eq!(
        source::member(&body, "balance_history_scan")
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
        "unavailable"
    );
    assert!(model_rows(&body).is_empty());
}
#[test]
fn source_reader_and_projection_preserve_all_oracle_labels_without_global_value_interpretation() {
    let data = fixture();
    let rows = source::member(&data, "rows")
        .unwrap()
        .array_items()
        .unwrap();
    let now = source::member(&data, "now")
        .unwrap()
        .deserialize::<i64>()
        .unwrap();
    let memory = Memory::default();
    for (i, row) in rows.iter().enumerate() {
        let model = row_field(row, "model");
        let provider = row_field(row, "provider");
        let bucket = source::member(row, "bucket_start_at_ms")
            .unwrap()
            .deserialize::<i64>()
            .unwrap();
        let key = key(bucket, &model, &provider, 0);
        memory.rows.borrow_mut().insert(
            key.0,
            encode_source_control_record(format!("fixture-{i}"), row, None).unwrap(),
        );
    }
    let mut host = host(now);
    host.collator = Arc::new(CapturedCollator::new());
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    let read = run(runtime.paid_usage_rollups(now - 30 * 86400000, now)).unwrap();
    assert_eq!(read.len(), rows.len());
    let response = run(runtime.quota_projection_response(30, 7)).unwrap();
    let actual = response_source(&response);
    let expected = source::member(&data, "expected").unwrap();
    // Compare whole source model outputs; numeric engine/source oracle prove the same labels,
    // windows and unknown-provider behavior, with no Value roundtrip.
    assert_source_eq(
        &source::member(&actual, "models").unwrap(),
        &source::member(&expected, "models").unwrap(),
    );
}
fn row_field(row: &SourceJson, name: &str) -> JsString16 {
    source::member(row, name).unwrap().deserialize().unwrap()
}
