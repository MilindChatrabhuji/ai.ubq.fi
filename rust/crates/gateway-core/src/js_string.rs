//! A JavaScript string is a sequence of UTF16 code units, not necessarily scalar text.
use crate::{GatewayError, source_json::SourceJson};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
use serde_json::value::RawValue;

#[derive(Clone, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct JsString16(Vec<u16>);

impl std::fmt::Debug for JsString16 {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("JsString16").field(&self.0).finish()
    }
}

impl JsString16 {
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }
    pub fn from_utf8(text: &str) -> Self {
        Self(text.encode_utf16().collect())
    }
    pub fn as_units(&self) -> &[u16] {
        &self.0
    }
    pub fn into_units(self) -> Vec<u16> {
        self.0
    }
    pub fn prefix_units(&self, limit: usize) -> Self {
        Self(self.0[..self.0.len().min(limit)].to_vec())
    }
    pub fn try_utf8(&self) -> Result<String, GatewayError> {
        String::from_utf16(&self.0).map_err(|_| invalid())
    }
    /// Source replace(/\s+/g, " ").trim(), followed by slice(0, limit).
    pub fn sanitize_js_whitespace_prefix(&self, limit: usize) -> Option<Self> {
        let mut units = Vec::new();
        let mut pending = false;
        for &unit in &self.0 {
            if whitespace(unit) {
                pending = !units.is_empty();
            } else {
                if pending {
                    units.push(32);
                }
                units.push(unit);
                pending = false;
            }
        }
        if units.is_empty() {
            return None;
        }
        units.truncate(limit);
        Some(Self(units))
    }
    /// The safe RawValue parser has already checked the surrounding JSON grammar.
    pub fn from_json_token(raw: &RawValue) -> Result<Self, GatewayError> {
        let text = raw.get();
        let bytes = text.as_bytes();
        if bytes.len() < 2 || bytes.first() != Some(&b'"') || bytes.last() != Some(&b'"') {
            return Err(invalid());
        }
        let mut units = Vec::new();
        let mut at = 1;
        let end = bytes.len() - 1;
        while at < end {
            if bytes[at] == b'\\' {
                at += 1;
                let unit = match bytes.get(at).copied().ok_or_else(invalid)? {
                    b'"' => 34,
                    b'\\' => 92,
                    b'/' => 47,
                    b'b' => 8,
                    b'f' => 12,
                    b'n' => 10,
                    b'r' => 13,
                    b't' => 9,
                    b'u' => {
                        let digits = text.get(at + 1..at + 5).ok_or_else(invalid)?;
                        let value = u16::from_str_radix(digits, 16).map_err(|_| invalid())?;
                        at += 4;
                        value
                    }
                    _ => return Err(invalid()),
                };
                units.push(unit);
                at += 1;
            } else {
                let ch = text[at..end].chars().next().ok_or_else(invalid)?;
                let mut encoded = [0; 2];
                units.extend_from_slice(ch.encode_utf16(&mut encoded));
                at += ch.len_utf8();
            }
        }
        Ok(Self(units))
    }
    pub fn to_source_json(&self) -> Result<SourceJson, GatewayError> {
        SourceJson::parse(&self.json_token())
    }
    pub(crate) fn json_token(&self) -> String {
        use std::fmt::Write;
        let mut out = String::from("\"");
        let mut at = 0;
        while at < self.0.len() {
            let unit = self.0[at];
            match unit {
                8 => out.push_str("\\b"),
                9 => out.push_str("\\t"),
                10 => out.push_str("\\n"),
                12 => out.push_str("\\f"),
                13 => out.push_str("\\r"),
                34 => out.push_str("\\\""),
                92 => out.push_str("\\\\"),
                0..=31 => write!(out, "\\u{unit:04x}").expect("String formatting cannot fail"),
                0xd800..=0xdbff => {
                    if let Some(&low) = self
                        .0
                        .get(at + 1)
                        .filter(|&&v| (0xdc00..=0xdfff).contains(&v))
                    {
                        let scalar =
                            0x10000 + ((u32::from(unit) - 0xd800) << 10) + u32::from(low) - 0xdc00;
                        out.push(char::from_u32(scalar).expect("A surrogate pair forms a scalar"));
                        at += 1;
                    } else {
                        write!(out, "\\u{unit:04x}").expect("String formatting cannot fail");
                    }
                }
                0xdc00..=0xdfff => {
                    write!(out, "\\u{unit:04x}").expect("String formatting cannot fail")
                }
                _ => out.push(
                    char::from_u32(u32::from(unit)).expect("A non-surrogate u16 is a scalar"),
                ),
            }
            at += 1;
        }
        out.push('"');
        out
    }
}

impl From<&str> for JsString16 {
    fn from(value: &str) -> Self {
        Self::from_utf8(value)
    }
}
impl std::str::FromStr for JsString16 {
    type Err = std::convert::Infallible;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(Self::from_utf8(value))
    }
}
impl Serialize for JsString16 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_source_json()
            .map_err(|_| serde::ser::Error::custom("Invalid source JSON string"))?
            .serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for JsString16 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        Self::from_json_token(&raw).map_err(|_| D::Error::custom("Expected a source JSON string"))
    }
}

/// Only explicit ProfileV2 nodes use this physical representation.
pub(crate) mod units {
    use super::*;
    pub fn serialize<S: Serializer>(value: &JsString16, serializer: S) -> Result<S::Ok, S::Error> {
        value.as_units().serialize(serializer)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<JsString16, D::Error> {
        Vec::<u16>::deserialize(deserializer).map(JsString16::from_units)
    }
}

pub(crate) mod optional_units {
    use super::*;
    pub fn serialize<S: Serializer>(
        value: &Option<JsString16>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value
            .as_ref()
            .map(JsString16::as_units)
            .serialize(serializer)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<JsString16>, D::Error> {
        Option::<Vec<u16>>::deserialize(deserializer).map(|v| v.map(JsString16::from_units))
    }
}
fn whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Source JSON string is invalid or cannot be represented as UTF8",
        "source_json_string_invalid",
    )
}
