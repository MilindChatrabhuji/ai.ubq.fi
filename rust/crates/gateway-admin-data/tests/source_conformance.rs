use gateway_admin_data::{profile, projection};
use serde_json::Value;

#[test]
fn profile_types_match_frozen_bun_source() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/profile-golden.json")).unwrap();
    assert_eq!(cases.len(), 53);
    for (index, case) in cases.iter().enumerate() {
        let decoded = profile::from_profile(&case["input"]);
        assert_eq!(decoded.is_ok(), case["ok"] == true, "profile {index}: {}: {decoded:?}", case["input"]);
        if let Ok(decoded) = decoded {
            assert_eq!(decoded.validate_for_storage().is_ok(), case["storage"] == true, "storage {index}");
            assert_eq!(profile::to_profile(&decoded).unwrap(), case["expected"], "profile round trip {index}: {}", case["input"]);
        }
    }
}

#[test]
fn quota_projections_match_frozen_bun_source() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/projection-golden.json")).unwrap();
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
        assert_eq!(projection::public_quota_view(&quota), case["expected"]["quota"], "quota {}", case["name"]);
        assert_eq!(serde_json::to_value(&usage).unwrap(), case["expected"]["usage"], "usage {}", case["name"]);
        assert_eq!(serde_json::to_value(&estimates).unwrap(), case["expected"]["estimates"], "estimates {}", case["name"]);
        let response = projection::project_quota(Some(rollups), snapshot, history, now, 7, str::cmp);
        assert_eq!(response["quota"], case["expected"]["quota"]);
        assert!(response["quota"].get("last_inferred_credit_quota").is_none());
    }
}

#[test]
fn profile_stream_keeps_typed_key_identity_and_never_treats_plain_objects_as_tags() {
    let line = r#"{"key":[{"type":"string","value":"default"},{"type":"bigint","value":"256"},{"type":"Uint8Array","value":"AAD_"}],"value":{"type":"object","value":{"type":{"type":"string","value":"Date"},"value":{"type":"string","value":"ordinary"}}},"versionstamp":"source-only"}"#;
    let entry = profile::normalize_import_line(line).unwrap().unwrap();
    assert_eq!(entry.key, "tuple-v1:0264656661756c74001601000100ff00ffff00");
    assert_eq!(entry.value.to_json_lossless().unwrap(), serde_json::json!({"type":"Date","value":"ordinary"}));
    assert!(profile::normalize_import_line(" \n").unwrap().is_none());
    assert!(profile::normalize_import_line(r#"{"key":[{"type":"Date","value":0}],"value":{"type":"null"}}"#).is_err());
    assert!(profile::normalize_import_line(r#"{"key":[],"value":{"type":"null"}}"#).is_err());
}
