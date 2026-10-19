use gateway_core::{
    js_string::JsString16, provider::UpstreamProvider, source_json::SourceJson,
    source_serialization as source,
};
use gateway_providers::{
    AuthMaterial, ClaudeBodyOptions, ClaudeCredentialKind, ClientSurface, PrepareOptions,
    PreparedClaudeBody, prepare_source_request,
};
use serde_json::json;
fn parse(text: &str) -> SourceJson {
    SourceJson::parse(text).unwrap()
}
fn body_options(kind: ClaudeCredentialKind) -> ClaudeBodyOptions {
    let mut options = ClaudeBodyOptions::new(kind);
    options.response_id = "resp_fixture".into();
    options.created_at = 123;
    options
}
#[test]
fn staged_scalar_bodies_and_decode_match_one_legacy_implementation() {
    for surface in [ClientSurface::Responses, ClientSurface::Chat] {
        for kind in [ClaudeCredentialKind::ApiKey, ClaudeCredentialKind::Oauth] {
            for stream in [false, true] {
                let raw=SourceJson::from_serializable(&if surface==ClientSurface::Responses {
                    json!({"model":"claude-fixture","input":"hello","stream":stream})
                } else {json!({"model":"claude-fixture","messages":[{"role":"user","content":"hello"}],"stream":stream})}).unwrap();
                let options = body_options(kind);
                let stage =
                    PreparedClaudeBody::prepare(surface, &raw, &"claude-fixture".into(), &options)
                        .unwrap();
                let scalar = PrepareOptions {
                    auth: AuthMaterial {
                        secret: "actual-scalar-fixture".into(),
                        api_key: kind == ClaudeCredentialKind::ApiKey,
                        workspace_id: Some("wrkspc_fixture".into()),
                        ..Default::default()
                    },
                    response_id: options.response_id.clone(),
                    created_at: options.created_at,
                    ..Default::default()
                };
                let legacy = prepare_source_request(
                    UpstreamProvider::ClaudeCode,
                    surface,
                    &raw,
                    &"claude-fixture".into(),
                    &scalar,
                )
                .unwrap();
                assert_eq!(stage.body(), &legacy.body);
                assert_eq!(
                    serde_json::to_string(stage.decode()).unwrap(),
                    serde_json::to_string(&legacy.decode).unwrap()
                );
                assert_eq!(stage.stream(), stream);
                assert_eq!(stage.kind(), kind);
                assert_eq!(stage.url(), "https://api.anthropic.com/v1/messages");
                assert_eq!(stage.method(), "POST");
                assert!(stage.warnings().is_empty());
                let attribution = source::member(stage.body(), "system")
                    .as_ref()
                    .and_then(source::array)
                    .and_then(|system| {
                        system
                            .first()
                            .and_then(|block| source::member(block, "text"))
                    })
                    .as_ref()
                    .and_then(source::string)
                    .is_some_and(|text| {
                        text == JsString16::from_utf8(
                            gateway_providers::finalize::CLAUDE_ATTRIBUTION,
                        )
                    });
                assert_eq!(attribution, kind == ClaudeCredentialKind::Oauth);
                assert_eq!(
                    legacy.headers.contains_key("x-api-key"),
                    kind == ClaudeCredentialKind::ApiKey
                );
            }
        }
    }
}
#[test]
fn pure_stage_has_no_material_port_and_retains_original_body_error() {
    let raw = parse(r#"{"model":"claude-fixture","input":[]}"#);
    let options = body_options(ClaudeCredentialKind::ApiKey);
    let error = PreparedClaudeBody::prepare(
        ClientSurface::Responses,
        &raw,
        &"claude-fixture".into(),
        &options,
    )
    .unwrap_err();
    let scalar = PrepareOptions {
        auth: AuthMaterial {
            secret: "actual-scalar-fixture".into(),
            api_key: true,
            ..Default::default()
        },
        ..Default::default()
    };
    let legacy = prepare_source_request(
        UpstreamProvider::ClaudeCode,
        ClientSurface::Responses,
        &raw,
        &"claude-fixture".into(),
        &scalar,
    )
    .unwrap_err();
    assert_eq!(error.body(), legacy.body());
    assert_eq!(error.status, 400);
    // No secret/workspace/header exists in the stage/options API, so neither an
    // invalid source secret nor an actual header attempt can preempt this error.
}
#[test]
fn stage_keeps_source_effort_payload_and_actual_disabled_capability() {
    let raw = parse(
        r#"{"model":"claude-fixture","input":"text\ud800","reasoning":{"effort":"vendor\udc00"}}"#,
    );
    let effort = JsString16::from_units("vendor".encode_utf16().chain([0xdc00]).collect());
    let mut options = body_options(ClaudeCredentialKind::Oauth);
    options.native_reasoning_efforts = Some(vec![effort.clone()]);
    let stage = PreparedClaudeBody::prepare(
        ClientSurface::Responses,
        &raw,
        &"claude-fixture".into(),
        &options,
    )
    .unwrap();
    assert_eq!(&stage.decode().request, &raw);
    assert_eq!(
        source::string(
            &source::member(
                &source::member(stage.body(), "output_config").unwrap(),
                "effort"
            )
            .unwrap()
        ),
        Some(effort)
    );
    assert!(stage.body().as_str().contains("\\ud800"));
    let disabled =
        parse(r#"{"model":"claude-fixture","input":"hello","reasoning":{"effort":"none"}}"#);
    assert!(
        PreparedClaudeBody::prepare(
            ClientSurface::Responses,
            &disabled,
            &"claude-fixture".into(),
            &options
        )
        .is_err()
    );
    options.supports_disabled_thinking = true;
    let stage = PreparedClaudeBody::prepare(
        ClientSurface::Responses,
        &disabled,
        &"claude-fixture".into(),
        &options,
    )
    .unwrap();
    assert_eq!(
        source::member(stage.body(), "thinking").unwrap(),
        parse(r#"{"type":"disabled"}"#)
    );
}
#[test]
fn plain_api_body_retains_scalar_golden_bytes_without_attribution() {
    let raw = parse(r#"{"model":"claude-fixture","input":"hello"}"#);
    let stage = PreparedClaudeBody::prepare(
        ClientSurface::Responses,
        &raw,
        &"claude-fixture".into(),
        &body_options(ClaudeCredentialKind::ApiKey),
    )
    .unwrap();
    assert_eq!(
        stage.body().as_str(),
        r#"{"model":"claude-fixture","max_tokens":32000,"messages":[{"role":"user","content":[{"type":"text","text":"hello","cache_control":{"type":"ephemeral"}}]}],"stream":false}"#
    );
}
