//! Source string controls: these remain data until the separately owned runtime cutover.
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use gateway_schema::source_request::{
    self, SourceField, SourceModelRequest, SourceRequestDocument,
};

fn doc(raw: &str) -> SourceRequestDocument {
    SourceRequestDocument::new(SourceJson::parse(raw).unwrap()).unwrap()
}
#[test]
fn literal_lone_instructions_and_input_are_not_scalar_parsed() {
    let raw = r#"{"model":" \ud800 ","input":"\ud800","instructions":"x\udfffy"}"#;
    let parsed = source_request::parse_http_body(raw.as_bytes()).unwrap();
    let document = SourceRequestDocument::new(parsed.clone()).unwrap();
    assert_eq!(document.original_source(), &parsed);
    assert_eq!(
        document.instructions().unwrap(),
        SourceField::Value(JsString16::from_units(vec![120, 0xdfff, 121]))
    );
    assert_eq!(
        document.model_request().unwrap(),
        SourceModelRequest::Named(JsString16::from_units(vec![0xd800]))
    );
}
#[test]
fn source_model_defaults_and_nonempty_lone_identity_stay_distinct() {
    for raw in ["{}", r#"{"model":null}"#, r#"{"model":"\u00a0\ufeff "}"#] {
        assert_eq!(
            doc(raw).model_request().unwrap(),
            SourceModelRequest::Default
        );
    }
    let named = doc(r#"{"model":" \ud800 "}"#).model_request().unwrap();
    assert_eq!(
        named,
        SourceModelRequest::Named(JsString16::from_units(vec![0xd800]))
    );
    for raw in [r#"{"model":5}"#, r#"{"model":false}"#] {
        let error = doc(raw).model_request().unwrap_err();
        assert_eq!(error.status, 400);
        let value: serde_json::Value = error.body().deserialize().unwrap();
        assert_eq!(value["error"]["message"], "model must be a string");
        assert!(value["error"].get("param").is_none());
    }
}
#[test]
fn last_duplicate_model_stream_and_instructions_follow_source_json_parse() {
    let document = doc(
        r#"{"model":"first","model":"last","stream":false,"stream":true,"instructions":null,"instructions":"\udc00"}"#,
    );
    assert_eq!(
        document.model_request().unwrap(),
        SourceModelRequest::Named(JsString16::from_utf8("last"))
    );
    assert!(document.stream().unwrap());
    assert_eq!(
        document.instructions().unwrap(),
        SourceField::Value(JsString16::from_units(vec![0xdc00]))
    );
    assert_eq!(doc("{}").instructions().unwrap(), SourceField::Missing);
    assert_eq!(
        doc(r#"{"instructions":null}"#).instructions().unwrap(),
        SourceField::Null
    );
}
#[test]
fn stream_rejects_null_and_strings_not_just_truthiness() {
    for raw in ["{}", r#"{"stream":false}"#] {
        assert!(!doc(raw).stream().unwrap());
    }
    assert!(doc(r#"{"stream":true}"#).stream().unwrap());
    for raw in [
        r#"{"stream":null}"#,
        r#"{"stream":"true"}"#,
        r#"{"stream":1}"#,
    ] {
        let error = doc(raw).stream().unwrap_err();
        let value: serde_json::Value = error.body().deserialize().unwrap();
        assert_eq!(value["error"]["message"], "stream must be a boolean");
        assert_eq!(value["error"]["param"], "stream");
    }
}
#[test]
fn http_decoder_keeps_source_bom_and_invalid_utf8_rule_only_at_byte_boundary() {
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(b"{\"input\":\"");
    bytes.push(0xff);
    bytes.extend_from_slice(b"\"}");
    let value = source_request::parse_http_body(&bytes).unwrap();
    assert_eq!(value.as_str(), "{\"input\":\"�\"}");
    for bytes in [b"".as_slice(), b"{", b"null trailing"] {
        assert!(source_request::parse_http_body(bytes).is_err());
    }
    assert!(SourceRequestDocument::new(SourceJson::parse("null").unwrap()).is_err());
}
