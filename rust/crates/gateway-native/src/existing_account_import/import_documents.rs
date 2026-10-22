//! Native-private credential parsing/merge. Unrelated UTF16 data never passes through Value.
use super::super::import_custody_protocol::unavailable;
use gateway_auth::native_credentials::{NativeCredentials, parse_native_document};
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};

pub(super) fn member(
    document: &SourceJson,
    name: &str,
) -> Result<Option<SourceJson>, GatewayError> {
    let key = JsString16::from_utf8(name);
    Ok(document
        .object_entries()?
        .into_iter()
        .rev()
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v))
}
pub(super) fn credentials(document: &SourceJson) -> Result<NativeCredentials, GatewayError> {
    let tokens = member(document, "tokens")?.ok_or_else(unavailable)?;
    let mut known_tokens = serde_json::Map::new();
    for name in ["access_token", "refresh_token", "account_id", "id_token"] {
        if let Some(value) = member(&tokens, name)? {
            known_tokens.insert(name.into(), value.deserialize()?);
        }
    }
    let mut known = serde_json::Map::new();
    known.insert("tokens".into(), serde_json::Value::Object(known_tokens));
    for name in ["auth_mode", "last_refresh", "OPENAI_API_KEY"] {
        if let Some(value) = member(document, name)? {
            known.insert(name.into(), value.deserialize()?);
        }
    }
    parse_native_document(&serde_json::Value::Object(known))
}
pub(super) fn merge(
    previous: &SourceJson,
    incoming: &SourceJson,
) -> Result<SourceJson, GatewayError> {
    let fields = ["tokens", "last_refresh", "auth_mode"];
    let mut entries = previous.object_entries()?;
    entries.retain(|(key, _)| {
        !fields
            .iter()
            .any(|name| *key == JsString16::from_utf8(name))
    });
    for name in fields {
        if let Some(value) = member(incoming, name)? {
            entries.push((JsString16::from_utf8(name), value));
        } else if name == "tokens" {
            return Err(unavailable());
        }
    }
    object(entries)
}
pub(super) fn object(entries: Vec<(JsString16, SourceJson)>) -> Result<SourceJson, GatewayError> {
    let mut output = String::from("{");
    for (at, (key, value)) in entries.into_iter().enumerate() {
        if at != 0 {
            output.push(',');
        }
        output.push_str(key.to_source_json()?.as_str());
        output.push(':');
        output.push_str(value.as_str());
    }
    output.push('}');
    SourceJson::parse(&output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_utf16_keys_values_and_independent_api_fields_survive_native_merge() {
        let old = SourceJson::parse(r#"{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT","other":"\ud800","\udfff":{"nested":[1,"\udc00"]},"tokens":{"account_id":"fixture","access_token":"old","refresh_token":"old-refresh"}}"#).unwrap();
        let new = SourceJson::parse(r#"{"tokens":{"account_id":"fixture","access_token":"new","refresh_token":"new-refresh","ignored":"\ud800"},"last_refresh":"2000-01-01T00:00:00Z","OPENAI_API_KEY":"MUST_NOT_REPLACE"}"#).unwrap();
        let merged = merge(&old, &new).unwrap();
        for name in ["OPENAI_API_KEY", "other"] {
            assert_eq!(member(&merged, name).unwrap(), member(&old, name).unwrap());
        }
        let surrogate = JsString16::from_units(vec![0xdfff]);
        assert_eq!(
            merged
                .object_entries()
                .unwrap()
                .into_iter()
                .find(|(k, _)| *k == surrogate),
            old.object_entries()
                .unwrap()
                .into_iter()
                .find(|(k, _)| *k == surrogate)
        );
        let credentials = credentials(&merged).unwrap();
        assert_eq!(credentials.access_token.expose(), "new");
        assert_eq!(credentials.refresh_token.expose(), "new-refresh");
        assert_eq!(
            credentials.native_refreshed_at.as_deref(),
            Some("2000-01-01T00:00:00Z")
        );
        assert_eq!(
            member(&member(&merged, "tokens").unwrap().unwrap(), "ignored")
                .unwrap()
                .unwrap()
                .as_str(),
            r#""\ud800""#
        );
    }
}
