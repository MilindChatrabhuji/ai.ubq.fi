//! Constructor-owned fixed profile registry. Picking a resource is not renewal authorization.
use super::{
    RegisteredRenewalOwner,
    actor::{self, NativeActorScope, NativeRenewalActor},
    rows::{self, ActionRow, fail},
};
use crate::{
    Authority, TokenSource, keys,
    routing::{LiveAccountSelection, SubscriptionPool},
    store::Transaction,
};
use gateway_auth::{
    AuthConfig,
    crypto::sha256_hex,
    provider_credentials::{codex_source_pool_key, parse_codex_source_pool},
};
use gateway_core::{
    GatewayError,
    identity::AccountBinding,
    state::{AuthorityStore, RecordKey},
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde_json::Value;

/// One or two explicitly configured independent native owners. No environment/default lookup.
pub struct RegisteredRenewalOwners {
    owners: Vec<RegisteredRenewalOwner>,
}
impl RegisteredRenewalOwners {
    pub async fn for_inference<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        authority: &Authority<S, I>,
        admission: &crate::routing::AdmittedAccount,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        for _ in 0..3 {
            authority
                .ensure_admission_current(admission, authority.fresh_time(0)?)
                .await?;
            let mut tx = authority.transaction(authority.fresh_time(0)?)?;
            let owner = self
                .account(
                    &mut tx,
                    &admission.binding.account_id_hash.0,
                    Some(&admission.binding),
                    None,
                )
                .await?;
            authority.fresh_time(tx.now)?;
            if tx.commit().await? {
                return Ok(owner);
            }
        }
        Err(fail())
    }

    pub fn configured(owners: Vec<RegisteredRenewalOwner>) -> Result<Self, GatewayError> {
        if !(1..=2).contains(&owners.len()) {
            return Err(fail());
        }
        for (index, owner) in owners.iter().enumerate() {
            if owners[..index].iter().any(|prior| {
                prior.native_owner_id() == owner.native_owner_id() || prior.home == owner.home
            }) {
                return Err(fail());
            }
        }
        Ok(Self { owners })
    }
    async fn account<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        tx: &mut Transaction<'_, S, I>,
        hash: &str,
        expected: Option<&AccountBinding>,
        required_owner: Option<&str>,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        let source_key = codex_source_pool_key();
        let raw: Value = tx.read(&source_key).await?.ok_or_else(fail)?;
        let source = parse_codex_source_pool(&raw)?.ok_or_else(fail)?;
        let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(fail)?;
        normalized.validate()?;
        if normalized.pool_versionstamp.0 != tx.revision(&source_key).ok_or_else(fail)?
            || normalized.accounts.len() != source.accounts.len()
        {
            return Err(fail());
        }
        let (slot, account) = source
            .accounts
            .iter()
            .enumerate()
            .find(|(_, a)| a.identity().routing_account_hash.0 == hash)
            .ok_or_else(fail)?;
        let identity = account.identity();
        let projected = &normalized.accounts[slot];
        if projected.account_id_hash != identity.routing_account_hash
            || projected.admin_account_hash != identity.administrative_account_hash
            || projected.credential_version != identity.credential_version
        {
            return Err(fail());
        }
        if expected.is_some_and(|b| {
            b.slot != slot as u64
                || b.credential_version != identity.credential_version
                || b.pool_versionstamp != normalized.pool_versionstamp
        }) {
            return Err(fail());
        }
        let native = account.native_owner.as_ref().ok_or_else(fail)?;
        let owner = self
            .owners
            .iter()
            .find(|o| o.home == native.codex_home)
            .ok_or_else(fail)?;
        if required_owner.is_some_and(|id| id != owner.native_owner_id()) {
            return Err(fail());
        }
        Ok(owner)
    }
    pub async fn for_live_create<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        authority: &Authority<S, I>,
        selected: &LiveAccountSelection,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        for _ in 0..3 {
            authority
                .ensure_live_account_current(selected, authority.fresh_time(0)?)
                .await?;
            let mut tx = authority.transaction(authority.fresh_time(0)?)?;
            let owner = self
                .account(
                    &mut tx,
                    &selected.binding.account_id_hash.0,
                    Some(&selected.binding),
                    None,
                )
                .await?;
            authority.fresh_time(tx.now)?;
            if tx.commit().await? {
                return Ok(owner);
            }
        }
        Err(fail())
    }
    pub async fn for_live_mapped<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        authority: &Authority<S, I>,
        actor: &NativeRenewalActor,
        config: &AuthConfig,
        call_id: &str,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        if actor.scope() != NativeActorScope::Client || call_id.is_empty() || call_id.len() > 4096 {
            return Err(fail());
        }
        for _ in 0..3 {
            let mut tx = authority.transaction(authority.fresh_time(0)?)?;
            let current = actor::read_current(&mut tx, actor.stored(), config).await?;
            let marker: Option<Value> = tx.read(&mapping_key(call_id, true)).await?;
            if marker.is_some() {
                return Err(fail());
            }
            let key = mapping_key(call_id, false);
            let mapping: Value = tx.read(&key).await?.ok_or_else(fail)?;
            if mapping["principal_id"].as_str() != Some(&current.principal) {
                return Err(fail());
            }
            let account = mapping["account_id"].as_str().ok_or_else(fail)?;
            let hash = sha256_hex(format!("uos_ai\0codex_routing_account\0{account}").as_bytes());
            let owner = self.account(&mut tx, &hash, None, None).await?;
            let now = authority.fresh_time(tx.now)?;
            actor::validate_current_time(actor.stored(), now)?;
            if tx.expiry(&key).is_some_and(|at| at <= now) {
                return Err(fail());
            }
            actor.bind_preparation(&mut tx).await?;
            if tx.commit().await? {
                return Ok(owner);
            }
        }
        Err(fail())
    }
    pub async fn for_cache_experiment<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        authority: &Authority<S, I>,
        permit: &crate::cache_experiment::RefreshPermit,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        for _ in 0..3 {
            let mut tx = authority.transaction(authority.fresh_time(0)?)?;
            let now = tx.now;
            crate::cache_experiment::validate_refresh_context(&mut tx, permit.context(), now)
                .await?;
            let owner = self
                .account(
                    &mut tx,
                    &permit.binding().account_id_hash.0,
                    Some(permit.binding()),
                    None,
                )
                .await?;
            authority.fresh_time(now)?;
            if tx.commit().await? {
                return Ok(owner);
            }
        }
        Err(fail())
    }
    /// Import codec/current account select only a configured resource, never permission.
    pub async fn for_import_action<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        authority: &Authority<S, I>,
        action_ref: &str,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        crate::text(action_ref)?;
        for _ in 0..3 {
            let mut tx = authority.transaction(authority.fresh_time(0)?)?;
            let (account_hash, native_owner) =
                super::import::owner_selection(&mut tx, action_ref).await?;
            let owner = self
                .account(&mut tx, &account_hash, None, Some(&native_owner))
                .await?;
            authority.fresh_time(tx.now)?;
            if tx.commit().await? {
                return Ok(owner);
            }
        }
        Err(fail())
    }

    /// Only the stored server action chooses an owner; the wire carries no profile/home selector.
    pub async fn for_action<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        authority: &Authority<S, I>,
        action_ref: &str,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        crate::text(action_ref)?;
        for _ in 0..3 {
            let mut tx = authority.transaction(authority.fresh_time(0)?)?;
            let action: ActionRow = tx
                .read(&rows::key("action", action_ref))
                .await?
                .ok_or_else(fail)?;
            if action.v != 2
                || action.action_ref != action_ref
                || action.fence.v != super::NATIVE_RENEWAL_FENCE_VERSION
            {
                return Err(fail());
            }
            let owner = self
                .account(
                    &mut tx,
                    &action.fence.account_id_hash,
                    None,
                    Some(&action.fence.native_owner_id),
                )
                .await?;
            authority.fresh_time(tx.now)?;
            if tx.commit().await? {
                return Ok(owner);
            }
        }
        Err(fail())
    }

    /// Reverse callbacks resolve only the server operation+claim binding, never a request home.
    pub async fn for_operation<'a, S: AuthorityStore, I: TokenSource>(
        &'a self,
        authority: &Authority<S, I>,
        operation_id: &str,
        claim_ref: &str,
    ) -> Result<&'a RegisteredRenewalOwner, GatewayError> {
        crate::text(operation_id)?;
        crate::text(claim_ref)?;
        for _ in 0..3 {
            let mut tx = authority.transaction(authority.fresh_time(0)?)?;
            let operation: rows::OperationRow = tx
                .read(&rows::key("operation", operation_id))
                .await?
                .ok_or_else(fail)?;
            if operation.v != 1
                || operation.operation_id != operation_id
                || operation.claim_ref != claim_ref
            {
                return Err(fail());
            }
            let action: ActionRow = tx
                .read(&rows::key("action", &operation.action_ref))
                .await?
                .ok_or_else(fail)?;
            if action.v != 2
                || action.action_ref != operation.action_ref
                || action.operation_id.as_deref() != Some(operation_id)
                || action.fence.v != super::NATIVE_RENEWAL_FENCE_VERSION
            {
                return Err(fail());
            }
            let owner = self
                .account(
                    &mut tx,
                    &action.fence.account_id_hash,
                    None,
                    Some(&action.fence.native_owner_id),
                )
                .await?;
            authority.fresh_time(tx.now)?;
            if tx.commit().await? {
                return Ok(owner);
            }
        }
        Err(fail())
    }
}
fn mapping_key(call: &str, pending: bool) -> RecordKey {
    let mut parts = vec![
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("codex_live_calls"),
        ScalarKeyPart::String("v1"),
    ];
    if pending {
        parts.push(ScalarKeyPart::String("pending_retirement"));
    }
    parts.push(ScalarKeyPart::String(call));
    TupleKey::from_scalar_parts(&parts).to_record_key()
}
