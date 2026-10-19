//! Lossless prompt-cache metadata policy shared by source and actual-scalar entrypoints.
use super::value::{Value, json, normalized_string, unknown_key};
use crate::prompt_cache::SCOPE_PROFILE;
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
#[derive(Default)]
struct Map(Vec<(JsString16, Value)>);
impl Map {
    fn new() -> Self {
        Self::default()
    }
    fn insert(&mut self, key: String, value: Value) {
        let key = JsString16::from_utf8(&key);
        if let Some((_, old)) = self.0.iter_mut().find(|(name, _)| name == &key) {
            *old = value;
        } else {
            self.0.push((key, value));
        }
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}
fn safe_integer(value: &Value) -> Option<i64> {
    let Value::Number(raw) = value else {
        return None;
    };
    let number = source::number(raw)?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= crate::util::MAX_SAFE_INTEGER)
        .then_some(number as i64)
}
fn enum_list(value: &Value, allowed: Option<&[&str]>, filter: bool) -> Option<Vec<Value>> {
    let values = value.as_array()?;
    let mut result = Vec::new();
    for value in values {
        let text = if filter {
            value.as_text()?.trim_matches(crate::util::js_whitespace)
        } else {
            value.as_text()?.clone()
        };
        if text.is_empty() {
            return None;
        }
        if let Some(allowed) = allowed
            && !allowed.iter().any(|value| {
                text.core()
                    .as_units()
                    .iter()
                    .copied()
                    .eq(value.encode_utf16())
            })
        {
            if filter {
                continue;
            }
            return None;
        }
        let item = Value::String(text.to_owned());
        if !result.contains(&item) {
            result.push(item);
        }
    }
    Some(result)
}
fn timestamp(value: Option<&Value>) -> Option<i64> {
    value.and_then(safe_integer).filter(|n| *n >= 0)
}
fn normalize_block_types(value: &Value) -> Option<Value> {
    if !value.is_object() || unknown_key(value, &["responses", "chat_completions"]).is_some() {
        return None;
    }
    let mut result = Map::new();
    for (endpoint, allowed) in [
        (
            "responses",
            &["input_text", "input_image", "input_file"][..],
        ),
        ("chat_completions", &["text", "image_url", "file"][..]),
    ] {
        if let Some(list) = value.get(endpoint) {
            let entries = enum_list(list, Some(allowed), true)?;
            if !entries.is_empty() {
                result.insert(endpoint.into(), Value::Array(entries));
            }
        }
    }
    (!result.is_empty()).then_some(Value::object(result.0))
}
fn normalize_controls(value: &Value) -> Option<Value> {
    if !value.is_object()
        || unknown_key(
            value,
            &[
                "key",
                "implicit",
                "explicit_breakpoints",
                "modes",
                "ttls",
                "legacy_retentions",
                "breakpoint_block_types",
                "expected_usage_fields",
                "source",
                "verified_at_ms",
            ],
        )
        .is_some()
    {
        return None;
    }
    let source = value.get("source")?.as_str()?;
    if !["catalog", "live_probe", "inferred"].contains(&source) {
        return None;
    }
    let time = timestamp(value.get("verified_at_ms"))?;
    let mut result = Map::new();
    for key in ["key", "implicit", "explicit_breakpoints"] {
        if let Some(v) = value.get(key) {
            if !v.is_boolean() {
                return None;
            }
            result.insert(key.into(), v.clone());
        }
    }
    for (key, allowed, filter, omit_empty) in [
        ("modes", &["implicit", "explicit"][..], false, false),
        ("ttls", &["30m"][..], true, true),
        ("legacy_retentions", &["in_memory", "24h"][..], true, true),
        (
            "expected_usage_fields",
            &["cached_tokens", "cache_write_tokens"][..],
            false,
            false,
        ),
    ] {
        if let Some(v) = value.get(key) {
            let list = enum_list(v, Some(allowed), filter)?;
            if !omit_empty || !list.is_empty() {
                result.insert(key.into(), Value::Array(list));
            }
        }
    }
    if let Some(v) = value.get("breakpoint_block_types") {
        result.insert("breakpoint_block_types".into(), normalize_block_types(v)?);
    }
    result.insert("source".into(), json!(source));
    result.insert("verified_at_ms".into(), json!(time));
    Some(Value::object(result.0))
}
pub(super) fn normalize_scope(value: &Value) -> Option<Value> {
    if !value.is_object()
        || unknown_key(
            value,
            &[
                "probe_profile",
                "account_slots",
                "token_refresh",
                "conversation_id",
                "effective_model",
                "reproducible_cycles",
                "source",
                "verified_at_ms",
            ],
        )
        .is_some()
    {
        return None;
    }
    if value.get("probe_profile").and_then(Value::as_str) != Some(SCOPE_PROFILE)
        || value.get("source").and_then(Value::as_str) != Some("live_probe")
    {
        return None;
    }
    for (key, allowed) in [
        (
            "account_slots",
            &["shared", "account_scoped", "unknown"][..],
        ),
        ("token_refresh", &["preserved", "changed", "unknown"][..]),
        ("conversation_id", &["independent", "scoped", "unknown"][..]),
    ] {
        if !value
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|s| allowed.contains(&s))
        {
            return None;
        }
    }
    let cycles = timestamp(value.get("reproducible_cycles"))?;
    if cycles < 3 {
        return None;
    }
    let time = timestamp(value.get("verified_at_ms"))?;
    let mut next = json!({"probe_profile":SCOPE_PROFILE,"account_slots":value["account_slots"],"token_refresh":value["token_refresh"],"conversation_id":value["conversation_id"]});
    if value.get("effective_model").is_some() {
        next["effective_model"] = Value::String(normalized_string(value.get("effective_model"))?);
    }
    next["reproducible_cycles"] = json!(cycles);
    next["source"] = json!("live_probe");
    next["verified_at_ms"] = json!(time);
    Some(next)
}
pub(super) fn normalize_capabilities(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if value == &Value::Bool(false) {
        return Some(Value::Bool(false));
    }
    if !value.is_object()
        || unknown_key(value, &["version", "providers"]).is_some()
        || value.get("version").and_then(safe_integer) != Some(1)
    {
        return None;
    }
    let providers = value.get("providers")?.as_array()?;
    if providers.is_empty() {
        return None;
    }
    let mut result = Vec::new();
    let mut seen = Vec::new();
    for provider in providers {
        if !provider.is_object() || unknown_key(provider, &["id", "controls", "scope"]).is_some() {
            return None;
        }
        let id = normalized_string(provider.get("id"))?;
        if seen.contains(&id) {
            return None;
        }
        seen.push(id.clone());
        let mut item = json!({"id":id});
        if let Some(v) = provider.get("controls") {
            item["controls"] = normalize_controls(v)?;
        }
        if let Some(v) = provider.get("scope") {
            item["scope"] = normalize_scope(v)?;
        }
        result.push(item);
    }
    Some(json!({"version":1,"providers":result}))
}
pub(super) fn compact_capabilities(value: Option<&Value>) -> Option<Value> {
    let normalized = normalize_capabilities(value)?;
    if normalized == Value::Bool(false) {
        return Some(normalized);
    }
    let providers: Vec<_> = normalized["providers"]
        .as_array()?
        .iter()
        .filter_map(|p| {
            p.get("controls")
                .map(|c| json!({"id":p["id"],"controls":c}))
        })
        .collect();
    (!providers.is_empty()).then(|| json!({"version":1,"providers":providers}))
}
pub(super) fn merge_capabilities(previous: Option<&Value>, next: Option<&Value>) -> Option<Value> {
    let previous = normalize_capabilities(previous);
    let next = normalize_capabilities(next);
    let Some(next) = next else { return previous };
    if next == Value::Bool(false) {
        return Some(next);
    }
    let Some(previous) = previous.filter(|v| v != &Value::Bool(false)) else {
        return Some(next);
    };
    let old = previous["providers"].as_array()?;
    let mut providers = Vec::new();
    for provider in next["providers"].as_array()? {
        let prior = old.iter().find(|p| p["id"] == provider["id"]);
        let mut merged = json!({"id":provider["id"]});
        for key in ["controls", "scope"] {
            if let Some(v) = provider.get(key).or_else(|| prior.and_then(|p| p.get(key))) {
                merged[key] = v.clone();
            }
        }
        providers.push(merged);
    }
    for provider in old {
        if !providers.iter().any(|p| p["id"] == provider["id"]) {
            providers.push(provider.clone());
        }
    }
    Some(json!({"version":1,"providers":providers}))
}
pub(super) fn concrete_scope(scope: &Value, reproducible_cycles: i64) -> bool {
    scope.get("probe_profile").and_then(Value::as_str) == Some(SCOPE_PROFILE)
        && scope.get("source").and_then(Value::as_str) == Some("live_probe")
        && ["account_slots", "token_refresh", "conversation_id"]
            .iter()
            .all(|k| {
                scope
                    .get(k)
                    .and_then(Value::as_str)
                    .is_some_and(|s| s != "unknown")
            })
        && scope.get("reproducible_cycles").and_then(Value::as_i64) == Some(reproducible_cycles)
        && normalized_string(scope.get("effective_model")).is_some()
}

pub(crate) fn normalize_capabilities_source(value: Option<&SourceJson>) -> Option<SourceJson> {
    let value = value.map(|value| Value::from_source(value.clone()));
    normalize_capabilities(value.as_ref())?.source().ok()
}
pub(crate) fn normalize_scope_source(value: &SourceJson) -> Option<SourceJson> {
    normalize_scope(&Value::from_source(value.clone()))?
        .source()
        .ok()
}
pub(crate) fn compact_capabilities_source(value: Option<&SourceJson>) -> Option<SourceJson> {
    let value = value.map(|value| Value::from_source(value.clone()));
    compact_capabilities(value.as_ref())?.source().ok()
}
pub(crate) fn merge_capabilities_source(
    previous: Option<&SourceJson>,
    next: Option<&SourceJson>,
) -> Option<SourceJson> {
    let previous = previous.map(|value| Value::from_source(value.clone()));
    let next = next.map(|value| Value::from_source(value.clone()));
    merge_capabilities(previous.as_ref(), next.as_ref())?
        .source()
        .ok()
}
pub(crate) fn concrete_scope_source(value: &SourceJson, cycles: i64) -> bool {
    concrete_scope(&Value::from_source(value.clone()), cycles)
}
