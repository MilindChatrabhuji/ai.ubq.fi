//! Native-only import authentication. Neither transport proof grants an effect.
pub mod authority;
pub mod catalog_seed;
pub mod publication;
use crate::{
    GatewayError,
    crypto::{base64url, decode_base64url, sha256_hex},
    native::{NATIVE_AUTH_WINDOW_MS, NATIVE_WIRE_VERSION},
    native_auth::{
        NativeAuthHeaders, NativeAuthenticator, NativeCapability, NativeNonceAuthority,
        NativeTransportIdentity,
    },
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub const NATIVE_IMPORT_CODEX_AUTH_PATH: &str = "/v1/native/import/codex-auth";
pub const NATIVE_IMPORT_PROFILE_PATH: &str = "/v1/native/import/profile";
pub const NATIVE_IMPORT_OPERATION_HEADER: &str = "x-uos-native-operation-id";
pub const NATIVE_IMPORT_ACTION_HEADER: &str = "x-uos-native-action-ref";
pub const NATIVE_IMPORT_BODY_HEADER: &str = "x-uos-native-body-sha256";
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeImportKind {
    CodexAuth,
    NativeProfile,
}
impl NativeImportKind {
    pub fn path(self) -> &'static str {
        match self {
            Self::CodexAuth => NATIVE_IMPORT_CODEX_AUTH_PATH,
            Self::NativeProfile => NATIVE_IMPORT_PROFILE_PATH,
        }
    }
    pub fn body_limit_bytes(self) -> usize {
        match self {
            Self::CodexAuth => 32 * 1024 * 1024,
            Self::NativeProfile => 5 * 1024 * 1024,
        }
    }
    fn capability(self) -> NativeCapability {
        match self {
            Self::CodexAuth => NativeCapability::CodexAuthImport,
            Self::NativeProfile => NativeCapability::NativeProfileImport,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeImportMetadata {
    pub v: u8,
    pub operation_id: String,
    pub action_ref: String,
}
impl NativeImportMetadata {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != NATIVE_WIRE_VERSION
            || !reference(&self.operation_id)
            || !reference(&self.action_ref)
        {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeImportTarget {
    ExistingAccount { account_id_hash: String },
    PreparedAccountSlot { slot_ref: String },
    PreparedProfile { profile_ref: String },
}
impl NativeImportTarget {
    pub fn kind(&self) -> NativeImportKind {
        match self {
            Self::PreparedProfile { .. } => NativeImportKind::NativeProfile,
            _ => NativeImportKind::CodexAuth,
        }
    }
    pub fn validate(&self) -> Result<(), GatewayError> {
        let valid = match self {
            Self::ExistingAccount { account_id_hash } => digest(account_id_hash),
            Self::PreparedAccountSlot { slot_ref } => reference(slot_ref),
            Self::PreparedProfile { profile_ref } => reference(profile_ref),
        };
        if !valid {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Clone, Copy)]
pub struct NativeImportAuthHeaders<'a> {
    pub auth: NativeAuthHeaders<'a>,
    pub body_sha256: &'a str,
}
/// Header admission only. Cannot be serialized, cloned, or used as effect authority.
/// ```compile_fail
/// use gateway_auth::native_import::NativeImportAdmission;
/// let forged:NativeImportAdmission=serde_json::from_str("{}").unwrap();
/// ```
pub struct NativeImportAdmission {
    kind: NativeImportKind,
    metadata: NativeImportMetadata,
    body_sha256: String,
    owner_id: String,
    owner_epoch: String,
    fingerprint: String,
    authenticated_at_ms: i64,
    valid_through_ms: i64,
}
impl NativeImportAdmission {
    pub fn kind(&self) -> NativeImportKind {
        self.kind
    }
    pub fn metadata(&self) -> &NativeImportMetadata {
        &self.metadata
    }
    pub fn valid_through_ms(&self) -> i64 {
        self.valid_through_ms
    }
    pub fn require_owner(
        &self,
        identity: &NativeTransportIdentity,
        now: i64,
    ) -> Result<(), GatewayError> {
        self.require_time(now)?;
        if self.owner_id != identity.owner_id()
            || self.owner_epoch != identity.owner_epoch()
            || self.fingerprint != identity.key_fingerprint()
            || !identity.capabilities.contains(&self.kind.capability())
        {
            return Err(forbidden());
        }
        Ok(())
    }
    fn require_time(&self, now: i64) -> Result<(), GatewayError> {
        if now < self.authenticated_at_ms || now > self.valid_through_ms {
            return Err(forbidden());
        }
        Ok(())
    }
    pub fn verify_body(
        self,
        body: &[u8],
        now: i64,
    ) -> Result<VerifiedNativeImportBody, GatewayError> {
        self.require_time(now)?;
        if sha256_hex(body) != self.body_sha256 {
            return Err(forbidden());
        }
        Ok(VerifiedNativeImportBody { admission: self })
    }
}
/// Exact native body binding; still not an actor/action/source permission.
pub struct VerifiedNativeImportBody {
    admission: NativeImportAdmission,
}
impl VerifiedNativeImportBody {
    pub fn kind(&self) -> NativeImportKind {
        self.admission.kind()
    }
    pub fn metadata(&self) -> &NativeImportMetadata {
        self.admission.metadata()
    }
    pub fn require_owner(
        &self,
        identity: &NativeTransportIdentity,
        now: i64,
    ) -> Result<(), GatewayError> {
        self.admission.require_owner(identity, now)
    }
    pub fn require_body(&self, body: &[u8], now: i64) -> Result<(), GatewayError> {
        self.admission.require_time(now)?;
        if sha256_hex(body) != self.admission.body_sha256 {
            return Err(forbidden());
        }
        Ok(())
    }
}
impl NativeTransportIdentity {
    pub fn sign_import(
        &self,
        kind: NativeImportKind,
        metadata: &NativeImportMetadata,
        body_sha256: &str,
        time_ms: i64,
        nonce: &str,
    ) -> Result<String, GatewayError> {
        let input = signature_input(kind, metadata, body_sha256, self.key_id(), time_ms, nonce)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key).map_err(|_| invalid())?;
        mac.update(&input);
        Ok(base64url(&mac.finalize().into_bytes()))
    }
}
impl<R: NativeNonceAuthority> NativeAuthenticator<'_, R> {
    pub async fn admit_import(
        &self,
        kind: NativeImportKind,
        headers: NativeImportAuthHeaders<'_>,
        metadata: &NativeImportMetadata,
        now: i64,
    ) -> Result<NativeImportAdmission, GatewayError> {
        let auth = headers.auth;
        if auth.version != "1"
            || auth.key_id != self.identity.key_id()
            || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&now)
        {
            return Err(unauthorized());
        }
        let time = auth
            .time_ms
            .parse::<i64>()
            .ok()
            .filter(|t| t.to_string() == auth.time_ms)
            .ok_or_else(unauthorized)?;
        if now.abs_diff(time) > NATIVE_AUTH_WINDOW_MS as u64 {
            return Err(unauthorized());
        }
        let input = signature_input(
            kind,
            metadata,
            headers.body_sha256,
            auth.key_id,
            time,
            auth.nonce,
        )
        .map_err(|_| unauthorized())?;
        let signature = decode_base64url(auth.mac).map_err(|_| unauthorized())?;
        if signature.len() != 32 || base64url(&signature) != auth.mac {
            return Err(unauthorized());
        }
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.identity.key).map_err(|_| unauthorized())?;
        mac.update(&input);
        mac.verify_slice(&signature).map_err(|_| unauthorized())?;
        if !self.identity.capabilities.contains(&kind.capability()) {
            return Err(forbidden());
        }
        let valid_through_ms = time
            .checked_add(NATIVE_AUTH_WINDOW_MS)
            .ok_or_else(unauthorized)?;
        self.replay
            .consume_nonce(auth.key_id, auth.nonce, valid_through_ms, now)
            .await?;
        Ok(NativeImportAdmission {
            kind,
            metadata: metadata.clone(),
            body_sha256: headers.body_sha256.into(),
            owner_id: self.identity.owner_id().into(),
            owner_epoch: self.identity.owner_epoch().into(),
            fingerprint: self.identity.key_fingerprint().into(),
            authenticated_at_ms: now,
            valid_through_ms,
        })
    }
}
pub fn signature_input(
    kind: NativeImportKind,
    metadata: &NativeImportMetadata,
    body_sha256: &str,
    key: &str,
    time: i64,
    nonce: &str,
) -> Result<Vec<u8>, GatewayError> {
    metadata.validate()?;
    if key.is_empty()
        || key.len() > 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&time)
        || !digest(body_sha256)
    {
        return Err(invalid());
    }
    let decoded = decode_base64url(nonce).map_err(|_| invalid())?;
    if decoded.len() != 32 || base64url(&decoded) != nonce {
        return Err(invalid());
    }
    let canonical = serde_json::to_vec(metadata).map_err(|_| invalid())?;
    Ok(format!(
        "uos-native-import-v1\0POST\0{}\0{key}\0{time}\0{nonce}\0{}\0{body_sha256}",
        kind.path(),
        sha256_hex(&canonical)
    )
    .into_bytes())
}
fn reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid native import metadata",
        Some("native_import_invalid"),
    )
}
fn unauthorized() -> GatewayError {
    GatewayError::new(
        401,
        "Native carrier authentication failed",
        Some("native_auth_invalid"),
    )
}
fn forbidden() -> GatewayError {
    GatewayError::new(
        403,
        "Native import proof is unavailable or mismatched",
        Some("native_capability_forbidden"),
    )
}
