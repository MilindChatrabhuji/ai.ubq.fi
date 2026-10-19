//! Source-specific final transport adaptations shared by buffered decoders.
use crate::types::*;
use gateway_core::{lifecycle::SemanticTerminal, provider::UpstreamProvider};
use serde_json::{Value, json};
pub const CLAUDE_ATTRIBUTION: &str = "You are Claude Code, Anthropic's official CLI for Claude.";
pub fn claude_native_transport(body: &mut Value, options: &PrepareOptions) {
    if let Some(object) = body.as_object_mut() {
        object.remove("prompt_cache_key");
    }
    if !options.auth.api_key {
        let system = body
            .get("system")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut attributed = vec![json!({"type":"text","text":CLAUDE_ATTRIBUTION})];
        attributed.extend(system);
        body["system"] = json!(attributed);
    }
}
pub fn buffered_chat_events(completion: &Value, plan: &DecodePlan) -> Vec<ProviderEvent> {
    let mut choices = vec![];
    let mut finishes = vec![];
    for (position, choice) in completion["choices"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let index = choice["index"].as_u64().unwrap_or(position as u64);
        let mut delta = choice["message"].clone();
        if let Some(calls) = delta["tool_calls"].as_array_mut() {
            for (index, call) in calls.iter_mut().enumerate() {
                call["index"] = json!(index);
            }
        }
        choices.push(json!({"index":index,"delta":delta,"finish_reason":null}));
        finishes.push(json!({"index":index,"delta":{},"finish_reason":choice["finish_reason"]}));
    }
    let base = |choices: Value| {
        crate::source::object(vec![
            (
                "id",
                crate::source::generated(
                    &completion
                        .get("id")
                        .cloned()
                        .unwrap_or(json!(plan.response_id)),
                ),
            ),
            ("object", crate::source::text("chat.completion.chunk")),
            (
                "created",
                crate::source::generated(
                    &completion
                        .get("created")
                        .cloned()
                        .unwrap_or(json!(plan.created_at)),
                ),
            ),
            ("model", crate::source::quoted(plan.model.as_js_string())),
            ("choices", crate::source::generated(&choices)),
        ])
    };
    let mut events = vec![
        ProviderEvent::chat_source(base(json!(choices))),
        ProviderEvent::chat_source(base(json!(finishes))),
    ];
    if crate::source::boolean(&crate::source::path(
        &plan.request,
        &["stream_options", "include_usage"],
    )) == Some(true)
        && let Some(usage) = completion.get("usage")
    {
        let mut chunk = base(json!([]));
        crate::source::set(&mut chunk, "usage", crate::source::generated(usage));
        events.push(ProviderEvent::chat_source(chunk));
    }
    events.push(ProviderEvent::chat(json!("[DONE]")));
    events
}
pub fn lithos_stream_refusal(
    plan: &DecodePlan,
    status: u16,
    headers: &Headers,
    value: &Value,
) -> Option<DecodedResponse> {
    if plan.provider != UpstreamProvider::Lithos || !plan.stream || status != 429 {
        return None;
    }
    let detail = value
        .get("error")
        .filter(|v| v.is_object())
        .unwrap_or(value);
    let message = detail["message"]
        .as_str()
        .unwrap_or("Upstream refused the streaming request.");
    let code = detail["code"]
        .as_str()
        .or_else(|| detail["type"].as_str())
        .unwrap_or("lithos_upstream_error");
    let mut output_headers = headers.clone();
    output_headers.insert("Content-Type".into(), "text/event-stream".into());
    output_headers.insert("x-uos-upstream".into(), "lithos".into());
    let event = if plan.surface == ClientSurface::Chat {
        ProviderEvent::chat(
            json!({"error":{"message":message,"type":"server_error","code":code,"param":null}}),
        )
    } else {
        let mut response = crate::writer::envelope(plan, "failed");
        crate::source::set(
            &mut response,
            "error",
            crate::source::generated(&json!({"code":code,"message":message})),
        );
        crate::source_echo::response_event("response.failed", response)
    };
    Some(DecodedResponse {
        status: 200,
        headers: output_headers,
        body: crate::source::generated(value),
        events: vec![event],
        terminal: Some(SemanticTerminal::Failed),
        usage: None,
        native_replay: None,
        raw_body: None,
    })
}
/// Native Messages stop vocabulary has its own error identity, distinct from Chat finish reasons.
pub fn native_stop_error(events: &mut [ProviderEvent], reason: &str) {
    if let Some(last) = events.last_mut() {
        let mut response = crate::source::get(&last.data, "response");
        if crate::source::is(&crate::source::get(&response, "status"), "failed")
            && crate::source::control(&crate::source::path(&response, &["error", "code"]))
                .is_some_and(|code| code.starts_with("unrecognized_finish_reason:"))
        {
            crate::source::set(
                &mut response,
                "error",
                crate::source::generated(
                    &json!({"code":"anthropic_unrecognized_stop_reason","message":format!("Anthropic Messages stopped with reason {reason}.")}),
                ),
            );
            crate::source::set(&mut last.data, "response", response);
        }
    }
}
