mod support;
use gateway_core::{
    js_string::JsString16,
    source_control::encode_source_control_record,
    source_json::SourceJson,
    source_serialization as source,
    source_usage::extract_usage_tokens,
    state::{RecordKey, StoredRecord},
    tuple_key::{DecodedKeyPart, TupleKey},
    value::{PortableValue, ValueEncoding},
};
use gateway_observability::{
    ObservabilityRuntime,
    ledger::terminal_rollup::TerminalUsageRollup,
    records::{usage_rollup_record_source, valid_usage_rollup_source},
};
use serde_json::json;
use support::{Host, Memory, run};
fn units(value: &SourceJson, name: &str) -> Vec<u16> {
    source::member(value, name)
        .unwrap()
        .deserialize::<JsString16>()
        .unwrap()
        .into_units()
}
#[test]
fn actual_terminal_writer_preserves_first_source_label_on_usv_key_collisions_and_restart() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let usage = extract_usage_tokens(Some(
        &json!({"input_tokens":10,"output_tokens":3,"input_tokens_details":{"cached_tokens":2}}),
    ))
    .unwrap();
    for model in [vec![0xfeff, 0xd800, 32], vec![0xdc00], vec![0xfffd]] {
        let model = JsString16::from_units(model);
        let runtime = ObservabilityRuntime::new(memory.clone(), host.clone());
        assert!(
            run(runtime.record_terminal_usage_rollup(TerminalUsageRollup {
                model: Some(&model),
                provider: Some(" chatgpt_codex "),
                request_id: "same-shard",
                request_created_at_ms: Some(1000.9),
                usage: Some(&usage)
            }))
            .unwrap()
        );
    }
    let rows = memory.rows.borrow();
    assert_eq!(rows.len(), 1);
    let (key, record) = rows.iter().next().unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(record.expires_at_ms, None);
    let restored: StoredRecord =
        serde_json::from_slice(&serde_json::to_vec(record).unwrap()).unwrap();
    let value = usage_rollup_record_source(&restored).unwrap();
    assert_eq!(units(&value, "model"), [0xd800]);
    for (field, expected) in [
        ("request_count", 3.0),
        ("input_tokens", 30.0),
        ("cached_input_tokens", 6.0),
        ("output_tokens", 9.0),
        ("quota_sum", 0.0),
        ("spend_microcredits", 0.0),
    ] {
        assert_eq!(
            source::number(&source::member(&value, field).unwrap()),
            Some(expected),
            "{field}"
        );
    }
    let parts = TupleKey::from_record_key(&RecordKey(key.clone()))
        .unwrap()
        .decoded_parts()
        .unwrap();
    let DecodedKeyPart::String(model_key) = &parts[5] else {
        panic!("actual model tuple slot")
    };
    assert_eq!(model_key, "�".as_bytes());
    println!(
        "M39_TERMINAL_WRITER_FIXTURE={}",
        json!({"family":"paid_usage_rollup_v1","rows":rows.iter().map(|(key,record)|json!({"key":key,"record":record})).collect::<Vec<_>>()})
    );
}
#[test]
fn astral_and_literal_escape_models_remain_distinct_and_scalar_rows_stay_json() {
    let memory = Memory::default();
    let host = Host::default();
    host.at.set(1000);
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    let usage = extract_usage_tokens(Some(&json!({"input_tokens":1,"output_tokens":1}))).unwrap();
    for model in [
        JsString16::from_units(vec![0xd800]),
        JsString16::from_utf8(r"\ud800"),
        JsString16::from_utf8("astral😀"),
    ] {
        assert!(
            run(runtime.record_terminal_usage_rollup(TerminalUsageRollup {
                model: Some(&model),
                provider: Some("chatgpt_codex"),
                request_id: "same-shard",
                request_created_at_ms: None,
                usage: Some(&usage)
            }))
            .unwrap()
        );
    }
    assert_eq!(memory.rows.borrow().len(), 3);
    let mut values = memory
        .rows
        .borrow()
        .values()
        .map(|record| {
            (
                units(&usage_rollup_record_source(record).unwrap(), "model"),
                record.value_encoding,
            )
        })
        .collect::<Vec<_>>();
    values.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(values.contains(&(vec![0xd800], ValueEncoding::ProfileV2)));
    assert!(values.contains(&(r"\ud800".encode_utf16().collect(), ValueEncoding::Json)));
    assert!(values.contains(&("astral😀".encode_utf16().collect(), ValueEncoding::Json)));
}
#[test]
fn named_rollup_reader_has_one_source_validator_and_rejects_wrong_codec_or_shape() {
    let doc=SourceJson::parse(r#"{"v":1.0,"bucket_start_at_ms":0,"model":"\ud800","provider":"chatgpt_codex","request_count":1,"quota_sum":0.5,"input_tokens":1,"cached_input_tokens":0,"output_tokens":2,"spend_microcredits":0.25,"first_request_at_ms":0,"last_request_at_ms":1,"updated_at_ms":1000}"#).unwrap();
    assert!(valid_usage_rollup_source(&doc));
    let record = encode_source_control_record("source-revision", &doc, Some(i64::MAX)).unwrap();
    let before = record.clone();
    assert_eq!(
        units(&usage_rollup_record_source(&record).unwrap(), "model"),
        [0xd800]
    );
    assert_eq!(record, before);
    let mut fields = doc.object_entries().unwrap();
    fields.retain(|(key, _)| key.try_utf8().ok().as_deref() != Some("model"));
    let missing = source::object_keys(fields).unwrap();
    assert!(!valid_usage_rollup_source(&missing));
    assert!(
        usage_rollup_record_source(&encode_source_control_record("r", &missing, None).unwrap())
            .is_err()
    );
    let wrong = StoredRecord::profile("old-codec", PortableValue::Null, None).unwrap();
    assert!(usage_rollup_record_source(&wrong).is_err());
    let wrong = StoredRecord::profile_v2("non-json", PortableValue::Map(vec![]), None).unwrap();
    assert!(usage_rollup_record_source(&wrong).is_err());
}
