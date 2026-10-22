//! Fixed live upgrade and reverse-authority authentication. No caller account,
//! URL, bearer, filesystem path or serialized permission crosses this boundary.
use crate::{
    GatewayError,
    crypto::{base64url, decode_base64url, sha256_hex},
    native::{NATIVE_AUTH_WINDOW_MS, NATIVE_WIRE_VERSION},
    native_auth::{
        NativeAuthHeaders, NativeCapability, NativeNonceAuthority, NativeTransportIdentity,
    },
};
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const NATIVE_LIVE_PATH: &str = "/v1/native/live";
pub const NATIVE_LIVE_AUTHORITY_PATH: &str = "/uos/native/live-authority";
pub const NATIVE_LIVE_ACTION_HEADER: &str = "x-uos-native-live-action";
pub const NATIVE_LIVE_AUTHORITY_MAX_BYTES: usize = 65_536;

pub fn validate_reference(value: &str) -> Result<(), GatewayError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(invalid());
    }
    Ok(())
}

fn frame_fields(key_id: &str, time_ms: i64, nonce: &str) -> Result<(), GatewayError> {
    if key_id.is_empty()
        || key_id.len() > 64
        || !key_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&time_ms)
    {
        return Err(invalid());
    }
    let decoded = decode_base64url(nonce).map_err(|_| invalid())?;
    if decoded.len() != 32 || base64url(&decoded) != nonce {
        return Err(invalid());
    }
    Ok(())
}

pub fn request_signature_input(
    key_id: &str,
    time_ms: i64,
    nonce: &str,
    action_ref: &str,
) -> Result<Vec<u8>, GatewayError> {
    frame_fields(key_id, time_ms, nonce)?;
    validate_reference(action_ref)?;
    Ok(format!("uos-native-live-upgrade-v1\0GET\0{NATIVE_LIVE_PATH}\0{key_id}\0{time_ms}\0{nonce}\0{action_ref}").into_bytes())
}

pub fn authority_signature_input(
    key_id: &str,
    time_ms: i64,
    nonce: &str,
    body: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    frame_fields(key_id, time_ms, nonce)?;
    if body.len() > NATIVE_LIVE_AUTHORITY_MAX_BYTES {
        return Err(invalid());
    }
    Ok(format!("uos-native-live-authority-v1\0POST\0{NATIVE_LIVE_AUTHORITY_PATH}\0{key_id}\0{time_ms}\0{nonce}\0{}", sha256_hex(body)).into_bytes())
}

pub fn authority_response_input(
    key_id: &str,
    nonce: &str,
    request: &[u8],
    status: u16,
    response: &[u8],
) -> Result<Vec<u8>, GatewayError> {
    authority_signature_input(key_id, 0, nonce, request)?;
    if !(100..=599).contains(&status) || response.len() > NATIVE_LIVE_AUTHORITY_MAX_BYTES {
        return Err(invalid());
    }
    Ok(format!("uos-native-live-authority-response-v1\0POST\0{NATIVE_LIVE_AUTHORITY_PATH}\0{key_id}\0{nonce}\0{}\0{status}\0{}", sha256_hex(request), sha256_hex(response)).into_bytes())
}

impl NativeTransportIdentity {
    fn live_mac(&self, message: &[u8]) -> Result<String, GatewayError> {
        if !self.capabilities.contains(&NativeCapability::LiveSideband) {
            return Err(invalid());
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| invalid())?;
        mac.update(message);
        Ok(base64url(&mac.finalize().into_bytes()))
    }
    fn verify_live_mac(&self, message: &[u8], signature: &str) -> Result<(), GatewayError> {
        if !self.capabilities.contains(&NativeCapability::LiveSideband) {
            return Err(invalid());
        }
        let bytes = decode_base64url(signature).map_err(|_| invalid())?;
        if bytes.len() != 32 || base64url(&bytes) != signature {
            return Err(invalid());
        }
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| invalid())?;
        mac.update(message);
        mac.verify_slice(&bytes).map_err(|_| invalid())
    }
    pub fn sign_live_request(
        &self,
        time_ms: i64,
        nonce: &str,
        action_ref: &str,
    ) -> Result<String, GatewayError> {
        self.live_mac(&request_signature_input(
            self.key_id(),
            time_ms,
            nonce,
            action_ref,
        )?)
    }
    pub fn sign_live_authority_request(
        &self,
        time_ms: i64,
        nonce: &str,
        body: &[u8],
    ) -> Result<String, GatewayError> {
        self.live_mac(&authority_signature_input(
            self.key_id(),
            time_ms,
            nonce,
            body,
        )?)
    }
    pub fn sign_live_authority_response(
        &self,
        nonce: &str,
        request: &[u8],
        status: u16,
        response: &[u8],
    ) -> Result<String, GatewayError> {
        self.live_mac(&authority_response_input(
            self.key_id(),
            nonce,
            request,
            status,
            response,
        )?)
    }
    pub fn verify_live_authority_response(
        &self,
        nonce: &str,
        request: &[u8],
        status: u16,
        response: &[u8],
        signature: &str,
    ) -> Result<(), GatewayError> {
        self.verify_live_mac(
            &authority_response_input(self.key_id(), nonce, request, status, response)?,
            signature,
        )
    }
}

#[derive(Clone)]
enum Purpose {
    Upgrade(String),
    Authority(String),
}

/// Constructible only after dedicated live authentication and durable nonce consumption.
/// ```compile_fail
/// let proof: gateway_auth::native_live::AuthenticatedNativeLive = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone)]
pub struct AuthenticatedNativeLive {
    owner_id: String,
    owner_epoch: String,
    transport_key_fingerprint: String,
    authenticated_at_ms: i64,
    valid_through_ms: i64,
    purpose: Purpose,
}
impl AuthenticatedNativeLive {
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
    pub fn owner_epoch(&self) -> &str {
        &self.owner_epoch
    }
    pub fn transport_key_fingerprint(&self) -> &str {
        &self.transport_key_fingerprint
    }
    fn current(&self, now_ms: i64) -> Result<(), GatewayError> {
        if now_ms < self.authenticated_at_ms || now_ms > self.valid_through_ms {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn require_upgrade(&self, action_ref: &str, now_ms: i64) -> Result<(), GatewayError> {
        self.current(now_ms)?;
        if !matches!(&self.purpose, Purpose::Upgrade(expected) if expected == action_ref) {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn require_authority_request(&self, body: &[u8], now_ms: i64) -> Result<(), GatewayError> {
        self.current(now_ms)?;
        if !matches!(&self.purpose, Purpose::Authority(expected) if *expected == sha256_hex(body)) {
            return Err(invalid());
        }
        Ok(())
    }
}

pub struct NativeLiveAuthenticator<'a, R> {
    identity: &'a NativeTransportIdentity,
    replay: &'a R,
}
impl<'a, R: NativeNonceAuthority> NativeLiveAuthenticator<'a, R> {
    pub fn new(identity: &'a NativeTransportIdentity, replay: &'a R) -> Self {
        Self { identity, replay }
    }
    async fn authenticate(
        &self,
        headers: NativeAuthHeaders<'_>,
        message: Vec<u8>,
        purpose: Purpose,
        now_ms: i64,
    ) -> Result<AuthenticatedNativeLive, GatewayError> {
        if headers.version != NATIVE_WIRE_VERSION.to_string()
            || headers.key_id != self.identity.key_id()
            || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&now_ms)
        {
            return Err(invalid());
        }
        let time = headers
            .time_ms
            .parse::<i64>()
            .ok()
            .filter(|time| time.to_string() == headers.time_ms)
            .ok_or_else(invalid)?;
        if now_ms.abs_diff(time) > NATIVE_AUTH_WINDOW_MS as u64 {
            return Err(invalid());
        }
        self.identity.verify_live_mac(&message, headers.mac)?;
        let valid_through_ms = time
            .checked_add(NATIVE_AUTH_WINDOW_MS)
            .ok_or_else(invalid)?;
        self.replay
            .consume_nonce(headers.key_id, headers.nonce, valid_through_ms, now_ms)
            .await?;
        Ok(AuthenticatedNativeLive {
            owner_id: self.identity.owner_id().into(),
            owner_epoch: self.identity.owner_epoch().into(),
            transport_key_fingerprint: self.identity.key_fingerprint().into(),
            authenticated_at_ms: now_ms,
            valid_through_ms,
            purpose,
        })
    }
    pub async fn authenticate_upgrade(
        &self,
        headers: NativeAuthHeaders<'_>,
        action_ref: &str,
        now_ms: i64,
    ) -> Result<AuthenticatedNativeLive, GatewayError> {
        let time = headers.time_ms.parse().map_err(|_| invalid())?;
        self.authenticate(
            headers,
            request_signature_input(headers.key_id, time, headers.nonce, action_ref)?,
            Purpose::Upgrade(action_ref.into()),
            now_ms,
        )
        .await
    }
    pub async fn authenticate_authority(
        &self,
        headers: NativeAuthHeaders<'_>,
        body: &[u8],
        now_ms: i64,
    ) -> Result<AuthenticatedNativeLive, GatewayError> {
        let time = headers.time_ms.parse().map_err(|_| invalid())?;
        self.authenticate(
            headers,
            authority_signature_input(headers.key_id, time, headers.nonce, body)?,
            Purpose::Authority(sha256_hex(body)),
            now_ms,
        )
        .await
    }
}

pub fn invalid() -> GatewayError {
    GatewayError::new(
        401,
        "Native live authentication failed",
        Some("native_live_auth_invalid"),
    )
}

#[cfg(test)]
#[path = "native_live/tests.rs"]
mod tests;
