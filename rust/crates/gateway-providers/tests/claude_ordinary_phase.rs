//! One source ordinary outcome is visible before real selected-account capability lookup.
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_providers::{
    ClaudeBodyOptions, ClaudeCredentialKind, ClientSurface, OrdinaryPhaseOptions,
    OrdinaryPreparationContext, PreparedClaudeBody, PreparedClaudeOrdinary,
};
use gateway_schema::{catalog::RequestModelMetadata, reasoning::ModelReasoning};
use serde_json::json;
fn raw(text: &str) -> SourceJson {
    SourceJson::parse(text).unwrap()
}
fn phase_options(record: SourceJson, default: &str) -> OrdinaryPhaseOptions {
    let metadata = RequestModelMetadata {
        snapshot: None,
        reasoning: ModelReasoning::from_record(Some(&record)),
        record: Some(record),
        supported_endpoints: None,
    };
    OrdinaryPhaseOptions {
        allowed_models: vec![],
        ordinary_preparation: Some(OrdinaryPreparationContext::from_metadata(
            &metadata,
            &default.into(),
        )),
    }
}
fn fixture_phase_options() -> OrdinaryPhaseOptions {
    // Exact positive controlled catalog: medium/high observed plus disabled support.
    phase_options(SourceJson::from_serializable(&json!({"supported_reasoning_levels":["none","medium","high"],"default_reasoning_level":"none"})).unwrap(),"medium")
}
fn selected_capabilities(efforts: &[&str], disabled: bool) -> ClaudeBodyOptions {
    let mut options = ClaudeBodyOptions::new(ClaudeCredentialKind::ApiKey);
    options.native_reasoning_efforts = Some(efforts.iter().map(|value| (*value).into()).collect());
    options.supports_disabled_thinking = disabled;
    options
}
fn original() -> SourceJson {
    raw(r#"{"model":"claude-sonnet-4-5","input":"fixture:matrix:claude:stream","stream":true}"#)
}
#[test]
fn effective_omitted_default_is_observed_before_capabilities_and_finalized_once() {
    let original = original();
    let initial_phase_options = fixture_phase_options();
    // Before correction the account selector sees original omitted reasoning and
    // supplies empty capabilities. The existing guard must continue to refuse it.
    let mut before = selected_capabilities(&[], false);
    before.ordinary_preparation = initial_phase_options.ordinary_preparation.clone();
    assert!(
        PreparedClaudeBody::prepare(
            ClientSurface::Responses,
            &original,
            &"claude-sonnet-4-5".into(),
            &before
        )
        .is_err()
    );
    let phase = PreparedClaudeOrdinary::prepare(
        ClientSurface::Responses,
        &original,
        &"claude-sonnet-4-5".into(),
        &initial_phase_options,
    )
    .unwrap();
    assert_eq!(
        phase.effective_effort(),
        Some(&JsString16::from_utf8("medium"))
    );
    assert_eq!(phase.surface(), ClientSurface::Responses);
    assert_eq!(phase.model(), &"claude-sonnet-4-5".into());
    // Only after the phase outcome is available does the caller provide actual
    // same-account observed medium/high support; the phase contains no such proof.
    let mut observed = selected_capabilities(&["medium", "high"], true);
    // A finalizer that wrongly reruns normalization would inject this different
    // default and fail. It must consume the phase, not read phase inputs again.
    observed.ordinary_preparation = phase_options(
        SourceJson::from_serializable(&json!({})).unwrap(),
        "must-not-run-twice",
    )
    .ordinary_preparation;
    let prepared = PreparedClaudeBody::from_ordinary(phase, &original, &observed).unwrap();
    assert!(prepared.stream());
    assert_eq!(prepared.decode().request, original);
    let output = source::member(prepared.body(), "output_config").unwrap();
    assert_eq!(
        source::string(&source::member(&output, "effort").unwrap()),
        Some("medium".into())
    );
    assert!(source::member(&prepared.decode().request, "reasoning").is_none());
}
#[test]
fn original_high_only_catalog_remains_an_explicit_default_medium_negative() {
    let original = original();
    let high_only_phase_options = phase_options(
        SourceJson::from_serializable(
            &json!({"supported_reasoning_levels":["none","high"],"default_reasoning_level":"none"}),
        )
        .unwrap(),
        "medium",
    );
    let phase = PreparedClaudeOrdinary::prepare(
        ClientSurface::Responses,
        &original,
        &"claude-sonnet-4-5".into(),
        &high_only_phase_options,
    )
    .unwrap();
    let error = PreparedClaudeBody::from_ordinary(
        phase,
        &original,
        &selected_capabilities(&["high"], true),
    )
    .unwrap_err();
    assert_eq!(error.status, 400);
    let fields = source::member(error.body(), "error").unwrap();
    assert_eq!(
        source::string(&source::member(&fields, "param").unwrap()),
        Some("reasoning".into())
    );
}
#[test]
fn explicit_none_nonstream_and_observed_high_keep_their_real_proof_rules() {
    for (effort, disabled, success) in [
        ("none", false, false),
        ("none", true, true),
        ("high", true, true),
    ] {
        let original=SourceJson::from_serializable(&json!({"model":"claude-sonnet-4-5","input":"fixture:matrix:claude:none","reasoning":{"effort":effort},"stream":false})).unwrap();
        let phase = PreparedClaudeOrdinary::prepare(
            ClientSurface::Responses,
            &original,
            &"claude-sonnet-4-5".into(),
            &fixture_phase_options(),
        )
        .unwrap();
        assert_eq!(
            phase.effective_effort(),
            Some(&JsString16::from_utf8(effort))
        );
        let result = PreparedClaudeBody::from_ordinary(
            phase,
            &original,
            &selected_capabilities(&["medium", "high"], disabled),
        );
        assert_eq!(result.is_ok(), success);
        if let Ok(prepared) = result {
            assert!(!prepared.stream());
            if effort == "none" {
                assert_eq!(
                    source::member(prepared.body(), "thinking").unwrap(),
                    raw(r#"{"type":"disabled"}"#)
                );
            }
        }
    }
}
#[test]
fn absent_effort_and_opaque_mapped_default_retain_exact_source_data() {
    let original = original();
    let phase = PreparedClaudeOrdinary::prepare(
        ClientSurface::Responses,
        &original,
        &"claude-sonnet-4-5".into(),
        &OrdinaryPhaseOptions::default(),
    )
    .unwrap();
    assert!(phase.effective_effort().is_none());
    let prepared =
        PreparedClaudeBody::from_ordinary(phase, &original, &selected_capabilities(&[], false))
            .unwrap();
    assert!(source::member(prepared.body(), "thinking").is_none());
    let phase_options = phase_options(
        raw(r#"{"reasoning_effort_wire_map":{"host-default":"wire\ud800"}}"#),
        "host-default",
    );
    let phase = PreparedClaudeOrdinary::prepare(
        ClientSurface::Responses,
        &original,
        &"claude-sonnet-4-5".into(),
        &phase_options,
    )
    .unwrap();
    let effort = JsString16::from_units("wire".encode_utf16().chain([0xd800]).collect());
    assert_eq!(phase.effective_effort(), Some(&effort));
    let mut observed = selected_capabilities(&[], false);
    observed.native_reasoning_efforts = Some(vec![effort.clone()]);
    let prepared = PreparedClaudeBody::from_ordinary(phase, &original, &observed).unwrap();
    let output = source::member(prepared.body(), "output_config").unwrap();
    assert_eq!(
        source::string(&source::member(&output, "effort").unwrap()),
        Some(effort)
    );
}
#[test]
fn source_input_cache_reasoning_priority_finishes_before_any_capability_input() {
    let options = phase_options(raw(r#"{"prompt_cache":false}"#), "medium");
    let cases = [
        (
            r#"{"model":"claude-sonnet-4-5","input":42,"prompt_cache_key":"key","reasoning":true,"instructions":17}"#,
            "input must be a string or an array",
            None,
        ),
        (
            r#"{"model":"claude-sonnet-4-5","input":"x","prompt_cache_key":"key","reasoning":true,"instructions":17}"#,
            "Prompt caching is not supported for model 'claude-sonnet-4-5'.",
            Some("prompt_cache_key"),
        ),
        (
            r#"{"model":"claude-sonnet-4-5","input":"x","reasoning":true,"instructions":17}"#,
            "reasoning must be an object",
            Some("reasoning"),
        ),
    ];
    for (body, message, param) in cases {
        let error = PreparedClaudeOrdinary::prepare(
            ClientSurface::Responses,
            &raw(body),
            &"claude-sonnet-4-5".into(),
            &options,
        )
        .unwrap_err();
        let fields = source::member(error.body(), "error").unwrap();
        assert_eq!(
            source::string(&source::member(&fields, "message").unwrap()),
            Some(message.into())
        );
        assert_eq!(
            source::member(&fields, "param")
                .as_ref()
                .and_then(source::string),
            param.map(JsString16::from_utf8)
        );
    }
}
#[test]
fn phased_and_existing_convenience_use_identical_normalized_body_and_decode() {
    for surface in [ClientSurface::Responses, ClientSurface::Chat] {
        let original = if surface == ClientSurface::Responses {
            original()
        } else {
            raw(
                r#"{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hello"}],"stream":false}"#,
            )
        };
        let phase_options = fixture_phase_options();
        let phase = PreparedClaudeOrdinary::prepare(
            surface,
            &original,
            &"claude-sonnet-4-5".into(),
            &phase_options,
        )
        .unwrap();
        let mut selected = selected_capabilities(&["medium", "high"], true);
        selected.ordinary_preparation = phase_options.ordinary_preparation;
        let phased = PreparedClaudeBody::from_ordinary(phase, &original, &selected).unwrap();
        let convenient =
            PreparedClaudeBody::prepare(surface, &original, &"claude-sonnet-4-5".into(), &selected)
                .unwrap();
        assert_eq!(phased.body(), convenient.body());
        assert_eq!(
            serde_json::to_string(phased.decode()).unwrap(),
            serde_json::to_string(convenient.decode()).unwrap()
        );
    }
}

#[test]
fn cloned_phase_retries_keep_one_normalized_outcome_and_actual_selected_kind() {
    let original = original();
    let mut initial = fixture_phase_options();
    let phase = PreparedClaudeOrdinary::prepare(
        ClientSurface::Responses,
        &original,
        &"claude-sonnet-4-5".into(),
        &initial,
    )
    .unwrap();
    // Change the old input after preparation. Neither a clone nor finalization
    // may reread these defaults, allowed models or ordinary metadata.
    initial = phase_options(raw(r#"{}"#), "must-not-run-twice");
    initial.allowed_models = vec!["different-model".into()];
    let mut selected = selected_capabilities(&["high"], true);
    selected.ordinary_preparation = initial.ordinary_preparation;
    selected.allowed_models = initial.allowed_models;
    assert!(PreparedClaudeBody::from_ordinary(phase.clone(), &original, &selected).is_err());
    selected.native_reasoning_efforts = Some(vec!["medium".into(), "high".into()]);
    for kind in [ClaudeCredentialKind::ApiKey, ClaudeCredentialKind::Oauth] {
        selected.kind = kind;
        let prepared =
            PreparedClaudeBody::from_ordinary(phase.clone(), &original, &selected).unwrap();
        assert_eq!(prepared.kind(), kind);
        assert!(prepared.stream());
        assert_eq!(prepared.decode().request, original);
        assert_eq!(prepared.decode().upstream_model, *phase.model());
        let output = source::member(prepared.body(), "output_config").unwrap();
        assert_eq!(
            source::string(&source::member(&output, "effort").unwrap()),
            Some("medium".into())
        );
        let system = source::member(prepared.body(), "system");
        if kind == ClaudeCredentialKind::Oauth {
            let blocks = source::array(&system.unwrap()).unwrap();
            assert_eq!(blocks.len(), 1);
            assert_eq!(
                source::string(&source::member(&blocks[0], "text").unwrap()),
                Some(gateway_providers::finalize::CLAUDE_ATTRIBUTION.into())
            );
        } else {
            assert!(system.is_none());
        }
    }
    assert_eq!(phase.effective_effort(), Some(&"medium".into()));
    assert_eq!(phase.model(), &"claude-sonnet-4-5".into());
    // A successful earlier account never turns the retained data into proof.
    selected.native_reasoning_efforts = Some(vec!["high".into()]);
    assert!(PreparedClaudeBody::from_ordinary(phase, &original, &selected).is_err());
}
