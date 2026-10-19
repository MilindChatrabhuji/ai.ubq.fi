//! Exact source forwarding seams, not an aggregate request tokenizer or runtime dispatch proof.
use gateway_core::provider::UpstreamProvider;
use gateway_providers::{
    AuthMaterial, ChatProfile, ClientSurface, PrepareOptions, chat, prepare_request,
};
use serde_json::{Value, json};

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/forwarding-unicode-source-v1.json")).unwrap()
}
fn with_emoji(prefix: String) -> String {
    let length = prefix.encode_utf16().count();
    prefix + "😀" + &"a".repeat(chat::FORWARD_LIMIT + 1024 - length - 2)
}
fn input(index: usize) -> String {
    match index {
        0 => with_emoji("a".repeat(chat::FORWARD_LIMIT - 1)),
        1 => with_emoji("é".repeat(10_000) + &"a".repeat(43_082)),
        2 => with_emoji("é".repeat(6_552) + &"a".repeat(46_530)),
        3 => "a".repeat(chat::FORWARD_LIMIT + 1024),
        4 => "é".repeat(chat::FORWARD_LIMIT + 1024),
        _ => panic!("unknown frozen source seam"),
    }
}
fn request(text: &str, truncation: Option<&str>) -> Value {
    let mut value = json!({"model":"deepseek-flash","input":[
        {"type":"function_call","name":"read_file","arguments":"{}","call_id":"call_unicode"},
        {"type":"function_call_output","call_id":"call_unicode","output":text}
    ]});
    if let Some(truncation) = truncation {
        value["truncation"] = json!(truncation);
    }
    value
}

#[test]
fn source_bmp_prefix_is_exactly_31343_code_units() {
    let result = chat::project_responses(
        &request(&input(4), None),
        "deepseek-flash",
        false,
        ChatProfile::Deepseek,
    )
    .unwrap();
    let body = scalar(&result.body);
    let content = body["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_str()
        .unwrap();
    let prefix = &content[..content.find("\n[gateway:").unwrap()];
    assert_eq!(prefix.encode_utf16().count(), 31_343);
}

#[test]
fn five_source_unicode_seams_match_exact_prefix_marker_counts_and_call_id() {
    let golden = golden();
    assert_eq!(golden["policy"]["version"], chat::FORWARD_VERSION);
    assert_eq!(golden["policy"]["perMessageLimit"], chat::FORWARD_LIMIT);
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 5);
    for (index, case) in cases.iter().enumerate() {
        let text = input(index);
        let units: Vec<u16> = text.encode_utf16().collect();
        let head =
            String::from_utf16(&units[..case["headUnits"].as_u64().unwrap() as usize]).unwrap();
        let expected = head.clone() + case["marker"].as_str().unwrap();
        for truncation in [None, Some("auto")] {
            for profile in [
                ChatProfile::Deepseek,
                ChatProfile::Lithos,
                ChatProfile::Cerebras,
            ] {
                let raw = request(&text, truncation);
                let before = raw.clone();
                let result =
                    chat::project_responses(&raw, "deepseek-flash", false, profile).unwrap();
                let body = scalar(&result.body);
                let tool = body["messages"].as_array().unwrap().last().unwrap();
                assert_eq!(tool["role"], "tool");
                assert_eq!(tool["tool_call_id"], "call_unicode");
                assert_eq!(
                    tool["content"].as_str().unwrap(),
                    expected,
                    "{} {truncation:?} {profile:?}",
                    case["name"]
                );
                assert_eq!(raw, before, "projection must not mutate replay history");
                assert!(expected.len() <= chat::FORWARD_LIMIT);
                assert!(text.starts_with(&head));
                assert_eq!(result.elisions.len(), 1);
                let actual = &result.elisions[0];
                let source = &case["elision"];
                assert_eq!(actual.path, source["path"].as_str().unwrap());
                assert_eq!(
                    actual
                        .call_id
                        .as_ref()
                        .map(|id| id.try_utf8().unwrap())
                        .as_deref(),
                    source["callId"].as_str()
                );
                assert_eq!(actual.kind, source["kind"].as_str().unwrap());
                assert_eq!(
                    actual.original_bytes,
                    source["originalBytes"].as_u64().unwrap() as usize
                );
                assert_eq!(
                    actual.forwarded_bytes,
                    source["forwardedBytes"].as_u64().unwrap() as usize
                );
                assert_eq!(
                    actual.omitted_bytes,
                    source["omittedBytes"].as_u64().unwrap() as usize
                );
            }
        }
    }
}

#[test]
fn in_budget_unicode_is_verbatim_for_every_reduction_setting() {
    let text = "é😀".repeat(10_000);
    for truncation in [None, Some("auto"), Some("disabled")] {
        let raw = request(&text, truncation);
        let result =
            chat::project_responses(&raw, "deepseek-flash", false, ChatProfile::Deepseek).unwrap();
        assert_eq!(
            scalar(&result.body)["messages"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["content"],
            text
        );
        assert!(result.elisions.is_empty());
    }
}

#[test]
fn disabled_unicode_refuses_preparation_with_exact_source_error() {
    let expected = golden()["disabled"].clone();
    let raw = request(&input(2), Some("disabled"));
    let options = PrepareOptions {
        auth: AuthMaterial {
            secret: "synthetic-no-dispatch".into(),
            ..Default::default()
        },
        ..Default::default()
    };
    for (provider, model) in [
        (UpstreamProvider::Deepseek, "deepseek-flash"),
        (
            UpstreamProvider::Lithos,
            gateway_providers::request::LITHOS_MODELS[0],
        ),
    ] {
        let mut current = raw.clone();
        current["model"] = json!(model);
        let error = match prepare_request(provider, ClientSurface::Responses, &current, &options) {
            Ok(_) => panic!("disabled reduction must not produce a dispatchable request"),
            Err(error) => error,
        };
        assert_eq!(error.status, 400);
        assert_eq!(
            error.envelope.error.message,
            expected["message"].as_str().unwrap()
        );
        assert_eq!(
            error.envelope.error.code.as_deref(),
            expected["code"].as_str()
        );
        assert_eq!(
            error
                .envelope
                .error
                .param
                .as_ref()
                .and_then(Option::as_deref),
            expected["param"].as_str()
        );
    }
}

fn scalar(value: &gateway_core::source_json::SourceJson) -> serde_json::Value {
    value
        .deserialize()
        .expect("This frozen regression fixture has scalar text")
}
