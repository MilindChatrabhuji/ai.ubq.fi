use gateway_core::provider::PaidProvider;
use gateway_providers::paid_lookup::*;
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/paid-lookup-golden.json")).unwrap()
}
fn lookup(id: &str) -> OpenluxLookup {
    match plan_lookup(PaidProvider::Metered, Some(id), 100_000, 200_000).unwrap() {
        LookupPlan::Openlux(plan) => plan,
        _ => panic!("fixture requires OpenLux lookup"),
    }
}
fn source_row(row: TokenLog) -> Value {
    let mut value = json!({"request_id":row.request_id,"quota":row.quota as i64,"prompt_tokens":row.prompt_tokens,"completion_tokens":row.completion_tokens,"model":row.model,"created_at":row.created_at});
    if let Some(cached) = row.cached_prompt_tokens {
        value["cached_prompt_tokens"] = json!(cached);
    }
    if let Some(write) = row.cache_write_prompt_tokens {
        value["cache_write_prompt_tokens"] = json!(write);
    }
    value
}

#[test]
fn exact_source_log_normalization_preserves_numeric_and_cache_contracts() {
    let corpus = golden();
    for case in corpus["logs"].as_array().unwrap() {
        let result = normalize_token_log(&case["raw"])
            .map(source_row)
            .unwrap_or(Value::Null);
        assert_eq!(result, case["expected"], "{}", case["name"]);
    }
}

#[test]
fn fixed_query_matches_source_time_rounding_and_encodes_only_owned_key() {
    for case in golden()["queries"].as_array().unwrap() {
        let LookupPlan::Openlux(plan) = plan_lookup(
            PaidProvider::Metered,
            Some("wanted"),
            case["created_at_ms"].as_i64().unwrap(),
            case["now_ms"].as_i64().unwrap(),
        )
        .unwrap() else {
            panic!("lookup expected");
        };
        let request = plan
            .next_request(case["key"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(request.url(), case["expected_url"].as_str().unwrap());
        assert_eq!(request.method(), "GET");
        assert_eq!(request.page(), 1);
        assert!(!request.follow_redirects());
        assert_eq!(
            request.headers().get("Accept").map(String::as_str),
            Some("application/json")
        );
        assert!(!request.headers().contains_key("Authorization"));
    }
}

#[test]
fn source_page_scenarios_match_last_valid_row_and_unresolved_outcomes() {
    for case in golden()["scenarios"].as_array().unwrap() {
        let mut plan = lookup("wanted");
        let mut count = 0;
        let mut selected = Value::Null;
        let mut error = Value::Null;
        for _ in 0..=MAX_PAGES {
            let request = plan
                .next_request("billing-fixture")
                .unwrap()
                .expect("unfinished lookup needs a page");
            count += 1;
            let body = if case.get("raw").is_some() {
                None
            } else {
                case.get("repeat").or_else(|| {
                    case.get("pages")
                        .and_then(Value::as_array)
                        .and_then(|pages| pages.get(count - 1))
                })
            };
            match plan.accept_page(
                &request,
                case["status"].as_u64().unwrap_or(200) as u16,
                body,
            ) {
                Ok(LookupStep::Continue) => {}
                Ok(LookupStep::Complete(row)) => {
                    selected = row.map(source_row).unwrap_or(Value::Null);
                    break;
                }
                Err(failure) => {
                    error = json!(failure.envelope.error.code);
                    break;
                }
            }
        }
        assert_eq!(
            count,
            case["expected"]["calls"].as_u64().unwrap() as usize,
            "{}",
            case["name"]
        );
        assert_eq!(selected, case["expected"]["selected"], "{}", case["name"]);
        assert_eq!(error, case["expected"]["error"], "{}", case["name"]);
        assert!(plan.next_request("billing-fixture").unwrap().is_none());
        assert_eq!(case["expected"]["signal_count"], 1);
    }
    assert_eq!(
        OVERALL_TIMEOUT_MS,
        golden()["overall_timeout_ms"].as_u64().unwrap()
    );
}

#[test]
fn unsupported_provider_and_missing_reference_never_create_http_or_zero_cost() {
    assert!(matches!(
        plan_lookup(PaidProvider::Surplus, Some("wanted"), 0, 0).unwrap(),
        LookupPlan::NoLookup(NoLookupReason::SurplusTerminalUsageOnly)
    ));
    for id in [None, Some(""), Some(" \u{feff}\u{00a0} ")] {
        assert!(matches!(
            plan_lookup(PaidProvider::Metered, id, 0, 0).unwrap(),
            LookupPlan::NoLookup(NoLookupReason::MissingProviderRequestId)
        ));
    }
    let plan = lookup("wanted");
    assert!(plan.next_request(" \u{feff} ").is_err());
    assert!(plan_lookup(PaidProvider::Metered, Some("wanted"), -1, 0).is_err());
    assert!(
        plan_lookup(
            PaidProvider::Metered,
            Some("wanted"),
            0,
            9_007_199_254_740_992
        )
        .is_err()
    );
}

#[test]
fn page_request_cannot_correlate_another_attempt_and_debug_redacts_secret_url() {
    let mut first = lookup("wanted");
    let second = lookup("another");
    let request = second
        .next_request("billing-fixture-canary")
        .unwrap()
        .unwrap();
    assert!(
        first
            .accept_page(&request, 200, Some(&json!({"success":true,"data":[]})))
            .is_err()
    );
    let debug = format!("{request:?}");
    assert!(!debug.contains("billing-fixture-canary"));
    assert!(!debug.contains("key="));
    assert!(!debug.contains(request.url()));
    assert!(debug.contains("[redacted]"));
}

#[test]
fn explicit_zero_is_matched_evidence_and_malformed_zero_is_not() {
    let mut plan = lookup("wanted");
    let request = plan.next_request("billing-fixture").unwrap().unwrap();
    let valid = json!({"request_id":"wanted","quota":0,"prompt_tokens":0,"completion_tokens":0,"model_name":"claude-opus","created_at":0,"other":{"claude":true,"cache_tokens":0,"cache_creation_tokens":0}});
    let LookupStep::Complete(Some(row)) = plan
        .accept_page(&request, 200, Some(&json!({"success":true,"data":[valid]})))
        .unwrap()
    else {
        panic!("explicit zero is authoritative");
    };
    assert_eq!(row.quota, 0.0);
    assert_eq!(row.cached_prompt_tokens, Some(0));
    assert_eq!(row.cache_write_prompt_tokens, Some(0));
    for quota in [Value::Null, json!("0"), json!(false), json!(-1)] {
        let row = json!({"request_id":"wanted","quota":quota,"prompt_tokens":0,"completion_tokens":0,"model_name":"gpt-test","created_at":0});
        assert!(normalize_token_log(&row).is_none());
    }
}
