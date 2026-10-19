#[path = "support/source_projection.rs"]
mod source_fixture;
use gateway_admin_data::projection::{project_quota, project_quota_source};
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::aliases::SourceStringCollator;
use serde_json::Value;
use source_fixture::{CapturedCollator, assert_source_eq, fixture};
struct NoComparisons;
impl SourceStringCollator for NoComparisons {
    fn compare(
        &self,
        _left: &JsString16,
        _right: &JsString16,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        Err(GatewayError::unavailable(
            "No comparison was expected.",
            "fixture_collation_missing",
        ))
    }
}
#[test]
fn source_labels_nul_groups_unknown_providers_and_numeric_outputs_match_actual_bun() {
    let data = fixture();
    let rows = source::member(&data, "rows")
        .unwrap()
        .array_items()
        .unwrap();
    let now = source::number(&source::member(&data, "now").unwrap()).unwrap();
    let actual =
        project_quota_source(Some(&rows), None, None, now, 30, &CapturedCollator::new()).unwrap();
    let expected = source::member(&data, "expected").unwrap();
    assert_source_eq(&actual, &expected);
    assert!(actual.deserialize::<Value>().is_err());
}
#[test]
fn scalar_frontend_and_source_frontend_share_all_eleven_frozen_numeric_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/projection-golden.json")).unwrap();
    assert_eq!(cases.len(), 11);
    for case in cases {
        let snapshot = (!case["snapshot"].is_null()).then_some(&case["snapshot"]);
        let rollups = case["rollups"].as_array().unwrap();
        let history = case["history"].as_array().map(Vec::as_slice);
        let now = case["now"].as_f64().unwrap();
        let rows = rollups
            .iter()
            .map(SourceJson::from_serializable)
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let expected = project_quota(Some(rollups), snapshot, history, now, 7, str::cmp);
        let actual =
            project_quota_source(Some(&rows), snapshot, history, now, 7, &NoComparisons).unwrap();
        assert_eq!(
            actual.deserialize::<Value>().unwrap(),
            expected,
            "{}",
            case["name"]
        );
        assert!(
            expected["quota"]
                .get("last_inferred_credit_quota")
                .is_none()
        );
    }
}
#[test]
fn source_comparison_errors_escape_and_absent_scan_is_not_successful_empty_scan() {
    let data = fixture();
    let rows = source::member(&data, "rows")
        .unwrap()
        .array_items()
        .unwrap();
    let now = source::number(&source::member(&data, "now").unwrap()).unwrap();
    assert!(project_quota_source(Some(&rows[..2]), None, None, now, 30, &NoComparisons).is_err());
    let mut unknown = source::entries(&rows[0]).unwrap();
    let model = JsString16::from_units(vec![0xe000]);
    unknown
        .iter_mut()
        .find(|(key, _)| key.as_units().iter().copied().eq("model".encode_utf16()))
        .unwrap()
        .1 = model.to_source_json().unwrap();
    let unknown = source::object_keys(unknown).unwrap();
    assert!(
        project_quota_source(
            Some(&[rows[0].clone(), unknown.clone()]),
            None,
            None,
            now,
            30,
            &CapturedCollator::new()
        )
        .is_err()
    );
    assert!(project_quota_source(Some(&[unknown]), None, None, now, 30, &NoComparisons).is_ok());
    for (rows, status) in [(None, "unavailable"), (Some(&[][..]), "ok")] {
        let output = project_quota_source(rows, None, None, now, 30, &NoComparisons).unwrap();
        assert_eq!(
            source::member(&output, "rollup_scan")
                .unwrap()
                .deserialize::<String>()
                .unwrap(),
            status
        );
        assert!(
            source::member(&output, "models")
                .unwrap()
                .array_items()
                .unwrap()
                .is_empty()
        );
    }
}
