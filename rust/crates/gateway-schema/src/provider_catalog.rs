//! Provider-declared catalog projections; credentials/configuration are injected observations.
use crate::{aliases::*, catalog::*, metadata::*, model_control as c};
use gateway_core::{js_string::JsString16, model::ModelId, source_json::SourceJson};
pub const CEREBRAS_IDS: &[&str] = &["gpt-oss-120b", "qwen-3.8-27b"];
pub fn provider_hint(provider: &str, id: &ModelId) -> MetadataHint {
    match provider {
        "deepseek" => MetadataHint::provider(1_000_000, &["none", "low", "high", "max"], "high"),
        "cerebras" if id.matches_scalar("qwen-3.8-27b") => {
            MetadataHint::provider(131_072, &["none", "low", "medium", "high"], "high")
        }
        "cerebras" => MetadataHint::provider(131_072, &["low", "medium", "high"], "medium"),
        "lithos" => MetadataHint {
            effective_context_window_percent: Some(100),
            ..MetadataHint::provider(
                1_048_576,
                &["none", "minimal", "low", "medium", "high", "xhigh", "max"],
                "medium",
            )
        },
        "ubiquity" => MetadataHint {
            auto_compact_token_limit_tokens: Some(891_289),
            effective_context_window_percent: Some(95),
            ..MetadataHint::provider(1_048_576, &["low", "high", "max"], "high")
        },
        _ => MetadataHint::default(),
    }
}
pub fn display_name(provider: &str, id: &ModelId) -> JsString16 {
    let literal = match provider {
        "deepseek" if id.matches_scalar("deepseek-flash") => Some("DeepSeek Flash"),
        "deepseek" if id.matches_scalar("deepseek-v4-flash") => Some("DeepSeek Flash (legacy id)"),
        "deepseek" if id.matches_scalar("deepseek-v4-pro") => Some("DeepSeek Pro"),
        "cerebras" if id.matches_scalar("gpt-oss-120b") => Some("GPT-OSS 120B"),
        "cerebras" if id.matches_scalar("qwen-3.8-27b") => Some("Qwen 3.8 27B"),
        "ubiquity" => Some("Ubiquity DeepSeek Flash"),
        _ => None,
    };
    if let Some(value) = literal {
        return value.into();
    }
    if provider == "lithos" {
        let units = id.as_js_string().as_units();
        let deepseek: Vec<u16> = "DeepSeek".encode_utf16().collect();
        let base = if units.windows(deepseek.len()).any(|part| part == deepseek) {
            "LithosAI DeepSeek V4.1 Flash"
        } else {
            "LithosAI Kimi K3"
        };
        let ends = |value: &str| units.ends_with(&value.encode_utf16().collect::<Vec<_>>());
        let suffix = if ends("-ultra-chat") {
            " (ultra, chat)"
        } else if ends("-ultra") {
            " (ultra)"
        } else if ends("-fast") {
            " (fast)"
        } else {
            ""
        };
        return format!("{base}{suffix}").as_str().into();
    }
    id.as_js_string().clone()
}
pub fn provider_ids(provider: &str) -> &'static [&'static str] {
    match provider {
        "deepseek" => DEEPSEEK_IDS,
        "lithos" => LITHOS_IDS,
        "cerebras" => CEREBRAS_IDS,
        "ubiquity" => &[SYNTHETIC_MODEL],
        _ => &[],
    }
}
pub(crate) fn openrouter_owner(id: &ModelId) -> JsString16 {
    let units = id.as_js_string().as_units();
    let prefix = units.split(|unit| *unit == 47).next().unwrap_or_default();
    if prefix.is_empty() {
        "openrouter".into()
    } else {
        JsString16::from_units(prefix.to_vec())
    }
}
pub fn configured_model_rows(input: &CatalogInput, provider: &str) -> Vec<SourceJson> {
    if !input.enabled(provider)
        || (provider == "ubiquity" && !input.synthetic_configured())
        || (provider != "ubiquity" && !input.configured(provider))
    {
        return Vec::new();
    }
    provider_ids(provider)
        .iter()
        .map(|id| {
            c::object(vec![
                ("id", c::json(id)),
                ("object", c::json("model")),
                (
                    "created",
                    c::json(&if provider == "ubiquity" {
                        1_791_244_800i64
                    } else {
                        0
                    }),
                ),
                ("owned_by", c::json(provider)),
            ])
        })
        .collect()
}
pub fn apply_resolved_fields(
    row: &mut SourceJson,
    resolved: &ResolvedMetadata,
    native: bool,
    include_nulls: bool,
) {
    for (key, value) in [
        (
            if native {
                "context_window"
            } else {
                "context_window_tokens"
            },
            resolved.context_window_tokens,
        ),
        (
            if native {
                "max_context_window"
            } else {
                "max_context_window_tokens"
            },
            resolved.max_context_window_tokens,
        ),
        (
            if native {
                "auto_compact_token_limit"
            } else {
                "auto_compact_token_limit_tokens"
            },
            resolved.auto_compact_token_limit_tokens,
        ),
        (
            "effective_context_window_percent",
            resolved.effective_context_window_percent,
        ),
    ] {
        if let Some(value) = value {
            c::set(row, key, c::json(&value));
        } else if include_nulls && key != "effective_context_window_percent" {
            c::set(row, key, c::json(&()));
        }
    }
}
pub fn configured_capabilities(input: &CatalogInput, provider: &str) -> Vec<SourceJson> {
    configured_model_rows(input, provider)
        .iter()
        .filter_map(|model| {
            let id = ModelId::from_source(c::get(model, "id").as_ref().and_then(c::string)?);
            let hint = provider_hint(provider, &id);
            let mut resolved = input.metadata(&id, None, Some(hint.clone()), false);
            if provider == "ubiquity" {
                resolved = resolve_metadata(&MetadataSources {
                    provider: Some(hint.clone()),
                    ..MetadataSources::default()
                });
            }
            let endpoints = if provider == "cerebras" {
                vec!["/v1/chat/completions"]
            } else if provider == "ubiquity" {
                vec!["/v1/responses"]
            } else {
                vec!["/v1/chat/completions", "/v1/responses"]
            };
            let mut row = c::object(vec![
                ("id", c::json(&id)),
                ("object", c::json("uos.model_capabilities")),
                ("owned_by", c::json(provider)),
                ("display_name", c::json(&display_name(provider, &id))),
                ("upstream_provider", c::json(provider)),
                ("supported_endpoints", c::json(&endpoints)),
                (
                    "supported_reasoning_levels",
                    c::json(hint.supported_reasoning_levels.as_deref().unwrap_or(&[])),
                ),
                (
                    "default_reasoning_effort",
                    c::json(&hint.default_reasoning_effort),
                ),
                ("reasoning_effort_wire_map", c::object(vec![])),
            ]);
            apply_resolved_fields(&mut row, &resolved, false, true);
            c::set(
                &mut row,
                "context_source",
                c::json(&resolved.context_source),
            );
            if provider == "deepseek" {
                c::set(
                    &mut row,
                    "reasoning_effort_wire_map",
                    c::object(vec![("ultra", c::json("max"))]),
                );
            }
            if provider == "ubiquity" {
                c::set(&mut row, "context_source", c::json("openrouter"));
                c::set(&mut row, "reasoning_source", c::json("provider_discovery"));
            }
            Some(row)
        })
        .collect()
}
pub fn openrouter_models(input: &CatalogInput) -> Vec<SourceJson> {
    if !input.enabled("openrouter") || !input.configured("openrouter") {
        return Vec::new();
    }
    let mut rows: Vec<_> = input
        .rows("openrouter")
        .iter()
        .filter_map(|r| c::get(r, "id").as_ref().and_then(c::string))
        .map(|id| {
            let id = ModelId::from_source(id);
            c::object(vec![
                ("id", c::json(&id)),
                ("object", c::json("model")),
                ("created", c::json(&0)),
                ("owned_by", c::json(&openrouter_owner(&id))),
            ])
        })
        .collect();
    append_unique(
        &mut rows,
        [c::object(vec![
            ("id", c::json("typesafe/jev-latest")),
            ("object", c::json("model")),
            ("created", c::json(&0)),
            ("owned_by", c::json("typesafe")),
        ])],
        "id",
    );
    rows
}
pub fn openrouter_capabilities(input: &CatalogInput) -> Vec<SourceJson> {
    openrouter_models(input)
        .iter()
        .map(|model| {
            let id = ModelId::from_source(
                c::get(model, "id")
                    .as_ref()
                    .and_then(c::string)
                    .expect("constructed model id"),
            );
            let jev = id.matches_scalar("typesafe/jev-latest");
            let resolved = input.metadata(&id, None, None, false);
            let discovered = input.rows("openrouter").iter().any(|r| {
                c::get(r, "id").as_ref().and_then(c::string).as_ref() == Some(id.as_js_string())
            });
            let levels = if jev {
                vec!["none".into()]
            } else {
                resolved
                    .supported_reasoning_levels
                    .clone()
                    .unwrap_or_else(|| vec!["none".into()])
            };
            let mut row = c::object(vec![
                ("id", c::json(&id)),
                ("object", c::json("uos.model_capabilities")),
                (
                    "owned_by",
                    c::get(model, "owned_by").unwrap_or_else(|| c::json(&())),
                ),
                (
                    "display_name",
                    c::json(&if jev {
                        JsString16::from_utf8("Jev (Typesafe System One decisions)")
                    } else {
                        id.as_js_string().clone()
                    }),
                ),
                ("upstream_provider", c::json("openrouter")),
                (
                    "supported_endpoints",
                    c::json(&if jev && !discovered {
                        vec!["/v1/systemone"]
                    } else {
                        vec!["/v1/responses", "/v1/chat/completions"]
                    }),
                ),
                ("supported_reasoning_levels", c::json(&levels)),
                ("reasoning_effort_wire_map", c::object(vec![])),
            ]);
            if jev {
                c::set(&mut row, "default_reasoning_effort", c::json("none"));
                for key in [
                    "context_window_tokens",
                    "max_context_window_tokens",
                    "auto_compact_token_limit_tokens",
                ] {
                    c::set(&mut row, key, c::json(&()));
                }
                c::set(&mut row, "context_source", c::json("unknown"));
                c::set(&mut row, "reasoning_source", c::json("unknown"));
            } else {
                if let Some(default) = &resolved.default_reasoning_effort {
                    c::set(&mut row, "default_reasoning_effort", c::json(default));
                } else if resolved.supported_reasoning_levels.is_none() {
                    c::set(&mut row, "default_reasoning_effort", c::json("none"));
                }
                apply_resolved_fields(&mut row, &resolved, false, true);
                c::set(
                    &mut row,
                    "context_source",
                    c::json(&resolved.context_source),
                );
                c::set(
                    &mut row,
                    "reasoning_source",
                    c::json(&resolved.reasoning_source),
                );
            }
            row
        })
        .collect()
}
pub fn normalized_codex_capability(
    input: &CatalogInput,
    record: &SourceJson,
) -> Option<SourceJson> {
    let id = ModelId::from_source(c::trim(&c::identifier(record)?));
    if id.as_js_string().as_units().is_empty() {
        return None;
    }
    let reasoning = crate::reasoning::ModelReasoning::from_record(Some(record));
    let resolved = input.metadata(&id, Some(record), None, true);
    let owner = c::get(record, "owned_by")
        .as_ref()
        .and_then(c::string)
        .unwrap_or_else(|| "openai".into());
    let mut row = c::object(vec![
        ("id", c::json(&id)),
        ("object", c::json("uos.model_capabilities")),
        ("owned_by", c::json(&owner)),
        (
            "display_name",
            c::get(record, "display_name").unwrap_or_else(|| c::json(&())),
        ),
        ("upstream_provider", c::json("codex_chatgpt")),
        (
            "supported_endpoints",
            c::json(&["/v1/chat/completions", "/v1/responses"]),
        ),
        ("supported_reasoning_levels", c::json(&reasoning.levels)),
        (
            "default_reasoning_effort",
            c::json(&reasoning.default_level),
        ),
        ("reasoning_effort_wire_map", reasoning.wire_efforts),
    ]);
    apply_resolved_fields(&mut row, &resolved, false, true);
    c::set(
        &mut row,
        "context_source",
        c::json(&resolved.context_source),
    );
    c::set(
        &mut row,
        "reasoning_source",
        c::json(&resolved.reasoning_source),
    );
    if let Some(cache) =
        crate::prompt_cache::normalize_capabilities_source(c::get(record, "prompt_cache").as_ref())
    {
        c::set(&mut row, "prompt_cache", cache);
    }
    Some(row)
}
