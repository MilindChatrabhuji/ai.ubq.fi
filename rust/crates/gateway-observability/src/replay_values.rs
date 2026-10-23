//! Logical JSON leaves for declared replay record schemas, with explicit ProfileV2 text.
use crate::store;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_json::SourceJson,
    state::{RecordKey, RecordMutation, StoredRecord},
    value::{PortableValue, ValueEncoding},
};
use serde::Serialize;

#[derive(Clone)]
pub(crate) struct SourceObject {
    entries: Vec<(JsString16, SourceJson)>,
}
impl SourceObject {
    pub(crate) fn parse(document: &SourceJson) -> Result<Self, GatewayError> {
        let document = SourceJson::parse(
            document
                .as_str()
                .trim_matches(|c| matches!(c, ' ' | '\n' | '\r' | '\t')),
        )?;
        let mut entries: Vec<(JsString16, SourceJson)> = Vec::new();
        for (key, value) in document.object_entries()? {
            if let Some((_, old)) = entries.iter_mut().find(|(name, _)| name == &key) {
                *old = value
            } else {
                entries.push((key, value))
            }
        }
        Ok(Self { entries })
    }
    pub(crate) fn get(&self, name: &str) -> Option<&SourceJson> {
        let name = JsString16::from_utf8(name);
        self.entries
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, v)| v)
    }
    pub(crate) fn set<T: Serialize + ?Sized>(
        &mut self,
        name: &str,
        value: &T,
    ) -> Result<(), GatewayError> {
        let name = JsString16::from_utf8(name);
        let value = SourceJson::from_serializable(value)?;
        if let Some((_, old)) = self.entries.iter_mut().find(|(key, _)| *key == name) {
            *old = value
        } else {
            self.entries.push((name, value))
        }
        Ok(())
    }
    pub(crate) fn select(&self, names: &[&str]) -> Result<SourceJson, GatewayError> {
        let entries = self
            .entries
            .iter()
            .filter(|(key, _)| {
                names
                    .iter()
                    .any(|name| key.as_units().iter().copied().eq(name.encode_utf16()))
            })
            .cloned()
            .collect();
        Self { entries }.source_json()
    }
    pub(crate) fn source_json(&self) -> Result<SourceJson, GatewayError> {
        let mut text = String::from("{");
        for (index, (key, value)) in self.entries.iter().enumerate() {
            if index > 0 {
                text.push(',')
            }
            text.push_str(key.to_source_json()?.as_str());
            text.push(':');
            text.push_str(value.as_str());
        }
        text.push('}');
        SourceJson::parse(&text)
    }
}
pub(crate) fn read_json_record(row: &StoredRecord) -> Result<SourceJson, GatewayError> {
    match row.value_encoding {
        ValueEncoding::Json => SourceJson::from_serializable(row.json_value()?),
        ValueEncoding::ProfileV2 => row.profile_v2_source_json(),
        ValueEncoding::ProfileV1 | ValueEncoding::SourceGraphV1 => Err(store::error(
            "Replay metadata requires explicit Json or ProfileV2 encoding",
        )),
    }
}
/// This input is JSON text, never a structured-clone graph or inferred sentinel shape.
fn portable_json(document: &SourceJson) -> Result<PortableValue, GatewayError> {
    let text = document.as_str().trim();
    Ok(match text.as_bytes().first() {
        Some(b'{') => {
            let object = SourceObject::parse(document)?;
            PortableValue::ObjectUtf16(
                object
                    .entries
                    .iter()
                    .map(|(name, value)| Ok((name.clone(), portable_json(value)?)))
                    .collect::<Result<_, GatewayError>>()?,
            )
        }
        Some(b'[') => PortableValue::Array(
            document
                .array_items()?
                .iter()
                .map(portable_json)
                .collect::<Result<_, _>>()?,
        ),
        Some(b'"') => PortableValue::StringUtf16(document.deserialize::<JsString16>()?),
        Some(b'n') => PortableValue::Null,
        Some(b't') => PortableValue::Boolean(true),
        Some(b'f') => PortableValue::Boolean(false),
        _ => PortableValue::number(
            text.parse::<f64>()
                .map_err(|_| store::error("Invalid replay JSON number"))?,
        ),
    })
}
pub(crate) fn put_json<H: crate::types::ObservabilityHost>(
    host: &H,
    key: RecordKey,
    document: &SourceJson,
    expiry: Option<i64>,
) -> Result<RecordMutation, GatewayError> {
    let value = portable_json(document)?;
    let revision = store::uuid(host)?;
    let record = if let Some(json) = value.to_json_lossless() {
        StoredRecord::json(revision, json, expiry)
    } else {
        StoredRecord::profile_v2(revision, value, expiry)?
    };
    Ok(RecordMutation::Put { key, record })
}
