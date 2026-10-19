use gateway_core::{model::ModelId, source_json::SourceJson, source_serialization as source};
use gateway_routing_runtime::classify;

#[test]
fn unsupported_model_keeps_source_utf16_and_never_becomes_a_quota_signal() {
    let model =
        ModelId::from_source(source::string(&SourceJson::parse(r#""\ud800""#).unwrap()).unwrap());
    let body=br#"{"detail":"The '\ud800' model is not supported when using Codex with a ChatGPT account."}"#;
    let detail = classify::unsupported_model(Some(400), body, true, &model).unwrap();
    assert!(detail.as_units().contains(&0xd800));
    assert!(classify::unsupported_model(Some(429), body, true, &model).is_none());
    assert!(classify::unsupported_model(Some(500), body, true, &model).is_none());
    assert!(classify::unsupported_model(Some(400), body, false, &model).is_none());
    assert!(
        classify::unsupported_model(Some(400), body, true, &ModelId::from_scalar("other"))
            .is_none()
    );
    assert!(
        classify::codex_quota(
            Some(400),
            &Default::default(),
            body,
            true,
            1_800_000_000_000
        )
        .is_none()
    );
}
#[test]
fn source_unavailability_proof_still_requires_complete_unambiguous_exact_detail() {
    let model = ModelId::from_scalar("gpt-test");
    for body in [
        r#"{"detail":"The 'gpt-test' model is not supported when using Codex with a ChatGPT account.","detail":"The 'gpt-test' model is not supported when using Codex with a ChatGPT account."}"#,
        r#"{"detail":"The 'gpt-test' model is not supported when using Codex with a ChatGPT account.","nested":{"\ud800":1,"\ud800":2}}"#,
        r#"{"detail":"The 'gpt-test' model is not supported when using Codex with a ChatGPT account.","nested":{"x":1,"\u0078":2}}"#,
        r#"{"error":{"code":"model_not_supported"}}"#,
        r#"{"detail":"The 'gpt-test' model is not supported when using Codex with a ChatGPT account."} trailing"#,
    ] {
        assert!(classify::unsupported_model(Some(400), body.as_bytes(), true, &model).is_none());
    }
    let complete=br#" {"detail":"The 'gpt-test' model is not supported when using Codex with a ChatGPT account."} "#;
    assert!(classify::unsupported_model(Some(400), complete, true, &model).is_some());
}
