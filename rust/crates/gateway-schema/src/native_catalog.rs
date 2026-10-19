//! Rich exact-client-version Codex catalog. Never substitute the official model-list envelope.
use crate::{catalog::*, metadata::*, model_control as c, provider_catalog::*};
use gateway_core::{js_string::JsString16, model::ModelId, source_json::SourceJson};
fn description(effort: &JsString16) -> JsString16 {
    if c::matches(effort, "none") {
        "No reasoning".into()
    } else {
        c::concat(&[&"Reasoning effort: ".into(), effort])
    }
}
fn common_fields(row: &mut SourceJson, priority: i64, forwarding: bool) {
    for (key, value) in [
        ("shell_type", c::json("shell_command")),
        ("visibility", c::json("list")),
        ("supported_in_api", c::json(&true)),
        ("priority", c::json(&priority)),
        ("availability_nux", c::json(&())),
        ("upgrade", c::json(&())),
        ("base_instructions", c::json("")),
        ("support_verbosity", c::json(&false)),
        ("default_verbosity", c::json(&())),
        ("apply_patch_tool_type", c::json(&())),
        ("web_search_tool_type", c::json("text")),
        (
            "truncation_policy",
            c::object(vec![
                ("mode", c::json("tokens")),
                ("limit", c::json(&10000)),
            ]),
        ),
    ] {
        c::set(row, key, value);
    }
    if forwarding {
        c::set(
            row,
            "forwarding_policy",
            c::object(vec![
                ("version", c::json("deepseek-forwarded-payload/v1")),
                ("mode", c::json("bytes")),
                ("per_message_limit", c::json(&65_536)),
            ]),
        );
    }
    c::set(row, "supports_parallel_tool_calls", c::json(&false));
    c::set(
        row,
        "experimental_supported_tools",
        c::json(&Vec::<SourceJson>::new()),
    );
}
fn reasoning_fields(row: &mut SourceJson, resolved: &ResolvedMetadata, external: bool) {
    let levels = resolved.supported_reasoning_levels.as_ref().map(|levels| {
        if external {
            ascending_external_levels(levels)
        } else {
            levels.clone()
        }
    });
    let levels = levels
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| vec!["none".into()]);
    c::set(
        row,
        "supported_reasoning_levels",
        c::json(
            &levels
                .iter()
                .map(|e| {
                    c::object(vec![
                        ("effort", c::json(e)),
                        ("description", c::json(&description(e))),
                    ])
                })
                .collect::<Vec<_>>(),
        ),
    );
    if let Some(default) = &resolved.default_reasoning_effort {
        c::set(row, "default_reasoning_level", c::json(default));
    } else if resolved.supported_reasoning_levels.is_none() {
        c::set(row, "default_reasoning_level", c::json("none"));
    }
}
pub fn paid_native_record(model: &SourceJson, input: &CatalogInput) -> SourceJson {
    let id = ModelId::from_source(
        c::get(model, "id")
            .as_ref()
            .and_then(c::string)
            .unwrap_or_default(),
    );
    let codex = input.codex().and_then(|s| s.find(&id));
    let resolved = input.metadata(&id, codex, None, codex.is_some());
    let mut row = c::object(vec![("slug", c::json(&id)), ("display_name", c::json(&id))]);
    if let Some(description) = c::get(model, "description") {
        c::set(&mut row, "description", description);
    }
    for key in ["owned_by", "supported_endpoint_types"] {
        c::set(
            &mut row,
            key,
            c::get(model, key).unwrap_or_else(|| c::json(&())),
        );
    }
    reasoning_fields(&mut row, &resolved, codex.is_none());
    apply_resolved_fields(&mut row, &resolved, true, false);
    common_fields(&mut row, 1000, false);
    row
}
pub fn claude_native_record(model: &SourceJson) -> SourceJson {
    let id = c::get(model, "id").unwrap_or_else(|| c::json(&()));
    let levels = claude_levels(model);
    let mut row = c::object(vec![
        ("slug", id.clone()),
        ("display_name", c::get(model, "display_name").unwrap_or(id)),
        ("owned_by", c::json("anthropic")),
        (
            "supported_endpoint_types",
            c::json(&["openai-response", "openai"]),
        ),
        (
            "supported_reasoning_levels",
            c::json(
                &levels
                    .iter()
                    .map(|e| {
                        c::object(vec![
                            ("effort", c::json(e)),
                            (
                                "description",
                                c::json(&if c::matches(e, "none") {
                                    JsString16::from_utf8("No reasoning")
                                } else {
                                    e.clone()
                                }),
                            ),
                        ])
                    })
                    .collect::<Vec<_>>(),
            ),
        ),
    ]);
    if c::get(model, "supports_disabled_thinking").is_some_and(|v| v.as_str() == "true") {
        c::set(&mut row, "default_reasoning_level", c::json("none"));
    }
    if let Some(window) = c::positive(c::get(model, "context_window_tokens").as_ref()) {
        c::set(&mut row, "context_window", c::json(&window));
        c::set(&mut row, "max_context_window", c::json(&window));
    }
    if let Some(max) = c::positive(c::get(model, "max_output_tokens").as_ref()) {
        c::set(&mut row, "max_output_tokens", c::json(&max));
    }
    common_fields(&mut row, 1000, false);
    row
}
pub fn configured_native_records(input: &CatalogInput, provider: &str) -> Vec<SourceJson> {
    if !input.enabled(provider)
        || (provider == "ubiquity" && !input.synthetic_configured())
        || (provider != "ubiquity" && !input.configured(provider))
    {
        return Vec::new();
    }
    provider_ids(provider).iter().map(|id|{
        let id=ModelId::from_scalar(id);let mut row=c::object(vec![("slug",c::json(&id)),("display_name",c::json(&display_name(provider,&id)))]);
        c::set(&mut row,"description",c::json(match provider{"deepseek"=>"DeepSeek official API (deepseek-flash) served by this gateway.","lithos"=>"LithosAI API (Chat Completions) served by this gateway.","cerebras"=>"Cerebras API (Chat Completions) served by this gateway.",_=>"Latest DeepSeek Flash waterfall: official DeepSeek, OpenRouter, LithosAI, Surplus, and OpenLux. Each hop uses the provider's latest alias and falls back only on infrastructure or serving failures."}));
        c::set(&mut row,"owned_by",c::json(provider));c::set(&mut row,"supported_endpoint_types",c::json(&if provider=="ubiquity"{vec!["openai-response"]}else{vec!["openai-response","openai-chat"]}));
        let hint=provider_hint(provider,&id);let resolved=if provider=="cerebras"||provider=="ubiquity"{resolve_metadata(&MetadataSources{provider:Some(hint.clone()),..MetadataSources::default()})}else{input.metadata(&id,None,Some(hint.clone()),false)};
        let levels=hint.supported_reasoning_levels.as_deref().unwrap_or(&[]);let levels=levels.iter().filter_map(c::string).map(|e|{
            let label=if provider=="deepseek"{JsString16::from_utf8(if c::matches(&e,"none"){"Disable thinking mode"}else if c::matches(&e,"low"){"Thinking effort: low"}else if c::matches(&e,"high"){"Thinking effort: high"}else{"Thinking effort: maximum"})}else{description(&e)};
            c::object(vec![("effort",c::json(&e)),("description",c::json(&label))])
        }).collect::<Vec<_>>();
        c::set(&mut row,"supported_reasoning_levels",c::json(&levels));c::set(&mut row,"default_reasoning_level",c::json(&hint.default_reasoning_effort));apply_resolved_fields(&mut row,&resolved,true,false);common_fields(&mut row,if provider=="ubiquity"{0}else{1},provider!="ubiquity");row
    }).collect()
}
fn openrouter_native(input: &CatalogInput) -> Vec<SourceJson> {
    if !input.enabled("openrouter") || !input.configured("openrouter") {
        return Vec::new();
    }
    input.rows("openrouter").iter().filter_map(|model|{
        let id=ModelId::from_source(c::get(model,"id").as_ref().and_then(c::string)?);let resolved=input.metadata(&id,None,None,false);
        let mut row=c::object(vec![("slug",c::json(&id)),("display_name",c::json(&id)),("description",c::json("OpenRouter upstream (Chat Completions and Responses) served by this gateway.")),("owned_by",c::json(&openrouter_owner(&id))),("supported_endpoint_types",c::json(&["openai-response","openai-chat"]))]);
        reasoning_fields(&mut row,&resolved,true);apply_resolved_fields(&mut row,&resolved,true,false);common_fields(&mut row,1000,false);Some(row)
    }).collect()
}
fn append_native(rows: &mut Vec<SourceJson>, entries: impl IntoIterator<Item = SourceJson>) {
    for record in entries {
        let id = c::identifier(&record).unwrap_or_default();
        if !rows
            .iter()
            .any(|r| c::identifier(r).is_some_and(|s| c::trim(&s) == c::trim(&id)))
        {
            rows.push(record);
        }
    }
}
fn native_id(row: &SourceJson) -> JsString16 {
    c::normalized(c::get(row, "slug").as_ref())
        .or_else(|| {
            c::get(row, "id")
                .as_ref()
                .and_then(c::string)
                .map(|id| c::trim(&id))
        })
        .unwrap_or_default()
}
fn merge_configured_native(rows: &mut Vec<SourceJson>, input: &CatalogInput, provider: &str) {
    let configured = configured_native_records(input, provider);
    if provider == "deepseek" {
        for row in rows.iter_mut() {
            if let Some(replacement) = configured
                .iter()
                .find(|entry| native_id(entry) == native_id(row))
            {
                *row = replacement.clone();
            }
        }
    }
    append_native(rows, configured);
}
fn unique_paid(input: &CatalogInput) -> Vec<SourceJson> {
    let mut rows = Vec::new();
    for provider in ["openlux", "surplus"] {
        for record in input.available_rows(provider) {
            if endpoint_supports(record, "openai-response")
                && !rows.iter().any(|r| {
                    c::get(r, "id").as_ref().and_then(c::string)
                        == c::get(record, "id").as_ref().and_then(c::string)
                })
            {
                rows.push(record.clone());
            }
        }
    }
    rows
}
pub fn native_catalog(stored: Option<&SourceJson>, input: &CatalogInput) -> SourceJson {
    let mut envelope = stored
        .filter(|v| c::is_object(v))
        .cloned()
        .unwrap_or_else(|| c::object(vec![("models", c::json(&Vec::<SourceJson>::new()))]));
    let mut rows = if input.enabled("codex") {
        stored
            .and_then(|v| c::get(v, "models"))
            .as_ref()
            .and_then(c::array)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    append_native(
        &mut rows,
        unique_paid(input)
            .iter()
            .map(|r| paid_native_record(r, input)),
    );
    append_native(
        &mut rows,
        input
            .available_rows("claude_code")
            .iter()
            .map(claude_native_record),
    );
    for provider in ["deepseek", "ubiquity", "lithos", "cerebras"] {
        merge_configured_native(&mut rows, input, provider);
    }
    append_native(&mut rows, openrouter_native(input));
    c::set(
        &mut envelope,
        "models",
        c::json(&filter_whitelist(rows, input.whitelist.as_ref(), true)),
    );
    envelope
}
pub fn native_catalog_fallback(input: &CatalogInput) -> Option<SourceJson> {
    let paid = unique_paid(input);
    let mut rows = Vec::new();
    append_native(
        &mut rows,
        input
            .available_rows("claude_code")
            .iter()
            .map(claude_native_record),
    );
    append_native(&mut rows, paid.iter().map(|r| paid_native_record(r, input)));
    for provider in ["deepseek", "ubiquity", "lithos", "cerebras"] {
        merge_configured_native(&mut rows, input, provider);
    }
    append_native(&mut rows, openrouter_native(input));
    if rows.is_empty() {
        None
    } else {
        Some(c::object(vec![(
            "models",
            c::json(&filter_whitelist(rows, input.whitelist.as_ref(), true)),
        )]))
    }
}
