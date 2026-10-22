use gateway_admin_data::migration::{ObservedRow, audit};
use gateway_core::{
    source_control::{
        decode_source_control_record, encode_source_control_record, source_json_tree,
    },
    source_json::SourceJson,
    source_serialization as source,
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use serde_json::{Value, json};

fn policies(models: &str) -> (SourceJson, SourceJson) {
    let hash = "a".repeat(43);
    let hash_policy = json!({"id":"fixture-key","expires_at_ms":-1,"revoked_at_ms":null,"usage_limit_requests":-1,"usage_requests":0,"usage_reset_at_ms":10000,"window_ms":1000,"usage_quota_version":3,"paid_fallback_enabled":false,"paid_fallback_limit_microcredits":-1,"paid_fallback_spent_microcredits":0,"paid_fallback_reserved_microcredits":0,"paid_fallback_reservation_request_id":null});
    let hash_policy = SourceJson::from_serializable(&hash_policy).unwrap();
    let mut fields = hash_policy.object_entries().unwrap();
    for (name, value) in [
        ("hash", SourceJson::from_serializable(&hash).unwrap()),
        ("prefix", SourceJson::parse(r#""u_0123456789""#).unwrap()),
        (
            "paid_fallback_model_ids",
            SourceJson::parse(models).unwrap(),
        ),
        (
            "paid_fallback_quota_per_credit",
            SourceJson::parse("0").unwrap(),
        ),
        (
            "paid_fallback_pricing_checked_at_ms",
            SourceJson::parse("null").unwrap(),
        ),
        (
            "paid_fallback_max_exposure_microcredits",
            SourceJson::parse(r#"{"\ud800":1,"\udc00":2,"\ufffd":3}"#).unwrap(),
        ),
    ] {
        fields.push((gateway_core::js_string::JsString16::from_utf8(name), value));
    }
    (source::object_keys(fields).unwrap(), hash_policy)
}
fn observed(parts: Value, value: &SourceJson) -> ObservedRow {
    ObservedRow::json(
        parts.as_array().unwrap().clone(),
        encode_source_control_record("source-policy", value, None).unwrap(),
    )
    .unwrap()
}
fn rows(id: &SourceJson, hash: &SourceJson) -> Vec<ObservedRow> {
    vec![
        observed(json!(["ubq_ai", "api_keys", "id", "fixture-key"]), id),
        observed(json!(["ubq_ai", "api_keys", "hash", "a".repeat(43)]), hash),
    ]
}

#[test]
fn named_key_pair_audit_preserves_complete_utf16_policy_and_finite_facts() {
    let (id, hash) = policies(r#"["\ud800","\udc00","\ufffd","\ud83d\ude00","\\ud800"]"#);
    let rows = rows(&id, &hash);
    assert_eq!(rows[0].record.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(rows[1].record.value_encoding, ValueEncoding::Json);
    let before = rows
        .iter()
        .map(|row| row.record.clone())
        .collect::<Vec<_>>();
    let (pairs, findings) = inspect_key_pairs(&rows).unwrap();
    assert!(findings.errors.is_empty());
    assert_eq!(findings.counts["api_key_ids"], 1);
    assert_eq!(findings.counts["api_key_hashes"], 1);
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].key_id, "fixture-key");
    assert!(pairs[0].unlimited_paid);
    assert_eq!(
        pairs[0].id,
        decode_source_control_record(&rows[0].record).unwrap()
    );
    assert_eq!(
        pairs[0].hash,
        decode_source_control_record(&rows[1].record).unwrap()
    );
    for field in [
        "paid_fallback_model_ids",
        "paid_fallback_max_exposure_microcredits",
    ] {
        assert_eq!(
            source_json_tree(&source::member(&pairs[0].id, field).unwrap()).unwrap(),
            source_json_tree(&source::member(&id, field).unwrap()).unwrap()
        );
    }
    assert_eq!(
        rows.iter()
            .map(|row| row.record.clone())
            .collect::<Vec<_>>(),
        before
    );
    let complete = audit::inspect_source_rows(&rows, true, 0).unwrap();
    assert!(complete.errors.is_empty());
}

#[test]
fn source_key_audit_keeps_malformed_pair_counter_and_model_rejections() {
    for models in [r#"[0]"#, r#"[null]"#, r#"[""]"#, r#"["\u00a0\t"]"#, "null"] {
        let (id, hash) = policies(models);
        assert!(!audit::valid_source_key_policy(&id, true), "{models}");
        let (pairs, findings) = inspect_key_pairs(&rows(&id, &hash)).unwrap();
        assert!(pairs.is_empty());
        assert!(findings.errors.iter().any(|error| {
            error
                .try_utf8()
                .is_ok_and(|text| text.contains("invalid v2 policy"))
        }));
        assert!(
            findings
                .errors
                .iter()
                .any(|error| error.try_utf8().is_ok_and(|text| text.contains("orphaned")))
        );
    }
    let (id, hash) = policies(r#"["scalar"]"#);
    let mut fields = hash.object_entries().unwrap();
    for (key, value) in &mut fields {
        if key
            .as_units()
            .iter()
            .copied()
            .eq("usage_requests".encode_utf16())
        {
            *value = SourceJson::parse("1").unwrap();
        }
    }
    let mismatch = source::object_keys(fields).unwrap();
    let (pairs, findings) = inspect_key_pairs(&rows(&id, &mismatch)).unwrap();
    assert!(pairs.is_empty());
    assert!(findings.errors.iter().any(|error| {
        error
            .try_utf8()
            .is_ok_and(|text| text.contains("missing or inconsistent"))
    }));
    let mut missing = rows(&id, &hash);
    missing.pop();
    let (pairs, findings) = inspect_key_pairs(&missing).unwrap();
    assert!(pairs.is_empty());
    assert!(findings.errors.iter().any(|error| {
        error
            .try_utf8()
            .is_ok_and(|text| text.contains("count mismatch"))
    }));
}

#[test]
fn named_key_audit_refuses_non_json_tree_encodings_without_global_reinterpretation() {
    let (id, hash) = policies(r#"["\ud800"]"#);
    let mut rows = rows(&id, &hash);
    rows[0].record =
        StoredRecord::profile("wrong-codec", PortableValue::String("policy".into()), None).unwrap();
    assert!(inspect_key_pairs(&rows).is_err());
    let row = observed(
        json!(["default", "unrelated"]),
        &SourceJson::parse(r#""\ud800""#).unwrap(),
    );
    assert!(row.value().is_err());
}

#[test]
fn scalar_key_policy_stays_json_and_legacy_wrapper_matches_source_validation() {
    let (id, hash) = policies(r#"["scalar"]"#);
    let fields = id
        .object_entries()
        .unwrap()
        .into_iter()
        .map(|(key, value)| {
            let value = if key
                .as_units()
                .iter()
                .copied()
                .eq("paid_fallback_max_exposure_microcredits".encode_utf16())
            {
                SourceJson::parse("{}").unwrap()
            } else {
                value
            };
            (key, value)
        })
        .collect();
    let scalar = source::object_keys(fields).unwrap();
    let rows = rows(&scalar, &hash);
    assert_eq!(rows[0].record.value_encoding, ValueEncoding::Json);
    assert_eq!(rows[0].record.value, scalar.deserialize::<Value>().unwrap());
    assert!(audit::valid_key_policy(&rows[0].record.value, true));
    assert!(audit::valid_source_key_policy(&scalar, true));
    assert!(inspect_key_pairs(&rows).unwrap().1.errors.is_empty());
}

// Independent decoded row lifetimes model the replayable native spool contract.
struct Replay<'a>(&'a [ObservedRow]);
impl audit::AuditInventory for Replay<'_> {
    fn visit(
        &self,
        callback: &mut dyn FnMut(&ObservedRow) -> Result<(), gateway_core::GatewayError>,
    ) -> Result<(), gateway_core::GatewayError> {
        for row in self.0 {
            let decoded = row.clone();
            callback(&decoded)?;
        }
        Ok(())
    }
}
fn inspect_key_pairs(
    rows: &[ObservedRow],
) -> Result<(Vec<audit::AuditedKeyPair>, audit::Audit), gateway_core::GatewayError> {
    let result = audit::inspect_key_pairs(rows);
    let replay = audit::inspect_inventory(&Replay(rows), 1000);
    match (&result, replay) {
        (Ok((_, expected)), Ok(actual)) => {
            for (key, count) in &expected.counts {
                assert_eq!(actual.counts.get(key), Some(count));
            }
            assert!(actual.errors.starts_with(&expected.errors));
        }
        (Err(expected), Err(actual)) => assert_eq!(format!("{expected:?}"), format!("{actual:?}")),
        (Ok(_), Err(error)) => panic!("replayed key audit differed: {error:?}"),
        (Err(_), Ok(_)) => panic!("replayed key error was lost"),
    }
    result
}
