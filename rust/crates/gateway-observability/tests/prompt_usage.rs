use gateway_core::{source_json::SourceJson, source_usage::extract_source_usage_tokens};
use gateway_observability::prompt::PromptEvent;
use serde_json::{Value, json};

fn event() -> PromptEvent {
    PromptEvent {
        provider: Some("chatgpt_codex".into()),
        model: Some("model".into()),
        route: "responses".into(),
        status: 200,
        completed: true,
        usage_telemetry_status: "reported".into(),
        input_tokens: Some(99),
        cached_input_tokens: Some(99),
        cache_write_input_tokens: Some(99),
        cache_write_tokens_present: true,
        prompt_cache_key_present: true,
        prompt_cache_mode: Some("explicit".into()),
        fallback_reason: None,
    }
}
#[test]
fn all_source_fixtures_map_without_reinterpreting_or_inventing_usage() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../gateway-core/src/source_usage_cases.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 34);
    for case in cases {
        let raw = case["raw"]
            .as_str()
            .map(|raw| SourceJson::parse(raw).unwrap());
        let usage = extract_source_usage_tokens(raw.as_ref()).unwrap();
        let mut event = event();
        event.set_source_usage(usage.as_ref());
        let expected = &case["expected"];
        assert_eq!(
            event.usage_telemetry_status,
            expected["status"].as_str().unwrap_or("missing"),
            "{}",
            case["name"]
        );
        assert_eq!(
            event.input_tokens,
            expected["inputTokens"].as_u64(),
            "{}",
            case["name"]
        );
        assert_eq!(
            event.cached_input_tokens,
            expected["cachedInputTokens"].as_u64(),
            "{}",
            case["name"]
        );
        assert_eq!(
            event.cache_write_input_tokens,
            expected["cacheWriteInputTokens"].as_u64(),
            "{}",
            case["name"]
        );
        assert_eq!(
            event.cache_write_tokens_present,
            usage
                .as_ref()
                .is_some_and(|u| u.cache_write_input_tokens.is_some())
        );
        assert_eq!(event.provider.as_deref(), Some("chatgpt_codex"));
        assert!(event.completed);
        assert!(event.prompt_cache_key_present);
    }
}
#[test]
fn absent_usage_clears_prior_counts_and_explicit_null_stays_invalid() {
    let mut event = event();
    event.set_source_usage(None);
    assert_eq!(
        json!([
            event.usage_telemetry_status,
            event.input_tokens,
            event.cached_input_tokens,
            event.cache_write_input_tokens,
            event.cache_write_tokens_present
        ]),
        json!(["missing", null, null, null, false])
    );
    let usage = gateway_core::source_usage::extract_usage_tokens(Some(&Value::Null)).unwrap();
    event.set_source_usage(Some(&usage));
    assert_eq!(event.usage_telemetry_status, "invalid");
    assert_eq!(event.input_tokens, None);
}
