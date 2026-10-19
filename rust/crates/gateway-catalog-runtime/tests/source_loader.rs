//! Actual source-aware provider parser output; no network or JavaScript projector.
use gateway_catalog_runtime::{CatalogProvider, providers};
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
fn parse(value: &str) -> SourceJson {
    SourceJson::parse(value).unwrap()
}
fn get(value: &SourceJson, key: &str) -> SourceJson {
    source::member(value, key).unwrap()
}
#[test]
fn openrouter_model_and_efforts_retain_units_and_do_not_coalesce_escape_text() {
    let input = parse(
        r#"{"data":[{"id":"\ud800","reasoning":{"supported_efforts":["\udc00","\\udc00","\udc00"],"default_effort":"\udc00","mandatory":true}},{"id":"\\ud800"}]}"#,
    );
    let original = input.clone();
    let (models, next) = providers::parse_page(CatalogProvider::Openrouter, &input).unwrap();
    assert_eq!(models.len(), 2);
    assert!(next.is_none());
    assert_eq!(
        source::string(&get(&models[0], "id")).unwrap().as_units(),
        &[0xd800]
    );
    let reasoning = get(&models[0], "reasoning");
    let levels = source::array(&get(&reasoning, "supported_efforts")).unwrap();
    assert_eq!(levels.len(), 2);
    assert_eq!(source::string(&levels[0]).unwrap().as_units(), &[0xdc00]);
    assert_eq!(
        source::string(&levels[1]).unwrap(),
        JsString16::from_utf8(r"\udc00")
    );
    assert_eq!(input, original);
    assert!(models[0].deserialize::<serde_json::Value>().is_err());
}
#[test]
fn claude_observed_effort_keys_and_cursor_keep_exact_units() {
    let input = parse(
        r#"{"data":[{"id":"claude-\ud800","display_name":"display\udc00","capabilities":{"thinking":{"types":{"adaptive":{"supported":true}}},"effort":{"supported":true,"none":{"supported":true},"\udc00":{"supported":true},"\\udc00":{"supported":true}}}}],"has_more":true,"last_id":"cursor\ud800"}"#,
    );
    let (models, next) = providers::parse_page(CatalogProvider::ClaudeCode, &input).unwrap();
    assert_eq!(models.len(), 1);
    let levels = source::array(&get(&models[0], "supported_reasoning_levels")).unwrap();
    assert_eq!(levels.len(), 2);
    assert_eq!(source::string(&levels[0]).unwrap().as_units(), &[0xdc00]);
    assert_eq!(
        next.unwrap(),
        JsString16::from_units("cursor".encode_utf16().chain([0xd800]).collect())
    );
    assert_eq!(
        source::string(&get(&models[0], "display_name")).unwrap(),
        JsString16::from_units("display".encode_utf16().chain([0xdc00]).collect())
    );
}
#[test]
fn scalar_surplus_prices_and_source_text_filter_are_unchanged() {
    let input = parse(
        r#"{"data":[{"id":" image-only ","architecture":{"input_modalities":["image"],"output_modalities":["image"]}},{"id":" scalar ","supported_parameters":["tools","tool_choice"],"supported_features":["tools"],"pricing":{"prompt":"0x10","completion":"0.25"}}]}"#,
    );
    let (models, next) = providers::parse_page(CatalogProvider::Surplus, &input).unwrap();
    assert!(next.is_none());
    assert_eq!(models.len(), 1);
    let row: serde_json::Value = models[0].deserialize().unwrap();
    assert_eq!(row["id"], "scalar");
    assert_eq!(row["input_price_per_token"], 16.0);
    assert_eq!(row["output_price_per_token"], 0.25);
    assert_eq!(row["supports_tools"], true);
}

#[test]
fn metadata_join_uses_the_shared_contextual_lowercase_and_preserves_opaque_exact_tiers() {
    use gateway_core::model::ModelId;
    let rows = vec![
        parse(r#"{"id":"vendor/ΟΣ\ud800","context_window_tokens":10}"#),
        parse(r#"{"id":"vendor/other\udc00","context_window_tokens":20}"#),
    ];
    let id = ModelId::from_source(JsString16::from_units(
        "vendor/ος".encode_utf16().chain([0xd800]).collect(),
    ));
    assert_eq!(providers::match_openrouter(&rows, &id), Some(&rows[0]));
    assert!(providers::match_openrouter(&rows, &r"vendor/ος\ud800".into()).is_none());
    let ambiguous = vec![parse(r#"{"id":"a/model"}"#), parse(r#"{"id":"b/model"}"#)];
    assert!(providers::match_openrouter(&ambiguous, &"model".into()).is_none());
    assert_eq!(
        providers::match_openrouter(&ambiguous, &"a/model".into()),
        Some(&ambiguous[0])
    );
}
