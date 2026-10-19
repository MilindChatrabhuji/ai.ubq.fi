//! Source request syntax. Provider-specific interpretation remains outside official allowlists.
use crate::util::*;
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
    crate::source_request::validate_request_fields(
        &gateway_core::source_json::SourceJson::from_serializable(body)?,
        surface,
        extensions,
    )
    .map_err(crate::source_request::SourceRequestError::into_scalar)
}

pub fn parse_stream(value: Option<&Value>) -> Result<bool, GatewayError> {
    let value = crate::source_request::scalar_value(value)?;
    crate::source_request::parse_stream(value.as_ref())
        .map_err(crate::source_request::SourceRequestError::into_scalar)
}

pub fn parse_chat_stream_options(value: Option<&Value>) -> Result<bool, GatewayError> {
    let value = crate::source_request::scalar_value(value)?;
    crate::source_request::parse_chat_stream_options(value.as_ref())
        .map_err(crate::source_request::SourceRequestError::into_scalar)
}
pub fn parse_max_completion_tokens(value: Option<&Value>) -> Result<Option<i64>, GatewayError> {
    let value = crate::source_request::scalar_value(value)?;
    crate::source_request::parse_max_completion_tokens(value.as_ref())
        .map_err(crate::source_request::SourceRequestError::into_scalar)
}

pub fn resolve_model(value: Option<&Value>, default: Option<&str>) -> Result<String, GatewayError> {
    let value = crate::source_request::scalar_value(value)?;
    crate::source_request::resolve_model(value.as_ref(), default)
        .map_err(crate::source_request::SourceRequestError::into_scalar)?
        .try_utf8()
}
pub fn parse_instructions(value: Option<&Value>) -> Result<Option<String>, GatewayError> {
    let value = crate::source_request::scalar_value(value)?;
    match crate::source_request::parse_instructions(value.as_ref())
        .map_err(crate::source_request::SourceRequestError::into_scalar)?
    {
        crate::source_request::SourceField::Missing | crate::source_request::SourceField::Null => {
            Ok(None)
        }
        crate::source_request::SourceField::Value(value) => value.try_utf8().map(Some),
    }
}

pub fn validate_cache_control(control: &Value) -> Result<(), GatewayError> {
    crate::source_request::validate_cache_control(
        &gateway_core::source_json::SourceJson::from_serializable(control)?,
    )
    .map_err(crate::source_request::SourceRequestError::into_scalar)
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
    crate::source_request::parse_http_body(bytes)
        .map_err(crate::source_request::SourceRequestError::into_scalar)?
        .deserialize()
        .map_err(|_| invalid("Invalid JSON body", None))
}
