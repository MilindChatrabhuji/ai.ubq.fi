use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::prompt_cache::*;
fn raw(value: &str) -> SourceJson {
    SourceJson::parse(value).unwrap()
}
#[test]
fn opaque_provider_ids_and_source_scope_models_are_lossless() {
    let scope = source::object(vec![
        (
            "probe_profile",
            SourceJson::from_serializable(SCOPE_PROFILE).unwrap(),
        ),
        ("account_slots", raw("\"shared\"")),
        ("token_refresh", raw("\"preserved\"")),
        ("conversation_id", raw("\"independent\"")),
        (
            "effective_model",
            source::quoted(&JsString16::from_units(vec![0xd800])).unwrap(),
        ),
        ("reproducible_cycles", raw("3")),
        ("source", raw("\"live_probe\"")),
        ("verified_at_ms", raw("100")),
    ])
    .unwrap();
    let normalized = normalize_scope_source(&scope).unwrap();
    assert!(concrete_scope_source(&normalized, 3));
    assert_eq!(
        source::string(&source::member(&normalized, "effective_model").unwrap())
            .unwrap()
            .as_units(),
        &[0xd800]
    );
    let provider = source::object(vec![
        (
            "id",
            source::quoted(&JsString16::from_units(vec![0xdfff])).unwrap(),
        ),
        ("scope", scope),
    ])
    .unwrap();
    let cap = source::object(vec![
        ("version", raw("1")),
        ("providers", source::json_array(&[provider]).unwrap()),
    ])
    .unwrap();
    let normalized = normalize_capabilities_source(Some(&cap)).unwrap();
    let providers = source::array(&source::member(&normalized, "providers").unwrap()).unwrap();
    assert_eq!(
        source::string(&source::member(&providers[0], "id").unwrap())
            .unwrap()
            .as_units(),
        &[0xdfff]
    );
}
#[test]
fn merging_is_by_exact_source_provider_identity_not_replacement_text() {
    let previous = raw(
        r#"{"version":1,"providers":[{"id":"\ud800","controls":{"key":false,"source":"catalog","verified_at_ms":1}},{"id":"�","controls":{"key":true,"source":"catalog","verified_at_ms":1}}]}"#,
    );
    let next = raw(r#"{"version":1,"providers":[{"id":"\ud800"}]}"#);
    let merged = merge_capabilities_source(Some(&previous), Some(&next)).unwrap();
    let providers = source::array(&source::member(&merged, "providers").unwrap()).unwrap();
    assert_eq!(providers.len(), 2);
    assert_eq!(
        source::string(&source::member(&providers[0], "id").unwrap())
            .unwrap()
            .as_units(),
        &[0xd800]
    );
    assert_eq!(
        source::member(&source::member(&providers[0], "controls").unwrap(), "key")
            .unwrap()
            .as_str(),
        "false"
    );
    assert_eq!(
        source::string(&source::member(&providers[1], "id").unwrap())
            .unwrap()
            .as_units(),
        &[0xfffd]
    );
}
#[test]
fn compact_source_keeps_controls_and_scalar_wrappers_match_actual_source() {
    let value = serde_json::json!({"version":1,"providers":[{"id":"codex_chatgpt","controls":{"key":true,"source":"catalog","verified_at_ms":1}}]});
    let source = SourceJson::from_serializable(&value).unwrap();
    assert_eq!(
        normalize_capabilities(Some(&value)).unwrap(),
        normalize_capabilities_source(Some(&source))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap()
    );
    assert_eq!(
        compact_capabilities(Some(&value)).unwrap(),
        compact_capabilities_source(Some(&source))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap()
    );
    let opaque = raw(
        r#"{"version":1,"providers":[{"id":"\ud800","controls":{"key":true,"source":"catalog","verified_at_ms":1}}]}"#,
    );
    let compact = compact_capabilities_source(Some(&opaque)).unwrap();
    let providers = source::array(&source::member(&compact, "providers").unwrap()).unwrap();
    assert_eq!(
        source::string(&source::member(&providers[0], "id").unwrap())
            .unwrap()
            .as_units(),
        &[0xd800]
    );
}
#[test]
fn malformed_opaque_metadata_is_unknown_without_erasing_valid_opaque_labels() {
    assert!(
        normalize_capabilities_source(Some(&raw(
            r#"{"version":1,"providers":[{"id":"\ud800"},{"id":"\ud800"}]}"#
        )))
        .is_none()
    );
    assert!(
        normalize_capabilities_source(Some(&raw(
            r#"{"version":1,"providers":[{"id":"x","\ud800":true}]}"#
        )))
        .is_none()
    );
    assert!(
        normalize_capabilities_source(Some(&raw(
            r#"{"version":1,"providers":[{"id":"\ud800"},{"id":"�"}]}"#
        )))
        .is_some()
    );
}
