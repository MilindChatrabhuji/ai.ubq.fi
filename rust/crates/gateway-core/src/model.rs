//! Opaque source model data, never an eligibility decision or authority capability.
use crate::{GatewayError, js_string::JsString16, source_json::SourceJson};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ModelId(JsString16);

impl ModelId {
    pub fn from_source(value: JsString16) -> Self {
        Self(value)
    }
    pub fn from_scalar(value: &str) -> Self {
        Self(JsString16::from_utf8(value))
    }
    pub fn as_js_string(&self) -> &JsString16 {
        &self.0
    }
    pub fn into_js_string(self) -> JsString16 {
        self.0
    }
    pub fn matches_scalar(&self, value: &str) -> bool {
        self.0.as_units().iter().copied().eq(value.encode_utf16())
    }
    pub fn to_source_json(&self) -> Result<SourceJson, GatewayError> {
        self.0.to_source_json()
    }
}

impl From<JsString16> for ModelId {
    fn from(value: JsString16) -> Self {
        Self::from_source(value)
    }
}
impl From<&str> for ModelId {
    fn from(value: &str) -> Self {
        Self::from_scalar(value)
    }
}
impl From<String> for ModelId {
    fn from(value: String) -> Self {
        Self::from_scalar(&value)
    }
}
