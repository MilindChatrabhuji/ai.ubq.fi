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
) -> Result<crate::NativeCapture, crate::MigrationError> {
    let custody = ConfiguredNativeCustody::new(registrations)?;
    custody.verify_existing_access_only(capture).await?;
    crate::sanitize_native_capture(capture, &custody).await
}

impl ConfiguredNativeCustody {
    // The existing sanitizer handles refresh-bearing source rows. Existing
    // access-only rows still require actual observation; this returns unit only,
    // never an OwnedNativeSnapshot/managed grant for an external account.
    async fn verify_existing_access_only(
        &self,
        capture: &crate::NativeCapture,
    ) -> Result<(), crate::MigrationError> {
        for entry in &capture.entries {
            if !crate::native_custody::codex_key(&entry.raw_key)? {
                continue;
            }
            let pool = crate::native_custody::source_pool(&entry.value)?;
            for account in pool
                .accounts
                .iter()
                .filter(|a| a.refresh_token.expose().is_empty())
            {
                let registration = self
                    .registrations
                    .get(&account.account_id)
                    .ok_or_else(invalid)?;
                let credentials = self
                    .transport
                    .read_credentials(&registration.fence.owner)
                    .await?;
                let at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| invalid())?
                    .as_millis();
                let at = i64::try_from(at).map_err(|_| invalid())?;
                let owner = account.native_owner.as_ref().ok_or_else(invalid)?;
                if registration.fence.authority_revision != entry.revision.record_revision()?
                    || registration.fence.account_id != credentials.account_id
                    || registration.fence.generation_hash != credentials.generation_hash()
                    || account.account_id != credentials.account_id
                    || account.access_token != credentials.access_token
                    || owner.codex_home != registration.home.to_str().ok_or_else(invalid)?
                    || owner.native_refreshed_at != credentials.native_refreshed_at
                    || credentials
                        .access_expires_at_ms()
                        .is_none_or(|expiry| expiry <= at.saturating_add(120_000))
                {
                    return Err(invalid().into());
                }
                if let Some(managed) = &owner.managed_source {
                    let projection =
                        gateway_auth::managed_access::ManagedAccessProjection::from_native(
                            &NativeGeneration {
                                fence: registration.fence.clone(),
                                credentials,
                                observed_at_ms: at,
                            },
                        )?;
                    if owner.external_user_id.is_some()
                        || owner.generation_hash != projection.access_generation()
                        || managed.generation_hash != projection.native_source_generation()
                    {
                        return Err(invalid().into());
                    }
                } else if owner.external_user_id.is_none()
                    || owner.external_user_id != credentials.external_user_id
                    || !credentials.refresh_token.expose().is_empty()
                    || owner.generation_hash != credentials.generation_hash()
                {
                    return Err(invalid().into());
                }
            }
        }
        Ok(())
    }
}

/// Native-only full audit/custody preparation. Only bounded canonical stage frames
/// leave this process. Ordinary profile/capture codecs and atomic adoption stay intact.
pub async fn prepare_local_stage(
    source: crate::NativeCapture,
    registrations: Vec<NativeCustodyRegistration>,
) -> Result<crate::staged::StagePlan, crate::MigrationError> {
    let custody = ConfiguredNativeCustody::new(registrations)?;
    custody.verify_existing_access_only(&source).await?;
    Ok(crate::staged::StagePlan::from_prepared(
        crate::prepare_native_with_custody(source, &custody).await?,
    )?)
}

/// Private file/pipe sinks only: current full credentials remain native. The
/// complete latest inverse is computed by the existing custody/transform engine,
/// not a source backup. This native memory requirement must be measured before
/// private production captures; no full bundle crosses the WASM wire.
pub async fn write_private_latest<
    S: gateway_core::query::QueryStore,
    H: crate::NativeCustody,
    W: std::io::Write,
    C: std::io::Write,
>(
    store: &S,
    now_ms: i64,
    host: &H,
    artifacts: crate::ArtifactContext,
    source_sink: &mut W,
    custody_sink: &mut C,
) -> Result<usize, crate::MigrationError> {
    let bounded = LatestPages(store);
    let bundle =
        crate::export_native_rollback_with_custody(&bounded, now_ms, host, artifacts).await?;
    let (source, controls, artifacts) = bundle.into_private_parts();
    serde_json::to_writer(source_sink, &source)
        .map_err(|_| crate::invalid("Private latest source sink failed"))?;
    serde_json::to_writer(
        custody_sink,
        &serde_json::json!({"rust_controls":controls,"artifacts":artifacts}),
    )
    .map_err(|_| crate::invalid("Private latest custody sink failed"))?;
    Ok(source.entries.len())
}
struct LatestPages<'a, S>(&'a S);
impl<S: gateway_core::query::QueryStore> gateway_core::state::AuthorityStore
    for LatestPages<'_, S>
{
    async fn read(
        &self,
        key: &gateway_core::state::RecordKey,
    ) -> Result<Option<gateway_core::state::StoredRecord>, GatewayError> {
        self.0.read(key).await
    }
    async fn commit(
        &self,
        transition: gateway_core::state::AtomicTransition,
    ) -> Result<gateway_core::state::CommitOutcome, GatewayError> {
        self.0.commit(transition).await
    }
}
impl<S: gateway_core::query::QueryStore> gateway_core::query::QueryStore for LatestPages<'_, S> {
    async fn query(
        &self,
        mut request: gateway_core::query::QueryRequest,
    ) -> Result<gateway_core::query::QueryPage, GatewayError> {
        // An arbitrary accepted source row can approach the private wire bound;
        // a row-count page of256 is not a byte bound. Keep this operator's page
        // to one row without changing ordinary query semantics or interfaces.
        request.limit = 1;
        self.0.query(request).await
    }
}
