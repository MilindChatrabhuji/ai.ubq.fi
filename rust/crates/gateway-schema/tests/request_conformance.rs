use gateway_core::{js_string::JsString16, source_json::SourceJson};
use gateway_schema::{
    allowlists::*, content::*, prompt_cache::*, reasoning::*, request::*, util::*,
};
use serde_json::{Value, json};
#[test]
fn official_surfaces_match_immutable_pin_and_extensions_stay_separate() {
    let pin: Value = serde_json::from_str(include_str!("fixtures/openai-spec-pin.json")).unwrap();
    assert_eq!(
        json!(CHAT_COMPLETIONS_REQUEST_KEYS),
        pin["surfaces"]["CreateChatCompletionRequest"]
    );
    assert_eq!(
        json!(RESPONSES_REQUEST_KEYS),
        pin["surfaces"]["CreateResponse"]
    );
    assert!(!RESPONSES_REQUEST_KEYS.contains(&"client_metadata"));
}
#[test]
fn unknown_key_is_first_js_integer_then_insertion_order() {
    let body: Value = serde_json::from_str(r#"{"z":1,"10":2,"2":3,"a":4}"#).unwrap();
    let error = validate_request_fields(
        &body,
        RequestSurface::Responses,
        &RequestExtensions::default(),
    )
    .unwrap_err();
    assert_eq!(
        error.envelope.error.message,
        "Unrecognized request argument supplied: 2"
    );
    assert_eq!(error.envelope.error.param, None);
    assert_eq!(json_stringify(&body), r#"{"2":3,"10":2,"z":1,"a":4}"#);
}
#[test]
fn source_null_and_scalar_contracts_remain_distinct() {
    assert!(!parse_stream(None).unwrap());
    assert!(parse_stream(Some(&Value::Null)).is_err());
    assert!(parse_max_completion_tokens(Some(&Value::Null)).is_err());
    assert!(
        validate_request_fields(
            &json!({"max_output_tokens":null,"max_tool_calls":null}),
            RequestSurface::Responses,
            &RequestExtensions::default()
        )
        .is_ok()
    );
    assert!(
        validate_request_fields(
            &json!({"parallel_tool_calls":null}),
            RequestSurface::Responses,
            &RequestExtensions::default()
        )
        .is_err()
    );
    assert_eq!(
        resolve_model(Some(&json!("  ")), Some("fallback")).unwrap(),
        "fallback"
    );
    assert_eq!(
        resolve_model(Some(&json!(7)), Some("fallback"))
            .unwrap_err()
            .envelope
            .error
            .message,
        "model must be a string"
    );
    assert!(parse_chat_stream_options(Some(&json!({"include_usage":true,"future":7}))).unwrap());
}
#[test]
fn scoped_extensions_do_not_widen_other_routes() {
    let body = json!({"client_metadata":{"turn":"one"}});
    assert!(
        validate_request_fields(
            &body,
            RequestSurface::Responses,
            &RequestExtensions::default()
        )
        .is_ok()
    );
    assert!(
        validate_request_fields(
            &body,
            RequestSurface::ChatCompletions,
            &RequestExtensions::default()
        )
        .is_err()
    );
    assert!(
        validate_request_fields(
            &json!({"client_metadata":{"turn":1}}),
            RequestSurface::Responses,
            &RequestExtensions::default()
        )
        .is_err()
    );
    assert!(
        validate_request_fields(
            &json!({"thinking":{"type":"enabled"}}),
            RequestSurface::ChatCompletions,
            &RequestExtensions::default()
        )
        .is_err()
    );
    assert!(
        validate_request_fields(
            &json!({"thinking":{"type":"enabled"}}),
            RequestSurface::ChatCompletions,
            &RequestExtensions {
                deepseek_thinking: true,
                openrouter_cache_control: false
            }
        )
        .is_ok()
    );
}
#[test]
fn none_custom_and_ultra_efforts_preserve_request_labels() {
    let record = SourceJson::from_serializable(&json!({"supported_reasoning_levels":["low","Future Tier"],"reasoning_effort_wire_map":{"none":"max","ultra":"low","Future Tier":"future-wire"}})).unwrap();
    let model = ModelReasoning::from_record(Some(&record));
    assert!(!model.levels.contains(&JsString16::from_utf8("none")));
    assert_eq!(
        effort_for_codex(&"none".into(), &model),
        JsString16::from_utf8("none")
    );
    assert_eq!(
        effort_for_codex(&"ultra".into(), &model),
        JsString16::from_utf8("max")
    );
    assert_eq!(
        effort_for_codex(&"Future Tier".into(), &model),
        JsString16::from_utf8("future-wire")
    );
    let resolved = resolve_reasoning(
        Some(
            &SourceJson::from_serializable(&json!({"effort":" ultra ","context":"opaque"}))
                .unwrap(),
        ),
        &model,
        &"medium".into(),
    )
    .unwrap();
    assert_eq!(resolved.label, JsString16::from_utf8("ultra"));
    let view: Value = resolved.value.deserialize().unwrap();
    assert_eq!(view["effort"], "max");
    assert_eq!(view["context"], "opaque");
    let summary = resolve_reasoning(
        Some(&SourceJson::from_serializable(&json!({"summary":"auto"})).unwrap()),
        &model,
        &"medium".into(),
    )
    .unwrap();
    let summary: Value = summary.value.deserialize().unwrap();
    assert!(summary.get("effort").is_none());
    assert_eq!(
        parse_effort(Some(&Value::Null), "reasoning_effort").unwrap(),
        None
    );
}
#[test]
fn actual_sanitized_codex_replay_keeps_tools_and_drops_output_metadata() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/codex-0.163.0-logprobs.json")).unwrap();
    validate_request_fields(
        &fixture,
        RequestSurface::Responses,
        &RequestExtensions::default(),
    )
    .unwrap();
    let input = normalize_responses_input(fixture.get("input")).unwrap();
    assert_eq!(input[0]["type"], "additional_tools");
    assert_eq!(input[0]["tools"], fixture["input"][0]["tools"]);
    let assistant = input.iter().find(|v| v["role"] == "assistant").unwrap();
    assert_eq!(assistant["content"].as_array().unwrap().len(), 2);
    for part in assistant["content"].as_array().unwrap() {
        assert_eq!(part.as_object().unwrap().len(), 2);
        assert!(part.get("logprobs").is_none());
        assert!(part.get("annotations").is_none());
    }
    assert!(
        !responses_warnings(&fixture)
            .iter()
            .any(|s| s == "client_metadata_ignored")
    );
}
#[test]
fn output_metadata_validation_keeps_precise_field_path() {
    let error = normalize_response_content(
        &json!({"type":"output_text","text":"answer","logprobs":null}),
        "input[3].content[1]",
        "assistant",
    )
    .unwrap_err();
    assert_eq!(
        error.envelope.error.param,
        Some(Some("input[3].content[1].logprobs".into()))
    );
    assert_eq!(
        error.envelope.error.message,
        "input[3].content[1].logprobs must be an array"
    );
    assert!(
        normalize_response_content(
            &json!({"type":"output_text","text":"answer","logprobs":[]}),
            "part",
            "user"
        )
        .is_err()
    );
}
#[test]
fn responses_bare_content_coalesces_only_before_noncontent() {
    let input=normalize_responses_input(Some(&json!(["a",{"type":"input_text","text":"b"},{"type":"function_call","call_id":"c","name":"f","arguments":"{}"},"d","e"]))).unwrap();
    assert_eq!(input.len(), 4);
    assert_eq!(input[0]["content"].as_array().unwrap().len(), 2);
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[2]["content"][0]["text"], "d");
    assert_eq!(input[3]["content"][0]["text"], "e");
    assert_eq!(
        normalize_responses_input(None).unwrap(),
        Vec::<Value>::new()
    );
    assert!(normalize_responses_input(Some(&Value::Null)).is_err());
}
#[test]
fn chat_tool_round_trip_keeps_order_and_opaque_arguments() {
    let messages = json!([{"role":"system","content":"Be concise"},{"role":"assistant","content":"calling","tool_calls":[{"id":" call1 ","type":"function","function":{"name":" tool ","arguments":"{ malformed JSON  "}}]},{"role":"tool","tool_call_id":"call1","content":"done"}]);
    let result = normalize_chat_messages(&messages).unwrap();
    assert_eq!(result.instructions, Some("Be concise".into()));
    assert_eq!(result.input[0]["content"][0]["text"], "calling");
    assert_eq!(
        result.input[1],
        json!({"type":"function_call","call_id":"call1","name":"tool","arguments":"{ malformed JSON  "})
    );
    assert_eq!(
        result.input[2],
        json!({"type":"function_call_output","call_id":"call1","output":"done"})
    );
}
#[test]
fn developer_breakpoint_prevents_instruction_hoisting() {
    let result=normalize_chat_messages(&json!([{"role":"system","content":"one"},{"role":"developer","content":[{"type":"text","text":"two","prompt_cache_breakpoint":{"mode":"explicit"}}]}])).unwrap();
    assert_eq!(result.instructions, None);
    assert_eq!(result.input.len(), 2);
    assert_eq!(result.input[0]["role"], "developer");
    assert_eq!(
        result.input[1]["content"][0]["prompt_cache_breakpoint"]["mode"],
        "explicit"
    );
}
#[test]
fn image_and_file_contracts_do_not_accept_unknown_metadata() {
    assert!(
        normalize_response_content(
            &json!({"type":"input_image","image_url":"x","file_id":"y"}),
            "input[0]",
            "user"
        )
        .is_err()
    );
    let image = normalize_response_content(
        &json!({"type":"input_image","image_url":" x ","detail":null}),
        "input[0]",
        "user",
    )
    .unwrap();
    assert_eq!(image["image_url"], "x");
    assert_eq!(image["detail"], Value::Null);
    assert!(
        normalize_response_content(
            &json!({"type":"input_file","file_data":"x","detail":null}),
            "input[0]",
            "user"
        )
        .is_err()
    );
    let file = normalize_response_content(
        &json!({"type":"input_file","file_id":"x","file_url":"y","filename":null}),
        "input[0]",
        "user",
    )
    .unwrap();
    assert_eq!(file["file_id"], "x");
    assert_eq!(file["file_url"], "y");
}
#[test]
fn prompt_cache_unknown_and_known_unsupported_are_distinct() {
    let body = json!({"prompt_cache_options":{"mode":"implicit","ttl":"30m"}});
    validate_prompt_cache_controls(&body).unwrap();
    validate_known_unsupported("model", None, &body, &[], "input").unwrap();
    let error = validate_known_unsupported(
        "model",
        Some(&json!({"prompt_cache":false})),
        &body,
        &[],
        "input",
    )
    .unwrap_err();
    assert_eq!(
        error.envelope.error.param,
        Some(Some("prompt_cache_options".into()))
    );
    assert!(validate_prompt_cache_controls(&json!({"prompt_cache_options":{"ttl":"1h"}})).is_err());
}
#[test]
fn function_tools_flatten_without_rewriting_custom_namespace() {
    let raw = json!([{"type":"function","name":"top","function":{"name":"nested","parameters":{"type":"object"},"strict":false}},{"type":"namespace","name":"n","tools":[{"type":"custom","name":"exec"}]}]);
    let normalized = normalize_tools_for_codex(&raw);
    assert_eq!(normalized[0]["name"], "top");
    assert_eq!(normalized[0]["strict"], false);
    assert!(normalized[0].get("function").is_none());
    assert_eq!(normalized[1], raw[1]);
}
#[test]
fn ecmascript_numeric_serialization_and_hash_vectors() {
    assert_eq!(
        json_stringify(&json!({"n":-0.0,"i":1.0,"tiny":1e-7,"small":1e-6,"large":1e21})),
        r#"{"n":0,"i":1,"tiny":1e-7,"small":0.000001,"large":1e+21}"#
    );
    assert_eq!(
        sha256(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn body_reader_matches_text_decoder_and_javascript_exponent_overflow() {
    let bytes = b"\xef\xbb\xbf{\"input\":\"\xff\",\"max_output_tokens\":1e400}";
    let body = parse_json_body(bytes).unwrap();
    assert_eq!(body["input"], "\u{fffd}");
    let error = validate_request_fields(
        &body,
        RequestSurface::Responses,
        &RequestExtensions::default(),
    )
    .unwrap_err();
    assert_eq!(
        error.envelope.error.param,
        Some(Some("max_output_tokens".into()))
    );
    assert_eq!(
        json_stringify(&body),
        "{\"input\":\"\u{fffd}\",\"max_output_tokens\":null}"
    );
}

#[test]
fn ecmascript_trim_includes_bom_but_not_next_line_control() {
    assert_eq!(
        resolve_model(Some(&json!("\u{feff} model \u{feff}")), None).unwrap(),
        "model"
    );
    assert_eq!(
        parse_effort(Some(&json!("\u{0085}low\u{0085}")), "reasoning_effort").unwrap(),
        Some("\u{0085}low\u{0085}".into())
    );
}
