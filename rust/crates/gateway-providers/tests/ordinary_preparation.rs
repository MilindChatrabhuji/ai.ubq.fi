//! The ordinary selected-metadata phase order, not a universal provider normalizer.
use gateway_core::{
    provider::UpstreamProvider, source_json::SourceJson, source_serialization as source,
};
use gateway_providers::{
    AuthMaterial, ClientSurface, OrdinaryPreparationContext, PrepareOptions, prepare_source_request,
};
use gateway_schema::{
    catalog::RequestModelMetadata, reasoning::ModelReasoning, source_request::SourceRequestError,
};
use serde_json::{Value, json};
fn parse(raw: &str) -> SourceJson {
    SourceJson::parse(raw).unwrap()
}
fn get(value: &SourceJson, key: &str) -> SourceJson {
    source::member(value, key).unwrap()
}
fn metadata(record: Option<Value>) -> RequestModelMetadata {
    let record = record.map(|value| SourceJson::from_serializable(&value).unwrap());
    RequestModelMetadata {
        snapshot: None,
        reasoning: ModelReasoning::from_record(record.as_ref()),
        record,
        supported_endpoints: None,
    }
}
fn options(record: Option<Value>, default: &str) -> PrepareOptions {
    PrepareOptions {
        auth: AuthMaterial {
            secret: "fixture-only".into(),
            account_id: Some("fixture-account".into()),
            ..Default::default()
        },
        conversation_id: Some("fixture-conversation".into()),
        ordinary_preparation: Some(OrdinaryPreparationContext::from_metadata(
            &metadata(record),
            &default.into(),
        )),
        ..Default::default()
    }
}
fn error(surface: ClientSurface, raw: &str, options: &PrepareOptions) -> SourceRequestError {
    prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        surface,
        &parse(raw),
        &"gpt-fixture".into(),
        options,
    )
    .unwrap_err()
}
fn assert_error(error: SourceRequestError, message: &str, param: Option<&str>) {
    let mut fields =
        json!({"message":message,"type":"invalid_request_error","code":"invalid_request_error"});
    if let Some(param) = param {
        fields["param"] = json!(param);
    }
    assert_eq!(error.status, 400);
    assert_eq!(
        error.body(),
        &SourceJson::from_serializable(&json!({"error":fields})).unwrap()
    );
}

#[test]
fn responses_input_cache_reasoning_instructions_order_matches_the_source() {
    let denied = options(Some(json!({"prompt_cache":false})), "host-default");
    assert_error(
        error(
            ClientSurface::Responses,
            r#"{"model":"gpt-fixture","input":42,"prompt_cache_key":"key","reasoning":true,"instructions":17}"#,
            &denied,
        ),
        "input must be a string or an array",
        None,
    );
    assert_error(
        error(
            ClientSurface::Responses,
            r#"{"model":"gpt-fixture","input":"x","prompt_cache_key":"key","reasoning":true,"instructions":17}"#,
            &denied,
        ),
        "Prompt caching is not supported for model 'gpt-fixture'.",
        Some("prompt_cache_key"),
    );
    assert_error(
        error(
            ClientSurface::Responses,
            r#"{"model":"gpt-fixture","input":"x","reasoning":true,"instructions":17}"#,
            &denied,
        ),
        "reasoning must be an object",
        Some("reasoning"),
    );
    assert_error(
        error(
            ClientSurface::Responses,
            r#"{"model":"gpt-fixture","input":"x","reasoning":{"effort":3},"instructions":17}"#,
            &denied,
        ),
        "reasoning.effort must be a string",
        Some("reasoning"),
    );
    assert_error(
        error(
            ClientSurface::Responses,
            r#"{"model":"gpt-fixture","input":"x","reasoning":{"effort":"future"},"instructions":17}"#,
            &denied,
        ),
        "instructions must be a string",
        None,
    );
}

#[test]
fn chat_syntax_stream_conversion_cache_then_selected_mapping_is_distinct() {
    let denied = options(Some(json!({"prompt_cache":false})), "host-default");
    assert_error(
        error(
            ClientSurface::Chat,
            r#"{"model":"gpt-fixture","messages":null,"reasoning_effort":3,"stream":"bad","prompt_cache_key":"key"}"#,
            &denied,
        ),
        "messages must be an array",
        None,
    );
    assert_error(
        error(
            ClientSurface::Chat,
            r#"{"model":"gpt-fixture","messages":[],"reasoning_effort":3,"stream":"bad","prompt_cache_key":"key"}"#,
            &denied,
        ),
        "messages must be a non-empty array",
        None,
    );
    assert_error(
        error(
            ClientSurface::Chat,
            r#"{"model":"gpt-fixture","messages":[{"role":"other","content":"x"}],"reasoning_effort":3,"stream":"bad","prompt_cache_key":"key"}"#,
            &denied,
        ),
        "reasoning_effort must be a string",
        Some("reasoning_effort"),
    );
    assert_error(
        error(
            ClientSurface::Chat,
            r#"{"model":"gpt-fixture","messages":[{"role":"other","content":"x"}],"reasoning_effort":"future","stream":"bad","prompt_cache_key":"key"}"#,
            &denied,
        ),
        "stream must be a boolean",
        Some("stream"),
    );
    assert_error(
        error(
            ClientSurface::Chat,
            r#"{"model":"gpt-fixture","messages":[{"role":"other","content":"x"}],"reasoning_effort":"future","stream":true,"stream_options":{"include_usage":3},"prompt_cache_key":"key"}"#,
            &denied,
        ),
        "stream_options.include_usage must be a boolean",
        Some("stream_options"),
    );
    assert_error(
        error(
            ClientSurface::Chat,
            r#"{"model":"gpt-fixture","messages":[{"role":"other","content":"x"}],"reasoning_effort":"future","prompt_cache_key":"key"}"#,
            &denied,
        ),
        "messages[0].role is not supported",
        Some("messages[0].role"),
    );
    assert_error(
        error(
            ClientSurface::Chat,
            r#"{"model":"gpt-fixture","messages":[{"role":"user","content":"x"}],"reasoning_effort":"future","prompt_cache_key":"key"}"#,
            &denied,
        ),
        "Prompt caching is not supported for model 'gpt-fixture'.",
        Some("prompt_cache_key"),
    );
}

#[test]
fn actual_host_default_and_catalog_wire_map_do_not_become_a_tier_allowlist() {
    let options = options(
        Some(
            json!({"supported_reasoning_levels":["catalog-default"],"default_reasoning_level":"catalog-default","reasoning_effort_wire_map":{"host-default":"wire-default","future":"wire-future","none":"forbidden-remap","ultra":"forbidden-remap"}}),
        ),
        "host-default",
    );
    let raw = parse(r#"{"model":"gpt-fixture","input":"x","instructions":null}"#);
    let prepared = prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &raw,
        &"gpt-fixture".into(),
        &options,
    )
    .unwrap();
    assert_eq!(
        get(&get(&prepared.body, "reasoning"), "effort"),
        parse(r#""wire-default""#)
    );
    assert!(source::member(&prepared.body, "instructions").is_none());
    assert_eq!(prepared.decode.request, raw);
    for (requested, wire) in [
        ("future", "wire-future"),
        ("none", "none"),
        ("ultra", "max"),
        ("not-advertised", "not-advertised"),
    ] {
        for surface in [ClientSurface::Responses, ClientSurface::Chat] {
            let raw = if surface == ClientSurface::Responses {
                json!({"model":"gpt-fixture","input":"x","reasoning":{"effort":requested}})
            } else {
                json!({"model":"gpt-fixture","messages":[{"role":"user","content":"x"}],"reasoning_effort":requested})
            };
            let raw = SourceJson::from_serializable(&raw).unwrap();
            let prepared = prepare_source_request(
                UpstreamProvider::ChatgptCodex,
                surface,
                &raw,
                &"gpt-fixture".into(),
                &options,
            )
            .unwrap();
            assert_eq!(
                get(&get(&prepared.body, "reasoning"), "effort"),
                SourceJson::from_serializable(wire).unwrap()
            );
            assert_eq!(prepared.decode.request, raw);
        }
    }
}

#[test]
fn absent_catalog_is_unknown_and_source_reasoning_fields_stay_authoritative() {
    let options = options(None, "host-default");
    let raw = parse(
        r#"{"model":"gpt-fixture","input":"x","prompt_cache_key":"k\ud800","reasoning":{"effort":"future\udc00","summary":"s\ud800"},"instructions":"i\udc00"}"#,
    );
    let prepared = prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &raw,
        &"gpt-fixture".into(),
        &options,
    )
    .unwrap();
    assert_eq!(
        get(&prepared.body, "prompt_cache_key"),
        get(&raw, "prompt_cache_key")
    );
    assert_eq!(get(&prepared.body, "reasoning"), get(&raw, "reasoning"));
    assert_eq!(
        get(&prepared.body, "instructions"),
        get(&raw, "instructions")
    );
    assert_eq!(prepared.decode.request, raw);
}

#[test]
fn selected_context_is_immutable_and_none_is_only_the_explicit_legacy_adapter_contract() {
    let mut original = metadata(Some(json!({"prompt_cache":false})));
    let mut default = "host-default".to_owned();
    let context = OrdinaryPreparationContext::from_metadata(&original, &default.as_str().into());
    original.record = Some(parse(r#"{"prompt_cache":true}"#));
    default.clear();
    assert_eq!(context.prompt_cache(), Some(&parse("false")));
    assert_eq!(context.default_effort(), &"host-default".into());
    let mut options = options(None, "host-default");
    options.ordinary_preparation = Some(context);
    assert_error(
        error(
            ClientSurface::Responses,
            r#"{"model":"gpt-fixture","input":"x","prompt_cache_key":"key"}"#,
            &options,
        ),
        "Prompt caching is not supported for model 'gpt-fixture'.",
        Some("prompt_cache_key"),
    );
    options.ordinary_preparation = None;
    let prepared = prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &parse(r#"{"model":"gpt-fixture","input":"x"}"#),
        &"gpt-fixture".into(),
        &options,
    )
    .unwrap();
    assert!(source::member(&prepared.body, "reasoning").is_none());
}

#[test]
fn selected_ordinary_metadata_does_not_prevalidate_direct_or_openrouter_branches() {
    let mut options = options(Some(json!({"prompt_cache":false})), "host-default");
    let raw = parse(
        r#"{"model":"deepseek-flash","messages":[{"role":"other","content":"x\ud800"}],"prompt_cache_key":"key"}"#,
    );
    let direct = prepare_source_request(
        UpstreamProvider::Deepseek,
        ClientSurface::Chat,
        &raw,
        &"deepseek-flash".into(),
        &options,
    )
    .unwrap();
    assert_eq!(get(&direct.body, "reasoning_effort"), parse(r#""high""#));
    options.allowed_models = vec!["openai/test".into()];
    let raw = parse(
        r#"{"model":"openai/test","input":{"untouched":"\ud800"},"reasoning":[],"prompt_cache_key":"key","stream":"not-boolean"}"#,
    );
    let native = prepare_source_request(
        UpstreamProvider::Openrouter,
        ClientSurface::Responses,
        &raw,
        &"openai/test".into(),
        &options,
    )
    .unwrap();
    assert_eq!(get(&native.body, "input"), get(&raw, "input"));
    assert_eq!(get(&native.body, "reasoning"), get(&raw, "reasoning"));
}

#[test]
fn opaque_model_and_effort_wire_map_units_are_data_not_scalar_fallbacks() {
    use gateway_core::{js_string::JsString16, model::ModelId};
    let record = parse(
        r#"{"id":"\ud800","supported_reasoning_levels":["\udc00"],"default_reasoning_level":"\udc00","reasoning_effort_wire_map":{"\udc00":"wire\ud800"},"prompt_cache":false}"#,
    );
    let metadata = RequestModelMetadata {
        snapshot: None,
        reasoning: ModelReasoning::from_record(Some(&record)),
        record: Some(record),
        supported_endpoints: None,
    };
    let mut opts = options(None, "none");
    opts.ordinary_preparation = Some(OrdinaryPreparationContext::from_metadata(
        &metadata,
        &JsString16::from_utf8("host-default"),
    ));
    let raw = parse(r#"{"model":"\ud800","input":"x","reasoning":{"effort":"\udc00"}}"#);
    let model = ModelId::from_source(JsString16::from_units(vec![0xd800]));
    let prepared = prepare_source_request(
        UpstreamProvider::ChatgptCodex,
        ClientSurface::Responses,
        &raw,
        &model,
        &opts,
    )
    .unwrap();
    assert_eq!(
        get(&prepared.body, "model"),
        model.to_source_json().unwrap()
    );
    assert_eq!(
        get(&get(&prepared.body, "reasoning"), "effort"),
        parse(r#""wire\ud800""#)
    );
    assert_eq!(prepared.decode.model, model);
    assert_eq!(prepared.decode.request, raw);
}
