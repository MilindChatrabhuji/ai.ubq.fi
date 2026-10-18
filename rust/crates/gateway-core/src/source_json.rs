//! Validated JSON bytes; raw string leaves never pass through serde_json::Value.
use crate::{GatewayError, js_string::JsString16, value::PortableValue};
use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{DeserializeOwned, Error},
};
use serde_json::value::RawValue;

#[derive(Clone)]
pub struct SourceJson(Box<RawValue>);
impl std::fmt::Debug for SourceJson {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("SourceJson")
            .field("bytes", &self.as_bytes().len())
            .finish()
    }
}
impl PartialEq for SourceJson {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}
impl Eq for SourceJson {}
impl SourceJson {
    pub fn parse(text: &str) -> Result<Self, GatewayError> {
        RawValue::from_string(text.into())
            .map(Self)
            .map_err(|_| invalid())
    }
    pub fn parse_bytes(bytes: &[u8]) -> Result<Self, GatewayError> {
        Self::parse(std::str::from_utf8(bytes).map_err(|_| invalid())?)
    }
    pub fn from_serializable<T: Serialize + ?Sized>(value: &T) -> Result<Self, GatewayError> {
        let text = serde_json::to_string(value).map_err(|_| invalid())?;
        Self::parse(&text)
    }
    pub fn from_portable_json(value: &PortableValue) -> Result<Self, GatewayError> {
        value.validate_for_storage_v2()?;
        let mut out = String::new();
        write_value(value, &mut out)?;
        Self::parse(&out)
    }
    pub fn as_str(&self) -> &str {
        self.0.get()
    }
    pub fn as_bytes(&self) -> &[u8] {
        self.as_str().as_bytes()
    }
    pub fn as_raw(&self) -> &RawValue {
        &self.0
    }
    /// Raw member order and duplicates are preserved; consumers apply their source schema.
    pub fn object_entries(&self) -> Result<Vec<(JsString16, Self)>, GatewayError> {
        let text = self.as_str();
        let bytes = text.as_bytes();
        if bytes.first() != Some(&b'{') {
            return Err(invalid());
        }
        let mut at = skip_space(bytes, 1);
        let mut entries = Vec::new();
        while bytes.get(at) != Some(&b'}') {
            let end = string_end(bytes, at)?;
            let token = RawValue::from_string(text[at..end].into()).map_err(|_| invalid())?;
            let key = JsString16::from_json_token(&token)?;
            at = skip_space(bytes, end);
            if bytes.get(at) != Some(&b':') {
                return Err(invalid());
            }
            at = skip_space(bytes, at + 1);
            let end = value_end(bytes, at)?;
            entries.push((key, Self::parse(&text[at..end])?));
            at = skip_space(bytes, end);
            if bytes.get(at) == Some(&b',') {
                at = skip_space(bytes, at + 1);
            } else {
                break;
            }
        }
        if bytes.get(at) != Some(&b'}') {
            return Err(invalid());
        }
        Ok(entries)
    }
    pub fn array_items(&self) -> Result<Vec<Self>, GatewayError> {
        let text = self.as_str();
        let bytes = text.as_bytes();
        if bytes.first() != Some(&b'[') {
            return Err(invalid());
        }
        let mut at = skip_space(bytes, 1);
        let mut items = Vec::new();
        while bytes.get(at) != Some(&b']') {
            let end = value_end(bytes, at)?;
            items.push(Self::parse(&text[at..end])?);
            at = skip_space(bytes, end);
            if bytes.get(at) == Some(&b',') {
                at = skip_space(bytes, at + 1);
            } else {
                break;
            }
        }
        if bytes.get(at) != Some(&b']') {
            return Err(invalid());
        }
        Ok(items)
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.as_bytes().to_vec()
    }
    pub fn deserialize<T: DeserializeOwned>(&self) -> Result<T, GatewayError> {
        serde_json::from_str(self.as_str()).map_err(|_| invalid())
    }
}
fn skip_space(bytes: &[u8], mut at: usize) -> usize {
    while bytes
        .get(at)
        .is_some_and(|v| matches!(v, b' ' | b'\n' | b'\r' | b'\t'))
    {
        at += 1;
    }
    at
}
fn string_end(bytes: &[u8], at: usize) -> Result<usize, GatewayError> {
    if bytes.get(at) != Some(&b'"') {
        return Err(invalid());
    }
    let mut end = at + 1;
    while end < bytes.len() {
        match bytes[end] {
            b'\\' => end += 2,
            b'"' => return Ok(end + 1),
            _ => end += 1,
        }
    }
    Err(invalid())
}
/// Only locates boundaries inside a value already validated by RawValue.
fn value_end(bytes: &[u8], at: usize) -> Result<usize, GatewayError> {
    match bytes.get(at) {
        Some(b'"') => string_end(bytes, at),
        Some(b'{' | b'[') => {
            let mut stack = vec![bytes[at]];
            let mut end = at + 1;
            while let Some(&byte) = bytes.get(end) {
                match byte {
                    b'"' => {
                        end = string_end(bytes, end)?;
                        continue;
                    }
                    b'{' | b'[' => stack.push(byte),
                    b'}' | b']' => {
                        let open = stack.pop().ok_or_else(invalid)?;
                        if !matches!((open, byte), (b'{', b'}') | (b'[', b']')) {
                            return Err(invalid());
                        }
                        if stack.is_empty() {
                            return Ok(end + 1);
                        }
                    }
                    _ => {}
                }
                end += 1;
            }
            Err(invalid())
        }
        Some(_) => {
            let mut end = at;
            while bytes
                .get(end)
                .is_some_and(|v| !matches!(v, b',' | b']' | b'}' | b' ' | b'\n' | b'\r' | b'\t'))
            {
                end += 1;
            }
            if end == at { Err(invalid()) } else { Ok(end) }
        }
        None => Err(invalid()),
    }
}
impl Serialize for SourceJson {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for SourceJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        Self::parse(raw.get()).map_err(|_| D::Error::custom("Invalid source JSON"))
    }
}
fn write_value(value: &PortableValue, out: &mut String) -> Result<(), GatewayError> {
    match value {
        PortableValue::Null => out.push_str("null"),
        PortableValue::Boolean(v) => out.push_str(if *v { "true" } else { "false" }),
        PortableValue::String(v) => out.push_str(&JsString16::from_utf8(v).json_token()),
        PortableValue::StringUtf16(v) => out.push_str(&v.json_token()),
        PortableValue::NumberBits(_) => {
            let v = value.to_json_lossless().ok_or_else(invalid)?;
            out.push_str(&serde_json::to_string(&v).map_err(|_| invalid())?);
        }
        PortableValue::Array(values) => {
            out.push('[');
            for (at, value) in values.iter().enumerate() {
                if at != 0 {
                    out.push(',');
                }
                write_value(value, out)?;
            }
            out.push(']');
        }
        PortableValue::Object(values) => {
            out.push('{');
            for (at, (key, value)) in values.iter().enumerate() {
                if at != 0 {
                    out.push(',');
                }
                out.push_str(&JsString16::from_utf8(key).json_token());
                out.push(':');
                write_value(value, out)?;
            }
            out.push('}');
        }
        PortableValue::ObjectUtf16(values) => {
            out.push('{');
            for (at, (key, value)) in values.iter().enumerate() {
                if at != 0 {
                    out.push(',');
                }
                out.push_str(&key.json_token());
                out.push(':');
                write_value(value, out)?;
            }
            out.push('}');
        }
        _ => return Err(invalid()),
    }
    Ok(())
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Source JSON is malformed or the typed value is not losslessly JSON-representable",
        "source_json_invalid",
    )
}
