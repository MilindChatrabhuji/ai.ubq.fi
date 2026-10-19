//! Source model/metadata views over the one core JSON and UTF16 implementation.
use gateway_core::{
    js_string::JsString16, model::ModelId, source_json::SourceJson, source_serialization as source,
};
use serde::Serialize;

pub(crate) fn json<T: Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).expect("typed model control is valid source JSON")
}
pub(crate) fn object(fields: Vec<(&str, SourceJson)>) -> SourceJson {
    source::object(fields).expect("typed model control object")
}
pub(crate) fn set(value: &mut SourceJson, key: &str, next: SourceJson) {
    let key = JsString16::from_utf8(key);
    let mut entries = source::entries(value).expect("model control object");
    if let Some((_, value)) = entries.iter_mut().find(|(name, _)| name == &key) {
        *value = next;
    } else {
        entries.push((key, next));
    }
    *value = source::object_keys(entries).expect("model control members");
}
pub(crate) fn get(value: &SourceJson, key: &str) -> Option<SourceJson> {
    source::member(value, key)
}
pub(crate) fn array(value: &SourceJson) -> Option<Vec<SourceJson>> {
    source::array(value)
}
pub(crate) fn is_object(value: &SourceJson) -> bool {
    value.as_str().starts_with('{')
}
pub(crate) fn is_record(value: &SourceJson) -> bool {
    is_object(value) || value.as_str().starts_with('[')
}
pub(crate) fn string(value: &SourceJson) -> Option<JsString16> {
    source::string(value)
}
pub(crate) fn matches(value: &JsString16, literal: &str) -> bool {
    value.as_units().iter().copied().eq(literal.encode_utf16())
}
pub(crate) fn trim(value: &JsString16) -> JsString16 {
    crate::source_request::trim(value)
}
pub(crate) fn push_unique<T: PartialEq>(values: &mut Vec<T>, value: T) {
    if !values.contains(&value) {
        values.push(value);
    }
}
pub(crate) fn normalized(value: Option<&SourceJson>) -> Option<JsString16> {
    value
        .and_then(string)
        .map(|s| trim(&s))
        .filter(|s| !s.as_units().is_empty())
}
pub(crate) fn identifier(value: &SourceJson) -> Option<JsString16> {
    ["slug", "id", "model", "name"]
        .iter()
        .find_map(|key| get(value, key).as_ref().and_then(string))
}
pub(crate) fn model(value: &SourceJson) -> Option<ModelId> {
    identifier(value).map(ModelId::from_source)
}
pub(crate) fn positive(value: Option<&SourceJson>) -> Option<i64> {
    value
        .and_then(source::number)
        .filter(|n| {
            n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= crate::util::MAX_SAFE_INTEGER
        })
        .map(|n| n as i64)
}
pub(crate) fn scalar(value: Option<&SourceJson>) -> Option<String> {
    // Only callers with independently finite fields (provider IDs/client versions) use this view.
    value.and_then(string).and_then(|s| s.try_utf8().ok())
}
pub(crate) fn concat(parts: &[&JsString16]) -> JsString16 {
    JsString16::from_units(
        parts
            .iter()
            .flat_map(|s| s.as_units().iter().copied())
            .collect(),
    )
}
