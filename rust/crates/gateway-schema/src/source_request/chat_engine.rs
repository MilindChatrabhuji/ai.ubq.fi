//! Chat-side half of the one source content normalization policy.
use super::content_engine::{check_fields, image_detail, role, string_field, with_breakpoint};
use super::{
    SourceRequestError as GatewayError,
    value::{Text, Value, json, normalized_string},
};
fn invalid(message: impl AsRef<str>, param: Option<&str>) -> GatewayError {
    GatewayError::scalar(message.as_ref(), param)
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
                .and_then(Value::as_text)
                .map(|v| v.trim_matches(crate::util::js_whitespace))
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
                    .and_then(Value::as_text)
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
pub(super) struct ChatMessage {
    pub instruction: Option<Text>,
    pub instruction_content: Option<Vec<Value>>,
    pub input: Vec<Value>,
}
pub(super) fn normalize_chat_message(
    value: &Value,
    index: usize,
) -> Result<ChatMessage, GatewayError> {
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
    let source_role = value
        .get("role")
        .and_then(Value::as_text)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            invalid(
                format!("{param}.role must be a string"),
                Some(&format!("{param}.role")),
            )
        })?;
    let raw = source_role.as_str().unwrap_or("");
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
        let output = if let Some(text) = value.get("content").and_then(Value::as_text) {
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
            .filter_map(|v| v.get("text").and_then(Value::as_text))
            .filter(|s| !s.trim_matches(crate::util::js_whitespace).is_empty())
            .cloned()
            .collect::<Vec<_>>();
        let text = super::value::join(&text, "\n");
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
pub(super) struct ChatInput {
    pub input: Vec<Value>,
    pub instructions: Option<Text>,
}
pub(super) fn normalize_chat_messages(value: &Value) -> Result<ChatInput, GatewayError> {
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
            json!({"type":"message","role":"user","content":vec![json!({"type":"input_text","text":""})]}),
        );
    }
    Ok(ChatInput {
        input,
        instructions: if preserve {
            None
        } else {
            Some(
                super::value::join(&instructions, "\n\n")
                    .trim_matches(crate::util::js_whitespace)
                    .to_owned(),
            )
        },
    })
}
