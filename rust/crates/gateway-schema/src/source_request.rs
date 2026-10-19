//! Ordinary-request data views; no provider dispatch or authority is implemented here.
mod error;
pub use error::SourceRequestError;
use gateway_core::{js_string::JsString16, source_json::SourceJson};

pub const MAX_ACCEPTED_JSON_BODY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum SourceField<T> {
    Missing,
    Null,
    Value(T),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourceModelRequest {
    Default,
    Named(JsString16),
}

/// Private construction retains one immutable document; this is data, not admission.
#[derive(Clone)]
pub struct SourceRequestDocument {
    original: SourceJson,
}
impl std::fmt::Debug for SourceRequestDocument {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("SourceRequestDocument")
            .field("bytes", &self.original.as_bytes().len())
            .finish()
    }
}
impl SourceRequestDocument {
    pub fn new(original: SourceJson) -> Result<Self, SourceRequestError> {
        original
            .object_entries()
            .map_err(|_| SourceRequestError::scalar("Invalid JSON body", None))?;
        Ok(Self { original })
    }
    pub fn original_source(&self) -> &SourceJson {
        &self.original
    }
    pub fn model_request(&self) -> Result<SourceModelRequest, SourceRequestError> {
        model_request(member(&self.original, "model")?.as_ref())
    }
    pub fn stream(&self) -> Result<bool, SourceRequestError> {
        parse_stream(member(&self.original, "stream")?.as_ref())
    }
    pub fn instructions(&self) -> Result<SourceField<JsString16>, SourceRequestError> {
        parse_instructions(member(&self.original, "instructions")?.as_ref())
    }
}

pub fn parse_http_body(bytes: &[u8]) -> Result<SourceJson, SourceRequestError> {
    if bytes.is_empty() || bytes.len() > MAX_ACCEPTED_JSON_BODY_BYTES {
        return Err(SourceRequestError::scalar("Invalid JSON body", None));
    }
    // Source TextDecoder replacement happens once at the HTTP byte boundary,
    // never on escaped JSON string leaves or a UTF16 string value.
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    SourceJson::parse(text).map_err(|_| SourceRequestError::scalar("Invalid JSON body", None))
}

pub(crate) fn member(
    value: &SourceJson,
    name: &str,
) -> Result<Option<SourceJson>, SourceRequestError> {
    Ok(value
        .object_entries()
        .map_err(|_| SourceRequestError::scalar("Invalid JSON body", None))?
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, value)| value))
}
fn is_null(value: &SourceJson) -> bool {
    value.as_str() == "null"
}
fn string(value: &SourceJson) -> Option<JsString16> {
    value.deserialize::<JsString16>().ok()
}
pub(crate) fn trim(value: &JsString16) -> JsString16 {
    let units = value.as_units();
    let white =
        |unit: &u16| char::from_u32(u32::from(*unit)).is_some_and(crate::util::js_whitespace);
    let start = units.iter().take_while(|unit| white(unit)).count();
    let end = units.len()
        - units[start..]
            .iter()
            .rev()
            .take_while(|unit| white(unit))
            .count();
    JsString16::from_units(units[start..end].to_vec())
}
pub fn model_request(value: Option<&SourceJson>) -> Result<SourceModelRequest, SourceRequestError> {
    let Some(value) = value.filter(|value| !is_null(value)) else {
        return Ok(SourceModelRequest::Default);
    };
    let Some(value) = string(value) else {
        return Err(SourceRequestError::scalar("model must be a string", None));
    };
    let value = trim(&value);
    Ok(if value.as_units().is_empty() {
        SourceModelRequest::Default
    } else {
        SourceModelRequest::Named(value)
    })
}
pub fn parse_stream(value: Option<&SourceJson>) -> Result<bool, SourceRequestError> {
    match value.map(SourceJson::as_str) {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        _ => Err(SourceRequestError::scalar(
            "stream must be a boolean",
            Some("stream"),
        )),
    }
}
pub fn parse_instructions(
    value: Option<&SourceJson>,
) -> Result<SourceField<JsString16>, SourceRequestError> {
    let Some(value) = value else {
        return Ok(SourceField::Missing);
    };
    if is_null(value) {
        return Ok(SourceField::Null);
    }
    string(value)
        .map(SourceField::Value)
        .ok_or_else(|| SourceRequestError::scalar("instructions must be a string", None))
}

pub fn resolve_model(
    value: Option<&SourceJson>,
    default: Option<&str>,
) -> Result<JsString16, SourceRequestError> {
    match model_request(value)? {
        SourceModelRequest::Named(value) => Ok(value),
        SourceModelRequest::Default => default.map(JsString16::from_utf8).ok_or_else(|| SourceRequestError::from_scalar(
            gateway_core::GatewayError::new(503, "Default model is unavailable: no configured default model or Codex model snapshot.", Some("server_error")))),
    }
}

pub(crate) fn scalar_value(
    value: Option<&serde_json::Value>,
) -> Result<Option<SourceJson>, gateway_core::GatewayError> {
    value.map(SourceJson::from_serializable).transpose()
}
