//! Exact source error strings may themselves contain non-scalar UTF16 units.
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use serde::Serialize;

#[derive(Clone, Debug)]
pub struct SourceRequestError {
    pub status: u16,
    body: SourceJson,
    diagnostic: Box<GatewayError>,
}
impl SourceRequestError {
    pub fn new(
        status: u16,
        message: impl Into<JsString16>,
        error_type: &str,
        code: Option<&str>,
        param: Option<Option<JsString16>>,
    ) -> Self {
        #[derive(Serialize)]
        struct ErrorBody<'a> {
            error: ErrorFields<'a>,
        }
        #[derive(Serialize)]
        struct ErrorFields<'a> {
            message: JsString16,
            #[serde(rename = "type")]
            kind: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            code: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            param: Option<Option<JsString16>>,
        }
        let body = SourceJson::from_serializable(&ErrorBody {
            error: ErrorFields {
                message: message.into(),
                kind: error_type,
                code,
                param,
            },
        })
        .expect("Source error fields are valid JSON");
        Self {
            status,
            body,
            diagnostic: Box::new(
                GatewayError::new(status, "Invalid source request.", code).with_type(error_type),
            ),
        }
    }
    pub fn invalid(message: impl Into<JsString16>, param: Option<JsString16>) -> Self {
        Self::new(
            400,
            message,
            "invalid_request_error",
            Some("invalid_request_error"),
            param.map(Some),
        )
    }
    /// Lift an existing scalar error without altering status, fields, or exact body.
    pub fn from_gateway(error: GatewayError) -> Self {
        Self::from_scalar(error)
    }
    pub(crate) fn from_scalar(error: GatewayError) -> Self {
        let body = SourceJson::from_serializable(&error.envelope)
            .expect("Scalar error fields are valid JSON");
        Self {
            status: error.status,
            body,
            diagnostic: Box::new(error),
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
                } else if gateway_core::source_serialization::member(&self.body, "error")
                    .and_then(|body| gateway_core::source_serialization::member(&body, "param"))
                    .is_some()
                {
                    error = error.with_param(None);
                }
                error
            }
            Err(_) => *self.diagnostic,
        }
    }
}
