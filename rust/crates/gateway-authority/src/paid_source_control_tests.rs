use super::*;
use gateway_core::{
    js_string::JsString16,
    model::ModelId,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    value::ValueEncoding,
};

fn model(units: &[u16]) -> ModelId {
    ModelId::from_source(JsString16::from_units(units.to_vec()))
}
fn source_request(id: &str, settled: bool, model: &ModelId) -> SourceJson {
    let mut fields =
        source::entries(&SourceJson::from_serializable(&request(id, settled)).unwrap()).unwrap();
    for (key, value) in &mut fields {
        if key.as_units().iter().copied().eq("model".encode_utf16()) {
            *value = model.to_source_json().unwrap();
        }
        if key
            .as_units()
            .iter()
            .copied()
            .eq("reasoning".encode_utf16())
        {
            *value = JsString16::from_units(vec![0xdc00])
                .to_source_json()
                .unwrap();
        }
    }
    fields.push((
        "source_extra".into(),
        SourceJson::parse(r#"{"\ud800":"\udc00"}"#).unwrap(),
    ));
    source::object_keys(fields).unwrap()
}
fn put_source(store: &Store, key: RecordKey, raw: &SourceJson) {
    let row = encode_source_control_record(store.next_token().unwrap(), raw, None).unwrap();
    store.rows.borrow_mut().insert(key.0, row);
}
fn typed<T: serde::de::DeserializeOwned>(store: &Store, key: &RecordKey) -> T {
    decode_source_control_record(&store.row(key))
        .unwrap()
        .deserialize()
        .unwrap()
}

#[test]
fn actual_settlement_preserves_first_label_for_three_source_physical_key_collisions() {
    // Actual pinned Bun oracle ref d537e22d-a279-4f3a-a86d-09376c77e73d:
    // high/low/replacement text bytes all efbfbd; source retains first label and sums.
    let store = Store::default();
    let bucket = (NOW - 1000) / 3_600_000 * 3_600_000;
    let first = model(&[0xd800]);
    let first_key =
        keys::paid_rollup_model(bucket, &first, "metered", crate::paid::rollup_shard("a"));
    assert_eq!(
        first_key,
        keys::paid_rollup(
            bucket,
            "\u{fffd}",
            "metered",
            crate::paid::rollup_shard("a")
        )
    );
    let mut active = window(NOW);
    active["reserved_microcredits"] = json!(30);
    active["pending_count"] = json!(3);
    store.put(keys::paid_window("key", NOW), active);
    let authority = store.authority();
    for (index, (id, units)) in [
        ("a", &[0xd800][..]),
        ("q", &[0xdc00][..]),
        ("A", &[0xfffd][..]),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            crate::paid::rollup_shard(id),
            crate::paid::rollup_shard("a")
        );
        let logical = model(units);
        let raw = source_request(id, false, &logical);
        let row: PaidAttempt = raw.deserialize().unwrap();
        put_source(&store, key(id), &raw);
        store.put(keys::paid_pending("key", id), json!({"key_id":"key","attempt_id":id,"created_at_ms":NOW-1000,"next_reconciliation_at_ms":NOW}));
        let mut usage = live_usage();
        usage.correlation = crate::paid::PaidCorrelation::ProviderRequestId(id.into());
        assert!(run(authority.settle_paid(&row.reservation, &usage, NOW + index as i64)).unwrap());
        assert!(!run(authority.settle_paid(&row.reservation, &usage, NOW + 10)).unwrap());
        let saved =
            crate::paid::decode_paid_attempt_record(&key(id), &store.row(&key(id))).unwrap();
        assert_eq!(saved.model, logical);
        assert_eq!(saved.reasoning.unwrap().as_units(), &[0xdc00]);
        let rollup =
            crate::paid::decode_paid_rollup_record(&first_key, &store.row(&first_key)).unwrap();
        assert_eq!(rollup.model, first);
        assert_eq!(rollup.request_count, index as i64 + 1);
        assert_eq!(rollup.provider_quota, (index + 1) as f64 * 5.0);
        assert_eq!(rollup.spend_microcredits, (index + 1) as f64 * 5.0);
        assert_eq!(store.row(&first_key).expires_at_ms, None);
        assert_eq!(
            store.row(&key(id)).expires_at_ms,
            Some(NOW - 1000 + crate::PAID_RETENTION_MS)
        );
    }
    assert_eq!(
        store.row(&first_key).value_encoding,
        ValueEncoding::ProfileV2
    );
    let window = store.value(&keys::paid_window("key", NOW));
    assert_eq!(window["settled_microcredits"], 15);
    assert_eq!(window["reserved_microcredits"], 0);
    assert_eq!(window["pending_count"], 0);
    let rows: Vec<_> = [key("a"), key("q"), key("A"), first_key]
        .into_iter()
        .map(|key| {
            let record = store.row(&key);
            serde_json::json!({"key":key.0,"record":record})
        })
        .collect();
    println!(
        "M19_SOURCE_WRITER_FIXTURES {}",
        serde_json::to_string(&rows).unwrap()
    );
}

#[test]
fn backfill_source_rows_preserve_unknown_units_restart_markers_and_collision_labels() {
    let store = Store::default();
    let high = model(&[0xd800]);
    let low = model(&[0xdc00]);
    for (id, logical) in [("a", &high), ("q", &low)] {
        put_source(&store, key(id), &source_request(id, true, logical));
    }
    let receipt = backfill(&store, 10);
    assert_eq!(receipt.requests.rollups_written, 2);
    let rollup_key = keys::paid_rollup_model(
        (NOW - 1000) / 3_600_000 * 3_600_000,
        &high,
        "metered",
        crate::paid::rollup_shard("a"),
    );
    let rollup: crate::paid::PaidRollup = typed(&store, &rollup_key);
    assert_eq!(rollup.model, high);
    assert_eq!(rollup.request_count, 2);
    assert_eq!(rollup.spend_microcredits, 10.0);
    for (id, logical) in [("a", &high), ("q", &low)] {
        let raw = decode_source_control_record(&store.row(&key(id))).unwrap();
        let row: PaidAttempt = raw.deserialize().unwrap();
        assert_eq!(&row.model, logical);
        assert_eq!(row.usage_rollup_at_ms, Some(NOW));
        let extra = source::member(&raw, "source_extra").unwrap();
        let entries = source::entries(&extra).unwrap();
        assert_eq!(entries[0].0.as_units(), &[0xd800]);
        assert_eq!(source::string(&entries[0].1).unwrap().as_units(), &[0xdc00]);
        assert_eq!(
            store.row(&key(id)).expires_at_ms,
            Some(NOW - 1000 + crate::PAID_RETENTION_MS)
        );
    }
    assert_eq!(backfill(&store, 10).requests.rollups_written, 0);
    let after: crate::paid::PaidRollup = typed(&store, &rollup_key);
    assert_eq!(after, rollup);
}

#[test]
fn source_physical_collision_does_not_merge_distinct_astral_or_literal_escape_controls() {
    let high = model(&[0xd800]);
    let replacement = model(&[0xfffd]);
    let astral = model(&[0xd83d, 0xde00]);
    let escape = ModelId::from_scalar(r"\ud800");
    let key_for = |value: &ModelId| keys::paid_rollup_model(1, value, "metered", 0);
    assert_ne!(high, replacement);
    assert_eq!(key_for(&high), key_for(&replacement));
    assert_ne!(key_for(&high), key_for(&astral));
    assert_ne!(key_for(&high), key_for(&escape));
    assert_ne!(key_for(&astral), key_for(&escape));
}

#[test]
fn keyed_paid_decoder_retains_expired_data_but_refuses_wrong_key_metadata_and_encoding() {
    let store = Store::default();
    let raw = source_request("a", true, &model(&[0xd800]));
    put_source(&store, key("a"), &raw);
    let row = store.row(&key("a"));
    assert!(crate::paid::decode_paid_attempt_record(&key("a"), &row).is_ok());
    assert!(crate::paid::decode_paid_attempt_record(&key("other"), &row).is_err());
    let mut expired = row.clone();
    expired.expires_at_ms = Some(NOW - 1);
    assert!(crate::paid::decode_paid_attempt_record(&key("a"), &expired).is_ok());
    assert_eq!(expired.expires_at_ms, Some(NOW - 1));
    let mut invalid = row.clone();
    invalid.revision = " ".into();
    assert!(crate::paid::decode_paid_attempt_record(&key("a"), &invalid).is_err());
    let mut invalid = row.clone();
    invalid.schema_version = 999;
    assert!(crate::paid::decode_paid_attempt_record(&key("a"), &invalid).is_err());
    let invalid =
        StoredRecord::profile("seed", gateway_core::value::PortableValue::Null, None).unwrap();
    assert!(crate::paid::decode_paid_attempt_record(&key("a"), &invalid).is_err());
}

#[test]
fn source_pricing_keeps_absent_null_and_malformed_utf16_cache_leaves_distinct() {
    let mut row: PaidAttempt = source_request("a", false, &model(&[0xd800]))
        .deserialize()
        .unwrap();
    row.reservation.provider = PaidProvider::Surplus;
    let raw = json!({"input_tokens":10,"output_tokens":3,"total_tokens":13,"input_tokens_details":{"cached_tokens":2,"cache_write_tokens":1}});
    let usage = gateway_core::source_usage::extract_usage_tokens(Some(&raw)).unwrap();
    for text in [
        r#"{"input_price_per_token":0.001,"output_price_per_token":0.002}"#,
        r#"{"input_price_per_token":0.001,"output_price_per_token":0.002,"cache_read_price_per_token":null,"cache_write_price_per_token":null}"#,
    ] {
        let pricing = SourceJson::parse(text).unwrap();
        let actual =
            crate::paid::surplus_usage_from_source(&row, Some(&usage), Some(&pricing)).unwrap();
        assert_eq!(actual.provider_quota, 17000.0);
    }
    for field in ["cache_read_price_per_token", "cache_write_price_per_token"] {
        let pricing = source::object(vec![
            ("input_price_per_token", SourceJson::parse("0.001").unwrap()),
            (
                "output_price_per_token",
                SourceJson::parse("0.002").unwrap(),
            ),
            (
                field,
                JsString16::from_units(vec![0xd800])
                    .to_source_json()
                    .unwrap(),
            ),
        ])
        .unwrap();
        assert!(
            crate::paid::surplus_usage_from_source(&row, Some(&usage), Some(&pricing)).is_none()
        );
    }
    let malformed = gateway_core::source_usage::extract_usage_tokens(Some(
        &json!({"input_tokens":10,"output_tokens":3,"buyer_cost_micro":"bad"}),
    ))
    .unwrap();
    let valid =
        SourceJson::parse(r#"{"input_price_per_token":0.001,"output_price_per_token":0.002}"#)
            .unwrap();
    assert!(crate::paid::surplus_usage_from_source(&row, Some(&malformed), Some(&valid)).is_none());
}
