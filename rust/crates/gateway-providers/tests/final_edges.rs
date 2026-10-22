//! Additional source boundaries: dc6be2c3 Cerebras and e706 Claude/Lithos/stream contracts.
use gateway_core::provider::UpstreamProvider;
use gateway_providers::*;
use serde_json::{Value, json};
fn opts() -> PrepareOptions {
    PrepareOptions {
        auth: AuthMaterial {
            secret: "fixture".into(),
            account_id: Some("account".into()),
            ..Default::default()
        },
        response_id: "resp_edges".into(),
        created_at: 1,
        ..Default::default()
    }
}
#[test]
fn explicit_null_reasoning_length_cerebras_is502_not_an_incompletion() {
    let prepared = prepare_request(
        UpstreamProvider::Cerebras,
        ClientSurface::Responses,
        &json!({"model":"gpt-oss-120b","input":"x","max_output_tokens":1}),
        &opts(),
    )
    .unwrap();
    let body = json!({"id":"chat_1","object":"chat.completion","created":1,"model":"gpt-oss-120b","choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning":"budget used thinking"},"finish_reason":"length"}]});
    let error = decode_response(
        &prepared.decode,
        200,
        &Headers::new(),
        &serde_json::to_vec(&body).unwrap(),
    )
    .unwrap_err();
    assert_eq!(error.status, 502);
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("cerebras_upstream_invalid_response")
    );
}
#[test]
fn claude_oauth_has_native_attribution_and_console_key_does_not() {
    let raw = json!({"model":"claude-fixture","input":"x","prompt_cache_key":"reseller-affinity"});
    let oauth = prepare_request(
        UpstreamProvider::ClaudeCode,
        ClientSurface::Responses,
        &raw,
        &opts(),
    )
    .unwrap();
    assert_eq!(
        scalar(&oauth.body)["system"][0]["text"],
        "You are Claude Code, Anthropic's official CLI for Claude."
    );
    assert_eq!(scalar(&oauth.body)["max_tokens"], 32_000);
    assert!(scalar(&oauth.body).get("prompt_cache_key").is_none());
    let mut api = opts();
    api.auth.api_key = true;
    let api = prepare_request(
        UpstreamProvider::ClaudeCode,
        ClientSurface::Responses,
        &raw,
        &api,
    )
    .unwrap();
    assert!(!api.headers.contains_key("anthropic-beta"));
    assert_eq!(
        api.headers.get("x-api-key").map(String::as_str),
        Some("fixture")
    );
    assert!(!api.body.as_str().to_owned().contains("You are Claude Code"));
}
#[test]
fn buffered_cerebras_chat_client_stream_replays_real_finish_and_usage() {
    let prepared=prepare_request(UpstreamProvider::Cerebras,ClientSurface::Chat,&json!({"model":"qwen-3.8-27b","messages":[{"role":"user","content":"x"}],"stream":true,"stream_options":{"include_usage":true}}),&opts()).unwrap();
    assert_eq!(scalar(&prepared.body)["stream"], false);
    let body = json!({"id":"chat_1","object":"chat.completion","created":1,"choices":[{"index":0,"message":{"role":"assistant","content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}});
    let decoded = decode_response(
        &prepared.decode,
        200,
        &Headers::new(),
        &serde_json::to_vec(&body).unwrap(),
    )
    .unwrap();
    assert_eq!(decoded.headers["Content-Type"], "text/event-stream");
    assert_eq!(
        scalar(&decoded.events[0].data)["choices"][0]["delta"]["content"],
        "pong"
    );
    assert_eq!(
        scalar(&decoded.events[1].data)["choices"][0]["finish_reason"],
        "stop"
    );
    assert_eq!(scalar(&decoded.events[2].data)["usage"]["total_tokens"], 11);
    assert_eq!(
        scalar(&decoded.events.last().unwrap().data),
        Value::String("[DONE]".into())
    );
}
#[test]
fn lithos_header_precedence_and_streamed_final_refusal_stay_in_band() {
    let headers = Headers::from([
        ("retry-after-ms".into(), "250".into()),
        ("retry-after".into(), "2".into()),
        ("x-ratelimit-reset-tokens".into(), "1m30s".into()),
    ]);
    let wait = gateway_providers::lithos::rate_limit_wait(&headers, 0.0, |_| None).unwrap();
    assert_eq!(wait.wait_ms, 250.0);
    let headers = Headers::from([
        ("x-ratelimit-reset-tokens".into(), "3.23s".into()),
        ("x-ratelimit-reset-requests".into(), "250ms".into()),
    ]);
    assert_eq!(
        gateway_providers::lithos::rate_limit_wait(&headers, 0.0, |_| None)
            .unwrap()
            .wait_ms,
        3230.0
    );
    let prepared = prepare_request(
        UpstreamProvider::Lithos,
        ClientSurface::Responses,
        &json!({"model":"deepseek-ai/DeepSeek-V4.1-Flash","input":"x","stream":true}),
        &opts(),
    )
    .unwrap();
    let decoded = decode_response(
        &prepared.decode,
        429,
        &Headers::new(),
        br#"{"error":{"code":"tokens_exhausted","message":"wait"}}"#,
    )
    .unwrap();
    assert_eq!(decoded.status, 200);
    assert_eq!(scalar(&decoded.events[0].data)["type"], "response.failed");
    assert_eq!(
        scalar(&decoded.events[0].data)["response"]["error"]["code"],
        "tokens_exhausted"
    );
}
#[test]
fn lithos_streamed_refusal_parity_is_exposed_for_both_client_surfaces() {
    let headers = Headers::from([
        ("content-type".into(), "application/json".into()),
        ("x-should-retry".into(), "false".into()),
        ("retry-after-ms".into(), "5000".into()),
    ]);
    for (surface, body) in [
        (
            ClientSurface::Responses,
            json!({"model":"deepseek-ai/DeepSeek-V4.1-Flash","input":"x","stream":true}),
        ),
        (
            ClientSurface::Chat,
            json!({"model":"deepseek-ai/DeepSeek-V4.1-Flash","messages":[{"role":"user","content":"x"}],"stream":true}),
        ),
    ] {
        let prepared = prepare_request(UpstreamProvider::Lithos, surface, &body, &opts()).unwrap();
        assert!(gateway_providers::sse::is_lithos_stream_refusal(
            &prepared.decode,
            429
        ));
        assert!(!gateway_providers::sse::is_lithos_stream_refusal(
            &prepared.decode,
            200
        ));
        let decoded = decode_response(
            &prepared.decode,
            429,
            &headers,
            br#"{"error":{"code":"tokens_exhausted","message":"wait"}}"#,
        )
        .unwrap();
        assert_eq!(decoded.status, 200, "{surface:?}");
        assert_eq!(
            decoded.terminal,
            Some(gateway_core::lifecycle::SemanticTerminal::Failed)
        );
        assert_eq!(decoded.headers["Content-Type"], "text/event-stream");
        assert_eq!(decoded.headers["x-should-retry"], "false");
        assert_eq!(decoded.events.len(), 1);
        let event = scalar(&decoded.events[0].data);
        let code = match surface {
            ClientSurface::Responses => &event["response"]["error"]["code"],
            ClientSurface::Chat => &event["error"]["code"],
            _ => unreachable!(),
        };
        assert_eq!(code, "tokens_exhausted", "{surface:?}: {event}");
    }
}
#[test]
fn codex_error_bytes_are_available_unchanged_before_authority_classification() {
    let mut options = opts();
    options.conversation_id = Some("conversation-uuid".into());
    let request = prepare_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &json!({"model":"gpt-fixture","input":"x"}),
        &options,
    )
    .unwrap();
    let bytes = b"{ \"detail\": \"unrelated validation error\" }\n";
    let result = decode_response(&request.decode, 400, &Headers::new(), bytes).unwrap();
    assert_eq!(result.status, 400);
    assert_eq!(result.raw_body.as_deref(), Some(bytes.as_slice()));
    assert_eq!(scalar(&result.body)["detail"], "unrelated validation error");
}
#[test]
fn buffered_chat_retains_usage_without_requesting_a_stream_usage_chunk() {
    let mut options = opts();
    options.conversation_id = Some("conversation-uuid".into());
    let request = prepare_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Chat,
        &json!({"model":"gpt-fixture","messages":[{"role":"user","content":"x"}],"stream":false}),
        &options,
    )
    .unwrap();
    let event = json!({"type":"response.completed","response":{"id":"resp_fixture","created_at":1,"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"pong"}]}],"usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}});
    let bytes = format!("event: response.completed\ndata: {event}\n\n");
    let response = decode_response(
        &request.decode,
        200,
        &Headers::from([("content-type".into(), "text/event-stream".into())]),
        bytes.as_bytes(),
    )
    .unwrap();
    assert_eq!(
        scalar(&response.body)["choices"][0]["message"]["content"],
        "pong"
    );
    assert_eq!(scalar(&response.body)["usage"]["prompt_tokens"], 10);
}
#[test]
fn image_fanout_measures_every_replayed_input_byte() {
    let url = format!("https://example.test/{}", "x".repeat(14 * 1024 * 1024));
    assert!(
        gateway_providers::extras::prepare_image(
            &json!({"prompt":"edit","images":[{"image_url":url}],"n":4}),
            "gpt-fixture",
            true,
            "request"
        )
        .is_err()
    );
}

fn scalar(value: &gateway_core::source_json::SourceJson) -> serde_json::Value {
    value
        .deserialize()
        .expect("This frozen regression fixture has scalar text")
}
