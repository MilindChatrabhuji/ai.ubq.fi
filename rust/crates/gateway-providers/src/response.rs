//! Buffered response validation and translation. Transport success is not semantic completion.
use crate::{
    tools,
    types::*,
    usage,
    writer::{ResponseWriter, envelope, finish_disposition},
};
use gateway_core::{GatewayError, lifecycle::SemanticTerminal, provider::UpstreamProvider};
use serde_json::{Value, json};
pub fn normalize_chat_completion(value: &Value, plan: &DecodePlan) -> Result<Value, GatewayError> {
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
        let calls = if let Some(calls) = message.get("tool_calls") {
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
    let mut result = json!({"id":id,"object":"chat.completion","created":created,"model":plan.model,"choices":normalized});
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
) -> Value {
    let (reason, incomplete, error) =
        finish_disposition(completion["choices"][0]["finish_reason"].as_str());
    let status = match reason {
        SemanticTerminal::Completed => "completed",
        SemanticTerminal::Incomplete => "incomplete",
        _ => "failed",
    };
    let mut body = envelope(plan, status);
    body["created_at"] = completion
        .get("created")
        .cloned()
        .unwrap_or(json!(plan.created_at));
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
        {
            if plan.reasoning_summary.as_deref() != Some("none") {
                output.push(json!({"id":format!("rs_{}_{choice_index}",plan.response_id),"type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":reason}]}));
            }
        }
        let mut parts = vec![];
        if let Some(text) = message["content"].as_str().filter(|s| !s.is_empty()) {
            parts.push(json!({"type":"output_text","text":text,"annotations":[]}));
        }
        if let Some(refusal) = message["refusal"].as_str().filter(|s| !s.is_empty()) {
            parts.push(json!({"type":"refusal","refusal":refusal}));
        }
        if !parts.is_empty() {
            output.push(json!({"id":format!("msg_{}_{choice_index}",plan.response_id),"type":"message","status":"completed","role":"assistant","content":parts}));
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
    body["output"] = json!(output);
    body["usage"] = usage::chat_to_responses(&completion["usage"], profile).unwrap_or(Value::Null);
    if let Some(incomplete) = incomplete {
        body["incomplete_details"] = json!({"reason":incomplete});
    }
    if let Some(error) = error {
        body["error"] =
            json!({"code":error,"message":format!("Upstream stopped generating: {error}")});
    }
    body
}
pub fn response_to_chat(payload: &Value, plan: &DecodePlan) -> Result<Value, GatewayError> {
    if payload["status"] != "completed" {
        return Err(malformed(
            "Upstream stream ended without response.completed.",
        ));
    }
    let mut text = String::new();
    let mut refusal = String::new();
    let mut calls = vec![];
    for item in payload["output"].as_array().into_iter().flatten() {
        match item["type"].as_str().unwrap_or("") {
            "message" => {
                for part in item["content"].as_array().into_iter().flatten() {
                    if let Some(value) = part["text"].as_str() {
                        text.push_str(value);
                    }
                    if let Some(value) = part["refusal"].as_str() {
                        refusal.push_str(value);
                    }
                }
            }
            "function_call" => {
                let id = item["call_id"]
                    .as_str()
                    .ok_or_else(|| malformed("Upstream function call has no call_id."))?;
                let name = item["name"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| malformed("Upstream function call has no name."))?;
                let arguments = item["arguments"]
                    .as_str()
                    .ok_or_else(|| malformed("Upstream function call arguments are invalid."))?;
                calls.push(json!({"id":id,"type":"function","function":{"name":name,"arguments":arguments}}));
            }
            _ => (),
        }
    }
    if text.is_empty() && refusal.is_empty() && calls.is_empty() {
        return Err(GatewayError::new(
            502,
            "Upstream response completed with no translated semantic output.",
            Some("empty_upstream_completion"),
        )
        .with_type("server_error"));
    }
    let mut message = json!({"role":"assistant","content":if text.is_empty()&&(!calls.is_empty()||!refusal.is_empty()){Value::Null}else{json!(text)}});
    if !refusal.is_empty() {
        message["refusal"] = json!(refusal);
    }
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    let mut result = json!({"id":payload.get("id").cloned().unwrap_or(json!(plan.response_id)),"object":"chat.completion","created":payload.get("created_at").cloned().unwrap_or(json!(plan.created_at)),"model":plan.model,"choices":[{"index":0,"message":message,"finish_reason":if calls.is_empty(){"stop"}else{"tool_calls"}}]});
    if let Some(usage) = usage::responses_to_chat(&payload["usage"]) {
        result["usage"] = usage;
    }
    Ok(result)
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
) -> Result<(Value, Vec<ProviderEvent>), GatewayError> {
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
        .and_then(|event| event.data.get("response"))
        .cloned()
        .ok_or_else(|| malformed("Anthropic terminal is absent."))?;
    Ok((body, events))
}
pub fn decode_response(
    plan: &DecodePlan,
    status: u16,
    headers: &Headers,
    bytes: &[u8],
) -> Result<DecodedResponse, GatewayError> {
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
            body: serde_json::from_slice(bytes).unwrap_or(Value::Null),
            events: vec![],
            terminal: Some(SemanticTerminal::Error),
            usage: None,
            native_replay: None,
            raw_body: Some(bytes.to_vec()),
        });
    }
    if header(headers, "content-type").is_some_and(|v| v.contains("text/event-stream")) {
        let mut decoder = crate::sse::StreamDecoder::new(plan.clone());
        let mut events = decoder.push(bytes)?;
        events.extend(decoder.finish()?);
        let body = events
            .iter()
            .rev()
            .find_map(|e| e.data.get("response").cloned())
            .unwrap_or(Value::Null);
        let mut body = if plan.surface == ClientSurface::Chat {
            collect_chat_events(&events, plan)?
        } else {
            body
        };
        if plan.surface == ClientSurface::Chat {
            if let Some(usage) = decoder.observed_usage().and_then(usage::responses_to_chat) {
                body["usage"] = usage;
            }
        }
        if plan.stream {
            output_headers.insert("Content-Type".into(), "text/event-stream".into());
        }
        let terminal = terminal_for(&body).or_else(|| {
            decoder
                .terminal_observed()
                .then_some(SemanticTerminal::Completed)
        });
        let usage = body.get("usage").filter(|v| !v.is_null()).cloned();
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
    if let Some(refusal) =
        crate::finalize::lithos_stream_refusal(plan, status, &output_headers, &value)
    {
        return Ok(refusal);
    }
    if status >= 400 {
        return Ok(DecodedResponse {
            status,
            headers: output_headers,
            body: if value["error"].is_object() {
                value
            } else {
                json!({"error":{"message":format!("Upstream request failed ({status})."),"type":"server_error","code":"upstream_error","param":null}})
            },
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
            let normalized = normalize_chat_completion(&value, plan)?;
            if plan.provider == UpstreamProvider::Cerebras
                && !crate::policy::chat_has_answer(&normalized)
            {
                return Err(cerebras_empty());
            }
            if plan.stream {
                events = crate::finalize::buffered_chat_events(&normalized, plan);
            }
            normalized
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
            let completion = normalize_chat_completion(&projected, plan)?;
            if plan.provider == UpstreamProvider::Cerebras
                && !crate::policy::chat_has_answer(&completion)
            {
                return Err(cerebras_empty());
            }
            let body = chat_completion_to_responses(&completion, plan, profile);
            if body["status"] == "completed" && !crate::policy::response_has_answer(&body) {
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
            if plan.decode == ResponseDecode::AnthropicChatToResponses {
                if body["status"] == "completed" {
                    native_replay = value["choices"][0].get("message").cloned();
                }
            }
            if plan.surface == ClientSurface::Chat {
                response_to_chat(&body, plan)?
            } else {
                body
            }
        }
        ResponseDecode::AnthropicToResponses => {
            let (body, translated) = decode_anthropic(&value, plan)?;
            events = if plan.stream { translated } else { vec![] };
            if body["status"] == "completed" {
                native_replay = Some(json!({"role":"assistant","content":value["content"]}));
            }
            if plan.surface == ClientSurface::Chat {
                response_to_chat(&body, plan)?
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
                value
            }
        }
        ResponseDecode::Voyage => crate::extras::decode_embeddings(&value, plan)?,
        ResponseDecode::SystemOne => crate::extras::decode_systemone(&value)?,
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
    let usage = body.get("usage").filter(|v| !v.is_null()).cloned();
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
fn terminal_for(value: &Value) -> Option<SemanticTerminal> {
    match value["status"].as_str() {
        Some("completed") => Some(SemanticTerminal::Completed),
        Some("incomplete") => Some(SemanticTerminal::Incomplete),
        Some("failed") => Some(SemanticTerminal::Failed),
        _ => None,
    }
}
fn collect_chat_events(events: &[ProviderEvent], plan: &DecodePlan) -> Result<Value, GatewayError> {
    let mut text = String::new();
    let mut refusal = String::new();
    let mut calls = std::collections::BTreeMap::<u64, Value>::new();
    let mut usage = None;
    let mut complete = false;
    for event in events {
        if event.data == "[DONE]" {
            complete = true;
            continue;
        }
        if event.data.get("error").is_some() {
            return Err(malformed(
                "Upstream stream ended without response.completed.",
            ));
        }
        if let Some(value) = event.data.get("usage") {
            usage = Some(value.clone());
        }
        for choice in event.data["choices"].as_array().into_iter().flatten() {
            let delta = &choice["delta"];
            if let Some(s) = delta["content"].as_str() {
                text.push_str(s)
            }
            if let Some(s) = delta["refusal"].as_str() {
                refusal.push_str(s)
            }
            for call in delta["tool_calls"].as_array().into_iter().flatten() {
                let index = call["index"].as_u64().unwrap_or(0);
                let row = calls.entry(index).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                if let Some(id) = call.get("id") {
                    row["id"] = id.clone();
                }
                if let Some(name) = call["function"].get("name") {
                    row["function"]["name"] = name.clone();
                }
                if let Some(args) = call["function"]["arguments"].as_str() {
                    let previous = row["function"]["arguments"].as_str().unwrap_or("");
                    row["function"]["arguments"] = json!(format!("{previous}{args}"));
                }
            }
        }
    }
    if !complete {
        return Err(malformed("Upstream Chat stream ended without sentinel."));
    }
    let mut message = json!({"role":"assistant","content":if text.is_empty()&&(!calls.is_empty()||!refusal.is_empty()){Value::Null}else{json!(text)}});
    if !refusal.is_empty() {
        message["refusal"] = json!(refusal);
    }
    let finish = if calls.is_empty() {
        "stop"
    } else {
        "tool_calls"
    };
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls.into_values().collect::<Vec<_>>());
    }
    let mut body = json!({"id":plan.response_id,"object":"chat.completion","created":plan.created_at,"model":plan.model,"choices":[{"index":0,"message":message,"finish_reason":finish}]});
    if let Some(usage) = usage {
        body["usage"] = usage;
    }
    Ok(body)
}

pub(crate) fn native_response_id(id: &str, fallback: &str) -> String {
    let clean = id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(40)
        .collect::<String>();
    if clean.is_empty() {
        fallback.into()
    } else {
        format!("resp_{clean}")
    }
}
