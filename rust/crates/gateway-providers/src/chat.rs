//! Responses -> Chat-only request translation, preserving provider-specific boundaries.
use crate::tools::{flatten_tools, project_tool_choice};
use crate::types::{ChatProfile, Elision, ToolMap, invalid};
use gateway_core::{GatewayError, js_string::JsString16};
use serde_json::{Value, json};
pub const FORWARD_LIMIT: usize = 65_536;
pub const FORWARD_VERSION: &str = "deepseek-forwarded-payload/v1";
const CONTINUATION: &str = "When tools are available, a progress update does not complete a requested action. If required work remains and you can perform it, continue with the next appropriate tool call instead of ending with a status message. Provide a final answer when the requested work is complete, or when you need user input or are blocked. Never claim a tool action has been done unless its result is in the conversation.";
#[derive(Clone, Debug)]
pub struct ChatProjection {
    pub body: Value,
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

fn bound_source(
    text: &JsString16,
    path: &str,
    call_id: Option<&str>,
    kind: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
) -> Result<JsString16, GatewayError> {
    let original_bytes = text_encoder_len(text.as_units());
    if original_bytes <= FORWARD_LIMIT {
        return Ok(text.clone());
    }
    if reject {
        let call_note = call_id.map_or_else(String::new, |id| format!(" (tool call {id})"));
        return Err(GatewayError::new(
            400,
            format!("input item {path}{call_note} carries {original_bytes} bytes; this route forwards at most {FORWARD_LIMIT} bytes per message under {FORWARD_VERSION}, and the request set truncation 'disabled', so the gateway will not reduce it. Reduce the payload or send truncation 'auto' to allow the declared reduction."),
            Some("context_length_exceeded"),
        ).with_param(Some(path)));
    }
    // Source utf8Head starts with a code-unit budget, not a UTF8 byte offset.
    let mut head = utf16_head(text.as_units(), FORWARD_LIMIT);
    while !head.is_empty() && text_encoder_len(head) > FORWARD_LIMIT {
        head = utf16_head(head, (head.len() as f64 * 0.9).floor() as usize);
    }
    loop {
        let head_bytes = text_encoder_len(head);
        let omitted = original_bytes - head_bytes;
        let marker = format!(
            "\n[gateway: {FORWARD_VERSION} elided {omitted} bytes omitted; the model did not receive the elided bytes; this route forwards at most {FORWARD_LIMIT} bytes per message because the provider counts forwarded payloads as text tokens]"
        );
        if head.is_empty() || head_bytes + marker.len() <= FORWARD_LIMIT {
            let mut units = head.to_vec();
            units.extend(marker.encode_utf16());
            elisions.push(Elision {
                path: path.into(),
                call_id: call_id.map(str::to_owned),
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

fn bound(
    text: &str,
    path: &str,
    call_id: Option<&str>,
    kind: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
) -> Result<String, GatewayError> {
    bound_source(
        &JsString16::from_utf8(text),
        path,
        call_id,
        kind,
        reject,
        elisions,
    )?
    .try_utf8()
}

fn content(
    value: &Value,
    role: &str,
    path: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
) -> Result<Value, GatewayError> {
    if let Some(text) = value.as_str() {
        return Ok(Value::String(bound(
            text, path, None, "message", reject, elisions,
        )?));
    }
    let parts = value.as_array().ok_or_else(|| {
        invalid(
            "input.content must be a string or an array",
            "input.content",
        )
    })?;
    let mut text = String::new();
    let mut images = vec![];
    for (index, part) in parts.iter().enumerate() {
        let kind = part["type"].as_str().unwrap_or("");
        match kind {
            "text" | "input_text" | "output_text" => {
                text.push_str(part["text"].as_str().ok_or_else(|| {
                    invalid("input.content text must be a string", "input.content.text")
                })?)
            }
            "refusal" if role == "assistant" => {
                text.push_str(part["refusal"].as_str().ok_or_else(|| {
                    invalid(
                        "input.content refusal must be a string",
                        "input.content.refusal",
                    )
                })?)
            }
            "input_image" => {
                let url = part["image_url"]
                    .as_str()
                    .or_else(|| part["file_url"].as_str())
                    .ok_or_else(|| {
                        invalid("input_image requires image_url", "input.content.image_url")
                    })?;
                if url.len() > FORWARD_LIMIT {
                    if reject {
                        return Err(invalid(
                            "input_image exceeds forwarded payload limit",
                            &format!("{path}[{index}]"),
                        ));
                    }
                    let marker = format!(
                        "[gateway: {FORWARD_VERSION} image omitted ({} bytes); the model did not receive this image; this route forwards at most {FORWARD_LIMIT} bytes per message because the provider counts forwarded payloads as text tokens]",
                        url.len()
                    );
                    text.push_str(&marker);
                    elisions.push(Elision {
                        path: format!("{path}[{index}]"),
                        kind: "image".into(),
                        original_bytes: url.len(),
                        forwarded_bytes: marker.len(),
                        omitted_bytes: url.len(),
                        call_id: None,
                    });
                } else {
                    let mut image = json!({"type":"image_url","image_url":{"url":url}});
                    if let Some(detail) = part.get("detail").and_then(Value::as_str) {
                        image["image_url"]["detail"] = json!(detail)
                    }
                    images.push(image);
                }
            }
            _ => {
                return Err(invalid(
                    format!("input.content type '{kind}' is not supported"),
                    "input.content.type",
                ));
            }
        }
    }
    if images.is_empty() {
        return Ok(Value::String(bound(
            &text, path, None, "message", reject, elisions,
        )?));
    }
    // Account for every image byte, removing whole images rather than broken data URLs.
    while text.len()
        + images
            .iter()
            .map(|v| v["image_url"]["url"].as_str().unwrap_or("").len())
            .sum::<usize>()
        > FORWARD_LIMIT
    {
        if reject {
            return Err(invalid(
                "input.content exceeds forwarded payload limit",
                path,
            ));
        }
        if let Some(image) = images.pop() {
            let url = image["image_url"]["url"].as_str().unwrap_or("");
            let marker = format!(
                "[gateway: {FORWARD_VERSION} image omitted ({} bytes); the model did not receive this image; this route forwards at most {FORWARD_LIMIT} bytes per message because the provider counts forwarded payloads as text tokens]",
                url.len()
            );
            text.push_str(&marker);
            elisions.push(Elision {
                path: path.into(),
                kind: "image".into(),
                original_bytes: url.len(),
                forwarded_bytes: marker.len(),
                omitted_bytes: url.len(),
                call_id: None,
            });
        } else {
            break;
        }
    }
    let text = bound(&text, path, None, "message", reject, elisions)?;
    if !text.is_empty() {
        images.insert(0, json!({"type":"text","text":text}));
    }
    Ok(Value::Array(images))
}
fn reasoning_text(item: &Value) -> String {
    let mut text = String::new();
    for key in ["summary", "content"] {
        if let Some(parts) = item[key].as_array() {
            for part in parts {
                if let Some(value) = part["text"].as_str() {
                    text.push_str(value);
                }
            }
        }
    }
    if let Some(value) = item["text"].as_str() {
        text.push_str(value);
    }
    text
}
pub fn responses_messages(raw: &Value) -> Result<(Vec<Value>, Vec<Elision>), GatewayError> {
    let reject = match raw.get("truncation") {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) if s == "auto" => false,
        Some(Value::String(s)) if s == "disabled" => true,
        _ => {
            return Err(invalid(
                "truncation must be 'auto' or 'disabled'",
                "truncation",
            ));
        }
    };
    let mut messages = vec![];
    let mut elisions = vec![];
    let mut pending = String::new();
    if let Some(instructions) = raw["instructions"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        messages.push(json!({"role":"system","content":bound(instructions,"instructions",None,"message",reject,&mut elisions)?}));
    }
    let input = raw.get("input").unwrap_or(&Value::Null);
    let items = if let Some(text) = input.as_str() {
        vec![json!({"role":"user","content":text})]
    } else {
        input
            .as_array()
            .cloned()
            .ok_or_else(|| invalid("input must be a string or an array", "input"))?
    };
    for (index, item) in items.iter().enumerate() {
        let path = format!("input[{index}]");
        let kind = item["type"].as_str().unwrap_or("message");
        if let Some(text) = item.as_str() {
            pending.clear();
            messages.push(
                json!({"role":"user","content":bound(text,&path,None,"message",reject,&mut elisions)?}),
            );
            continue;
        }
        match kind {
            "reasoning" => pending.push_str(&reasoning_text(item)),
            "message" => {
                let role = item["role"].as_str().unwrap_or("user");
                if role == "user" {
                    pending.clear();
                }
                let role = if role == "developer" { "system" } else { role };
                let mut message = json!({"role":role,"content":content(item.get("content").unwrap_or(&Value::Null),role,&format!("{path}.content"),reject,&mut elisions)?});
                if role == "assistant" && !pending.is_empty() {
                    message["reasoning_content"] = json!(std::mem::take(&mut pending));
                }
                messages.push(message);
            }
            "function_call" | "custom_tool_call" => {
                let call_id = item["call_id"]
                    .as_str()
                    .or_else(|| item["id"].as_str())
                    .ok_or_else(|| {
                        invalid(format!("{kind} items require call_id and name"), "input")
                    })?;
                let name = item["name"].as_str().ok_or_else(|| {
                    invalid(format!("{kind} items require call_id and name"), "input")
                })?;
                let args = if kind == "custom_tool_call" {
                    json!({"input":item["input"].as_str().unwrap_or("")}).to_string()
                } else {
                    item["arguments"].as_str().unwrap_or("{}").into()
                };
                let call = json!({"id":call_id,"type":"function","function":{"name":name,"arguments":args}});
                let previous = messages.last_mut().filter(|v| {
                    v["role"] == "assistant" && v["content"].is_null() && v["tool_calls"].is_array()
                });
                if let Some(previous) = previous {
                    previous["tool_calls"]
                        .as_array_mut()
                        .expect("checked array")
                        .push(call);
                    if !pending.is_empty() {
                        let old = previous["reasoning_content"].as_str().unwrap_or("");
                        previous["reasoning_content"] =
                            json!(format!("{old}{}", std::mem::take(&mut pending)));
                    }
                } else {
                    let mut message =
                        json!({"role":"assistant","content":null,"tool_calls":[call]});
                    if !pending.is_empty() {
                        message["reasoning_content"] = json!(std::mem::take(&mut pending));
                    }
                    messages.push(message);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let Some(call_id) = item["call_id"].as_str() else {
                    continue;
                };
                let output = item.get("output").unwrap_or(&Value::Null);
                let text = if let Some(text) = output.as_str() {
                    text.into()
                } else {
                    output.to_string()
                };
                messages.push(json!({"role":"tool","tool_call_id":call_id,"content":bound(&text,&format!("{path}.output"),Some(call_id),"tool_output",reject,&mut elisions)?}));
            }
            "agent_message" => {
                pending.clear();
                let author = item["author"].as_str().unwrap_or("agent");
                let recipient = item["recipient"].as_str().unwrap_or("root");
                let mut texts = vec![];
                let mut omitted = 0;
                for part in item["content"].as_array().into_iter().flatten() {
                    if let Some(text) = part["text"].as_str() {
                        texts.push(text.to_owned());
                    } else if let Some(text) = part["encrypted_content"].as_str() {
                        if text.starts_with("gAAAAA") && text.len() >= 100 {
                            omitted += 1;
                        } else {
                            texts.push(text.into());
                        }
                    }
                }
                let notice = if omitted > 0 {
                    format!(
                        "\n[gateway: {omitted} sealed agent-message part(s) were not readable and omitted]"
                    )
                } else {
                    String::new()
                };
                let text = format!(
                    "[agent message] {author} -> {recipient}:\n{}{notice}",
                    texts.join("\n")
                );
                messages.push(json!({"role":"user","content":bound(&text,&path,None,"agent_message",reject,&mut elisions)?}));
            }
            _ => {
                return Err(invalid(
                    format!("input item type '{kind}' is not supported"),
                    "input.type",
                ));
            }
        }
    }
    Ok((messages, elisions))
}
pub fn project_responses(
    raw: &Value,
    model: &str,
    stream: bool,
    profile: ChatProfile,
) -> Result<ChatProjection, GatewayError> {
    let (mut messages, mut elisions) = responses_messages(raw)?;
    if messages.is_empty() {
        return Err(invalid("input must contain at least one message", "input"));
    }
    let (tools, names) = flatten_tools(raw.get("tools"), 128)?;
    let mut body = json!({"model":model,"messages":[],"stream":stream});
    if let Some(effort) = raw["reasoning"]["effort"].as_str() {
        body["reasoning_effort"] = json!(project_effort(effort, profile)?);
    } else if profile == ChatProfile::Deepseek && !thinking_active(None, &raw["thinking"]) {
        body["reasoning_effort"] = json!("none");
    }
    let thinking = profile == ChatProfile::Deepseek
        && thinking_active(body["reasoning_effort"].as_str(), &raw["thinking"]);
    let mut warnings = Vec::new();
    for field in ["temperature", "top_p"] {
        if let Some(value) = raw.get(field) {
            if thinking {
                warnings.push(format!("{field}_ignored"));
            } else {
                body[field] = value.clone();
            }
        }
    }
    if let Some(max) = raw.get("max_output_tokens").filter(|v| !v.is_null()) {
        if !max
            .as_u64()
            .is_some_and(|v| v > 0 && v <= 9_007_199_254_740_991)
        {
            return Err(invalid(
                "max_output_tokens must be a positive integer",
                "max_output_tokens",
            ));
        }
        body["max_tokens"] = max.clone();
    }
    if stream && profile == ChatProfile::Deepseek {
        body["stream_options"] = json!({"include_usage":true});
    }
    if profile == ChatProfile::Cerebras
        && let Some(key) = raw.get("prompt_cache_key")
    {
        body["prompt_cache_key"] = key.clone();
    }
    if !tools.is_empty() {
        if raw["tool_choice"] != "none" {
            let system = messages
                .iter()
                .position(|m| m["role"] == "system" && m["content"].is_string());
            if let Some(index) = system {
                let text = format!(
                    "{}\n\n{CONTINUATION}",
                    messages[index]["content"].as_str().unwrap_or("")
                );
                messages[index]["content"] = json!(bound(
                    &text,
                    "instructions",
                    None,
                    "message",
                    raw["truncation"] == "disabled",
                    &mut elisions
                )?);
            } else {
                messages.insert(0, json!({"role":"system","content":CONTINUATION}));
            }
        }
        let start = messages
            .iter()
            .rposition(|m| m["role"] == "user")
            .map_or(0, |i| i + 1);
        for message in messages.iter_mut().skip(start) {
            if message["role"] == "assistant" && !message["reasoning_content"].is_string() {
                message["reasoning_content"] = json!("");
            }
        }
        body["tools"] = Value::Array(tools);
    }
    if let Some(choice) = project_tool_choice(raw.get("tool_choice"), &names)? {
        body["tool_choice"] = choice;
    }
    if let Some(parallel) = raw.get("parallel_tool_calls").filter(|v| v.is_boolean()) {
        body["parallel_tool_calls"] = parallel.clone();
    }
    if let Some(format) = raw["text"].get("format").filter(|v| !v.is_null()) {
        match format["type"].as_str().unwrap_or("text") {
            "text" => (),
            "json_object" => body["response_format"] = json!({"type":"json_object"}),
            other => {
                return Err(invalid(
                    format!("text.format type '{other}' is not supported upstream"),
                    "text.format.type",
                ));
            }
        }
    }
    if profile == ChatProfile::Deepseek {
        validate_thinking_choice(&body, "reasoning.effort")?;
    }
    body["messages"] = Value::Array(messages);
    Ok(ChatProjection {
        body,
        tool_names: names,
        elisions,
        warnings,
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
