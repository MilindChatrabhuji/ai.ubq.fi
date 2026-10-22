//! Small runtime catalog projection; source model/effort controls never pass through Value.
use crate::source_request::SourceRequestError;
use crate::{
    model_control as c, prompt_cache::compact_capabilities_source, reasoning::ModelReasoning,
    snapshot::ModelSnapshot,
};
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, source_json::SourceJson,
    source_serialization as source,
};
fn error(message: impl Into<String>) -> GatewayError {
    GatewayError::new(503, message, Some("runtime_config_invalid"))
}
pub fn default_model(value: &SourceJson) -> Option<ModelId> {
    c::normalized(c::get(value, "default_model").as_ref()).map(ModelId::from_source)
}
pub fn default_reasoning_effort(value: &SourceJson) -> Option<JsString16> {
    c::normalized(c::get(value, "default_reasoning_effort").as_ref())
}
pub fn compact_snapshot(snapshot: &ModelSnapshot) -> Result<SourceJson, GatewayError> {
    let mut models = Vec::new();
    let mut seen = Vec::new();
    for record in &snapshot.models {
        let Some(slug) = c::identifier(record)
            .map(|s| c::trim(&s))
            .filter(|s| !s.as_units().is_empty())
        else {
            continue;
        };
        if seen.contains(&slug) {
            continue;
        }
        seen.push(slug.clone());
        let reasoning = ModelReasoning::from_record(Some(record));
        let mut row = c::object(vec![("slug", c::json(&slug))]);
        if let Some(default) = reasoning.default_level {
            c::set(&mut row, "default_reasoning_level", c::json(&default));
        }
        c::set(
            &mut row,
            "supported_reasoning_levels",
            c::json(&reasoning.levels),
        );
        let mut wires = reasoning.wire_efforts;
        if reasoning.levels.iter().any(|s| c::matches(s, "ultra")) {
            c::set(&mut wires, "ultra", c::json("max"));
        }
        if source::entries(&wires).is_some_and(|w| !w.is_empty()) {
            c::set(&mut row, "reasoning_effort_wire_map", wires);
        }
        if let Some(cache) = compact_capabilities_source(c::get(record, "prompt_cache").as_ref()) {
            c::set(&mut row, "prompt_cache", cache);
        }
        models.push(row);
    }
    if models.is_empty() {
        return Err(error(
            "runtime config requires a non-empty Codex model catalog",
        ));
    }
    let source_label = c::trim(&snapshot.source);
    if source_label.as_units().is_empty() || snapshot.updated_at_ms <= 0 {
        return Err(error(
            "runtime config requires valid Codex catalog metadata",
        ));
    }
    let mut value = c::object(vec![
        ("models", c::json(&models)),
        ("source", c::json(&source_label)),
        ("updated_at_ms", c::json(&snapshot.updated_at_ms)),
    ]);
    if let Some(version) = snapshot
        .client_version
        .as_deref()
        .map(crate::util::js_trim)
        .filter(|s| !s.is_empty())
    {
        c::set(&mut value, "client_version", c::json(version));
    }
    Ok(value)
}
pub fn build_runtime_config(
    snapshot: &ModelSnapshot,
    default_model: Option<&ModelId>,
    default_effort: Option<&JsString16>,
    now_ms: i64,
) -> Result<SourceJson, SourceRequestError> {
    let compact = compact_snapshot(snapshot).map_err(SourceRequestError::from_gateway)?;
    let requested = default_model
        .map(|m| c::trim(m.as_js_string()))
        .filter(|s| !s.as_units().is_empty());
    let models = c::get(&compact, "models")
        .as_ref()
        .and_then(c::array)
        .expect("validated compact catalog");
    let model = requested
        .or_else(|| {
            models
                .first()
                .and_then(|m| c::get(m, "slug"))
                .as_ref()
                .and_then(c::string)
        })
        .ok_or_else(|| {
            SourceRequestError::from_gateway(error("runtime config requires a default model"))
        })?;
    if !models.iter().any(|row| {
        c::get(row, "slug")
            .as_ref()
            .and_then(c::string)
            .is_some_and(|slug| slug == model)
    }) {
        let prefix =
            JsString16::from_utf8("runtime config default model is absent from the catalog: ");
        return Err(SourceRequestError::new(
            503,
            c::concat(&[&prefix, &model]),
            "invalid_request_error",
            Some("runtime_config_invalid"),
            None,
        ));
    }
    let effort = default_effort
        .map(c::trim)
        .filter(|s| !s.as_units().is_empty())
        .unwrap_or_else(|| "medium".into());
    let value = c::object(vec![
        ("version", c::json(&2)),
        ("default_model", c::json(&model)),
        ("default_reasoning_effort", c::json(&effort)),
        ("codex_models", compact),
        ("updated_at_ms", c::json(&now_ms)),
    ]);
    let value = source::canonical(&value).map_err(SourceRequestError::from_gateway)?;
    let bytes = value.as_str().len();
    if bytes > 4096 {
        return Err(SourceRequestError::from_gateway(error(format!(
            "runtime config is too large ({bytes} bytes; maximum 4096 bytes)"
        ))));
    }
    Ok(value)
}
pub fn normalize_runtime_config(value: &SourceJson) -> Option<SourceJson> {
    if c::get(value, "version").as_ref().and_then(source::number) != Some(2.0) {
        return None;
    }
    let snapshot = c::get(value, "codex_models")?
        .deserialize::<ModelSnapshot>()
        .ok()?;
    let model = default_model(value)?;
    let effort = default_reasoning_effort(value)?;
    let time = c::get(value, "updated_at_ms")
        .as_ref()
        .and_then(source::number)?
        .trunc() as i64;
    if time <= 0 {
        return None;
    }
    build_runtime_config(&snapshot, Some(&model), Some(&effort), time).ok()
}
