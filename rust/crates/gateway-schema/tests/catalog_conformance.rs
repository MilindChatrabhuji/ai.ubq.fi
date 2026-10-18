use gateway_schema::{
    aliases::*, catalog::*, metadata::*, prompt_cache::*, runtime_config::*, selection::*,
    snapshot::*,
};
use serde_json::{Value, json};
fn snapshot(models: Value, version: &str) -> ModelSnapshot {
    normalize_snapshot(&json!({"models":models,"client_version":version,"source":"codex_cli","updated_at_ms":1000}),&SnapshotOverrides::default(),1000).unwrap()
}
#[test]
fn uploaded_tiers_and_hidden_api_models_keep_source_semantics() {
    let snapshot = snapshot(
        json!([{"slug":"a","supported_reasoning_levels":["low",null,{"effort":"Custom"},{"effort":"ultra","wire_effort":"wrong"},"low"],"default_reasoning_level":null},{"slug":"hidden","visibility":"hide"},{"slug":"review","visibility":"HIDE","supported_in_api":true}]),
        "0.163.0",
    );
    assert_eq!(snapshot.models.len(), 2);
    assert_eq!(
        snapshot.models[0]["supported_reasoning_levels"],
        json!(["low", "none", "Custom", "ultra", "low"])
    );
    assert_eq!(
        snapshot.models[0]["reasoning_effort_wire_map"]["ultra"],
        "max"
    );
    assert_eq!(snapshot.models[0]["default_reasoning_level"], "none");
}
#[test]
fn external_standard_tiers_sort_without_moving_custom_slots() {
    let values = [
        "ultra",
        "custom-v1",
        "max",
        "high",
        "CUSTOM",
        "xhigh",
        "medium",
        "minimal",
        "low",
        "none",
    ]
    .map(str::to_owned);
    assert_eq!(
        ascending_external_levels(&values),
        [
            "none",
            "custom-v1",
            "minimal",
            "low",
            "CUSTOM",
            "medium",
            "high",
            "xhigh",
            "max",
            "ultra"
        ]
        .map(str::to_owned)
    );
}
#[test]
fn context_uses_widest_source_while_reasoning_uses_upload() {
    let sources = MetadataSources {
        codex: Some(MetadataHint::provider(
            272000,
            &["low", "Bespoke"],
            "Bespoke",
        )),
        subscription: Some(MetadataHint::subscription()),
        provider: Some(MetadataHint::provider(500000, &["none"], "none")),
        openrouter: Some(MetadataHint::provider(1050000, &["high"], "high")),
    };
    let resolved = resolve_metadata(&sources);
    assert_eq!(resolved.context_window_tokens, Some(1050000));
    assert_eq!(resolved.context_source, "openrouter");
    assert_eq!(
        resolved.supported_reasoning_levels,
        Some(vec!["low".into(), "Bespoke".into()])
    );
    assert_eq!(resolved.reasoning_source, "codex_upload");
    let unknown = resolve_metadata(&MetadataSources::default());
    assert_eq!(unknown.context_window_tokens, None);
    assert_eq!(unknown.supported_reasoning_levels, None);
}
#[test]
fn catalog_views_preserve_intentional_whitelist_differences() {
    let upload = snapshot(
        json!([{"slug":"a","supported_reasoning_levels":["medium"]}]),
        "0.163.0",
    );
    let mut input = CatalogInput {
        snapshot: Some(upload.clone()),
        full_snapshot: Some(upload),
        whitelist: Some(ModelWhitelist {
            model_ids: vec!["a".into()],
            updated_at_ms: 1,
        }),
        ..CatalogInput::default()
    };
    input.providers.insert(
        "openrouter".into(),
        ProviderCatalog {
            models: vec![json!({"id":"vendor/new"})],
            configured: true,
            available: true,
            ..ProviderCatalog::default()
        },
    );
    input.providers.insert("openlux".into(),ProviderCatalog{models:vec![json!({"id":"paid","created":1,"owned_by":"vendor","supported_endpoint_types":["openai-response"]})],configured:true,available:true,..ProviderCatalog::default()});
    let ordinary = ordinary_models(&input);
    let ids: Vec<_> = ordinary["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["a", "vendor/new", "typesafe/jev-latest"]);
    for row in ordinary["data"].as_array().unwrap() {
        assert_eq!(row.as_object().unwrap().len(), 4);
    }
    let native = native_catalog(
        Some(&json!({"models":[{"slug":"a","future":"kept"}]})),
        &input,
    );
    assert_eq!(native["models"].as_array().unwrap().len(), 1);
    assert_eq!(native["models"][0]["future"], "kept");
    let public = public_catalog(&input);
    assert_eq!(public["data"].as_array().unwrap().len(), 1);
    assert_eq!(public["data"][0]["id"], "a");
    let capabilities = capabilities(&input);
    assert!(
        capabilities["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "vendor/new")
    );
}
#[test]
fn selected_provider_and_gateway_identity_remove_disabled_rows() {
    let mut input = CatalogInput::default();
    input.providers.insert(
        "deepseek".into(),
        ProviderCatalog {
            configured: true,
            ..ProviderCatalog::default()
        },
    );
    input.selection = Some(ProviderSelection {
        provider_ids: vec!["deepseek".into()],
        updated_at_ms: 1,
    });
    let public = public_catalog(&input);
    assert!(
        !public["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == SYNTHETIC_MODEL)
    );
    assert_eq!(public["sources"]["codex"]["disabled"], true);
    assert!(
        public["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "deepseek-flash")
    );
}
#[test]
fn exact_versions_include_leading_zero_alias_but_refuse_ranges() {
    assert_eq!(parse_client_version(" 00.163.0 "), Some([0, 163, 0]));
    for invalid in [
        "latest",
        "0.163",
        "^0.163.0",
        "0.163.0-beta",
        "0.163.0+build",
        "9007199254740992.0.0",
    ] {
        assert!(parse_client_version(invalid).is_none());
    }
    assert_eq!(
        compare_client_versions("0.163.0", "0.99.0"),
        Some(std::cmp::Ordering::Greater)
    );
}
#[test]
fn synthetic_alias_follows_provider_catalogs_without_dropping_hops() {
    let aliases = resolve_flash_aliases(
        Some(&[
            json!({"id":"deepseek-ai/DeepSeek-V4.2-Flash-1018"}),
            json!({"id":"deepseek-ai/DeepSeek-V4.2-Flash"}),
            json!({"id":"deepseek-ai/DeepSeek-V9-Flash-ultra"}),
        ]),
        Some(&[
            json!({"id":"~deepseek/deepseek-v4.1-flash-latest"}),
            json!({"id":"~deepseek/deepseek-flash-latest"}),
        ]),
        None,
        None,
        2026,
    );
    assert_eq!(aliases.lithos, "deepseek-ai/DeepSeek-V4.2-Flash");
    assert_eq!(aliases.openrouter, "~deepseek/deepseek-flash-latest");
    assert_eq!(aliases.surplus, "deepseek-v4.1-flash");
    assert_eq!(aliases.deepseek, "deepseek-flash");
    assert_eq!(
        canonical_whitelist_id(LEGACY_SYNTHETIC_MODEL),
        SYNTHETIC_MODEL
    );
}
#[test]
fn account_catalog_union_retains_first_row_and_top_level_metadata() {
    let catalogs = vec![
        (
            "one".into(),
            json!({"future":"first","models":[{"slug":"a","x":1},{"slug":"shared","x":1}]}),
        ),
        (
            "two".into(),
            json!({"future":"second","models":[{"slug":"shared","x":2},{"slug":"b","x":2}]}),
        ),
    ];
    let (union, evidence) = union_account_catalogs(&catalogs).unwrap();
    assert_eq!(union["future"], "first");
    assert_eq!(union["models"][1]["x"], 1);
    assert_eq!(union["models"].as_array().unwrap().len(), 3);
    assert_eq!(evidence[1].1, vec!["shared", "b"]);
}
#[test]
fn account_absence_needs_current_sibling_same_version_and_rejection_expires() {
    let store = AccountModelsStore::default().record_catalogs(&[
        (
            "one".into(),
            AccountModelCatalog {
                slugs: vec!["a".into()],
                client_version: "0.1.0".into(),
                updated_at_ms: 1,
            },
        ),
        (
            "two".into(),
            AccountModelCatalog {
                slugs: vec!["a".into(), "b".into()],
                client_version: "0.2.0".into(),
                updated_at_ms: 1,
            },
        ),
    ]);
    let accounts = vec!["one".into(), "two".into()];
    assert!(store.unavailable("b", &accounts, 2).is_empty());
    let store = store.record_unsupported("one", "b", 2);
    assert_eq!(store.unavailable("b", &accounts, 3), vec!["one"]);
    assert!(
        store
            .unavailable("b", &accounts, 2 + 7 * 24 * 60 * 60_000 + 1)
            .is_empty()
    );
    let store = store.record_catalogs(&[(
        "one".into(),
        AccountModelCatalog {
            slugs: vec!["a".into(), "b".into()],
            client_version: "0.2.0".into(),
            updated_at_ms: 5,
        },
    )]);
    assert!(!store.unsupported.contains_key("one"));
}
#[test]
fn cache_evidence_merge_preserves_scope_by_exact_slug_and_compact_drops_it() {
    let scope = json!({"probe_profile":SCOPE_PROFILE,"account_slots":"shared","token_refresh":"preserved","conversation_id":"independent","effective_model":"a","reproducible_cycles":3,"source":"live_probe","verified_at_ms":100});
    let cache = json!({"version":1,"providers":[{"id":"codex_chatgpt","controls":{"key":true,"source":"catalog","verified_at_ms":1},"scope":scope}]});
    let previous = snapshot(json!([{"slug":"a","prompt_cache":cache}]), "0.1.0");
    let next = snapshot(json!([{"slug":"a"},{"slug":"renamed"}]), "0.2.0")
        .merge_prompt_cache(Some(&previous));
    assert_eq!(
        next.models[0]["prompt_cache"]["providers"][0]["scope"]["effective_model"],
        "a"
    );
    assert!(next.models[1].get("prompt_cache").is_none());
    let compact = compact_snapshot(&next).unwrap();
    assert!(
        compact["models"][0]["prompt_cache"]["providers"][0]
            .get("scope")
            .is_none()
    );
    assert!(concrete_scope(&scope, 3));
}
#[test]
fn runtime_projection_enforces_four_kib_and_preserves_custom_reasoning() {
    let full = snapshot(
        json!([{"slug":"a","context_window":1000000,"supported_reasoning_levels":["ultra","custom"]}]),
        "0.163.0",
    );
    let config = build_runtime_config(&full, None, Some("custom"), 10).unwrap();
    assert_eq!(config["version"], 2);
    assert_eq!(config["default_reasoning_effort"], "custom");
    assert!(
        config["codex_models"]["models"][0]
            .get("context_window")
            .is_none()
    );
    assert_eq!(
        config["codex_models"]["models"][0]["reasoning_effort_wire_map"]["ultra"],
        "max"
    );
    assert_eq!(normalize_runtime_config(&config), Some(config));
}

#[test]
fn finite_large_catalog_counts_are_retained_but_not_treated_as_safe_context() {
    let source =
        json!({"models":[{"slug":"a","context_window":1e100,"max_context_window":400000.9}]});
    let snapshot = normalize_snapshot(&source, &SnapshotOverrides::default(), 1000).unwrap();
    assert_eq!(snapshot.models[0]["context_window"].as_f64(), Some(1e100));
    assert_eq!(snapshot.models[0]["max_context_window"], 400000);
    let hint = MetadataHint::codex(&snapshot.models[0]);
    assert_eq!(hint.context_window_tokens, None);
    assert_eq!(hint.max_context_window_tokens, Some(400000));
}

#[test]
fn capabilities_use_runtime_snapshot_when_optional_full_snapshot_is_unavailable() {
    let runtime = snapshot(
        json!([{"slug":"runtime-fallback","supported_reasoning_levels":["low","ultra"],"default_reasoning_level":"ultra"}]),
        "0.163.0",
    );
    let input = CatalogInput {
        snapshot: Some(runtime),
        full_snapshot: None,
        selection: Some(ProviderSelection {
            provider_ids: vec!["codex".into()],
            updated_at_ms: 1,
        }),
        ..CatalogInput::default()
    };
    let result = capabilities(&input);
    assert_eq!(result["data"][0]["id"], "runtime-fallback");
    assert_eq!(
        result["data"][0]["supported_reasoning_levels"],
        json!(["low", "ultra"])
    );
    assert_eq!(result["data"][0]["default_reasoning_effort"], "ultra");
    assert_eq!(result["client_version"], "0.163.0");
}
