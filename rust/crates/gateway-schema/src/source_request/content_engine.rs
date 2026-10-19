//! Lossless supported Chat/Responses input normalization from src/input-normalization.ts.
use super::controls::normalize_breakpoint;
use super::{
    SourceRequestError as GatewayError,
    value::{Text, Value, json, normalized_string},
};
use gateway_core::{js_string::JsString16, source_serialization as source};
fn invalid(message: impl AsRef<str>, param: Option<&str>) -> GatewayError {
    GatewayError::scalar(message.as_ref(), param)
}
pub(super) fn check_fields(
    value: &Value,
    fields: &[&str],
    param: &str,
    label: &str,
) -> Result<(), GatewayError> {
    let raw = value.source().expect("Validated policy view");
    if let Some((key, _)) = source::entries(&raw).and_then(|entries| {
        entries.into_iter().find(|(key, _)| {
            !fields
                .iter()
                .any(|field| key.as_units().iter().copied().eq(field.encode_utf16()))
        })
    }) {
        let mut message = format!("Unknown {label} field: ")
            .encode_utf16()
            .collect::<Vec<_>>();
        message.extend_from_slice(key.as_units());
        let mut path = format!("{param}.").encode_utf16().collect::<Vec<_>>();
        path.extend_from_slice(key.as_units());
        return Err(GatewayError::invalid(
            JsString16::from_units(message),
            Some(JsString16::from_units(path)),
        ));
    }
    Ok(())
}
pub(super) fn string_field<'a>(
    value: &'a Value,
    key: &str,
    param: &str,
) -> Result<&'a Text, GatewayError> {
    value.get(key).and_then(Value::as_text).ok_or_else(|| {
        invalid(
            format!("{param}.{key} must be a string"),
            Some(&format!("{param}.{key}")),
        )
    })
}
pub(super) fn image_detail(
    value: Option<&Value>,
    param: &str,
) -> Result<Option<Value>, GatewayError> {
    match value {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(Value::String(s))
            if s.as_str()
                .is_some_and(|s| ["auto", "low", "high", "original"].contains(&s)) =>
        {
            Ok(Some(Value::String(s.clone())))
        }
        _ => Err(invalid(
            format!("{param} must be one of auto, low, high, or original"),
            Some(param),
        )),
    }
}
pub(super) fn with_breakpoint(
    mut item: Value,
    raw: Option<&Value>,
    param: &str,
) -> Result<Value, GatewayError> {
    if let Some(bp) = normalize_breakpoint(raw, param)? {
        item["prompt_cache_breakpoint"] = bp;
    }
    Ok(item)
}
pub(super) fn normalize_response_content(
    value: &Value,
    param: &str,
    role: &str,
) -> Result<Value, GatewayError> {
    if !value.is_object() {
        return Err(invalid(format!("{param} must be an object"), Some(param)));
    }
    let source_kind = value
        .get("type")
        .and_then(Value::as_text)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            invalid(
                format!("{param}.type must be a string"),
                Some(&format!("{param}.type")),
            )
        })?;
    let kind = source_kind.as_str().unwrap_or("");
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
            let url = normalized_string(value.get("image_url")).unwrap_or_default();
            let id = normalized_string(value.get("file_id")).unwrap_or_default();
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
                    .and_then(Value::as_text)
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
                    .and_then(Value::as_text)
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
pub(super) fn role(raw: &str) -> Option<&'static str> {
    match raw {
        "system" | "developer" | "tool" => Some("developer"),
        "user" => Some("user"),
        "assistant" => Some("assistant"),
        _ => None,
    }
}
pub(super) fn normalize_response_message(
    value: &Value,
    param: &str,
) -> Result<Value, GatewayError> {
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
    let content = if let Some(text) = value.get("content").and_then(Value::as_text) {
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
pub(super) fn is_gateway_failover_warning(value: &Value) -> bool {
    const PREFIX: &str = "⚠ Failover active: this response is from `removed_provider:";
    const SUFFIX: &str = "` because the Codex upstream was unavailable.";
    if value.get("type").and_then(Value::as_str) != Some("message")
        || value.get("role").and_then(Value::as_str) != Some("assistant")
        || !value
            .get("id")
            .and_then(Value::as_text)
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
            .and_then(Value::as_text)
            .is_some_and(|s| {
                s.starts_with(PREFIX)
                    && s.ends_with(SUFFIX)
                    && s.len() > PREFIX.encode_utf16().count() + SUFFIX.encode_utf16().count()
            })
}
pub(super) fn normalize_function_output(value: &Value, param: &str) -> Result<Value, GatewayError> {
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
pub(super) fn normalize_responses_input(input: Option<&Value>) -> Result<Vec<Value>, GatewayError> {
    let Some(input) = input else {
        return Ok(Vec::new());
    };
    if let Some(text) = input.as_text() {
        return Ok(vec![
            json!({"type":"message","role":"user","content":vec![json!({"type":"input_text","text":text})]}),
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
        let source_kind = item.get("type").and_then(Value::as_text);
        let kind = source_kind.and_then(Text::as_str);
        if kind == Some("message")
            || (source_kind.is_none() && item.is_object() && item.get("role").is_some())
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
        let content = if let Some(text) = item.as_text() {
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
        if let Some(source_kind) = source_kind {
            if source_kind.starts_with("input_")
                || kind.is_some_and(|kind| ["text", "image_url", "output_text"].contains(&kind))
            {
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
