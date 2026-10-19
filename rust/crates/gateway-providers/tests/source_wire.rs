//! Literal source-unit and actual Rust wire/echo fixtures. No JavaScript projector or live provider.
use gateway_core::{
    js_string::JsString16, provider::UpstreamProvider, source_json::SourceJson,
    source_serialization as json,
};
use gateway_providers::{
    AuthMaterial, ClientSurface, PrepareOptions, ProviderEvent, ToolMap, decode_response,
    prepare_source_request,
};
fn parse(raw: &str) -> SourceJson {
    SourceJson::parse(raw).unwrap()
}
fn get(value: &SourceJson, key: &str) -> SourceJson {
    json::member(value, key).unwrap()
}
fn path(value: &SourceJson, keys: &[&str]) -> SourceJson {
    keys.iter()
        .fold(value.clone(), |value, key| get(&value, key))
}
fn rows(value: &SourceJson) -> Vec<SourceJson> {
    json::array(value).unwrap()
}
fn text(value: &SourceJson) -> JsString16 {
    json::string(value).unwrap()
}
fn options() -> PrepareOptions {
    PrepareOptions {
        auth: AuthMaterial {
            secret: "fixture-only".into(),
            account_id: Some("fixture-account".into()),
            ..Default::default()
        },
        conversation_id: Some("fixture-conversation".into()),
        response_id: "resp_source".into(),
        created_at: 1,
        ..Default::default()
    }
}
const SOURCE: &str = r#"{"model":"deepseek-flash","instructions":"i\ud800\udc00\ud800","input":[{"role":"user","content":"u\udc00"},{"type":"function_call","call_id":"c\ud800","name":"f\udc00","arguments":" { \"x\":1, \"x\":2 } "},{"type":"custom_tool_call","call_id":"custom\udc00","name":"custom","input":"raw\ud800"},{"type":"function_call_output","call_id":"c\ud800","output":"o\udc00"}],"reasoning":{"effort":"none"},"tools":[{"type":"function","name":"f\udc00","description":"d\ud800","parameters":{"type":"object","properties":{"\ud800":{"type":"string"}}}}],"tool_choice":{"type":"function","name":"f\udc00"}}"#;

#[test]
fn literal_source_units_reach_direct_provider_wire_and_input_is_immutable() {
    let original = parse(SOURCE);
    for (provider, model) in [
        (UpstreamProvider::Deepseek, "deepseek-flash"),
        (UpstreamProvider::Lithos, "deepseek-ai/DeepSeek-V4.1-Flash"),
        (UpstreamProvider::Cerebras, "qwen-3.8-27b"),
    ] {
        let prepared = prepare_source_request(
            provider,
            ClientSurface::Responses,
            &original,
            &model.into(),
            &options(),
        )
        .unwrap();
        assert_eq!(prepared.decode.request, original);
        assert_eq!(original.as_str(), SOURCE);
        assert!(prepared.body.as_str().contains("\\ud800"));
        assert!(prepared.body.as_str().contains("\\udc00"));
        assert!(!prepared.body.as_str().contains('\u{fffd}'));
        let messages = rows(&get(&prepared.body, "messages"));
        assert_eq!(
            text(&get(&messages[1], "content")),
            JsString16::from_units(vec![117, 0xdc00])
        );
        let calls = rows(&get(&messages[2], "tool_calls"));
        assert_eq!(
            text(&get(&calls[0], "id")),
            JsString16::from_units(vec![99, 0xd800])
        );
        assert_eq!(
            text(&path(&calls[0], &["function", "arguments"])),
            JsString16::from_utf8(" { \"x\":1, \"x\":2 } ")
        );
        assert_eq!(
            text(&path(&calls[1], &["function", "arguments"])),
            JsString16::from_utf8(r#"{"input":"raw\ud800"}"#)
        );
        assert_eq!(
            text(&get(messages.last().unwrap(), "content")),
            JsString16::from_units(vec![111, 0xdc00])
        );
        let tools = rows(&get(&prepared.body, "tools"));
        let properties = path(&tools[0], &["function", "parameters", "properties"]);
        assert_eq!(
            json::entries(&properties).unwrap()[0].0,
            JsString16::from_units(vec![0xd800])
        );
        assert_eq!(
            text(&path(&prepared.body, &["tool_choice", "function", "name"])),
            JsString16::from_units(vec![102, 0xdc00])
        );
    }
}

#[test]
fn actual_stringify_boundary_uses_shared_duplicate_integer_key_and_number_semantics() {
    let raw = parse(
        r#"{"model":"deepseek-flash","input":[{"type":"function_call_output","call_id":"c\udc00","output":{"10":1,"2":2,"\ud800":1,"\ud800":9007199254740993,"x":1e400,"z":-0}}]}"#,
    );
    let prepared = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap();
    let message = rows(&get(&prepared.body, "messages")).remove(0);
    assert_eq!(
        text(&get(&message, "content")),
        JsString16::from_utf8(r#"{"2":2,"10":1,"\ud800":9007199254740992,"x":null,"z":0}"#)
    );
    assert_eq!(
        text(&get(&message, "tool_call_id")),
        JsString16::from_units(vec![99, 0xdc00])
    );
    assert_eq!(prepared.decode.request, raw);
}

fn assert_echo(response: &SourceJson, request: &SourceJson) {
    for key in ["instructions", "tools"] {
        assert_eq!(get(response, key), get(request, key), "{key}");
    }
    let choice = json::member(request, "tool_choice").unwrap_or_else(|| parse(r#""auto""#));
    assert_eq!(get(response, "tool_choice"), choice);
}
fn reply() -> &'static [u8] {
    br#"{"id":"chat_fixture","object":"chat.completion","created":2,"choices":[{"index":0,"message":{"role":"assistant","content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#
}
#[test]
fn buffered_and_actual_sse_writer_created_progress_terminal_echo_the_same_source() {
    let raw = parse(SOURCE);
    let prepared = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap();
    let decoded = decode_response(&prepared.decode, 200, &Default::default(), reply()).unwrap();
    assert_echo(&decoded.body, &raw);
    let mut plan = prepared.decode.clone();
    plan.stream = true;
    let mut decoder = gateway_providers::StreamDecoder::new(plan);
    let mut events=decoder.push(b"data: {\"id\":\"chat_fixture\",\"object\":\"chat.completion.chunk\",\"created\":2,\"choices\":[{\"index\":0,\"delta\":{\"content\":\"answer\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").unwrap();
    events.extend(decoder.finish().unwrap());
    for kind in [
        "response.created",
        "response.in_progress",
        "response.completed",
    ] {
        let event = events
            .iter()
            .find(|event| event.type_name().as_deref() == Some(kind))
            .unwrap();
        assert_echo(&event.field("response").unwrap(), &raw);
        let encoded = event.encode_sse();
        let data = encoded
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let parsed = parse(data);
        assert_echo(&get(&parsed, "response"), &raw);
    }
    for reason in ["length", "aborted"] {
        let mut writer = gateway_providers::writer::ResponseWriter::new(prepared.decode.clone());
        writer.finish_reason = Some(reason.into());
        let events = writer.finish();
        assert_echo(&events.last().unwrap().field("response").unwrap(), &raw);
    }
}

#[test]
fn utf16_tool_prefix_collision_namespace_and_map_wire_are_source_strings() {
    let name = "a".repeat(127) + "😀";
    let raw = parse(&format!(
        r#"{{"model":"deepseek-flash","input":"x","tools":[{{"type":"function","name":{name}}},{{"type":"namespace","name":"n\udc00","tools":[{{"type":"function","name":{name}}}]}}]}}"#,
        name = serde_json::to_string(&name).unwrap()
    ));
    let prepared = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap();
    let tools = rows(&get(&prepared.body, "tools"));
    let first = text(&path(&tools[0], &["function", "name"]));
    let second = text(&path(&tools[1], &["function", "name"]));
    assert_eq!(first.as_units().len(), 128);
    assert_eq!(first.as_units()[127], 0xd83d);
    assert_ne!(first, second);
    assert_eq!(
        prepared.decode.tool_names.get_source(&first).unwrap().name,
        JsString16::from_utf8(&name)
    );
    let map = SourceJson::from_serializable(&prepared.decode.tool_names).unwrap();
    assert!(map.as_str().contains("\\ud83d"));
    assert!(!map.as_str().contains("units"));
    assert_eq!(
        map.deserialize::<ToolMap>().unwrap(),
        prepared.decode.tool_names
    );
    assert_eq!(json::entries(&map).unwrap()[0].0, first);
}

#[test]
fn direct_native_and_ordinary_branches_keep_the_source_phase_boundary() {
    let raw = parse(
        r#"{"model":"openai/test","input":{"unusual":"\ud800"},"stream":"not-a-boolean","reasoning":{"unknown":"\udc00"}}"#,
    );
    let mut options = options();
    options.allowed_models = vec!["openai/test".into()];
    let prepared = prepare_source_request(
        UpstreamProvider::Openrouter,
        ClientSurface::Responses,
        &raw,
        &"openai/test".into(),
        &options,
    )
    .unwrap();
    assert_eq!(get(&prepared.body, "input"), get(&raw, "input"));
    assert_eq!(get(&prepared.body, "reasoning"), get(&raw, "reasoning"));
    assert!(!prepared.decode.stream);
    let error = prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &raw,
        &"gpt-fixture".into(),
        &options,
    )
    .unwrap_err();
    assert_eq!(
        error.body(),
        &parse(
            r#"{"error":{"message":"stream must be a boolean","type":"invalid_request_error","code":"invalid_request_error","param":"stream"}}"#
        )
    );
}

#[test]
fn source_errors_keep_unknown_field_role_choice_and_disabled_call_id_units() {
    // This is explicitly the common envelope validator, not a provider-owned ingress gate.
    let error = gateway_schema::source_request::validate_request_fields(
        &parse(r#"{"model":"deepseek-flash","input":"x","\ud800":1}"#),
        gateway_schema::request::RequestSurface::Responses,
        &Default::default(),
    )
    .unwrap_err();
    assert_eq!(
        error.body(),
        &parse(
            r#"{"error":{"message":"Unrecognized request argument supplied: \ud800","type":"invalid_request_error","code":"invalid_request_error"}}"#
        )
    );
    let raw = parse(r#"{"model":"deepseek-flash","input":[{"role":"\ud800","content":"x"}]}"#);
    let error = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap_err();
    assert_eq!(
        text(&path(error.body(), &["error", "message"])),
        JsString16::from_units(
            "input role '"
                .encode_utf16()
                .chain([0xd800])
                .chain("' is not supported".encode_utf16())
                .collect()
        )
    );
    let raw = parse(&format!(
        r#"{{"model":"deepseek-flash","input":[{{"type":"function_call_output","call_id":"c\ud800","output":"{}"}}],"truncation":"disabled"}}"#,
        "a".repeat(65_537)
    ));
    let error = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap_err();
    assert_eq!(
        get(&get(error.body(), "error"), "code"),
        parse(r#""context_length_exceeded""#)
    );
    assert_eq!(
        get(&get(error.body(), "error"), "param"),
        parse(r#""input[0].output""#)
    );
    let expected = format!(
        "input item input[0].output (tool call c{} carries 65537 bytes; this route forwards at most 65536 bytes per message under deepseek-forwarded-payload/v1, and the request set truncation 'disabled', so the gateway will not reduce it. Reduce the payload or send truncation 'auto' to allow the declared reduction.",
        ")"
    );
    let mut units = expected.encode_utf16().collect::<Vec<_>>();
    let at = "input item input[0].output (tool call c"
        .encode_utf16()
        .count();
    units.insert(at, 0xd800);
    assert_eq!(
        text(&path(error.body(), &["error", "message"])),
        JsString16::from_units(units)
    );
}

#[test]
fn codex_replay_and_direct_chat_do_not_lose_source_text() {
    let raw = parse(
        r#"{"model":"gpt-fixture","instructions":"i\ud800","input":[{"type":"reasoning","id":"rs_resp_a_0","summary":[]},{"type":"message","role":"assistant","id":"msg_resp_a_1","content":[{"type":"output_text","text":"a\udc00"}]},{"type":"reasoning","id":"rs_genuine\ud800","encrypted_content":"sealed\udc00","summary":[]}]}"#,
    );
    let prepared = prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &raw,
        &"gpt-fixture".into(),
        &options(),
    )
    .unwrap();
    let input = rows(&get(&prepared.body, "input"));
    assert_eq!(input.len(), 2);
    assert!(json::member(&input[0], "id").is_none());
    assert_eq!(get(&input[1], "id"), parse(r#""rs_genuine\ud800""#));
    assert_eq!(get(&prepared.body, "instructions"), parse(r#""i\ud800""#));
    assert_eq!(prepared.decode.request, raw);
    let raw = parse(
        r#"{"model":"deepseek-flash","messages":[{"role":"developer","content":"d\ud800"},{"role":"user","content":"u\udc00"}],"reasoning_effort":"none"}"#,
    );
    let prepared = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Chat,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap();
    let messages = rows(&get(&prepared.body, "messages"));
    assert_eq!(get(&messages[0], "role"), parse(r#""system""#));
    assert_eq!(get(&messages[0], "content"), parse(r#""d\ud800""#));
    assert_eq!(get(&messages[1], "content"), parse(r#""u\udc00""#));
}

#[test]
fn semantic_and_usage_accessors_observe_the_authoritative_event_only() {
    let event = ProviderEvent::responses_source(parse(
        r#"{"type":"response.output_item.done","item":{"type":"function_call","call_id":"c\ud800","name":"n\udc00","arguments":""}}"#,
    ));
    assert!(event.semantic_event());
    assert!(event.observed_usage().is_none());
    assert!(event.terminal().is_none());
    let event = ProviderEvent::responses_source(parse(
        r#"{"type":"response.completed","response":{"instructions":"\ud800","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}"#,
    ));
    assert_eq!(event.observed_usage().unwrap()["total_tokens"], 3);
    assert_eq!(
        event.terminal(),
        Some(gateway_core::lifecycle::SemanticTerminal::Completed)
    );
}

#[test]
fn paid_and_native_claude_source_wire_and_request_echo_keep_text_and_schema_units() {
    let raw = parse(
        r#"{"model":"claude-opus-5-5","instructions":"i\ud800","input":[{"role":"user","content":[{"type":"input_text","text":"u\udc00"}]}],"tools":[{"type":"function","name":"f","description":"d\ud800","parameters":{"type":"object","properties":{"\udc00":{"type":"string"}}}}]}"#,
    );
    for provider in [
        UpstreamProvider::Surplus,
        UpstreamProvider::Metered,
        UpstreamProvider::ClaudeCode,
    ] {
        let prepared = prepare_source_request(
            provider,
            ClientSurface::Responses,
            &raw,
            &"claude-opus-5-5".into(),
            &options(),
        )
        .unwrap();
        assert_eq!(prepared.decode.request, raw);
        assert!(prepared.body.as_str().contains("\\ud800"));
        assert!(prepared.body.as_str().contains("\\udc00"));
        assert!(!prepared.body.as_str().contains('\u{fffd}'));
        let reply = if provider == UpstreamProvider::Surplus {
            reply()
        } else {
            br#"{"id":"msg_fixture","type":"message","role":"assistant","content":[{"type":"text","text":"answer"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}"#
        };
        let decoded = decode_response(&prepared.decode, 200, &Default::default(), reply).unwrap();
        assert_echo(&decoded.body, &raw);
    }
}

#[test]
fn source_original_tool_identity_survives_buffered_and_streamed_generated_items() {
    let raw = parse(r#"{"model":"deepseek-flash","input":"x"}"#);
    let mut plan = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap()
    .decode;
    let identity = gateway_providers::ToolIdentity {
        name: JsString16::from_units(vec![102, 0xd800]),
        namespace: Some(JsString16::from_units(vec![110, 0xdc00])),
        custom: false,
    };
    plan.tool_names
        .insert("wire_ascii".into(), identity.clone());
    let generated = serde_json::json!({"id":"chat_fixture","object":"chat.completion","created":2,"choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_fixture","type":"function","function":{"name":"wire_ascii","arguments":" { \"x\":1 } "}}]},"finish_reason":"tool_calls"}]});
    let buffered = decode_response(
        &plan,
        200,
        &Default::default(),
        &serde_json::to_vec(&generated).unwrap(),
    )
    .unwrap();
    let item = rows(&get(&buffered.body, "output")).remove(0);
    assert_eq!(text(&get(&item, "name")), identity.name);
    assert_eq!(
        text(&get(&item, "namespace")),
        identity.namespace.clone().unwrap()
    );
    let mut writer = gateway_providers::writer::ResponseWriter::new(plan);
    let mut events =
        writer.tool_delta(0, Some("call_fixture"), Some("wire_ascii"), " { \"x\":1 } ");
    writer.finish_reason = Some("tool_calls".into());
    events.extend(writer.finish());
    for event in events
        .iter()
        .filter(|event| event.type_name().as_deref() == Some("response.output_item.done"))
    {
        let item = event.field("item").unwrap();
        assert_eq!(text(&get(&item, "name")), identity.name);
        assert_eq!(
            text(&get(&item, "namespace")),
            identity.namespace.clone().unwrap()
        );
        assert!(event.encode_sse().contains("\\ud800"));
    }
}

#[test]
fn selected_provider_phase_errors_and_open_effort_do_not_scalarize_source_controls() {
    let raw = parse(r#"{"model":"deepseek-flash","input":"x","reasoning":{"effort":"new\ud800"}}"#);
    let prepared = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap();
    assert_eq!(
        get(&prepared.body, "reasoning_effort"),
        parse(r#""new\ud800""#)
    );
    let raw = parse(
        r#"{"model":"deepseek-flash","input":"x","reasoning":{"effort":"none"},"tool_choice":"\udc00"}"#,
    );
    let error = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap_err();
    assert_eq!(
        path(error.body(), &["error", "message"]),
        parse(r#""tool_choice '\udc00' is not supported""#)
    );
    let raw = parse(
        r#"{"model":"deepseek-flash","input":"x","max_output_tokens":0,"reasoning":[],"tools":null}"#,
    );
    let error = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap_err();
    assert_eq!(
        path(error.body(), &["error", "param"]),
        parse(r#""max_output_tokens""#)
    );
    let raw = parse(r#"{"model":"deepseek-flash","input":"x","reasoning":[],"tools":null}"#);
    let error = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap_err();
    assert_eq!(
        path(error.body(), &["error", "param"]),
        parse(r#""reasoning""#)
    );
}

#[test]
fn reasoning_refusal_and_agent_message_envelopes_preserve_literal_units() {
    let raw = parse(
        r#"{"model":"deepseek-flash","input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"r\ud800"}]},{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"no\udc00"}]},{"type":"agent_message","author":"a\ud800","recipient":"b\udc00","content":[{"type":"input_text","text":"t\ud800"},{"type":"encrypted_content","encrypted_content":"plain\udc00"}]}]}"#,
    );
    let prepared = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap();
    let messages = rows(&get(&prepared.body, "messages"));
    assert_eq!(get(&messages[0], "content"), parse(r#""no\udc00""#));
    assert_eq!(
        get(&messages[0], "reasoning_content"),
        parse(r#""r\ud800""#)
    );
    assert_eq!(
        get(&messages[1], "content"),
        parse(r#""[agent message] a\ud800 -> b\udc00:\nt\ud800\nplain\udc00""#)
    );
    assert_eq!(prepared.decode.request, raw);
}

#[test]
fn combined_image_text_reduction_preserves_source_parts_and_exact_refusal_boundary() {
    let url = "https://x/".to_owned() + &"a".repeat(40_000);
    let raw = parse(&format!(
        r#"{{"model":"deepseek-flash","input":[{{"role":"user","content":[{{"type":"input_text","text":"\ud800{}"}},{{"type":"input_image","image_url":{}}}]}}]}}"#,
        "a".repeat(40_000),
        serde_json::to_string(&url).unwrap()
    ));
    let prepared = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap();
    let messages = rows(&get(&prepared.body, "messages"));
    let parts = rows(&get(&messages[0], "content"));
    assert_eq!(parts.len(), 2);
    assert_eq!(text(&get(&parts[0], "text")).as_units()[0], 0xd800);
    assert_eq!(get(&parts[1], "type"), parse(r#""text""#));
    assert_eq!(
        text(&get(&parts[1], "text")),
        JsString16::from_utf8(&format!(
            "[gateway: deepseek-forwarded-payload/v1 image omitted ({} bytes); the model did not receive this image; this route forwards at most 65536 bytes per message because the provider counts forwarded payloads as text tokens]",
            url.len()
        ))
    );
    let mut fields = json::entries(&raw).unwrap();
    fields.push((JsString16::from_utf8("truncation"), parse(r#""disabled""#)));
    let disabled = json::object_keys(fields).unwrap();
    let error = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &disabled,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap_err();
    assert_eq!(
        path(error.body(), &["error", "param"]),
        parse(r#""input[0].content""#)
    );
    assert_eq!(
        path(error.body(), &["error", "code"]),
        parse(r#""context_length_exceeded""#)
    );
    assert!(
        text(&path(error.body(), &["error", "message"]))
            .try_utf8()
            .unwrap()
            .contains(&format!("carries {} bytes", 40_003 + url.len()))
    );
}

#[test]
fn custom_argument_json_parse_extracts_source_units_without_a_scalar_response_mirror() {
    let mut names = ToolMap::new();
    names.insert(
        "custom".into(),
        gateway_providers::ToolIdentity {
            name: JsString16::from_units(vec![99, 0xd800]),
            namespace: None,
            custom: true,
        },
    );
    let arguments = r#" { "input" : "raw\udc00" } "#;
    let item = gateway_providers::tools::function_item(
        "ctc_fixture",
        "call_fixture",
        "custom",
        arguments,
        &names,
        "completed",
    );
    assert_eq!(get(&item, "input"), parse(r#""raw\udc00""#));
    let raw = parse(r#"{"model":"deepseek-flash","input":"x"}"#);
    let mut plan = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &"deepseek-flash".into(),
        &options(),
    )
    .unwrap()
    .decode;
    plan.tool_names = names;
    let mut writer = gateway_providers::writer::ResponseWriter::new(plan);
    writer.tool_delta(0, Some("call_fixture"), Some("custom"), arguments);
    let events = writer.finish();
    let delta = events
        .iter()
        .find(|event| event.type_name().as_deref() == Some("response.custom_tool_call_input.delta"))
        .unwrap();
    assert_eq!(delta.field("delta").unwrap(), parse(r#""raw\udc00""#));
    assert!(delta.encode_sse().contains("\\udc00"));
}

#[test]
fn source_model_echoes_in_buffered_and_sse_composition_are_ordinary_json_strings() {
    use gateway_core::model::ModelId;
    for model in [
        JsString16::from_units(vec![0xd800]),
        JsString16::from_units(vec![0xdc00]),
        JsString16::from_utf8(r"\ud800"),
        JsString16::from_utf8("m\ncontrol"),
    ] {
        let raw = json::object(vec![
            ("model", model.to_source_json().unwrap()),
            ("input", parse(r#""x""#)),
        ])
        .unwrap();
        let selected = ModelId::from_source(model.clone());
        let prepared = prepare_source_request(
            UpstreamProvider::Surplus,
            ClientSurface::Responses,
            &raw,
            &selected,
            &options(),
        )
        .unwrap();
        assert_eq!(text(&get(&prepared.body, "model")), model);
        // Select the existing scalar Chat upstream codec to exercise its synthesized
        // request-derived envelope; this is not a new router/provider selection.
        let mut plan = prepared.decode.clone();
        plan.decode = gateway_providers::ResponseDecode::ChatToResponses(
            gateway_providers::ChatProfile::Deepseek,
        );
        let buffered = decode_response(&plan, 200, &Default::default(), reply()).unwrap();
        assert_eq!(text(&get(&buffered.body, "model")), model);
        let mut writer = gateway_providers::writer::ResponseWriter::new(prepared.decode);
        let mut events = writer.text("answer", false);
        events.extend(writer.finish());
        for event in events
            .iter()
            .filter(|event| event.field("response").is_some())
        {
            assert_eq!(
                text(&get(&event.field("response").unwrap(), "model")),
                model
            );
            let encoded = event.encode_sse();
            let data = encoded
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap();
            assert_eq!(text(&path(&parse(data), &["response", "model"])), model);
        }
    }
}
#[test]
fn opaque_model_refusal_body_does_not_replace_or_scalarize_request_units() {
    use gateway_core::model::ModelId;
    let raw = parse(r#"{"model":"\ud800","input":"x"}"#);
    let model = ModelId::from_source(JsString16::from_units(vec![0xd800]));
    let error = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Responses,
        &raw,
        &model,
        &options(),
    )
    .unwrap_err();
    assert_eq!(error.status, 404);
    let message = text(&path(error.body(), &["error", "message"]));
    assert_eq!(
        message.as_units(),
        "The model '"
            .encode_utf16()
            .chain([0xd800])
            .chain("' does not exist or is not available.".encode_utf16())
            .collect::<Vec<_>>()
    );
    assert!(error.body().as_str().contains(r"\ud800"));
}

#[test]
fn paid_catalog_lookup_compares_source_model_units_and_retains_billing_fragments() {
    use gateway_core::{model::ModelId, provider::PaidProvider};
    use gateway_providers::policy::{PaidRoutingInput, resolve_paid_route};
    let model = ModelId::from_source(JsString16::from_units(vec![0xd800]));
    let row = parse(
        r#"{"id":"\ud800","supported_endpoint_types":["openai-response"],"input_price_per_token":0.1,"output_price_per_token":0.2,"cache_read_price_per_token":"source\udc00"}"#,
    );
    let mut input = PaidRoutingInput {
        model,
        endpoint_type: "openai-response".into(),
        request_uses_tools: false,
        codex_model_known: false,
        codex_enabled: true,
        surplus_enabled: true,
        openlux_enabled: true,
        surplus_configured: true,
        openlux_configured: true,
        surplus_catalog: Some(vec![row.clone()]),
        openlux_catalog: Some(vec![]),
        allowed_paid_providers: None,
        synthetic_hop: None,
        ubiquity_enabled: true,
    };
    let plan = resolve_paid_route(&input);
    assert_eq!(plan.providers, vec![PaidProvider::Surplus]);
    assert_eq!(
        get(
            plan.surplus_billing.as_ref().unwrap(),
            "cache_read_price_per_token"
        ),
        get(&row, "cache_read_price_per_token")
    );
    input.model = r"\ud800".into();
    assert!(resolve_paid_route(&input).providers.is_empty());
}
