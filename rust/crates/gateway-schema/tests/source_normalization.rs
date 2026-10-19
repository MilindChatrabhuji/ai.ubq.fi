//! Pinned Bun source oracles plus neutral construction/error-phase invariants.
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::{
    request::{RequestExtensions, RequestSurface},
    source_request::{self, SourceRequestDocument, SourceRequestError},
};
use serde::{Deserialize, Serialize};
fn raw(text: &str) -> SourceJson {
    SourceJson::parse(text).unwrap()
}
fn document(text: &str) -> SourceRequestDocument {
    SourceRequestDocument::new(raw(text)).unwrap()
}
fn same(actual: &SourceJson, expected: &str) {
    assert_eq!(
        source::canonical(actual).unwrap(),
        source::canonical(&raw(expected)).unwrap()
    )
}
#[derive(Deserialize)]
struct Fixture {
    runtime: String,
    source: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    op: String,
    name: String,
    input: String,
    expected: String,
}
#[test]
fn source_normalization_matches_pinned_bun_utf16_oracles() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/source-normalization-v1.json")).unwrap();
    assert_eq!(fixture.runtime, "bun@1.4.0");
    assert_eq!(fixture.source, "893c14045e9aaaf436fe135a0b7743d3ea3fd9ac");
    assert_eq!(fixture.cases.len(), 17);
    for case in fixture.cases {
        let value = raw(&case.input);
        let result = match case.op.as_str() {
            "content" => source_request::normalize_response_content(&value, "input[0]", "user"),
            "message" => source_request::normalize_response_message(&value, "input[0]"),
            "function" => source_request::normalize_function_output(&value, "input[0]"),
            "chat" => source_request::normalize_chat_message(&value, 0).map(|message| {
                #[derive(Serialize)]
                struct Chat {
                    instruction: Option<JsString16>,
                    #[serde(rename = "instructionContent")]
                    instruction_content: Option<Vec<SourceJson>>,
                    input: Vec<SourceJson>,
                }
                SourceJson::from_serializable(&Chat {
                    instruction: message.instruction,
                    instruction_content: message.instruction_content,
                    input: message.input,
                })
                .unwrap()
            }),
            "cache" => source_request::validate_prompt_cache_controls(&value).map(|()| raw("null")),
            other => panic!("unknown oracle operation {other}"),
        };
        let actual = match result {
            Ok(value) => {
                let mut fields = vec![("ok", raw("true"))];
                if case.op != "cache" {
                    fields.push(("value", value))
                }
                source::object(fields).unwrap()
            }
            Err(error) => {
                let error = source::member(error.body(), "error").unwrap();
                let mut fields = vec![
                    ("ok", raw("false")),
                    ("message", source::member(&error, "message").unwrap()),
                ];
                if let Some(param) = source::member(&error, "param") {
                    fields.push(("param", param))
                }
                source::object(fields).unwrap()
            }
        };
        assert_eq!(
            source::canonical(&actual).unwrap(),
            source::canonical(&raw(&case.expected)).unwrap(),
            "{}: {}",
            case.op,
            case.name
        );
    }
}
#[test]
fn neutral_surface_does_not_prevalidate_direct_chat_or_ordinary_content() {
    let input = r#"{"model":"openrouter/example","messages":[{"role":"vendor","content":{}}],"stream":"native-value"}"#;
    let request = document(input).for_surface(RequestSurface::ChatCompletions);
    assert_eq!(request.original_source(), &raw(input));
    request
        .validate_fields(&RequestExtensions::default())
        .unwrap();
    assert!(request.stream().is_err());
    assert!(request.normalize_chat_for_codex().is_err());
    assert_eq!(request.original_source(), &raw(input));
    let response =
        document(r#"{"model":5,"input":null,"reasoning":5,"instructions":5,"stream":null}"#)
            .for_surface(RequestSurface::Responses);
    assert!(response.stream().is_err());
    assert!(response.model_request().is_err());
    assert!(response.normalize_responses_input().is_err());
    assert!(response.reasoning().is_err());
    assert!(response.instructions().is_err());
}
#[test]
fn envelope_order_matches_source_max_output_parallel_then_max_tool() {
    for (text, expected) in [
        (
            r#"{"max_output_tokens":0,"parallel_tool_calls":null,"max_tool_calls":0}"#,
            "max_output_tokens",
        ),
        (
            r#"{"parallel_tool_calls":null,"max_tool_calls":0}"#,
            "parallel_tool_calls",
        ),
        (r#"{"max_tool_calls":0}"#, "max_tool_calls"),
    ] {
        let request = document(text).for_surface(RequestSurface::Responses);
        let error = request
            .validate_fields(&RequestExtensions::default())
            .unwrap_err();
        let body = source::member(error.body(), "error").unwrap();
        assert_eq!(
            source::string(&source::member(&body, "param").unwrap()).unwrap(),
            JsString16::from_utf8(expected)
        );
    }
}
#[test]
fn original_survives_named_response_and_chat_phases() {
    let text = r#"{"input":"\ud800","instructions":"\udfff","metadata":{"2":1,"2":2}}"#;
    let request = document(text).for_surface(RequestSurface::Responses);
    let output = source::json_array(&request.normalize_responses_input().unwrap()).unwrap();
    same(
        &output,
        r#"[{"type":"message","role":"user","content":[{"type":"input_text","text":"\ud800"}]}]"#,
    );
    assert_eq!(request.original_source(), &raw(text));
    let request=document(r#"{"messages":[{"role":"system","content":" \ud800 "},{"role":"tool","tool_call_id":" \udfff ","content":"\ud800"}]}"#).for_surface(RequestSurface::ChatCompletions);
    let chat = request.normalize_chat_for_codex().unwrap();
    assert_eq!(
        chat.instructions,
        Some(JsString16::from_units(vec![0xd800]))
    );
    same(
        &chat.input[0],
        r#"{"type":"function_call_output","call_id":"\udfff","output":"\ud800"}"#,
    );
}
#[test]
fn reasoning_keeps_open_utf16_tiers_and_opaque_keys() {
    let request=document(r#"{"reasoning":{"effort":" \ud800 ","summary":null,"generate_summary":"\udfff","\ud800":{"n":1e400}}}"#).for_surface(RequestSurface::Responses);
    same(
        &request.reasoning().unwrap().unwrap(),
        r#"{"effort":"\ud800","generate_summary":"\udfff","\ud800":{"n":1e400}}"#,
    );
    let error = document(r#"{"reasoning":{"effort":5,"summary":5}}"#)
        .reasoning()
        .unwrap_err();
    same(
        error.body(),
        r#"{"error":{"message":"reasoning.effort must be a string","type":"invalid_request_error","code":"invalid_request_error","param":"reasoning"}}"#,
    );
}
#[test]
fn public_error_factory_and_scalar_lift_keep_exact_existing_envelope() {
    let error = SourceRequestError::new(
        422,
        JsString16::from_units(vec![0xd800]),
        "existing_type",
        Some("existing_code"),
        Some(Some(JsString16::from_units(vec![0xdfff]))),
    );
    assert_eq!(error.status, 422);
    same(
        error.body(),
        r#"{"error":{"message":"\ud800","type":"existing_type","code":"existing_code","param":"\udfff"}}"#,
    );
    let null = SourceRequestError::new(409, "conflict", "server_error", None, Some(None));
    same(
        null.body(),
        r#"{"error":{"message":"conflict","type":"server_error","param":null}}"#,
    );
    let scalar = GatewayError::new(503, "busy", Some("capacity"))
        .with_type("server_error")
        .with_param(None);
    let expected = SourceJson::from_serializable(&scalar.envelope).unwrap();
    let lifted = SourceRequestError::from_gateway(scalar);
    assert_eq!(lifted.status, 503);
    assert_eq!(lifted.body(), &expected);
}
