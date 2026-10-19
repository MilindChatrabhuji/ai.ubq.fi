//! Same-authority live custody. No admission, quota proof, refresh or paid authorization.
use crate::native_control::actor::{self, NativeActorScope, NativeRenewalActor, StoredNativeActor};
use crate::paid_control::PaidControlOwner;
use crate::routing::SubscriptionPool;
use crate::{Authority, TokenSource, keys, store::Transaction};
use gateway_auth::{
    AuthConfig,
    native_auth::NativeTransportIdentity,
    native_live::AuthenticatedNativeLive,
    provider_credentials::{
        codex_access_expiry_ms, codex_source_pool_key, parse_codex_source_pool,
    },
};
use gateway_core::{
    GatewayError,
    state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation},
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod wire;
pub use wire::*;

/// Nonexpiring secretless control custody, NOT a second routing/accounting ledger.
pub fn custody_key(kind: &str, reference: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("native_live"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String(kind),
        ScalarKeyPart::String(reference),
    ])
    .to_record_key()
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
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ActionRow {
    v: u8,
    action_ref: String,
    request_id: String,
    actor: StoredNativeActor,
    call_id: String,
    account_id: String,
    mapping_revision: String,
    created_at_ms: i64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConnectionRow {
    v: u8,
    action_ref: String,
    connection_id: String,
    authorization_ref: String,
    owner_id: String,
    owner_epoch: String,
    key_fingerprint: String,
    call_id: String,
    created_at_ms: i64,
    upstream_status: Option<u16>,
    retired: bool,
}
/// Server-created selector, deliberately neither Serialize nor Deserialize.
pub struct NativeLiveAction {
    action_ref: String,
}
impl NativeLiveAction {
    pub fn action_ref(&self) -> &str {
        &self.action_ref
    }
}
pub struct NativeLiveAuthority<'a, S, I> {
    authority: &'a Authority<S, I>,
    identity: &'a NativeTransportIdentity,
    config: &'a AuthConfig,
}
impl<'a, S: AuthorityStore, I: TokenSource> NativeLiveAuthority<'a, S, I> {
    pub fn configured(
        authority: &'a Authority<S, I>,
        identity: &'a NativeTransportIdentity,
        config: &'a AuthConfig,
    ) -> Self {
        Self {
            authority,
            identity,
            config,
        }
    }

    /// Original actor is minted by the real request's AuthService, never recovered from an ID.
    pub async fn prepare_live_sideband(
        &self,
        actor: &NativeRenewalActor,
        call_id: &str,
    ) -> Result<NativeLiveAction, GatewayError> {
        if actor.scope() != NativeActorScope::Client || call_id.is_empty() || call_id.len() > 4096 {
            return Err(fail());
        }
        for _ in 0..5 {
            let now = self.authority.fresh_time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let reference = self.authority.tokens.next_token()?;
            if !wire::reference(&reference) {
                return Err(fail());
            }
            let key = custody_key("action", &reference);
            let prior: Option<Value> = tx.read(&key).await?;
            if prior.is_some() {
                return Err(fail());
            }
            let mapping: Value = tx
                .read(&mapping_key(call_id, false))
                .await?
                .ok_or_else(missing)?;
            let row = ActionRow {
                v: 1,
                action_ref: reference.clone(),
                request_id: actor.context().request_id.0.clone(),
                actor: actor.stored().clone(),
                call_id: call_id.into(),
                account_id: mapping["account_id"].as_str().ok_or_else(missing)?.into(),
                mapping_revision: tx
                    .revision(&mapping_key(call_id, false))
                    .ok_or_else(missing)?,
                created_at_ms: now,
            };
            let _ = self.current(&mut tx, &row).await?;
            actor.bind_preparation(&mut tx).await?;
            tx.put(&key, &row, None)?;
            if tx.commit().await? {
                return Ok(NativeLiveAction {
                    action_ref: reference,
                });
            }
        }
        Err(conflict())
    }
    async fn current(
        &self,
        tx: &mut Transaction<'_, S, I>,
        row: &ActionRow,
    ) -> Result<(NativeLiveFence, NativeLiveAccess), GatewayError> {
        if row.v != 1 {
            return Err(fail());
        }
        let actor = actor::read_current(tx, &row.actor, self.config).await?;
        if actor.scope != NativeActorScope::Client {
            return Err(fail());
        }
        let pending: Option<Value> = tx.read(&mapping_key(&row.call_id, true)).await?;
        if pending.is_some() {
            return Err(missing());
        }
        let map_key = mapping_key(&row.call_id, false);
        let mapping: Value = tx.read(&map_key).await?.ok_or_else(missing)?;
        if mapping["account_id"].as_str() != Some(&row.account_id)
            || mapping["principal_id"].as_str() != Some(&actor.principal)
            || tx.revision(&map_key).as_deref() != Some(&row.mapping_revision)
        {
            return Err(missing());
        }
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
        let source_key = codex_source_pool_key();
        let raw: Value = tx.read(&source_key).await?.ok_or_else(fail)?;
        let pool = parse_codex_source_pool(&raw)?.ok_or_else(fail)?;
        let normalized: SubscriptionPool = tx.read(&keys::pool()).await?.ok_or_else(fail)?;
        normalized.validate()?;
        let (slot, account) = pool
            .accounts
            .iter()
            .enumerate()
            .find(|(_, a)| a.account_id == row.account_id)
            .ok_or_else(missing)?;
        let identity = account.identity();
        let projected = normalized.accounts.get(slot).ok_or_else(fail)?;
        if normalized.pool_versionstamp.0 != tx.revision(&source_key).ok_or_else(fail)?
            || projected.account_id_hash != identity.routing_account_hash
            || projected.admin_account_hash != identity.administrative_account_hash
            || projected.credential_version != identity.credential_version
        {
            return Err(fail());
        }
        let expiry = codex_access_expiry_ms(&account.access_token)
            .filter(|v| {
                v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v <= 9_007_199_254_740_991.0
            })
            .map(|v| v as i64);
        let now = self.authority.fresh_time(tx.now)?;
        actor::validate_current_time(&row.actor, now)?;
        if tx.expiry(&map_key).is_some_and(|at| at <= now) {
            return Err(missing());
        }
        if expiry.is_some_and(|at| at <= now) {
            return Err(GatewayError::new(
                503,
                "Current live access requires separate credential preparation.",
                Some("native_live_access_expired"),
            ));
        }
        tx.now = now;
        Ok((
            NativeLiveFence {
                call_id: row.call_id.clone(),
                account_id: row.account_id.clone(),
                account_id_hash: identity.routing_account_hash.0,
                credential_version: identity.credential_version.0,
                source_revision: tx.revision(&source_key).ok_or_else(fail)?,
                normalized_revision: tx.revision(&keys::pool()).ok_or_else(fail)?,
                mapping_revision: row.mapping_revision.clone(),
                owner_id: owner.owner_id,
                owner_epoch: owner.owner_epoch,
                owner_revision: tx.revision(&keys::paid_control_owner()).ok_or_else(fail)?,
                principal: actor.principal,
                principal_policy_digest: actor.policy_digest,
                access_expires_at_ms: expiry,
            },
            NativeLiveAccess::current(account.access_token.expose().to_owned()),
        ))
    }
    fn proof(&self, proof: &AuthenticatedNativeLive, body: &[u8]) -> Result<(), GatewayError> {
        proof.require_authority_request(body, self.authority.fresh_time(0)?)?;
        if proof.owner_id() != self.identity.owner_id()
            || proof.owner_epoch() != self.identity.owner_epoch()
            || proof.transport_key_fingerprint() != self.identity.key_fingerprint()
        {
            return Err(fail());
        }
        Ok(())
    }
    pub async fn execute(
        &self,
        proof: &AuthenticatedNativeLive,
        body: &[u8],
    ) -> Result<NativeLiveAuthorityResponse, GatewayError> {
        self.proof(proof, body)?;
        match NativeLiveAuthorityRequest::parse(body)? {
            NativeLiveAuthorityRequest::Authorize {
                action_ref,
                connection_id,
                ..
            } => {
                self.authorize(proof, body, &action_ref, &connection_id)
                    .await
            }
            NativeLiveAuthorityRequest::Recheck {
                action_ref,
                connection_id,
                authorization_ref,
                ..
            } => {
                self.recheck(proof, body, &action_ref, &connection_id, &authorization_ref)
                    .await
            }
            NativeLiveAuthorityRequest::Retire {
                action_ref,
                connection_id,
                authorization_ref,
                upstream_status,
                ..
            } => {
                let outcome = self
                    .retire(
                        proof,
                        body,
                        &action_ref,
                        &connection_id,
                        &authorization_ref,
                        upstream_status,
                    )
                    .await?;
                Ok(NativeLiveAuthorityResponse::Retire { v: 1, outcome })
            }
        }
    }
    async fn authorize(
        &self,
        proof: &AuthenticatedNativeLive,
        body: &[u8],
        action_ref: &str,
        connection_id: &str,
    ) -> Result<NativeLiveAuthorityResponse, GatewayError> {
        for _ in 0..5 {
            self.proof(proof, body)?;
            let mut tx = self.authority.transaction(self.authority.fresh_time(0)?)?;
            let action: ActionRow = tx
                .read(&custody_key("action", action_ref))
                .await?
                .ok_or_else(fail)?;
            if action.action_ref != action_ref {
                return Err(fail());
            }
            let (fence, access) = self.current(&mut tx, &action).await?;
            let key = custody_key("connection", connection_id);
            let existing: Option<ConnectionRow> = tx.read(&key).await?;
            let connection = if let Some(connection) = existing {
                self.connection(&connection, action_ref, connection_id, None)?;
                if connection.upstream_status.is_some() || connection.retired {
                    return Err(fail());
                }
                connection
            } else {
                ConnectionRow {
                    v: 1,
                    action_ref: action_ref.into(),
                    connection_id: connection_id.into(),
                    authorization_ref: self.authority.tokens.next_token()?,
                    owner_id: self.identity.owner_id().into(),
                    owner_epoch: self.identity.owner_epoch().into(),
                    key_fingerprint: self.identity.key_fingerprint().into(),
                    call_id: action.call_id,
                    created_at_ms: tx.now,
                    upstream_status: None,
                    retired: false,
                }
            };
            tx.put(&key, &connection, None)?;
            self.proof(proof, body)?;
            if tx.commit().await? {
                return Ok(NativeLiveAuthorityResponse::Authorize {
                    v: 1,
                    authorization_ref: connection.authorization_ref,
                    fence,
                    access,
                });
            }
        }
        Err(conflict())
    }
    fn connection(
        &self,
        row: &ConnectionRow,
        action: &str,
        connection: &str,
        authorization: Option<&str>,
    ) -> Result<(), GatewayError> {
        if row.v != 1
            || row.action_ref != action
            || row.connection_id != connection
            || authorization.is_some_and(|r| r != row.authorization_ref)
            || row.owner_id != self.identity.owner_id()
            || row.owner_epoch != self.identity.owner_epoch()
            || row.key_fingerprint != self.identity.key_fingerprint()
        {
            return Err(fail());
        }
        Ok(())
    }
    async fn recheck(
        &self,
        proof: &AuthenticatedNativeLive,
        body: &[u8],
        action_ref: &str,
        connection_id: &str,
        authorization_ref: &str,
    ) -> Result<NativeLiveAuthorityResponse, GatewayError> {
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.authority.fresh_time(0)?)?;
            let connection: ConnectionRow = tx
                .read(&custody_key("connection", connection_id))
                .await?
                .ok_or_else(fail)?;
            self.connection(
                &connection,
                action_ref,
                connection_id,
                Some(authorization_ref),
            )?;
            if connection.upstream_status.is_some() || connection.retired {
                return Err(fail());
            }
            let action: ActionRow = tx
                .read(&custody_key("action", action_ref))
                .await?
                .ok_or_else(fail)?;
            if action.action_ref != action_ref || action.call_id != connection.call_id {
                return Err(fail());
            }
            let (fence, access) = self.current(&mut tx, &action).await?;
            self.proof(proof, body)?;
            if tx.commit().await? {
                return Ok(NativeLiveAuthorityResponse::Recheck {
                    v: 1,
                    fence,
                    access,
                });
            }
        }
        Err(conflict())
    }
    async fn retire(
        &self,
        proof: &AuthenticatedNativeLive,
        body: &[u8],
        action_ref: &str,
        connection_id: &str,
        authorization_ref: &str,
        status: u16,
    ) -> Result<NativeLiveRetirement, GatewayError> {
        let connection_key = custody_key("connection", connection_id);
        let mut call = None;
        for _ in 0..5 {
            self.proof(proof, body)?;
            let mut tx = self.authority.transaction(self.authority.fresh_time(0)?)?;
            let mut row: ConnectionRow = tx.read(&connection_key).await?.ok_or_else(fail)?;
            self.connection(&row, action_ref, connection_id, Some(authorization_ref))?;
            if row.upstream_status.is_some_and(|s| s != status) {
                return Err(fail());
            }
            if row.retired {
                return Ok(NativeLiveRetirement::Retired);
            }
            // Genuine prior-effect cleanup does not need current actor, mapping or credentials.
            let marker = mapping_key(&row.call_id, true);
            let prior: Option<Value> = tx.read(&marker).await?;
            if prior.as_ref().is_some_and(|v| {
                v["schema_version"] != 1
                    || v["call_id"] != row.call_id
                    || !matches!(v["upstream_status"].as_u64(), Some(404 | 410))
            }) {
                return Ok(NativeLiveRetirement::Unknown);
            }
            row.upstream_status = Some(status);
            tx.put(&connection_key, &row, None)?;
            if prior.is_none() {
                tx.put(&marker,&serde_json::json!({"schema_version":1,"call_id":row.call_id,"upstream_status":status,"created_at_ms":tx.now}),None)?;
            }
            match tx.commit().await {
                Ok(true) => {
                    call = Some(row.call_id);
                    break;
                }
                Ok(false) => {}
                Err(_) => return Ok(NativeLiveRetirement::Unknown),
            }
        }
        let Some(call) = call else {
            return Ok(NativeLiveRetirement::Pending);
        };
        // Source deletion is unconditional, including a newer mapping of the same call ID.
        if self
            .authority
            .store
            .commit(AtomicTransition {
                checks: vec![],
                mutations: vec![RecordMutation::Delete {
                    key: mapping_key(&call, false),
                }],
            })
            .await
            != Ok(CommitOutcome::Committed)
        {
            return Ok(NativeLiveRetirement::Pending);
        }
        let mut tx = self.authority.transaction(self.authority.fresh_time(0)?)?;
        let marker = mapping_key(&call, true);
        let _: Option<Value> = tx.read(&marker).await?;
        let mut row: ConnectionRow = tx.read(&connection_key).await?.ok_or_else(fail)?;
        self.connection(&row, action_ref, connection_id, Some(authorization_ref))?;
        row.retired = true;
        tx.put(&connection_key, &row, None)?;
        tx.delete(&marker)?;
        match tx.commit().await {
            Ok(true) => Ok(NativeLiveRetirement::Retired),
            _ => Ok(NativeLiveRetirement::Pending),
        }
    }
}
fn fail() -> GatewayError {
    GatewayError::new(
        403,
        "Current native live authority is unavailable.",
        Some("native_live_authority_stale"),
    )
}
fn missing() -> GatewayError {
    GatewayError::new(
        404,
        "Live call mapping is unavailable.",
        Some("live_call_not_found"),
    )
}
fn conflict() -> GatewayError {
    GatewayError::new(
        409,
        "Live authority changed concurrently.",
        Some("native_live_conflict"),
    )
}

/// Offline migration validator. These rows remain private custody and never source credentials.
pub fn validate_live_custody(
    kind: &str,
    reference: &str,
    value: &Value,
) -> Result<(), GatewayError> {
    if !wire::reference(reference) {
        return Err(fail());
    }
    match kind {
        "action" => {
            let row: ActionRow = serde_json::from_value(value.clone()).map_err(|_| fail())?;
            if row.v != 1
                || row.action_ref != reference
                || row.request_id.is_empty()
                || row.account_id.is_empty()
                || row.call_id.is_empty()
                || row.mapping_revision.is_empty()
                || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&row.created_at_ms)
                || row.actor.principal().is_empty()
            {
                return Err(fail());
            }
        }
        "connection" => {
            let row: ConnectionRow = serde_json::from_value(value.clone()).map_err(|_| fail())?;
            if row.v != 1
                || row.connection_id != reference
                || !wire::reference(&row.action_ref)
                || !wire::reference(&row.authorization_ref)
                || row.owner_id.is_empty()
                || row.owner_epoch.is_empty()
                || row.key_fingerprint.len() != 64
                || row.call_id.is_empty()
                || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&row.created_at_ms)
                || row.upstream_status.is_some_and(|s| s != 404 && s != 410)
                || (row.retired && row.upstream_status.is_none())
            {
                return Err(fail());
            }
        }
        _ => return Err(fail()),
    }
    Ok(())
}
