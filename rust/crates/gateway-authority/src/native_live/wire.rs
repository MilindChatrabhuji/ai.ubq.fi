//! Private live-authority v1. Request selectors never carry original auth or credentials.
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};

pub const NATIVE_LIVE_AUTHORITY_PATH: &str = "/uos/native/live-authority";
pub const NATIVE_LIVE_AUTHORITY_MAX_BYTES: usize = 65_536;

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeLiveAuthorityRequest {
    Authorize {
        v: u8,
        action_ref: String,
        connection_id: String,
    },
    Recheck {
        v: u8,
        action_ref: String,
        connection_id: String,
        authorization_ref: String,
    },
    Retire {
        v: u8,
        action_ref: String,
        connection_id: String,
        authorization_ref: String,
        upstream_status: u16,
    },
}
impl NativeLiveAuthorityRequest {
    pub fn parse(bytes: &[u8]) -> Result<Self, GatewayError> {
        if bytes.len() > NATIVE_LIVE_AUTHORITY_MAX_BYTES {
            return Err(invalid());
        }
        let request: Self = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        let (v, fields, status) = match &request {
            Self::Authorize {
                v,
                action_ref,
                connection_id,
            } => (*v, vec![action_ref, connection_id], None),
            Self::Recheck {
                v,
                action_ref,
                connection_id,
                authorization_ref,
            } => (*v, vec![action_ref, connection_id, authorization_ref], None),
            Self::Retire {
                v,
                action_ref,
                connection_id,
                authorization_ref,
                upstream_status,
            } => (
                *v,
                vec![action_ref, connection_id, authorization_ref],
                Some(*upstream_status),
            ),
        };
        if v != 1
            || fields.iter().any(|s| !reference(s))
            || status.is_some_and(|s| s != 404 && s != 410)
        {
            return Err(invalid());
        }
        Ok(request)
    }
}
pub(super) fn reference(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeLiveFence {
    pub call_id: String,
    pub account_id: String,
    pub account_id_hash: String,
    pub credential_version: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub mapping_revision: String,
    pub owner_id: String,
    pub owner_epoch: String,
    pub owner_revision: String,
    pub principal: String,
    pub principal_policy_digest: String,
    pub access_expires_at_ms: Option<i64>,
}

/// Ephemeral access-only projection. No Debug/Clone and no durable-row serialization.
/// Only the fixed authenticated TLS response may serialize it. Never include in evidence.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeLiveAccess {
    access_token: String,
}
impl NativeLiveAccess {
    pub(super) fn current(access_token: String) -> Self {
        Self { access_token }
    }
    pub fn expose(&self) -> &str {
        &self.access_token
    }
}
impl std::fmt::Debug for NativeLiveAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeLiveAccess([redacted])")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeLiveRetirement {
    Retired,
    Pending,
    Unknown,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeLiveAuthorityResponse {
    Authorize {
        v: u8,
        authorization_ref: String,
        fence: NativeLiveFence,
        access: NativeLiveAccess,
    },
    Recheck {
        v: u8,
        fence: NativeLiveFence,
        access: NativeLiveAccess,
    },
    Retire {
        v: u8,
        outcome: NativeLiveRetirement,
    },
}
pub(super) fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid finite native live frame.",
        Some("native_live_wire_invalid"),
    )
}
