//! Data-only admin field views over the shared source JSON/string grammar.
//! The single AdminInput body stays SourceJson; these views grant no authority.
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_json::SourceJson,
    source_serialization as source,
    state::RecordKey,
    tuple_key::{KeyPart, TupleKey},
};
use serde::Serialize;

pub fn json<T: Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).expect("typed admin data is source JSON")
}
pub fn object(fields: Vec<(&str, SourceJson)>) -> SourceJson {
    source::object(fields).expect("typed admin source object")
}
pub fn member(value: &SourceJson, name: &str) -> Option<SourceJson> {
    source::member(value, name)
}
pub fn text(value: &SourceJson) -> Option<JsString16> {
    source::string(value)
}
pub fn boolean(value: &SourceJson) -> Option<bool> {
    value.deserialize().ok()
}
pub fn number(value: &SourceJson) -> Option<f64> {
    source::number(value)
}
pub fn is_record(value: &SourceJson) -> bool {
    matches!(value.as_str().as_bytes().first(), Some(b'{' | b'['))
}
pub fn set(value: &mut SourceJson, name: &str, next: SourceJson) {
    let key = JsString16::from_utf8(name);
    let mut fields = source::entries(value).expect("constructed admin source object");
    if let Some((_, old)) = fields.iter_mut().find(|(field, _)| field == &key) {
        *old = next;
    } else {
        fields.push((key, next));
    }
    *value = source::object_keys(fields).expect("admin source object fields");
}
/// Source ECMAScript WhiteSpace/LineTerminator, not Rust's broader whitespace.
pub fn whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
pub fn trim(value: &JsString16) -> JsString16 {
    let units = value.as_units();
    let start = units.iter().take_while(|unit| whitespace(**unit)).count();
    let end = units.len()
        - units[start..]
            .iter()
            .rev()
            .take_while(|unit| whitespace(**unit))
            .count();
    JsString16::from_units(units[start..end].to_vec())
}
/// Same source tuple codec as auth::store::key, with an original UTF16 selector.
/// A decoded source value/key is data, not an authenticated operation or a KV handle.
pub fn selected_key(prefix: &[&str], id: &JsString16) -> Result<RecordKey, GatewayError> {
    let mut parts = prefix
        .iter()
        .map(|part| KeyPart::source_string_utf16(&part.encode_utf16().collect::<Vec<_>>()))
        .collect::<Vec<_>>();
    parts.push(KeyPart::source_string_utf16(id.as_units()));
    Ok(TupleKey::from_parts(&parts)?.to_record_key())
}
