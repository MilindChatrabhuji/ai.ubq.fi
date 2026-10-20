//! Native-private credential parsing/merge. Unrelated UTF16 data never passes through Value.
use gateway_auth::native_credentials::{NativeCredentials, parse_native_document};
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use super::super::import_custody_protocol::unavailable;

pub(super) fn member(document: &SourceJson, name: &str) -> Result<Option<SourceJson>, GatewayError> {
    let key = JsString16::from_utf8(name);
    Ok(document.object_entries()?.into_iter().rev().find(|(k, _)| *k == key).map(|(_, v)| v))
}
pub(super) fn credentials(document: &SourceJson) -> Result<NativeCredentials, GatewayError> {
    let tokens = member(document, "tokens")?.ok_or_else(unavailable)?;
    let mut known_tokens = serde_json::Map::new();
    for name in ["access_token", "refresh_token", "account_id", "id_token"] {
        if let Some(value) = member(&tokens, name)? { known_tokens.insert(name.into(), value.deserialize()?); }
    }
    let mut known = serde_json::Map::new();
    known.insert("tokens".into(), serde_json::Value::Object(known_tokens));
    for name in ["auth_mode", "last_refresh", "OPENAI_API_KEY"] {
        if let Some(value) = member(document, name)? { known.insert(name.into(), value.deserialize()?); }
    }
    parse_native_document(&serde_json::Value::Object(known))
}
pub(super) fn merge(previous: &SourceJson, incoming: &SourceJson) -> Result<SourceJson, GatewayError> {
    let fields = ["tokens", "last_refresh", "auth_mode"];
    let mut entries = previous.object_entries()?;
    entries.retain(|(key, _)| !fields.iter().any(|name| *key == JsString16::from_utf8(name)));
    for name in fields {
        if let Some(value) = member(incoming, name)? { entries.push((JsString16::from_utf8(name), value)); }
        else if name == "tokens" { return Err(unavailable()); }
    }
    object(entries)
}
pub(super) fn object(entries: Vec<(JsString16, SourceJson)>) -> Result<SourceJson, GatewayError> {
    let mut output = String::from("{");
    for (at, (key, value)) in entries.into_iter().enumerate() {
        if at != 0 { output.push(','); }
        output.push_str(key.to_source_json()?.as_str()); output.push(':'); output.push_str(value.as_str());
    }
    output.push('}'); SourceJson::parse(&output)
}
