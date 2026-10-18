//! Versioned private native carrier. These are constructor capabilities, not
//! public OpenAI request fields or caller-selected network/filesystem targets.
use serde::{Deserialize, Serialize};

use crate::{
    GatewayError,
    crypto::{base64url, decode_base64url, sha256_hex},
    invalid,
};

pub const NATIVE_WIRE_VERSION: u8 = 1;
pub const NATIVE_RPC_PATH: &str = "/v1/native/rpc";
pub const NATIVE_FOLLOW_PATH: &str = "/v1/native/follow";
pub const NATIVE_MAX_BODY_BYTES: usize = 1_048_576;
pub const NATIVE_AUTH_WINDOW_MS: i64 = 30_000;
pub const NATIVE_NONCE_CAP: usize = 4096;
pub const NATIVE_VERSION_HEADER: &str = "x-uos-native-version";
pub const NATIVE_KEY_HEADER: &str = "x-uos-native-key-id";
pub const NATIVE_TIME_HEADER: &str = "x-uos-native-time-ms";
pub const NATIVE_NONCE_HEADER: &str = "x-uos-native-nonce";
pub const NATIVE_MAC_HEADER: &str = "x-uos-native-mac";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeReadRequest {
    SupervisorSessions,
    SupervisorOutput {
        source_id: String,
        thread_id: String,
        cursor: Option<String>,
    },
    SupervisorBrief {
        source_id: String,
        thread_id: String,
    },
}

impl<'de> Deserialize<'de> for NativeReadRequest {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Serde internally tagged unit variants ignore extra fields even with
        // deny_unknown_fields. A zero-field struct preserves the public unit
        // variant while enforcing the exact finite wire object.
        #[derive(Deserialize)]
        #[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
        enum Wire {
            SupervisorSessions {},
            SupervisorOutput {
                source_id: String,
                thread_id: String,
                cursor: Option<String>,
            },
            SupervisorBrief {
                source_id: String,
                thread_id: String,
            },
        }
        Ok(match Wire::deserialize(deserializer)? {
            Wire::SupervisorSessions {} => Self::SupervisorSessions,
            Wire::SupervisorOutput {
                source_id,
                thread_id,
                cursor,
            } => Self::SupervisorOutput {
                source_id,
                thread_id,
                cursor,
            },
            Wire::SupervisorBrief {
                source_id,
                thread_id,
            } => Self::SupervisorBrief {
                source_id,
                thread_id,
            },
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRpcEnvelope {
    pub v: u8,
    pub request: NativeReadRequest,
}

impl NativeRpcEnvelope {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != NATIVE_WIRE_VERSION {
            return Err(invalid("Unsupported native protocol version"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthStream {
    /// Native inventory validates this selection when minted and again on open.
    /// Only the native carrier may resolve its source; it contains no URL/path.
    SupervisorFollow {
        source_id: String,
        thread_id: String,
        cursor: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRpcResponse {
    pub v: u8,
    pub status: u16,
    pub body: serde_json::Value,
    pub stream: Option<AuthStream>,
}

impl NativeRpcResponse {
    pub fn validate_for(&self, envelope: &NativeRpcEnvelope) -> Result<(), GatewayError> {
        envelope.validate()?;
        let valid = match (&envelope.request, &self.stream) {
            (
                NativeReadRequest::SupervisorOutput {
                    source_id,
                    thread_id,
                    cursor,
                },
                Some(AuthStream::SupervisorFollow {
                    source_id: actual_source,
                    thread_id: actual_thread,
                    cursor: actual_cursor,
                }),
            ) => {
                self.status == 200
                    && source_id == actual_source
                    && thread_id == actual_thread
                    && cursor == actual_cursor
            }
            (NativeReadRequest::SupervisorOutput { .. }, None) => self.status >= 400,
            (_, None) => true,
            _ => false,
        };
        if self.v != NATIVE_WIRE_VERSION || !(200..=599).contains(&self.status) || !valid {
            return Err(GatewayError::unavailable(
                "Native protocol response is invalid",
                "native_protocol_invalid",
            ));
        }
        Ok(())
    }
}

/// HMAC-SHA256 authenticates these exact bytes with a dedicated constructor key.
/// Platforms supply real HMAC primitives; body bytes are never reserialized.
pub fn signature_input(
    path: &str,
    key_id: &str,
    time_ms: i64,
    nonce: &str,
    body: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    if !matches!(path, NATIVE_RPC_PATH | NATIVE_FOLLOW_PATH)
        || key_id.is_empty()
        || key_id.len() > 64
        || !key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&time_ms)
        || body.len() > NATIVE_MAX_BODY_BYTES
    {
        return Err(invalid("Invalid native authentication frame"));
    }
    let decoded =
        decode_base64url(nonce).map_err(|_| invalid("Invalid native authentication nonce"))?;
    if decoded.len() != 32 || base64url(&decoded) != nonce {
        return Err(invalid("Invalid native authentication nonce"));
    }
    Ok(format!(
        "uos-native-http-v1\0POST\0{path}\0{key_id}\0{time_ms}\0{nonce}\0{}",
        sha256_hex(body)
    )
    .into_bytes())
}
