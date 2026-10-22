use super::*;
use crate::{
    keys,
    paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner},
    routing::SubscriptionPool,
    store::Transaction,
};
use gateway_auth::{
    native_import::NativeImportTarget,
    provider_credentials::{codex_source_pool_key, parse_codex_source_pool},
};
use serde_json::Value;
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportFacts {
    pub owner_id: String,
    pub owner_epoch: String,
    pub native_owner_id: String,
    pub slot: u64,
    pub account_id_hash: String,
    pub credential_version: String,
    pub access_generation: String,
    pub source_native_generation: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    #[serde(deserialize_with = "required_nullable")]
    pub runtime_revision: Option<String>,
    pub control_checks_digest: String,
    pub account_digests: Vec<String>,
    pub checks_digest: String,
}
pub(super) async fn read<
    S: AuthorityStore,
    I: TokenSource,
    C: super::super::NativeRenewalCancellation,
>(
    control: &NativeRenewalAuthority<'_, S, I, C>,
    tx: &mut Transaction<'_, S, I>,
    actor: &super::super::actor::StoredNativeActor,
    target: &NativeImportTarget,
) -> Result<ImportFacts, GatewayError> {
    let NativeImportTarget::ExistingAccount { account_id_hash } = target else {
        return Err(unavailable());
    };
    let owner_key = keys::paid_control_owner();
    let owner: PaidControlOwner = tx.read(&owner_key).await?.ok_or_else(unavailable)?;
    if owner.v != 1
        || owner.owner_id != control.identity.owner_id()
        || owner.owner_epoch != control.identity.owner_epoch()
        || owner.key_fingerprint != control.identity.key_fingerprint()
    {
        return Err(unavailable());
    }
    let config: PaidControlConfig = tx
        .read(&keys::paid_control_config())
        .await?
        .ok_or_else(unavailable)?;
    let runtime = gateway_auth::store::key(serde_json::json!(["uos_ai", "runtime_config", "v2"]));
    tx.observe_revision(&runtime).await?;
    if config.v != PAID_CONTROL_CONFIG_VERSION
        || config.owner_id != owner.owner_id
        || config.owner_epoch != owner.owner_epoch
        || config.source_checks.len() != 1
        || config.source_checks[0].key != runtime.0
        || config.source_checks[0].expected_revision != tx.revision(&runtime)
    {
        return Err(unavailable());
    }
    let current = super::super::actor::read_current(tx, actor, control.current_config).await?;
    if current.scope != super::super::actor::NativeActorScope::Admin {
        return Err(unavailable());
    }
    let key = codex_source_pool_key();
    let raw: Value = tx.read(&key).await?.ok_or_else(unavailable)?;
    let source = parse_codex_source_pool(&raw)?.ok_or_else(unavailable)?;
    let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(unavailable)?;
    normalized.validate()?;
    if normalized.pool_versionstamp.0 != tx.revision(&key).ok_or_else(unavailable)?
        || normalized.accounts.len() != source.accounts.len()
    {
        return Err(unavailable());
    }
    let mut selected = None;
    let mut account_digests = Vec::new();
    for (index, account) in source.accounts.iter().enumerate() {
        account_digests.push(super::super::facts::digest(
            &account.private_source_value(),
        )?);
        let identity = account.identity();
        let projected = &normalized.accounts[index];
        if projected.account_id_hash != identity.routing_account_hash
            || projected.admin_account_hash != identity.administrative_account_hash
            || projected.credential_version != identity.credential_version
        {
            return Err(unavailable());
        }
        if identity.routing_account_hash.0 == *account_id_hash {
            let native = account.native_owner.as_ref().ok_or_else(unavailable)?;
            if native.codex_home != control.registered.home
                || native.generation_hash != identity.native_generation_hash
                || native.external_user_id.is_none()
                    && (native.managed_source.is_none()
                        || !account.refresh_token.expose().is_empty())
            {
                return Err(unavailable());
            }
            let physical = native
                .managed_source
                .as_ref()
                .filter(|source| {
                    source.v == gateway_auth::provider_credentials::MANAGED_NATIVE_SOURCE_VERSION
                })
                .ok_or_else(unavailable)?;
            if native.external_user_id.is_some() || !account.refresh_token.expose().is_empty() {
                return Err(unavailable());
            }
            selected = Some((
                index as u64,
                identity.credential_version.0,
                native.generation_hash.clone(),
                physical.generation_hash.clone(),
            ));
        }
    }
    let (slot, credential_version, access_generation, source_native_generation) =
        selected.ok_or_else(unavailable)?;
    tx.now = control.time(tx.now)?;
    super::super::actor::validate_current_time(actor, tx.now)?;
    Ok(ImportFacts {
        owner_id: owner.owner_id,
        owner_epoch: owner.owner_epoch,
        native_owner_id: control.registered.native_owner_id().into(),
        slot,
        account_id_hash: account_id_hash.clone(),
        credential_version,
        access_generation,
        source_native_generation,
        owner_revision: tx.revision(&owner_key).ok_or_else(unavailable)?,
        source_revision: tx.revision(&key).ok_or_else(unavailable)?,
        normalized_revision: tx.revision(&keys::pool()).ok_or_else(unavailable)?,
        runtime_revision: tx.revision(&runtime),
        control_checks_digest: control_digest(&tx.checks())?,
        account_digests,
        checks_digest: super::super::facts::checks_digest(&tx.checks())?,
    })
}

pub(super) fn control_digest(
    checks: &[gateway_core::state::RevisionCheck],
) -> Result<String, GatewayError> {
    let source = codex_source_pool_key();
    let pool = keys::pool();
    let runtime = gateway_auth::store::key(serde_json::json!(["uos_ai", "runtime_config", "v2"]));
    super::super::facts::checks_digest(
        &checks
            .iter()
            .filter(|c| c.key != source && c.key != pool && c.key != runtime)
            .cloned()
            .collect::<Vec<_>>(),
    )
}
