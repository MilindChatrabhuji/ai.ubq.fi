//! Source request syntax. Provider-specific interpretation remains outside official allowlists.
use crate::{allowlists::*, prompt_cache::validate_prompt_cache_controls, util::*};
use gateway_core::GatewayError;
use serde_json::{Value, json};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestSurface {
    ChatCompletions,
    Responses,
}
#[derive(Clone, Debug, Default)]
pub struct RequestExtensions {
    pub deepseek_thinking: bool,
    pub openrouter_cache_control: bool,
}
pub fn validate_request_fields(
    body: &Value,
    surface: RequestSurface,
    extensions: &RequestExtensions,
) -> Result<(), GatewayError> {
    if !is_record(body) {
        return Err(invalid("Invalid JSON body", None));
    }
    let allowed = match surface {
        RequestSurface::ChatCompletions => CHAT_COMPLETIONS_REQUEST_KEYS,
        RequestSurface::Responses => RESPONSES_REQUEST_KEYS,
    };
    for key in js_keys(body) {
        let extension = (surface == RequestSurface::Responses && key == "client_metadata")
            || (surface == RequestSurface::ChatCompletions
                && extensions.deepseek_thinking
                && key == "thinking")
            || (extensions.openrouter_cache_control && key == "cache_control");
        if !allowed.contains(&key.as_str()) && !extension {
            return Err(invalid(
                format!("Unrecognized request argument supplied: {key}"),
                None,
            ));
        }
    }
    if extensions.openrouter_cache_control && body.get("cache_control").is_some() {
        validate_cache_control(&body["cache_control"])?;
    }
    if surface == RequestSurface::Responses {
        for field in ["max_output_tokens", "max_tool_calls"] {
            if let Some(value) = body.get(field).filter(|v| !v.is_null())
                && positive_integer(Some(value)).is_none()
            {
                return Err(invalid(
                    format!("{field} must be a positive integer"),
                    Some(field),
                ));
            }
        }
        if body
            .get("parallel_tool_calls")
            .is_some_and(|v| !v.is_boolean())
        {
            return Err(invalid(
                "parallel_tool_calls must be a boolean",
                Some("parallel_tool_calls"),
            ));
        }
    }
    validate_prompt_cache_controls(body)?;
    if surface == RequestSurface::Responses
        && let Some(metadata) = body.get("client_metadata")
        && !metadata
            .as_object()
            .is_some_and(|m| m.values().all(Value::is_string))
    {
        return Err(invalid(
            "client_metadata must be an object with string values",
            Some("client_metadata"),
        ));
    }
    Ok(())
}
pub fn parse_stream(value: Option<&Value>) -> Result<bool, GatewayError> {
    match value {
        None | Some(Value::Bool(false)) => Ok(false),
        Some(Value::Bool(true)) => Ok(true),
        _ => Err(invalid("stream must be a boolean", Some("stream"))),
    }
}
pub fn parse_chat_stream_options(value: Option<&Value>) -> Result<bool, GatewayError> {
    let Some(value) = value else { return Ok(false) };
    let Some(record) = value.as_object() else {
        return Err(invalid(
            "stream_options must be an object",
            Some("stream_options"),
        ));
    };
    if record.get("include_usage").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid(
            "stream_options.include_usage must be a boolean",
            Some("stream_options"),
        ));
    }
    Ok(record.get("include_usage").and_then(Value::as_bool) == Some(true))
}
pub fn parse_max_completion_tokens(value: Option<&Value>) -> Result<Option<i64>, GatewayError> {
    match value {
        None => Ok(None),
        Some(value) => positive_integer(Some(value)).map(Some).ok_or_else(|| {
            invalid(
                "max_completion_tokens must be a positive integer",
                Some("max_completion_tokens"),
            )
        }),
    }
}
pub fn resolve_model(value: Option<&Value>, default: Option<&str>) -> Result<String, GatewayError> {
    if value.is_some_and(|v| !v.is_null() && !v.is_string()) {
        return Err(invalid("model must be a string", None));
    }
    normalized_string(value).or_else(|| default.map(str::to_owned)).ok_or_else(|| GatewayError::new(503,"Default model is unavailable: no configured default model or Codex model snapshot.",Some("server_error")))
}
pub fn parse_instructions(value: Option<&Value>) -> Result<Option<String>, GatewayError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(invalid("instructions must be a string", None)),
    }
}
pub fn validate_cache_control(control: &Value) -> Result<(), GatewayError> {
    if !control.is_object() {
        return Err(invalid(
            "cache_control must be an object",
            Some("cache_control"),
        ));
    }
    if let Some(key) = unknown_key(control, &["type", "ttl"]) {
        return Err(invalid(
            format!("Unknown cache control field: {key}"),
            Some(&format!("cache_control.{key}")),
        ));
    }
    if control.get("type").and_then(Value::as_str) != Some("ephemeral") {
        return Err(invalid(
            "cache_control.type must be ephemeral",
            Some("cache_control.type"),
        ));
    }
    if control
        .get("ttl")
        .is_some_and(|v| !matches!(v.as_str(), Some("5m" | "1h")))
    {
        return Err(invalid(
            "cache_control.ttl must be 5m or 1h",
            Some("cache_control.ttl"),
        ));
    }
    Ok(())
}
pub fn ignored_warnings(body: &Value, handled: &[&str]) -> Vec<String> {
    let mut warnings = Vec::new();
    for key in js_keys(body) {
        if handled.contains(&key.as_str()) {
            continue;
        }
        let warning = match key.as_str() {
            "temperature" => "temperature_ignored".into(),
            "max_tokens" | "max_completion_tokens" | "max_output_tokens" => {
                "max_output_tokens_ignored".into()
            }
            _ => format!("{key}_ignored"),
        };
        push_unique(&mut warnings, warning);
    }
    warnings
}
pub fn merge_warnings(existing: Option<&str>, warnings: &[String]) -> Option<String> {
    let mut values = Vec::new();
    for value in existing
        .unwrap_or("")
        .split(',')
        .map(crate::util::js_trim)
        .filter(|v| !v.is_empty())
    {
        push_unique(&mut values, value.to_owned());
    }
    for value in warnings {
        push_unique(&mut values, value.clone());
    }
    (!values.is_empty()).then(|| values.join(", "))
}

pub const RESPONSES_HANDLED_KEYS: &[&str] = &[
    "model",
    "input",
    "stream",
    "reasoning",
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "max_output_tokens",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "text",
    "include",
    "context_management",
    "client_metadata",
];
pub const CHAT_HANDLED_KEYS: &[&str] = &[
    "messages",
    "model",
    "stream",
    "reasoning_effort",
    "max_completion_tokens",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "stream_options",
];
pub fn responses_warnings(body: &Value) -> Vec<String> {
    ignored_warnings(body, RESPONSES_HANDLED_KEYS)
}
pub fn chat_warnings(body: &Value) -> Vec<String> {
    let mut handled = CHAT_HANDLED_KEYS.to_vec();
    if body
        .get("response_format")
        .and_then(Value::as_object)
        .is_some_and(|r| {
            r.len() == 1 && r.get("type").and_then(Value::as_str) == Some("json_object")
        })
    {
        handled.push("response_format");
    }
    ignored_warnings(body, &handled)
}
pub fn temporary_free_surplus_capability(model: &str, body: &Value) -> Result<(), GatewayError> {
    if model == "glm-5.2"
        && body
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|t| !t.is_empty())
    {
        Err(GatewayError::new(
            400,
            format!("The model '{model}' does not support tools through this gateway."),
            Some("unsupported_model_capability"),
        )
        .with_param(Some("tools")))
    } else {
        Ok(())
    }
}
pub fn normalize_tools_for_codex(value: &Value) -> Value {
    let Some(tools) = value.as_array() else {
        return value.clone();
    };
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                if tool.get("type").and_then(Value::as_str) != Some("function") {
                    return tool.clone();
                }
                let Some(function) = tool.get("function").filter(|v| is_record(v)) else {
                    return tool.clone();
                };
                let top = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let nested = function
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                if top.is_none() && nested.is_none() {
                    return tool.clone();
                }
                let mut next = tool.clone();
                if top.is_none() {
                    next["name"] = json!(nested);
                }
                if let Some(fields) = function.as_object() {
                    for key in js_keys(function) {
                        if next.get(&key).is_none() {
                            next[&key] = fields[&key].clone();
                        }
                    }
                }
                if let Some(record) = next.as_object_mut() {
                    record.shift_remove("function");
                }
                next
            })
            .collect(),
    )
}
pub fn normalize_tool_choice_for_codex(value: &Value) -> Value {
    if value.get("type").and_then(Value::as_str) != Some("function") {
        return value.clone();
    }
    let top = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let nested = value
        .get("function")
        .and_then(|f| f.get("name"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if top.is_none() && nested.is_none() {
        return value.clone();
    }
    let mut next = value.clone();
    if top.is_none() {
        next["name"] = json!(nested);
    }
    if let Some(record) = next.as_object_mut() {
        record.shift_remove("function");
    }
    next
}

/// TextDecoder's lossy UTF-8 and initial BOM handling precede JSON.parse in src/request.ts.
/// arbitrary_precision carries exponent overflow until JS numeric checks/stringification handle it.
pub fn parse_json_body(bytes: &[u8]) -> Result<Value, GatewayError> {
    if bytes.is_empty() || bytes.len() > 32 * 1024 * 1024 {
        return Err(invalid("Invalid JSON body", None));
    }
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).map_err(|_| invalid("Invalid JSON body", None))
}
