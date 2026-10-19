//! Keep platform responses intact where workers-rs would drop status text or an upgrade.
use worker::{Headers, IntoResponse, Response};

pub enum GatewayResponse {
    Http(Response),
    Raw(worker::web_sys::Response),
}
impl From<Response> for GatewayResponse {
    fn from(response: Response) -> Self {
        Self::Http(response)
    }
}
impl GatewayResponse {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::Http(response) => response.status_code(),
            Self::Raw(response) => response.status(),
        }
    }
    pub fn headers(&self) -> Headers {
        match self {
            Self::Http(response) => response.headers().clone(),
            Self::Raw(response) => response.headers().into(),
        }
    }
    pub fn headers_mut(&mut self) -> Headers {
        self.headers()
    }
}
impl IntoResponse for GatewayResponse {
    fn into_raw(self) -> Result<worker::web_sys::Response, impl Into<Box<dyn std::error::Error>>> {
        Ok::<_, worker::Error>(match self {
            Self::Http(response) => response.into(),
            Self::Raw(response) => response,
        })
    }
}
