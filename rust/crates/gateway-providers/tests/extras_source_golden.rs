//! Golden cases from src/embeddings/voyage.ts, src/images.ts and
//! src/systemone/handlers.ts at 1b7b9737; no live provider calls.
use gateway_core::GatewayError;
use gateway_providers::{extras, types::PrepareOptions};
use serde_json::{Value, json};

fn error(error: GatewayError, message: &str, code: &str, param: Option<Option<&str>>) {
    assert_eq!(error.status, 400);
    assert_eq!(error.envelope.error.message, message);
    assert_eq!(error.envelope.error.code.as_deref(), Some(code));
    assert_eq!(
        error.envelope.error.param.as_ref().map(|v| v.as_deref()),
        param
    );
}

#[test]
fn embeddings_model_is_mandatory_and_never_trimmed_into_a_different_model() {
    for value in [
        json!({"input":"x"}),
        json!({"input":"x","model":null}),
        json!({"input":"x","model":false}),
        json!({"input":"x","model":"\u{feff} "}),
    ] {
        error(
            extras::parse_embeddings(&value, false).unwrap_err(),
            "model is required and must be a non-empty string",
            "invalid_request_error",
            Some(Some("model")),
        );
    }
    error(
        extras::parse_embeddings(&json!({"model":" voyage-4-large","input":"x"}), false)
            .unwrap_err(),
        "Unsupported embedding model:  voyage-4-large",
        "model_not_found",
        Some(Some("model")),
    );
}

#[test]
fn embeddings_scalar_errors_and_precedence_match_source() {
    let cases = [
        (
            json!({"unknown":null}),
            "Unrecognized request argument supplied: unknown",
            None,
        ),
        (
            json!({"dimensions":null}),
            "dimensions must be an integer",
            Some(Some("dimensions")),
        ),
        (
            json!({"dimensions":-1}),
            "dimensions must be one of: 256, 512, 1024, 2048",
            Some(Some("dimensions")),
        ),
        (
            json!({"dimensions":1.5}),
            "dimensions must be an integer",
            Some(Some("dimensions")),
        ),
        (
            json!({"encoding_format":null}),
            "encoding_format must be a string",
            Some(Some("encoding_format")),
        ),
        (
            json!({"encoding_format":"FLOAT"}),
            "encoding_format must be one of: \"float\", \"base64\"",
            Some(Some("encoding_format")),
        ),
        (
            json!({"input_type":null}),
            "input_type must be one of: \"query\", \"document\"",
            Some(Some("input_type")),
        ),
        (
            json!({"truncation":null}),
            "truncation must be a boolean",
            Some(Some("truncation")),
        ),
        (
            json!({"user":1}),
            "user must be a string",
            Some(Some("user")),
        ),
        (
            json!({"input":[]}),
            "input must be a non-empty string or a non-empty array",
            Some(Some("input")),
        ),
        (
            json!({"input":["ok",null]}),
            "input must be a string or an array of strings",
            Some(Some("input")),
        ),
    ];
    for (fields, message, param) in cases {
        let mut value = json!({"model":"voyage-4-large","input":"x"});
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        error(
            extras::parse_embeddings(&value, false).unwrap_err(),
            message,
            "invalid_request_error",
            param,
        );
    }
    let accepted = extras::parse_embeddings(
        &json!({"model":"voyage-4-large","input":"","dimensions":256.0,"user":null}),
        false,
    )
    .unwrap();
    assert_eq!(
        accepted.inputs,
        [gateway_core::js_string::JsString16::from_utf8("")]
    );
    assert_eq!(accepted.dimensions, 256);
    assert_eq!(accepted.input_type, "document");
    assert_eq!(
        accepted.cache_profile_key,
        "[\"voyage-profile-v2\",\"voyage-4-large\",\"document\",256,\"float\",\"float\",true]"
    );
}

#[test]
fn embeddings_job_requires_input_type_and_float_format() {
    error(
        extras::parse_embeddings(&json!({"model":"voyage-4-large","input":"x"}), true).unwrap_err(),
        "input_type is required and must be one of: \"query\", \"document\"",
        "invalid_request_error",
        Some(Some("input_type")),
    );
    error(
        extras::parse_embeddings(
            &json!({"model":"voyage-4-large","input":"x","encoding_format":"base64"}),
            true,
        )
        .unwrap_err(),
        "encoding_format must be \"float\" for embeddings jobs",
        "invalid_request_error",
        Some(Some("encoding_format")),
    );
    error(
        extras::parse_embeddings(
            &json!({"model":"voyage-4-large","input":"x","user":null}),
            true,
        )
        .unwrap_err(),
        "Unrecognized request argument supplied: user",
        "invalid_request_error",
        None,
    );
}

#[test]
fn embeddings_limits_use_utf16_characters_and_utf8_token_estimates() {
    error(
        extras::parse_embeddings(
            &json!({"model":"voyage-4-large","input":vec!["x";129]}),
            false,
        )
        .unwrap_err(),
        "Too many inputs: 129 (max 128)",
        "invalid_request_error",
        Some(Some("input")),
    );
    error(
        extras::parse_embeddings(
            &json!({"model":"voyage-4-large","input":"😀".repeat(10_001)}),
            false,
        )
        .unwrap_err(),
        "Input too large: 20002 chars (max 20000)",
        "invalid_request_error",
        Some(Some("input")),
    );
    error(
        extras::parse_embeddings(
            &json!({"model":"voyage-4-large","input":vec!["x".repeat(20_000);6]}),
            false,
        )
        .unwrap_err(),
        "Request too large: 120000 chars total (max 100000)",
        "invalid_request_error",
        Some(Some("input")),
    );
    error(
        extras::parse_embeddings(
            &json!({"model":"voyage-4-large","input":"界".repeat(20_000)}),
            false,
        )
        .unwrap_err(),
        "Input too large for embeddings provider: ~15000 tokens (max 10000).",
        "invalid_request_error",
        Some(Some("input")),
    );
}

#[test]
fn image_reference_urls_preserve_source_case_normalization_and_url_validation() {
    for url in [
        "https://example.com/a",
        "HtTpS://EXAMPLE.COM:443/a",
        "http:////example.com/a",
        "\u{feff} https://example.com/a \u{feff}",
    ] {
        let result = extras::normalize_image_reference(&json!({"image_url":url}), false).unwrap();
        assert_eq!(
            result["image_url"],
            if url.starts_with('\u{feff}') {
                "https://example.com/a"
            } else {
                url
            }
        );
    }
    for value in [
        json!({}),
        json!({"image_url":"http://"}),
        json!({"image_url":"https://example.com:99999/a"}),
        json!({"image_url":"https://exa mple.com/a"}),
        json!({"image_url":"/relative"}),
        json!({"image_url":"file:///tmp/a.png"}),
        json!({"image_url":"https://x/a","file_id":"x"}),
    ] {
        error(
            extras::normalize_image_reference(&value, false).unwrap_err(),
            "Each image must contain one image_url with a fully qualified HTTP(S) URL or supported base64 data URL; file_id is unsupported by this gateway.",
            "invalid_request_error",
            Some(Some("images")),
        );
    }
}

#[test]
fn image_base64_uses_source_syntax_without_inventing_a_canonical_padding_rule() {
    for url in [
        "DATA:IMAGE/X-PNG;BASE64,AA==",
        "data: image/png ;BaSe64,AB==",
        "data:image/png;base64,AAAA",
    ] {
        let normalized =
            extras::normalize_image_reference(&json!({"image_url":url}), false).unwrap();
        assert!(
            normalized["image_url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
    }
    for url in [
        "data:image/png;base64,",
        "data:image/png;base64,AAA",
        "data:image/png;base64,=AAA",
        "data:image/png;base64,AA=A",
        "data:image/png;base64,A===",
        "data:image/png;base64,AAAA====",
        "data:image/png;foo;base64,AAAA",
        "data:image/gif;base64,AAAA",
    ] {
        assert!(
            extras::normalize_image_reference(&json!({"image_url":url}), false).is_err(),
            "{url}"
        );
    }
    assert!(
        extras::normalize_image_reference(&json!({"image_url":"DATA:IMAGE/PNG;BASE64,AB=="}), true)
            .is_ok()
    );
    for url in [
        "https://example.com/mask.png",
        "data:image/jpeg;base64,AAAA",
    ] {
        let failure =
            extras::normalize_image_reference(&json!({"image_url":url}), true).unwrap_err();
        assert_eq!(failure.envelope.error.param, Some(Some("mask".to_owned())));
    }
}

#[test]
fn image_unknown_null_fields_fail_before_scalar_validation_and_nullable_options_disappear() {
    error(
        extras::prepare_image(
            &json!({"prompt":"x","input_fidelity":null}),
            "gpt-base",
            false,
            "request",
        )
        .unwrap_err(),
        "Unsupported image generations field: input_fidelity.",
        "invalid_request_error",
        Some(Some("input_fidelity")),
    );
    error(
        extras::prepare_image(
            &json!({"prompt":"x","style":null}),
            "gpt-base",
            true,
            "request",
        )
        .unwrap_err(),
        "Unsupported image edits field: style.",
        "invalid_request_error",
        Some(Some("style")),
    );
    let plan = extras::prepare_image(
        &json!({"prompt":"x","quality":null,"style":null,"n":1.0,"output_compression":50.0}),
        "gpt-base",
        false,
        "request",
    )
    .unwrap();
    assert_eq!(plan.count, 1);
    assert!(
        scalar_source(&plan.responses)["tools"][0]
            .get("quality")
            .is_none()
    );
    error(
        extras::prepare_image(&Value::Null, "gpt-base", false, "request").unwrap_err(),
        "Image requests must use an object body.",
        "invalid_request_error",
        Some(None),
    );
}

#[test]
fn image_scalar_error_order_and_child_identity_follow_source() {
    error(
        extras::prepare_image(
            &json!({"prompt":"x","quality":"bad","output_compression":101}),
            "gpt-base",
            false,
            "request",
        )
        .unwrap_err(),
        "output_compression must be an integer from 0 to 100.",
        "invalid_request_error",
        Some(Some("output_compression")),
    );
    error(
        extras::prepare_image(
            &json!({"prompt":"x","quality":"bad","size":""}),
            "gpt-base",
            true,
            "request",
        )
        .unwrap_err(),
        "size must be a non-empty string.",
        "invalid_request_error",
        Some(Some("size")),
    );
    let plan = extras::prepare_image(
        &json!({"prompt":"😀".repeat(32_000),"n":3}),
        "gpt-base",
        false,
        "request",
    )
    .unwrap();
    assert_eq!(
        plan.request_ids,
        [
            "request",
            "request:image:generations:2",
            "request:image:generations:3"
        ]
    );
    assert!(plan.codex_only);
}

#[test]
fn systemone_default_and_exact_error_envelopes_follow_source() {
    let request = json!({"state":{},"questions":{"go":{"type":"noul"}}});
    let prepared = extras::prepare_systemone(&request, &PrepareOptions::default()).unwrap();
    assert_eq!(scalar(&prepared.body)["model"], "~typesafe/jev-latest");
    for value in [Value::Null, json!([])] {
        error(
            extras::prepare_systemone(&value, &PrepareOptions::default()).unwrap_err(),
            "Invalid JSON body",
            "invalid_request_error",
            None,
        );
    }
    let mut invalid = request.clone();
    invalid["model"] = json!("other/model");
    error(
        extras::prepare_systemone(&invalid, &PrepareOptions::default()).unwrap_err(),
        "model must be a typesafe model id",
        "invalid_request_error",
        None,
    );
    invalid["model"] = Value::Null;
    error(
        extras::prepare_systemone(&invalid, &PrepareOptions::default()).unwrap_err(),
        "model must be a string",
        "invalid_request_error",
        None,
    );
    let failure = extras::decode_systemone(&json!({"answers":null})).unwrap_err();
    assert_eq!(failure.status, 502);
    assert_eq!(failure.envelope.error.error_type, "invalid_request_error");
}

#[test]
fn opaque_image_parse_precedes_host_model_resolution_and_keeps_operation_kind() {
    let parsed = extras::parse_image(&json!({"prompt":"image","n":2}), false).unwrap();
    assert_eq!(parsed.count(), 2);
    let plan = extras::prepare_parsed_image(&parsed, &"host".into(), "original");
    assert_eq!(
        scalar_source(&plan.responses)["tools"][0]["action"],
        "generate"
    );
    assert!(extras::parse_image(&json!({"prompt":"image","n":0}), false).is_err());
}

#[test]
fn multipart_scalar_strings_follow_source_grammar_and_fail_before_file_validation() {
    let file = extras::MultipartFile {
        name: "image".into(),
        filename: "image.png".into(),
        content_type: "image/png".into(),
        bytes: vec![1],
    };
    let parsed = extras::parse_multipart_image(&json!({"prompt":"image","n":" 2 ","stream":"false","output_compression":"1e2","response_format":"b64_json"}), std::slice::from_ref(&file)).unwrap();
    let plan = extras::prepare_parsed_image(&parsed, &"host".into(), "original");
    assert_eq!(plan.count, 2);
    assert_eq!(scalar_source(&plan.responses)["tools"][0]["action"], "edit");
    assert_eq!(
        scalar_source(&plan.responses)["tools"][0]["output_compression"],
        100.0
    );
    for n in ["01", "1e0", "+1", "1.0"] {
        assert!(
            extras::parse_multipart_image(
                &json!({"prompt":"image","n":n}),
                std::slice::from_ref(&file)
            )
            .is_err()
        );
    }
    error(
        extras::parse_multipart_image(&json!({"prompt":"image","n":"0"}), &[]).unwrap_err(),
        "n must be an integer from 1 to 10.",
        "invalid_request_error",
        Some(Some("n")),
    );
    error(
        extras::parse_multipart_image(&json!({"prompt":"image","moderation":"auto"}), &[])
            .unwrap_err(),
        "Unsupported image edit field: moderation.",
        "invalid_request_error",
        Some(Some("moderation")),
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
