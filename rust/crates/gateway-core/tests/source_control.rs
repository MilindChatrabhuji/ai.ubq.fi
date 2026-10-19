use gateway_core::{
    identity::MAX_SAFE_INTEGER,
    js_string::JsString16,
    model::ModelId,
    source_control::{
        decode_source_control_record, encode_source_control_record, source_json_tree,
    },
    source_json::SourceJson,
    source_serialization as source,
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use serde_json::json;
use std::collections::BTreeSet;

#[test]
fn model_is_only_data_and_retains_distinct_utf16_and_ordinary_wire() {
    let units = [
        vec![0xd800],
        vec![0xdc00],
        vec![0xfffd],
        vec![0xd83d, 0xde00],
        r"\ud800".encode_utf16().collect(),
    ];
    let mut distinct = BTreeSet::new();
    for units in units {
        let model = ModelId::from_source(JsString16::from_units(units.clone()));
        let wire = serde_json::to_string(&model).unwrap();
        assert!(wire.starts_with('"'));
        let decoded: ModelId = serde_json::from_str(&wire).unwrap();
        assert_eq!(decoded.as_js_string().as_units(), units);
        assert_eq!(
            model
                .to_source_json()
                .unwrap()
                .deserialize::<ModelId>()
                .unwrap(),
            model
        );
        assert!(distinct.insert(model));
    }
    assert_eq!(distinct.len(), 5);
    let model = ModelId::from_scalar("  gpt-test  ");
    assert!(model.matches_scalar("  gpt-test  "));
    assert!(!model.matches_scalar("gpt-test"));
    assert_eq!(serde_json::to_string(&model).unwrap(), r#""  gpt-test  ""#);
    assert!(ModelId::from_scalar("").matches_scalar(""));
    assert_eq!(
        ModelId::from("scalar".to_owned()).into_js_string(),
        JsString16::from_utf8("scalar")
    );
}

#[test]
fn model_refuses_nonstring_wire_without_accepting_a_tag_or_literal_escape_substitute() {
    for raw in ["null", "1", "[]", "{}", r#"{"model":"x"}"#] {
        assert!(serde_json::from_str::<ModelId>(raw).is_err());
    }
    let lone: ModelId = serde_json::from_str(r#""\ud800""#).unwrap();
    let literal: ModelId = serde_json::from_str(r#""\\ud800""#).unwrap();
    assert_ne!(lone, literal);
    assert!(!lone.matches_scalar(r"\ud800"));
}

#[test]
fn scalar_records_keep_the_existing_json_shape_bytes_revision_and_expiry() {
    let value = json!({"v":3,"model":"gpt-test","reasoning":"new-tier","nested":[null,true,7,1.25],"absent":null});
    let document = SourceJson::from_serializable(&value).unwrap();
    let actual =
        encode_source_control_record("revision-one", &document, Some(MAX_SAFE_INTEGER)).unwrap();
    let prior = StoredRecord::json("revision-one", value, Some(MAX_SAFE_INTEGER));
    assert_eq!(actual, prior);
    assert_eq!(
        serde_json::to_vec(&actual).unwrap(),
        serde_json::to_vec(&prior).unwrap()
    );
    assert_eq!(
        decode_source_control_record(&actual)
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap(),
        prior.value
    );
    let before = actual.clone();
    decode_source_control_record(&actual).unwrap();
    assert_eq!(actual, before);
}

#[test]
fn nested_models_efforts_and_object_keys_use_explicit_profile_without_unit_loss() {
    let original=SourceJson::parse(r#"{"\ud800":{"items":[{"model":"\udfff","effort":"tier-\ud800"}],"scalar":1.5,"zero":-0},"\ufffd":"replacement","literal":"\\ud800"}"#).unwrap();
    let record = encode_source_control_record("revision-two", &original, Some(123456789)).unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(record.revision, "revision-two");
    assert_eq!(record.expires_at_ms, Some(123456789));
    let before = record.clone();
    let decoded = decode_source_control_record(&record).unwrap();
    let fields = decoded.object_entries().unwrap();
    assert_eq!(fields[0].0.as_units(), [0xd800]);
    assert_eq!(fields[1].0.as_units(), [0xfffd]);
    let items = source::member(&fields[0].1, "items")
        .unwrap()
        .array_items()
        .unwrap();
    assert_eq!(
        source::member(&items[0], "model")
            .unwrap()
            .deserialize::<ModelId>()
            .unwrap()
            .as_js_string()
            .as_units(),
        [0xdfff]
    );
    assert_eq!(
        source::member(&items[0], "effort")
            .unwrap()
            .deserialize::<JsString16>()
            .unwrap()
            .as_units(),
        [116, 105, 101, 114, 45, 0xd800]
    );
    assert_eq!(
        source::member(&decoded, "literal")
            .unwrap()
            .deserialize::<JsString16>()
            .unwrap(),
        JsString16::from_utf8(r"\ud800")
    );
    let zero = source::member(&fields[0].1, "zero").unwrap();
    assert_eq!(
        source::number(&zero).unwrap().to_bits(),
        (-0.0_f64).to_bits()
    );
    assert_eq!(record, before);
}

#[test]
fn negative_zero_is_preserved_in_both_record_encodings_without_canonicalization() {
    let original = SourceJson::parse("-0").unwrap();
    assert_eq!(original.as_str(), "-0");
    assert_eq!(source::canonical(&original).unwrap().as_str(), "0");
    let record = encode_source_control_record("negative-zero", &original, None).unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::Json);
    assert_eq!(
        record.value.as_f64().unwrap().to_bits(),
        (-0.0_f64).to_bits()
    );
    assert_eq!(
        source::number(&decode_source_control_record(&record).unwrap())
            .unwrap()
            .to_bits(),
        (-0.0_f64).to_bits()
    );
    assert_eq!(
        source_json_tree(&original)
            .unwrap()
            .number_value()
            .unwrap()
            .to_bits(),
        (-0.0_f64).to_bits()
    );
}

#[test]
fn source_object_duplicate_values_use_existing_source_key_identity() {
    let document = SourceJson::parse(r#"{"x":0,"\ud800":1,"x":2,"\ufffd":3}"#).unwrap();
    let record = encode_source_control_record("duplicates", &document, None).unwrap();
    let decoded = decode_source_control_record(&record).unwrap();
    let fields = decoded.object_entries().unwrap();
    assert_eq!(fields.len(), 3);
    assert_eq!(fields[0].0, JsString16::from_utf8("x"));
    assert_eq!(source::number(&fields[0].1), Some(2.0));
    assert_ne!(fields[1].0, fields[2].0);
}

#[test]
fn profile_integer_fields_still_decode_into_the_actual_typed_dto() {
    #[derive(serde::Deserialize)]
    struct Control {
        v: u32,
        model: ModelId,
        effort: JsString16,
        counter: i64,
        fraction: f64,
    }
    let source = SourceJson::parse(
        r#"{"v":3,"model":"\ud800","effort":"\udfff","counter":42,"fraction":1.0}"#,
    )
    .unwrap();
    let record = encode_source_control_record("typed-fields", &source, None).unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::ProfileV2);
    let typed: Control = decode_source_control_record(&record)
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(typed.v, 3);
    assert_eq!(typed.model.as_js_string().as_units(), [0xd800]);
    assert_eq!(typed.effort.as_units(), [0xdfff]);
    assert_eq!(typed.counter, 42);
    assert_eq!(typed.fraction, 1.0);
}

#[test]
fn codec_refuses_nonfinite_and_non_json_profile_nodes_without_converting_them() {
    for document in ["1e9999", "-1e9999"] {
        let document = SourceJson::parse(document).unwrap();
        assert!(source_json_tree(&document).is_err());
        assert!(encode_source_control_record("finite-only", &document, None).is_err());
    }
    for node in [
        PortableValue::Undefined,
        PortableValue::BigInt("1".into()),
        PortableValue::KvU64("1".into()),
        PortableValue::Date { epoch_ms: Some(1) },
        PortableValue::Map(vec![]),
        PortableValue::Set(vec![]),
        PortableValue::RegExp {
            source: "x".into(),
            flags: "g".into(),
        },
        PortableValue::number(f64::INFINITY),
        PortableValue::number(f64::NEG_INFINITY),
        PortableValue::number(f64::NAN),
    ] {
        let record = StoredRecord::profile_v2("typed-node", node, None).unwrap();
        assert!(decode_source_control_record(&record).is_err());
    }
}

#[test]
fn wrong_encoding_duplicate_profile_keys_and_versions_fail_closed() {
    let document = SourceJson::parse(r#"{"model":"x"}"#).unwrap();
    let v1 = StoredRecord::profile("profile-v1", PortableValue::Null, None).unwrap();
    assert!(decode_source_control_record(&v1).is_err());
    let mut record = encode_source_control_record("valid", &document, None).unwrap();
    record.schema_version += 1;
    assert!(decode_source_control_record(&record).is_err());
    record.schema_version -= 1;
    record.value_encoding = ValueEncoding::SourceGraphV1;
    assert!(decode_source_control_record(&record).is_err());
    let duplicate = PortableValue::ObjectUtf16(vec![
        (JsString16::from_units(vec![0xd800]), PortableValue::Null),
        (
            JsString16::from_units(vec![0xd800]),
            PortableValue::Boolean(true),
        ),
    ]);
    let mut record =
        StoredRecord::json("duplicates", serde_json::to_value(duplicate).unwrap(), None);
    record.value_encoding = ValueEncoding::ProfileV2;
    assert!(decode_source_control_record(&record).is_err());
}

#[test]
fn codec_preserves_the_full_existing_i64_expiry_domain_without_family_time_policy() {
    for raw in [r#"{"model":"scalar"}"#, r#"{"model":"\ud800"}"#] {
        let document = SourceJson::parse(raw).unwrap();
        for expiry in [
            None,
            Some(i64::MIN),
            Some(-1),
            Some(0),
            Some(MAX_SAFE_INTEGER + 1),
            Some(i64::MAX),
        ] {
            for revision in ["", "  ", "revision-exact"] {
                let record = encode_source_control_record(revision, &document, expiry).unwrap();
                assert_eq!(record.expires_at_ms, expiry);
                let stored = serde_json::to_string(&record).unwrap();
                let restored: StoredRecord = serde_json::from_str(&stored).unwrap();
                assert_eq!(restored.expires_at_ms, expiry);
                assert_eq!(restored.revision, revision);
                let decoded = decode_source_control_record(&restored).unwrap();
                assert_eq!(
                    source::member(&decoded, "model")
                        .unwrap()
                        .deserialize::<ModelId>()
                        .unwrap(),
                    source::member(&document, "model")
                        .unwrap()
                        .deserialize::<ModelId>()
                        .unwrap()
                );
            }
        }
    }
}
