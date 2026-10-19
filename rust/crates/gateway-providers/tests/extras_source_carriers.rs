use gateway_core::{
    js_string::JsString16, model::ModelId, source_json::SourceJson, source_serialization as source,
};
use gateway_providers::{PrepareOptions, extras};
fn parse(raw: &str) -> SourceJson {
    SourceJson::parse(raw).unwrap()
}
fn text(raw: &SourceJson, key: &str) -> JsString16 {
    source::string(&source::member(raw, key).unwrap()).unwrap()
}
#[test]
fn image_source_prompt_user_model_default_and_unknown_key_error_remain_original() {
    let raw =
        parse(r#"{"prompt":"p\ud800","user":"u\udc00","model":" m\ud801 ","size":"s\udc02"}"#);
    let parsed = extras::parse_source_image(&raw, false).unwrap();
    let default = ModelId::from_source(JsString16::from_units(vec![68, 0xd802]));
    let plan = extras::prepare_parsed_image(&parsed, &default, "original");
    assert_eq!(
        text(&plan.responses, "model"),
        default.as_js_string().clone()
    );
    assert_eq!(text(&plan.responses, "input"), text(&raw, "prompt"));
    assert_eq!(text(&plan.responses, "user"), text(&raw, "user"));
    let tool = source::array(&source::member(&plan.responses, "tools").unwrap())
        .unwrap()
        .remove(0);
    assert_eq!(
        text(&tool, "model"),
        JsString16::from_units(vec![109, 0xd801])
    );
    let bad = parse(r#"{"prompt":"","\ud800":true,"n":0}"#);
    let error = extras::parse_source_image(&bad, false).unwrap_err();
    let fields = source::member(error.body(), "error").unwrap();
    assert_eq!(text(&fields, "param"), JsString16::from_units(vec![0xd800]));
    assert!(text(&fields, "message").as_units().contains(&0xd800));
}
#[test]
fn embedding_and_systemone_use_the_same_source_engine_without_scalar_payloads() {
    let raw = parse(r#"{"model":"voyage-4-large","input":["x\ud800"],"user":"u\udc00"}"#);
    let profile = extras::parse_source_embeddings(&raw, false).unwrap();
    assert_eq!(profile.inputs[0].as_units(), &[120, 0xd800]);
    let prepared = extras::prepare_source_embeddings(&raw, &PrepareOptions::default()).unwrap();
    assert_eq!(prepared.decode.request, raw);
    assert!(prepared.body.as_str().contains("\\ud800"));
    let system = parse(r#"{"state":{"\ud800":"v\udc00"},"questions":{"q\ud801":{"type":"noul"}}}"#);
    let prepared = extras::prepare_source_systemone(&system, &PrepareOptions::default()).unwrap();
    assert_eq!(prepared.decode.request, system);
    assert!(prepared.body.as_str().contains("\\ud800"));
    assert!(prepared.body.as_str().contains("\\ud801"));
}
#[test]
fn source_upstream_response_text_is_retained_in_existing_json_shape() {
    let payload = parse(
        r#"{"output":[{"type":"image_generation_call","result":"AA==","revised_prompt":"r\ud800"}]}"#,
    );
    let images = extras::extract_source_images(&payload);
    assert_eq!(
        text(&images[0], "revised_prompt"),
        JsString16::from_units(vec![114, 0xd800])
    );
    let system = parse(r#"{"answers":{"q":"a\udc00"}}"#);
    assert_eq!(extras::decode_source_systemone(&system).unwrap(), system);
}
