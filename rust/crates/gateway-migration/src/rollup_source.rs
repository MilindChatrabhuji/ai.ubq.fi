//! The existing shared source usage family includes paid AND ordinary providers.
//! M39 owns its value predicate; this adapter adds only physical-key/metadata custody.
use crate::*;
use gateway_core::{
    identity::MAX_SAFE_INTEGER, js_string::JsString16, model::ModelId,
    source_serialization as source, tuple_key::DecodedKeyPart,
};

pub(crate) fn validate(key: &RecordKey, record: &StoredRecord) -> Result<(), GatewayError> {
    record.validate_version()?;
    if record.revision.trim().is_empty()
        || record
            .expires_at_ms
            .is_some_and(|expiry| !(0..=MAX_SAFE_INTEGER).contains(&expiry))
    {
        return Err(invalid("Source usage rollup metadata is invalid"));
    }
    let document = gateway_observability::records::usage_rollup_record_source(record)?;
    let field = |name| {
        source::member(&document, name)
            .ok_or_else(|| invalid("Source usage rollup field is missing"))
    };
    let model: ModelId = field("model")?.deserialize()?;
    let provider: JsString16 = field("provider")?.deserialize()?;
    let bucket: f64 = field("bucket_start_at_ms")?.deserialize()?;
    let tuple = TupleKey::from_record_key(key)?;
    tuple.validate_stored_key()?;
    let parts = tuple.decoded_parts()?;
    let shard = match parts.last() {
        Some(DecodedKeyPart::Number(value))
            if parts.len() == 8 && value.fract() == 0.0 && (0.0..16.0).contains(value) =>
        {
            *value
        }
        _ => return Err(invalid("Source usage rollup shard is invalid")),
    };
    if gateway_authority::keys::paid_rollup_source(bucket, &model, &provider, shard)? != *key {
        return Err(invalid(
            "Source usage rollup key conflicts with its stored labels",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gateway_core::source_control::{
        decode_source_control_record, encode_source_control_record,
    };

    fn fixture() -> (RecordKey, StoredRecord) {
        let envelope = SourceJson::parse(include_str!(
            "../tests/fixtures/source-usage-rollup-writer.json"
        ))
        .unwrap();
        assert_eq!(
            source::member(&envelope, "source_sha")
                .unwrap()
                .deserialize::<String>()
                .unwrap(),
            "5c177d8c228b5e4f96043b9a81076a46e6a366cc"
        );
        let case = source::member(&envelope, "fixtures")
            .unwrap()
            .array_items()
            .unwrap()
            .remove(0);
        let row = source::member(&case, "rows")
            .unwrap()
            .array_items()
            .unwrap()
            .remove(0);
        (
            RecordKey(source::member(&row, "key").unwrap().deserialize().unwrap()),
            source::member(&row, "record")
                .unwrap()
                .deserialize()
                .unwrap(),
        )
    }
    fn field(record: &StoredRecord, name: &str, value: SourceJson) -> StoredRecord {
        let document = decode_source_control_record(record).unwrap();
        let mut fields = source::entries(&document).unwrap();
        let old = fields
            .iter_mut()
            .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
            .unwrap();
        old.1 = value;
        encode_source_control_record(
            &record.revision,
            &source::object_keys(fields).unwrap(),
            record.expires_at_ms,
        )
        .unwrap()
    }
    fn source_key(record: &StoredRecord, shard: f64) -> RecordKey {
        let document = decode_source_control_record(record).unwrap();
        gateway_authority::keys::paid_rollup_source(
            source::member(&document, "bucket_start_at_ms")
                .unwrap()
                .deserialize()
                .unwrap(),
            &source::member(&document, "model")
                .unwrap()
                .deserialize()
                .unwrap(),
            &source::member(&document, "provider")
                .unwrap()
                .deserialize()
                .unwrap(),
            shard,
        )
        .unwrap()
    }
    #[test]
    fn actual_general_writer_fixture_keeps_first_label_sums_and_metadata() {
        let (key, record) = fixture();
        let before = record.clone();
        validate(&key, &record).unwrap();
        let document = decode_source_control_record(&record).unwrap();
        assert_eq!(
            source::member(&document, "model")
                .unwrap()
                .deserialize::<JsString16>()
                .unwrap()
                .as_units(),
            &[0xd800]
        );
        assert_eq!(
            source::member(&document, "request_count")
                .unwrap()
                .deserialize::<f64>()
                .unwrap(),
            3.0
        );
        assert_eq!(
            source::member(&document, "provider")
                .unwrap()
                .deserialize::<String>()
                .unwrap(),
            "chatgpt_codex"
        );
        assert_eq!(record, before);
        let mut expired_data = record;
        expired_data.expires_at_ms = Some(42);
        validate(&key, &expired_data).unwrap();
        assert_eq!(expired_data.expires_at_ms, Some(42));
    }
    #[test]
    fn source_provider_units_and_number_bits_are_not_scalarized() {
        let (_, record) = fixture();
        // These are explicitly synthetic variants of the real writer output.
        let record = field(
            &record,
            "provider",
            SourceJson::parse(r#""\udc00""#).unwrap(),
        );
        let key = source_key(&record, 6.0);
        validate(&key, &record).unwrap();
        let signed = field(
            &record,
            "bucket_start_at_ms",
            SourceJson::parse("-0.0").unwrap(),
        );
        let signed_key = source_key(&signed, 6.0);
        assert_ne!(key, signed_key);
        validate(&signed_key, &signed).unwrap();
        assert!(validate(&key, &signed).is_err());
        let model = ModelId::from_scalar("scalar-model");
        assert_eq!(
            gateway_authority::keys::paid_rollup(0, "scalar-model", "chatgpt_codex", 6),
            gateway_authority::keys::paid_rollup_model(0, &model, "chatgpt_codex", 6)
        );
        assert_eq!(
            gateway_authority::keys::paid_rollup_model(0, &model, "chatgpt_codex", 6),
            gateway_authority::keys::paid_rollup_source(
                0.0,
                &model,
                &JsString16::from_utf8("chatgpt_codex"),
                6.0
            )
            .unwrap()
        );
    }
    #[test]
    fn malformed_values_keys_and_metadata_refuse_without_mutation() {
        let (key, record) = fixture();
        let wrong_label = field(
            &record,
            "model",
            SourceJson::from_serializable("other-model").unwrap(),
        );
        assert!(validate(&key, &wrong_label).is_err());
        let wrong_number = field(&record, "quota_sum", SourceJson::parse("-1").unwrap());
        assert!(validate(&key, &wrong_number).is_err());
        assert!(validate(&source_key(&record, 16.0), &record).is_err());
        let mut corrupt = record.clone();
        corrupt.revision = " ".into();
        assert!(validate(&key, &corrupt).is_err());
        corrupt = record.clone();
        corrupt.expires_at_ms = Some(-1);
        assert!(validate(&key, &corrupt).is_err());
        assert_eq!(record, fixture().1);
    }
}
