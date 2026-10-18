//! src/request-policy.ts:98-163,412-451,565-613; tiers are deliberately open strings.
use crate::util::{invalid, normalized_string, push_unique};
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelReasoning {
    pub levels: Vec<String>,
    pub default_level: Option<String>,
    pub wire_efforts: Map<String, Value>,
}
pub fn advertised_effort(value: &Value) -> Option<String> {
    let raw = if value.is_object() {
        value.get("effort")?
    } else {
        value
    };
    if raw.is_null() {
        Some("none".to_owned())
    } else {
        normalized_string(Some(raw))
    }
}
impl ModelReasoning {
    pub fn from_record(record: Option<&Value>) -> Self {
        let mut levels = Vec::new();
        if let Some(entries) = record
            .and_then(|r| r.get("supported_reasoning_levels"))
            .and_then(Value::as_array)
        {
            for effort in entries.iter().filter_map(advertised_effort) {
                push_unique(&mut levels, effort);
            }
        }
        let default_level = record
            .and_then(|r| r.get("default_reasoning_level"))
            .and_then(|v| {
                if v.is_null() {
                    Some("none".into())
                } else {
                    normalized_string(Some(v))
                }
            });
        if let Some(default) = &default_level {
            push_unique(&mut levels, default.clone());
        }
        let mut wire_efforts = Map::new();
        if let Some(wires) = record
            .and_then(|r| r.get("reasoning_effort_wire_map"))
            .and_then(Value::as_object)
        {
            for (key, value) in wires {
                if let (Some(key), Some(value)) = (
                    normalized_string(Some(&Value::String(key.clone()))),
                    normalized_string(Some(value)),
                ) {
                    wire_efforts.insert(key, Value::String(value));
                }
            }
        }
        Self {
            levels,
            default_level,
            wire_efforts,
        }
    }
}
pub fn parse_effort(value: Option<&Value>, field: &str) -> Result<Option<String>, GatewayError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    if !value.is_string() {
        return Err(invalid(format!("{field} must be a string"), Some(field)));
    }
    normalized_string(Some(value))
        .map(Some)
        .ok_or_else(|| invalid(format!("{field} must be a non-empty string"), Some(field)))
}
pub fn parse_reasoning(value: Option<&Value>) -> Result<Option<Map<String, Value>>, GatewayError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let Some(record) = value.as_object() else {
        return Err(invalid("reasoning must be an object", Some("reasoning")));
    };
    let mut normalized = record.clone();
    if let Some(effort) = record.get("effort") {
        let parsed = parse_effort(Some(effort), "reasoning.effort").map_err(|mut e| {
            e.envelope.error.param = Some(Some("reasoning".into()));
            e
        })?;
        match parsed {
            Some(effort) => {
                normalized.insert("effort".into(), Value::String(effort));
            }
            None => {
                normalized.shift_remove("effort");
            }
        }
    }
    for field in ["summary", "generate_summary"] {
        if let Some(value) = record.get(field) {
            if value.is_null() {
                normalized.shift_remove(field);
            } else if !value.is_string() {
                return Err(invalid(
                    format!("reasoning.{field} must be a string"),
                    Some("reasoning"),
                ));
            }
        }
    }
    Ok((!normalized.is_empty()).then_some(normalized))
}
pub fn effort_for_codex(effort: &str, model: &ModelReasoning) -> String {
    match effort {
        "none" => "none".into(),
        "ultra" => "max".into(),
        _ => model
            .wire_efforts
            .get(effort)
            .and_then(Value::as_str)
            .unwrap_or(effort)
            .to_owned(),
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedReasoning {
    pub label: String,
    pub value: Map<String, Value>,
}
pub fn resolve_reasoning(
    value: Option<&Value>,
    model: &ModelReasoning,
    default_effort: &str,
) -> Result<ResolvedReasoning, GatewayError> {
    let parsed = parse_reasoning(value)?;
    let label = parsed
        .as_ref()
        .and_then(|r| normalized_string(r.get("effort")))
        .unwrap_or_else(|| default_effort.to_owned());
    let mut value = parsed.unwrap_or_else(|| {
        let mut m = Map::new();
        m.insert(
            "effort".into(),
            Value::String(effort_for_codex(&label, model)),
        );
        m
    });
    if let Some(effort) = value.get("effort").and_then(Value::as_str) {
        value.insert(
            "effort".into(),
            Value::String(effort_for_codex(effort, model)),
        );
    }
    Ok(ResolvedReasoning { label, value })
}
