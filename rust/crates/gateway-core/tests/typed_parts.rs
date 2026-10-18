use gateway_core::{
    state::RecordKey,
    tuple_key::{BigIntKey, DecodedKeyPart, KeyPart, TupleKey},
};

#[test]
fn canonical_source_parts_roundtrip_with_all_types_and_nul_escaping() {
    let parts = vec![
        KeyPart::Bytes(vec![0, 255, 1]),
        KeyPart::String("é\0雪".into()),
        KeyPart::BigInt(BigIntKey::from_i128(-256)),
        KeyPart::BigInt(BigIntKey::from_i128(0)),
        KeyPart::BigInt(BigIntKey::from_i128(1_i128 << 80)),
        KeyPart::Number(-0.0),
        KeyPart::Number(f64::NEG_INFINITY),
        KeyPart::Number(f64::INFINITY),
        KeyPart::Boolean(false),
        KeyPart::Boolean(true),
    ];
    let key = TupleKey::from_parts(&parts).unwrap();
    let decoded = key.decoded_parts().unwrap();
    assert_eq!(decoded[0], DecodedKeyPart::Bytes(vec![0, 255, 1]));
    assert_eq!(
        decoded[1],
        DecodedKeyPart::String("é\0雪".as_bytes().to_vec())
    );
    assert_eq!(
        decoded[2],
        DecodedKeyPart::BigInt {
            negative: true,
            magnitude: vec![1, 0]
        }
    );
    assert_eq!(
        decoded[3],
        DecodedKeyPart::BigInt {
            negative: false,
            magnitude: vec![]
        }
    );
    let rebuilt: Vec<_> = decoded
        .into_iter()
        .map(|part| match part {
            DecodedKeyPart::Bytes(v) => KeyPart::Bytes(v),
            DecodedKeyPart::String(v) => KeyPart::String(String::from_utf8(v).unwrap()),
            DecodedKeyPart::BigInt {
                negative,
                magnitude,
            } => KeyPart::BigInt(BigIntKey::from_signed_magnitude(negative, magnitude).unwrap()),
            DecodedKeyPart::Number(v) => KeyPart::Number(v),
            DecodedKeyPart::Boolean(v) => KeyPart::Boolean(v),
        })
        .collect();
    assert_eq!(
        TupleKey::from_parts(&rebuilt).unwrap().to_record_key(),
        key.to_record_key()
    );
}

#[test]
fn observations_retain_source_accepted_noncanonical_payloads_without_reencoding() {
    for (encoded, expected) in [
        ("tuple-v1:02ff00", DecodedKeyPart::String(vec![255])),
        ("tuple-v1:0200ff00", DecodedKeyPart::String(vec![0])),
        (
            "tuple-v1:1d020001",
            DecodedKeyPart::BigInt {
                negative: false,
                magnitude: vec![0, 1],
            },
        ),
        (
            "tuple-v1:0bfdfffe",
            DecodedKeyPart::BigInt {
                negative: true,
                magnitude: vec![0, 1],
            },
        ),
        (
            "tuple-v1:1d00",
            DecodedKeyPart::BigInt {
                negative: false,
                magnitude: vec![],
            },
        ),
        (
            "tuple-v1:0bff",
            DecodedKeyPart::BigInt {
                negative: true,
                magnitude: vec![],
            },
        ),
    ] {
        let record = RecordKey(encoded.into());
        let key = TupleKey::from_record_key(&record).unwrap();
        assert_eq!(key.decoded_parts().unwrap(), [expected]);
        assert_eq!(key.to_record_key(), record);
    }
}

#[test]
fn numeric_bits_distinguish_signed_zero_and_preserve_positive_nan_payload() {
    for (encoded, bits) in [
        ("217fffffffffffffff", (-0.0f64).to_bits()),
        ("218000000000000000", 0.0f64.to_bits()),
        ("21fff8000000000001", 0x7ff8_0000_0000_0001),
    ] {
        let record = RecordKey(format!("tuple-v1:{encoded}"));
        let key = TupleKey::from_record_key(&record).unwrap();
        let parts = key.decoded_parts().unwrap();
        let DecodedKeyPart::Number(value) = parts[0] else {
            panic!("number")
        };
        assert_eq!(value.to_bits(), bits);
        assert_eq!(key.to_record_key(), record);
    }
    assert!(TupleKey::from_record_key(&RecordKey("tuple-v1:210007ffffffffffff".into())).is_err());
}

#[test]
fn decoding_uses_existing_validation_and_keeps_empty_prefix_semantics() {
    let prefix = TupleKey::from_parts(&[]).unwrap();
    assert!(prefix.decoded_parts().unwrap().is_empty());
    assert!(prefix.validate_stored_key().is_err());
    for encoded in ["01", "0100ff", "02ff", "1d0201", "0bfe", "21", "00", "28"] {
        assert!(
            TupleKey::from_record_key(&RecordKey(format!("tuple-v1:{encoded}"))).is_err(),
            "{encoded}"
        );
    }
}
