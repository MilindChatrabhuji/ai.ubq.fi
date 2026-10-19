//! Exact logical-value corpus from frozen M31 source oracle; no compaction algorithm dependency.
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use serde_json::Value;
#[test]
fn frozen_source_canonical_vectors_keep_js_numbers_order_and_utf16() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/source-serialization-v1.json")).unwrap();
    let cases = fixture["canonical"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for case in cases {
        let input = SourceJson::parse(case["raw"].as_str().unwrap()).unwrap();
        let before = input.clone();
        let actual = source::canonical(&input).unwrap();
        assert_eq!(actual.as_str(), case["expected"].as_str().unwrap());
        assert_eq!(input, before);
    }
}
#[test]
fn logical_members_keep_last_duplicate_and_first_insertion_with_integer_order() {
    let input =
        SourceJson::parse(r#"{"b":1,"2":"two","a":1,"b":2,"1":"one","\ud800":"literal"}"#).unwrap();
    let members = source::entries(&input).unwrap();
    let keys: Vec<_> = members
        .iter()
        .map(|(key, _)| key.as_units().to_vec())
        .collect();
    assert_eq!(
        keys,
        vec![vec![49], vec![50], vec![98], vec![97], vec![0xd800]]
    );
    assert_eq!(source::member(&input, "b").unwrap().as_str(), "2");
}
#[test]
fn structural_builders_keep_lone_units_without_wire_tags_or_replacement() {
    let text = JsString16::from_units(vec![0xd800, 97, 0xdc00]);
    let value = source::quoted(&text).unwrap();
    let object =
        source::object_keys(vec![(JsString16::from_units(vec![0xdfff]), value.clone())]).unwrap();
    let array = source::json_array(&[object]).unwrap();
    assert_eq!(array.as_str(), r#"[{"\udfff":"\ud800a\udc00"}]"#);
    assert_eq!(source::string(&value).unwrap(), text);
}
