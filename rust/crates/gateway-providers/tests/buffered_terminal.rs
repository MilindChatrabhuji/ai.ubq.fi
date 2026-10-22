use gateway_core::{lifecycle::SemanticTerminal, provider::UpstreamProvider};
use gateway_providers::*;
use serde_json::{Value, json};

fn plan(stream: bool) -> DecodePlan {
    DecodePlan {
        provider: UpstreamProvider::ChatgptCodex,
        surface: ClientSurface::Responses,
        decode: ResponseDecode::Responses,
        model: "fixture-model".into(),
        upstream_model: "fixture-model".into(),
        response_id: "resp_fixture".into(),
        created_at: 1,
        stream,
        request: gateway_core::source_json::SourceJson::from_serializable(&json!({})).unwrap(),
        tool_names: ToolMap::new(),
        reasoning_summary: None,
    }
}
fn headers() -> Headers {
    Headers::from([("content-type".into(), "text/event-stream".into())])
}
fn frames(events: &[Value]) -> Vec<u8> {
    events
        .iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect::<String>()
        .into_bytes()
}
fn completed() -> Value {
    json!({"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}})
}

#[test]
fn buffered_error_only_retains_source502_envelope_and_error_settlement() {
    let error = json!({"type":"error","code":"provider_busy","message":"Try again later."});
    let decoded = decode_response(&plan(false), 200, &headers(), &frames(&[error])).unwrap();
    assert_eq!(decoded.status, 502);
    assert_eq!(
        scalar(&decoded.body),
        json!({"error":{"message":"Try again later.","type":"invalid_request_error","code":"provider_busy"}})
    );
    assert_eq!(decoded.terminal, Some(SemanticTerminal::Error));
    assert_eq!(decoded.events.len(), 1);
    assert_eq!(scalar(&decoded.events[0].data)["type"], "error");
    assert_eq!(decoded.headers["Content-Type"], "application/json");
    assert!(decoded.usage.is_none());
}

#[test]
fn created_before_error_is_not_misreported_as_completed_response() {
    let created = json!({"type":"response.created","response":{"id":"resp_fixture","status":"in_progress","output":[]}});
    let error = json!({"type":"error","message":"Terminal failure.","code":"failed"});
    let decoded = decode_response(
        &plan(false),
        200,
        &headers(),
        &frames(&[created, error, completed()]),
    )
    .unwrap();
    assert_eq!(decoded.status, 502);
    assert_eq!(decoded.terminal, Some(SemanticTerminal::Error));
    assert_eq!(
        scalar(&decoded.body)["error"]["message"],
        "Terminal failure."
    );
    assert_eq!(decoded.events.len(), 2);
}

#[test]
fn streaming_flat_and_nested_errors_preserve_actual_events_and_original_status() {
    for error in [
        json!({"type":"error","code":"capacity","message":"Capacity unavailable.","future":{"retained":true}}),
        json!({"type":"error","error":{"code":"upstream_error","message":"Nested failure.","type":"server_error"}}),
    ] {
        let decoded = decode_response(
            &plan(true),
            200,
            &headers(),
            &frames(std::slice::from_ref(&error)),
        )
        .unwrap();
        assert_eq!(decoded.status, 200);
        assert_eq!(decoded.terminal, Some(SemanticTerminal::Error));
        assert_eq!(decoded.body, decoded.events[0].data);
        for (key, value) in error.as_object().unwrap() {
            assert_eq!(scalar(&decoded.body)[key], *value);
        }
        assert_eq!(decoded.headers["Content-Type"], "text/event-stream");
    }
}

#[test]
fn source_default_error_fields_are_used_for_buffered_nested_terminal() {
    let error = json!({"type":"error","error":{"message":"nested","code":"nested"}});
    let decoded = decode_response(
        &plan(false),
        200,
        &headers(),
        &frames(std::slice::from_ref(&error)),
    )
    .unwrap();
    assert_eq!(decoded.status, 502);
    assert_eq!(decoded.terminal, Some(SemanticTerminal::Error));
    assert_eq!(
        scalar(&decoded.body),
        json!({"error":{"message":"Upstream Responses stream ended unexpectedly.","type":"invalid_request_error","code":"server_error"}})
    );
    assert_eq!(scalar(&decoded.events[0].data)["error"], error["error"]);
}

#[test]
fn truncated_or_missing_terminal_still_fails_closed() {
    let delta = frames(&[
        json!({"type":"response.output_text.delta","response_id":"resp_fixture","delta":"partial"}),
    ]);
    for bytes in [delta, b"data: {\"type\":\"error\"".to_vec()] {
        let error = decode_response(&plan(false), 200, &headers(), &bytes).unwrap_err();
        assert_eq!(error.status, 502);
    }
}

#[test]
fn first_completed_terminal_survives_a_later_error_in_both_client_modes() {
    for stream in [false, true] {
        let terminal = completed();
        let bytes = frames(&[
            terminal.clone(),
            json!({"type":"error","code":"late","message":"ignored after completion"}),
        ]);
        let decoded = decode_response(&plan(stream), 200, &headers(), &bytes).unwrap();
        assert_eq!(decoded.status, 200);
        assert_eq!(decoded.terminal, Some(SemanticTerminal::Completed));
        assert_eq!(scalar(&decoded.body), terminal["response"]);
        assert_eq!(decoded.events.len(), 1);
        assert_eq!(decoded.usage, terminal["response"].get("usage").cloned());
    }
}

fn scalar(value: &gateway_core::source_json::SourceJson) -> serde_json::Value {
    value
        .deserialize()
        .expect("This frozen regression fixture has scalar text")
}

#[test]
fn successful_codex_without_media_type_uses_strict_sse_in_both_client_modes() {
    let terminal = completed();
    for stream in [false, true] {
        let plan = plan(stream);
        assert!(response::is_event_stream(
            plan.provider,
            200,
            &Headers::new()
        ));
        let decoded = decode_response(
            &plan,
            200,
            &Headers::new(),
            &frames(std::slice::from_ref(&terminal)),
        )
        .unwrap();
        assert_eq!(decoded.status, 200);
        assert_eq!(decoded.terminal, Some(SemanticTerminal::Completed));
        assert_eq!(scalar(&decoded.body), terminal["response"]);
        assert_eq!(decoded.usage, terminal["response"].get("usage").cloned());
        assert_eq!(decoded.events.len(), 1);
        assert_eq!(
            decoded.headers["Content-Type"],
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            }
        );
    }
}

#[test]
fn absent_codex_media_type_never_accepts_non_sse_or_missing_terminal_as_completion() {
    let partial = frames(&[
        json!({"type":"response.output_text.delta","response_id":"resp_fixture","delta":"partial"}),
    ]);
    for stream in [false, true] {
        for bytes in [
            b"<html>not an SSE response</html>".as_slice(),
            b"data: {\"type\":\"response.completed\"",
            &partial,
        ] {
            let error = decode_response(&plan(stream), 200, &Headers::new(), bytes).unwrap_err();
            assert_eq!(error.status, 502);
        }
        let error = json!({"type":"error","code":"provider_busy","message":"Still refused."});
        let decoded =
            decode_response(&plan(stream), 200, &Headers::new(), &frames(&[error])).unwrap();
        assert_eq!(decoded.terminal, Some(SemanticTerminal::Error));
        assert!(decoded.usage.is_none());
        assert_eq!(decoded.status, if stream { 200 } else { 502 });
    }
}

#[test]
fn missing_media_type_is_inferred_only_for_successful_fixed_codex_protocol() {
    for status in [199, 300, 400, 403, 429, 500] {
        assert!(!response::is_event_stream(
            UpstreamProvider::ChatgptCodex,
            status,
            &Headers::new()
        ));
    }
    for provider in [
        UpstreamProvider::Openrouter,
        UpstreamProvider::Surplus,
        UpstreamProvider::Cerebras,
    ] {
        assert!(!response::is_event_stream(provider, 200, &Headers::new()));
    }
    let json_headers = Headers::from([("Content-Type".into(), "application/json".into())]);
    assert!(!response::is_event_stream(
        UpstreamProvider::ChatgptCodex,
        200,
        &json_headers
    ));
    let body = br#"{"error":{"code":"quota_exhausted","message":"unchanged"}}"#;
    let decoded = decode_response(&plan(true), 429, &Headers::new(), body).unwrap();
    assert_eq!(decoded.status, 429);
    assert_eq!(decoded.raw_body, Some(body.to_vec()));
    assert_eq!(decoded.terminal, Some(SemanticTerminal::Error));
}
