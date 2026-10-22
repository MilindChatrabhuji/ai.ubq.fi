//! Trusted offline/native preparation only; the common candidate never receives refresh material.
use crate::*;
use gateway_auth::{
    managed_access::ManagedAccessProjection,
    native_credentials::{NativeGeneration, OwnerFence, verify_fence},
    provider_credentials::{
        CodexNativeOwner, CodexSourcePool, ManagedNativeSource, parse_codex_source_pool,
    },
};
use gateway_core::{query::QueryStore, value::PortableValue};
use std::future::Future;

/// Implemented by a configured, fixed local owner host, never a capture decoder.
pub trait NativeCustody {
    fn observe(
        &self,
        account_id: &str,
    ) -> impl Future<Output = Result<OwnedNativeSnapshot, GatewayError>>;
}
/// No Deserialize/Serialize/Debug. The native adapter must independently read its
/// configured owner registration and current fixed-file credentials.
pub struct OwnedNativeSnapshot {
    home: String,
    generation: NativeGeneration,
}
impl OwnedNativeSnapshot {
    pub fn verify(
        configured_home: &str,
        expected: &OwnerFence,
        observed: NativeGeneration,
    ) -> Result<Self, GatewayError> {
        verify_fence(expected, &observed.fence)?;
        if !configured_home.starts_with('/')
            || configured_home.split('/').any(|p| p == "..")
            || observed.fence.account_id != observed.credentials.account_id
            || observed.fence.generation_hash != observed.credentials.generation_hash()
            || observed.fence.authority_revision.is_empty()
        {
            return Err(custody_error());
        }
        ManagedAccessProjection::from_native(&observed)?;
        Ok(Self {
            home: configured_home.into(),
            generation: observed,
        })
    }
}
fn custody_error() -> GatewayError {
    GatewayError::unavailable(
        "Current fixed native-owner custody does not match this source account and revision",
        "migration_native_custody_required",
    )
}

pub(crate) fn source_pool(value: &NativeValue) -> Result<CodexSourcePool, GatewayError> {
    let NativeValue::SourceGraphV1(graph) = value else {
        return Err(invalid(
            "Codex source pool requires its explicit graph representation",
        ));
    };
    let value = crate::graph_transport::from_source_graph(graph)?
        .try_identity_free_tree()?
        .and_then(|v| v.to_json_lossless())
        .ok_or_else(|| unavailable("Codex source pool graph lacks a business-schema binding"))?;
    parse_codex_source_pool(&value)?.ok_or_else(|| invalid("Source Codex pool is malformed"))
}
fn pool_value(pool: &CodexSourcePool) -> Result<NativeValue, GatewayError> {
    Ok(NativeValue::SourceGraphV1(
        crate::graph_transport::to_source_graph(&crate::graph_tree::from_tree(
            &PortableValue::from_json(&pool.private_source_value()),
        )?)?,
    ))
}
pub(crate) fn codex_key(raw: &[u8]) -> Result<bool, GatewayError> {
    Ok(starts(
        &parts(&TupleKey::from_sort_bytes(raw.to_vec())?.to_record_key())?,
        &["ubq_ai", "codex_auth"],
    ))
}

/// Full local capture enters only this trusted preparation capability. No local
/// refresh token or full native document is copied into the returned candidate.
pub async fn sanitize_native_capture<H: NativeCustody>(
    source: &NativeCapture,
    host: &H,
) -> Result<NativeCapture, MigrationError> {
    let candidate = normalize_owned(source.clone(), host).await?;
    prepare_native(&candidate)?;
    Ok(candidate)
}

/// Trusted native staging consumes its input and returns the SAME complete audit
/// result instead of constructing/discarding it and auditing it a second time.
pub async fn prepare_native_with_custody<H: NativeCustody>(
    source: NativeCapture,
    host: &H,
) -> Result<PreparedAdoption, MigrationError> {
    prepare_native(&normalize_owned(source, host).await?)
}

async fn normalize_owned<H: NativeCustody>(
    mut candidate: NativeCapture,
    host: &H,
) -> Result<NativeCapture, MigrationError> {
    for entry in &mut candidate.entries {
        normalize_entry(entry, host).await?;
    }
    // Both callers run the exact complete-candidate gate before any result exits.
    Ok(candidate)
}

pub(crate) async fn normalize_entry<H: NativeCustody>(
    entry: &mut NativeEntry,
    host: &H,
) -> Result<(), MigrationError> {
    if !codex_key(&entry.raw_key)? {
        return Ok(());
    }
    let mut pool = source_pool(&entry.value)?;
    for account in &mut pool.accounts {
        if account.refresh_token.expose().is_empty() {
            continue;
        }
        let observed = host.observe(&account.account_id).await?;
        let local = &observed.generation;
        if local.fence.authority_revision != entry.revision.record_revision()?
            || local.credentials.account_id != account.account_id
            || local.credentials.access_token != account.access_token
            || local.credentials.refresh_token != account.refresh_token
            || account.native_owner.as_ref().is_some_and(|o| {
                o.codex_home != observed.home
                    || o.generation_hash != local.credentials.generation_hash()
                    || o.external_user_id.is_some()
                    || o.managed_source.is_some()
                    || o.native_refreshed_at != local.credentials.native_refreshed_at
            })
        {
            return Err(MigrationError::from(custody_error()));
        }
        let projection = ManagedAccessProjection::from_native(local)?;
        account.refresh_token = gateway_auth::crypto::Secret::new(String::new());
        account.native_owner = Some(CodexNativeOwner {
            codex_home: observed.home,
            generation_hash: projection.access_generation().into(),
            native_refreshed_at: projection.native_refreshed_at().map(str::to_owned),
            external_user_id: None,
            managed_source: Some(ManagedNativeSource {
                v: 2,
                generation_hash: projection.native_source_generation().into(),
            }),
        });
    }
    entry.value = pool_value(&pool)?;
    Ok(())
}

/// Only this opaque local result can contain restored managed refresh material.
/// It is not a cloud/common-candidate authorization or a live Bun restore command.
pub struct LocalNativeCapture(NativeCapture);
impl LocalNativeCapture {
    pub fn into_private_capture(self) -> NativeCapture {
        self.0
    }
}

pub async fn export_native_with_custody<S: QueryStore, H: NativeCustody>(
    store: &S,
    now_ms: i64,
    host: &H,
) -> Result<LocalNativeCapture, MigrationError> {
    let source = crate::export_native_latest(store, now_ms).await?;
    reconstruct_native(store, source, host).await
}

async fn reconstruct_native<S: QueryStore, H: NativeCustody>(
    store: &S,
    mut source: NativeCapture,
    host: &H,
) -> Result<LocalNativeCapture, MigrationError> {
    for entry in &mut source.entries {
        reconstruct_entry(store, entry, host).await?;
    }
    Ok(LocalNativeCapture(source))
}

pub(crate) async fn reconstruct_entry<S: QueryStore, H: NativeCustody>(
    store: &S,
    entry: &mut NativeEntry,
    host: &H,
) -> Result<(), MigrationError> {
    if !codex_key(&entry.raw_key)? {
        return Ok(());
    }
    let mut pool = source_pool(&entry.value)?;
    let key = TupleKey::from_sort_bytes(entry.raw_key.clone())?.to_record_key();
    let current = store.read(&key).await?.ok_or_else(custody_error)?;
    for account in &mut pool.accounts {
        let Some(owner) = &account.native_owner else {
            continue;
        };
        let Some(managed) = &owner.managed_source else {
            continue;
        };
        let observed = host.observe(&account.account_id).await?;
        let local = &observed.generation;
        let projection = ManagedAccessProjection::from_native(local)?;
        if local.fence.authority_revision != current.revision
            || observed.home != owner.codex_home
            || local.credentials.account_id != account.account_id
            || !account.refresh_token.expose().is_empty()
            || projection.native_source_generation() != managed.generation_hash
            || projection.access_generation() != owner.generation_hash
            || projection.access_token() != &account.access_token
            || local.credentials.native_refreshed_at != owner.native_refreshed_at
        {
            return Err(MigrationError::from(custody_error()));
        }
        account.refresh_token = local.credentials.refresh_token.clone();
        let owner = account.native_owner.as_mut().ok_or_else(custody_error)?;
        owner.generation_hash = local.credentials.generation_hash();
        owner.managed_source = None;
    }
    if store.read(&key).await?.as_ref() != Some(&current) {
        return Err(MigrationError::from(custody_error()));
    }
    entry.value = pool_value(&pool)?;
    Ok(())
}

/// Explicit local-only source plus current private operational custody. No live
/// restore or authorization constructor consumes this evidence object.
pub struct LocalNativeRollbackBundle {
    source: LocalNativeCapture,
    controls: Vec<CustodyRecord>,
    artifacts: ArtifactContext,
}
impl LocalNativeRollbackBundle {
    pub fn into_private_parts(self) -> (NativeCapture, Vec<CustodyRecord>, ArtifactContext) {
        (
            self.source.into_private_capture(),
            self.controls,
            self.artifacts,
        )
    }
}
pub async fn export_native_rollback_with_custody<S: QueryStore, H: NativeCustody>(
    store: &S,
    now_ms: i64,
    host: &H,
    artifacts: ArtifactContext,
) -> Result<LocalNativeRollbackBundle, MigrationError> {
    crate::inverse::validate_artifacts(&artifacts)?;
    let (source, controls) = crate::native_inverse::export(store, now_ms).await?;
    Ok(LocalNativeRollbackBundle {
        source: reconstruct_native(store, source, host).await?,
        controls,
        artifacts,
    })
}
