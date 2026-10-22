//! Runtime-facing Claude native replay publication and PrepareOptions restoration.
use gateway_core::model::ModelId;
use gateway_core::provider::UpstreamProvider;
use gateway_core::source_json::SourceJson;
use gateway_providers::{
    AuthMaterial, ClientSurface, PrepareOptions, ToolMap, anthropic, prepare_source_request, replay,
};
use serde_json::{Value, json};

fn scalar(value: &SourceJson) -> Value {
    value.deserialize().unwrap()
}

fn source(value: &Value) -> SourceJson {
    SourceJson::from_serializable(value).unwrap()
}

fn sources(values: &[Value]) -> Vec<SourceJson> {
    values.iter().map(source).collect()
}

fn context() -> replay::ReplayContext {
    replay::ReplayContext {
        scope: "key-a".into(),
        provider: "surplus".into(),
        model: "claude-fixture".into(),
    }
}

fn messages_output() -> Vec<Value> {
    vec![
        json!({"id":"rs_resp_replay_0","type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]}),
        json!({"id":"msg_resp_replay_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"answer"}]}),
        json!({"id":"fc_resp_replay_2","type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}),
    ]
}

fn raw_request(output: &[Value]) -> Value {
    let mut input = vec![
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"read"}]}),
    ];
    input.extend(output.iter().cloned());
    input.push(json!({"type":"function_call_output","call_id":"call_1","output":[{"type":"input_text","text":"file"}]}));
    input.push(
        json!({"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}),
    );
    json!({
        "model": "claude-fixture",
        "max_output_tokens": 16,
        "input": input,
        "tools": [{"type":"function","name":"read_file","parameters":{"type":"object"}}]
    })
}

#[test]
fn decoded_messages_replay_publishes_and_restores_through_prepare_options() {
    let context = context();
    let output = messages_output();
    let native = json!({"role":"assistant","content":[
        {"type":"thinking","thinking":"thought","signature":"private-signature"},
        {"type":"text","text":"answer"},
        {"type":"tool_use","id":"call_1","name":"read_file","input":{"path":"a.txt"}}
    ]});
    let mut store = replay::ReplayStore::default();
    assert!(store.remember_decoded_native(
        context.clone(),
        &sources(&output),
        source(&native),
        replay::ReplayTransport::Messages,
        &ToolMap::new(),
        1,
    ));
    let raw = raw_request(&output);
    let raw_source = SourceJson::from_serializable(&raw).unwrap();
    let mut options = PrepareOptions::default();
    assert!(store.restore_prepare_options(
        &context,
        &raw_source,
        &mut options,
        replay::ReplayTransport::Messages,
        2,
    ));
    let body = scalar(&anthropic::try_native_messages(&raw, &options).unwrap());
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][1]["role"], "assistant");
    assert_eq!(body["messages"][1]["content"][0]["type"], "thinking");
    assert_eq!(
        body["messages"][1]["content"][0]["signature"],
        "private-signature"
    );
    assert_eq!(body["messages"][1]["content"][1]["text"], "answer");
    assert_eq!(body["messages"][1]["content"][2]["type"], "tool_use");
    assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
    assert_eq!(body["messages"][2]["content"][1]["text"], "continue");
}

#[test]
fn decoded_chat_replay_keeps_reasoning_details_and_tool_calls_through_prepare_options() {
    let context = context();
    let output = messages_output();
    let native = json!({
        "role":"assistant",
        "content":"answer",
        "reasoning_details":[{"type":"reasoning.text","text":"thought","signature":"private-chat-signature"}],
        "tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]
    });
    let mut store = replay::ReplayStore::default();
    assert!(store.remember_decoded_native(
        context.clone(),
        &sources(&output),
        source(&native),
        replay::ReplayTransport::Chat,
        &ToolMap::new(),
        1,
    ));
    let raw = raw_request(&output);
    let raw_source = SourceJson::from_serializable(&raw).unwrap();
    let mut options = PrepareOptions::default();
    assert!(store.restore_prepare_options(
        &context,
        &raw_source,
        &mut options,
        replay::ReplayTransport::Chat,
        2,
    ));
    let body = scalar(&anthropic::try_claude_chat(&raw, &options).unwrap().body);
    assert_eq!(body["messages"][1]["role"], "assistant");
    assert_eq!(body["messages"][1]["content"], "answer");
    assert_eq!(
        body["messages"][1]["reasoning_details"][0]["signature"],
        "private-chat-signature"
    );
    assert_eq!(body["messages"][1]["tool_calls"][0]["id"], "call_1");
    let mut invalid = native;
    invalid["reasoning_details"][0]["signature"] = json!("");
    assert!(!replay::ReplayStore::default().remember_decoded_native(
        context,
        &sources(&output),
        source(&invalid),
        replay::ReplayTransport::Chat,
        &ToolMap::new(),
        1,
    ));
}

#[test]
fn lone_surrogate_native_replay_survives_prepare_source_request() {
    let context = context();
    let native =
        SourceJson::parse(r#"{"role":"assistant","content":[{"type":"text","text":"\ud800"}]}"#)
            .unwrap();
    let output = vec![
        SourceJson::parse(
            r#"{"id":"msg_resp_lone_0","type":"message","role":"assistant","content":[{"type":"output_text","text":"\ud800"}]}"#,
        )
        .unwrap(),
    ];
    let raw = SourceJson::parse(
        r#"{"model":"claude-fixture","max_output_tokens":16,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"\ud800"}]},{"id":"msg_resp_lone_0","type":"message","role":"assistant","content":[{"type":"output_text","text":"\ud800"}]}]}"#,
    )
    .unwrap();
    let mut store = replay::ReplayStore::default();
    assert!(store.remember_decoded_native(
        context.clone(),
        &output,
        native,
        replay::ReplayTransport::Messages,
        &ToolMap::new(),
        1,
    ));
    let mut options = PrepareOptions {
        auth: AuthMaterial {
            secret: "fixture-secret".into(),
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(store.restore_prepare_options(
        &context,
        &raw,
        &mut options,
        replay::ReplayTransport::Messages,
        2,
    ));
    let prepared = prepare_source_request(
        UpstreamProvider::Surplus,
        ClientSurface::Responses,
        &raw,
        &ModelId::from_scalar("claude-fixture"),
        &options,
    )
    .unwrap();
    let body = prepared.body.as_str();
    assert!(
        body.contains("\\ud800") || body.contains("\\uD800"),
        "{body}"
    );
    assert!(!body.contains("fffd"), "{body}");
}
