//! Lazy policy view over the existing SourceJson parser, never a scalar transcript mirror.
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use serde::{Serialize, Serializer};
use std::{
    ops::{Index, IndexMut},
    sync::OnceLock,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Text {
    units: JsString16,
    scalar: Option<String>,
}
impl Default for Text {
    fn default() -> Self {
        Self::new(JsString16::default())
    }
}
impl Text {
    pub fn new(units: JsString16) -> Self {
        let scalar = units.try_utf8().ok();
        Self { units, scalar }
    }
    pub fn core(&self) -> JsString16 {
        self.units.clone()
    }
    pub fn as_str(&self) -> Option<&str> {
        self.scalar.as_deref()
    }
    pub fn is_empty(&self) -> bool {
        self.units.as_units().is_empty()
    }
    pub fn len(&self) -> usize {
        self.units.as_units().len()
    }
    pub fn trim_matches(&self, predicate: impl Fn(char) -> bool) -> Self {
        let units = self.units.as_units();
        let white = |unit: &u16| char::from_u32(u32::from(*unit)).is_some_and(&predicate);
        let lo = units.iter().take_while(|unit| white(unit)).count();
        let hi = units.len()
            - units[lo..]
                .iter()
                .rev()
                .take_while(|unit| white(unit))
                .count();
        Self::new(JsString16::from_units(units[lo..hi].to_vec()))
    }
    pub fn starts_with(&self, prefix: &str) -> bool {
        self.units
            .as_units()
            .starts_with(&prefix.encode_utf16().collect::<Vec<_>>())
    }
    pub fn ends_with(&self, suffix: &str) -> bool {
        self.units
            .as_units()
            .ends_with(&suffix.encode_utf16().collect::<Vec<_>>())
    }
}
impl Serialize for Text {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.units.serialize(s)
    }
}

#[derive(Clone, Debug)]
pub enum Value {
    Null,
    Bool(bool),
    Number(SourceJson),
    String(Text),
    Array(Vec<Value>),
    Object(Vec<(JsString16, Value)>),
    // Unknown extension payloads stay lazy raw SourceJson, including arbitrarily deep subtrees.
    Raw(SourceJson, OnceLock<Box<Value>>),
}
impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        self.source().ok() == other.source().ok()
    }
}
impl Value {
    pub fn from_source(raw: SourceJson) -> Self {
        match raw.as_str() {
            "null" => Self::Null,
            "true" => Self::Bool(true),
            "false" => Self::Bool(false),
            text if text.starts_with('"') => Self::String(Text::new(
                source::string(&raw).expect("Validated source string"),
            )),
            text if text.starts_with('{') || text.starts_with('[') => {
                Self::Raw(raw, OnceLock::new())
            }
            _ => Self::Number(raw),
        }
    }
    fn resolve(&self) -> &Self {
        if let Self::Raw(raw, cache) = self {
            cache.get_or_init(|| {
                Box::new(if raw.as_str().starts_with('{') {
                    Self::Object(
                        source::entries(raw)
                            .expect("Validated source object")
                            .into_iter()
                            .map(|(k, v)| (k, Self::from_source(v)))
                            .collect(),
                    )
                } else {
                    Self::Array(
                        raw.array_items()
                            .expect("Validated source array")
                            .into_iter()
                            .map(Self::from_source)
                            .collect(),
                    )
                })
            })
        } else {
            self
        }
    }
    fn mutable(&mut self) -> &mut Self {
        if matches!(self, Self::Raw(..)) {
            *self = self.resolve().clone();
        }
        self
    }
    pub fn from_serializable<T: Serialize + ?Sized>(value: &T) -> Result<Self, GatewayError> {
        SourceJson::from_serializable(value).map(Self::from_source)
    }
    pub fn object(fields: Vec<(JsString16, Value)>) -> Self {
        Self::Object(fields)
    }
    pub fn source(&self) -> Result<SourceJson, GatewayError> {
        match self {
            Self::Null => SourceJson::parse("null"),
            Self::Bool(v) => SourceJson::from_serializable(v),
            Self::Number(v) | Self::Raw(v, _) => Ok(v.clone()),
            Self::String(v) => source::quoted(&v.units),
            Self::Array(v) => {
                source::json_array(&v.iter().map(Self::source).collect::<Result<Vec<_>, _>>()?)
            }
            Self::Object(v) => source::object_keys(
                v.iter()
                    .map(|(k, v)| Ok((k.clone(), v.source()?)))
                    .collect::<Result<Vec<_>, GatewayError>>()?,
            ),
        }
    }
    pub fn as_object(&self) -> Option<&Vec<(JsString16, Self)>> {
        if let Self::Object(fields) = self.resolve() {
            Some(fields)
        } else {
            None
        }
    }
    pub fn as_object_mut(&mut self) -> Option<&mut Vec<(JsString16, Self)>> {
        if let Self::Object(fields) = self.mutable() {
            Some(fields)
        } else {
            None
        }
    }
    pub fn as_array_mut(&mut self) -> Option<&mut Vec<Self>> {
        if let Self::Array(items) = self.mutable() {
            Some(items)
        } else {
            None
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Self::Number(raw) = self {
            source::number(raw)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(value) = self {
            Some(*value)
        } else {
            None
        }
    }
    pub fn is_number(&self) -> bool {
        matches!(self, Self::Number(_))
    }
    pub fn remove(&mut self, key: &str) -> Option<Self> {
        let Self::Object(fields) = self.mutable() else {
            return None;
        };
        let index = fields
            .iter()
            .position(|(name, _)| name.as_units().iter().copied().eq(key.encode_utf16()))?;
        Some(fields.remove(index).1)
    }
    pub fn is_object(&self) -> bool {
        matches!(self.resolve(), Self::Object(_))
    }
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub fn as_i64(&self) -> Option<i64> {
        if let Self::Number(raw) = self {
            raw.deserialize().ok()
        } else {
            None
        }
    }
    pub fn is_array(&self) -> bool {
        self.as_array().is_some()
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn as_text(&self) -> Option<&Text> {
        if let Self::String(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        self.as_text().and_then(Text::as_str)
    }
    pub fn as_array(&self) -> Option<&Vec<Self>> {
        if let Self::Array(v) = self.resolve() {
            Some(v)
        } else {
            None
        }
    }
    pub fn get(&self, key: &str) -> Option<&Self> {
        if let Self::Object(v) = self.resolve() {
            v.iter()
                .find(|(k, _)| k.as_units().iter().copied().eq(key.encode_utf16()))
                .map(|(_, v)| v)
        } else {
            None
        }
    }
    pub fn pointer(&self, path: &str) -> Option<&Self> {
        let mut value = self;
        for key in path.strip_prefix('/')?.split('/') {
            value = value.get(key)?;
        }
        Some(value)
    }
}
impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.source()
            .map_err(serde::ser::Error::custom)?
            .serialize(s)
    }
}
static NULL: Value = Value::Null;
impl Index<&str> for Value {
    type Output = Value;
    fn index(&self, key: &str) -> &Self::Output {
        self.get(key).unwrap_or(&NULL)
    }
}
impl Index<usize> for Value {
    type Output = Value;
    fn index(&self, index: usize) -> &Self::Output {
        self.as_array().and_then(|v| v.get(index)).unwrap_or(&NULL)
    }
}
impl IndexMut<&str> for Value {
    fn index_mut(&mut self, key: &str) -> &mut Self::Output {
        let Self::Object(fields) = self.mutable() else {
            panic!("Object mutation requires validated object")
        };
        let index = fields
            .iter()
            .position(|(k, _)| k.as_units().iter().copied().eq(key.encode_utf16()))
            .unwrap_or_else(|| {
                fields.push((JsString16::from_utf8(key), Value::Null));
                fields.len() - 1
            });
        &mut fields[index].1
    }
}

pub(super) fn normalized_string(value: Option<&Value>) -> Option<Text> {
    value
        .and_then(Value::as_text)
        .map(|v| v.trim_matches(crate::util::js_whitespace))
        .filter(|v| !v.is_empty())
}
pub(super) fn join(values: &[Text], separator: &str) -> Text {
    let mut units = vec![];
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend_from_slice(value.units.as_units());
    }
    Text::new(JsString16::from_units(units))
}
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{$crate::source_request::value::Value::object(vec![$((gateway_core::js_string::JsString16::from_utf8($key),$crate::source_request::value::Value::from_serializable(&$value).expect("Source normalization fields serialize"))),*])};
    ($value:expr)=>{$crate::source_request::value::Value::from_serializable(&$value).expect("Source normalization value serializes")};
}
pub(super) use json;

pub(super) fn unknown_key(value: &Value, allowed: &[&str]) -> Option<JsString16> {
    source::entries(&value.source().ok()?)?
        .into_iter()
        .map(|(key, _)| key)
        .find(|key| {
            !allowed
                .iter()
                .any(|name| key.as_units().iter().copied().eq(name.encode_utf16()))
        })
}
pub(super) fn keyed_error(
    prefix: &str,
    key: &JsString16,
    param_prefix: Option<&str>,
) -> super::SourceRequestError {
    let mut message = prefix.encode_utf16().collect::<Vec<_>>();
    message.extend_from_slice(key.as_units());
    let param = param_prefix.map(|prefix| {
        let mut units = prefix.encode_utf16().collect::<Vec<_>>();
        units.extend_from_slice(key.as_units());
        JsString16::from_units(units)
    });
    super::SourceRequestError::invalid(JsString16::from_units(message), param)
}
