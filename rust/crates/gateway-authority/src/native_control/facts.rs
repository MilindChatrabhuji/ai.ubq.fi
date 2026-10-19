use super::{
    NativeRenewalFence,
    rows::{Actor, fail, session_key},
};
use crate::{
    TokenSource, keys,
    paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner},
    quota::{ApiKeyPolicy, ApiReservation, ApiUsageRequest, ApiUsageState},
    routing::{AdmittedAccount, SubscriptionPool},
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
    identity::RequestContext,
    local_work::journal_local_work,
    model::ModelId,
    provider::UpstreamProvider,
    source_json::SourceJson,
    source_serialization as source,
    state::{AuthorityStore, RevisionCheck},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Session {
    context: RequestContext,
    input_digest: String,
    api: Option<ApiReservation>,
    attempts: Vec<Attempt>,
    active: Option<String>,
    refreshed_versions: Vec<String>,
    finished: bool,
    semantic_committed: bool,
    recovering: bool,
    lease_expires_at_ms: i64,
}
#[derive(Deserialize)]
struct Attempt {
    id: String,
    provider: UpstreamProvider,
    model: ModelId,
    fence: SourceJson,
    phase: String,
}

pub(super) struct Facts {
    pub fence: NativeRenewalFence,
    pub checks_digest: String,
    pub account_digests: Vec<String>,
    pub control_checks_digest: String,
}

pub(super) fn digest<T: serde::Serialize>(value: &T) -> Result<String, GatewayError> {
    Ok(sha256_hex(&serde_json::to_vec(value).map_err(|_| fail())?))
}
pub(super) fn checks_digest(checks: &[RevisionCheck]) -> Result<String, GatewayError> {
    let prefix = super::rows::prefix();
    digest(
        &checks
            .iter()
            .filter(|c| !c.key.0.starts_with(&prefix.0))
            .map(|c| (&c.key.0, &c.expected_revision))
            .collect::<Vec<_>>(),
    )
}

async fn read_session<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    request_id: &str,
) -> Result<Session, GatewayError> {
    let raw: SourceJson = tx
        .read_source_control(&session_key(request_id))
        .await?
        .ok_or_else(fail)?;
    // One authoritative parser retains v1, complete provider-planned v2, and
    // ordinary v3's canonical-ORIGINAL binding. A version never grants authority.
    journal_local_work(&raw)?;
    raw.deserialize().map_err(|_| fail())
}

pub(super) async fn session_context<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    request_id: &str,
) -> Result<RequestContext, GatewayError> {
    Ok(read_session(tx, request_id).await?.context)
}

pub(super) async fn read_control<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    actor: &Actor,
    request_id: &str,
    expected_attempt: Option<&str>,
    identity: &gateway_auth::native_auth::NativeTransportIdentity,
    current_config: &gateway_auth::AuthConfig,
) -> Result<ControlFacts, GatewayError> {
    let owner_id = identity.owner_id();
    let owner_epoch = identity.owner_epoch();
    let key_fingerprint = identity.key_fingerprint();
    let owner: PaidControlOwner = tx
        .read(&keys::paid_control_owner())
        .await?
        .ok_or_else(fail)?;
    if owner.v != 1
        || owner.owner_id != owner_id
        || owner.owner_epoch != owner_epoch
        || owner.key_fingerprint != key_fingerprint
    {
        return Err(fail());
    }
    let config: PaidControlConfig = tx
        .read(&keys::paid_control_config())
        .await?
        .ok_or_else(fail)?;
    if config.v != PAID_CONTROL_CONFIG_VERSION
        || config.owner_id != owner_id
        || config.owner_epoch != owner_epoch
    {
        return Err(fail());
    }
    let runtime_key = runtime_key();
    tx.observe_revision(&runtime_key).await?;
    if config.source_checks.len() != 1
        || config.source_checks[0].key != runtime_key.0
        || config.source_checks[0].expected_revision != tx.revision(&runtime_key)
    {
        return Err(fail());
    }
    let current_actor = super::actor::read_current(tx, actor, current_config).await?;
    if current_actor.scope != super::actor::NativeActorScope::Client {
        return Err(fail());
    }
    let policy_digest = current_actor.policy_digest;
    let session = read_session(tx, request_id).await?;
    if session.context.request_id.0 != request_id
        || session.context.principal.0 != current_actor.principal
        || session.finished
        || session.semantic_committed
        || session.recovering
        || session.lease_expires_at_ms <= tx.now
    {
        return Err(fail());
    }
    let attempt_id = expected_attempt
        .or(session.active.as_deref())
        .ok_or_else(fail)?;
    let attempt = session
        .attempts
        .iter()
        .find(|a| a.id == attempt_id)
        .ok_or_else(fail)?;
    if attempt.provider != UpstreamProvider::ChatgptCodex
        || !matches!(attempt.phase.as_str(), "Prepared" | "Intent" | "Started")
    {
        return Err(fail());
    }
    let fence = source::member(&attempt.fence, "Codex").ok_or_else(fail)?;
    let admission: AdmittedAccount = source::member(&fence, "admission")
        .ok_or_else(fail)?
        .deserialize()
        .map_err(|_| fail())?;
    let source_key = codex_source_pool_key();
    let scalar =
        |field| source::member(&fence, field).and_then(|value| value.deserialize::<String>().ok());
    if scalar("source_key").as_deref() != Some(source_key.0.as_str())
        || scalar("source_revision").as_deref()
            != Some(admission.binding.pool_versionstamp.0.as_str())
        || !session
            .refreshed_versions
            .contains(&admission.binding.credential_version.0)
    {
        return Err(fail());
    }
    if let Some(key_id) = session.context.key_id.as_ref().map(|k| &k.0) {
        if current_actor.principal != format!("api-key:{key_id}") {
            return Err(fail());
        }
        if session.context.key_id.as_ref().map(|k| k.0.as_str()) != Some(key_id) {
            return Err(fail());
        }
        let api = session.api.as_ref().ok_or_else(fail)?;
        if api.key_id.0 != *key_id
            || api.request_id != session.context.request_id
            || api.route != session.context.route
        {
            return Err(fail());
        }
        let _: ApiKeyPolicy = tx.read(&keys::api_policy(key_id)).await?.ok_or_else(fail)?;
        if !api.deferred {
            let request: ApiUsageRequest = tx
                .read(&keys::api_request(
                    key_id,
                    &api.policy_version,
                    api.window_start_ms,
                    &api.request_id.0,
                ))
                .await?
                .ok_or_else(fail)?;
            request.validate()?;
            if request.key_id != api.key_id
                || request.request_id != api.request_id
                || request.route != api.route
                || request.state == ApiUsageState::Released
            {
                return Err(fail());
            }
        }
    }
    Ok(ControlFacts {
        admission,
        attempt_id: attempt_id.into(),
        model: attempt.model.clone(),
        native_generation: scalar("native_generation").ok_or_else(fail)?,
        principal_policy_digest: policy_digest,
        original_admission_digest: digest(&(
            &session.context,
            &session.input_digest,
            &session.api,
            attempt_id,
        ))?,
        checks_digest: checks_digest(&tx.checks())?,
    })
}

pub(super) struct ControlFacts {
    pub admission: AdmittedAccount,
    pub attempt_id: String,
    pub model: ModelId,
    pub native_generation: String,
    pub principal_policy_digest: String,
    pub original_admission_digest: String,
    pub checks_digest: String,
}

pub(super) async fn read<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    actor: &Actor,
    request_id: &str,
    expected_attempt: Option<&str>,
    identity: &gateway_auth::native_auth::NativeTransportIdentity,
    current_config: &gateway_auth::AuthConfig,
    registered: &super::RegisteredRenewalOwner,
) -> Result<Facts, GatewayError> {
    let control = read_control(
        tx,
        actor,
        request_id,
        expected_attempt,
        identity,
        current_config,
    )
    .await?;
    let admission = &control.admission;
    let current_actor = super::actor::read_current(tx, actor, current_config).await?;
    let source_key = codex_source_pool_key();
    let owner_id = identity.owner_id();
    let owner_epoch = identity.owner_epoch();
    let native_owner_id = registered.native_owner_id();
    let home = registered.home.as_str();
    let view = crate::routing::read_view(tx).await?;
    if !view.matches(admission) {
        return Err(fail());
    }
    let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(fail)?;
    let raw: Value = tx.read(&source_key).await?.ok_or_else(fail)?;
    let source = parse_codex_source_pool(&raw)?.ok_or_else(fail)?;
    let slot = usize::try_from(admission.binding.slot).map_err(|_| fail())?;
    let account = source.accounts.get(slot).ok_or_else(fail)?;
    let identity = account.identity();
    let native = account.native_owner.as_ref().ok_or_else(fail)?;
    if native.codex_home != home
        || native.generation_hash != identity.native_generation_hash
        || control.native_generation != identity.native_generation_hash
        || normalized.pool_versionstamp.0 != admission.binding.pool_versionstamp.0
    {
        return Err(fail());
    }
    if native.external_user_id.is_none()
        && (native.managed_source.is_none() || !account.refresh_token.expose().is_empty())
    {
        return Err(fail());
    }
    let physical = native
        .managed_source
        .as_ref()
        .map(|s| s.generation_hash.as_str())
        .unwrap_or(&native.generation_hash);
    let expiry = codex_access_expiry_ms(&account.access_token)
        .filter(|v| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0)
        .map(|v| v as i64);
    let fence = NativeRenewalFence {
        v: super::NATIVE_RENEWAL_FENCE_VERSION,
        owner_id: owner_id.into(),
        owner_epoch: owner_epoch.into(),
        owner_revision: tx.revision(&keys::paid_control_owner()).ok_or_else(fail)?,
        native_owner_id: native_owner_id.into(),
        source_revision: tx.revision(&source_key).ok_or_else(fail)?,
        normalized_revision: tx.revision(&keys::pool()).ok_or_else(fail)?,
        account_id_hash: identity.routing_account_hash.0,
        credential_version: identity.credential_version.0,
        source_native_generation: physical.into(),
        access_generation: native.generation_hash.clone(),
        access_expires_at_ms: expiry,
        native_refreshed_at: native.native_refreshed_at.clone(),
        principal: current_actor.principal,
        principal_policy_digest: control.principal_policy_digest,
        original_request_id: request_id.into(),
        context: super::NativeRenewalContext::Inference {
            attempt_id: control.attempt_id,
            original_admission_digest: control.original_admission_digest,
            model: control.model,
            slot: admission.binding.slot,
        },
    };
    Ok(Facts {
        fence,
        checks_digest: checks_digest(&tx.checks())?,
        control_checks_digest: control.checks_digest,
        account_digests: source
            .accounts
            .iter()
            .map(|a| digest(&a.private_source_value()))
            .collect::<Result<_, _>>()?,
    })
}

fn runtime_key() -> gateway_core::state::RecordKey {
    gateway_core::tuple_key::TupleKey::from_scalar_parts(&[
        gateway_core::tuple_key::ScalarKeyPart::String("uos_ai"),
        gateway_core::tuple_key::ScalarKeyPart::String("runtime_config"),
        gateway_core::tuple_key::ScalarKeyPart::String("v2"),
    ])
    .to_record_key()
}
