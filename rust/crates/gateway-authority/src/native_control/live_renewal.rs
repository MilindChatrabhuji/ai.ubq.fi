//! Explicit non-inference native renewal facts. No manufactured session, attempt or admission.
use super::{
    NATIVE_RENEWAL_FENCE_VERSION, NativeRenewalAction, NativeRenewalAuthority,
    NativeRenewalCancellation, NativeRenewalContext, NativeRenewalFence, OWNER_RENEWAL_MAX_MS,
    actor::{self, NativeActorScope, NativeRenewalActor, StoredNativeActor},
    facts,
    rows::{self, ActionRow, conflict, fail},
};
use crate::{
    TokenSource, keys,
    paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner},
    routing::{LiveAccountSelection, SubscriptionPool},
    store::Transaction,
};
use gateway_auth::{
    crypto::sha256_hex,
    provider_credentials::{
        codex_access_expiry_ms, codex_source_pool_key, parse_codex_source_pool,
    },
};
use gateway_core::{
    GatewayError,
    identity::ActiveSelection,
    state::AuthorityStore,
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde_json::Value;

struct Control {
    principal: String,
    policy_digest: String,
    account_hash: String,
    checks_digest: String,
}
fn mapping_key(call: &str, pending: bool) -> gateway_core::state::RecordKey {
    let mut p = vec![
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("codex_live_calls"),
        ScalarKeyPart::String("v1"),
    ];
    if pending {
        p.push(ScalarKeyPart::String("pending_retirement"));
    }
    p.push(ScalarKeyPart::String(call));
    TupleKey::from_scalar_parts(&p).to_record_key()
}
impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    pub async fn prepare_live_create_renewal(
        &self,
        actor: &NativeRenewalActor,
        selected: &LiveAccountSelection,
    ) -> Result<NativeRenewalAction, GatewayError> {
        let context = NativeRenewalContext::LiveCreate {
            binding: selected.binding.clone(),
            active_generation: selected.active_generation,
            model_utf16: selected.model.as_ref().map(|s| s.as_units().to_vec()),
        };
        self.prepare_live_context(actor, context, None).await
    }
    pub async fn prepare_live_mapped_renewal(
        &self,
        actor: &NativeRenewalActor,
        call_id: &str,
    ) -> Result<NativeRenewalAction, GatewayError> {
        if call_id.is_empty() || call_id.len() > 4096 {
            return Err(fail());
        }
        let mut tx = self.authority.transaction(self.time(0)?)?;
        let key = mapping_key(call_id, false);
        let _: Value = tx.read(&key).await?.ok_or_else(fail)?;
        let mapping_revision = tx.revision(&key).ok_or_else(fail)?;
        if !tx.commit().await? {
            return Err(conflict());
        }
        self.prepare_live_context(
            actor,
            NativeRenewalContext::LiveMapped {
                call_id: call_id.into(),
                mapping_revision,
            },
            None,
        )
        .await
    }
    pub async fn prepare_cache_experiment_renewal(
        &self,
        actor: &NativeRenewalActor,
        permit: &crate::cache_experiment::RefreshPermit,
    ) -> Result<NativeRenewalAction, GatewayError> {
        self.prepare_live_context(
            actor,
            NativeRenewalContext::CacheExperiment {
                context: Box::new(permit.context().clone()),
            },
            Some(permit.binding()),
        )
        .await
    }
    async fn prepare_live_context(
        &self,
        actor: &NativeRenewalActor,
        context: NativeRenewalContext,
        expected: Option<&gateway_core::identity::AccountBinding>,
    ) -> Result<NativeRenewalAction, GatewayError> {
        let scope = if matches!(context, NativeRenewalContext::CacheExperiment { .. }) {
            NativeActorScope::Admin
        } else {
            NativeActorScope::Client
        };
        if actor.scope() != scope {
            return Err(fail());
        }
        let request_id = &actor.context().request_id.0;
        for _ in 0..5 {
            let now = self.time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let current = self
                .read_context(&mut tx, actor.stored(), request_id, &context)
                .await?;
            if expected.is_some_and(|binding| {
                binding.slot != 0
                    || binding.account_id_hash.0 != current.fence.account_id_hash
                    || binding.credential_version.0 != current.fence.credential_version
                    || binding.pool_versionstamp.0 != current.fence.source_revision
            }) {
                return Err(fail());
            }
            if current.fence.principal_policy_digest != actor.policy_digest() {
                return Err(fail());
            }
            let reference = facts::digest(&(
                "uos-native-renewal-action-v2",
                request_id,
                &context,
                &current.fence.source_native_generation,
            ))?;
            let key = rows::key("action", &reference);
            let prior: Option<ActionRow> = tx.read_source_control(&key).await?;
            let row = if let Some(row) = prior {
                if row.v != 2
                    || row.actor != *actor.stored()
                    || row.fence != current.fence
                    || row.checks_digest != current.checks_digest
                {
                    return Err(conflict());
                }
                row
            } else {
                let row = ActionRow {
                    v: 2,
                    action_ref: reference.clone(),
                    actor: actor.stored().clone(),
                    created_at_ms: now,
                    deadline_ms: crate::add(now, OWNER_RENEWAL_MAX_MS)?,
                    fence: current.fence,
                    checks_digest: current.checks_digest,
                    control_checks_digest: current.control_checks_digest,
                    account_digests: current.account_digests,
                    operation_id: None,
                };
                tx.put_source_control(&key, &row, None)?;
                row
            };
            self.current(&mut tx, &row).await?;
            actor.bind_preparation(&mut tx).await?;
            actor::validate_current_time(&row.actor, self.time(now)?)?;
            if tx.commit().await? {
                return Ok(NativeRenewalAction {
                    action_ref: reference,
                    deadline_ms: row.deadline_ms,
                    fence: row.fence,
                });
            }
        }
        Err(conflict())
    }
    async fn live_control(
        &self,
        tx: &mut Transaction<'_, S, I>,
        actor: &StoredNativeActor,
        context: &NativeRenewalContext,
    ) -> Result<Control, GatewayError> {
        let owner: PaidControlOwner = tx
            .read(&keys::paid_control_owner())
            .await?
            .ok_or_else(fail)?;
        if owner.v != 1
            || owner.owner_id != self.identity.owner_id()
            || owner.owner_epoch != self.identity.owner_epoch()
            || owner.key_fingerprint != self.identity.key_fingerprint()
        {
            return Err(fail());
        }
        let config: PaidControlConfig = tx
            .read(&keys::paid_control_config())
            .await?
            .ok_or_else(fail)?;
        let runtime_key = TupleKey::from_scalar_parts(&[
            ScalarKeyPart::String("uos_ai"),
            ScalarKeyPart::String("runtime_config"),
            ScalarKeyPart::String("v2"),
        ])
        .to_record_key();
        tx.observe_revision(&runtime_key).await?;
        if config.v != PAID_CONTROL_CONFIG_VERSION
            || config.owner_id != owner.owner_id
            || config.owner_epoch != owner.owner_epoch
            || config.source_checks.len() != 1
            || config.source_checks[0].key != runtime_key.0
            || config.source_checks[0].expected_revision != tx.revision(&runtime_key)
        {
            return Err(fail());
        }
        let current = actor::read_current(tx, actor, self.current_config).await?;
        let scope = if matches!(context, NativeRenewalContext::CacheExperiment { .. }) {
            NativeActorScope::Admin
        } else {
            NativeActorScope::Client
        };
        if current.scope != scope {
            return Err(fail());
        }
        let account_hash = match context {
            NativeRenewalContext::LiveCreate {
                binding,
                active_generation,
                ..
            } => {
                let active: ActiveSelection = tx.read(&keys::active()).await?.ok_or_else(fail)?;
                if active.v != 1
                    || active.binding != *binding
                    || active.generation != *active_generation
                {
                    return Err(fail());
                }
                let routing: Option<Value> = tx.read(&keys::routing()).await?;
                if let Some(raw) = routing {
                    let state = crate::routing::parse_routing_state(&raw)?;
                    let slot = state
                        .slots
                        .get(usize::try_from(binding.slot).map_err(|_| fail())?)
                        .ok_or_else(fail)?;
                    if slot.account_id_hash.as_ref() != Some(&binding.account_id_hash)
                        || slot.credential_version != binding.credential_version
                        || slot.generation != binding.routing_generation
                        || slot.invalid_credential_version.as_ref()
                            == Some(&binding.credential_version)
                    {
                        return Err(fail());
                    }
                } else if binding.routing_generation != 0 {
                    return Err(fail());
                }
                let selection: Option<Value> = tx.read(&keys::provider_selection()).await?;
                if selection.as_ref().is_some_and(|v| {
                    !v.is_null()
                        && gateway_schema::selection::ProviderSelection::normalize(v).is_none()
                }) {
                    return Err(fail());
                }
                binding.account_id_hash.0.clone()
            }
            NativeRenewalContext::LiveMapped {
                call_id,
                mapping_revision,
            } => {
                let pending: Option<Value> = tx.read(&mapping_key(call_id, true)).await?;
                if pending.is_some() {
                    return Err(fail());
                }
                let key = mapping_key(call_id, false);
                let mapping: Value = tx.read(&key).await?.ok_or_else(fail)?;
                if tx.revision(&key).as_ref() != Some(mapping_revision)
                    || mapping["principal_id"].as_str() != Some(&current.principal)
                    || tx.expiry(&key).is_some_and(|v| v <= tx.now)
                {
                    return Err(fail());
                }
                let account = mapping["account_id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(fail)?;
                sha256_hex(format!("uos_ai\0codex_routing_account\0{account}").as_bytes())
            }
            NativeRenewalContext::CacheExperiment { context } => {
                {
                    let now = self.time(tx.now)?;
                    crate::cache_experiment::validate_refresh_context(tx, context, now)
                }
                .await?;
                let pool: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(fail)?;
                if pool.accounts.len() != 2 {
                    return Err(fail());
                }
                pool.accounts[0].account_id_hash.0.clone()
            }
            NativeRenewalContext::Inference { .. } => return Err(fail()),
        };
        tx.now = self.time(tx.now)?;
        actor::validate_current_time(actor, tx.now)?;
        if let NativeRenewalContext::LiveMapped { call_id, .. } = context
            && tx
                .expiry(&mapping_key(call_id, false))
                .is_some_and(|at| at <= tx.now)
        {
            return Err(fail());
        }
        // Credential replacement is proven separately by current facts/known terminal publication.
        // Do not mistake the operation's own source+projection CAS for caller/configuration drift.
        let credential_keys = [codex_source_pool_key(), keys::pool()];
        let control_checks = tx
            .checks()
            .into_iter()
            .filter(|c| !credential_keys.contains(&c.key))
            .collect::<Vec<_>>();
        Ok(Control {
            principal: current.principal,
            policy_digest: current.policy_digest,
            account_hash,
            checks_digest: facts::checks_digest(&control_checks)?,
        })
    }
    pub(super) async fn read_context(
        &self,
        tx: &mut Transaction<'_, S, I>,
        actor: &StoredNativeActor,
        request_id: &str,
        context: &NativeRenewalContext,
    ) -> Result<facts::Facts, GatewayError> {
        if let NativeRenewalContext::Inference { attempt_id, .. } = context {
            return facts::read(
                tx,
                actor,
                request_id,
                Some(attempt_id),
                self.identity,
                self.current_config,
                self.registered,
            )
            .await;
        }
        let control = self.live_control(tx, actor, context).await?;
        let source_key = codex_source_pool_key();
        let raw: Value = tx.read(&source_key).await?.ok_or_else(fail)?;
        let source = parse_codex_source_pool(&raw)?.ok_or_else(fail)?;
        let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(fail)?;
        normalized.validate()?;
        if normalized.pool_versionstamp.0 != tx.revision(&source_key).ok_or_else(fail)?
            || source.accounts.len() != normalized.accounts.len()
        {
            return Err(fail());
        }
        let (slot, account) = source
            .accounts
            .iter()
            .enumerate()
            .find(|(_, a)| a.identity().routing_account_hash.0 == control.account_hash)
            .ok_or_else(fail)?;
        let id = account.identity();
        let projected = &normalized.accounts[slot];
        if projected.account_id_hash != id.routing_account_hash
            || projected.admin_account_hash != id.administrative_account_hash
            || projected.credential_version != id.credential_version
        {
            return Err(fail());
        }
        if let NativeRenewalContext::LiveCreate { binding, .. } = context {
            if binding.slot != slot as u64
                || binding.pool_versionstamp != normalized.pool_versionstamp
                || binding.credential_version != id.credential_version
            {
                return Err(fail());
            }
            let selection: Option<Value> = tx.read(&keys::provider_selection()).await?;
            if selection
                .as_ref()
                .filter(|v| !v.is_null())
                .is_some_and(|v| {
                    gateway_schema::selection::ProviderSelection::normalize(v)
                        .is_none_or(|s| !s.account_eligible(&id.administrative_account_hash.0))
                })
            {
                return Err(fail());
            }
        }
        let native = account.native_owner.as_ref().ok_or_else(fail)?;
        if native.codex_home != self.registered.home
            || native.generation_hash != id.native_generation_hash
            || (native.external_user_id.is_none()
                && (native.managed_source.is_none() || !account.refresh_token.expose().is_empty()))
        {
            return Err(fail());
        }
        let raw_expiry = codex_access_expiry_ms(&account.access_token);
        // Source auth.ts needsRefresh: JWT truthy expiry <2min; otherwise updated age >7min.
        let needs = raw_expiry.filter(|v| *v != 0.0).map_or(
            (self.time(tx.now)? as f64) - account.updated_at_ms > 420_000.0,
            |v| v - (tx.now as f64) < 120_000.0,
        );
        if !needs && !matches!(context, NativeRenewalContext::CacheExperiment { .. }) {
            return Err(GatewayError::new(
                409,
                "Current live access does not require native renewal.",
                Some("native_live_renewal_not_required"),
            ));
        }
        let expiry = raw_expiry
            .filter(|v| {
                v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v <= 9_007_199_254_740_991.0
            })
            .map(|v| v as i64);
        let physical = native
            .managed_source
            .as_ref()
            .map(|s| s.generation_hash.clone())
            .unwrap_or_else(|| native.generation_hash.clone());
        tx.now = self.time(tx.now)?;
        actor::validate_current_time(actor, tx.now)?;
        if let NativeRenewalContext::LiveMapped { call_id, .. } = context
            && tx
                .expiry(&mapping_key(call_id, false))
                .is_some_and(|at| at <= tx.now)
        {
            return Err(fail());
        }
        if let NativeRenewalContext::CacheExperiment { context } = context {
            let now = tx.now;
            crate::cache_experiment::validate_refresh_context(tx, context, now).await?;
        }
        Ok(facts::Facts {
            fence: NativeRenewalFence {
                v: NATIVE_RENEWAL_FENCE_VERSION,
                owner_id: self.identity.owner_id().into(),
                owner_epoch: self.identity.owner_epoch().into(),
                owner_revision: tx.revision(&keys::paid_control_owner()).ok_or_else(fail)?,
                native_owner_id: self.registered.native_owner_id().into(),
                source_revision: tx.revision(&source_key).ok_or_else(fail)?,
                normalized_revision: tx.revision(&keys::pool()).ok_or_else(fail)?,
                account_id_hash: id.routing_account_hash.0,
                credential_version: id.credential_version.0,
                source_native_generation: physical,
                access_generation: native.generation_hash.clone(),
                access_expires_at_ms: expiry,
                native_refreshed_at: native.native_refreshed_at.clone(),
                principal: control.principal,
                principal_policy_digest: control.policy_digest,
                original_request_id: request_id.into(),
                context: context.clone(),
            },
            checks_digest: facts::checks_digest(&tx.checks())?,
            control_checks_digest: control.checks_digest,
            account_digests: source
                .accounts
                .iter()
                .map(|a| facts::digest(&a.private_source_value()))
                .collect::<Result<_, _>>()?,
        })
    }
    pub(super) async fn context_control_digest(
        &self,
        tx: &mut Transaction<'_, S, I>,
        action: &ActionRow,
    ) -> Result<String, GatewayError> {
        match &action.fence.context {
            NativeRenewalContext::Inference { attempt_id, .. } => Ok(facts::read_control(
                tx,
                &action.actor,
                &action.fence.original_request_id,
                Some(attempt_id),
                self.identity,
                self.current_config,
            )
            .await?
            .checks_digest),
            context => Ok(self
                .live_control(tx, &action.actor, context)
                .await?
                .checks_digest),
        }
    }
}
