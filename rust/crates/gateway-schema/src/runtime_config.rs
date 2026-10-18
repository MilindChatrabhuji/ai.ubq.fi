//! Small runtime catalog projection; full context/probe evidence stays in the full snapshot.
use crate::{
    prompt_cache::compact_capabilities, reasoning::ModelReasoning, snapshot::ModelSnapshot, util::*,
};
use gateway_core::GatewayError;
use serde_json::{Value, json};
fn error(message: impl Into<String>) -> GatewayError {
    GatewayError::new(503, message, Some("runtime_config_invalid"))
}
pub fn compact_snapshot(snapshot: &ModelSnapshot) -> Result<Value, GatewayError> {
    let mut models = Vec::new();
    let mut seen = Vec::new();
    for record in &snapshot.models {
        let Some(slug) = identifier(record)
            .map(crate::util::js_trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if seen.contains(&slug) {
            continue;
        }
        seen.push(slug);
        let reasoning = ModelReasoning::from_record(Some(record));
        let mut row = json!({"slug":slug});
        if let Some(default) = reasoning.default_level {
            row["default_reasoning_level"] = json!(default);
        }
        row["supported_reasoning_levels"] = json!(reasoning.levels);
        let mut wires = reasoning.wire_efforts;
        if reasoning.levels.iter().any(|s| s == "ultra") {
            wires.insert("ultra".into(), json!("max"));
        }
        if !wires.is_empty() {
            row["reasoning_effort_wire_map"] = Value::Object(wires);
        }
        if let Some(cache) = compact_capabilities(record.get("prompt_cache")) {
            row["prompt_cache"] = cache;
        }
        models.push(row);
    }
    if models.is_empty() {
        return Err(error(
            "runtime config requires a non-empty Codex model catalog",
        ));
    }
    if snapshot
        .source
        .trim_matches(crate::util::js_whitespace)
        .is_empty()
        || snapshot.updated_at_ms <= 0
    {
        return Err(error(
            "runtime config requires valid Codex catalog metadata",
        ));
    }
    let mut value = json!({"models":models,"source":snapshot.source.trim_matches(crate::util::js_whitespace),"updated_at_ms":snapshot.updated_at_ms});
    if let Some(version) = snapshot
        .client_version
        .as_deref()
        .map(crate::util::js_trim)
        .filter(|s| !s.is_empty())
    {
        value["client_version"] = json!(version);
    }
    Ok(value)
}
pub fn build_runtime_config(
    snapshot: &ModelSnapshot,
    default_model: Option<&str>,
    default_effort: Option<&str>,
    now_ms: i64,
) -> Result<Value, GatewayError> {
    let compact = compact_snapshot(snapshot)?;
    let requested = default_model
        .map(crate::util::js_trim)
        .filter(|s| !s.is_empty());
    let model = requested
        .map(str::to_owned)
        .or_else(|| {
            compact["models"]
                .as_array()
                .and_then(|m| m.first())
                .and_then(|m| m.get("slug"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(|| error("runtime config requires a default model"))?;
    if !compact["models"]
        .as_array()
        .is_some_and(|m| m.iter().any(|r| r["slug"].as_str() == Some(&model)))
    {
        return Err(error(format!(
            "runtime config default model is absent from the catalog: {model}"
        )));
    }
    let value = json!({"version":2,"default_model":model,"default_reasoning_effort":default_effort.map(crate::util::js_trim).filter(|s|!s.is_empty()).unwrap_or("medium"),"codex_models":compact,"updated_at_ms":now_ms});
    let bytes = json_stringify(&value).len();
    if bytes > 4096 {
        return Err(error(format!(
            "runtime config is too large ({bytes} bytes; maximum 4096 bytes)"
        )));
    }
    Ok(value)
}
pub fn normalize_runtime_config(value: &Value) -> Option<Value> {
    if value.get("version").and_then(safe_integer) != Some(2) {
        return None;
    }
    let raw = value.get("codex_models")?;
    let snapshot: ModelSnapshot = serde_json::from_value(raw.clone()).ok()?;
    let model = normalized_string(value.get("default_model"))?;
    let effort = normalized_string(value.get("default_reasoning_effort"))?;
    let time = value.get("updated_at_ms")?.as_f64()?.trunc() as i64;
    if time <= 0 {
        return None;
    }
    build_runtime_config(&snapshot, Some(&model), Some(&effort), time).ok()
}
