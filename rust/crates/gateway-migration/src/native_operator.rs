//! Local read-only custody assembled from an existing trusted owner registration.
//! No wire decoder, home discovery, refresh, network, service or restore operation.
use crate::{NativeCustody, OwnedNativeSnapshot};
use gateway_auth::native_credentials::{NativeGeneration, OwnerFence};
use gateway_core::{GatewayError, identity::MAX_SAFE_INTEGER};
use gateway_native::{
    NativeOwnerTransport,
    unix::{NativeOwnerLocation, UnixOwnerTransport},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

/// Constructor input from the existing local owner configuration and its current
/// source/generation fence. A source capture cannot deserialize this registration.
pub struct NativeCustodyRegistration {
    home: PathBuf,
    fence: OwnerFence,
}
impl NativeCustodyRegistration {
    pub fn existing(home: PathBuf, fence: OwnerFence) -> Result<Self, GatewayError> {
        if !home.is_absolute()
            || home.to_str().is_none()
            || home
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
            || fence.owner.0.is_empty()
            || fence.account_id.is_empty()
            || fence.account_id.trim() != fence.account_id
            || fence.generation_hash.is_empty()
            || fence.authority_revision.is_empty()
        {
            return Err(invalid());
        }
        Ok(Self { home, fence })
    }
}

/// Holds only fixed path/fence configuration. Credentials are read at observation
/// time and verified by the existing OwnerFence family, not a renewal-v2 request.
pub struct ConfiguredNativeCustody {
    transport: UnixOwnerTransport,
    registrations: BTreeMap<String, NativeCustodyRegistration>,
}
impl ConfiguredNativeCustody {
    pub fn new(registrations: Vec<NativeCustodyRegistration>) -> Result<Self, GatewayError> {
        if !(1..=2).contains(&registrations.len()) {
            return Err(invalid());
        }
        let mut locations = Vec::new();
        let mut by_account = BTreeMap::new();
        let mut homes = BTreeSet::new();
        for registration in registrations {
            if !homes.insert(registration.home.clone()) {
                return Err(invalid());
            }
            locations.push(NativeOwnerLocation::configured(
                registration.fence.owner.clone(),
                registration.home.clone(),
            )?);
            if by_account
                .insert(registration.fence.account_id.clone(), registration)
                .is_some()
            {
                return Err(invalid());
            }
        }
        // The native constructor independently refuses duplicate fixed owners.
        Ok(Self {
            transport: UnixOwnerTransport::new(locations)?,
            registrations: by_account,
        })
    }
}
impl NativeCustody for ConfiguredNativeCustody {
    async fn observe(&self, account_id: &str) -> Result<OwnedNativeSnapshot, GatewayError> {
        let registration = self.registrations.get(account_id).ok_or_else(invalid)?;
        let credentials = self
            .transport
            .read_credentials(&registration.fence.owner)
            .await?;
        let observed_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| invalid())?
            .as_millis();
        let observed_at_ms = i64::try_from(observed_at_ms).map_err(|_| invalid())?;
        if !(0..=MAX_SAFE_INTEGER).contains(&observed_at_ms) {
            return Err(invalid());
        }
        OwnedNativeSnapshot::verify(
            registration.home.to_str().ok_or_else(invalid)?,
            &registration.fence,
            NativeGeneration {
                fence: registration.fence.clone(),
                credentials,
                observed_at_ms,
            },
        )
    }
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "The configured local native custody registration is missing or stale",
        "migration_native_custody_required",
    )
}

/// Compose only the existing real native custody and candidate validators.
/// The host supplies the capture and registrations through independent private
/// operator inputs. This creates no native writer, renewal or ownership grant.
pub async fn prepare_local_bootstrap(
    capture: &crate::NativeCapture,
    registrations: Vec<NativeCustodyRegistration>,
) -> Result<crate::operational::NativeMigrationRequest, crate::MigrationError> {
    let custody = ConfiguredNativeCustody::new(registrations)?;
    let candidate = crate::sanitize_native_capture(capture, &custody).await?;
    Ok(crate::operational::NativeMigrationRequest {
        v: 1,
        request: crate::operational::NativeOperation::AdoptNative { capture: candidate },
    })
}
