//! Frozen source-derived cases from e706343d: deepseek-responses, oss-terminal-parity,
//! anthropic-responses/replay, lithos-tier-windows, images and embeddings fixtures.
use gateway_core::provider::{PaidProvider, UpstreamProvider};
use gateway_core::source_json::SourceJson;
use gateway_providers::{chat, extras, policy, replay, request, usage, *};
use serde_json::{Value, json};
fn options() -> PrepareOptions {
    PrepareOptions {
        auth: AuthMaterial {
            secret: "fixture-secret".into(),
            account_id: Some("fixture-account".into()),
            ..Default::default()
        },
        response_id: "resp_parity".into(),
        created_at: 1_780_000_000,
        ..Default::default()
    }
}
fn previous_response_options() -> PrepareOptions {
    let mut options = options();
    options.conversation_id = Some("previous-response-conversation".into());
    options.allowed_models = vec!["~openai/gpt-fixture".into()];
    options
}
fn previous_response_fixture(model: &str, previous: Option<Value>) -> Value {
    let mut raw = json!({
        "model": model,
        "max_output_tokens": 64,
        "input": [
            {"role":"user","content":[{"type":"input_text","text":"first turn"}]},
            {"role":"assistant","content":[{"type":"output_text","text":"prior answer"}]},
            {"role":"user","content":[{"type":"input_text","text":"current turn"}]}
        ]
    });
    if let Some(previous) = previous {
        raw["previous_response_id"] = previous;
    }
    raw
}
fn plan(profile: ChatProfile) -> DecodePlan {
    DecodePlan {
        provider: match profile {
            ChatProfile::Deepseek => UpstreamProvider::Deepseek,
            ChatProfile::Lithos => UpstreamProvider::Lithos,
            ChatProfile::Cerebras => UpstreamProvider::Cerebras,
            _ => UpstreamProvider::Surplus,
        },
        surface: ClientSurface::Responses,
        decode: ResponseDecode::ChatToResponses(profile),
        model: "deepseek-flash".into(),
        upstream_model: "deepseek-flash".into(),
        response_id: "resp_parity".into(),
        created_at: 1_780_000_000,
        stream: true,
        request: gateway_core::source_json::SourceJson::from_serializable(&json!({})).unwrap(),
        tool_names: ToolMap::new(),
        reasoning_summary: None,
    }
}
fn chunk(delta: Value, finish: Value) -> Value {
    json!({"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1_780_000_001,"model":"deepseek-flash","choices":[{"index":0,"delta":delta,"finish_reason":finish}]})
}
fn frame(value: &Value) -> Vec<u8> {
    format!("data: {value}\n\n").into_bytes()
}
#[test]
fn frozen_waterfalls_distinguish_quota_from_serving_failure() {
    assert!(!policy::paid_should_advance(Some(503), true));
    assert!(!policy::paid_should_advance(None, true));
    assert!(policy::paid_should_advance(Some(402), true));
    assert!(policy::paid_should_advance(Some(429), true));
    assert_eq!(
        policy::deepseek_decision(policy::HopFailure::Status(503), false),
        policy::HopDecision::Advance
    );
    assert_eq!(
        policy::deepseek_decision(policy::HopFailure::Status(503), true),
        policy::HopDecision::Deliver
    );
    assert_eq!(
        policy::deepseek_decision(policy::HopFailure::Cancelled, false),
        policy::HopDecision::Abort
    );
    assert_eq!(
        policy::deepseek_decision(policy::HopFailure::Status(400), false),
        policy::HopDecision::Deliver
    );
    assert_eq!(policy::codex_paid_fallback_reason(429, None), None);
    assert_eq!(
        policy::codex_paid_fallback_reason(429, Some("codex_quota_blocked")),
        Some("primary_quota_blocked")
    );
    assert_ne!(
        policy::paid_hop_identity("r", PaidProvider::Surplus),
        policy::paid_hop_identity("r", PaidProvider::Metered)
    );
}
#[test]
fn codex_replay_repair_is_exact_and_does_not_damage_provider_history() {
    let input = json!([{"type":"reasoning","id":"resp_old_rs_0","summary":[]},{"type":"reasoning","id":"rs_resp_old_0","encrypted_content":"signed"},{"type":"function_call","id":"fc_resp_old_0_0","call_id":"call_1","name":"lookup","arguments":"{}"},{"type":"reasoning","id":"rs_upstream","summary":[]}]);
    let repaired = scalar(&request::codex_replay_input(&input));
    assert_eq!(
        repaired,
        json!([{"type":"reasoning","encrypted_content":"signed"},{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{}"},{"type":"reasoning","id":"rs_upstream","summary":[]}])
    );
    assert_eq!(input.as_array().unwrap().len(), 4);
    let body=scalar(&request::build_codex_body(&json!({"model":"gpt-fixture","input":[],"reasoning":{"effort":"none"},"stream":false,"store":true})).unwrap());
    assert_eq!(body["reasoning"]["effort"], "none");
    assert_eq!(body["stream"], true);
    assert_eq!(body["store"], false);
}
#[test]
fn namespace_and_freeform_round_trip_keeps_identity() {
    let raw = json!({"input":"hello","reasoning":{"effort":"none"},"tools":[{"type":"namespace","name":"first","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]},{"type":"namespace","name":"second","tools":[{"type":"function","name":"read","parameters":{"type":"object"}}]},{"type":"custom","name":"apply_patch"}]});
    let result =
        chat::project_responses(&raw, "deepseek-flash", true, ChatProfile::Deepseek).unwrap();
    assert_eq!(scalar(&result.body)["tools"][0]["function"]["name"], "read");
    assert_eq!(
        scalar(&result.body)["tools"][1]["function"]["name"],
        "second_read"
    );
    assert_eq!(
        result.tool_names["read"]
            .namespace
            .as_ref()
            .map(|v| v.try_utf8().unwrap())
            .as_deref(),
        Some("first")
    );
    assert!(result.tool_names["apply_patch"].custom);
    assert_eq!(
        scalar(&result.body)["stream_options"],
        json!({"include_usage":true})
    );
    let item = gateway_providers::tools::function_item(
        "ctc_resp_1_0",
        "call_1",
        "apply_patch",
        "{\"input\":\"*** Begin Patch\"}",
        &result.tool_names,
        "completed",
    );
    assert_eq!(scalar(&item)["type"], "custom_tool_call");
    assert_eq!(scalar(&item)["input"], "*** Begin Patch");
}
#[test]
fn thinking_conflict_and_reasoning_profiles_are_provider_specific() {
    assert!(chat::project_responses(&json!({"input":"x","reasoning":{"effort":"high"},"tools":[{"type":"function","name":"a"}],"tool_choice":"required"}),"deepseek-flash",false,ChatProfile::Deepseek).is_err());
    assert!(chat::project_responses(&json!({"input":"x","reasoning":{"effort":"high"},"tools":[{"type":"function","name":"a"}],"tool_choice":"required"}),"deepseek-ai/DeepSeek-V4.1-Flash",false,ChatProfile::Lithos).is_ok());
    assert_eq!(
        chat::project_effort("ultra", ChatProfile::Deepseek).unwrap(),
        "max"
    );
    assert_eq!(
        chat::project_effort("vendor-new", ChatProfile::Deepseek).unwrap(),
        "vendor-new"
    );
    assert!(chat::project_effort("ultra", ChatProfile::Lithos).is_err());
}
#[test]
fn declared_payload_bound_keeps_unicode_and_disabled_rejects() {
    let text = "😀".repeat(20_000);
    let result = chat::project_responses(
        &json!({"input":text}),
        "deepseek-flash",
        false,
        ChatProfile::Deepseek,
    )
    .unwrap();
    let scalar_body = scalar(&result.body);
    let forwarded = scalar_body["messages"][0]["content"].as_str().unwrap();
    assert!(forwarded.len() <= 65_536);
    assert!(forwarded.contains("the model did not receive the elided bytes"));
    assert!(!result.elisions.is_empty());
    assert!(
        chat::project_responses(
            &json!({"input":"😀".repeat(20_000),"truncation":"disabled"}),
            "deepseek-flash",
            false,
            ChatProfile::Deepseek
        )
        .is_err()
    );
}
#[test]
fn reasoning_closes_before_text_and_fragmented_tools_keep_announced_indexes() {
    let mut writer = gateway_providers::writer::ResponseWriter::new(plan(ChatProfile::Deepseek));
    let mut events = writer.chat_chunk(
        &chunk(json!({"reasoning_content":"think"}), Value::Null),
        ChatProfile::Deepseek,
    );
    events.extend(writer.chat_chunk(
        &chunk(json!({"content":"answer"}), Value::Null),
        ChatProfile::Deepseek,
    ));
    events.extend(writer.finish());
    let kinds = events
        .iter()
        .map(|e| e.type_name().unwrap())
        .collect::<Vec<_>>();
    let done = kinds
        .iter()
        .position(|k| *k == "response.output_item.done")
        .unwrap();
    let message = events
        .iter()
        .position(|e| {
            scalar(&e.data)["type"] == "response.output_item.added"
                && scalar(&e.data)["item"]["type"] == "message"
        })
        .unwrap();
    assert!(done < message);
    assert_eq!(
        scalar(&events.last().unwrap().data)["response"]["output"][0]["type"],
        "reasoning"
    );
    assert_eq!(
        scalar(&events.last().unwrap().data)["response"]["output"][1]["type"],
        "message"
    );
    let mut writer = gateway_providers::writer::ResponseWriter::new(plan(ChatProfile::Deepseek));
    writer.tool_delta(1, Some("call_b"), Some("second"), "{\"b\":");
    writer.tool_delta(0, Some("call_a"), Some("first"), "{\"a\":");
    writer.tool_delta(1, None, None, "2}");
    writer.tool_delta(0, None, None, "1}");
    let events = writer.finish();
    let output = &scalar(&events.last().unwrap().data)["response"]["output"];
    assert_eq!(output[0]["name"], "second");
    assert_eq!(output[0]["arguments"], "{\"b\":2}");
    assert_eq!(output[1]["name"], "first");
    assert!(writer.finish().is_empty());
}
#[test]
fn truthful_terminals_distinguish_explicit_truncation_and_empty_stop() {
    let mut writer = gateway_providers::writer::ResponseWriter::new(plan(ChatProfile::Deepseek));
    writer.reasoning("only reasoning");
    let events = writer.finish();
    assert_eq!(
        scalar(&events.last().unwrap().data)["type"],
        "response.failed"
    );
    assert_eq!(
        scalar(&events.last().unwrap().data)["response"]["error"]["code"],
        "empty_upstream_completion"
    );
    let mut writer = gateway_providers::writer::ResponseWriter::new(plan(ChatProfile::Deepseek));
    writer.reasoning("only reasoning");
    writer.finish_reason = Some("length".into());
    let events = writer.finish();
    assert_eq!(
        scalar(&events.last().unwrap().data)["type"],
        "response.incomplete"
    );
    assert_eq!(
        scalar(&events.last().unwrap().data)["response"]["incomplete_details"]["reason"],
        "max_output_tokens"
    );
}
#[test]
fn sse_incremental_utf8_mixed_line_endings_and_eof_fail_closed() {
    let mut parser = gateway_providers::sse::SseParser::new(1000);
    let raw = "event: thing\r\ndata: {\"text\":\"😀\"}\r\n\r\n".as_bytes();
    let mut frames = vec![];
    for byte in raw {
        frames.extend(parser.push(&[*byte]).unwrap());
    }
    assert_eq!(frames.len(), 1);
    assert_eq!(
        serde_json::from_str::<Value>(&frames[0].data).unwrap()["text"],
        "😀"
    );
    let mut decoder = StreamDecoder::new(plan(ChatProfile::Deepseek));
    decoder
        .push(&frame(&chunk(
            json!({"reasoning_content":"thought"}),
            Value::Null,
        )))
        .unwrap();
    assert!(decoder.finish().is_err());
    let mut decoder = StreamDecoder::new(plan(ChatProfile::Deepseek));
    let mut events = decoder
        .push(&frame(&chunk(json!({"content":"answer"}), json!("stop"))))
        .unwrap();
    events.extend(decoder.push(b"data: [DONE]\n\n").unwrap());
    assert_eq!(
        scalar(&events.last().unwrap().data)["type"],
        "response.completed"
    );
    decoder.finish().unwrap();
}
#[test]
fn usage_preserves_missingness_and_native_cache_gross_input() {
    let missing = usage::chat_to_responses(
        &json!({"prompt_tokens":10,"completion_tokens":4}),
        ChatProfile::Deepseek,
    )
    .unwrap();
    assert!(missing.get("input_tokens_details").is_none());
    assert!(missing.get("output_tokens_details").is_none());
    let native=usage::anthropic_to_responses(&json!({"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"buyer_cost_micro":17})).unwrap();
    assert_eq!(native["input_tokens"], 35);
    assert_eq!(native["total_tokens"], 39);
    assert_eq!(native["input_tokens_details"]["cached_tokens"], 20);
    assert_eq!(native["buyer_cost_micro"], 17);
    let invalid = usage::anthropic_to_responses(
        &json!({"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":-1}),
    )
    .unwrap();
    assert!(invalid["input_tokens"].is_null());
    assert!(invalid["input_tokens_details"]["cached_tokens"].is_null());
}
#[test]
fn transport_profiles_cerebras_and_openrouter_preserve_actual_wires() {
    let cerebras=prepare_request(UpstreamProvider::Cerebras,ClientSurface::Chat,&json!({"model":"qwen-3.8-27b","messages":[{"role":"developer","content":"a"},{"role":"system","content":"b"},{"role":"user","content":"x"}],"stream":true,"store":null,"metadata":null}),&options()).unwrap();
    assert_eq!(scalar(&cerebras.body)["stream"], false);
    assert_eq!(
        scalar(&cerebras.body)["messages"][0],
        json!({"role":"system","content":"a\n\nb"})
    );
    assert!(scalar(&cerebras.body).get("store").is_none());
    assert!(scalar(&cerebras.body).get("metadata").is_none());
    let mut opts = options();
    opts.allowed_models = vec!["~openai/gpt-fixture".into()];
    let request = prepare_request(
        UpstreamProvider::Openrouter,
        ClientSurface::Responses,
        &json!({"model":"~openai/gpt-fixture","input":"x"}),
        &opts,
    )
    .unwrap();
    assert_eq!(request.url, "https://openrouter.ai/api/v1/responses");
    assert_eq!(
        scalar(&request.body)["tools"],
        json!([{"type":"openrouter:web_search"},{"type":"openrouter:web_fetch"}])
    );
    assert!(!format!("{request:?}").contains("fixture-secret"));
}
#[test]
fn cerebras_schema_preserves_property_names_and_collapses_root_union() {
    let schema = json!({"oneOf":[{"type":"object","properties":{"operationId":{"const":"a"},"format":{"type":"string","pattern":"x"}},"required":["operationId","format"]},{"type":"object","properties":{"operationId":{"const":"b"},"count":{"type":"number"}},"required":["operationId"]}]});
    let projected = scalar(&request::project_cerebras_schema(&schema));
    assert_eq!(projected["type"], "object");
    assert_eq!(
        projected["properties"]["operationId"]["enum"],
        json!(["a", "b"])
    );
    assert!(projected["properties"].get("format").is_some());
    assert!(projected["properties"]["format"].get("pattern").is_none());
    assert_eq!(projected["required"], json!(["operationId"]));
}
#[test]
fn native_disabled_thinking_requires_exact_independent_proof() {
    let body = json!({"model":"claude-fixture","input":"hello","max_output_tokens":10,"reasoning":{"effort":"none"}});
    assert!(gateway_providers::anthropic::try_native_messages(&body, &options()).is_none());
    let mut opts = options();
    opts.supports_disabled_thinking = true;
    let native = scalar(&gateway_providers::anthropic::try_native_messages(&body, &opts).unwrap());
    assert_eq!(native["thinking"], json!({"type":"disabled"}));
    assert!(native.get("output_config").is_none());
    assert_eq!(
        native["messages"][0]["content"][0]["cache_control"],
        json!({"type":"ephemeral"})
    );
}
#[test]
fn native_replay_is_scoped_complete_expiring_and_never_publicly_signed() {
    let context = replay::ReplayContext {
        scope: "key-a".into(),
        provider: "claude_code".into(),
        model: "claude-fixture".into(),
    };
    let source = |value: &Value| SourceJson::from_serializable(value).unwrap();
    let native = source(
        &json!([{"type":"thinking","thinking":"thought","signature":"private"},{"type":"text","text":"answer"}]),
    );
    let output = [
        json!({"id":"rs_resp_native_0","type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]}),
        json!({"id":"msg_resp_native_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer","annotations":[]}]}),
    ]
    .map(|value| source(&value));
    let mut store = replay::ReplayStore::default();
    assert!(store.remember(
        context.clone(),
        &output,
        native,
        replay::ReplayTransport::Messages,
        0
    ));
    assert!(
        store
            .restore(&context, &output, replay::ReplayTransport::Messages, 1)
            .is_some()
    );
    let mut other = context.clone();
    other.scope = "key-b".into();
    assert!(
        store
            .restore(&other, &output, replay::ReplayTransport::Messages, 1)
            .is_none()
    );
    let tampered_value = json!({"id":"rs_resp_native_0","type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]});
    let tampered = [
        source(&tampered_value),
        source(
            &json!({"id":"msg_resp_native_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"tampered"}]}),
        ),
    ];
    assert!(
        store
            .restore(&context, &tampered, replay::ReplayTransport::Messages, 1)
            .is_none()
    );
    assert!(
        store
            .restore(
                &context,
                &output,
                replay::ReplayTransport::Messages,
                1_800_000
            )
            .is_none()
    );
    assert!(!json!(output).to_string().contains("private"));
}
#[test]
fn lithos_rung_windows_recover_independently() {
    let mut windows = policy::LithosWindows::default();
    let ultra = "deepseek-ai/DeepSeek-V4.1-Flash-ultra";
    windows.refuse(&ultra.into(), 0, 100);
    windows.refuse(&"deepseek-ai/DeepSeek-V4.1-Flash-fast".into(), 0, 200);
    assert!(
        windows
            .select(&ultra.into(), 50)
            .matches_scalar("deepseek-ai/DeepSeek-V4.1-Flash")
    );
    assert!(windows.select(&ultra.into(), 150).matches_scalar(ultra));
    let mut waits = policy::WaitBudget {
        waits: 0,
        waited_ms: 0,
        streamed: true,
    };
    for _ in 0..4 {
        assert!(waits.claim(75_000, false))
    }
    assert!(!waits.claim(1, false));
}
#[test]
fn additional_inference_routes_have_provider_payloads_and_image_billing_boundary() {
    let embedding = extras::prepare_embeddings(
        &json!({"model":"voyage-4-large","input":["hello"],"dimensions":256}),
        &options(),
    )
    .unwrap();
    assert_eq!(
        scalar(&embedding.body),
        json!({"model":"voyage-4-large","input":"hello","input_type":"document","output_dimension":256,"output_dtype":"float","truncation":true})
    );
    assert_eq!(embedding.url, "https://api.voyageai.com/v1/embeddings");
    assert!(extras::parse_embeddings(&json!({"input":"x"}), true).is_err());
    let system = extras::prepare_systemone(
        &json!({"state":{},"questions":{"go":{"type":"noul"}}}),
        &options(),
    )
    .unwrap();
    assert_eq!(scalar(&system.body)["model"], "~typesafe/jev-latest");
    assert_eq!(system.url, "https://openrouter.ai/api/v1/systemone");
    let image = extras::prepare_image(
        &json!({"prompt":"edit","images":[{"image_url":"https://example.test/image.png"}],"n":2}),
        "gpt-fixture",
        true,
        "request",
    )
    .unwrap();
    assert!(image.codex_only);
    assert_eq!(
        scalar_source(&image.responses)["tools"][0]["model"],
        "gpt-image-1.5"
    );
    assert_eq!(image.request_ids, vec!["request", "request:image:edits:2"]);
    assert!(
        extras::prepare_image(
            &json!({"prompt":"x","stream":true}),
            "gpt-fixture",
            false,
            "request"
        )
        .is_err()
    );
}
#[test]
fn chat_tool_calls_null_is_absent_in_buffered_responses() {
    let mut plan = plan(ChatProfile::Lithos);
    plan.stream = false;
    plan.surface = ClientSurface::Responses;
    let completion = json!({"id":"chat_1","created":1,"object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"pong","tool_calls":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});
    let decoded = decode_response(
        &plan,
        200,
        &Headers::new(),
        &serde_json::to_vec(&completion).unwrap(),
    )
    .unwrap();
    assert_eq!(decoded.status, 200);
    assert_eq!(scalar(&decoded.body)["status"], "completed");
    assert_eq!(
        scalar(&decoded.body)["output"][0]["content"][0]["text"],
        "pong"
    );
}

#[test]
fn direct_chat_empty_stop_is_preserved_while_responses_rejects_it() {
    let mut plan = plan(ChatProfile::Deepseek);
    plan.surface = ClientSurface::Chat;
    plan.decode = ResponseDecode::Chat;
    let completion = json!({"id":"chat_1","created":1,"object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":""},"finish_reason":"stop"}]});
    let decoded = decode_response(
        &plan,
        200,
        &Headers::new(),
        &serde_json::to_vec(&completion).unwrap(),
    )
    .unwrap();
    assert_eq!(
        scalar(&decoded.body)["choices"][0]["message"]["content"],
        ""
    );
    plan.surface = ClientSurface::Responses;
    plan.decode = ResponseDecode::ChatToResponses(ChatProfile::Deepseek);
    assert!(
        decode_response(
            &plan,
            200,
            &Headers::new(),
            &serde_json::to_vec(&completion).unwrap()
        )
        .is_err()
    );
}
#[test]
fn signed_claude_chat_details_are_private_and_do_not_duplicate_reasoning() {
    let mut plan = plan(ChatProfile::Claude);
    plan.decode = ResponseDecode::AnthropicChatToResponses;
    let mut decoder = StreamDecoder::new(plan);
    let mut events=decoder.push(&frame(&chunk(json!({"reasoning_content":"think","reasoning_details":[{"index":0,"type":"reasoning.text","text":"think","signature":"private"}]}),Value::Null))).unwrap();
    events.extend(
        decoder
            .push(&frame(&chunk(json!({"content":"answer"}), json!("stop"))))
            .unwrap(),
    );
    events.extend(decoder.push(b"data: [DONE]\n\n").unwrap());
    assert_eq!(
        scalar(&events.last().unwrap().data)["response"]["output"][0]["summary"][0]["text"],
        "think"
    );
    assert!(
        !json!(events.iter().map(|e| e.data.clone()).collect::<Vec<_>>())
            .to_string()
            .contains("private")
    );
    assert_eq!(
        decoder.native_replay().unwrap()["reasoning_details"][0]["signature"],
        "private"
    );
}
#[test]
fn direct_paid_and_synthetic_pins_preserve_catalog_admission() {
    let surplus = json!({"id":"deepseek-v4.1-flash","supported_endpoint_types":["openai-response"],"input_price_per_token":0.1,"output_price_per_token":0.2,"supports_tools":true});
    let openlux = json!({"id":"deepseek-v4.1-flash","supported_endpoint_types":["openai"]});
    let mut input = policy::PaidRoutingInput {
        model: "deepseek-v4.1-flash".into(),
        endpoint_type: "openai-response".into(),
        request_uses_tools: true,
        codex_model_known: false,
        codex_enabled: true,
        surplus_enabled: true,
        openlux_enabled: true,
        surplus_configured: true,
        openlux_configured: true,
        surplus_catalog: Some(vec![
            gateway_core::source_json::SourceJson::from_serializable(&surplus).unwrap(),
        ]),
        openlux_catalog: Some(vec![
            gateway_core::source_json::SourceJson::from_serializable(&openlux).unwrap(),
        ]),
        allowed_paid_providers: None,
        synthetic_hop: None,
        ubiquity_enabled: true,
    };
    let normal = policy::resolve_paid_route(&input);
    assert_eq!(normal.providers, vec![PaidProvider::Surplus]);
    assert_eq!(
        policy::paid_entry(&normal),
        policy::PaidEntry::Direct(PaidProvider::Surplus)
    );
    input.surplus_enabled = false;
    input.openlux_enabled = false;
    input.allowed_paid_providers = Some(vec![PaidProvider::Metered]);
    input.synthetic_hop = Some(policy::DeepseekHop::Openlux);
    let pinned = policy::resolve_paid_route(&input);
    assert_eq!(pinned.providers, vec![PaidProvider::Metered]);
    input.ubiquity_enabled = false;
    assert!(policy::resolve_paid_route(&input).providers.is_empty());
}
#[test]
fn responses_chat_reconciles_terminal_only_output_without_duplicate_deltas() {
    let mut plan = plan(ChatProfile::Deepseek);
    plan.surface = ClientSurface::Chat;
    plan.decode = ResponseDecode::ResponsesToChat;
    let mut decoder = StreamDecoder::new(plan);
    let mut events=decoder.push(&frame(&json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"an"}))).unwrap();
    events.extend(decoder.push(&frame(&json!({"type":"response.completed","response":{"id":"resp_parity","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}]}}))).unwrap());
    let text = events
        .iter()
        .filter_map(|e| {
            scalar(&e.data)["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_owned)
        })
        .collect::<String>();
    assert_eq!(text, "answer");
    assert!(events.last().unwrap().is_done());
}
#[test]
fn codex_transport_strips_accepted_ignored_controls_and_keeps_session_scope() {
    let mut opts = options();
    opts.conversation_id = Some("generated-conversation-uuid".into());
    opts.client_version = "0.1.0".into();
    let prepared=prepare_request(UpstreamProvider::ChatgptCodex,ClientSurface::Responses,&json!({"model":"gpt-fixture","input":[{"role":"user","content":[{"type":"input_text","text":"x","prompt_cache_breakpoint":{"mode":"explicit"}}]}],"max_output_tokens":10,"prompt_cache_key":"raw-affinity","prompt_cache_options":{"mode":"explicit"},"previous_response_id":"resp_prev"}),&opts).unwrap();
    assert!(scalar(&prepared.body).get("max_output_tokens").is_none());
    assert!(scalar(&prepared.body).get("prompt_cache_options").is_none());
    assert!(scalar(&prepared.body).get("previous_response_id").is_none());
    assert!(
        scalar(&prepared.body)["input"][0]["content"][0]
            .get("prompt_cache_breakpoint")
            .is_none()
    );
    assert_eq!(
        prepared.headers["conversation_id"],
        "generated-conversation-uuid"
    );
    assert_eq!(
        prepared.headers["user-agent"],
        "codex_cli_rs/0.100.0 (ai.ubq.fi)"
    );
    assert!(
        prepared
            .warnings
            .contains(&"max_output_tokens_ignored".into())
    );
    assert!(
        prepared
            .warnings
            .contains(&"prompt_cache_breakpoint_ignored".into())
    );
    assert_eq!(
        prepared
            .warnings
            .iter()
            .filter(|warning| warning.as_str() == "previous_response_id_ignored")
            .count(),
        1
    );
}
#[test]
fn previous_response_id_provider_matrix_matches_typescript_parity() {
    #[derive(Clone, Copy, Debug)]
    enum Expected {
        StripAndWarn,
        SilentStrip,
        Forward,
    }
    let cases = [
        (
            UpstreamProvider::ChatgptCodex,
            "gpt-fixture",
            Expected::StripAndWarn,
        ),
        (
            UpstreamProvider::Surplus,
            "deepseek-v4.1-flash",
            Expected::StripAndWarn,
        ),
        (
            UpstreamProvider::Metered,
            "deepseek-v4.1-flash",
            Expected::StripAndWarn,
        ),
        (
            UpstreamProvider::Surplus,
            "claude-fixture",
            Expected::StripAndWarn,
        ),
        (
            UpstreamProvider::Metered,
            "claude-fixture",
            Expected::StripAndWarn,
        ),
        (
            UpstreamProvider::Deepseek,
            "deepseek-flash",
            Expected::SilentStrip,
        ),
        (
            UpstreamProvider::Lithos,
            "deepseek-ai/DeepSeek-V4.1-Flash",
            Expected::SilentStrip,
        ),
        (
            UpstreamProvider::Cerebras,
            "qwen-3.8-27b",
            Expected::SilentStrip,
        ),
        (
            UpstreamProvider::Openrouter,
            "~openai/gpt-fixture",
            Expected::Forward,
        ),
    ];
    let options = previous_response_options();
    for (provider, model, expected) in cases {
        for previous in [json!("resp_prev"), Value::Null] {
            let raw = previous_response_fixture(model, Some(previous.clone()));
            let without = previous_response_fixture(model, None);
            let prepared = prepare_request(provider, ClientSurface::Responses, &raw, &options)
                .unwrap_or_else(|error| panic!("{provider:?} failed: {error}"));
            let baseline =
                prepare_request(provider, ClientSurface::Responses, &without, &options).unwrap();
            let body = scalar(&prepared.body);
            let baseline_body = scalar(&baseline.body);
            let warnings = prepared
                .warnings
                .iter()
                .filter(|warning| warning.as_str() == "previous_response_id_ignored")
                .count();
            match expected {
                Expected::StripAndWarn => {
                    assert!(body.get("previous_response_id").is_none(), "{provider:?}");
                    assert_eq!(warnings, 1, "{provider:?} warning");
                    assert_eq!(prepared.body, baseline.body, "{provider:?} body changed");
                    if model.starts_with("claude-") {
                        assert_eq!(
                            prepared.decode.decode,
                            match provider {
                                UpstreamProvider::Surplus =>
                                    ResponseDecode::AnthropicChatToResponses,
                                UpstreamProvider::Metered => ResponseDecode::AnthropicToResponses,
                                _ => unreachable!(),
                            },
                            "{provider:?} did not select native Claude"
                        );
                        assert_eq!(
                            prepared.url,
                            if provider == UpstreamProvider::Surplus {
                                "https://api.surplusintelligence.ai/v1/chat/completions"
                            } else {
                                "https://api.openlux.ai/v1/messages"
                            },
                            "{provider:?} URL"
                        );
                    } else {
                        assert_eq!(
                            body["input"].as_array().map(Vec::len),
                            raw["input"].as_array().map(Vec::len),
                            "{provider:?} input item count changed"
                        );
                    }
                    let history = prepared.body.as_str();
                    for marker in ["first turn", "prior answer", "current turn"] {
                        assert!(history.contains(marker), "{provider:?} lost {marker}");
                    }
                }
                Expected::SilentStrip => {
                    assert!(body.get("previous_response_id").is_none(), "{provider:?}");
                    assert_eq!(warnings, 0, "{provider:?} warning");
                    assert_eq!(prepared.body, baseline.body, "{provider:?} body changed");
                    let forwarded = prepared.body.as_str();
                    for marker in ["first turn", "prior answer", "current turn"] {
                        assert!(forwarded.contains(marker), "{provider:?} lost {marker}");
                    }
                }
                Expected::Forward => {
                    assert_eq!(
                        body.get("previous_response_id"),
                        Some(&previous),
                        "{provider:?}"
                    );
                    assert_eq!(warnings, 0, "{provider:?} warning");
                    assert_eq!(body["input"], raw["input"], "{provider:?} input changed");
                    let mut stripped = body.clone();
                    stripped
                        .as_object_mut()
                        .expect("OpenRouter body is an object")
                        .remove("previous_response_id");
                    assert_eq!(stripped, baseline_body, "{provider:?} body changed");
                }
            }
            assert_eq!(
                scalar(&prepared.decode.request),
                raw,
                "{provider:?} source request changed"
            );
        }
    }
    let raw = previous_response_fixture("claude-fixture", Some(json!("resp_prev")));
    let error = prepare_request(
        UpstreamProvider::ClaudeCode,
        ClientSurface::Responses,
        &raw,
        &options,
    )
    .expect_err("Claude Code must keep refusing non-null response IDs");
    assert_eq!(error.status, 400);
    assert_eq!(
        error
            .envelope
            .error
            .param
            .as_ref()
            .and_then(|param| param.as_deref()),
        Some("reasoning"),
        "Claude refusal parameter changed"
    );
    assert!(
        error
            .envelope
            .error
            .message
            .contains("cannot be represented losslessly")
    );
}
#[test]
fn native_messages_unclosed_blocks_fail_before_terminal() {
    let mut plan = plan(ChatProfile::Claude);
    plan.decode = ResponseDecode::AnthropicToResponses;
    let mut decoder = StreamDecoder::new(plan);
    decoder.push(&frame(&json!({"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","usage":{"input_tokens":10}}}))).unwrap();
    decoder.push(&frame(&json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":"answer"}}))).unwrap();
    assert!(
        decoder
            .push(&frame(&json!({"type":"message_stop"})))
            .is_err()
    );
}

fn scalar(value: &gateway_core::source_json::SourceJson) -> serde_json::Value {
    value
        .deserialize()
        .expect("This frozen regression fixture has scalar text")
}

fn scalar_source(value: &gateway_core::source_json::SourceJson) -> serde_json::Value {
    value.deserialize().expect("actual scalar fixture output")
}
