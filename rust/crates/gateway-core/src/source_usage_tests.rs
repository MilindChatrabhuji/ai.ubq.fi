use super::*;
use serde_json::json;

#[test]
fn frozen_bun_source_fixtures_share_one_engine() {
    // Actual pinned Bun 1.4.0 source extractUsageTokens oracle, 2026-10-19.
    // Function/helper text copied verbatim from src/openai-telemetry.ts and utils.ts.
    let cases: Vec<Value> = serde_json::from_str(include_str!("source_usage_cases.json")).unwrap();
    assert_eq!(cases.len(), 34);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let source = case["raw"]
            .as_str()
            .map(|raw| SourceJson::parse(raw).unwrap());
        let actual = extract_source_usage_tokens(source.as_ref()).unwrap();
        assert_eq!(
            serde_json::to_value(&actual).unwrap(),
            case["expected"],
            "{name}"
        );
        if let Some(source) = source {
            if let Ok(value) = source.deserialize::<Value>() {
                assert_eq!(
                    extract_usage_tokens(Some(&value)),
                    actual,
                    "{name}: value frontend"
                );
            }
        } else {
            assert_eq!(extract_usage_tokens(None), None);
        }
    }
}
#[test]
fn provenance_never_invents_present_cache_write_or_buyer_charge() {
    let usage = json!({"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":0}});
    let absent = extract_usage_tokens(Some(&usage)).unwrap();
    assert_eq!(absent.status, UsageStatus::Reported);
    assert!(!absent.cache_write_tokens_present());
    assert_eq!(absent.cache_write_input_tokens, None);
    assert_eq!(absent.buyer_cost_micro, None);
    let mut present = usage;
    present["input_tokens_details"]["cache_write_tokens"] = Value::Null;
    present["buyer_cost_micro"] = json!("invalid");
    let present = extract_usage_tokens(Some(&present)).unwrap();
    assert_eq!(present.status, UsageStatus::Invalid);
    assert!(present.cache_write_tokens_present());
    assert_eq!(present.cache_write_input_tokens, None);
    assert_eq!(present.buyer_cost_micro, Some(None));
}
#[test]
fn invalid_buyer_charge_does_not_reclassify_reported_usage() {
    let usage = json!({"input_tokens":10,"output_tokens":2,"total_tokens":12,"input_tokens_details":{"cached_tokens":0},"buyer_cost_micro":-1});
    let actual = extract_usage_tokens(Some(&usage)).unwrap();
    assert_eq!(actual.status, UsageStatus::Reported);
    assert_eq!(actual.buyer_cost_micro, Some(None));
    assert_eq!(actual.status.as_str(), "reported");
}
