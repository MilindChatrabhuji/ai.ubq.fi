use gateway_admin_data::{profile, projection};
use serde_json::Value;

// Both wire formats use JavaScript numbers. Integer/f64 JSON representations
// compare at the exact f64 value, with no rounding tolerance.
fn assert_source(actual: &Value, expected: &Value, context: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            assert_eq!(a.as_f64(), b.as_f64(), "{context}");
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{context}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_source(a, b, &format!("{context}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{context}");
            for (key, b) in b {
                let a = a
                    .get(key)
                    .unwrap_or_else(|| panic!("{context}.{key} missing"));
                assert_source(a, b, &format!("{context}.{key}"));
            }
        }
        _ => assert_eq!(actual, expected, "{context}"),
    }
}

#[test]
fn kernel_policy_normalization_matches_frozen_bun_source() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/kernel-policy-golden.json")).unwrap();
    assert_eq!(cases.len(), 30);
    for case in cases {
        let result = gateway_admin_data::migration::kernel::normalize_policy(
            &case["value"],
            case["scope"].as_str().unwrap(),
            case["owner"].as_str().unwrap(),
            case["repo"].as_str(),
        );
        assert_source(
            &result.unwrap_or(Value::Null),
            &case["expected"],
            &case.to_string(),
        );
    }
}

#[test]
fn profile_types_match_frozen_bun_source() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/profile-golden.json")).unwrap();
    assert_eq!(cases.len(), 53);
    for (index, case) in cases.iter().enumerate() {
        let decoded = profile::from_profile(&case["input"]);
        assert_eq!(
            decoded.is_ok(),
            case["ok"] == true,
            "profile {index}: {}: {decoded:?}",
            case["input"]
        );
        if let Ok(decoded) = decoded {
            assert_eq!(
                decoded.validate_for_storage().is_ok(),
                case["storage"] == true,
                "storage {index}"
            );
            assert_eq!(
                profile::to_profile(&decoded).unwrap(),
                case["expected"],
                "profile round trip {index}: {}",
                case["input"]
            );
        }
    }
}

#[test]
fn quota_projections_match_frozen_bun_source() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/projection-golden.json")).unwrap();
    assert_eq!(cases.len(), 11);
    for case in cases {
        let snapshot = (!case["snapshot"].is_null()).then_some(&case["snapshot"]);
        let rollups = case["rollups"].as_array().unwrap();
        let history = case["history"].as_array().map(Vec::as_slice);
        let now = case["now"].as_f64().unwrap();
        let quota = projection::metered_quota_runway_view(snapshot);
        let groups = projection::group_paid_fallback_usage_rollups(rollups, str::cmp);
        let usage = projection::summarize_paid_fallback_usage(&groups, now);
        let estimates = projection::project_paid_fallback_runway(&usage[0], &quota, now, history);
        let context = case["name"].to_string();
        assert_source(
            &projection::public_quota_view(&quota),
            &case["expected"]["quota"],
            &context,
        );
        assert_source(
            &serde_json::to_value(&usage).unwrap(),
            &case["expected"]["usage"],
            &context,
        );
        assert_source(
            &serde_json::to_value(&estimates).unwrap(),
            &case["expected"]["estimates"],
            &context,
        );
        let response =
            projection::project_quota(Some(rollups), snapshot, history, now, 7, str::cmp);
        assert_eq!(response["quota"], case["expected"]["quota"]);
        assert!(
            response["quota"]
                .get("last_inferred_credit_quota")
                .is_none()
        );
    }
}

#[test]
fn profile_stream_keeps_typed_key_identity_and_never_treats_plain_objects_as_tags() {
    let line = r#"{"key":[{"type":"string","value":"default"},{"type":"bigint","value":"256"},{"type":"Uint8Array","value":"AAD_"}],"value":{"type":"object","value":{"type":{"type":"string","value":"Date"},"value":{"type":"string","value":"ordinary"}}},"versionstamp":"source-only"}"#;
    let entry = profile::normalize_import_line(line).unwrap().unwrap();
    assert_eq!(
        entry.key.0,
        "tuple-v1:0264656661756c74001601000100ff00ffff00"
    );
    assert_eq!(
        entry.value.to_json_lossless().unwrap(),
        serde_json::json!({"type":"Date","value":"ordinary"})
    );
    assert!(profile::normalize_import_line(" \n").unwrap().is_none());
    assert!(
        profile::normalize_import_line(
            r#"{"key":[{"type":"Date","value":0}],"value":{"type":"null"}}"#
        )
        .is_err()
    );
    assert!(profile::normalize_import_line(r#"{"key":[],"value":{"type":"null"}}"#).is_err());
}
