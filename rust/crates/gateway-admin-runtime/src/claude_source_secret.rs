//! Claude record data, not a validated token, header or runtime permission.
use gateway_auth::crypto::Secret;
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};

#[derive(Eq, PartialEq)]
pub struct ClaudeSourceSecret(JsString16);
impl ClaudeSourceSecret {
    pub fn from_source(value: JsString16) -> Self {
        Self(value)
    }
    /// Exact data conversion only. The actual host must still validate its wire.
    pub fn try_scalar_secret(&self) -> Result<Secret, GatewayError> {
        self.0.try_utf8().map(Secret::new).map_err(|_| {
            GatewayError::unavailable(
                "Claude credential cannot be represented on this scalar data port.",
                "claude_source_secret_not_scalar",
            )
        })
    }
    pub(crate) fn source_json(&self) -> SourceJson {
        self.0.to_source_json().expect("validated source string")
    }
    pub(crate) fn hint(&self) -> JsString16 {
        let units = self.0.as_units();
        if units.len() <= 18 {
            return JsString16::from_utf8("configured");
        }
        let mut hint = units[..14].to_vec();
        hint.extend_from_slice(&[46, 46, 46]);
        hint.extend_from_slice(&units[units.len() - 4..]);
        JsString16::from_units(hint)
    }
}
impl std::fmt::Debug for ClaudeSourceSecret {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("[redacted]")
    }
}
