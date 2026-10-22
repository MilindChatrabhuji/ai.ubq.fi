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
    pub(crate) async fn verify_existing_access_only(
        &self,
        capture: &crate::NativeCapture,
    ) -> Result<(), crate::MigrationError> {
        for entry in &capture.entries {
            self.verify_access_only_entry(entry).await?;
        }
        Ok(())
    }

    // One entry at a time so a stopped-file preparation can verify access-only
    // accounts without cloning the complete capture or constructing tiny headers.
    pub(crate) async fn verify_access_only_entry(
        &self,
        entry: &crate::NativeEntry,
    ) -> Result<(), crate::MigrationError> {
        if !crate::native_custody::codex_key(&entry.raw_key)? {
            return Ok(());
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
    let directory = crate::native_stage::directory(&std::env::temp_dir())?;
    crate::native_stage::Captured::owned(source, &directory)?
        .prepare(&custody)
        .await
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
    crate::native_latest::write_latest(store, now_ms, host, artifacts, source_sink, custody_sink)
        .await
}

/// Same configured custody, with a stopped owner-only source file and private
/// sealed spool. No source payload inventory is collected by the operator.
pub async fn prepare_local_stage_file(
    path: &std::path::Path,
    directory: &std::path::Path,
    registrations: Vec<NativeCustodyRegistration>,
) -> Result<crate::staged::StagePlan, crate::MigrationError> {
    let custody = ConfiguredNativeCustody::new(registrations)?;
    let source = crate::native_stage::Captured::read(path, directory)?;
    source.verify_configured(&custody).await?;
    source.prepare(&custody).await
}

/// Copy-only reconciliation over the caller's immutable authority snapshot.
/// The original file must be stopped and owner-only. All output is private data;
/// current Rust controls and nonces go only to the separate custody sink.
/// On any error discard the partial custody output and candidate spools.
pub async fn reconcile_local_history_file<
    S: gateway_core::query::QueryStore,
    H: crate::NativeCustody,
    C: std::io::Write,
>(
    store: &S,
    now_ms: i64,
    host: &H,
    artifacts: crate::ArtifactContext,
    original_path: &std::path::Path,
    directory: &std::path::Path,
    custody_sink: &mut C,
) -> Result<crate::native_stage::Captured, crate::MigrationError> {
    use std::{fs::OpenOptions, os::unix::fs::OpenOptionsExt};
    let root = crate::native_stage::directory(directory)?;
    let latest_path = root.join("latest-native.json");
    let mut latest_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&latest_path)
        .map_err(|_| crate::invalid("Private latest source file cannot be created"))?;
    let (_, manifest, mapping_keys) = crate::native_latest::write_latest_for_reconciliation(
        store,
        now_ms,
        host,
        artifacts,
        &mut latest_file,
        custody_sink,
    )
    .await?;
    latest_file
        .sync_all()
        .map_err(|_| crate::invalid("Private latest source file cannot be synced"))?;
    drop(latest_file);
    let original_directory = crate::native_stage::directory(&root)?;
    let latest_directory = crate::native_stage::directory(&root)?;
    let original = crate::native_stage::Captured::read(original_path, &original_directory)?;
    let latest = crate::native_stage::Captured::read(&latest_path, &latest_directory)?;
    let mut writer = crate::native_spool::Writer::create(&root.join("reconciled-native.spool"))?;
    let header = crate::native_history_reconcile::reconcile(
        &original,
        &latest,
        &manifest,
        &mapping_keys,
        &mut |entry| writer.push(entry),
    )?;
    Ok(crate::native_stage::Captured::from_parts(
        header,
        writer.seal()?,
        &root,
    ))
}

/// Normal complete preparation follows the data-only reconciliation; this emits
/// no public authority, ownership or activation receipt.
pub async fn prepare_reconciled_stage_file<
    S: gateway_core::query::QueryStore,
    H: crate::NativeCustody,
    C: std::io::Write,
>(
    store: &S,
    now_ms: i64,
    host: &H,
    artifacts: crate::ArtifactContext,
    original_path: &std::path::Path,
    directory: &std::path::Path,
    custody_sink: &mut C,
) -> Result<crate::staged::StagePlan, crate::MigrationError> {
    reconcile_local_history_file(
        store,
        now_ms,
        host,
        artifacts,
        original_path,
        directory,
        custody_sink,
    )
    .await?
    .prepare(host)
    .await
}
