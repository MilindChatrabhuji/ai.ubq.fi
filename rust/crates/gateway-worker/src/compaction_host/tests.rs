use super::*;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
struct Golden {
    source_blob: String,
    cases: Vec<WireCase>,
}
#[derive(Deserialize)]
struct WireCase {
    name: String,
    state: String,
    questions: String,
    url: String,
    headers: BTreeMap<String, String>,
    body: String,
}

#[test]
fn compaction_host_jev_wire_matches_frozen_source_sdk_without_route_restrictions() {
    let fixture: Golden = serde_json::from_str(include_str!("source_golden.json")).unwrap();
    assert_eq!(
        fixture.source_blob,
        "f2cf7a41e7c59e73bf5db9604027c4c42a0b15cb"
    );
    assert_eq!(fixture.cases.len(), 4);
    for case in fixture.cases {
        let actual = jev_request(
            &SourceJson::parse(&case.state).unwrap(),
            &SourceJson::parse(&case.questions).unwrap(),
            "fixture-key",
        )
        .unwrap();
        assert_eq!(actual.url, case.url, "{}", case.name);
        assert_eq!(actual.headers, case.headers, "{}", case.name);
        assert_eq!(
            String::from_utf8(actual.body).unwrap(),
            case.body,
            "{}",
            case.name
        );
        assert!(!actual.headers.contains_key("accept"));
    }
}

fn residue() -> SourceJson {
    SourceJson::parse(r#"{"model":"gpt-oss-120b","stream":false,"reasoning_effort":"medium","max_completion_tokens":16000,"messages":[{"role":"user","content":"fixture \ud800"}]}"#).unwrap()
}

#[test]
fn compaction_host_residue_keeps_fixed_buffered_body_and_source_token_field() {
    let input = residue();
    let request = residue_request(&input, "fixture-key").unwrap();
    assert_eq!(request.url, "https://api.cerebras.ai/v1/chat/completions");
    assert_eq!(request.body, input.as_bytes());
    assert_eq!(
        request.headers.get("accept").map(String::as_str),
        Some("application/json")
    );
    assert_eq!(
        request.headers.get("authorization").map(String::as_str),
        Some("Bearer fixture-key")
    );
    assert!(
        String::from_utf8(request.body)
            .unwrap()
            .contains("max_completion_tokens")
    );
}

#[test]
fn compaction_host_residue_cannot_choose_provider_model_options_or_destination() {
    let source = json!({"model":"gpt-oss-120b","stream":false,"reasoning_effort":"medium","max_completion_tokens":16000,"messages":[{"role":"user","content":"fixture"}]});
    for (key, value) in [
        ("model", json!("another-model")),
        ("stream", json!(true)),
        ("reasoning_effort", json!("high")),
        ("max_completion_tokens", json!(16001)),
        ("url", json!("https://caller.invalid")),
        ("max_tokens", json!(16000)),
    ] {
        let mut body = source.clone();
        body[key] = value;
        assert!(
            residue_request(
                &SourceJson::from_serializable(&body).unwrap(),
                "fixture-key"
            )
            .is_err(),
            "{key}"
        );
    }
    let mut body = source;
    body["messages"][0]["role"] = json!("assistant");
    assert!(
        residue_request(
            &SourceJson::from_serializable(&body).unwrap(),
            "fixture-key"
        )
        .is_err()
    );
}

#[test]
fn compaction_host_jev_parser_returns_full_raw_payload_and_does_not_clamp_noul() {
    let body =
        br#"{"answers":{"call_t0":{"noul":2.5}},"usage":{"input_tokens":4},"extra":"\ud800"}"#;
    let parsed = parse_response(Call::Jev, 200, body).unwrap();
    assert_eq!(parsed.as_bytes(), body);
    let answers = member(&parsed, "answers").unwrap();
    assert_eq!(
        member(&member(&answers, "call_t0").unwrap(), "noul")
            .unwrap()
            .deserialize::<f64>()
            .unwrap(),
        2.5
    );
    assert_eq!(
        member(&parsed, "extra")
            .unwrap()
            .deserialize::<JsString16>()
            .unwrap()
            .as_units(),
        &[0xd800]
    );
    assert!(parse_response(Call::Jev, 200, br#"{"answers":[]}"#).is_ok());
    assert!(parse_response(Call::Jev, 200, br#"{"answers":null,"answers":{}}"#).is_ok());
}

#[test]
fn compaction_host_jev_parser_rejects_actual_source_shape_failures() {
    for input in [
        "null",
        "[]",
        "{}",
        "{\"answers\":null}",
        "{\"answers\":false}",
        "{\"answers\":\"no\"}",
    ] {
        let error = parse_response(Call::Jev, 200, input.as_bytes()).unwrap_err();
        assert_eq!(
            error.envelope.error.message,
            "Jev response is missing answers"
        );
    }
    let error = parse_response(Call::Jev, 200, b"not-json").unwrap_err();
    assert_eq!(error.envelope.error.message, "Jev returned malformed JSON");
}

#[test]
fn compaction_host_source_response_text_bom_and_utf8_decoding_keep_utf16_escapes() {
    let mut bytes = b"\xef\xbb\xbf{\"answers\":{},\"text\":\"".to_vec();
    bytes.extend_from_slice(b"\xff\"}");
    let parsed = parse_response(Call::Jev, 200, &bytes).unwrap();
    assert_eq!(
        member(&parsed, "text")
            .unwrap()
            .deserialize::<String>()
            .unwrap(),
        "\u{fffd}"
    );
}

#[test]
fn compaction_host_http_failures_never_echo_provider_body_or_request_material() {
    for call in [Call::Jev, Call::Residue] {
        for status in [302, 400, 401, 429, 500] {
            let error =
                parse_response(call, status, b"synthetic-secret-or-transcript").unwrap_err();
            assert_eq!(error.status, 502);
            assert!(error.envelope.error.message.contains(&status.to_string()));
            assert!(!error.envelope.error.message.contains("synthetic-secret"));
        }
    }
}

#[test]
fn compaction_host_original_cancellation_wins_over_child_deadline_and_never_mints_proof() {
    for call in [Call::Jev, Call::Residue] {
        for child in [false, true] {
            let error = interruption(true, child, call, 30_000).unwrap();
            assert_eq!(error.status, 499);
            assert_eq!(
                error.envelope.error.code.as_deref(),
                Some("request_cancelled")
            );
        }
        let timeout = interruption(false, true, call, 30_000).unwrap();
        assert_eq!(timeout.status, 502);
        assert!(timeout.envelope.error.code.unwrap().ends_with("timeout"));
        assert!(interruption(false, false, call, 30_000).is_none());
    }
}

#[test]
fn compaction_host_residue_returns_full_chat_or_null_for_algorithm_owned_best_effort() {
    let full =
        br#"{"choices":[{"message":{"content":"full fixture"}}],"usage":{"total_tokens":7}}"#;
    assert_eq!(
        parse_response(Call::Residue, 200, full).unwrap().as_bytes(),
        full
    );
    assert_eq!(
        parse_response(Call::Residue, 200, b"null")
            .unwrap()
            .as_str(),
        "null"
    );
    assert!(parse_response(Call::Residue, 200, b"{bad").is_err());
    let value: Value = parse_response(Call::Residue, 200, full)
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(value["usage"]["total_tokens"], 7);
}
