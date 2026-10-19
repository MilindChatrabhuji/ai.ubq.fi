//! Golden outputs captured from the current TypeScript source, with no provider I/O.
use gateway_authority::cache_experiment::{model::*, request_body};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "fixtures/cache-experiment-model-source-v1.json"
    ))
    .unwrap()
}
#[test]
fn source_target_binding_roundtrips_and_rejects_missing_nullable_unknown_or_blank_fields() {
    let fixture = fixture();
    for case in fixture["target_cases"].as_array().unwrap() {
        let parsed = serde_json::from_value::<TargetBinding>(case["input"].clone())
            .ok()
            .filter(|v| v.validate().is_ok());
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            case["expected"],
            "{}",
            case["input"]
        );
    }
}
#[test]
fn source_state_and_evidence_semantic_fences_match_the_actual_parsers() {
    let fixture = fixture();
    let now = fixture["now"].as_i64().unwrap();
    for case in fixture["state_cases"].as_array().unwrap() {
        let parsed = serde_json::from_value::<State>(case["input"].clone())
            .ok()
            .filter(|v| v.valid(now));
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            case["expected"],
            "state {}",
            case["input"]
        );
    }
    for case in fixture["evidence_cases"].as_array().unwrap() {
        let parsed = serde_json::from_value::<Evidence>(case["input"].clone())
            .ok()
            .filter(|v| v.valid(now));
        assert_eq!(
            serde_json::to_value(parsed).unwrap(),
            case["expected"],
            "evidence {}",
            case["input"]
        );
    }
}
#[test]
fn all_eight_scope_discriminator_combinations_match_source_without_guessing() {
    let fixture = fixture();
    for case in fixture["classifications"].as_array().unwrap() {
        let samples: Vec<Sample> = serde_json::from_value(case["samples"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(classify("fixture-model", &samples)).unwrap(),
            case["expected"]
        );
        for index in [2, 5, 7] {
            let mut mixed = samples.clone();
            mixed[index].usage.cached_tokens = 2_560;
            mixed[index].usage.cache_write_tokens = 2_560;
            mixed[index].raw_usage = mixed[index].usage.clone();
            assert!(classify("fixture-model", &mixed).is_none());
        }
        let mut drift = samples.clone();
        drift[4].usage.cached_tokens = 2_559;
        drift[4].raw_usage = drift[4].usage.clone();
        assert!(classify("fixture-model", &drift).is_none());
    }
}
#[test]
fn fixed_request_has_the_exact_source_input_prefix_and_wire_fields() {
    let actual: Value =
        serde_json::from_str(&request_body("fixture-model", "cycle-nonce", "cache-key")).unwrap();
    assert_eq!(actual, fixture()["request"]);
}
#[test]
fn safe_integer_json_floats_preserve_js_semantics_without_coercing_fractional_values() {
    let fixture = fixture();
    let mut state = fixture["state_cases"][0]["input"].clone();
    state["v"] = serde_json::json!(3.0);
    state["next_cycle"] = serde_json::json!(1.0);
    let parsed: State = serde_json::from_value(state.clone()).unwrap();
    assert!(parsed.valid(fixture["now"].as_i64().unwrap()));
    state["next_cycle"] = serde_json::json!(1.5);
    assert!(serde_json::from_value::<State>(state).is_err());
}
