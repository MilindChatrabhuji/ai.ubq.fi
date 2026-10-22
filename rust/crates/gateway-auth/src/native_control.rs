//! The physical native control boundary has one operation. References name
//! server-owned authority; deserializing this wire never creates permission.
use serde::{Deserialize, Serialize};

use crate::{GatewayError, crypto::sha256_hex, native::*};

pub const NATIVE_CONTROL_MAX_BYTES: usize = 65_536;
pub const NATIVE_CONTROL_ERROR_MAX_BYTES: usize = 4096;
pub const NATIVE_RENEWAL_MAX_MS: i64 = 45_000;
pub const NATIVE_AUTHORITY_MAX_BYTES: usize = 98_304;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeControlEnvelope {
    pub v: u8,
    pub operation_id: String,
    pub request: NativeControlRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeControlRequest {
    CodexRenewAccess { action_ref: String },
}

impl NativeControlEnvelope {
    pub fn parse(body: &[u8]) -> Result<Self, GatewayError> {
        if body.len() > NATIVE_CONTROL_MAX_BYTES {
            return Err(invalid());
        }
        let envelope: Self = serde_json::from_slice(body).map_err(|_| invalid())?;
        envelope.validate()?;
        Ok(envelope)
    }
    pub fn validate(&self) -> Result<(), GatewayError> {
        let NativeControlRequest::CodexRenewAccess { action_ref } = &self.request;
        if self.v != NATIVE_WIRE_VERSION
            || !identifier(&self.operation_id)
            || !identifier(action_ref)
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeControlDisposition {
    Published,
    AlreadyCurrent,
    Unavailable,
    Conflict,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeControlReason {
    OwnerUnavailable,
    AuthorityChanged,
    OutcomeUnknown,
    PublicationUnavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeControlResponse {
    pub v: u8,
    pub operation_id: String,
    pub disposition: NativeControlDisposition,
    pub publication_revision: Option<String>,
    pub reason: Option<NativeControlReason>,
}

impl NativeControlResponse {
    pub fn validate_for(&self, request: &NativeControlEnvelope) -> Result<(), GatewayError> {
        request.validate()?;
        let valid = match self.disposition {
            NativeControlDisposition::Published | NativeControlDisposition::AlreadyCurrent => {
                self.publication_revision.as_deref().is_some_and(identifier)
                    && self.reason.is_none()
            }
            NativeControlDisposition::Unknown => {
                self.publication_revision.is_none()
                    && self.reason == Some(NativeControlReason::OutcomeUnknown)
            }
            NativeControlDisposition::Conflict => {
                self.publication_revision.is_none()
                    && self.reason == Some(NativeControlReason::AuthorityChanged)
            }
            NativeControlDisposition::Unavailable => {
                self.publication_revision.is_none()
                    && matches!(
                        self.reason,
                        Some(
                            NativeControlReason::OwnerUnavailable
                                | NativeControlReason::PublicationUnavailable
                        )
                    )
            }
        };
        if self.v != NATIVE_WIRE_VERSION || self.operation_id != request.operation_id || !valid {
            return Err(unverified());
        }
        Ok(())
    }
}

pub fn control_response_input(
    key_id: &str,
    nonce: &str,
    request: &[u8],
    status: u16,
    response: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    signature_input(NATIVE_CONTROL_PATH, key_id, 0, nonce, request)?;
    if !(200..=599).contains(&status)
        || response.len() > NATIVE_CONTROL_MAX_BYTES
        || status >= 400 && response.len() > NATIVE_CONTROL_ERROR_MAX_BYTES
    {
        return Err(invalid());
    }
    Ok(format!(
        "uos-native-control-response-v1\0POST\0{NATIVE_CONTROL_PATH}\0{key_id}\0{nonce}\0{}\0{status}\0{}",
        sha256_hex(request), sha256_hex(response)
    ).into_bytes())
}

pub fn authority_response_input(
    key_id: &str,
    nonce: &str,
    request: &[u8],
    status: u16,
    response: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    signature_input(NATIVE_RENEWAL_AUTHORITY_PATH, key_id, 0, nonce, request)?;
    let response_limit =
        crate::native_import::authority::new_response_limit(request, status, response)?
            .unwrap_or(NATIVE_CONTROL_MAX_BYTES);
    if !(200..=599).contains(&status)
        || response.len() > response_limit
        || status >= 400 && response.len() > NATIVE_CONTROL_ERROR_MAX_BYTES
    {
        return Err(invalid());
    }
    Ok(format!("uos-native-renewal-authority-response-v1\0POST\0{NATIVE_RENEWAL_AUTHORITY_PATH}\0{key_id}\0{nonce}\0{}\0{status}\0{}",sha256_hex(request),sha256_hex(response)).into_bytes())
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}
fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid native control request",
        Some("native_control_invalid"),
    )
}
pub fn unverified() -> GatewayError {
    GatewayError::unavailable(
        "Native control result is not an authenticated matching receipt; reconcile the original action",
        "native_control_outcome_unknown",
    )
}
