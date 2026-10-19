//! Responses -> Chat-only request translation, preserving provider-specific boundaries.
use crate::types::{ChatProfile, Elision, ToolMap, invalid};
use gateway_core::{GatewayError, js_string::JsString16};
use serde_json::Value;
pub const FORWARD_LIMIT: usize = 65_536;
pub const FORWARD_VERSION: &str = "deepseek-forwarded-payload/v1";
pub(crate) const CONTINUATION: &str = "When tools are available, a progress update does not complete a requested action. If required work remains and you can perform it, continue with the next appropriate tool call instead of ending with a status message. Provide a final answer when the requested work is complete, or when you need user input or are blocked. Never claim a tool action has been done unless its result is in the conversation.";
#[derive(Clone, Debug)]
pub struct ChatProjection {
    pub body: gateway_core::source_json::SourceJson,
    pub tool_names: ToolMap,
    pub elisions: Vec<Elision>,
    pub warnings: Vec<String>,
}
/// Source utf16Head: preserve the exact code-unit prefix, dropping a cut high surrogate.
fn utf16_head(value: &[u16], length: usize) -> &[u16] {
    let mut end = length.min(value.len());
    if end < value.len() && end > 0 && (0xd800..=0xdbff).contains(&value[end - 1]) {
        end -= 1;
    }
    &value[..end]
}

/// TextEncoder counts unpaired units as U+FFFD without replacing the stored source string.
fn text_encoder_len(value: &[u16]) -> usize {
    char::decode_utf16(value.iter().copied())
        .map(|value| value.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
        .sum()
}

pub(crate) fn oversized(
    path: &str,
    original_bytes: usize,
    call_id: Option<&JsString16>,
) -> gateway_schema::source_request::SourceRequestError {
    let call_note = call_id
        .map(|id| {
            crate::source::concat(&[
                &JsString16::from_utf8(" (tool call "),
                id,
                &JsString16::from_utf8(")"),
            ])
        })
        .unwrap_or_default();
    let message = crate::source::concat(&[
        &JsString16::from_utf8(&format!("input item {path}")),
        &call_note,
        &JsString16::from_utf8(&format!(
            " carries {original_bytes} bytes; this route forwards at most {FORWARD_LIMIT} bytes per message under {FORWARD_VERSION}, and the request set truncation 'disabled', so the gateway will not reduce it. Reduce the payload or send truncation 'auto' to allow the declared reduction."
        )),
    ]);
    gateway_schema::source_request::SourceRequestError::new(
        400,
        message,
        "invalid_request_error",
        Some("context_length_exceeded"),
        Some(Some(JsString16::from_utf8(path))),
    )
}
pub(crate) fn bound_source(
    text: &JsString16,
    path: &str,
    call_id: Option<&JsString16>,
    kind: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
) -> crate::source::Result<JsString16> {
    bound_source_limit(text, path, call_id, kind, reject, elisions, FORWARD_LIMIT)
}
pub(crate) fn bound_source_limit(
    text: &JsString16,
    path: &str,
    call_id: Option<&JsString16>,
    kind: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
    limit: usize,
) -> crate::source::Result<JsString16> {
    let original_bytes = text_encoder_len(text.as_units());
    if original_bytes <= limit {
        return Ok(text.clone());
    }
    if reject {
        return Err(oversized(path, original_bytes, call_id));
    }
    // Source utf8Head starts with a code-unit budget, not a UTF8 byte offset.
    let mut head = utf16_head(text.as_units(), limit);
    while !head.is_empty() && text_encoder_len(head) > limit {
        head = utf16_head(head, (head.len() as f64 * 0.9).floor() as usize);
    }
    loop {
        let head_bytes = text_encoder_len(head);
        let omitted = original_bytes - head_bytes;
        let marker = format!(
            "\n[gateway: {FORWARD_VERSION} elided {omitted} bytes omitted; the model did not receive the elided bytes; this route forwards at most {FORWARD_LIMIT} bytes per message because the provider counts forwarded payloads as text tokens]"
        );
        if head.is_empty() || head_bytes + marker.len() <= limit {
            let mut units = head.to_vec();
            units.extend(marker.encode_utf16());
            elisions.push(Elision {
                path: path.into(),
                call_id: call_id.cloned(),
                kind: kind.into(),
                original_bytes,
                forwarded_bytes: head_bytes + marker.len(),
                omitted_bytes: omitted,
            });
            return Ok(JsString16::from_units(units));
        }
        head = utf16_head(head, (head.len() as f64 * 0.9).floor() as usize);
    }
}

pub fn responses_messages(
    raw: &Value,
) -> Result<(Vec<gateway_core::source_json::SourceJson>, Vec<Elision>), GatewayError> {
    crate::source_chat::messages(&crate::source::generated(raw))
        .map_err(crate::source::scalar_error)
}
pub fn project_responses(
    raw: &Value,
    model: &str,
    stream: bool,
    profile: ChatProfile,
) -> Result<ChatProjection, GatewayError> {
    let projection = crate::source_chat::project(
        &crate::source::generated(raw),
        &gateway_core::model::ModelId::from_scalar(model),
        stream,
        profile,
    )
    .map_err(crate::source::scalar_error)?;
    Ok(ChatProjection {
        body: projection.body,
        tool_names: projection.names,
        elisions: projection.elisions,
        warnings: projection.warnings,
    })
}
pub fn project_effort(value: &str, profile: ChatProfile) -> Result<String, GatewayError> {
    let effort = value.trim().to_lowercase();
    if profile == ChatProfile::Deepseek {
        return Ok(if effort == "ultra" {
            "max".into()
        } else {
            value.into()
        });
    }
    let allowed = match profile {
        ChatProfile::Lithos => {
            ["none", "minimal", "low", "medium", "high", "xhigh", "max"].as_slice()
        }
        ChatProfile::Cerebras => ["none", "low", "medium", "high"].as_slice(),
        _ => return Ok(value.trim().into()),
    };
    if !allowed.contains(&effort.as_str()) {
        return Err(invalid(
            format!("reasoning.effort '{value}' is not supported by {profile:?}"),
            "reasoning.effort",
        ));
    }
    Ok(effort)
}
pub fn thinking_active(effort: Option<&str>, thinking: &Value) -> bool {
    if let Some(effort) = effort.map(str::trim).filter(|effort| !effort.is_empty()) {
        return !effort.eq_ignore_ascii_case("none");
    }
    thinking
        .get("type")
        .and_then(Value::as_str)
        .is_none_or(|kind| !kind.trim().eq_ignore_ascii_case("disabled"))
}
pub fn validate_thinking_choice(body: &Value, field: &str) -> Result<(), GatewayError> {
    let effort = body["reasoning_effort"].as_str();
    let thinking = thinking_active(effort, &body["thinking"]);
    if thinking && (body["tool_choice"] == "required" || body["tool_choice"].is_object()) {
        let choice = body["tool_choice"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "function:{}",
                    body["tool_choice"]["function"]["name"]
                        .as_str()
                        .unwrap_or("")
                )
            });
        return Err(invalid(
            format!(
                "tool_choice '{choice}' is not supported while {field} keeps DeepSeek thinking mode active; set {field} to 'none' or use tool_choice 'auto'"
            ),
            "tool_choice",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "chat_unicode_tests.rs"]
mod unicode_tests;
