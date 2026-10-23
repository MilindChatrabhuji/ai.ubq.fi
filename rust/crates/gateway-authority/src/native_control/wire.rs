//! Finite private reverse carrier. These DTOs contain selectors and observations, not capabilities.
use super::{NativeRenewalFence, NativeRenewalMode};
use gateway_auth::{
    GatewayError,
    crypto::{base64url, decode_base64url},
    native_auth::NativeAuthHeaders,
    native_control::NATIVE_CONTROL_MAX_BYTES,
};
use serde::{Deserialize, Serialize};

pub const NATIVE_RENEWAL_AUTHORITY_PATH: &str = "/uos/native/renewal-authority";
/// The original 64KiB frame is base64url encoded inside this bounded private envelope.
pub const NATIVE_RENEWAL_AUTHORITY_MAX_BYTES: usize = 96 * 1024;
pub const NATIVE_RENEWAL_AUTHORITY_RESPONSE_MAX_BYTES: usize = 65_536;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OriginalControlHeaders {
    pub version: String,
    pub key_id: String,
    pub time_ms: String,
    pub nonce: String,
    pub mac: String,
}
impl OriginalControlHeaders {
    pub fn borrowed(&self) -> NativeAuthHeaders<'_> {
        NativeAuthHeaders {
            version: &self.version,
            key_id: &self.key_id,
            time_ms: &self.time_ms,
            nonce: &self.nonce,
            mac: &self.mac,
        }
    }
    fn validate(&self) -> Result<(), GatewayError> {
        if [
            &self.version,
            &self.key_id,
            &self.time_ms,
            &self.nonce,
            &self.mac,
        ]
        .iter()
        .any(|v| v.is_empty() || v.len() > 256)
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeRenewalAuthorityRequest {
    Claim {
        v: u8,
        original_control_body_base64url: String,
        original_auth_headers: OriginalControlHeaders,
    },
    Start {
        v: u8,
        operation_id: String,
        claim_ref: String,
        start_permit: String,
    },
    Recheck {
        v: u8,
        operation_id: String,
        claim_ref: String,
    },
    Published {
        v: u8,
        operation_id: String,
        claim_ref: String,
        publication_revision: String,
    },
    Unknown {
        v: u8,
        operation_id: String,
        claim_ref: String,
    },
}

impl NativeRenewalAuthorityRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self, GatewayError> {
        if bytes.len() > NATIVE_RENEWAL_AUTHORITY_MAX_BYTES {
            return Err(invalid());
        }
        let request: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        request.validate()?;
        Ok(request)
    }
    pub fn original_control_body(&self) -> Result<Vec<u8>, GatewayError> {
        let Self::Claim {
            original_control_body_base64url,
            ..
        } = self
        else {
            return Err(invalid());
        };
        let body = decode_base64url(original_control_body_base64url)?;
        if body.len() > NATIVE_CONTROL_MAX_BYTES
            || base64url(&body) != *original_control_body_base64url
        {
            return Err(invalid());
        }
        Ok(body)
    }
    pub fn validate(&self) -> Result<(), GatewayError> {
        let (v, fields): (&u8, Vec<&str>) = match self {
            Self::Claim {
                v,
                original_auth_headers,
                ..
            } => {
                original_auth_headers.validate()?;
                let _ = self.original_control_body()?;
                (v, vec![])
            }
            Self::Start {
                v,
                operation_id,
                claim_ref,
                start_permit,
            } => (v, vec![operation_id, claim_ref, start_permit]),
            Self::Recheck {
                v,
                operation_id,
                claim_ref,
            }
            | Self::Unknown {
                v,
                operation_id,
                claim_ref,
            } => (v, vec![operation_id, claim_ref]),
            Self::Published {
                v,
                operation_id,
                claim_ref,
                publication_revision,
            } => (v, vec![operation_id, claim_ref, publication_revision]),
        };
        if *v != 1
            || fields.iter().any(|s| {
                s.is_empty()
                    || s.len() > 256
                    || !s.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.')
                    })
            })
        {
            return Err(invalid());
        }
        Ok(())
    }
}

mod response_codec;

#[derive(Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeRenewalAuthorityResponse {
    Claim {
        v: u8,
        action_ref: String,
        operation_id: String,
        claim_ref: String,
        start_permit: Option<String>,
        publication_revision: Option<String>,
        mode: NativeRenewalMode,
        deadline_ms: i64,
        fence: NativeRenewalFence,
    },
    Start {
        v: u8,
        mode: NativeRenewalMode,
    },
    Recheck {
        v: u8,
        fence: NativeRenewalFence,
    },
    Published {
        v: u8,
        publication_revision: String,
    },
    Unknown {
        v: u8,
    },
}

pub fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid fixed native renewal authority frame.",
        Some("native_renewal_wire_invalid"),
    )
}
