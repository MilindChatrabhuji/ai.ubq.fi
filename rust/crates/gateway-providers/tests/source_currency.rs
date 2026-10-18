use gateway_core::provider::UpstreamProvider;
use gateway_providers::{ChatProfile, ClientSurface, PrepareOptions, chat, prepare_request};
use serde_json::{Value, json};

#[test]
fn ba5ef_source_projection_vectors_match() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/source-currency-golden.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let projection =
            chat::project_responses(&case["raw"], "deepseek-flash", false, ChatProfile::Deepseek)
                .unwrap();
        let body = &projection.body;
        let observed = match case["select"].as_str().unwrap() {
            "reasoning" => json!(
                body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["role"] == "assistant")
                    .map(|m| m.get("reasoning_content").cloned().unwrap_or(Value::Null))
                    .collect::<Vec<_>>()
            ),
            "tools" => {
                json!({"tool_choice":body["tool_choice"],"names":body["tools"].as_array().unwrap().iter().map(|t|t["function"]["name"].clone()).collect::<Vec<_>>()})
            }
            "sampling" => {
                json!({"effort":body.get("reasoning_effort").cloned().unwrap_or(Value::Null),"temperature":body.get("temperature").cloned().unwrap_or(Value::Null),"top_p":body.get("top_p").cloned().unwrap_or(Value::Null),"warnings":projection.warnings})
            }
            other => panic!("unknown vector selector {other}"),
        };
        assert_eq!(observed, case["expected"], "{}", case["name"]);
    }
}

#[test]
fn prepared_provider_wire_keeps_source_sampling_warnings_and_zero() {
    let raw = json!({"model":"deepseek-flash","input":"sample","temperature":0,"top_p":0.5});
    let prepared = prepare_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &PrepareOptions::default(),
    )
    .unwrap();
    assert_eq!(
        prepared.warnings,
        vec!["temperature_ignored", "top_p_ignored"]
    );
    assert!(prepared.body.get("temperature").is_none());
    let mut disabled = raw;
    disabled["thinking"] = json!({"type":" DISABLED "});
    let prepared = prepare_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &disabled,
        &PrepareOptions::default(),
    )
    .unwrap();
    assert_eq!(prepared.body["reasoning_effort"], "none");
    assert_eq!(prepared.body["temperature"], 0);
    assert_eq!(prepared.body["top_p"], 0.5);
    assert!(prepared.warnings.is_empty());
    let mut lithos = disabled;
    lithos["model"] = json!("deepseek-ai/DeepSeek-V4.1-Flash");
    lithos.as_object_mut().unwrap().remove("thinking");
    let prepared = prepare_request(
        UpstreamProvider::Lithos,
        ClientSurface::Responses,
        &lithos,
        &PrepareOptions::default(),
    )
    .unwrap();
    assert_eq!(prepared.body["temperature"], 0);
    assert!(prepared.warnings.is_empty());
}

#[test]
fn lithos_tier_windows_use_same_case_and_trim_identity_as_dispatch() {
    use gateway_providers::policy::{LithosWindows, lithos_ladder};
    assert_eq!(
        lithos_ladder("  DEEPSEEK-AI/deepseek-v4.1-flash-ULTRA "),
        vec![
            "deepseek-ai/DeepSeek-V4.1-Flash-fast",
            "deepseek-ai/DeepSeek-V4.1-Flash"
        ]
    );
    let mut windows = LithosWindows::default();
    windows.refuse(" DEEPSEEK-AI/DeepSeek-V4.1-FLASH-ultra ", 1000, 500);
    assert_eq!(
        windows.select("deepseek-ai/deepseek-v4.1-flash-ultra", 1200),
        "deepseek-ai/DeepSeek-V4.1-Flash-fast"
    );
    assert_eq!(
        windows.select("deepseek-ai/deepseek-v4.1-flash-ultra", 1500),
        "deepseek-ai/DeepSeek-V4.1-Flash-ultra"
    );
}
