//! Lossless supported Chat/Responses input normalization from src/input-normalization.ts.
use crate::{prompt_cache::normalize_breakpoint, util::*};
use gateway_core::GatewayError;
use serde_json::{Value, json};
fn check_fields(
    value: &Value,
    fields: &[&str],
    param: &str,
    label: &str,
) -> Result<(), GatewayError> {
    if let Some(key) = unknown_key(value, fields) {
        return Err(invalid(
            format!("Unknown {label} field: {key}"),
            Some(&format!("{param}.{key}")),
        ));
    }
    Ok(())
}
fn string_field<'a>(value: &'a Value, key: &str, param: &str) -> Result<&'a str, GatewayError> {
    value.get(key).and_then(Value::as_str).ok_or_else(|| {
        invalid(
            format!("{param}.{key} must be a string"),
            Some(&format!("{param}.{key}")),
        )
    })
}
fn image_detail(value: Option<&Value>, param: &str) -> Result<Option<Value>, GatewayError> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(Value::String(s)) if ["auto", "low", "high", "original"].contains(&s.as_str()) => {
            Ok(Some(Value::String(s.clone())))
        }
        _ => Err(invalid(
            format!("{param} must be one of auto, low, high, or original"),
            Some(param),
        )),
    }
}
fn with_breakpoint(
    mut item: Value,
    raw: Option<&Value>,
    param: &str,
) -> Result<Value, GatewayError> {
    if let Some(bp) = normalize_breakpoint(raw, param)? {
        item["prompt_cache_breakpoint"] = bp;
    }
    Ok(item)
}
pub fn normalize_response_content(
    value: &Value,
    param: &str,
    role: &str,
) -> Result<Value, GatewayError> {
    if !value.is_object() {
        return Err(invalid(format!("{param} must be an object"), Some(param)));
    }
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            invalid(
                format!("{param}.type must be a string"),
                Some(&format!("{param}.type")),
            )
        })?;
    match kind {
        "input_text" | "output_text" => {
            if kind == "output_text" && role != "assistant" {
                return Err(invalid(
                    format!("{param}.type is only valid for assistant messages"),
                    Some(&format!("{param}.type")),
                ));
            }
            let fields: &[&str] = if kind == "output_text" {
                &["type", "text", "annotations", "logprobs"]
            } else {
                &["type", "text", "prompt_cache_breakpoint"]
            };
            check_fields(value, fields, param, "content")?;
            let text = string_field(value, "text", param)?;
            if kind == "output_text" {
                for key in ["annotations", "logprobs"] {
                    if value.get(key).is_some_and(|v| !v.is_array()) {
                        return Err(invalid(
                            format!("{param}.{key} must be an array"),
                            Some(&format!("{param}.{key}")),
                        ));
                    }
                }
                return Ok(json!({"type":kind,"text":text}));
            }
            with_breakpoint(
                json!({"type":kind,"text":text}),
                value.get("prompt_cache_breakpoint"),
                &format!("{param}.prompt_cache_breakpoint"),
            )
        }
        "input_image" => {
            check_fields(
                value,
                &[
                    "type",
                    "image_url",
                    "file_id",
                    "detail",
                    "prompt_cache_breakpoint",
                ],
                param,
                "content",
            )?;
            let url = value
                .get("image_url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_matches(crate::util::js_whitespace);
            let id = value
                .get("file_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim_matches(crate::util::js_whitespace);
            if url.is_empty() == id.is_empty() {
                return Err(invalid(
                    format!("{param} must include exactly one of image_url or file_id"),
                    Some(&format!("{param}.image_url")),
                ));
            }
            for key in ["image_url", "file_id"] {
                if value.get(key).is_some_and(|v| !v.is_string()) {
                    return Err(invalid(
                        format!("{param}.{key} must be a string"),
                        Some(&format!("{param}.{key}")),
                    ));
                }
            }
            let mut item = if !url.is_empty() {
                json!({"type":kind,"image_url":url})
            } else {
                json!({"type":kind,"file_id":id})
            };
            if let Some(detail) = image_detail(value.get("detail"), &format!("{param}.detail"))? {
                item["detail"] = detail;
            }
            with_breakpoint(
                item,
                value.get("prompt_cache_breakpoint"),
                &format!("{param}.prompt_cache_breakpoint"),
            )
        }
        "input_file" => {
            check_fields(
                value,
                &[
                    "type",
                    "file_id",
                    "file_data",
                    "file_url",
                    "filename",
                    "detail",
                    "prompt_cache_breakpoint",
                ],
                param,
                "content",
            )?;
            let fields = ["file_id", "file_data", "file_url"];
            if !fields.iter().any(|k| {
                value
                    .get(k)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim_matches(crate::util::js_whitespace).is_empty())
            }) {
                return Err(invalid(
                    format!("{param} must include file_id, file_data, or file_url"),
                    Some(&format!("{param}.file_id")),
                ));
            }
            for key in fields {
                if value.get(key).is_some_and(|v| !v.is_string()) {
                    return Err(invalid(
                        format!("{param}.{key} must be a string"),
                        Some(&format!("{param}.{key}")),
                    ));
                }
            }
            if value
                .get("filename")
                .is_some_and(|v| !v.is_null() && !v.is_string())
            {
                return Err(invalid(
                    format!("{param}.filename must be a string or null"),
                    Some(&format!("{param}.filename")),
                ));
            }
            if value
                .get("detail")
                .is_some_and(|v| !matches!(v.as_str(), Some("auto" | "low" | "high")))
            {
                return Err(invalid(
                    format!("{param}.detail must be one of auto, low, or high"),
                    Some(&format!("{param}.detail")),
                ));
            }
            let mut item = json!({"type":kind});
            for key in fields {
                if value
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                {
                    item[key] = value[key].clone();
                }
            }
            for key in ["filename", "detail"] {
                if let Some(v) = value.get(key) {
                    item[key] = v.clone();
                }
            }
            with_breakpoint(
                item,
                value.get("prompt_cache_breakpoint"),
                &format!("{param}.prompt_cache_breakpoint"),
            )
        }
        _ => Err(invalid(
            format!("{param}.type is not supported"),
            Some(&format!("{param}.type")),
        )),
    }
}
fn role(raw: &str) -> Option<&'static str> {
    match raw {
        "system" | "developer" | "tool" => Some("developer"),
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        _ => None,
    }
}
pub fn normalize_response_message(value: &Value, param: &str) -> Result<Value, GatewayError> {
    if !value.is_object() {
        return Err(invalid(format!("{param} must be an object"), Some(param)));
    }
    if value.get("prompt_cache_breakpoint").is_some() {
        return Err(invalid(
            "prompt_cache_breakpoint is only valid on supported input content blocks",
            Some(&format!("{param}.prompt_cache_breakpoint")),
        ));
    }
    if value
        .get("type")
        .is_some_and(|v| v.as_str() != Some("message"))
    {
        return Err(invalid(
            format!("{param}.type must be message"),
            Some(&format!("{param}.type")),
        ));
    }
    let raw = value.get("role").and_then(Value::as_str).unwrap_or("");
    let mapped = if raw == "tool" { None } else { role(raw) }.ok_or_else(|| {
        invalid(
            format!("{param}.role is invalid"),
            Some(&format!("{param}.role")),
        )
    })?;
    let content = if let Some(text) = value.get("content").and_then(Value::as_str) {
        vec![json!({"type":if mapped=="assistant"{"output_text"}else{"input_text"},"text":text})]
    } else if let Some(parts) = value.get("content").and_then(Value::as_array) {
        parts
            .iter()
            .enumerate()
            .map(|(i, p)| normalize_response_content(p, &format!("{param}.content[{i}]"), mapped))
            .collect::<Result<_, _>>()?
    } else {
        return Err(invalid(
            format!("{param}.content must be a string or an array"),
            Some(&format!("{param}.content")),
        ));
    };
    Ok(json!({"type":"message","role":mapped,"content":content}))
}
pub fn is_gateway_failover_warning(value: &Value) -> bool {
    const PREFIX: &str = "⚠ Failover active: this response is from `removed_provider:";
    const SUFFIX: &str = "` because the Codex upstream was unavailable.";
    if value.get("type").and_then(Value::as_str) != Some("message")
        || value.get("role").and_then(Value::as_str) != Some("assistant")
        || !value
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|s| s.starts_with("msg_failover_"))
    {
        return false;
    }
    let Some(parts) = value
        .get("content")
        .and_then(Value::as_array)
        .filter(|a| a.len() == 1)
    else {
        return false;
    };
    parts[0].get("type").and_then(Value::as_str) == Some("output_text")
        && parts[0]
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|s| {
                s.starts_with(PREFIX)
                    && s.ends_with(SUFFIX)
                    && s.len() > PREFIX.len() + SUFFIX.len()
            })
}
pub fn normalize_function_output(value: &Value, param: &str) -> Result<Value, GatewayError> {
    if value.get("type").and_then(Value::as_str) != Some("function_call_output") {
        return Ok(value.clone());
    }
    let Some(output) = value.get("output").and_then(Value::as_array) else {
        return Ok(value.clone());
    };
    let normalized = output
        .iter()
        .enumerate()
        .map(|(i, v)| normalize_response_content(v, &format!("{param}.output[{i}]"), "user"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut next = value.clone();
    next["output"] = Value::Array(normalized);
    Ok(next)
}
pub fn normalize_responses_input(input: Option<&Value>) -> Result<Vec<Value>, GatewayError> {
    let Some(input) = input else {
        return Ok(Vec::new());
    };
    if let Some(text) = input.as_str() {
        return Ok(vec![
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":text}]}),
        ]);
    }
    let Some(items) = input.as_array() else {
        return Err(invalid("input must be a string or an array", None));
    };
    let mut output = Vec::new();
    let mut buffer = Vec::new();
    let mut saw_item = false;
    fn flush(buffer: &mut Vec<Value>, output: &mut Vec<Value>) {
        if !buffer.is_empty() {
            output.push(json!({"type":"message","role":"user","content":std::mem::take(buffer)}));
        }
    }
    for (index, item) in items.iter().enumerate() {
        let param = format!("input[{index}]");
        let kind = item.get("type").and_then(Value::as_str);
        if kind == Some("message")
            || (kind.is_none() && item.is_object() && item.get("role").is_some())
        {
            if is_gateway_failover_warning(item) {
                continue;
            }
            let message = normalize_response_message(item, &param)?;
            flush(&mut buffer, &mut output);
            output.push(message);
            saw_item = true;
            continue;
        }
        let content = if let Some(text) = item.as_str() {
            Some(json!({"type":"input_text","text":text}))
        } else if matches!(kind, Some("input_text" | "input_image" | "input_file")) {
            Some(normalize_response_content(item, &param, "user")?)
        } else {
            None
        };
        if let Some(content) = content {
            if saw_item {
                output.push(json!({"type":"message","role":"user","content":[content]}));
            } else {
                buffer.push(content);
            }
            continue;
        }
        if item.get("prompt_cache_breakpoint").is_some() {
            return Err(invalid(
                "prompt_cache_breakpoint is only valid on supported input content blocks",
                Some(&format!("{param}.prompt_cache_breakpoint")),
            ));
        }
        if let Some(kind) = kind {
            if kind.starts_with("input_") || ["text", "image_url", "output_text"].contains(&kind) {
                return Err(invalid(
                    format!("{param}.type is not supported"),
                    Some(&format!("{param}.type")),
                ));
            }
            flush(&mut buffer, &mut output);
            output.push(normalize_function_output(item, &param)?);
            saw_item = true;
        } else {
            return Err(invalid("Invalid message in input[]", Some(&param)));
        }
    }
    flush(&mut buffer, &mut output);
    Ok(output)
}
fn normalize_chat_part(
    part: &Value,
    param: &str,
    mapped: &str,
    count: usize,
) -> Result<Value, GatewayError> {
    if !part.is_object() {
        return Err(invalid(format!("{param} must be an object"), Some(param)));
    }
    let kind = part.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "text" => {
            check_fields(
                part,
                &["type", "text", "prompt_cache_breakpoint"],
                param,
                "content",
            )?;
            let text = string_field(part, "text", param)?;
            if mapped == "assistant" && part.get("prompt_cache_breakpoint").is_some() {
                return Err(invalid(
                    "prompt_cache_breakpoint is not supported for assistant output content in this gateway",
                    Some(&format!("{param}.prompt_cache_breakpoint")),
                ));
            }
            let normalized =
                json!({"type":if mapped=="assistant"{"output_text"}else{"input_text"},"text":text});
            with_breakpoint(
                normalized,
                part.get("prompt_cache_breakpoint"),
                &format!("{param}.prompt_cache_breakpoint"),
            )
        }
        "refusal" => {
            check_fields(
                part,
                &["type", "refusal", "prompt_cache_breakpoint"],
                param,
                "content",
            )?;
            if mapped != "assistant" {
                return Err(invalid(
                    format!("{param}.type is only valid for assistant messages"),
                    Some(&format!("{param}.type")),
                ));
            }
            if count != 1 {
                return Err(invalid(
                    "assistant refusal content must be the only part",
                    Some(&format!("{param}.type")),
                ));
            }
            let refusal = string_field(part, "refusal", param)?;
            if part.get("prompt_cache_breakpoint").is_some() {
                return Err(invalid(
                    "prompt_cache_breakpoint is not supported for refusal content in this gateway",
                    Some(&format!("{param}.prompt_cache_breakpoint")),
                ));
            }
            Ok(json!({"type":"output_text","text":refusal}))
        }
        "image_url" => {
            check_fields(
                part,
                &["type", "image_url", "prompt_cache_breakpoint"],
                param,
                "content",
            )?;
            if mapped != "user" {
                return Err(invalid(
                    format!("{param}.type is only valid for user messages"),
                    Some(&format!("{param}.type")),
                ));
            }
            let image = part
                .get("image_url")
                .filter(|v| v.is_object())
                .ok_or_else(|| {
                    invalid(
                        format!("{param}.image_url must be an object"),
                        Some(&format!("{param}.image_url")),
                    )
                })?;
            check_fields(
                image,
                &["url", "detail"],
                &format!("{param}.image_url"),
                "image_url",
            )?;
            let url = image
                .get("url")
                .and_then(Value::as_str)
                .map(crate::util::js_trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    invalid(
                        format!("{param}.image_url.url must contain a URL"),
                        Some(&format!("{param}.image_url.url")),
                    )
                })?;
            let mut item = json!({"type":"input_image","image_url":url});
            if let Some(detail) =
                image_detail(image.get("detail"), &format!("{param}.image_url.detail"))?
            {
                item["detail"] = detail;
            }
            with_breakpoint(
                item,
                part.get("prompt_cache_breakpoint"),
                &format!("{param}.prompt_cache_breakpoint"),
            )
        }
        "file" => {
            check_fields(
                part,
                &["type", "file", "prompt_cache_breakpoint"],
                param,
                "content",
            )?;
            if mapped != "user" {
                return Err(invalid(
                    format!("{param}.type is only valid for user messages"),
                    Some(&format!("{param}.type")),
                ));
            }
            let file = part.get("file").filter(|v| v.is_object()).ok_or_else(|| {
                invalid(
                    format!("{param}.file must be an object"),
                    Some(&format!("{param}.file")),
                )
            })?;
            check_fields(
                file,
                &["file_id", "file_data", "filename"],
                &format!("{param}.file"),
                "file",
            )?;
            for key in ["file_id", "file_data", "filename"] {
                if file.get(key).is_some_and(|v| !v.is_string()) {
                    return Err(invalid(
                        format!("{param}.file.{key} must be a string"),
                        Some(&format!("{param}.file.{key}")),
                    ));
                }
            }
            if !["file_id", "file_data"].iter().any(|k| {
                file.get(k)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim_matches(crate::util::js_whitespace).is_empty())
            }) {
                return Err(invalid(
                    format!("{param}.file must include file_id or file_data"),
                    Some(&format!("{param}.file.file_id")),
                ));
            }
            let mut item = json!({"type":"input_file"});
            for key in ["file_id", "file_data", "filename"] {
                if let Some(v) = file.get(key) {
                    item[key] = v.clone();
                }
            }
            with_breakpoint(
                item,
                part.get("prompt_cache_breakpoint"),
                &format!("{param}.prompt_cache_breakpoint"),
            )
        }
        "input_audio" if part.get("prompt_cache_breakpoint").is_some() => Err(invalid(
            "prompt_cache_breakpoint is not supported for input_audio content in this gateway",
            Some(&format!("{param}.prompt_cache_breakpoint")),
        )),
        _ => Err(invalid(
            format!("{param}.type is not supported"),
            Some(&format!("{param}.type")),
        )),
    }
}
fn chat_content(
    value: Option<&Value>,
    mapped: &str,
    param: &str,
) -> Result<Vec<Value>, GatewayError> {
    if let Some(Value::String(text)) = value {
        return Ok(vec![
            json!({"type":if mapped=="assistant"{"output_text"}else{"input_text"},"text":text}),
        ]);
    }
    if matches!(value, Some(Value::Null)) && mapped == "assistant" {
        return Ok(Vec::new());
    }
    let Some(parts) = value.and_then(Value::as_array) else {
        return Err(invalid(
            format!("{param} must be a string or an array"),
            Some(param),
        ));
    };
    parts
        .iter()
        .enumerate()
        .map(|(i, v)| normalize_chat_part(v, &format!("{param}[{i}]"), mapped, parts.len()))
        .collect()
}
fn chat_tool_call(value: &Value, param: &str) -> Result<Value, GatewayError> {
    if !value.is_object() {
        return Err(invalid(format!("{param} must be an object"), Some(param)));
    }
    check_fields(value, &["id", "type", "function"], param, "tool call")?;
    if value.get("type").and_then(Value::as_str) != Some("function") {
        return Err(invalid(
            format!("{param}.type must be function"),
            Some(&format!("{param}.type")),
        ));
    }
    let id = normalized_string(value.get("id")).ok_or_else(|| {
        invalid(
            format!("{param}.id must be a non-empty string"),
            Some(&format!("{param}.id")),
        )
    })?;
    let function = value
        .get("function")
        .filter(|v| v.is_object())
        .ok_or_else(|| {
            invalid(
                format!("{param}.function must be an object"),
                Some(&format!("{param}.function")),
            )
        })?;
    check_fields(
        function,
        &["name", "arguments"],
        &format!("{param}.function"),
        "tool call function",
    )?;
    let name = normalized_string(function.get("name")).ok_or_else(|| {
        invalid(
            format!("{param}.function.name must be a non-empty string"),
            Some(&format!("{param}.function.name")),
        )
    })?;
    let arguments = string_field(function, "arguments", &format!("{param}.function"))?;
    Ok(json!({"type":"function_call","call_id":id,"name":name,"arguments":arguments}))
}
#[derive(Clone, Debug, PartialEq)]
pub struct ChatMessage {
    pub instruction: Option<String>,
    pub instruction_content: Option<Vec<Value>>,
    pub input: Vec<Value>,
}
pub fn normalize_chat_message(value: &Value, index: usize) -> Result<ChatMessage, GatewayError> {
    let param = format!("messages[{index}]");
    if !value.is_object() {
        return Err(invalid(format!("{param} must be an object"), Some(&param)));
    }
    if value.get("prompt_cache_breakpoint").is_some() {
        return Err(invalid(
            "prompt_cache_breakpoint is only valid on supported input content blocks",
            Some(&format!("{param}.prompt_cache_breakpoint")),
        ));
    }
    let raw = value
        .get("role")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            invalid(
                format!("{param}.role must be a string"),
                Some(&format!("{param}.role")),
            )
        })?;
    let mapped = role(raw).ok_or_else(|| {
        invalid(
            format!("{param}.role is not supported"),
            Some(&format!("{param}.role")),
        )
    })?;
    if raw == "tool" {
        if value.get("tool_calls").is_some() {
            return Err(invalid(
                "tool_calls are only valid for assistant messages",
                Some(&format!("{param}.tool_calls")),
            ));
        }
        let id = normalized_string(value.get("tool_call_id")).ok_or_else(|| {
            invalid(
                format!("{param}.tool_call_id must be a non-empty string"),
                Some(&format!("{param}.tool_call_id")),
            )
        })?;
        let output = if let Some(text) = value.get("content").and_then(Value::as_str) {
            Value::String(text.to_owned())
        } else if let Some(parts) = value.get("content").and_then(Value::as_array) {
            let mut output = Vec::new();
            for (i, part) in parts.iter().enumerate() {
                let p = format!("{param}.content[{i}]");
                if !part.is_object() {
                    return Err(invalid(format!("{p} must be an object"), Some(&p)));
                }
                if part.get("type").and_then(Value::as_str) != Some("text") {
                    return Err(invalid(
                        format!("{p}.type must be a text content part"),
                        Some(&format!("{p}.type")),
                    ));
                }
                check_fields(
                    part,
                    &["type", "text", "prompt_cache_breakpoint"],
                    &p,
                    "content",
                )?;
                let text = string_field(part, "text", &p)?;
                output.push(with_breakpoint(
                    json!({"type":"input_text","text":text}),
                    part.get("prompt_cache_breakpoint"),
                    &format!("{p}.prompt_cache_breakpoint"),
                )?);
            }
            Value::Array(output)
        } else {
            return Err(invalid(
                format!("{param}.content must be a string or an array"),
                Some(&format!("{param}.content")),
            ));
        };
        return Ok(ChatMessage {
            instruction: None,
            instruction_content: None,
            input: vec![json!({"type":"function_call_output","call_id":id,"output":output})],
        });
    }
    if value.get("tool_call_id").is_some() {
        return Err(invalid(
            "tool_call_id is only valid for tool messages",
            Some(&format!("{param}.tool_call_id")),
        ));
    }
    if raw == "assistant" {
        let has_tools = value.get("tool_calls").is_some();
        let refusal = match value.get("refusal") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s),
            _ => {
                return Err(invalid(
                    format!("{param}.refusal must be a string or null"),
                    Some(&format!("{param}.refusal")),
                ));
            }
        };
        let mut content = if value.get("content").is_none() && has_tools {
            Vec::new()
        } else {
            chat_content(value.get("content"), mapped, &format!("{param}.content"))?
        };
        if let Some(refusal) = refusal {
            content.push(json!({"type":"output_text","text":refusal}));
        }
        let mut input = Vec::new();
        if !content.is_empty() {
            input.push(json!({"type":"message","role":mapped,"content":content}));
        }
        if has_tools {
            let calls = value["tool_calls"].as_array().ok_or_else(|| {
                invalid(
                    format!("{param}.tool_calls must be an array"),
                    Some(&format!("{param}.tool_calls")),
                )
            })?;
            for (i, call) in calls.iter().enumerate() {
                input.push(chat_tool_call(call, &format!("{param}.tool_calls[{i}]"))?);
            }
        }
        if input.is_empty() {
            return Err(invalid(
                "assistant messages require content, refusal, or tool_calls",
                Some(&format!("{param}.content")),
            ));
        }
        return Ok(ChatMessage {
            instruction: None,
            instruction_content: None,
            input,
        });
    }
    let content = chat_content(value.get("content"), mapped, &format!("{param}.content"))?;
    if value.get("tool_calls").is_some() {
        return Err(invalid(
            "tool_calls are only valid for assistant messages",
            Some(&format!("{param}.tool_calls")),
        ));
    }
    if raw == "system" || raw == "developer" {
        let text = content
            .iter()
            .filter_map(|v| v.get("text").and_then(Value::as_str))
            .filter(|s| !s.trim_matches(crate::util::js_whitespace).is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(ChatMessage {
            instruction: Some(text),
            instruction_content: Some(content),
            input: Vec::new(),
        });
    }
    Ok(ChatMessage {
        instruction: None,
        instruction_content: None,
        input: vec![json!({"type":"message","role":mapped,"content":content})],
    })
}
#[derive(Clone, Debug, PartialEq)]
pub struct ChatInput {
    pub input: Vec<Value>,
    pub instructions: Option<String>,
}
pub fn normalize_chat_messages(value: &Value) -> Result<ChatInput, GatewayError> {
    let messages = value
        .as_array()
        .ok_or_else(|| invalid("messages must be an array", None))?;
    if messages.is_empty() {
        return Err(invalid("messages must be a non-empty array", None));
    }
    let normalized = messages
        .iter()
        .enumerate()
        .map(|(i, v)| normalize_chat_message(v, i))
        .collect::<Result<Vec<_>, _>>()?;
    let preserve = normalized.iter().any(|m| {
        m.instruction_content.as_ref().is_some_and(|c| {
            c.iter().any(|v| {
                v.pointer("/prompt_cache_breakpoint/mode")
                    .and_then(Value::as_str)
                    == Some("explicit")
            })
        })
    });
    let mut input = Vec::new();
    let mut instructions = Vec::new();
    for message in normalized {
        if preserve {
            if let Some(content) = message.instruction_content {
                input.push(json!({"type":"message","role":"developer","content":content}));
            }
        } else if let Some(text) = message
            .instruction
            .filter(|s| !s.trim_matches(crate::util::js_whitespace).is_empty())
        {
            instructions.push(text.trim_matches(crate::util::js_whitespace).to_owned());
        }
        input.extend(message.input);
    }
    if input.is_empty() {
        input.push(
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":""}]}),
        );
    }
    Ok(ChatInput {
        input,
        instructions: if preserve {
            None
        } else {
            Some(
                instructions
                    .join("\n\n")
                    .trim_matches(crate::util::js_whitespace)
                    .to_owned(),
            )
        },
    })
}
