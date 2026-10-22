use crate::{
    aliases::*, catalog::*, metadata::*, model_control as c, provider_catalog::*, selection::*,
};
use gateway_core::{GatewayError, model::ModelId, source_json::SourceJson};
fn snapshot_models(input: &CatalogInput, full: bool) -> Vec<SourceJson> {
    let snapshot = if full {
        input.codex()
    } else {
        input.snapshot.as_ref()
    };
    snapshot
        .map(|s| {
            s.models
                .iter()
                .filter_map(|r| model_list_row(r, (s.updated_at_ms / 1000).max(0)))
                .collect()
        })
        .unwrap_or_default()
}
fn row_id(row: &SourceJson) -> Option<ModelId> {
    c::get(row, "id")
        .as_ref()
        .and_then(c::string)
        .map(ModelId::from_source)
}
pub fn ordinary_models(input: &CatalogInput) -> SourceJson {
    let mut rows = if input.enabled("codex") {
        snapshot_models(input, false)
    } else {
        Vec::new()
    };
    append_unique(&mut rows, configured_model_rows(input, "cerebras"), "id");
    for provider in ["deepseek", "lithos", "ubiquity"] {
        let configured = configured_model_rows(input, provider);
        if !configured.is_empty() {
            rows.retain(|r| !configured.iter().any(|c| row_id(c) == row_id(r)));
            rows.extend(configured);
        }
    }
    let claude = input.available_rows("claude_code").iter().map(|r| {
        c::object(vec![
            ("id", c::get(r, "id").unwrap_or_else(|| c::json(&()))),
            ("object", c::json("model")),
            (
                "created",
                c::get(r, "created").unwrap_or_else(|| c::json(&0)),
            ),
            ("owned_by", c::json("anthropic")),
        ])
    });
    append_unique(&mut rows, claude, "id");
    for provider in ["openlux", "surplus"] {
        let records = input
            .available_rows(provider)
            .iter()
            .filter(|r| endpoint_supports(r, "openai") || endpoint_supports(r, "openai-response"))
            .filter_map(|r| model_list_row(r, 0));
        append_unique(&mut rows, records, "id");
    }
    let mut rows = filter_whitelist(rows, input.whitelist.as_ref(), false);
    append_unique(&mut rows, openrouter_models(input), "id");
    c::object(vec![("object", c::json("list")), ("data", c::json(&rows))])
}
fn discovered_capability(input: &CatalogInput, model: &SourceJson, provider: &str) -> SourceJson {
    let id = row_id(model).unwrap_or_else(|| "".into());
    let resolved = input.metadata(&id, None, None, false);
    let levels = resolved
        .supported_reasoning_levels
        .clone()
        .unwrap_or_else(|| vec!["none".into()]);
    let mut row = c::object(vec![
        ("id", c::json(&id)),
        ("object", c::json("uos.model_capabilities")),
        (
            "owned_by",
            c::get(model, "owned_by").unwrap_or_else(|| c::json(&())),
        ),
        ("display_name", c::json(&id)),
        ("upstream_provider", c::json(provider)),
        ("supported_endpoints", c::json(&endpoint_paths(model))),
        ("supported_reasoning_levels", c::json(&levels)),
    ]);
    if let Some(default) = &resolved.default_reasoning_effort {
        c::set(&mut row, "default_reasoning_effort", c::json(default));
    } else if resolved.supported_reasoning_levels.is_none() {
        c::set(&mut row, "default_reasoning_effort", c::json("none"));
    }
    c::set(&mut row, "reasoning_effort_wire_map", c::object(vec![]));
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
    row
}
fn claude_capability(model: &SourceJson) -> SourceJson {
    let levels = claude_levels(model);
    let window = c::positive(c::get(model, "context_window_tokens").as_ref());
    let id = c::get(model, "id").unwrap_or_else(|| c::json(&()));
    let mut row = c::object(vec![
        ("id", id.clone()),
        ("object", c::json("uos.model_capabilities")),
        ("owned_by", c::json("anthropic")),
        ("display_name", c::get(model, "display_name").unwrap_or(id)),
        ("upstream_provider", c::json("claude_code")),
        (
            "supported_endpoints",
            c::json(&["/v1/responses", "/v1/chat/completions"]),
        ),
        ("supported_reasoning_levels", c::json(&levels)),
    ]);
    if c::get(model, "supports_disabled_thinking").is_some_and(|v| v.as_str() == "true") {
        c::set(&mut row, "default_reasoning_effort", c::json("none"));
    }
    c::set(&mut row, "context_window_tokens", c::json(&window));
    c::set(
        &mut row,
        "context_source",
        c::json(if window.is_some() {
            "provider_discovery"
        } else {
            "unknown"
        }),
    );
    c::set(
        &mut row,
        "reasoning_source",
        c::json(if levels.is_empty() {
            "unknown"
        } else {
            "provider_discovery"
        }),
    );
    c::set(
        &mut row,
        "max_output_tokens",
        c::get(model, "max_output_tokens").unwrap_or_else(|| c::json(&())),
    );
    c::set(
        &mut row,
        "upstream_capabilities",
        c::object(vec![
            (
                "image_input",
                c::get(model, "supports_image_input").unwrap_or_else(|| c::json(&())),
            ),
            (
                "pdf_input",
                c::get(model, "supports_pdf_input").unwrap_or_else(|| c::json(&())),
            ),
        ]),
    );
    row
}
pub fn capabilities(input: &CatalogInput) -> SourceJson {
    let mut rows = if input.enabled("codex") {
        input
            .codex()
            .map(|s| {
                s.models
                    .iter()
                    .filter_map(|r| normalized_codex_capability(input, r))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    append_unique(&mut rows, configured_capabilities(input, "cerebras"), "id");
    append_unique(
        &mut rows,
        input
            .available_rows("claude_code")
            .iter()
            .map(claude_capability),
        "id",
    );
    for (provider, label) in [("openlux", "metered"), ("surplus", "surplus")] {
        append_unique(
            &mut rows,
            input
                .available_rows(provider)
                .iter()
                .map(|r| discovered_capability(input, r, label)),
            "id",
        );
    }
    for provider in ["deepseek", "lithos", "ubiquity"] {
        let configured = configured_capabilities(input, provider);
        if !configured.is_empty() {
            rows.retain(|r| !configured.iter().any(|c| row_id(c) == row_id(r)));
            rows.extend(configured);
        }
    }
    let mut rows = filter_whitelist(rows, input.whitelist.as_ref(), false);
    append_unique(&mut rows, openrouter_capabilities(input), "id");
    let snapshot = input.codex();
    c::object(vec![
        ("object", c::json("list")),
        ("data", c::json(&rows)),
        ("upstream_provider", c::json("codex_chatgpt")),
        (
            "source",
            snapshot
                .map(|s| c::json(&s.source))
                .unwrap_or_else(|| c::json("stored_codex_models")),
        ),
        (
            "client_version",
            c::json(&snapshot.and_then(|s| s.client_version.as_deref())),
        ),
        ("updated_at_ms", c::json(&snapshot.map(|s| s.updated_at_ms))),
    ])
}
fn public_entry(
    id: &ModelId,
    provider: SourceJson,
    created: Option<i64>,
    resolved: &ResolvedMetadata,
) -> SourceJson {
    let mut row = c::object(vec![
        ("id", c::json(id)),
        ("providers", c::json(&[provider])),
    ]);
    if let Some(created) = created.filter(|n| *n > 0) {
        c::set(&mut row, "created", c::json(&created));
    }
    apply_resolved_fields(&mut row, resolved, false, false);
    if let Some(levels) = &resolved.supported_reasoning_levels {
        c::set(&mut row, "supported_reasoning_levels", c::json(levels));
    }
    if let Some(default) = &resolved.default_reasoning_effort {
        c::set(&mut row, "default_reasoning_effort", c::json(default));
    }
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
    row
}
fn add_public(
    rows: &mut Vec<SourceJson>,
    id: &ModelId,
    provider: SourceJson,
    created: Option<i64>,
    resolved: &ResolvedMetadata,
) {
    if let Some(existing) = rows.iter_mut().find(|r| row_id(r).as_ref() == Some(id)) {
        let mut providers = c::get(existing, "providers")
            .as_ref()
            .and_then(c::array)
            .expect("constructed providers");
        providers.push(provider);
        c::set(existing, "providers", c::json(&providers));
        if c::get(existing, "created").is_none()
            && let Some(n) = created.filter(|n| *n > 0)
        {
            c::set(existing, "created", c::json(&n));
        }
    } else {
        rows.push(public_entry(id, provider, created, resolved));
    }
}
fn merge_provider_metadata(rows: &mut [SourceJson], id: &ModelId, hint: MetadataHint) {
    let Some(entry) = rows.iter_mut().find(|row| row_id(row).as_ref() == Some(id)) else {
        return;
    };
    let resolved = resolve_metadata(&MetadataSources {
        provider: Some(hint),
        ..MetadataSources::default()
    });
    apply_resolved_fields(entry, &resolved, false, false);
    if resolved.context_window_tokens.is_some() || resolved.max_context_window_tokens.is_some() {
        c::set(entry, "context_source", c::json(&resolved.context_source));
    }
    if let Some(levels) = &resolved.supported_reasoning_levels {
        c::set(entry, "supported_reasoning_levels", c::json(levels));
    }
    if let Some(default) = &resolved.default_reasoning_effort {
        c::set(entry, "default_reasoning_effort", c::json(default));
    }
    if resolved.supported_reasoning_levels.is_some() || resolved.default_reasoning_effort.is_some()
    {
        c::set(
            entry,
            "reasoning_source",
            c::json(&resolved.reasoning_source),
        );
    }
}
fn sorted_models(
    rows: Vec<SourceJson>,
    collator: &dyn SourceStringCollator,
) -> Result<Vec<SourceJson>, GatewayError> {
    sort_source(rows, &|a, b| {
        let left = row_id(a).expect("constructed catalog id");
        let right = row_id(b).expect("constructed catalog id");
        collator.compare(left.as_js_string(), right.as_js_string())
    })
}
pub fn build_catalog_snapshot(
    input: &CatalogInput,
    collator: &dyn SourceStringCollator,
) -> Result<SourceJson, GatewayError> {
    let mut rows = Vec::new();
    let codex = snapshot_models(input, true);
    for model in &codex {
        if let Some(id) = row_id(model) {
            let record = input.codex().and_then(|s| s.find(&id));
            add_public(
                &mut rows,
                &id,
                c::object(vec![
                    ("id", c::json("codex")),
                    (
                        "owned_by",
                        c::get(model, "owned_by").unwrap_or_else(|| c::json(&())),
                    ),
                    (
                        "supported_endpoints",
                        c::json(&["/v1/responses", "/v1/chat/completions"]),
                    ),
                ]),
                c::positive(c::get(model, "created").as_ref()),
                &input.metadata(&id, record, None, true),
            );
        }
    }
    for provider in ["openlux", "surplus", "claude_code"] {
        for model in input.rows(provider) {
            if let Some(id) = row_id(model) {
                let claude = provider == "claude_code";
                let owner = if claude {
                    c::json("anthropic")
                } else {
                    c::get(model, "owned_by").unwrap_or_else(|| c::json(&()))
                };
                let paths = if claude {
                    vec!["/v1/responses".into(), "/v1/chat/completions".into()]
                } else {
                    endpoint_paths(model)
                };
                let hint = if claude {
                    Some(MetadataHint {
                        context_window_tokens: c::positive(
                            c::get(model, "context_window_tokens").as_ref(),
                        ),
                        max_context_window_tokens: c::positive(
                            c::get(model, "context_window_tokens").as_ref(),
                        ),
                        ..MetadataHint::default()
                    })
                } else {
                    None
                };
                let existing = rows.iter().any(|row| row_id(row).as_ref() == Some(&id));
                add_public(
                    &mut rows,
                    &id,
                    c::object(vec![
                        ("id", c::json(provider)),
                        ("owned_by", owner),
                        ("supported_endpoints", c::json(&paths)),
                    ]),
                    c::positive(c::get(model, "created").as_ref()),
                    &input.metadata(&id, None, hint.clone(), false),
                );
                if existing && let Some(hint) = hint {
                    merge_provider_metadata(&mut rows, &id, hint);
                }
            }
        }
    }
    for provider in ["deepseek", "cerebras", "lithos"] {
        if !input.configured(provider) {
            continue;
        }
        for id in provider_ids(provider) {
            let id = ModelId::from_scalar(id);
            let existing = rows.iter().any(|row| row_id(row).as_ref() == Some(&id));
            let endpoints = if provider == "cerebras" {
                vec!["/v1/chat/completions"]
            } else {
                vec!["/v1/chat/completions", "/v1/responses"]
            };
            add_public(
                &mut rows,
                &id,
                c::object(vec![
                    ("id", c::json(provider)),
                    ("owned_by", c::json(provider)),
                    ("supported_endpoints", c::json(&endpoints)),
                ]),
                None,
                &input.metadata(&id, None, Some(provider_hint(provider, &id)), false),
            );
            if existing {
                merge_provider_metadata(&mut rows, &id, provider_hint(provider, &id));
            }
        }
    }
    if input.synthetic_configured() {
        let id = ModelId::from_scalar(SYNTHETIC_MODEL);
        let existing = rows.iter().any(|row| row_id(row).as_ref() == Some(&id));
        let resolved = input.metadata(&id, None, Some(provider_hint("ubiquity", &id)), false);
        add_public(
            &mut rows,
            &id,
            c::object(vec![
                ("id", c::json("ubiquity")),
                ("owned_by", c::json("ubiquity")),
                ("supported_endpoints", c::json(&["/v1/responses"])),
            ]),
            Some(1_791_244_800),
            &resolved,
        );
        if existing {
            merge_provider_metadata(&mut rows, &id, provider_hint("ubiquity", &id));
        }
        for provider in FLASH_ORDER {
            if input.configured(provider) {
                add_public(
                    &mut rows,
                    &id,
                    c::object(vec![
                        ("id", c::json(provider)),
                        ("owned_by", c::json("ubiquity")),
                        ("supported_endpoints", c::json(&["/v1/responses"])),
                    ]),
                    None,
                    &resolved,
                );
            }
        }
    }
    if input.configured("openrouter") {
        for model in input.rows("openrouter") {
            if let Some(id) = row_id(model) {
                add_public(
                    &mut rows,
                    &id,
                    c::object(vec![
                        ("id", c::json("openrouter")),
                        ("owned_by", c::json(&openrouter_owner(&id))),
                        (
                            "supported_endpoints",
                            c::json(&["/v1/responses", "/v1/chat/completions"]),
                        ),
                    ]),
                    None,
                    &input.metadata(&id, None, None, false),
                );
            }
        }
        let id = ModelId::from_scalar("typesafe/jev-latest");
        add_public(
            &mut rows,
            &id,
            c::object(vec![
                ("id", c::json("openrouter")),
                ("owned_by", c::json("typesafe")),
                ("supported_endpoints", c::json(&["/v1/systemone"])),
            ]),
            None,
            &input.metadata(&id, None, None, false),
        );
    }
    // Both source public renderers use the same stable locale comparator, never
    // lexical ModelId ordering or a comparator-error substitute (catalog.ts482).
    let rows = sorted_models(rows, collator)?;
    let mut sources = vec![(
        "codex",
        c::object(vec![
            (
                "status",
                c::json(if input.codex().is_some_and(|s| !s.models.is_empty()) {
                    "available"
                } else {
                    "unavailable"
                }),
            ),
            ("count", c::json(&codex.len())),
            (
                "updated_at_ms",
                c::json(&input.codex().map(|s| s.updated_at_ms)),
            ),
        ]),
    )];
    for provider in [
        "claude_code",
        "openlux",
        "surplus",
        "deepseek",
        "cerebras",
        "lithos",
        "openrouter",
    ] {
        let snapshot = input.providers.get(provider);
        let configured = input.configured(provider);
        let gated = ["deepseek", "cerebras", "lithos", "openrouter"].contains(&provider);
        let count = if gated {
            if configured {
                if provider == "openrouter" {
                    input.rows(provider).len() + 1
                } else {
                    provider_ids(provider).len()
                }
            } else {
                0
            }
        } else {
            input.rows(provider).len()
        };
        let available = if gated {
            configured
        } else {
            snapshot.is_some_and(|s| s.available && (provider != "claude_code" || !s.stale))
        };
        let mut source = c::object(vec![
            (
                "status",
                c::json(if available {
                    "available"
                } else {
                    "unavailable"
                }),
            ),
            ("count", c::json(&count)),
            (
                "updated_at_ms",
                c::json(&if gated && provider != "openrouter" {
                    None
                } else {
                    snapshot.and_then(|p| p.updated_at_ms)
                }),
            ),
        ]);
        if gated || provider == "claude_code" {
            c::set(&mut source, "configured", c::json(&configured));
        }
        if provider == "claude_code" && snapshot.is_some_and(|s| s.stale) {
            c::set(&mut source, "stale", c::json(&true));
        }
        sources.push((provider, source));
    }
    Ok(c::object(vec![
        ("models", c::json(&rows)),
        ("sources", c::object(sources)),
    ]))
}
pub fn public_catalog(
    input: &CatalogInput,
    collator: &dyn SourceStringCollator,
) -> Result<SourceJson, GatewayError> {
    let snapshot = build_catalog_snapshot(input, collator)?;
    let mut rows = Vec::new();
    for mut row in c::get(&snapshot, "models")
        .as_ref()
        .and_then(c::array)
        .unwrap_or_default()
    {
        let id = row_id(&row).expect("constructed catalog id");
        if !ModelWhitelist::permits(input.whitelist.as_ref(), &id) {
            continue;
        }
        let providers = c::get(&row, "providers")
            .as_ref()
            .and_then(c::array)
            .unwrap_or_default();
        if providers.iter().any(|p| {
            c::get(p, "id")
                .as_ref()
                .and_then(c::string)
                .is_some_and(|id| c::matches(&id, "ubiquity"))
        }) && !input.enabled("ubiquity")
        {
            continue;
        }
        let selected: Vec<_> = providers
            .into_iter()
            .filter(|p| {
                c::scalar(c::get(p, "id").as_ref())
                    .is_some_and(|id| !PROVIDERS.contains(&id.as_str()) || input.enabled(&id))
            })
            .collect();
        if selected.is_empty() {
            continue;
        }
        c::set(&mut row, "providers", c::json(&selected));
        rows.push(row);
    }
    let mut sources = c::get(&snapshot, "sources").expect("constructed source summary");
    for provider in PROVIDERS {
        if !input.enabled(provider) && c::get(&sources, provider).is_some() {
            c::set(
                &mut sources,
                provider,
                c::object(vec![
                    ("status", c::json("unavailable")),
                    ("count", c::json(&0)),
                    ("updated_at_ms", c::json(&())),
                    ("configured", c::json(&false)),
                    ("disabled", c::json(&true)),
                ]),
            );
        }
    }
    let rows = sorted_models(rows, collator)?;
    Ok(c::object(vec![
        ("object", c::json("uos.model_catalog")),
        ("data", c::json(&rows)),
        ("sources", sources),
    ]))
}
