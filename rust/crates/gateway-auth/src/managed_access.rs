//! Explicit managed-owner projection. No refresh bytes can be obtained from
//! this type, and external access-only credentials never become managed.
use crate::{
    GatewayError,
    crypto::Secret,
    native_credentials::{NativeGeneration, native_refresh_time_ns},
    provider_credentials::{codex_credential_identity, valid_native_generation},
};

/// No Debug, Serialize or Deserialize: only the fixed private managed publisher
/// may encode its access field. A projection itself is never write authority.
pub struct ManagedAccessProjection {
    account_id: String,
    access_token: Secret,
    native_source_generation: String,
    access_generation: String,
    native_refreshed_at: Option<String>,
    access_expiry_ms: i64,
}
impl ManagedAccessProjection {
    pub fn from_native(generation: &NativeGeneration) -> Result<Self, GatewayError> {
        let credentials = &generation.credentials;
        let expiry = credentials.access_expires_at_ms().ok_or_else(invalid)?;
        if credentials.external_user_id.is_some()
            || credentials.account_id.is_empty()
            || credentials.refresh_token.expose().is_empty()
            || generation.fence.owner.0.is_empty()
            || generation.fence.account_id != credentials.account_id
            || generation.fence.authority_revision.is_empty()
            || !valid_native_generation(&generation.fence.generation_hash)
            || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&generation.observed_at_ms)
            || expiry <= generation.observed_at_ms.saturating_add(120_000)
            || credentials
                .native_refreshed_at
                .as_deref()
                .is_some_and(|value| native_refresh_time_ns(Some(value)).is_none())
        {
            return Err(invalid());
        }
        let access = codex_credential_identity(
            &credentials.account_id,
            &credentials.access_token,
            &Secret::new(String::new()),
        );
        Ok(Self {
            account_id: credentials.account_id.clone(),
            access_token: credentials.access_token.clone(),
            native_source_generation: credentials.generation_hash(),
            access_generation: access.native_generation_hash,
            native_refreshed_at: credentials.native_refreshed_at.clone(),
            access_expiry_ms: expiry,
        })
    }
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn access_token(&self) -> &Secret {
        &self.access_token
    }
    pub fn native_source_generation(&self) -> &str {
        &self.native_source_generation
    }
    pub fn access_generation(&self) -> &str {
        &self.access_generation
    }
    pub fn native_refreshed_at(&self) -> Option<&str> {
        self.native_refreshed_at.as_deref()
    }
    pub fn access_expiry_ms(&self) -> i64 {
        self.access_expiry_ms
    }
}

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Managed native access projection is invalid",
        "native_managed_access_invalid",
    )
}
