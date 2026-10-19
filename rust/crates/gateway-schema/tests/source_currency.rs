use gateway_schema::{catalog::*, metadata::MetadataHint};
use serde_json::{Value, json};
#[path = "support/source_catalog.rs"]
mod support;

#[test]
fn configured_deepseek_replaces_same_id_at_original_slot_and_preserves_envelope() {
    let mut input = CatalogInput::default();
    input.providers.insert(
        "deepseek".into(),
        ProviderCatalog {
            configured: true,
            available: true,
            ..Default::default()
        },
    );
    let stored = json!({"future":"kept","models":[{"slug":"other","future":1},{"slug":" deepseek-v4-flash ","future":2},{"slug":"\u{00a0}","id":"\u{feff} deepseek-flash ","future":3}]});
    let output = native_catalog(Some(&support::json(&stored)), &input)
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(output["future"], "kept");
    assert_eq!(output["models"][0], stored["models"][0]);
    for (index, id) in [(1, "deepseek-v4-flash"), (2, "deepseek-flash")] {
        let row = &output["models"][index];
        assert_eq!(row["slug"], id);
        assert!(row.get("future").is_none());
        assert_eq!(row["default_reasoning_level"], "high");
        assert_eq!(
            row["supported_reasoning_levels"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["effort"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["none", "low", "high", "max"]
        );
    }
    assert_eq!(
        output["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["slug"] == "deepseek-flash")
            .count(),
        1
    );
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/source-currency-golden.json")).unwrap();
    // The source oracle owns the official-row overlay. The full catalog also
    // adds its configured synthetic route, which remains present exactly once.
    assert_eq!(
        output["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["slug"] == "ubiquity/deepseek-flash")
            .count(),
        1
    );
    let observed=output["models"].as_array().unwrap().iter()
        .filter(|row| row["slug"] != "ubiquity/deepseek-flash")
        .map(|row|json!({"slug":row["slug"],"id":row["id"],"future":row["future"],"efforts":row["supported_reasoning_levels"].as_array().map(|levels|levels.iter().map(|l|l["effort"].clone()).collect::<Vec<_>>()),"default":row["default_reasoning_level"]})).collect::<Vec<_>>();
    assert_eq!(json!(observed), golden["native"]);
}

#[test]
fn public_provider_declaration_overwrites_discovery_enrichment_only_on_collision() {
    let mut input = CatalogInput::default();
    input.providers.insert(
        "deepseek".into(),
        ProviderCatalog {
            configured: true,
            available: true,
            ..Default::default()
        },
    );
    input.providers.insert("surplus".into(),ProviderCatalog{configured:true,available:true,models:vec![support::json(&json!({"id":"deepseek-v4-flash","created":123,"owned_by":"other","supported_endpoint_types":["openai-response"]})),support::json(&json!({"id":"unrelated","created":124,"owned_by":"other","supported_endpoint_types":["openai-response"]}))],..Default::default()});
    input.enrichment.insert(
        "deepseek-v4-flash".into(),
        MetadataHint::provider(1_048_576, &["third-party"], "third-party"),
    );
    input.enrichment.insert(
        "unrelated".into(),
        MetadataHint::provider(123_456, &["retained-custom"], "retained-custom"),
    );
    let output = build_catalog_snapshot(&input, &support::Collator::captured())
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    let rows = output["models"].as_array().unwrap();
    let collision = rows
        .iter()
        .find(|r| r["id"] == "deepseek-v4-flash")
        .unwrap();
    assert_eq!(
        collision["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["surplus", "deepseek"]
    );
    assert_eq!(collision["created"], 123);
    assert_eq!(collision["context_window_tokens"], 1_000_000);
    assert_eq!(
        collision["supported_reasoning_levels"],
        json!(["none", "low", "high", "max"])
    );
    assert_eq!(collision["default_reasoning_effort"], "high");
    assert_eq!(collision["context_source"], "provider_discovery");
    assert_eq!(collision["reasoning_source"], "provider_discovery");
    let unrelated = rows.iter().find(|r| r["id"] == "unrelated").unwrap();
    assert_eq!(unrelated["context_window_tokens"], 123_456);
    assert_eq!(unrelated["default_reasoning_effort"], "retained-custom");
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/source-currency-golden.json")).unwrap();
    for (field, value) in golden["collision"].as_object().unwrap() {
        if field != "providers" {
            assert_eq!(&collision[field], value, "{field}");
        }
    }
}
