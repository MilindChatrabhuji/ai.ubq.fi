mod source_input;
use gateway_core::{
    js_string::JsString16, model::ModelId, provider::UpstreamProvider, source_json::SourceJson,
    source_serialization as source,
};
use gateway_providers::ClientSurface;
use gateway_routing_runtime::{
    policy::{self, RouteHop},
    types::{RoutingError, RoutingInput, SourceRefusalBody},
};
use source_input::{NOW, input};
fn fixture_json<T: serde::Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).unwrap()
}
struct NoSortingExpected;
impl gateway_schema::aliases::SourceStringCollator for NoSortingExpected {
    fn compare(
        &self,
        _left: &JsString16,
        _right: &JsString16,
    ) -> Result<std::cmp::Ordering, gateway_core::GatewayError> {
        Err(gateway_core::GatewayError::unavailable(
            "This captured source case performs no alias sorting.",
            "unexpected_alias_comparison",
        ))
    }
}
fn raw(value: &str) -> SourceJson {
    SourceJson::parse(value).unwrap()
}
fn error_field(error: RoutingError, name: &str) -> JsString16 {
    let Some(SourceRefusalBody::Json(body)) = error.source_body else {
        panic!("source error body lost")
    };
    source::string(&source::member(&source::member(&body, "error").unwrap(), name).unwrap())
        .unwrap()
}
#[test]
fn unknown_opaque_field_precedes_model_stream_and_content_errors() {
    let mut request = input("source-unknown-priority", "gpt-test", &[]);
    request.raw = raw(r#"{"model":7,"stream":null,"input":null,"\ud800":1}"#);
    let error = policy::plan(&request, NOW, &NoSortingExpected).unwrap_err();
    assert_eq!(error.error.status, 400);
    let message = error_field(error, "message");
    assert_eq!(message.as_units().last(), Some(&0xd800));
}
#[test]
fn ordinary_responses_stream_precedes_model_and_chat_model_precedes_cap() {
    let mut request = input("source-order", "gpt-test", &[]);
    request.raw = raw(r#"{"model":7,"stream":null,"input":null}"#);
    assert_eq!(
        error_field(
            policy::plan(&request, NOW, &NoSortingExpected).unwrap_err(),
            "param"
        ),
        JsString16::from_utf8("stream")
    );
    request.surface = ClientSurface::Chat;
    request.raw = raw(r#"{"model":7,"stream":null,"messages":null,"max_completion_tokens":0}"#);
    assert_eq!(
        error_field(
            policy::plan(&request, NOW, &NoSortingExpected).unwrap_err(),
            "message"
        ),
        JsString16::from_utf8("model must be a string")
    );
}
#[test]
fn native_openrouter_chat_is_not_globally_codex_normalized() {
    let mut request = input("native-source-chat", "gpt-test", &["openrouter"]);
    request.surface = ClientSurface::Chat;
    request
        .catalog
        .providers
        .get_mut("openrouter")
        .unwrap()
        .models = vec![raw(r#"{"id":"anthropic/claude-fixture"}"#)];
    request.raw = raw(
        r#"{"model":"anthropic/claude-fixture","messages":[{"role":"vendor","content":{"text":"\ud800"}}],"stream":"native"}"#,
    );
    let original = request.raw.clone();
    let plan = policy::plan(&request, NOW, &NoSortingExpected).unwrap();
    assert!(matches!(
        plan.hops.first(),
        Some(RouteHop::Direct {
            provider: UpstreamProvider::Openrouter,
            ..
        })
    ));
    assert_eq!(request.raw, original);
}
#[test]
fn opaque_model_retains_source_availability_branch_without_a_scalar_fallback() {
    let mut request = input("opaque-source-model", "gpt-test", &[]);
    request.raw = raw(r#"{"model":"\ud800","input":"x"}"#);
    let error = policy::plan(&request, NOW, &NoSortingExpected).unwrap_err();
    assert_eq!(error.error.status, 404);
    let message = error_field(error, "message");
    assert!(message.as_units().contains(&0xd800));
    request
        .catalog
        .full_snapshot
        .as_mut()
        .unwrap()
        .models
        .clear();
    let plan = policy::plan(&request, NOW, &NoSortingExpected).unwrap();
    assert_eq!(plan.model.as_js_string().as_units(), &[0xd800]);
    request.catalog.full_snapshot = None;
    let plan = policy::plan(&request, NOW, &NoSortingExpected).unwrap();
    assert_eq!(
        plan.model,
        ModelId::from_source(JsString16::from_units(vec![0xd800]))
    );
}
