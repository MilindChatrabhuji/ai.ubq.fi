#[path = "support/source_catalog.rs"]
mod support;
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, source_json::SourceJson,
    source_serialization as source,
};
use gateway_schema::{
    aliases::SourceStringCollator, catalog::*, metadata::MetadataHint, selection::ModelWhitelist,
    snapshot::ModelSnapshot,
};
use support::*;

fn document(value: &str) -> SourceJson {
    SourceJson::parse(value).unwrap()
}
fn member(value: &SourceJson, key: &str) -> SourceJson {
    source::member(value, key).unwrap()
}
fn rows(value: &SourceJson, key: &str) -> Vec<SourceJson> {
    source::array(&member(value, key)).unwrap()
}
fn units(value: &SourceJson) -> Vec<u16> {
    value.deserialize::<JsString16>().unwrap().into_units()
}

fn snapshot(models: Vec<gateway_core::source_json::SourceJson>) -> ModelSnapshot {
    ModelSnapshot {
        models,
        source: "codex_cli".into(),
        updated_at_ms: 1000,
        client_version: Some("0.163.0".into()),
    }
}
#[test]
fn ordinary_native_and_capability_views_keep_opaque_model_effort_and_unknown_fields() {
    let model = document(
        r#"{"slug":"\ud800","display_name":"name\udc00","supported_reasoning_levels":["\udc00"],"default_reasoning_level":"\udc00","reasoning_effort_wire_map":{"\udc00":"\ud800"}}"#,
    );
    let input = CatalogInput {
        snapshot: Some(snapshot(vec![model])),
        ..Default::default()
    };
    let ordinary = ordinary_models(&input);
    let ordinary = rows(&ordinary, "data");
    assert_eq!(ordinary.len(), 1);
    assert_eq!(units(&member(&ordinary[0], "id")), [0xd800]);
    assert_eq!(ordinary[0].object_entries().unwrap().len(), 4);
    let capability = rows(&capabilities(&input), "data").remove(0);
    assert_eq!(units(&member(&capability, "id")), [0xd800]);
    assert_eq!(
        units(&member(&capability, "default_reasoning_effort")),
        [0xdc00]
    );
    let levels = rows(&capability, "supported_reasoning_levels");
    assert_eq!(units(&levels[0]), [0xdc00]);
    let wire = member(&capability, "reasoning_effort_wire_map")
        .object_entries()
        .unwrap();
    assert_eq!(wire[0].0.as_units(), [0xdc00]);
    assert_eq!(units(&wire[0].1), [0xd800]);
    let stored = document(
        r#"{"future":{"\ud800":"\udc00"},"models":[{"slug":"\ud800","future":{"\udc00":"\ud800"}}]}"#,
    );
    let native = native_catalog(Some(&stored), &input);
    assert_eq!(member(&native, "future"), member(&stored, "future"));
    assert_eq!(rows(&native, "models"), rows(&stored, "models"));
    assert!(
        native.deserialize::<serde_json::Value>().is_err(),
        "opaque strings must not silently become Value"
    );
}
#[test]
fn openrouter_whitelist_phase_owner_prefix_and_effort_remain_source_values() {
    let id = ModelId::from_source(JsString16::from_units(vec![
        111, 119, 110, 101, 114, 0xd800, 47, 105, 100,
    ]));
    let effort = JsString16::from_units(vec![0xdc00]);
    let mut input = CatalogInput {
        snapshot: Some(snapshot(vec![document(r#"{"slug":"a"}"#)])),
        whitelist: Some(ModelWhitelist {
            model_ids: vec!["a".into()],
            updated_at_ms: 1,
        }),
        ..Default::default()
    };
    input.providers.insert(
        "openrouter".into(),
        ProviderCatalog {
            models: vec![document(r#"{"id":"owner\ud800/id"}"#)],
            configured: true,
            available: true,
            ..Default::default()
        },
    );
    input.enrichment.insert(
        id.clone(),
        MetadataHint {
            supported_reasoning_levels: Some(vec![json(&effort)]),
            default_reasoning_effort: Some(effort.clone()),
            ..Default::default()
        },
    );
    let ordinary = rows(&ordinary_models(&input), "data");
    assert_eq!(ordinary.len(), 3);
    let row = ordinary
        .iter()
        .find(|r| units(&member(r, "id")) == id.as_js_string().as_units())
        .unwrap();
    assert_eq!(
        units(&member(row, "owned_by")),
        [111, 119, 110, 101, 114, 0xd800]
    );
    let capabilities = rows(&capabilities(&input), "data");
    let row = capabilities
        .iter()
        .find(|r| units(&member(r, "id")) == id.as_js_string().as_units())
        .unwrap();
    assert_eq!(
        units(&member(row, "default_reasoning_effort")),
        effort.as_units()
    );
    let public = public_catalog(&input, &Collator::captured()).unwrap();
    assert_eq!(rows(&public, "data").len(), 1);
    assert_eq!(units(&member(&rows(&public, "data")[0], "id")), [97]);
    let stored = document(r#"{"models":[{"slug":"a","unknown":"kept"}]}"#);
    assert_eq!(
        rows(&native_catalog(Some(&stored), &input), "models").len(),
        1
    );
}
#[test]
fn public_catalog_uses_finite_source_locale_order_without_rewriting_opaque_ids() {
    let input = CatalogInput {
        snapshot: Some(snapshot(vec![
            document(r#"{"slug":"\udc00"}"#),
            document(r#"{"slug":"\ud800"}"#),
        ])),
        ..Default::default()
    };
    let collator = Collator::captured();
    for catalog in [
        build_catalog_snapshot(&input, &collator).unwrap(),
        public_catalog(&input, &collator).unwrap(),
    ] {
        let key = if source::member(&catalog, "models").is_some() {
            "models"
        } else {
            "data"
        };
        let models = rows(&catalog, key);
        assert_eq!(units(&member(&models[0], "id")), [0xd800]);
        assert_eq!(units(&member(&models[1], "id")), [0xdc00]);
    }
    assert!(
        collator
            .compare(&"unknown-to-oracle".into(), &"a".into())
            .is_err()
    );
}
struct Refuse;
impl SourceStringCollator for Refuse {
    fn compare(&self, _: &JsString16, _: &JsString16) -> Result<std::cmp::Ordering, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture comparator refused.",
            "source_collation_refused",
        ))
    }
}
#[test]
fn comparator_failure_never_publishes_a_partial_catalog() {
    let input = CatalogInput {
        snapshot: Some(snapshot(vec![
            document(r#"{"slug":"a"}"#),
            document(r#"{"slug":"A"}"#),
        ])),
        ..Default::default()
    };
    assert!(build_catalog_snapshot(&input, &Refuse).is_err());
    assert!(public_catalog(&input, &Refuse).is_err());
}

#[test]
fn capabilities_source_label_is_exact_utf16_with_only_missing_snapshot_default() {
    let original = vec![0xd800, 0, 0xdc00, 0xfffd];
    let mut uploaded = snapshot(vec![document(r#"{"slug":"a"}"#)]);
    uploaded.source = JsString16::from_units(original.clone());
    let input = CatalogInput {
        snapshot: Some(uploaded),
        ..Default::default()
    };
    assert_eq!(units(&member(&capabilities(&input), "source")), original);

    let mut empty = snapshot(Vec::new());
    empty.source = JsString16::default();
    let input = CatalogInput {
        snapshot: Some(empty),
        ..Default::default()
    };
    assert!(units(&member(&capabilities(&input), "source")).is_empty());
    assert_eq!(
        units(&member(&capabilities(&CatalogInput::default()), "source")),
        "stored_codex_models".encode_utf16().collect::<Vec<_>>()
    );
}
