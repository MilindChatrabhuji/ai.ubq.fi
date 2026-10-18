use gateway_core::{
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use serde_json::{Value, json};

#[test]
fn json_that_resembles_a_type_tag_is_never_guessed_as_typed() {
    let ambiguous = json!({"type":"number_bits","value":"7ff8000000000000"});
    let record = StoredRecord::json("r1", ambiguous.clone(), Some(100));
    let restored: StoredRecord =
        serde_json::from_value(serde_json::to_value(&record).unwrap()).unwrap();
    assert_eq!(restored.value_encoding, ValueEncoding::Json);
    assert_eq!(restored.json_value().unwrap(), &ambiguous);
    let typed = StoredRecord::profile("r2", PortableValue::number(f64::NAN), None).unwrap();
    assert!(typed.json_value().is_err());
    assert!(
        typed
            .portable_value()
            .unwrap()
            .number_value()
            .unwrap()
            .is_nan()
    );
}
#[test]
fn numeric_bits_round_trip_nonfinite_and_signed_zero() {
    for bits in [
        0u64,
        1u64 << 63,
        f64::INFINITY.to_bits(),
        f64::NEG_INFINITY.to_bits(),
        0x7ff8000000000001,
        0xfff8000000000000,
    ] {
        let value = PortableValue::number(f64::from_bits(bits));
        let stored = StoredRecord::profile("r", value, None).unwrap();
        let decoded: StoredRecord =
            serde_json::from_str(&serde_json::to_string(&stored).unwrap()).unwrap();
        assert_eq!(
            decoded
                .portable_value()
                .unwrap()
                .number_value()
                .unwrap()
                .to_bits(),
            bits
        );
    }
    assert!(PortableValue::number(-0.0).to_json_lossless().is_none());
    assert_eq!(
        PortableValue::number(4.0).to_json_lossless(),
        Some(json!(4))
    );
}
#[test]
fn all_source_tree_types_round_trip_without_shape_collisions() {
    let values = vec![
        PortableValue::Undefined,
        PortableValue::Null,
        PortableValue::Boolean(true),
        PortableValue::String("雪\0".into()),
        PortableValue::BigInt("-123456789012345678901234567890".into()),
        PortableValue::KvU64(u64::MAX.to_string()),
        PortableValue::Date { epoch_ms: Some(-1) },
        PortableValue::Date { epoch_ms: None },
        PortableValue::RegExp {
            source: "a/b".into(),
            flags: "giu".into(),
        },
        PortableValue::Array(vec![PortableValue::Undefined]),
        PortableValue::Object(vec![("type".into(), PortableValue::String("date".into()))]),
        PortableValue::Map(vec![(
            PortableValue::number(f64::NAN),
            PortableValue::String("v".into()),
        )]),
        PortableValue::Set(vec![PortableValue::number(-0.0)]),
        PortableValue::Error {
            kind: "TypeError".into(),
            message: "bad".into(),
            stack: Some("supplied source stack".into()),
            cause: None,
        },
    ];
    for value in values {
        let record = StoredRecord::profile("v", value.clone(), Some(1000)).unwrap();
        let wire = serde_json::to_value(record).unwrap();
        let restored: StoredRecord = serde_json::from_value(wire).unwrap();
        assert_eq!(restored.portable_value().unwrap(), value);
    }
}
#[test]
fn binary_backing_buffers_and_views_are_preserved() {
    for kind in [
        "ArrayBuffer",
        "DataView",
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float32Array",
        "Float64Array",
        "BigInt64Array",
        "BigUint64Array",
    ] {
        let value = PortableValue::Binary {
            kind: kind.into(),
            bytes: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
            byte_offset: if kind == "ArrayBuffer" { 0 } else { 8 },
            byte_length: if kind == "ArrayBuffer" { 16 } else { 8 },
        };
        let record = StoredRecord::profile("r", value.clone(), None).unwrap();
        assert_eq!(record.portable_value().unwrap(), value);
    }
    assert!(
        PortableValue::Binary {
            kind: "Int16Array".into(),
            bytes: vec![1],
            byte_offset: 0,
            byte_length: 1
        }
        .validate()
        .is_err()
    );
}
#[test]
fn cause_rejection_is_recursive_and_graph_references_are_not_invented() {
    let error = PortableValue::Error {
        kind: "Error".into(),
        message: "e".into(),
        stack: None,
        cause: Some(Box::new(PortableValue::Undefined)),
    };
    assert!(error.validate().is_ok());
    assert!(
        StoredRecord::profile(
            "r",
            PortableValue::Map(vec![(PortableValue::Null, error)]),
            None
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<PortableValue>(json!({"type":"reference","value":0})).is_err()
    );
    assert!(
        serde_json::from_value::<PortableValue>(json!({"type":"accessor","value":"getter"}))
            .is_err()
    );
}
#[test]
fn json_metadata_defaults_only_for_predeployment_json_records() {
    let old =
        json!({"schema_version":1,"revision":"r","value":{"type":"date"},"expires_at_ms":null});
    let row: StoredRecord = serde_json::from_value(old).unwrap();
    assert_eq!(row.json_value().unwrap(), &json!({"type":"date"}));
    assert!(serde_json::from_value::<StoredRecord>(json!({"schema_version":1,"value_encoding":"unknown","revision":"r","value":null,"expires_at_ms":null})).is_err());
    let malformed = StoredRecord {
        schema_version: 1,
        value_encoding: ValueEncoding::ProfileV1,
        revision: "r".into(),
        value: Value::Null,
        expires_at_ms: None,
    };
    assert!(malformed.validate_version().is_err());
}
