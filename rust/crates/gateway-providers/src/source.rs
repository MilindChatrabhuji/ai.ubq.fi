//! Source JSON composition only. Grammar/stringification policy belongs to core.
use gateway_core::{js_string::JsString16, source_json::SourceJson, source_serialization as json};
use gateway_schema::source_request::SourceRequestError;
use serde::Serialize;

pub(crate) type Result<T> = std::result::Result<T, SourceRequestError>;

/// Only generated/already-scalar data enters this lift. Source payloads never do.
pub(crate) fn generated(value: &impl Serialize) -> SourceJson {
    SourceJson::from_serializable(value).expect("Generated provider JSON is serializable")
}
pub(crate) fn null() -> SourceJson {
    generated(&())
}
pub(crate) fn text(value: &str) -> SourceJson {
    generated(&value)
}
pub(crate) fn quoted(value: &JsString16) -> SourceJson {
    json::quoted(value).expect("A source string is valid JSON")
}
pub(crate) fn object(fields: Vec<(&str, SourceJson)>) -> SourceJson {
    json::object(fields).expect("Source fragments form a valid JSON object")
}
pub(crate) fn object_keys(fields: Vec<(JsString16, SourceJson)>) -> SourceJson {
    json::object_keys(fields).expect("Source fragments form a valid JSON object")
}
pub(crate) fn array(values: &[SourceJson]) -> SourceJson {
    json::json_array(values).expect("Source fragments form a valid JSON array")
}
pub(crate) fn get(value: &SourceJson, name: &str) -> SourceJson {
    json::member(value, name).unwrap_or_else(null)
}
pub(crate) fn present(value: &SourceJson, name: &str) -> Option<SourceJson> {
    json::member(value, name)
}
pub(crate) fn is_null(value: &SourceJson) -> bool {
    value.as_str() == "null"
}
pub(crate) fn is(value: &SourceJson, expected: &str) -> bool {
    json::string(value).is_some_and(|s| s.as_units().iter().copied().eq(expected.encode_utf16()))
}
pub(crate) fn boolean(value: &SourceJson) -> Option<bool> {
    match value.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
pub(crate) fn set(value: &mut SourceJson, name: &str, replacement: SourceJson) {
    let mut fields = json::entries(value).expect("The provider owns an object here");
    let key = JsString16::from_utf8(name);
    if let Some((_, current)) = fields.iter_mut().find(|(field, _)| *field == key) {
        *current = replacement;
    } else {
        fields.push((key, replacement));
    }
    *value = object_keys(fields);
}
pub(crate) fn remove(value: &mut SourceJson, name: &str) {
    let key = JsString16::from_utf8(name);
    let mut fields = json::entries(value).expect("The provider owns an object here");
    fields.retain(|(field, _)| *field != key);
    *value = object_keys(fields);
}
pub(crate) fn string(value: &SourceJson) -> Option<JsString16> {
    json::string(value)
}
/// Structural control only, never ordinary payload text or an opaque argument.
pub(crate) fn control(value: &SourceJson) -> Option<String> {
    string(value).and_then(|value| value.try_utf8().ok())
}
pub(crate) fn concat(parts: &[&JsString16]) -> JsString16 {
    JsString16::from_units(
        parts
            .iter()
            .flat_map(|part| part.as_units().iter().copied())
            .collect(),
    )
}
pub(crate) fn trim(value: &JsString16) -> JsString16 {
    let units = value.as_units();
    let white = |unit: &u16| {
        char::from_u32(u32::from(*unit)).is_some_and(gateway_schema::util::js_whitespace)
    };
    let start = units.iter().take_while(|unit| white(unit)).count();
    let end = units.len()
        - units[start..]
            .iter()
            .rev()
            .take_while(|unit| white(unit))
            .count();
    JsString16::from_units(units[start..end].to_vec())
}
pub(crate) fn nonempty(value: &SourceJson) -> Option<JsString16> {
    string(value).filter(|value| !trim(value).as_units().is_empty())
}
pub(crate) fn invalid(message: impl Into<JsString16>, param: &str) -> SourceRequestError {
    SourceRequestError::invalid(message, Some(JsString16::from_utf8(param)))
}
pub(crate) fn canonical(value: &SourceJson) -> Result<SourceJson> {
    json::canonical(value).map_err(SourceRequestError::from_gateway)
}
pub(crate) fn path(value: &SourceJson, names: &[&str]) -> SourceJson {
    names
        .iter()
        .fold(value.clone(), |value, name| get(&value, name))
}
pub(crate) fn join(parts: &[JsString16], separator: &str) -> JsString16 {
    let mut units = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend_from_slice(part.as_units());
    }
    JsString16::from_units(units)
}
/// Only legacy callers that supplied an actual scalar Value receive a scalar error.
pub(crate) fn scalar_error(error: SourceRequestError) -> gateway_core::GatewayError {
    let body = get(error.body(), "error");
    let Some(message) = control(&get(&body, "message")) else {
        return error.diagnostic().clone();
    };
    let kind = control(&get(&body, "type")).unwrap_or_else(|| "invalid_request_error".into());
    let code = control(&get(&body, "code"));
    let mut scalar =
        gateway_core::GatewayError::new(error.status, message, code.as_deref()).with_type(&kind);
    if let Some(param) = present(&body, "param") {
        scalar = scalar.with_param(control(&param).as_deref());
    }
    scalar
}

pub(crate) fn starts(value: &JsString16, prefix: &str) -> bool {
    value
        .as_units()
        .starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
}
