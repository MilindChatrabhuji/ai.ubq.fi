//! Exact source error strings may themselves contain non-scalar UTF16 units.
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct SourceRequestError {
    pub status: u16,
    body: SourceJson,
    diagnostic: GatewayError,
}
impl SourceRequestError {
    pub fn invalid(message: impl Into<JsString16>, param: Option<JsString16>) -> Self {
        #[derive(Serialize)]
        struct ErrorBody {
            error: ErrorFields,
        }
        #[derive(Serialize)]
        struct ErrorFields {
            message: JsString16,
            #[serde(rename = "type")]
            kind: &'static str,
            code: &'static str,
            #[serde(skip_serializing_if = "Option::is_none")]
            param: Option<JsString16>,
        }
        let body = SourceJson::from_serializable(&ErrorBody {
            error: ErrorFields {
                message: message.into(),
                kind: "invalid_request_error",
                code: "invalid_request_error",
                param,
            },
        })
        .expect("Source error fields are valid JSON");
        Self {
            status: 400,
            body,
            diagnostic: GatewayError::new(
                400,
                "Invalid source request.",
                Some("invalid_request_error"),
            ),
        }
    }
    pub(crate) fn from_scalar(error: GatewayError) -> Self {
        let body = SourceJson::from_serializable(&error.envelope)
            .expect("Scalar error fields are valid JSON");
        Self {
            status: error.status,
            body,
            diagnostic: error,
        }
    }
    pub fn body(&self) -> &SourceJson {
        &self.body
    }
    pub fn diagnostic(&self) -> &GatewayError {
        &self.diagnostic
    }
    pub(crate) fn scalar(message: &str, param: Option<&str>) -> Self {
        Self::invalid(
            JsString16::from_utf8(message),
            param.map(JsString16::from_utf8),
        )
    }
    /// Only the old scalar API calls this after supplying an actual serde Value.
    pub(crate) fn into_scalar(self) -> GatewayError {
        #[derive(serde::Deserialize)]
        struct Body {
            error: Fields,
        }
        #[derive(serde::Deserialize)]
        struct Fields {
            message: String,
            #[serde(rename = "type")]
            kind: String,
            code: Option<String>,
            param: Option<String>,
        }
        match self.body.deserialize::<Body>() {
            Ok(body) => {
                let fields = body.error;
                let mut error =
                    GatewayError::new(self.status, fields.message, fields.code.as_deref())
                        .with_type(&fields.kind);
                if let Some(param) = fields.param {
                    error = error.with_param(Some(&param));
                }
                error
            }
            Err(_) => self.diagnostic,
        }
    }
}
