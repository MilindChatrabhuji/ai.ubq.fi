use gateway_core::query::{QueryRequest, QuerySelector};
use gateway_core::state::{RecordKey, StoredRecord};
use gateway_core::tuple_key::{BigIntKey, KeyPart, ScalarKeyPart, TupleKey};
use serde_json::{Value, json};

fn key(parts: &[Value]) -> RecordKey {
    TupleKey::from_json_parts(parts).unwrap().to_record_key()
}

fn request(selector: QuerySelector) -> QueryRequest {
    QueryRequest {
        selector,
        reverse: false,
        limit: 2,
        cursor: None,
        now_ms: 1_000,
    }
}

fn prefix(parts: &[Value]) -> QuerySelector {
    QuerySelector::Prefix {
        prefix: key(parts),
        start: None,
        end: None,
    }
}

fn row(expires_at_ms: Option<i64>) -> StoredRecord {
    StoredRecord {
        schema_version: 1,
        revision: "1".to_owned(),
        value: json!({"value":1}),
        expires_at_ms,
    }
}

#[test]
fn actual_patched_source_encoder_vectors_match_every_portable_part_kind() {
    // Captured from @deno/kv 0.14.0 patched kv_key.js packKey on 2026-10-18.
    // Source SHA256 0abb4eb4ae8f4583df9d6638c00cb6b583e0692a788c7b48601dcae4980f7d70.
    // Full vector artifact SHA256 01c93962af3c4b3f9c591fe388f96dcbb6831b3dc9ceb94f808932b6fe0d302a.
    let vectors = [
        (vec![], ""),
        (vec![KeyPart::Bytes(vec![])], "0100"),
        (vec![KeyPart::Bytes(vec![0, 255, 1])], "0100ffff0100"),
        (vec![KeyPart::String(String::new())], "0200"),
        (
            vec![KeyPart::String("é\0雪".to_owned())],
            "02c3a900ffe99baa00",
        ),
        (vec![KeyPart::BigInt(BigIntKey::from_i128(0))], "14"),
        (vec![KeyPart::BigInt(BigIntKey::from_i128(-256))], "12feff"),
        (vec![KeyPart::BigInt(BigIntKey::from_i128(256))], "160100"),
        (
            vec![KeyPart::BigInt(BigIntKey::from_i128(-(1_i128 << 80)))],
            "0bf4feffffffffffffffffffff",
        ),
        (
            vec![KeyPart::BigInt(BigIntKey::from_i128(1_i128 << 80))],
            "1d0b0100000000000000000000",
        ),
        (
            vec![KeyPart::Number(f64::NEG_INFINITY)],
            "21000fffffffffffff",
        ),
        (vec![KeyPart::Number(-2.0)], "213fffffffffffffff"),
        (vec![KeyPart::Number(-0.0)], "217fffffffffffffff"),
        (vec![KeyPart::Number(0.0)], "218000000000000000"),
        (vec![KeyPart::Number(2.0)], "21c000000000000000"),
        (vec![KeyPart::Number(f64::INFINITY)], "21fff0000000000000"),
        (vec![KeyPart::Number(f64::NAN)], "21fff8000000000000"),
        (vec![KeyPart::Boolean(false)], "26"),
        (vec![KeyPart::Boolean(true)], "27"),
        (
            vec![
                KeyPart::String("uos_ai".to_owned()),
                KeyPart::Bytes(vec![0, 1]),
                KeyPart::BigInt(BigIntKey::from_i128(-10)),
                KeyPart::Number(-0.0),
                KeyPart::Boolean(true),
            ],
            "02756f735f6169000100ff010013f5217fffffffffffffff27",
        ),
    ];
    for (parts, hex) in vectors {
        let packed = TupleKey::from_parts(&parts).unwrap();
        assert_eq!(packed.to_record_key().0, format!("tuple-v1:{hex}"));
        assert_eq!(
            TupleKey::from_record_key(&packed.to_record_key()).unwrap(),
            packed
        );
    }
}

#[test]
fn typed_comparator_preserves_source_order_instead_of_json_order() {
    let parts = [
        KeyPart::Bytes(vec![0]),
        KeyPart::Bytes(vec![2]),
        KeyPart::Bytes(vec![10]),
        KeyPart::String("a".into()),
        KeyPart::String("é".into()),
        KeyPart::BigInt(BigIntKey::from_i128(-2)),
        KeyPart::BigInt(BigIntKey::from_i128(0)),
        KeyPart::BigInt(BigIntKey::from_i128(2)),
        KeyPart::Number(-2.0),
        KeyPart::Number(-0.0),
        KeyPart::Number(0.0),
        KeyPart::Number(2.0),
        KeyPart::Boolean(false),
        KeyPart::Boolean(true),
    ];
    let packed: Vec<_> = parts
        .into_iter()
        .map(|part| TupleKey::from_parts(&[part]).unwrap())
        .collect();
    assert!(packed.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(
        TupleKey::from_json_parts(&[json!(2)]).unwrap()
            < TupleKey::from_json_parts(&[json!(10)]).unwrap()
    );
    assert_ne!(key(&[json!(2)]), key(&[json!("2")]));
    let typed = TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("p"),
        ScalarKeyPart::Number(2),
        ScalarKeyPart::Boolean(true),
    ]);
    assert_eq!(
        typed.to_record_key(),
        key(&[json!("p"), json!(2), json!(true)])
    );
}

#[test]
fn source_numeric_identity_and_negative_nan_refusal_are_preserved() {
    let negative_zero = TupleKey::from_parts(&[KeyPart::Number(-0.0)]).unwrap();
    let positive_zero = TupleKey::from_parts(&[KeyPart::Number(0.0)]).unwrap();
    assert_ne!(negative_zero, positive_zero);
    assert!(
        TupleKey::from_parts(&[KeyPart::Number(f64::from_bits(0xfff8_0000_0000_0000))]).is_err()
    );
    assert!(TupleKey::from_record_key(&RecordKey("tuple-v1:210007ffffffffffff".into())).is_err());
    // Do not reject or normalize a raw positive NaN payload accepted by the source validator.
    let raw = RecordKey("tuple-v1:21fff8000000000001".into());
    assert_eq!(
        TupleKey::from_record_key(&raw).unwrap().to_record_key(),
        raw
    );
}

#[test]
fn structural_validation_rejects_truncation_tags_and_invalid_wire_versions() {
    for encoded in [
        "tuple-v1:21",
        "tuple-v1:01ff",
        "tuple-v1:1d0201",
        "tuple-v1:00",
        "tuple-v1:02ff",
        "tuple-v1:01",
        "tuple-v1:0100ff",
        "tuple-v1:f",
        "tuple-v1:0A",
        "tuple-v2:26",
        "[\"old-json\"]",
    ] {
        assert!(
            TupleKey::from_record_key(&RecordKey(encoded.into())).is_err(),
            "{encoded}"
        );
    }
    let empty = TupleKey::from_parts(&[]).unwrap();
    assert!(empty.validate_stored_key().is_err());
    assert!(
        TupleKey::from_parts(&[KeyPart::String(String::new())])
            .unwrap()
            .validate_stored_key()
            .is_ok()
    );
    for value in [json!(null), json!({}), json!([])] {
        assert!(TupleKey::from_json_parts(&[value]).is_err());
    }
}

#[test]
fn bigint_magnitude_handles_source_length_boundary_without_wrapping() {
    let largest = BigIntKey::from_signed_magnitude(true, vec![1; 255]).unwrap();
    let encoded = TupleKey::from_parts(&[KeyPart::BigInt(largest)]).unwrap();
    assert_eq!(encoded.sort_bytes()[..2], [0x0b, 0]);
    assert_eq!(
        TupleKey::from_record_key(&encoded.to_record_key()).unwrap(),
        encoded
    );
    assert!(BigIntKey::from_signed_magnitude(false, vec![1; 256]).is_err());
    let zero = BigIntKey::from_signed_magnitude(true, vec![0, 0]).unwrap();
    assert_eq!(
        TupleKey::from_parts(&[KeyPart::BigInt(zero)])
            .unwrap()
            .to_record_key()
            .0,
        "tuple-v1:14"
    );
}

#[test]
fn prefix_excludes_its_exact_row_and_allows_either_source_bound() {
    let root = key(&[json!("p")]);
    let first = key(&[json!("p"), json!(1)]);
    let second = key(&[json!("p"), json!(2)]);
    let third = key(&[json!("p"), json!(3)]);
    let all = request(prefix(&[json!("p")])).validate().unwrap();
    assert!(!all.accepts_key(&root).unwrap());
    assert!(all.accepts_key(&first).unwrap());
    assert!(!all.accepts_key(&key(&[json!("other"), json!(1)])).unwrap());
    let from = request(QuerySelector::Prefix {
        prefix: root.clone(),
        start: Some(second.clone()),
        end: None,
    })
    .validate()
    .unwrap();
    assert!(!from.accepts_key(&first).unwrap());
    assert!(from.accepts_key(&second).unwrap());
    assert!(from.accepts_key(&third).unwrap());
    let until = request(QuerySelector::Prefix {
        prefix: root.clone(),
        start: None,
        end: Some(second.clone()),
    })
    .validate()
    .unwrap();
    assert!(until.accepts_key(&first).unwrap());
    assert!(!until.accepts_key(&second).unwrap());
    for selector in [
        QuerySelector::Prefix {
            prefix: root.clone(),
            start: Some(root.clone()),
            end: None,
        },
        QuerySelector::Prefix {
            prefix: root.clone(),
            start: None,
            end: Some(key(&[json!("other")])),
        },
        QuerySelector::Prefix {
            prefix: root,
            start: Some(first),
            end: Some(second),
        },
    ] {
        assert!(request(selector).validate().is_err());
    }
}

#[test]
fn range_bounds_are_inclusive_exclusive_and_reversed_range_is_refused() {
    let first = key(&[json!("p"), json!(1)]);
    let second = key(&[json!("p"), json!(2)]);
    let range = request(QuerySelector::Range {
        start: first.clone(),
        end: second.clone(),
    })
    .validate()
    .unwrap();
    assert!(range.accepts_key(&first).unwrap());
    assert!(!range.accepts_key(&second).unwrap());
    assert!(
        request(QuerySelector::Range {
            start: second.clone(),
            end: first
        })
        .validate()
        .is_err()
    );
    let empty = request(QuerySelector::Range {
        start: second.clone(),
        end: second.clone(),
    })
    .validate()
    .unwrap();
    assert!(!empty.accepts_key(&second).unwrap());
    let all = request(prefix(&[])).validate().unwrap();
    assert!(all.accepts_key(&second).unwrap());
    assert!(
        all.accepts_key(
            &TupleKey::from_parts(&[KeyPart::Bytes(vec![])])
                .unwrap()
                .to_record_key()
        )
        .unwrap()
    );
}

#[test]
fn continuation_is_exclusive_and_binds_selector_and_direction_but_not_limit() {
    let first = key(&[json!("p"), json!(1)]);
    let second = key(&[json!("p"), json!(2)]);
    let original = request(prefix(&[json!("p")]));
    let cursor = original.validate().unwrap().cursor_after(&first).unwrap();
    let mut resumed = original.clone();
    resumed.cursor = Some(cursor.clone());
    resumed.limit = 17;
    let validated = resumed.validate().unwrap();
    assert_eq!(
        validated.resume_key(),
        Some(TupleKey::from_record_key(&first).unwrap().sort_bytes())
    );
    assert!(!validated.accepts_key(&first).unwrap());
    assert!(validated.accepts_key(&second).unwrap());
    let mut other = request(prefix(&[json!("other")]));
    other.cursor = Some(cursor.clone());
    assert!(other.validate().is_err());
    let mut reversed = resumed;
    reversed.reverse = true;
    assert!(reversed.validate().is_err());
    for malformed in [
        String::new(),
        "query-v2:00".into(),
        "query-v1:00".into(),
        "query-v1:0A".into(),
    ] {
        let mut query = original.clone();
        query.cursor = Some(malformed);
        assert!(query.validate().is_err());
    }
}

#[test]
fn reverse_continuation_seeks_before_last_row_and_retains_range() {
    let first = key(&[json!("p"), json!(1)]);
    let second = key(&[json!("p"), json!(2)]);
    let third = key(&[json!("p"), json!(3)]);
    let mut query = request(prefix(&[json!("p")]));
    query.reverse = true;
    query.cursor = Some(query.validate().unwrap().cursor_after(&second).unwrap());
    let validated = query.validate().unwrap();
    assert!(validated.accepts_key(&first).unwrap());
    assert!(!validated.accepts_key(&second).unwrap());
    assert!(!validated.accepts_key(&third).unwrap());
}

#[test]
fn expiry_is_filtered_before_page_limit_and_never_rewritten() {
    let query = request(prefix(&[json!("p")])).validate().unwrap();
    let rows = [
        (key(&[json!("p"), json!(1)]), row(Some(999))),
        (key(&[json!("p"), json!(2)]), row(Some(1_000))),
        (key(&[json!("p"), json!(3)]), row(Some(1_001))),
        (key(&[json!("p"), json!(4)]), row(None)),
    ];
    let accepted: Vec<_> = rows
        .iter()
        .filter(|(key, row)| query.accepts_record(key, row).unwrap())
        .take(query.limit as usize)
        .map(|(key, _)| key.clone())
        .collect();
    assert_eq!(accepted, vec![rows[2].0.clone(), rows[3].0.clone()]);
    assert_eq!(rows[0].1.expires_at_ms, Some(999));
    assert_eq!(rows[2].1.expires_at_ms, Some(1_001));
    let corrupt_live = StoredRecord {
        schema_version: 2,
        ..row(None)
    };
    assert!(query.accepts_record(&rows[2].0, &corrupt_live).is_err());
}

#[test]
fn query_refuses_zero_page_limit_and_invalid_clock() {
    let mut query = request(prefix(&[]));
    query.limit = 0;
    assert!(query.validate().is_err());
    query.limit = 1;
    query.now_ms = -1;
    assert!(query.validate().is_err());
}
