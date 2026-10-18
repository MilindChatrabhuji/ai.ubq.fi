//! Rich exact-client-version Codex catalog. Never substitute the official model-list envelope.
use crate::{catalog::*, metadata::*, provider_catalog::*, util::*};
use serde_json::{Value, json};
fn description(effort: &str) -> String {
    if effort == "none" {
        "No reasoning".into()
    } else {
        format!("Reasoning effort: {effort}")
    }
}
fn common_fields(row: &mut Value, priority: i64, forwarding: bool) {
    for (key, value) in [
        ("shell_type", json!("shell_command")),
        ("visibility", json!("list")),
        ("supported_in_api", json!(true)),
        ("priority", json!(priority)),
        ("availability_nux", Value::Null),
        ("upgrade", Value::Null),
        ("base_instructions", json!("")),
        ("support_verbosity", json!(false)),
        ("default_verbosity", Value::Null),
        ("apply_patch_tool_type", Value::Null),
        ("web_search_tool_type", json!("text")),
        ("truncation_policy", json!({"mode":"tokens","limit":10000})),
    ] {
        row[key] = value;
    }
    if forwarding {
        row["forwarding_policy"] = json!({"version":"deepseek-forwarded-payload/v1","mode":"bytes","per_message_limit":65_536});
    }
    row["supports_parallel_tool_calls"] = json!(false);
    row["experimental_supported_tools"] = json!([]);
}
fn reasoning_fields(row: &mut Value, resolved: &ResolvedMetadata, external: bool) {
    let levels = resolved.supported_reasoning_levels.as_ref().map(|levels| {
        if external {
            ascending_external_levels(levels)
        } else {
            levels.clone()
        }
    });
    row["supported_reasoning_levels"] = json!(
        levels
            .as_ref()
            .filter(|l| !l.is_empty())
            .cloned()
            .unwrap_or_else(|| vec!["none".into()])
            .iter()
            .map(|e| json!({"effort":e,"description":description(e)}))
            .collect::<Vec<_>>()
    );
    if let Some(default) = &resolved.default_reasoning_effort {
        row["default_reasoning_level"] = json!(default);
    } else if resolved.supported_reasoning_levels.is_none() {
        row["default_reasoning_level"] = json!("none");
    }
}
pub fn paid_native_record(model: &Value, input: &CatalogInput) -> Value {
    let id = model["id"].as_str().unwrap_or("");
    let codex = input.codex().and_then(|s| s.find(id));
    let resolved = input.metadata(id, codex, None, codex.is_some());
    let mut row = json!({"slug":id,"display_name":id});
    if let Some(description) = model.get("description") {
        row["description"] = description.clone();
    }
    row["owned_by"] = model["owned_by"].clone();
    row["supported_endpoint_types"] = model["supported_endpoint_types"].clone();
    reasoning_fields(&mut row, &resolved, codex.is_none());
    apply_resolved_fields(&mut row, &resolved, true, false);
    common_fields(&mut row, 1000, false);
    row
}
pub fn claude_native_record(model: &Value) -> Value {
    let mut row = json!({"slug":model["id"],"display_name":model.get("display_name").unwrap_or(&model["id"]),"owned_by":"anthropic","supported_endpoint_types":["openai-response","openai"],"supported_reasoning_levels":claude_levels(model).iter().map(|e|json!({"effort":e,"description":if e=="none"{"No reasoning"}else{e.as_str()}})).collect::<Vec<_>>()});
    if model.get("supports_disabled_thinking") == Some(&Value::Bool(true)) {
        row["default_reasoning_level"] = json!("none");
    }
    if let Some(window) = positive_integer(model.get("context_window_tokens")) {
        row["context_window"] = json!(window);
        row["max_context_window"] = json!(window);
    }
    if let Some(max) = positive_integer(model.get("max_output_tokens")) {
        row["max_output_tokens"] = json!(max);
    }
    common_fields(&mut row, 1000, false);
    row
}
pub fn configured_native_records(input: &CatalogInput, provider: &str) -> Vec<Value> {
    if !input.enabled(provider)
        || (provider == "ubiquity" && !input.synthetic_configured())
        || (provider != "ubiquity" && !input.configured(provider))
    {
        return Vec::new();
    }
    provider_ids(provider).iter().map(|id|{
        let mut row=json!({"slug":id,"display_name":display_name(provider,id)});
        row["description"]=json!(match provider{"deepseek"=>"DeepSeek official API (deepseek-flash) served by this gateway.","lithos"=>"LithosAI API (Chat Completions) served by this gateway.","cerebras"=>"Cerebras API (Chat Completions) served by this gateway.",_=>"Latest DeepSeek Flash waterfall: official DeepSeek, OpenRouter, LithosAI, Surplus, and OpenLux. Each hop uses the provider's latest alias and falls back only on infrastructure or serving failures."});
        row["owned_by"]=json!(provider);row["supported_endpoint_types"]=if provider=="ubiquity"{json!(["openai-response"])}else{json!(["openai-response","openai-chat"])};
        let hint=provider_hint(provider,id);let resolved=if provider=="cerebras"||provider=="ubiquity"{resolve_metadata(&MetadataSources{provider:Some(hint.clone()),..MetadataSources::default()})}else{input.metadata(id,None,Some(hint.clone()),false)};
        let levels=hint.supported_reasoning_levels.as_deref().unwrap_or(&[]);row["supported_reasoning_levels"]=json!(levels.iter().filter_map(Value::as_str).map(|e|{let label=if provider=="deepseek"{match e{"none"=>"Disable thinking mode".to_owned(),"low"=>"Thinking effort: low".into(),"high"=>"Thinking effort: high".into(),_=>"Thinking effort: maximum".into()}}else{description(e)};json!({"effort":e,"description":label})}).collect::<Vec<_>>());row["default_reasoning_level"]=json!(hint.default_reasoning_effort);apply_resolved_fields(&mut row,&resolved,true,false);common_fields(&mut row,if provider=="ubiquity"{0}else{1},provider!="ubiquity");row
    }).collect()
}
fn openrouter_native(input: &CatalogInput) -> Vec<Value> {
    if !input.enabled("openrouter") || !input.configured("openrouter") {
        return Vec::new();
    }
    input.rows("openrouter").iter().filter_map(|model|{let id=model.get("id")?.as_str()?;let resolved=input.metadata(id,None,None,false);let mut row=json!({"slug":id,"display_name":id,"description":"OpenRouter upstream (Chat Completions and Responses) served by this gateway.","owned_by":id.split('/').next().filter(|s|!s.is_empty()).unwrap_or("openrouter"),"supported_endpoint_types":["openai-response","openai-chat"]});reasoning_fields(&mut row,&resolved,true);apply_resolved_fields(&mut row,&resolved,true,false);common_fields(&mut row,1000,false);Some(row)}).collect()
}
fn append_native(rows: &mut Vec<Value>, entries: impl IntoIterator<Item = Value>) {
    for record in entries {
        let id = identifier(&record).unwrap_or("");
        if !rows.iter().any(|r| {
            identifier(r).is_some_and(|s| {
                s.trim_matches(crate::util::js_whitespace)
                    == id.trim_matches(crate::util::js_whitespace)
            })
        }) {
            rows.push(record);
        }
    }
}
fn unique_paid(input: &CatalogInput) -> Vec<Value> {
    let mut rows = Vec::new();
    for provider in ["openlux", "surplus"] {
        for record in input.available_rows(provider) {
            if endpoint_supports(record, "openai-response")
                && !rows.iter().any(|r: &Value| r["id"] == record["id"])
            {
                rows.push(record.clone());
            }
        }
    }
    rows
}
pub fn native_catalog(stored: Option<&Value>, input: &CatalogInput) -> Value {
    let mut envelope = stored
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({"models":[]}));
    let mut rows = if input.enabled("codex") {
        stored
            .and_then(|v| v.get("models"))
            .and_then(Value::as_array)
            .cloned()
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
        append_native(&mut rows, configured_native_records(input, provider));
    }
    append_native(&mut rows, openrouter_native(input));
    envelope["models"] = json!(filter_whitelist(rows, input.whitelist.as_ref(), true));
    envelope
}
pub fn native_catalog_fallback(input: &CatalogInput) -> Option<Value> {
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
        append_native(&mut rows, configured_native_records(input, provider));
    }
    append_native(&mut rows, openrouter_native(input));
    if rows.is_empty() {
        None
    } else {
        Some(json!({"models":filter_whitelist(rows,input.whitelist.as_ref(),true)}))
    }
}
