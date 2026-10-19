//! Named default/model snapshot audit; source text never crosses a Value transcript.
use super::{ObservedRow, source_fields};
use gateway_core::{
    GatewayError, js_string::JsString16, source_control::decode_source_control_record,
    source_json::SourceJson, source_serialization as source,
};
use serde_json::json;

// Exact existing profile::js_string coercion for this finite source JSON domain.
// Serialization/grammar stay in the shared SourceJson/JsString16 implementation.
fn diagnostic_text(value: &SourceJson) -> Result<JsString16, GatewayError> {
    if let Some(text) = source::string(value) {
        return Ok(text);
    }
    if let Some(values) = source::array(value) {
        let mut units = Vec::new();
        for (index, value) in values.iter().enumerate() {
            if index != 0 {
                units.push(u16::from(b','));
            }
            if value.as_str() != "null" {
                units.extend(diagnostic_text(value)?.into_units());
            }
        }
        return Ok(JsString16::from_units(units));
    }
    if source::entries(value).is_some() {
        return Ok(JsString16::from_utf8("[object Object]"));
    }
    Ok(JsString16::from_utf8(&crate::profile::js_string(
        &value.deserialize()?,
    )))
}
pub fn inspect_model_snapshot(rows: &[ObservedRow]) -> Result<Vec<JsString16>, GatewayError> {
    let get = |parts: &[serde_json::Value]| {
        rows.iter()
            .find(|row| row.parts == parts)
            .map(|row| decode_source_control_record(&row.record))
            .transpose()
    };
    let default = get(&[json!("default"), json!("model")])?.filter(|value| {
        !matches!(value.as_str(), "null" | "false")
            && source::number(value) != Some(0.0)
            && source::string(value).is_none_or(|text| !text.as_units().is_empty())
    });
    let snapshot = get(&[json!("ubq_ai"), json!("codex_models")])?;
    let mut errors = Vec::new();
    if let Some(default) = default
        && let Some(snapshot) = snapshot.filter(|value| value.as_str() != "null")
    {
        let models = source::member(&snapshot, "models").and_then(|value| source::array(&value));
        let prefix = if models.as_ref().is_none_or(Vec::is_empty) {
            Some("codex model snapshot is empty or malformed; cannot validate default model: ")
        } else if !models.as_ref().into_iter().flatten().any(|model| {
            ["slug", "id", "model", "name"].iter().any(|field| {
                source::member(model, field)
                    .is_some_and(|candidate| source_fields::same_value(&candidate, &default))
            })
        }) {
            Some("default model is not present in codex model snapshot: ")
        } else {
            None
        };
        if let Some(prefix) = prefix {
            let mut units = prefix.encode_utf16().collect::<Vec<_>>();
            units.extend(diagnostic_text(&default)?.into_units());
            errors.push(JsString16::from_units(units));
        }
    }
    Ok(errors)
}
