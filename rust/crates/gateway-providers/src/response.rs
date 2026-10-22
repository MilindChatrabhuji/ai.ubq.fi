//! Buffered response validation and translation. Transport success is not semantic completion.
use crate::source as s;
use crate::{
    tools,
    types::*,
    usage,
    writer::{ResponseWriter, envelope, finish_disposition},
};
use gateway_core::source_json::SourceJson;
use gateway_core::{GatewayError, lifecycle::SemanticTerminal, provider::UpstreamProvider};
use serde_json::{Value, json};
pub fn normalize_chat_completion(
    value: &Value,
    plan: &DecodePlan,
) -> Result<SourceJson, GatewayError> {
    let fields = normalize_chat_completion_fragment(value, plan)?;
    Ok(chat_model_body(&fields, plan))
}
fn chat_model_body(fields: &Value, plan: &DecodePlan) -> SourceJson {
    let mut body = s::generated(fields);
    s::set(&mut body, "model", s::quoted(plan.model.as_js_string()));
    body
}
/// Only actual scalar upstream fragments, without source-derived model/request fields.
fn normalize_chat_completion_fragment(
    value: &Value,
    plan: &DecodePlan,
) -> Result<Value, GatewayError> {
    let id = value["id"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| malformed("Upstream Chat Completion is missing an id."))?;
    let created = value["created"]
        .as_u64()
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or_else(|| malformed("Upstream Chat Completion has an invalid creation time."))?;
    if value.get("object").is_some_and(|v| v != "chat.completion") {
        return Err(malformed("Upstream did not return a Chat Completion."));
    }
    let choices = value["choices"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| malformed("Upstream Chat Completion has no choices."))?;
    let mut normalized = vec![];
    for (position, choice) in choices.iter().enumerate() {
        let message = &choice["message"];
        if message["role"] != "assistant" {
            return Err(malformed(
                "Upstream choice does not contain an assistant message.",
            ));
        }
        for key in ["content", "refusal", "reasoning_content", "reasoning"] {
            if message
                .get(key)
                .is_some_and(|v| !v.is_null() && !v.is_string())
            {
                return Err(malformed(format!("Upstream choice has invalid {key}.")));
            }
        }
        let calls = if let Some(calls) = message.get("tool_calls").filter(|value| !value.is_null())
        {
            let mut validated = vec![];
            for call in calls
                .as_array()
                .ok_or_else(|| malformed("Upstream tool calls are not an array."))?
            {
                let id = call["id"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.trim() == *s)
                    .ok_or_else(|| malformed("Upstream tool call id is invalid."))?;
                let name = call["function"]["name"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.trim() == *s)
                    .ok_or_else(|| malformed("Upstream tool name is invalid."))?;
                let args = call["function"]["arguments"]
                    .as_str()
                    .ok_or_else(|| malformed("Upstream tool arguments are invalid."))?;
                validated.push(
                    json!({"id":id,"type":"function","function":{"name":name,"arguments":args}}),
                );
            }
            validated
        } else {
            vec![]
        };
        let content = message["content"].as_str().unwrap_or("");
        let refusal = message["refusal"].as_str().unwrap_or("");
        let reasoning = message["reasoning_content"]
            .as_str()
            .or_else(|| message["reasoning"].as_str());
        if message.get("content").is_none()
            && refusal.is_empty()
            && calls.is_empty()
            && reasoning.is_none()
        {
            return Err(malformed(
                "Upstream choice has neither content nor a tool call.",
            ));
        }
        let mut mapped = json!({"role":"assistant","content":if content.is_empty()&&(!calls.is_empty()||!refusal.is_empty()){Value::Null}else{json!(content)}});
        if !calls.is_empty() {
            mapped["tool_calls"] = json!(calls);
        }
        if !refusal.is_empty() {
            mapped["refusal"] = json!(refusal);
        }
        if let Some(reasoning) = reasoning {
            mapped[if plan.provider == UpstreamProvider::Cerebras {
                "reasoning"
            } else {
                "reasoning_content"
            }] = json!(reasoning);
        }
        let finish = choice.get("finish_reason").cloned().unwrap_or(Value::Null);
        if !finish.is_null() && !finish.is_string() {
            return Err(malformed("Upstream choice has an invalid finish reason."));
        }
        normalized.push(json!({"index":choice["index"].as_u64().unwrap_or(position as u64),"message":mapped,"finish_reason":finish}));
    }
    let mut result =
        json!({"id":id,"object":"chat.completion","created":created,"choices":normalized});
    if let Some(value) = value.get("usage").filter(|v| !v.is_null()) {
        if !value.is_object() {
            return Err(malformed("Upstream usage is not an object."));
        }
        result["usage"] = value.clone();
    }
    Ok(result)
}
pub fn chat_completion_to_responses(
    completion: &Value,
    plan: &DecodePlan,
    profile: ChatProfile,
) -> SourceJson {
    let (reason, incomplete, error) =
        finish_disposition(completion["choices"][0]["finish_reason"].as_str());
    let status = match reason {
        SemanticTerminal::Completed => "completed",
        SemanticTerminal::Incomplete => "incomplete",
        _ => "failed",
    };
    let mut body = envelope(plan, status);
    s::set(
        &mut body,
        "created_at",
        s::generated(
            &completion
                .get("created")
                .cloned()
                .unwrap_or(json!(plan.created_at)),
        ),
    );
    let mut output = vec![];
    for (choice_index, choice) in completion["choices"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let message = &choice["message"];
        if let Some(reason) = message["reasoning_content"]
            .as_str()
            .or_else(|| message["reasoning"].as_str())
            .filter(|s| !s.is_empty())
            && !plan
                .reasoning_summary
                .as_ref()
                .is_some_and(|value| value.as_units().iter().copied().eq("none".encode_utf16()))
        {
            output.push(s::generated(&json!({"id":format!("rs_{}_{choice_index}",plan.response_id),"type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":reason}]})));
        }
        let mut parts = vec![];
        if let Some(text) = message["content"].as_str().filter(|s| !s.is_empty()) {
            parts.push(json!({"type":"output_text","text":text,"annotations":[]}));
        }
        if let Some(refusal) = message["refusal"].as_str().filter(|s| !s.is_empty()) {
            parts.push(json!({"type":"refusal","refusal":refusal}));
        }
        if !parts.is_empty() {
            output.push(s::generated(&json!({"id":format!("msg_{}_{choice_index}",plan.response_id),"type":"message","status":"completed","role":"assistant","content":parts})));
        }
        for (call_index, call) in message["tool_calls"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let name = call["function"]["name"].as_str().unwrap_or("");
            let identity = tools::original(name, &plan.tool_names);
            let prefix = if identity.custom { "ctc" } else { "fc" };
            let id = format!("{prefix}_{}_{choice_index}_{call_index}", plan.response_id);
            let fallback = format!("{}_call_{call_index}", plan.response_id);
            let call_id = call["id"].as_str().unwrap_or(&fallback);
            output.push(tools::function_item(
                &id,
                call_id,
                name,
                call["function"]["arguments"].as_str().unwrap_or(""),
                &plan.tool_names,
                "completed",
            ));
        }
    }
    s::set(&mut body, "output", s::array(&output));
    s::set(
        &mut body,
        "usage",
        s::generated(&usage::chat_to_responses(&completion["usage"], profile)),
    );
    if let Some(incomplete) = incomplete {
        s::set(
            &mut body,
            "incomplete_details",
            s::generated(&json!({"reason":incomplete})),
        );
    }
    if let Some(error) = error {
        s::set(
            &mut body,
            "error",
            s::generated(
                &json!({"code":error,"message":format!("Upstream stopped generating: {error}")}),
            ),
        );
    }
    body
}
pub fn response_to_chat(payload: &Value, plan: &DecodePlan) -> Result<SourceJson, GatewayError> {
    crate::source_response::to_chat(&s::generated(payload), plan)
}
fn replay_chat(completion: &Value, plan: &DecodePlan, profile: ChatProfile) -> Vec<ProviderEvent> {
    let mut writer = ResponseWriter::new(plan.clone());
    let mut delta = completion["choices"][0]["message"].clone();
    if let Some(calls) = delta["tool_calls"].as_array_mut() {
        for (index, call) in calls.iter_mut().enumerate() {
            call["index"] = json!(index);
        }
    }
    let mut events=writer.chat_chunk(&json!({"choices":[{"delta":delta,"finish_reason":completion["choices"][0]["finish_reason"]}],"usage":completion["usage"]}),profile);
    events.extend(writer.finish());
    events
}
fn decode_anthropic(
    value: &Value,
    plan: &DecodePlan,
) -> Result<(SourceJson, Vec<ProviderEvent>), GatewayError> {
    if value["type"] != "message" || value["role"] != "assistant" {
        return Err(malformed(
            "Anthropic Messages returned an invalid assistant message.",
        ));
    }
    let mut native_plan = plan.clone();
    if let Some(id) = value["id"].as_str().filter(|s| !s.is_empty()) {
        native_plan.response_id = native_response_id(id, &plan.response_id);
    }
    let mut writer = ResponseWriter::new(native_plan);
    let blocks = value["content"]
        .as_array()
        .ok_or_else(|| malformed("Anthropic Messages content is not an array."))?;
    let mut events = writer.start();
    for (index, block) in blocks.iter().enumerate() {
        match block["type"].as_str().unwrap_or("") {
            "text" => {
                events.extend(
                    writer.text(
                        block["text"]
                            .as_str()
                            .ok_or_else(|| malformed("Anthropic text is invalid."))?,
                        false,
                    ),
                );
                events.extend(writer.close());
            }
            "thinking" => {
                events.extend(
                    writer.reasoning(
                        block["thinking"]
                            .as_str()
                            .ok_or_else(|| malformed("Anthropic thinking is invalid."))?,
                    ),
                );
                events.extend(writer.close());
            }
            "tool_use" => {
                if !block["input"].is_object() {
                    return Err(malformed("Anthropic tool input is not object."));
                }
                events.extend(
                    writer.tool_delta(
                        index,
                        Some(
                            block["id"]
                                .as_str()
                                .ok_or_else(|| malformed("Anthropic tool id is invalid."))?,
                        ),
                        Some(
                            block["name"]
                                .as_str()
                                .ok_or_else(|| malformed("Anthropic tool name is invalid."))?,
                        ),
                        &block["input"].to_string(),
                    ),
                );
            }
            "redacted_thinking" => {
                if !block["data"].is_string() {
                    return Err(malformed("Anthropic redacted thinking is invalid."));
                }
            }
            _ => return Err(malformed("Anthropic content block is unsupported.")),
        }
    }
    writer.finish_reason = Some(crate::writer::anthropic_reason(
        value["stop_reason"].as_str().unwrap_or("unknown"),
    ));
    writer.usage = usage::anthropic_to_responses(&value["usage"]);
    events.extend(writer.finish());
    crate::finalize::native_stop_error(
        &mut events,
        value["stop_reason"].as_str().unwrap_or("unknown"),
    );
    let body = events
        .last()
        .and_then(|event| event.field("response"))
        .ok_or_else(|| malformed("Anthropic terminal is absent."))?;
    Ok((body, events))
}
/// The fixed Codex Responses request always speaks SSE. The source consumer
/// reads every successful Codex body as SSE even when the upstream omits its
/// media type; no other provider or explicit non-SSE media type is inferred.
pub fn is_event_stream(provider: UpstreamProvider, status: u16, headers: &Headers) -> bool {
    match header(headers, "content-type") {
        Some(value) => value.contains("text/event-stream"),
        None => provider == UpstreamProvider::ChatgptCodex && (200..300).contains(&status),
    }
}
pub fn decode_response(
    plan: &DecodePlan,
    status: u16,
    headers: &Headers,
    bytes: &[u8],
) -> Result<DecodedResponse, GatewayError> {
    let response_plan = response_plan(plan, headers);
    let plan = &response_plan;
    let mut output_headers = Headers::from([
        ("Content-Type".into(), "application/json".into()),
        (
            "x-uos-upstream".into(),
            crate::policy::direct_provider_label(plan.provider).into(),
        ),
    ]);
    for (key, value) in headers {
        let lower = key.to_lowercase();
        if lower == "retry-after"
            || lower.starts_with("x-ratelimit-")
            || [
                "x-request-id",
                "request-id",
                "x-uos-warning",
                "x-should-retry",
            ]
            .contains(&lower.as_str())
        {
            output_headers.insert(key.clone(), value.clone());
        }
    }
    if status >= 400 && plan.provider == UpstreamProvider::ChatgptCodex {
        if let Some(content_type) = header(headers, "content-type") {
            output_headers.insert("Content-Type".into(), content_type.into());
        }
        return Ok(DecodedResponse {
            status,
            headers: output_headers,
            body: s::generated(&serde_json::from_slice::<Value>(bytes).unwrap_or(Value::Null)),
            events: vec![],
            terminal: Some(SemanticTerminal::Error),
            usage: None,
            native_replay: None,
            raw_body: Some(bytes.to_vec()),
        });
    }
    if is_event_stream(plan.provider, status, headers) {
        let mut decoder = crate::sse::StreamDecoder::new(plan.clone());
        let mut events = decoder.push(bytes)?;
        events.extend(decoder.finish()?);
        // The decoder stops at the first terminal. An error must not fall back to
        // an earlier response.created payload or the generic completed sentinel.
        if plan.surface == ClientSurface::Responses
            && let Some(event) = events
                .iter()
                .find(|event| event.type_name().as_deref() == Some("error"))
        {
            let body = if plan.stream {
                output_headers.insert("Content-Type".into(), "text/event-stream".into());
                event.data.clone()
            } else {
                s::generated(&json!({"error":{
                    "message":s::control(&s::get(&event.data,"message")).unwrap_or_else(||"Upstream Responses stream ended unexpectedly.".into()),
                    "type":"invalid_request_error",
                    "code":s::control(&s::get(&event.data,"code")).unwrap_or_else(||"server_error".into())
                }}))
            };
            return Ok(DecodedResponse {
                status: if plan.stream { status } else { 502 },
                headers: output_headers,
                body,
                events,
                terminal: Some(SemanticTerminal::Error),
                usage: None,
                native_replay: None,
                raw_body: None,
            });
        }
        let body = events
            .iter()
            .rev()
            .find_map(|e| e.field("response"))
            .unwrap_or_else(s::null);
        let mut body = if plan.surface == ClientSurface::Chat {
            collect_chat_events(&events, plan)?
        } else {
            body
        };
        if plan.surface == ClientSurface::Chat
            && let Some(usage) = decoder.observed_usage().and_then(usage::responses_to_chat)
        {
            s::set(&mut body, "usage", s::generated(&usage));
        }
        if plan.stream {
            output_headers.insert("Content-Type".into(), "text/event-stream".into());
        }
        let terminal = terminal_for(&body).or_else(|| {
            decoder
                .terminal_observed()
                .then_some(SemanticTerminal::Completed)
        });
        let usage = crate::source_collector::usage(&s::get(&body, "usage"));
        return Ok(DecodedResponse {
            status,
            headers: output_headers,
            body,
            events,
            terminal,
            usage,
            native_replay: decoder.native_replay().cloned(),
            raw_body: None,
        });
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| malformed("Upstream response was not valid JSON."))?;
    let mut buffered_plan = plan.clone();
    if plan.decode == ResponseDecode::AnthropicChatToResponses {
        if let Some(id) = value["id"].as_str() {
            buffered_plan.response_id = translated_response_id(id);
        }
    } else if plan.decode == ResponseDecode::ChatToResponses(ChatProfile::Cerebras)
        && translated_provider_request_id(plan.provider, headers).is_none()
        && let Some(id) = value["id"]
            .as_str()
            .filter(|id| valid_provider_request_id(id))
    {
        buffered_plan.response_id = translated_response_id(id);
    }
    let plan = &buffered_plan;
    if let Some(refusal) =
        crate::finalize::lithos_stream_refusal(plan, status, &output_headers, &value)
    {
        return Ok(refusal);
    }
    if status >= 400 {
        return Ok(DecodedResponse {
            status,
            headers: output_headers,
            body: s::generated(&if value["error"].is_object() {
                value
            } else {
                json!({"error":{"message":format!("Upstream request failed ({status})."),"type":"server_error","code":"upstream_error","param":null}})
            }),
            events: vec![],
            terminal: Some(SemanticTerminal::Error),
            usage: None,
            native_replay: None,
            raw_body: None,
        });
    }
    let mut events = vec![];
    let mut native_replay = None;
    let body = match plan.decode {
        ResponseDecode::Chat => {
            let normalized = normalize_chat_completion_fragment(&value, plan)?;
            if plan.provider == UpstreamProvider::Cerebras
                && !crate::policy::chat_has_answer(&normalized)
            {
                return Err(cerebras_empty());
            }
            if plan.stream {
                events = crate::finalize::buffered_chat_events(&normalized, plan);
            }
            chat_model_body(&normalized, plan)
        }
        ResponseDecode::ChatToResponses(_) | ResponseDecode::AnthropicChatToResponses => {
            let profile = if plan.decode == ResponseDecode::AnthropicChatToResponses {
                ChatProfile::Claude
            } else {
                profile_for(plan.decode)
            };
            let projected = if plan.decode == ResponseDecode::AnthropicChatToResponses {
                let mut copy = value.clone();
                let reasoning =
                    crate::claude_chat_stream::readable_reasoning(&value["choices"][0]["message"]);
                if !reasoning.is_empty() {
                    copy["choices"][0]["message"]["reasoning_content"] = json!(reasoning);
                }
                copy
            } else {
                value.clone()
            };
            let completion = normalize_chat_completion_fragment(&projected, plan)?;
            if plan.provider == UpstreamProvider::Cerebras
                && !crate::policy::chat_has_answer(&completion)
            {
                return Err(cerebras_empty());
            }
            let body = chat_completion_to_responses(&completion, plan, profile);
            if s::is(&s::get(&body, "status"), "completed")
                && !crate::source_policy::response_has_answer(&body)
            {
                return Err(GatewayError::new(
                    502,
                    "Upstream response completed with no translated semantic output.",
                    Some("empty_upstream_completion"),
                )
                .with_type("server_error"));
            }
            if plan.stream {
                events = replay_chat(&completion, plan, profile);
            }
            if plan.decode == ResponseDecode::AnthropicChatToResponses
                && s::is(&s::get(&body, "status"), "completed")
            {
                native_replay = value["choices"][0].get("message").cloned();
            }
            if plan.surface == ClientSurface::Chat {
                crate::source_response::to_chat(&body, plan)?
            } else {
                body
            }
        }
        ResponseDecode::AnthropicToResponses => {
            let (body, translated) = decode_anthropic(&value, plan)?;
            events = if plan.stream { translated } else { vec![] };
            if s::is(&s::get(&body, "status"), "completed") {
                native_replay = Some(json!({"role":"assistant","content":value["content"]}));
            }
            if plan.surface == ClientSurface::Chat {
                crate::source_response::to_chat(&body, plan)?
            } else {
                body
            }
        }
        ResponseDecode::Responses | ResponseDecode::ResponsesToChat => {
            if !value.is_object() {
                return Err(malformed("Upstream Responses body is invalid."));
            }
            if value["status"] == "completed" && !crate::policy::response_has_answer(&value) {
                return Err(GatewayError::new(
                    502,
                    "Upstream response completed with no translated semantic output.",
                    Some("empty_upstream_completion"),
                )
                .with_type("server_error"));
            }
            if plan.decode == ResponseDecode::ResponsesToChat {
                response_to_chat(&value, plan)?
            } else {
                s::generated(&value)
            }
        }
        ResponseDecode::Voyage => crate::extras::decode_embeddings(&value, plan)?,
        ResponseDecode::SystemOne => s::generated(&crate::extras::decode_systemone(&value)?),
    };
    if plan.stream && !events.is_empty() {
        output_headers.insert("Content-Type".into(), "text/event-stream".into());
    }
    let terminal = terminal_for(&body).or_else(|| {
        matches!(
            plan.surface,
            ClientSurface::Chat | ClientSurface::Embeddings | ClientSurface::SystemOne
        )
        .then_some(SemanticTerminal::Completed)
    });
    let usage = crate::source_collector::usage(&s::get(&body, "usage"));
    Ok(DecodedResponse {
        status,
        headers: output_headers,
        body,
        events,
        terminal,
        usage,
        native_replay,
        raw_body: None,
    })
}
fn profile_for(decode: ResponseDecode) -> ChatProfile {
    if let ResponseDecode::ChatToResponses(profile) = decode {
        profile
    } else {
        ChatProfile::Claude
    }
}
fn cerebras_empty() -> GatewayError {
    GatewayError::new(
        502,
        "Cerebras upstream returned an invalid completion.",
        Some("cerebras_upstream_invalid_response"),
    )
    .with_type("server_error")
}
fn terminal_for(value: &SourceJson) -> Option<SemanticTerminal> {
    match s::control(&s::get(value, "status")).as_deref() {
        Some("completed") => Some(SemanticTerminal::Completed),
        Some("incomplete") => Some(SemanticTerminal::Incomplete),
        Some("failed") => Some(SemanticTerminal::Failed),
        _ => None,
    }
}
fn collect_chat_events(
    events: &[ProviderEvent],
    plan: &DecodePlan,
) -> Result<SourceJson, GatewayError> {
    crate::source_response::collect(events, plan)
}

/// Exact source Chat-only Responses producer spelling, not an upstream identity validator.
pub fn translated_response_id(id: &str) -> String {
    let clean = id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(40)
        .collect::<String>();
    format!("resp_{clean}")
}

fn valid_provider_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && id.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn first_header<'a>(headers: &'a Headers, names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| header(headers, name))
}

fn translated_provider_request_id(provider: UpstreamProvider, headers: &Headers) -> Option<&str> {
    // Source selects the first PRESENT header, then validates it. A malformed
    // preferred value must not silently select a later header.
    let names: &[&str] = match provider {
        UpstreamProvider::Deepseek => &["x-request-id", "x-ds-request-id", "x-deepseek-request-id"],
        UpstreamProvider::Cerebras => {
            &["x-request-id", "x-api-request-id", "x-cerebras-request-id"]
        }
        // Lithos deliberately has no documented response request-ID header.
        _ => return None,
    };
    first_header(headers, names).filter(|id| valid_provider_request_id(id))
}

/// Bind actual source header identity once, before both buffer and stream translation.
/// Native Responses and ordinary Chat retain the upstream's own body/event IDs.
pub fn response_plan(plan: &DecodePlan, headers: &Headers) -> DecodePlan {
    let mut result = plan.clone();
    let source_id = match plan.decode {
        ResponseDecode::ChatToResponses(_) => {
            translated_provider_request_id(plan.provider, headers)
        }
        ResponseDecode::AnthropicChatToResponses => first_header(
            headers,
            &["x-request-id", "x-api-request-id", "x-oneapi-request-id"],
        )
        .map(gateway_schema::util::js_trim)
        .filter(|id| !id.is_empty()),
        ResponseDecode::AnthropicToResponses => match plan.provider {
            UpstreamProvider::Metered => {
                ["x-api-request-id", "x-oneapi-request-id", "x-request-id"]
                    .into_iter()
                    .filter_map(|name| header(headers, name).map(gateway_schema::util::js_trim))
                    .find(|id| !id.is_empty())
            }
            UpstreamProvider::ClaudeCode => first_header(headers, &["request-id", "x-request-id"])
                .map(gateway_schema::util::js_trim)
                .filter(|id| !id.is_empty()),
            _ => None,
        },
        _ => None,
    };
    if let Some(id) = source_id {
        result.response_id = if plan.decode == ResponseDecode::AnthropicToResponses {
            native_response_id(id, &plan.response_id)
        } else {
            translated_response_id(id)
        };
    }
    result
}

pub(crate) fn native_response_id(id: &str, fallback: &str) -> String {
    let id = translated_response_id(id);
    if id == "resp_" { fallback.into() } else { id }
}
