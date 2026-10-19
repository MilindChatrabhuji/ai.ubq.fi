use gateway_core::{
    claude::ClaudeErrorEvidence,
    js_string::JsString16,
    source_json::SourceJson,
    state::StoredRecord,
    tuple_key::{KeyPart, TupleKey},
    value::{PortableValue, ValueEncoding},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[test]
fn exact_source_sanitizer_and_prefix_vectors_keep_unpaired_units() {
    let source: Value =
        serde_json::from_str(include_str!("fixtures/js-string-source.json")).unwrap();
    for case in source["cases"].as_array().unwrap() {
        let input: Vec<u16> = serde_json::from_value(case["input_units"].clone()).unwrap();
        let expected: Vec<u16> = serde_json::from_value(case["output_units"].clone()).unwrap();
        let actual = JsString16::from_units(input)
            .sanitize_js_whitespace_prefix(240)
            .unwrap();
        assert_eq!(actual.as_units(), expected, "{}", case["name"]);
        assert_eq!(
            actual.to_source_json().unwrap().as_str(),
            case["json"].as_str().unwrap()
        );
    }
    let prefix = JsString16::from_utf8(&format!("{}😀tail", "x".repeat(4095))).prefix_units(4096);
    assert_eq!(
        prefix.as_units().len(),
        source["prefix"]["length"].as_u64().unwrap() as usize
    );
    assert_eq!(
        prefix.as_units().last().copied(),
        Some(source["prefix"]["last_unit"].as_u64().unwrap() as u16)
    );
    assert!(prefix.try_utf8().is_err());
    assert_eq!(
        JsString16::from_utf8("\u{feff} a\t\u{2003}b \n")
            .sanitize_js_whitespace_prefix(240)
            .unwrap()
            .try_utf8()
            .unwrap(),
        "a b"
    );
    assert!(
        JsString16::from_utf8("\t\u{feff} ")
            .sanitize_js_whitespace_prefix(240)
            .is_none()
    );
    assert_eq!(
        JsString16::from_utf8("\u{85}")
            .sanitize_js_whitespace_prefix(240)
            .unwrap()
            .as_units(),
        &[0x85]
    );
}

#[test]
fn every_utf16_unit_and_source_escape_token_round_trip_without_replacement() {
    let all = JsString16::from_units((0..=u16::MAX).collect());
    let encoded = all.to_source_json().unwrap();
    assert_eq!(
        encoded.as_str(),
        include_str!("fixtures/all-code-units-source.txt")
    );
    assert_eq!(encoded.deserialize::<JsString16>().unwrap(), all);
    let cases: Value =
        serde_json::from_str(include_str!("fixtures/js-string-tokens.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let units: Vec<u16> = serde_json::from_value(case["units"].clone()).unwrap();
        let text = JsString16::from_units(units);
        let raw = text.to_source_json().unwrap();
        assert_eq!(raw.as_str(), case["json"].as_str().unwrap());
        assert_eq!(raw.deserialize::<JsString16>().unwrap(), text);
    }
    let literal = JsString16::from_utf8(r"\ud83d");
    let lone = JsString16::from_units(vec![0xd83d]);
    assert_ne!(
        literal.to_source_json().unwrap(),
        lone.to_source_json().unwrap()
    );
    assert!(serde_json::to_value(&lone).is_err());
    assert!(
        SourceJson::parse(r#""\ud83d""#)
            .unwrap()
            .deserialize::<String>()
            .is_err()
    );
}

#[test]
fn profile_v2_preserves_every_arbitrary_string_position_and_rejects_v1_mislabeling() {
    let high = JsString16::from_units(vec![0xd800]);
    let low = JsString16::from_units(vec![0xdc00]);
    let values = vec![
        PortableValue::StringUtf16(high.clone()),
        PortableValue::Object(vec![(
            "message".into(),
            PortableValue::StringUtf16(low.clone()),
        )]),
        PortableValue::ObjectUtf16(vec![(
            high.clone(),
            PortableValue::StringUtf16(low.clone()),
        )]),
        PortableValue::RegExpUtf16 {
            source: high.clone(),
            flags: "giu".into(),
        },
        PortableValue::ErrorUtf16 {
            kind: "TypeError".into(),
            message: low.clone(),
            stack: Some(high.clone()),
            cause: None,
        },
        PortableValue::Map(vec![(
            PortableValue::StringUtf16(high.clone()),
            PortableValue::Set(vec![PortableValue::StringUtf16(low)]),
        )]),
    ];
    for value in values {
        assert!(StoredRecord::profile("old", value.clone(), Some(500)).is_err());
        let record = StoredRecord::profile_v2("revision-1", value.clone(), Some(500)).unwrap();
        let bytes = serde_json::to_vec(&record).unwrap();
        let restarted: StoredRecord = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restarted.value_encoding, ValueEncoding::ProfileV2);
        assert_eq!(restarted.revision, "revision-1");
        assert_eq!(restarted.expires_at_ms, Some(500));
        assert_eq!(restarted.profile_v2_value().unwrap(), value);
        assert!(restarted.json_value().is_err());
        let mislabeled = StoredRecord {
            value_encoding: ValueEncoding::ProfileV1,
            ..restarted
        };
        assert!(mislabeled.validate_version().is_err());
    }
    let duplicate = PortableValue::ObjectUtf16(vec![
        (high.clone(), PortableValue::Null),
        (high.clone(), PortableValue::Null),
    ]);
    assert!(StoredRecord::profile_v2("r", duplicate, None).is_err());
    let cause = PortableValue::ErrorUtf16 {
        kind: "Error".into(),
        message: high,
        stack: None,
        cause: Some(Box::new(PortableValue::Null)),
    };
    assert!(StoredRecord::profile_v2("r", cause, None).is_err());
}

#[derive(Serialize, Deserialize)]
struct ErrorDetail {
    message: JsString16,
}
#[derive(Serialize, Deserialize)]
struct QuotaDetail {
    last_error: ErrorDetail,
    updated_at_ms: i64,
}
#[derive(Deserialize)]
struct ProofOnly {
    pool_proofs: Value,
    updated_at_ms: i64,
}

#[test]
fn restarted_quota_detail_and_unchanged_proof_projection_use_direct_source_json() {
    let message = JsString16::from_units(vec![0xd83d]);
    let proof =
        json!({"model":{"kind":"quota_exhausted","evidence_generation":"g1","expires_at_ms":2000}});
    let value = PortableValue::Object(vec![
        (
            "last_error".into(),
            PortableValue::Object(vec![(
                "message".into(),
                PortableValue::StringUtf16(message.clone()),
            )]),
        ),
        ("updated_at_ms".into(), PortableValue::number(1000.0)),
        ("pool_proofs".into(), PortableValue::from_json(&proof)),
    ]);
    let record = StoredRecord::profile_v2("r", value, Some(9000)).unwrap();
    let restarted: StoredRecord =
        serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
    let output = restarted.profile_v2_source_json().unwrap();
    assert!(!output.as_str().contains("string_utf16"));
    assert!(output.deserialize::<Value>().is_err());
    let detail: QuotaDetail = output.deserialize().unwrap();
    assert_eq!(detail.last_error.message, message);
    assert_eq!(detail.updated_at_ms, 1000);
    let projection: ProofOnly = output.deserialize().unwrap();
    assert_eq!(projection.pool_proofs, proof);
    assert_eq!(projection.updated_at_ms, 1000);
    let public = SourceJson::from_serializable(&detail).unwrap();
    assert_eq!(
        public
            .deserialize::<QuotaDetail>()
            .unwrap()
            .last_error
            .message,
        message
    );
}

#[test]
fn ordered_source_members_and_arrays_keep_non_scalar_keys_and_nested_tokens() {
    let object =
        SourceJson::parse(r#"{"\ud800":["\udc00",{"x":"a\\\"b"}],"same":1,"same":2}"#).unwrap();
    let entries = object.object_entries().unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].0.as_units(), &[0xd800]);
    let items = entries[0].1.array_items().unwrap();
    assert_eq!(
        items[0].deserialize::<JsString16>().unwrap().as_units(),
        &[0xdc00]
    );
    assert_eq!(
        items[1].object_entries().unwrap()[0]
            .1
            .deserialize::<String>()
            .unwrap(),
        "a\\\"b"
    );
    assert_eq!(entries[1].0, entries[2].0);
    assert_eq!(entries[1].1.deserialize::<i32>().unwrap(), 1);
    assert_eq!(entries[2].1.deserialize::<i32>().unwrap(), 2);
    assert!(SourceJson::parse("null").unwrap().object_entries().is_err());
    assert!(SourceJson::parse("{}").unwrap().array_items().is_err());
    #[derive(Deserialize)]
    struct RawEntry {
        key: Vec<SourceJson>,
        value: SourceJson,
    }
    let entry: RawEntry =
        serde_json::from_str(r#"{"key":["\ud800"],"value":{"message":"\udc00"}}"#).unwrap();
    assert_eq!(
        entry.key[0].deserialize::<JsString16>().unwrap().as_units(),
        &[0xd800]
    );
    assert_eq!(
        entry.value.object_entries().unwrap()[0]
            .1
            .deserialize::<JsString16>()
            .unwrap()
            .as_units(),
        &[0xdc00]
    );
}

#[test]
fn malformed_json_invalid_units_and_non_json_typed_values_fail_closed() {
    for text in [
        r#""\uQQQQ""#,
        r#""unterminated"#,
        r#""\ud800" extra"#,
        "[1,]",
        r#"{"x":1,}"#,
    ] {
        assert!(SourceJson::parse(text).is_err());
    }
    assert!(
        SourceJson::parse("12")
            .unwrap()
            .deserialize::<JsString16>()
            .is_err()
    );
    for units in [json!([-1]), json!([65536]), json!([1.5]), json!("literal")] {
        let malformed = StoredRecord {
            schema_version: 1,
            value_encoding: ValueEncoding::ProfileV2,
            revision: "r".into(),
            value: json!({"type":"string_utf16","value":units}),
            expires_at_ms: None,
        };
        assert!(malformed.validate_version().is_err());
    }
    for value in [
        PortableValue::Undefined,
        PortableValue::number(f64::NAN),
        PortableValue::number(-0.0),
        PortableValue::BigInt("1".into()),
    ] {
        assert!(value.to_source_json().is_err());
    }
    let tag = json!({"type":"string_utf16","value":[55357]});
    let json_record = StoredRecord::json("r", tag.clone(), None);
    assert_eq!(json_record.json_value().unwrap(), &tag);
    assert!(json_record.profile_v2_value().is_err());
    let v1 = StoredRecord::profile("r", PortableValue::String("ordinary".into()), None).unwrap();
    assert!(v1.profile_v2_value().is_err());
}

#[test]
fn finite_error_evidence_is_data_not_a_deserializable_or_accepted_proof() {
    let evidence = ClaudeErrorEvidence::from_prefix(Some(vec![0xd800; 4096]), true).unwrap();
    assert_eq!(evidence.prefix().unwrap().len(), 4096);
    assert!(evidence.complete());
    assert!(ClaudeErrorEvidence::from_prefix(Some(vec![0; 4097]), true).is_err());
    assert!(
        ClaudeErrorEvidence::from_prefix(None, false)
            .unwrap()
            .prefix()
            .is_none()
    );
    assert!(!format!("{evidence:?}").contains("55296"));
}

#[test]
fn source_key_adapter_matches_pinned_text_encoder_without_changing_values() {
    let cases: Value = serde_json::from_str(include_str!("fixtures/js-string-keys.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let units: Vec<u16> = serde_json::from_value(case["units"].clone()).unwrap();
        let expected: Vec<u8> = serde_json::from_value(case["bytes"].clone()).unwrap();
        let key = TupleKey::from_parts(&[KeyPart::source_string_utf16(&units)]).unwrap();
        assert_eq!(key.sort_bytes(), expected.as_slice());
        let value = JsString16::from_units(units.clone());
        assert_eq!(value.as_units(), units);
        assert_eq!(
            value
                .to_source_json()
                .unwrap()
                .deserialize::<JsString16>()
                .unwrap(),
            value
        );
    }
    let key = TupleKey::from_parts(&[KeyPart::source_string_utf16(&[0xd800])]).unwrap();
    let replacement = TupleKey::from_parts(&[KeyPart::String("\u{fffd}".into())]).unwrap();
    assert_eq!(key, replacement);
    assert!(JsString16::from_units(vec![0xd800]).try_utf8().is_err());
}
