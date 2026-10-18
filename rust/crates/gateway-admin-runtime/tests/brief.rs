use gateway_admin_runtime::{brief::*, capabilities::SupervisorBriefTarget};
use gateway_core::redaction::{redact, redact_parts};
use serde_json::{Value, json};
fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/supervisor-portable-golden.json")).unwrap()
}
#[test]
fn shared_frozen_redaction_matches_native_source_corpus() {
    let value = golden();
    for case in value["redaction"].as_array().unwrap() {
        let result = redact(case["input"].as_str().unwrap());
        assert_eq!(result.text, case["expected"]["text"]);
        assert_eq!(
            result.redactions,
            case["expected"]["redactions"].as_u64().unwrap() as usize
        );
    }
    for case in value["parts"].as_array().unwrap() {
        let parts: Vec<String> = serde_json::from_value(case["input"].clone()).unwrap();
        let results = redact_parts(&parts);
        assert_eq!(
            json!(
                results
                    .iter()
                    .map(|r| json!({"text":r.text,"redactions":r.redactions}))
                    .collect::<Vec<_>>()
            ),
            case["expected"]
        );
    }
}
#[test]
fn private_native_context_produces_exact_source_prompt_request_and_output() {
    let value = golden();
    let context: BriefContext = serde_json::from_value(value["prompt"]["context"].clone()).unwrap();
    assert_eq!(build_prompt(&context), value["prompt"]["expected"]);
    assert_eq!(request_body(&context), value["prompt"]["request"]);
    let sanitized: BriefContext =
        serde_json::from_value(value["prompt"]["sanitized"].clone()).unwrap();
    assert_eq!(
        build_prompt(&sanitized),
        value["prompt"]["sanitizedExpected"]
    );
    for case in value["outputs"].as_array().unwrap() {
        let actual = parse_output(&case["input"])
            .map(|p| json!({"about":p.about,"status":p.status}))
            .unwrap_or(Value::Null);
        assert_eq!(actual, case["expected"]);
    }
}
#[test]
fn no_transcript_returns_source_unavailable_metadata_and_no_model_request() {
    let value = golden();
    let mut context: BriefContext =
        serde_json::from_value(value["prompt"]["context"].clone()).unwrap();
    context.transcript_available = false;
    context.turns.clear();
    match plan(&context, 1234, 5678) {
        BriefPlan::Unavailable(response) => {
            assert!(response["model"].is_null());
            assert!(response["effort"].is_null());
            assert_eq!(response["sampledAtMs"], 1234);
            assert_eq!(response["generatedAtMs"], 5678);
            assert!(response.get("turns").is_none());
            assert_eq!(response["transcript"]["available"], false);
        }
        BriefPlan::Generate { .. } => panic!("empty transcript must not call a provider"),
    };
    assert!(completed(&context, &json!({}), 1234, 5678).is_err());
    let target = SupervisorBriefTarget {
        source_id: "other".into(),
        thread_id: context.thread_id.clone(),
    };
    assert!(BriefContext::from_native(&serde_json::to_value(&context).unwrap(), &target).is_err());
}
