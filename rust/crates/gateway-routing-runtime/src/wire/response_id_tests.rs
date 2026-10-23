use super::*;
use crate::types::direct_credential;
use gateway_auth::{AuthMethod, AuthPrincipal, crypto::Secret};
use gateway_core::identity::{PrincipalId, RequestContext, RequestId};
use gateway_providers::{
    ClaudeBodyOptions, ClaudeCredentialKind, Headers, PrepareOptions, ResponseDecode,
    StreamDecoder, decode_response,
    response::{response_plan, translated_response_id},
};
use gateway_schema::catalog::CatalogInput;
use serde_json::{Value, json};

fn parse(value: Value) -> SourceJson {
    SourceJson::from_serializable(&value).unwrap()
}
fn scalar(value: &SourceJson) -> Value {
    value.deserialize().unwrap()
}
fn request(model: &str, stream: bool) -> RoutingInput {
    RoutingInput {
        context: RequestContext {
            request_id: RequestId("response-id-fixture".into()),
            principal: PrincipalId("synthetic".into()),
            key_id: None,
            route: "responses".into(),
            started_at_ms: 1_800_000_000_000,
        },
        principal: AuthPrincipal {
            token: None,
            method: AuthMethod::Disabled,
            is_admin: false,
            is_super_admin: false,
        },
        raw: parse(
            json!({"model":model,"input":"producer é😀","stream":stream,"tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{}}},{"type":"custom","name":"apply_patch"}]}),
        ),
        surface: ClientSurface::Responses,
        catalog: CatalogInput::default(),
        runtime: None,
        client_version: "0.163.0".into(),
        native_session_id: None,
        retry_prohibited: false,
    }
}
fn prepared(provider: UpstreamProvider, model: &str, stream: bool) -> PreparedWireRequest {
    let input = request(model, stream);
    let published = direct_credential(provider, &Secret::new("synthetic-only".into()));
    prepare(
        &input,
        "fixture-conversation",
        input.context.started_at_ms,
        provider,
        &model.into(),
        &published,
        &"a".repeat(64),
    )
    .unwrap()
}
fn headers(values: &[(&str, &str)]) -> Headers {
    values
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect()
}
fn completion(request: &PreparedWireRequest, id: &str) -> Value {
    let body = scalar(request.body());
    json!({"id":id,"object":"chat.completion","created":1_800_000_000,"model":request.decode().upstream_model,
        "choices":[{"index":0,"message":{"role":"assistant","content":"replay answer 😀","reasoning_content":"replay thought é","tool_calls":[
            {"id":"call_lookup","type":"function","function":{"name":body["tools"][0]["function"]["name"],"arguments":"{\"query\":\"kept😀\"}"}},
            {"id":"call_patch","type":"function","function":{"name":body["tools"][1]["function"]["name"],"arguments":"{\"input\":\"*** Begin Patch\\nfixture😀\\n*** End Patch\"}"}}
        ]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}})
}
fn decode(
    request: &PreparedWireRequest,
    response_headers: &Headers,
    value: &Value,
) -> gateway_providers::DecodedResponse {
    decode_response(
        request.decode(),
        200,
        response_headers,
        &serde_json::to_vec(value).unwrap(),
    )
    .unwrap()
}
fn codex_replay(output: &Value) -> Value {
    let mut history = output.as_array().unwrap().clone();
    history.extend([
        json!({"type":"function_call_output","call_id":"call_lookup","output":"lookup result é😀"}),
        json!({"type":"custom_tool_call_output","call_id":"call_patch","output":"patch result 😀"}),
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"next"}]}),
    ]);
    let original = parse(json!({"model":"gpt-test","input":history}));
    let snapshot = original.clone();
    let result = prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &original,
        &"gpt-test".into(),
        &PrepareOptions {
            auth: gateway_providers::AuthMaterial {
                secret: "synthetic-only".into(),
                account_id: Some("synthetic-account".into()),
                ..Default::default()
            },
            conversation_id: Some("fixture-conversation".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(original, snapshot);
    scalar(&result.body)["input"].clone()
}

#[test]
fn both_real_wire_factories_bound_and_clean_the_random_fallback() {
    let expected = format!("resp_{}", "a".repeat(40));
    for (provider, model) in [
        (UpstreamProvider::Deepseek, "deepseek-flash"),
        (UpstreamProvider::Lithos, "deepseek-ai/DeepSeek-V4.1-Flash"),
        (UpstreamProvider::Cerebras, "qwen-3.8-27b"),
    ] {
        assert_eq!(
            prepared(provider, model, false).decode().response_id,
            expected
        );
    }
    let mut input = request("claude-sonnet-4-6", false);
    set(&mut input.raw, "tools", parse(json!([]))).unwrap();
    let phase = claude_ordinary(
        &input,
        &"claude-sonnet-4-6".into(),
        input.context.started_at_ms,
    )
    .unwrap();
    let published = PublishedCredential::Claude {
        fence: CredentialFence::Claude {
            account_id: "fixture".into(),
            cohort_id: "fixture".into(),
            credential_fingerprint: "fixture".into(),
            evidence_generation: "fixture".into(),
            workspace_id: None,
            checks: vec![],
        },
        body_options: {
            let mut options = ClaudeBodyOptions::new(ClaudeCredentialKind::ApiKey);
            options.native_reasoning_efforts = Some(vec!["medium".into()]);
            options.supports_disabled_thinking = true;
            options
        },
    };
    let wire = finalize_claude(
        &input,
        &published,
        &phase,
        &"a".repeat(64),
        input.context.started_at_ms,
    )
    .unwrap();
    assert_eq!(wire.decode().response_id, expected);
    assert_eq!(
        translated_response_id("--uuid_-ABC é😀!123--"),
        "resp_uuidABC123"
    );
}

#[test]
fn actual_producer_ids_round_trip_through_the_unchanged_codex_cleanup() {
    for (provider, model) in [
        (UpstreamProvider::Deepseek, "deepseek-flash"),
        (UpstreamProvider::Lithos, "deepseek-ai/DeepSeek-V4.1-Flash"),
        (UpstreamProvider::Cerebras, "qwen-3.8-27b"),
    ] {
        let request = prepared(provider, model, false);
        let response = decode(
            &request,
            &headers(&[("x-request-id", "provider-request-123")]),
            &completion(&request, "completion-body-id"),
        );
        let body = scalar(&response.body);
        let output = &body["output"];
        assert_eq!(
            output
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["reasoning", "message", "function_call", "custom_tool_call"]
        );
        for item in output.as_array().unwrap() {
            let id = item["id"].as_str().unwrap();
            assert!(id.contains(body["id"].as_str().unwrap()));
        }
        let replay = codex_replay(output);
        let replay = replay.as_array().unwrap();
        assert_eq!(
            replay
                .iter()
                .map(|v| v["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "message",
                "function_call",
                "custom_tool_call",
                "function_call_output",
                "custom_tool_call_output",
                "message"
            ]
        );
        assert!(replay[..3].iter().all(|item| item.get("id").is_none()));
        assert_eq!(replay[0]["content"][0]["text"], "replay answer 😀");
        assert_eq!(replay[1]["call_id"], "call_lookup");
        assert_eq!(replay[1]["arguments"], "{\"query\":\"kept😀\"}");
        assert_eq!(replay[2]["call_id"], "call_patch");
        assert_eq!(
            replay[2]["input"],
            "*** Begin Patch\nfixture😀\n*** End Patch"
        );
        assert_eq!(replay[3]["output"], "lookup result é😀");
        assert_eq!(replay[4]["output"], "patch result 😀");
    }
}

#[test]
fn literal_long_unrecognized_and_encrypted_reasoning_are_still_not_dropped() {
    let prefix = format!("resp_{}", "a".repeat(40));
    let output = json!([
        {"type":"reasoning","id":format!("rs_{prefix}_0"),"summary":[]},
        {"type":"reasoning","id":format!("rs_{prefix}_1"),"encrypted_content":"synthetic-opaque","summary":[]},
        {"type":"reasoning","id":format!("rs_resp_{}_0","b".repeat(64)),"summary":[]},
        {"type":"reasoning","id":"rs_genuine_abcdef","summary":[]}
    ]);
    let replay = codex_replay(&output);
    assert_eq!(replay.as_array().unwrap().len(), 6);
    assert_eq!(replay[0]["encrypted_content"], "synthetic-opaque");
    assert!(replay[0].get("id").is_none());
    assert_eq!(replay[1]["id"], format!("rs_resp_{}_0", "b".repeat(64)));
    assert_eq!(replay[2]["id"], "rs_genuine_abcdef");
}

#[test]
fn first_present_provider_header_is_validated_before_any_fallback() {
    for (provider, model, names) in [
        (
            UpstreamProvider::Deepseek,
            "deepseek-flash",
            ["x-request-id", "x-ds-request-id", "x-deepseek-request-id"],
        ),
        (
            UpstreamProvider::Cerebras,
            "qwen-3.8-27b",
            ["x-request-id", "x-api-request-id", "x-cerebras-request-id"],
        ),
    ] {
        let request = prepared(provider, model, false);
        let fallback = &request.decode().response_id;
        assert_eq!(
            response_plan(
                request.decode(),
                &headers(&[
                    (names[2], "third"),
                    (names[1], "second"),
                    (names[0], "First-ABC_123")
                ])
            )
            .response_id,
            "resp_FirstABC123"
        );
        for bad in ["", " has-space", "invalid value", "é", "line\nbreak"] {
            assert_eq!(
                response_plan(
                    request.decode(),
                    &headers(&[(names[0], bad), (names[1], "later-valid")])
                )
                .response_id,
                *fallback
            );
        }
        assert_eq!(
            response_plan(
                request.decode(),
                &headers(&[(names[0], &"x".repeat(257)), (names[1], "later-valid")])
            )
            .response_id,
            *fallback
        );
        assert_eq!(
            response_plan(request.decode(), &headers(&[(names[1], "Second-ABC")])).response_id,
            "resp_SecondABC"
        );
        assert_eq!(
            response_plan(
                request.decode(),
                &headers(&[("X-REQUEST-ID", &"b".repeat(256))])
            )
            .response_id,
            format!("resp_{}", "b".repeat(40))
        );
        assert_eq!(
            response_plan(request.decode(), &headers(&[(names[0], "!!!")])).response_id,
            "resp_"
        );
    }
    let lithos = prepared(
        UpstreamProvider::Lithos,
        "deepseek-ai/DeepSeek-V4.1-Flash",
        false,
    );
    assert_eq!(
        response_plan(lithos.decode(), &headers(&[("x-request-id", "ignored")])).response_id,
        lithos.decode().response_id
    );
}

#[test]
fn buffered_completion_identity_precedence_matches_the_source() {
    let cerebras = prepared(UpstreamProvider::Cerebras, "qwen-3.8-27b", true);
    let body = completion(&cerebras, "completion-fallback-ABC");
    let bound = decode(&cerebras, &Headers::new(), &body);
    assert_eq!(scalar(&bound.body)["id"], "resp_completionfallbackABC");
    assert!(
        bound
            .events
            .iter()
            .all(|e| !e.data.as_str().contains(&cerebras.decode().response_id))
    );
    assert_eq!(
        scalar(
            &decode(
                &cerebras,
                &headers(&[("x-request-id", "header-wins")]),
                &body
            )
            .body
        )["id"],
        "resp_headerwins"
    );
    let deepseek = prepared(UpstreamProvider::Deepseek, "deepseek-flash", false);
    assert_eq!(
        scalar(
            &decode(
                &deepseek,
                &Headers::new(),
                &completion(&deepseek, "body-must-not-win")
            )
            .body
        )["id"],
        deepseek.decode().response_id
    );
    let mut claude = deepseek.decode().clone();
    claude.decode = ResponseDecode::AnthropicChatToResponses;
    claude.provider = UpstreamProvider::Surplus;
    claude.tool_names = Default::default();
    let body = json!({"id":"chatcmpl_native-ABC","object":"chat.completion","created":1_800_000_000,"model":"claude-sonnet-4-6","choices":[{"message":{"role":"assistant","content":"native"},"finish_reason":"stop"}]});
    let decoded = decode_response(
        &claude,
        200,
        &headers(&[("x-request-id", "header-not-buffered")]),
        &serde_json::to_vec(&body).unwrap(),
    )
    .unwrap();
    assert_eq!(scalar(&decoded.body)["id"], "resp_chatcmplnativeABC");
    assert_eq!(
        response_plan(&claude, &headers(&[("x-request-id", "header-streamed")])).response_id,
        "resp_headerstreamed"
    );
}

#[test]
fn real_stream_and_buffer_translation_use_the_same_bound_plan_identity() {
    for (provider, model) in [
        (UpstreamProvider::Deepseek, "deepseek-flash"),
        (UpstreamProvider::Lithos, "deepseek-ai/DeepSeek-V4.1-Flash"),
    ] {
        let request = prepared(provider, model, true);
        let h = headers(&[("x-request-id", "same-header-ABC")]);
        let plan = response_plan(request.decode(), &h);
        let buffered = decode(&request, &h, &completion(&request, "completion-id"));
        let completion = completion(&request, "completion-id");
        let message = &completion["choices"][0]["message"];
        let mut delta = message.clone();
        for (index, call) in delta["tool_calls"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            call["index"] = json!(index);
        }
        let chunk = json!({"id":"chatcmpl_stream-ignored","choices":[{"index":0,"delta":delta,"finish_reason":"tool_calls"}],"usage":completion["usage"]});
        let frame = format!("data: {chunk}\n\ndata: [DONE]\n\n");
        let mut stream = StreamDecoder::new(plan.clone());
        let mut events = stream.push(frame.as_bytes()).unwrap();
        events.extend(stream.finish().unwrap());
        let terminal = events
            .iter()
            .find(|e| e.type_name().as_deref() == Some("response.completed"))
            .unwrap();
        let terminal = scalar(&terminal.data);
        assert_eq!(terminal["response"]["id"], scalar(&buffered.body)["id"]);
        for event in events {
            let data = scalar(&event.data);
            if let Some(id) = data.get("item_id").and_then(Value::as_str) {
                assert!(id.contains(&plan.response_id));
            }
        }
    }
}

#[test]
fn native_responses_and_original_chat_ids_are_not_relabelled() {
    let request = prepared(UpstreamProvider::Deepseek, "deepseek-flash", false);
    for mode in [
        ResponseDecode::Responses,
        ResponseDecode::ResponsesToChat,
        ResponseDecode::Chat,
    ] {
        let mut plan = request.decode().clone();
        plan.decode = mode;
        assert_eq!(
            response_plan(&plan, &headers(&[("x-request-id", "must-not-relabel")])).response_id,
            plan.response_id
        );
    }
    let mut plan = request.decode().clone();
    plan.provider = UpstreamProvider::ChatgptCodex;
    plan.decode = ResponseDecode::Responses;
    let body = json!({"id":"resp_original_native_ABCDEFGHIJKLMNOPQRSTUVWXYZ","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"native"}]}]});
    let event = json!({"type":"response.completed","response":&body});
    let bytes = format!("event: response.completed\ndata: {event}\n\n");
    let decoded = decode_response(
        &plan,
        200,
        &headers(&[("x-request-id", "ignored")]),
        bytes.as_bytes(),
    )
    .unwrap();
    assert_eq!(scalar(&decoded.body)["id"], body["id"]);
}

#[test]
fn native_messages_keep_source_header_order_and_actual_message_identity() {
    let request = prepared(UpstreamProvider::Deepseek, "deepseek-flash", false);
    let mut plan = request.decode().clone();
    plan.decode = ResponseDecode::AnthropicToResponses;
    plan.provider = UpstreamProvider::ClaudeCode;
    assert_eq!(
        response_plan(
            &plan,
            &headers(&[
                ("x-request-id", "secondary"),
                ("request-id", "native-first")
            ])
        )
        .response_id,
        "resp_nativefirst"
    );
    assert_eq!(
        response_plan(
            &plan,
            &headers(&[("request-id", ""), ("x-request-id", "do-not-skip-empty")])
        )
        .response_id,
        plan.response_id
    );
    plan.provider = UpstreamProvider::Metered;
    assert_eq!(
        response_plan(
            &plan,
            &headers(&[
                ("x-api-request-id", ""),
                ("x-oneapi-request-id", "native-second"),
                ("x-request-id", "third")
            ])
        )
        .response_id,
        "resp_nativesecond"
    );
    let body = json!({"type":"message","id":"msg_native-identity_ABC","role":"assistant","content":[{"type":"text","text":"native answer"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}});
    let h = headers(&[("x-api-request-id", "initial-fallback")]);
    let decoded = decode_response(&plan, 200, &h, &serde_json::to_vec(&body).unwrap()).unwrap();
    assert_eq!(scalar(&decoded.body)["id"], "resp_msgnativeidentityABC");
    let mut stream = StreamDecoder::new(response_plan(&plan, &h));
    let mut start = body.clone();
    start["content"] = json!([]);
    start["stop_reason"] = Value::Null;
    let frames = [
        json!({"type":"message_start","message":start}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"native answer"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
        json!({"type":"message_stop"}),
    ];
    let raw = frames
        .iter()
        .map(|value| {
            format!(
                "event: {}\ndata: {value}\n\n",
                value["type"].as_str().unwrap()
            )
        })
        .collect::<String>();
    let mut events = stream.push(raw.as_bytes()).unwrap();
    events.extend(stream.finish().unwrap());
    let terminal = events
        .iter()
        .find(|e| e.type_name().as_deref() == Some("response.completed"))
        .unwrap();
    assert_eq!(
        scalar(&terminal.data)["response"]["id"],
        scalar(&decoded.body)["id"]
    );
}
