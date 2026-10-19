use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::source_request::source_value::{Text, Value};

fn parse(raw: &str) -> Value {
    Value::from_source(SourceJson::parse(raw).unwrap())
}
#[test]
fn existing_scalar_get_index_and_serialization_stay_source_identical() {
    let raw =
        SourceJson::parse(r#"{"text":"hello","number":1.5,"boolean":false,"items":[null,2]}"#)
            .unwrap();
    let value = Value::from_source(raw.clone());
    assert_eq!(value.get("text").and_then(Value::as_str), Some("hello"));
    assert_eq!(value["number"].as_f64(), Some(1.5));
    assert!(value["number"].as_i64().is_none());
    assert_eq!(value["boolean"].as_bool(), Some(false));
    assert!(value["items"][0].is_null());
    assert_eq!(value["items"][1].as_i64(), Some(2));
    assert!(value["missing"].is_null());
    let fields = value.as_object().unwrap();
    assert_eq!(
        fields
            .iter()
            .map(|(key, _)| key.try_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["text", "number", "boolean", "items"]
    );
    assert_eq!(value.source().unwrap(), raw);
    assert_eq!(SourceJson::from_serializable(&value).unwrap(), raw);
    assert_eq!(
        Text::new("hello".into()).core(),
        JsString16::from_utf8("hello")
    );
}
#[test]
fn mutable_object_array_and_named_remove_keep_utf16_identity_and_order() {
    let mut value = parse(
        r#"{"before":"\ud800","\ud800":"value\udfff","\\ud800":"literal","items":["\ud800"],"after":2}"#,
    );
    let opaque_key = JsString16::from_units(vec![0xd800]);
    let replacement = JsString16::from_units(vec![0xdfff, 119]);
    let fields = value.as_object_mut().unwrap();
    let (_, payload) = fields
        .iter_mut()
        .find(|(key, _)| key == &opaque_key)
        .unwrap();
    *payload = Value::String(Text::new(replacement.clone()));
    fields.push(("last".into(), Value::Bool(true)));
    value["items"]
        .as_array_mut()
        .unwrap()
        .push(Value::String(Text::new(JsString16::from_units(vec![
            0xdfff,
        ]))));
    let literal = value.remove(r"\ud800").unwrap();
    assert_eq!(literal.as_str(), Some("literal"));
    let removed = value.remove("before").unwrap();
    assert_eq!(removed.as_text().unwrap().core().as_units(), &[0xd800]);
    assert!(removed.as_str().is_none());
    assert!(value.remove("missing").is_none());
    let fields = value.as_object().unwrap();
    assert_eq!(
        fields
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>(),
        vec![
            opaque_key.clone(),
            "items".into(),
            "after".into(),
            "last".into()
        ]
    );
    let output = value.source().unwrap();
    let fields = source::entries(&output).unwrap();
    assert_eq!(source::string(&fields[0].1), Some(replacement));
    assert_eq!(fields[0].0, opaque_key);
    let items = source::array(&source::member(&output, "items").unwrap()).unwrap();
    assert_eq!(source::string(&items[0]).unwrap().as_units(), &[0xd800]);
    assert_eq!(source::string(&items[1]).unwrap().as_units(), &[0xdfff]);
    assert_eq!(SourceJson::from_serializable(&value).unwrap(), output);
}
#[test]
fn untouched_deep_extension_stays_lazy_raw_after_sibling_mutation_and_remove() {
    let deep = format!("{}0{}", "[".repeat(8192), "]".repeat(8192));
    let raw = SourceJson::parse(&format!(
        r#"{{"keep":true,"extension":{deep},"remove":false}}"#
    ))
    .unwrap();
    let mut value = Value::from_source(raw);
    value
        .as_object_mut()
        .unwrap()
        .push(("added".into(), Value::String(Text::new("value".into()))));
    assert_eq!(value.remove("remove").unwrap().as_bool(), Some(false));
    let Value::Raw(extension, cache) = value.get("extension").unwrap() else {
        panic!("untouched extension must retain the actual Raw variant")
    };
    assert_eq!(extension.as_str(), deep);
    assert!(cache.get().is_none());
    let output = value.source().unwrap();
    assert_eq!(source::member(&output, "extension").unwrap().as_str(), deep);
    assert!(cache.get().is_none());
    let keys = source::entries(&output)
        .unwrap()
        .into_iter()
        .map(|(key, _)| key)
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        vec!["keep".into(), "extension".into(), "added".into()]
    );
}
#[test]
fn numeric_view_reuses_core_source_number_without_finite_or_integer_filtering() {
    for token in [
        "0",
        "-0",
        "1.5",
        "2.0",
        "9007199254740993",
        "1e999",
        "-1e999",
        "1e-9999",
        "-1e-9999",
    ] {
        let raw = SourceJson::parse(token).unwrap();
        let value = Value::from_source(raw.clone());
        assert!(value.is_number());
        assert_eq!(
            value.as_f64().map(f64::to_bits),
            source::number(&raw).map(f64::to_bits),
            "{token}"
        );
        assert_eq!(
            value.source().unwrap(),
            raw,
            "number spelling must not be reconstructed"
        );
    }
    assert!(parse("1e999").as_f64().unwrap().is_infinite());
    assert!(parse("-1e-9999").as_f64().unwrap().is_sign_negative());
    assert!(
        parse("2.0").as_i64().is_none(),
        "existing integer view is unchanged"
    );
    for token in [r#""1""#, "true", "false", "null", "[]", "{}"] {
        let value = parse(token);
        assert!(!value.is_number());
        assert!(value.as_f64().is_none());
    }
}
#[test]
fn new_views_never_coerce_or_change_wrong_container_kinds() {
    let mut number = parse("7");
    assert!(number.as_object().is_none());
    assert!(number.as_object_mut().is_none());
    assert!(number.as_array_mut().is_none());
    assert!(number.as_bool().is_none());
    assert!(number.remove("missing").is_none());
    assert_eq!(number.source().unwrap().as_str(), "7");
    assert_eq!(parse("true").as_bool(), Some(true));
    assert_eq!(parse("false").as_bool(), Some(false));
    assert!(parse(r#""true""#).as_bool().is_none());
}
