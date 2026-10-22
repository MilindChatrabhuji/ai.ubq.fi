//! Authenticated native/configuration owner proofs. No deserializable proof,
//! arbitrary fingerprint authority, provider credential or permissive fallback.
use std::{collections::BTreeSet, future::Future};

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::{
    GatewayError,
    crypto::{base64url, decode_base64url, sha256_hex},
    native::*,
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum NativeCapability {
    SupervisorRead,
    ConfigurationPublish,
    AccessPublish,
    OwnerRenewal,
    CodexAuthImport,
    NativeProfileImport,
    LiveSideband,
}

#[derive(Clone)]
pub struct NativeTransportIdentity {
    key_id: String,
    owner_id: String,
    owner_epoch: String,
    pub(crate) key: [u8; 32],
    key_fingerprint: String,
    pub(crate) capabilities: BTreeSet<NativeCapability>,
}

impl std::fmt::Debug for NativeTransportIdentity {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_struct("NativeTransportIdentity")
            .field("key_id", &self.key_id)
            .field("owner_id", &self.owner_id)
            .field("owner_epoch", &self.owner_epoch)
            .field("key", &"[redacted]")
            .finish()
    }
}

impl NativeTransportIdentity {
    pub fn new(
        key_id: String,
        owner_id: String,
        owner_epoch: String,
        key: [u8; 32],
        capabilities: BTreeSet<NativeCapability>,
    ) -> Result<Self, GatewayError> {
        let identifier = |value: &str, max: usize| {
            !value.is_empty()
                && value.len() <= max
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        };
        if !identifier(&key_id, 64)
            || key_id.contains('.')
            || !identifier(&owner_id, 128)
            || !identifier(&owner_epoch, 128)
            || capabilities.is_empty()
        {
            return Err(unavailable(
                "Native identity configuration is invalid",
                "native_configuration_invalid",
            ));
        }
        Ok(Self {
            key_id,
            owner_id,
            owner_epoch,
            key,
            key_fingerprint: sha256_hex(&key),
            capabilities,
        })
    }
    pub fn key_id(&self) -> &str {
        &self.key_id
    }
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
    pub fn owner_epoch(&self) -> &str {
        &self.owner_epoch
    }
    pub fn key_fingerprint(&self) -> &str {
        &self.key_fingerprint
    }
    pub fn sign_control_response(
        &self,
        nonce: &str,
        request: &[u8],
        status: u16,
        response: &[u8],
    ) -> Result<String, GatewayError> {
        let message = crate::native_control::control_response_input(
            &self.key_id,
            nonce,
            request,
            status,
            response,
        )?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| unauthorized())?;
        mac.update(&message);
        Ok(base64url(&mac.finalize().into_bytes()))
    }
    pub fn sign_authority_response(
        &self,
        nonce: &str,
        request: &[u8],
        status: u16,
        response: &[u8],
    ) -> Result<String, GatewayError> {
        let message = crate::native_control::authority_response_input(
            &self.key_id,
            nonce,
            request,
            status,
            response,
        )?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| unauthorized())?;
        mac.update(&message);
        Ok(base64url(&mac.finalize().into_bytes()))
    }
    pub fn verify_authority_response(
        &self,
        nonce: &str,
        request: &[u8],
        status: u16,
        response: &[u8],
        signature: &str,
    ) -> Result<(), GatewayError> {
        let message = crate::native_control::authority_response_input(
            &self.key_id,
            nonce,
            request,
            status,
            response,
        )?;
        let bytes = decode_base64url(signature).map_err(|_| unauthorized())?;
        if bytes.len() != 32 || base64url(&bytes) != signature {
            return Err(unauthorized());
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| unauthorized())?;
        mac.update(&message);
        mac.verify_slice(&bytes).map_err(|_| unauthorized())
    }
    pub fn verify_control_response(
        &self,
        nonce: &str,
        request: &[u8],
        status: u16,
        response: &[u8],
        signature: &str,
    ) -> Result<(), GatewayError> {
        let message = crate::native_control::control_response_input(
            &self.key_id,
            nonce,
            request,
            status,
            response,
        )?;
        let bytes = decode_base64url(signature).map_err(|_| unauthorized())?;
        if bytes.len() != 32 || base64url(&bytes) != signature {
            return Err(unauthorized());
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| unauthorized())?;
        mac.update(&message);
        mac.verify_slice(&bytes).map_err(|_| unauthorized())
    }
    pub fn sign_publication_response(
        &self,
        nonce: &str,
        request_body: &[u8],
        status: u16,
        response_body: &[u8],
    ) -> Result<String, GatewayError> {
        let message =
            publication_response_input(&self.key_id, nonce, request_body, status, response_body)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| unauthorized())?;
        mac.update(&message);
        Ok(base64url(&mac.finalize().into_bytes()))
    }
    pub fn verify_publication_response(
        &self,
        nonce: &str,
        request_body: &[u8],
        status: u16,
        response_body: &[u8],
        signature: &str,
    ) -> Result<(), GatewayError> {
        let message =
            publication_response_input(&self.key_id, nonce, request_body, status, response_body)?;
        let signature_bytes = decode_base64url(signature).map_err(|_| unauthorized())?;
        if signature_bytes.len() != 32 || base64url(&signature_bytes) != signature {
            return Err(unauthorized());
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| unauthorized())?;
        mac.update(&message);
        mac.verify_slice(&signature_bytes)
            .map_err(|_| unauthorized())
    }
    /// Used by a constructor-owned sender, never an HTTP signing oracle.
    pub fn sign(
        &self,
        path: &str,
        time_ms: i64,
        nonce: &str,
        body: &[u8],
    ) -> Result<String, GatewayError> {
        let message = signature_input(path, &self.key_id, time_ms, nonce, body)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| {
            unavailable("Native HMAC key is invalid", "native_configuration_invalid")
        })?;
        mac.update(&message);
        Ok(base64url(&mac.finalize().into_bytes()))
    }
}

#[derive(Clone, Copy)]
pub struct NativeAuthHeaders<'a> {
    pub version: &'a str,
    pub key_id: &'a str,
    pub time_ms: &'a str,
    pub nonce: &'a str,
    pub mac: &'a str,
}

/// Atomically prune only expired nonces, refuse any live replay, and refuse new
/// requests at NATIVE_NONCE_CAP rather than evicting a live authentication fence.
/// Runtime implementations must persist fences in their owned control store;
/// no in-memory default is installed by the authentication library.
pub trait NativeNonceAuthority {
    fn consume_nonce(
        &self,
        key_id: &str,
        nonce: &str,
        valid_through_ms: i64,
        now_ms: i64,
    ) -> impl Future<Output = Result<(), GatewayError>>;
}

#[derive(Clone, Debug)]
pub struct AuthenticatedNativeOwner {
    owner_id: String,
    owner_epoch: String,
    transport_key_fingerprint: String,
    capabilities: BTreeSet<NativeCapability>,
    authenticated_at_ms: i64,
    valid_through_ms: i64,
    request_digest: String,
    request_path: String,
}

impl AuthenticatedNativeOwner {
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
    pub fn owner_epoch(&self) -> &str {
        &self.owner_epoch
    }
    pub fn transport_key_fingerprint(&self) -> &str {
        &self.transport_key_fingerprint
    }
    pub fn request_digest(&self) -> &str {
        &self.request_digest
    }
    pub fn require_request(
        &self,
        capability: NativeCapability,
        path: &str,
        body: &[u8],
        now_ms: i64,
    ) -> Result<(), GatewayError> {
        self.require_body(capability, body, now_ms)?;
        if self.request_path != path {
            return Err(GatewayError::new(
                403,
                "Native owner proof is bound to a different operation",
                Some("native_capability_forbidden"),
            ));
        }
        Ok(())
    }
    /// A publisher cannot reuse an authenticated owner request for another body.
    pub fn require_body(
        &self,
        capability: NativeCapability,
        body: &[u8],
        now_ms: i64,
    ) -> Result<(), GatewayError> {
        self.require(capability, now_ms)?;
        if self.request_digest != sha256_hex(body) {
            return Err(GatewayError::new(
                403,
                "Native owner proof is bound to a different request",
                Some("native_capability_forbidden"),
            ));
        }
        Ok(())
    }
    pub fn require(&self, capability: NativeCapability, now_ms: i64) -> Result<(), GatewayError> {
        if now_ms < self.authenticated_at_ms
            || now_ms > self.valid_through_ms
            || !self.capabilities.contains(&capability)
        {
            return Err(GatewayError::new(
                403,
                "Native owner capability is unavailable or expired",
                Some("native_capability_forbidden"),
            ));
        }
        Ok(())
    }
}

pub struct NativeAuthenticator<'a, R> {
    pub(crate) identity: &'a NativeTransportIdentity,
    pub(crate) replay: &'a R,
}
impl<'a, R: NativeNonceAuthority> NativeAuthenticator<'a, R> {
    pub fn new(identity: &'a NativeTransportIdentity, replay: &'a R) -> Self {
        Self { identity, replay }
    }
    pub async fn authenticate(
        &self,
        path: &str,
        headers: NativeAuthHeaders<'_>,
        body: &[u8],
        now_ms: i64,
    ) -> Result<AuthenticatedNativeOwner, GatewayError> {
        if headers.version != "1"
            || headers.key_id != self.identity.key_id
            || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&now_ms)
        {
            return Err(unauthorized());
        }
        let time = headers
            .time_ms
            .parse::<i64>()
            .ok()
            .filter(|time| time.to_string() == headers.time_ms)
            .ok_or_else(unauthorized)?;
        if now_ms.abs_diff(time) > NATIVE_AUTH_WINDOW_MS as u64 {
            return Err(unauthorized());
        }
        let message = signature_input(path, headers.key_id, time, headers.nonce, body)
            .map_err(|_| unauthorized())?;
        let signature = decode_base64url(headers.mac).map_err(|_| unauthorized())?;
        if signature.len() != 32 || base64url(&signature) != headers.mac {
            return Err(unauthorized());
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.identity.key).map_err(|_| {
            unavailable(
                "Native HMAC configuration is invalid",
                "native_configuration_invalid",
            )
        })?;
        mac.update(&message);
        mac.verify_slice(&signature).map_err(|_| unauthorized())?;
        let valid_through = time
            .checked_add(NATIVE_AUTH_WINDOW_MS)
            .ok_or_else(unauthorized)?;
        self.replay
            .consume_nonce(headers.key_id, headers.nonce, valid_through, now_ms)
            .await?;
        Ok(AuthenticatedNativeOwner {
            owner_id: self.identity.owner_id.clone(),
            owner_epoch: self.identity.owner_epoch.clone(),
            transport_key_fingerprint: self.identity.key_fingerprint.clone(),
            capabilities: self.identity.capabilities.clone(),
            authenticated_at_ms: now_ms,
            valid_through_ms: valid_through,
            request_digest: sha256_hex(body),
            request_path: path.to_owned(),
        })
    }
}

fn unauthorized() -> GatewayError {
    GatewayError::new(
        401,
        "Native carrier authentication failed",
        Some("native_auth_invalid"),
    )
}
fn unavailable(message: &str, code: &str) -> GatewayError {
    GatewayError::unavailable(message, code)
}
