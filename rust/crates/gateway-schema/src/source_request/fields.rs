//! Envelope and finite controls are separate source phases, never transcript scalarization.
use super::value::{Value, keyed_error, unknown_key};
use super::{SourceRequestError, member};
use crate::{
    allowlists::*,
    request::{RequestExtensions, RequestSurface},
};
use gateway_core::{source_json::SourceJson, source_serialization as source};
fn invalid(message: impl AsRef<str>, param: Option<&str>) -> SourceRequestError {
    SourceRequestError::scalar(message.as_ref(), param)
}
fn positive_integer(value: &SourceJson) -> Option<i64> {
    source::number(value)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
        .map(|n| n as i64)
}
pub fn parse_max_completion_tokens(
    value: Option<&SourceJson>,
) -> Result<Option<i64>, SourceRequestError> {
    value
        .map(|value| {
            positive_integer(value).ok_or_else(|| {
                invalid(
                    "max_completion_tokens must be a positive integer",
                    Some("max_completion_tokens"),
                )
            })
        })
        .transpose()
}
pub fn parse_chat_stream_options(value: Option<&SourceJson>) -> Result<bool, SourceRequestError> {
    let Some(value) = value else { return Ok(false) };
    let value = Value::from_source(value.clone());
    if !value.is_object() {
        return Err(invalid(
            "stream_options must be an object",
            Some("stream_options"),
        ));
    }
    if value
        .get("include_usage")
        .is_some_and(|v| !matches!(v, Value::Bool(_)))
    {
        return Err(invalid(
            "stream_options.include_usage must be a boolean",
            Some("stream_options"),
        ));
    }
    Ok(value.get("include_usage") == Some(&Value::Bool(true)))
}
pub fn validate_cache_control(value: &SourceJson) -> Result<(), SourceRequestError> {
    let value = Value::from_source(value.clone());
    if !value.is_object() {
        return Err(invalid(
            "cache_control must be an object",
            Some("cache_control"),
        ));
    }
    if let Some(key) = unknown_key(&value, &["type", "ttl"]) {
        return Err(keyed_error(
            "Unknown cache control field: ",
            &key,
            Some("cache_control."),
        ));
    }
    if value.get("type").and_then(Value::as_str) != Some("ephemeral") {
        return Err(invalid(
            "cache_control.type must be ephemeral",
            Some("cache_control.type"),
        ));
    }
    if value
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
pub fn validate_prompt_cache_controls(value: &SourceJson) -> Result<(), SourceRequestError> {
    let value = Value::from_source(value.clone());
    if value
        .get("prompt_cache_key")
        .is_some_and(|v| !v.is_string())
    {
        return Err(invalid(
            "prompt_cache_key must be a string",
            Some("prompt_cache_key"),
        ));
    }
    if let Some(options) = value.get("prompt_cache_options") {
        if !options.is_object() {
            return Err(invalid(
                "prompt_cache_options must be an object",
                Some("prompt_cache_options"),
            ));
        }
        if let Some(key) = unknown_key(options, &["mode", "ttl"]) {
            return Err(keyed_error(
                "Unknown prompt cache option: ",
                &key,
                Some("prompt_cache_options."),
            ));
        }
        if options
            .get("mode")
            .is_some_and(|v| !matches!(v.as_str(), Some("implicit" | "explicit")))
        {
            return Err(invalid(
                "prompt_cache_options.mode must be implicit or explicit",
                Some("prompt_cache_options.mode"),
            ));
        }
        if options
            .get("ttl")
            .is_some_and(|v| v.as_str() != Some("30m"))
        {
            return Err(invalid(
                "prompt_cache_options.ttl must be 30m",
                Some("prompt_cache_options.ttl"),
            ));
        }
    }
    if value
        .get("prompt_cache_retention")
        .is_some_and(|v| !matches!(v.as_str(), Some("in_memory" | "24h")))
    {
        return Err(invalid(
            "prompt_cache_retention must be in_memory or 24h",
            Some("prompt_cache_retention"),
        ));
    }
    Ok(())
}
pub fn validate_request_fields(
    value: &SourceJson,
    surface: RequestSurface,
    extensions: &RequestExtensions,
) -> Result<(), SourceRequestError> {
    let view = Value::from_source(value.clone());
    if !view.is_object() {
        return Err(invalid("Invalid JSON body", None));
    }
    let allowed = match surface {
        RequestSurface::Responses => RESPONSES_REQUEST_KEYS,
        RequestSurface::ChatCompletions => CHAT_COMPLETIONS_REQUEST_KEYS,
    };
    let mut keys = allowed.to_vec();
    if surface == RequestSurface::Responses {
        keys.push("client_metadata")
    }
    if surface == RequestSurface::ChatCompletions && extensions.deepseek_thinking {
        keys.push("thinking")
    }
    if extensions.openrouter_cache_control {
        keys.push("cache_control")
    }
    if let Some(key) = unknown_key(&view, &keys) {
        return Err(keyed_error(
            "Unrecognized request argument supplied: ",
            &key,
            None,
        ));
    }
    if extensions.openrouter_cache_control
        && let Some(control) = member(value, "cache_control")?
    {
        validate_cache_control(&control)?
    }
    if surface == RequestSurface::Responses {
        // Source precedence is max-output, parallel-tool-calls, then max-tool-calls.
        validate_positive(value, "max_output_tokens")?;
        if view
            .get("parallel_tool_calls")
            .is_some_and(|v| !matches!(v, Value::Bool(_)))
        {
            return Err(invalid(
                "parallel_tool_calls must be a boolean",
                Some("parallel_tool_calls"),
            ));
        }
        validate_positive(value, "max_tool_calls")?;
    }
    validate_prompt_cache_controls(value)?;
    if surface == RequestSurface::Responses
        && let Some(metadata) = member(value, "client_metadata")?
        && !source::entries(&metadata).is_some_and(|entries| {
            entries
                .into_iter()
                .all(|(_, value)| source::string(&value).is_some())
        })
    {
        return Err(invalid(
            "client_metadata must be an object with string values",
            Some("client_metadata"),
        ));
    }
    Ok(())
}
fn validate_positive(value: &SourceJson, field: &str) -> Result<(), SourceRequestError> {
    if let Some(value) = member(value, field)?
        && value.as_str() != "null"
        && positive_integer(&value).is_none()
    {
        return Err(invalid(
            format!("{field} must be a positive integer"),
            Some(field),
        ));
    }
    Ok(())
}
