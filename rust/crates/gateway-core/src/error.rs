use serde::Serialize;

/// `None` omits param; `Some(None)` emits null, matching src/http.ts openaiError.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OpenAiError {
    pub message: String,
    #[serde(rename = "type")]
    pub error_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct OpenAiErrorEnvelope {
    pub error: OpenAiError,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GatewayError {
    pub status: u16,
    pub envelope: OpenAiErrorEnvelope,
}

impl GatewayError {
    pub fn new(status: u16, message: impl Into<String>, code: Option<&str>) -> Self {
        Self {
            status,
            envelope: OpenAiErrorEnvelope {
                error: OpenAiError {
                    message: message.into(),
                    error_type: "invalid_request_error".to_owned(),
                    code: code.map(str::to_owned),
                    param: None,
                },
            },
        }
    }

    pub fn with_type(mut self, error_type: &str) -> Self {
        let trimmed = error_type.trim();
        self.envelope.error.error_type = if trimmed.is_empty() {
            "invalid_request_error".to_owned()
        } else {
            trimmed.to_owned()
        };
        self
    }

    pub fn with_param(mut self, param: Option<&str>) -> Self {
        self.envelope.error.param = Some(param.map(str::to_owned));
        self
    }

    pub fn unavailable(message: impl Into<String>, code: &str) -> Self {
        Self::new(503, message, Some(code)).with_type("server_error")
    }
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.envelope.error.message)
    }
}

impl std::error::Error for GatewayError {}
