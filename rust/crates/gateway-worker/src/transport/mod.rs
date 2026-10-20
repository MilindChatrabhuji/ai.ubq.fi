//! Worker transport primitives. Authentication, provider policy and settlement
//! remain with their domain owners; transport EOF never becomes delivery proof.

pub mod aead;
pub mod body;
pub mod claude_body;
pub mod crypto;
pub mod outbound;
pub mod random;
pub(crate) mod relay_delay;
pub mod stream;
pub mod websocket;

use std::collections::BTreeMap;

use gateway_core::GatewayError;
use worker::Request;

/// Bounds supplied by the route's existing policy, never by a client header.
#[derive(Clone, Copy)]
pub struct HeaderLimits {
    pub total_bytes: usize,
    pub value_bytes: usize,
    pub fields: usize,
}

pub fn bounded_headers(
    request: &Request,
    limits: HeaderLimits,
) -> Result<BTreeMap<String, String>, GatewayError> {
    let mut headers = BTreeMap::new();
    let mut total = 0_usize;
    for (name, value) in request.headers().entries() {
        total = total
            .checked_add(name.len())
            .and_then(|size| size.checked_add(value.len()))
            .ok_or_else(headers_too_large)?;
        if total > limits.total_bytes
            || value.len() > limits.value_bytes
            || headers.len() >= limits.fields
        {
            return Err(headers_too_large());
        }
        if matches!(
            name.as_str(),
            "authorization" | "x-api-key" | "x-ubiquity-kernel-token"
        ) && value.contains(',')
        {
            return Err(GatewayError::new(
                400,
                "Ambiguous credential header.",
                Some("ambiguous_credential_header"),
            ));
        }
        headers.insert(name.to_ascii_lowercase(), value);
    }
    Ok(headers)
}

fn headers_too_large() -> GatewayError {
    GatewayError::new(
        431,
        "Request headers are too large.",
        Some("request_headers_too_large"),
    )
}

pub fn platform_error(message: &str, code: &str) -> GatewayError {
    GatewayError::new(502, message, Some(code)).with_type("server_error")
}
