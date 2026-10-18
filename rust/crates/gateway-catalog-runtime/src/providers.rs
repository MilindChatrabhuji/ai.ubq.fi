//! Source-observed discovery only; no guessed model capabilities or reasoning tiers.
use crate::host::{CatalogProvider, unavailable};
use gateway_core::GatewayError;
use gateway_schema::util::{js_trim, normalized_string, positive_integer, safe_integer};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn text(value: Option<&Value>) -> Option<String> { normalized_string(value) }
fn positive(value: Option<&Value>) -> Option<i64> { positive_integer(value) }
fn nonnegative(value: Option<&Value>) -> i64 { value.and_then(safe_integer).filter(|n| *n >= 0).unwrap_or(0) }
fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(|v| text(Some(v))).collect()
}
fn copy_string(row: &mut Value, source: &Value, key: &str) {
    if let Some(value) = text(source.get(key)) { row[key] = json!(value); }
}
fn copy_positive(row: &mut Value, key: &str, value: Option<&Value>) {
    if let Some(value) = positive(value) { row[key] = json!(value); }
}
fn number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let number = if let Some(n) = value.as_f64() { n } else {
        let string = js_trim(value.as_str()?);
        if string.is_empty() { return None; }
        if let Some(hex) = string.strip_prefix("0x").or_else(|| string.strip_prefix("0X")) { u64::from_str_radix(hex, 16).ok()? as f64 }
        else if let Some(binary) = string.strip_prefix("0b").or_else(|| string.strip_prefix("0B")) { u64::from_str_radix(binary, 2).ok()? as f64 }
        else if let Some(octal) = string.strip_prefix("0o").or_else(|| string.strip_prefix("0O")) { u64::from_str_radix(octal, 8).ok()? as f64 }
        else { string.parse().ok()? }
    };
    (number.is_finite() && number >= 0.0).then_some(number)
}
fn openlux(raw: &Value) -> Option<Value> {
    let id = text(raw.get("id"))?;
    let mut row = json!({"id":id,"object":"model","created":nonnegative(raw.get("created")),"owned_by":text(raw.get("owned_by")).unwrap_or_else(||"openlux".into()),"supported_endpoint_types":raw.get("supported_endpoint_types").and_then(Value::as_array).map(|a|a.iter().filter(|v|v.is_string()).cloned().collect::<Vec<_>>()).unwrap_or_default()});
    for key in ["model_type", "description", "tags"] { copy_string(&mut row, raw, key); }
    copy_positive(&mut row, "max_output_tokens", raw.get("max_completion_tokens").filter(|v| !v.is_null()).or_else(|| raw.get("max_output_tokens").filter(|v| !v.is_null())).or_else(|| raw.pointer("/top_provider/max_completion_tokens")));
    Some(row)
}
fn modality_has_text(value: &str) -> bool { value.split(['+', ',']).any(|part| js_trim(part) == "text") }
fn supports_text(raw: &Value) -> bool {
    let Some(architecture) = raw.get("architecture").filter(|v| v.is_object()) else { return true; };
    let mut input = None;
    let mut output = None;
    for (key, dest) in [("input_modalities", &mut input), ("output_modalities", &mut output)] {
        let values = architecture.get(key).and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
        if !values.is_empty() { *dest = Some(values.contains(&"text")); }
    }
    if let Some(modality) = text(architecture.get("modality")) {
        if let Some((left, right)) = modality.rsplit_once("->") { input = Some(modality_has_text(left)); output = Some(modality_has_text(right)); }
        else { input = Some(modality_has_text(&modality)); output = input; }
    }
    input != Some(false) && output != Some(false)
}
fn surplus(raw: &Value) -> Option<Value> {
    if !supports_text(raw) { return None; }
    let id = text(raw.get("id"))?;
    let mut row = json!({"id":id,"object":"model","created":nonnegative(raw.get("created")),"owned_by":text(raw.get("provider")).or_else(||text(raw.get("owned_by"))).unwrap_or_else(||"surplus".into()),"supported_endpoint_types":["openai","openai-response"]});
    copy_string(&mut row, raw, "description");
    let parameters = strings(raw.get("supported_parameters"));
    if parameters.iter().any(|v|v=="tools") && parameters.iter().any(|v|v=="tool_choice") && strings(raw.get("supported_features")).iter().any(|v|v=="tools") { row["supports_tools"] = json!(true); }
    if parameters.iter().any(|v|v=="parallel_tool_calls") { row["supports_parallel_tool_calls"] = json!(true); }
    copy_positive(&mut row, "max_output_tokens", raw.pointer("/top_provider/max_completion_tokens"));
    if let Some(pricing) = raw.get("pricing").filter(|v| v.is_object()) {
        for (target, keys) in [("input_price_per_token", &["prompt", "input"][..]), ("output_price_per_token", &["completion", "output"][..]), ("cache_read_price_per_token", &["input_cache_read", "cache_read", "cache_read_input"][..]), ("cache_write_price_per_token", &["input_cache_write", "cache_write", "cache_write_input"][..])] {
            if let Some(value) = number(keys.iter().find_map(|key|pricing.get(key).filter(|v| !v.is_null()))) { row[target] = json!(value); }
        }
    }
    Some(row)
}
fn openrouter(raw: &Value) -> Option<Value> {
    let id = text(raw.get("id"))?;
    let context = positive(raw.get("context_length"));
    let widest = context.into_iter().chain(positive(raw.pointer("/top_provider/context_length"))).max();
    let reasoning = raw.get("reasoning").and_then(|v| {
        if !v.is_object() { return None; }
        let mut seen = BTreeSet::new();
        let efforts = strings(v.get("supported_efforts")).into_iter().filter(|e|seen.insert(e.clone())).collect::<Vec<_>>();
        let default = text(v.get("default_effort"));
        (!efforts.is_empty() || default.is_some()).then(|| json!({"supported_efforts":efforts,"default_effort":default,"mandatory":v.get("mandatory")==Some(&Value::Bool(true))}))
    });
    Some(json!({"id":id,"context_window_tokens":context,"max_context_window_tokens":widest,"reasoning":reasoning}))
}
fn observed_flag(raw: &Value, path: &str) -> Option<bool> { raw.pointer(path)?.get("supported")?.as_bool() }
fn claude(raw: &Value) -> Option<Value> {
    let id = raw.get("id")?.as_str()?;
    if !id.strip_prefix("~anthropic/").or_else(||id.strip_prefix("anthropic/")).unwrap_or(id).starts_with("claude-") || id.len() > 512 { return None; }
    let mut row = json!({"id":id,"created":raw.get("created_at").and_then(Value::as_str).and_then(iso_timestamp).unwrap_or(0)});
    if let Some(display) = raw.get("display_name").filter(|v| v.is_string()) { row["display_name"] = display.clone(); }
    for (target, key) in [("context_window_tokens", "max_input_tokens"), ("max_output_tokens", "max_tokens")] { copy_positive(&mut row, target, raw.get(key)); }
    for (target, path) in [("supports_disabled_thinking", "/capabilities/thinking/types/disabled"), ("supports_adaptive_thinking", "/capabilities/thinking/types/adaptive"), ("supports_image_input", "/capabilities/image_input"), ("supports_pdf_input", "/capabilities/pdf_input")] {
        if let Some(flag) = observed_flag(raw, path) { row[target] = json!(flag); }
    }
    let mut levels = Vec::new();
    if raw.pointer("/capabilities/effort/supported") == Some(&Value::Bool(true)) && row.get("supports_adaptive_thinking") == Some(&Value::Bool(true)) {
        if let Some(effort) = raw.pointer("/capabilities/effort").and_then(Value::as_object) {
            for (key, value) in effort { if key != "supported" && key != "none" && !key.is_empty() && value.get("supported") == Some(&Value::Bool(true)) { levels.push(key.clone()); } }
        }
    }
    row["supported_reasoning_levels"] = json!(levels);
    Some(row)
}
/// Upstream Models API publishes ISO-8601 instants. Invalid dates retain the source's zero.
fn iso_timestamp(raw: &str) -> Option<i64> {
    let date = raw.get(..10)?;
    let year = date.get(..4)?.parse::<i64>().ok()?;
    let month = date.get(5..7)?.parse::<i64>().ok()?;
    let day = date.get(8..10)?.parse::<i64>().ok()?;
    if date.get(4..5)? != "-" || date.get(7..8)? != "-" || !(1..=12).contains(&month) || !(1..=31).contains(&day) { return None; }
    let adjusted = year - i64::from(month <= 2);
    let era = adjusted.div_euclid(400);
    let yoe = adjusted - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * month + 2) / 5 + day - 1 - 719468;
    let time = raw.get(11..19)?;
    let hour = time.get(..2)?.parse::<i64>().ok()?;
    let minute = time.get(3..5)?.parse::<i64>().ok()?;
    let second = time.get(6..8)?.parse::<i64>().ok()?;
    if raw.get(10..11)? != "T" || hour > 23 || minute > 59 || second > 59 { return None; }
    let suffix = raw.get(19..)?;
    let zone_start = suffix.find(['Z', '+', '-'])?;
    let zone = &suffix[zone_start..];
    let offset = if zone == "Z" { 0 } else {
        if zone.len() != 6 || zone.get(3..4)? != ":" { return None; }
        let h = zone.get(1..3)?.parse::<i64>().ok()?;
        let m = zone.get(4..6)?.parse::<i64>().ok()?;
        if h > 23 || m > 59 { return None; }
        (h * 3600 + m * 60) * if zone.starts_with('-') { -1 } else { 1 }
    };
    let timestamp = days * 86400 + hour * 3600 + minute * 60 + second - offset;
    (timestamp > 0).then_some(timestamp)
}
pub(crate) fn parse_page(provider: CatalogProvider, payload: &Value) -> Result<(Vec<Value>, Option<String>), GatewayError> {
    let data = payload.get("data").and_then(Value::as_array).ok_or_else(||unavailable("Provider did not return a model catalog"))?;
    let mut seen = BTreeSet::new();
    let mut models = Vec::new();
    for raw in data {
        if provider == CatalogProvider::ClaudeCode && text(raw.get("id")).is_none() { return Err(unavailable("Claude model discovery returned an invalid row")); }
        let row = match provider {
            CatalogProvider::Openlux => openlux(raw),
            CatalogProvider::Surplus => surplus(raw),
            CatalogProvider::Openrouter => openrouter(raw),
            CatalogProvider::Lithos => text(raw.get("id")).map(|id|json!({"id":id,"created":raw.get("created").and_then(safe_integer).unwrap_or(0)})),
            CatalogProvider::ClaudeCode => claude(raw),
            CatalogProvider::Deepseek | CatalogProvider::Cerebras => return Err(unavailable("This provider has no discovery endpoint")),
        };
        if let Some(row) = row {
            let id = row["id"].as_str().unwrap_or("").to_owned();
            if seen.insert(id) { models.push(row); }
        }
    }
    if provider == CatalogProvider::Openrouter && models.is_empty() { return Err(unavailable("OpenRouter model discovery returned no models")); }
    let next = if provider == CatalogProvider::ClaudeCode {
        match payload.get("has_more").and_then(Value::as_bool) {
            Some(false) => None,
            Some(true) => Some(payload.get("last_id").and_then(Value::as_str).filter(|s|!s.is_empty()).ok_or_else(||unavailable("Claude model discovery returned an invalid cursor"))?.into()),
            None => return Err(unavailable("Claude model discovery omitted pagination evidence")),
        }
    } else { None };
    Ok((models, next))
}
pub(crate) fn withdraw_stale_reasoning(models: &mut [Value]) {
    for model in models { if let Some(row) = model.as_object_mut() { for key in ["supports_disabled_thinking", "supports_adaptive_thinking", "supported_reasoning_levels"] { row.remove(key); } } }
}
fn normalize_key(raw: &str) -> String {
    let mut key = String::new();
    for c in js_trim(raw).chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() { key.push(c); }
        else if !key.is_empty() && !key.ends_with('-') { key.push('-'); }
    }
    key.trim_end_matches('-').into()
}
fn billing_base(raw: &str) -> Option<&str> {
    [":free", "-free", ":batch", "-batch"].iter().find_map(|suffix|raw.strip_suffix(suffix))
}
/// Ambiguous joins degrade to unknown. Source tier precedence is preserved.
pub fn match_openrouter<'a>(models: &'a [Value], model_id: &str) -> Option<&'a Value> {
    let target = js_trim(model_id);
    if target.is_empty() { return None; }
    let slug = target.rsplit('/').next().unwrap_or(target);
    let mut tiers: Vec<BTreeMap<String, Option<usize>>> = (0..6).map(|_| BTreeMap::new()).collect();
    for (index, model) in models.iter().enumerate() {
        let Some(id) = model.get("id").and_then(Value::as_str) else { continue; };
        let model_slug = id.rsplit('/').next().unwrap_or(id);
        let alias = id.strip_prefix('~').and_then(|id|id.rsplit('/').next()).and_then(|s|s.strip_suffix("-latest").or_else(||s.strip_suffix(":latest"))).map(normalize_key);
        let keys = [Some(id.to_lowercase()), Some(model_slug.to_lowercase()), Some(normalize_key(id)), Some(normalize_key(model_slug)), alias, billing_base(model_slug).map(normalize_key)];
        for (tier, key) in tiers.iter_mut().zip(keys) {
            if let Some(key) = key.filter(|s|!s.is_empty()) {
                match tier.get(&key) { None => { tier.insert(key, Some(index)); }, Some(Some(old)) if models[*old].get("id") != model.get("id") => { tier.insert(key, None); }, _ => {} }
            }
        }
    }
    let keys = [target.to_lowercase(), slug.to_lowercase(), normalize_key(target), normalize_key(slug), normalize_key(slug), normalize_key(slug)];
    for (tier, key) in tiers.iter().zip(keys) { if let Some(Some(index)) = tier.get(&key) { return models.get(*index); } }
    if let Some(stripped) = billing_base(slug) {
        for (tier, key) in [(&tiers[1], stripped.to_lowercase()), (&tiers[3], normalize_key(stripped))] { if let Some(Some(index)) = tier.get(&key) { return models.get(*index); } }
    }
    None
}
