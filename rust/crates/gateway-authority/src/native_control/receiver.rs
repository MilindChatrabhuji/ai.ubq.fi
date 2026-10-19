use super::{
    NativeRenewalAction, NativeRenewalCancellation, NativeRenewalClaim, NativeRenewalControl,
    NativeRenewalFence, NativeRenewalMode, NativeRenewalPublished, OWNER_RENEWAL_MAX_MS, facts,
    rows::{self, ActionRow, Actor, OperationRow, Phase, conflict, fail},
};
use crate::{Authority, TokenSource, add, store::Transaction, text};
use gateway_auth::{
    AuthConfig, AuthHost, AuthMethod, AuthRequest, AuthService,
    crypto::sha256_hex,
    native::NATIVE_CONTROL_PATH,
    native_auth::{AuthenticatedNativeOwner, NativeCapability, NativeTransportIdentity},
    native_control::{NativeControlEnvelope, NativeControlRequest},
};
use gateway_core::{GatewayError, state::AuthorityStore};

/// Registry construction is a host operation; no request may select a native home.
pub struct RegisteredRenewalOwner {
    id: String,
    pub(super) home: String,
}
impl RegisteredRenewalOwner {
    pub fn configured(id: String, home: String) -> Result<Self, GatewayError> {
        text(&id)?;
        if !std::path::Path::new(&home).is_absolute() {
            return Err(fail());
        }
        Ok(Self { id, home })
    }
    pub fn native_owner_id(&self) -> &str {
        &self.id
    }
}

pub struct NativeRenewalAuthority<'a, S, I, C> {
    pub(super) authority: &'a Authority<S, I>,
    pub(super) identity: &'a NativeTransportIdentity,
    pub(super) registered: &'a RegisteredRenewalOwner,
    pub(super) cancellation: &'a C,
}
impl<'a, S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'a, S, I, C>
{
    pub fn configured(
        authority: &'a Authority<S, I>,
        identity: &'a NativeTransportIdentity,
        registered: &'a RegisteredRenewalOwner,
        cancellation: &'a C,
    ) -> Self {
        Self {
            authority,
            identity,
            registered,
            cancellation,
        }
    }
    fn time(&self, anchor: i64) -> Result<i64, GatewayError> {
        if self.cancellation.cancelled() {
            return Err(GatewayError::new(
                499,
                "Native renewal was cancelled.",
                Some("request_cancelled"),
            ));
        }
        self.authority.fresh_time(anchor)
    }
    pub(super) async fn current(
        &self,
        tx: &mut Transaction<'_, S, I>,
        row: &ActionRow,
    ) -> Result<facts::Facts, GatewayError> {
        let now = self.time(row.created_at_ms)?;
        if row.v != 1
            || now >= row.deadline_ms
            || row.deadline_ms > add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
        {
            return Err(fail());
        }
        tx.now = now;
        let current = facts::read(
            tx,
            &row.actor,
            &row.fence.original_request_id,
            Some(&row.attempt_id),
            self.identity,
            self.registered,
        )
        .await?;
        tx.now = self.time(tx.now)?;
        if tx.now >= row.deadline_ms
            || current.fence != row.fence
            || current.checks_digest != row.checks_digest
        {
            return Err(fail());
        }
        Ok(current)
    }
    pub(super) async fn action(
        &self,
        tx: &mut Transaction<'_, S, I>,
        reference: &str,
    ) -> Result<ActionRow, GatewayError> {
        text(reference)?;
        let action: ActionRow = tx
            .read(&rows::key("action", reference))
            .await?
            .ok_or_else(fail)?;
        if action.action_ref != reference {
            return Err(fail());
        }
        Ok(action)
    }
    /// The fixed authenticated reverse receiver resolves a capability selector, never deserializes one.
    /// A fresh start additionally needs the one-time opaque permit, whose digest alone is durable.
    pub async fn resolve_claim(
        &self,
        operation_id: &str,
        claim_ref: &str,
        start_permit: Option<&str>,
    ) -> Result<NativeRenewalClaim, GatewayError> {
        text(operation_id)?;
        text(claim_ref)?;
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let row: OperationRow = tx
                .read(&rows::key("operation", operation_id))
                .await?
                .ok_or_else(fail)?;
            if row.v != 1 || row.operation_id != operation_id || row.claim_ref != claim_ref {
                return Err(conflict());
            }
            let action = self.action(&mut tx, &row.action_ref).await?;
            if action.operation_id.as_deref() != Some(operation_id) {
                return Err(conflict());
            }
            self.current(&mut tx, &action).await?;
            let fresh = row.phase == Phase::Claimed
                && start_permit.is_some_and(|p| sha256_hex(p.as_bytes()) == row.start_digest);
            if start_permit.is_some() && !fresh {
                return Err(conflict());
            }
            if tx.commit().await? {
                return Ok(NativeRenewalClaim {
                    claim_ref: claim_ref.into(),
                    operation_id: operation_id.into(),
                    action: NativeRenewalAction {
                        action_ref: action.action_ref,
                        deadline_ms: action.deadline_ms,
                        fence: action.fence,
                    },
                    mode: if fresh {
                        NativeRenewalMode::RenewOnce
                    } else {
                        NativeRenewalMode::ReconcileOnly
                    },
                    start_permit: start_permit.map(str::to_owned),
                });
            }
        }
        Err(conflict())
    }
    pub(super) async fn operation(
        &self,
        tx: &mut Transaction<'_, S, I>,
        claim: &NativeRenewalClaim,
    ) -> Result<(ActionRow, OperationRow), GatewayError> {
        let action = self.action(tx, claim.action.action_ref()).await?;
        let operation: OperationRow = tx
            .read(&rows::key("operation", &claim.operation_id))
            .await?
            .ok_or_else(fail)?;
        if operation.v != 1
            || operation.operation_id != claim.operation_id
            || operation.action_ref != action.action_ref
            || operation.claim_ref != claim.claim_ref
            || action.operation_id.as_ref() != Some(&claim.operation_id)
            || action.fence != claim.action.fence
        {
            return Err(conflict());
        }
        Ok((action, operation))
    }

    /// Only the originating trusted Worker calls this with its already-selected request identity.
    /// AuthService reauthenticates against this exact store. Reverse calls never receive that request.
    pub async fn authenticate_and_prepare<H: AuthHost>(
        &self,
        host: &H,
        config: &AuthConfig,
        request: &AuthRequest,
        request_id: &str,
    ) -> Result<NativeRenewalAction, GatewayError> {
        text(request_id)?;
        self.time(0)?;
        let principal = AuthService::new(self.authority.store(), host, config)
            .authenticate_client(request)
            .await?;
        let actor = match principal.method {
            AuthMethod::KvApiKey { key_id, policy } => Actor::ApiKey {
                key_id,
                token_hash: policy.token_hash,
            },
            AuthMethod::AuthTokensAllowlist => Actor::Configuration {
                principal: "auth-method:auth_tokens_allowlist".into(),
            },
            AuthMethod::AdminAllowlist => Actor::Configuration {
                principal: "auth-method:admin_allowlist".into(),
            },
            AuthMethod::DenoDeployToken => Actor::Configuration {
                principal: "auth-method:deno_deploy_token".into(),
            },
            AuthMethod::Disabled => Actor::Configuration {
                principal: principal
                    .token
                    .as_ref()
                    .map(|v| format!("bearer-sha256:{}", sha256_hex(v.expose().as_bytes())))
                    .unwrap_or_else(|| "local-auth-disabled".into()),
            },
            // The separate auth owner must supply a revocation-aware secretless session index.
            AuthMethod::PasskeySession { .. } => {
                return Err(GatewayError::unavailable(
                    "Current secretless session authority is not installed.",
                    "native_session_fence_unavailable",
                ));
            }
            AuthMethod::GithubToken { .. } => {
                return Err(GatewayError::unavailable(
                    "Current kernel request authority is not bound.",
                    "native_kernel_fence_unavailable",
                ));
            }
        };
        for _ in 0..5 {
            let now = self.time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let current = facts::read(
                &mut tx,
                &actor,
                request_id,
                None,
                self.identity,
                self.registered,
            )
            .await?;
            let reference = facts::digest(&(
                "uos-native-renewal-action-v1",
                request_id,
                &current.attempt_id,
                &current.fence.source_native_generation,
            ))?;
            let key = rows::key("action", &reference);
            let existing: Option<ActionRow> = tx.read(&key).await?;
            let row = if let Some(row) = existing {
                if row.actor != actor
                    || row.fence != current.fence
                    || row.checks_digest != current.checks_digest
                {
                    return Err(conflict());
                }
                row
            } else {
                let row = ActionRow {
                    v: 1,
                    action_ref: reference.clone(),
                    actor: actor.clone(),
                    attempt_id: current.attempt_id,
                    created_at_ms: now,
                    deadline_ms: add(now, OWNER_RENEWAL_MAX_MS)?,
                    fence: current.fence,
                    checks_digest: current.checks_digest,
                    account_digests: current.account_digests,
                    operation_id: None,
                };
                // Retention is conservative: no unknown operation can disappear into a new rotation grant.
                tx.put(&key, &row, None)?;
                row
            };
            self.current(&mut tx, &row).await?;
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
}

impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation> NativeRenewalControl
    for NativeRenewalAuthority<'_, S, I, C>
{
    async fn claim(
        &self,
        proof: &AuthenticatedNativeOwner,
        reference: &str,
        operation_id: &str,
        exact_body: &[u8],
    ) -> Result<NativeRenewalClaim, GatewayError> {
        let now = self.time(0)?;
        proof.require_request(
            NativeCapability::OwnerRenewal,
            NATIVE_CONTROL_PATH,
            exact_body,
            now,
        )?;
        if proof.owner_id() != self.identity.owner_id()
            || proof.owner_epoch() != self.identity.owner_epoch()
            || proof.transport_key_fingerprint() != self.identity.key_fingerprint()
        {
            return Err(fail());
        }
        let body = NativeControlEnvelope::parse(exact_body)?;
        let NativeControlRequest::CodexRenewAccess { action_ref } = body.request;
        if body.operation_id != operation_id || action_ref != reference {
            return Err(conflict());
        }
        let digest = sha256_hex(exact_body);
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(now)?)?;
            let mut action = self.action(&mut tx, reference).await?;
            self.current(&mut tx, &action).await?;
            if action
                .operation_id
                .as_ref()
                .is_some_and(|id| id != operation_id)
            {
                return Err(conflict());
            }
            let key = rows::key("operation", operation_id);
            let existing: Option<OperationRow> = tx.read(&key).await?;
            let (operation, mode, start_permit) = if let Some(row) = existing {
                if row.v != 1
                    || row.action_ref != reference
                    || row.operation_id != operation_id
                    || row.request_digest != digest
                {
                    return Err(conflict());
                }
                (row, NativeRenewalMode::ReconcileOnly, None)
            } else {
                let permit = self.authority.tokens.next_token()?;
                text(&permit)?;
                let row = OperationRow {
                    v: 1,
                    action_ref: reference.into(),
                    operation_id: operation_id.into(),
                    request_digest: digest.clone(),
                    claim_ref: self.authority.tokens.next_token()?,
                    start_digest: sha256_hex(permit.as_bytes()),
                    phase: Phase::Claimed,
                    publication_revision: None,
                    native_source_generation: None,
                    access_generation: None,
                };
                tx.put(&key, &row, None)?;
                (row, NativeRenewalMode::RenewOnce, Some(permit))
            };
            if action.operation_id.is_none() {
                action.operation_id = Some(operation_id.into());
                tx.put(&rows::key("action", reference), &action, None)?;
            }
            self.current(&mut tx, &action).await?;
            if tx.commit().await? {
                return Ok(NativeRenewalClaim {
                    claim_ref: operation.claim_ref,
                    operation_id: operation_id.into(),
                    action: NativeRenewalAction {
                        action_ref: reference.into(),
                        deadline_ms: action.deadline_ms,
                        fence: action.fence,
                    },
                    mode,
                    start_permit,
                });
            }
        }
        Err(conflict())
    }
    async fn start(
        &self,
        claim: &mut NativeRenewalClaim,
    ) -> Result<NativeRenewalMode, GatewayError> {
        let can_start = claim.mode == NativeRenewalMode::RenewOnce;
        claim.mode = NativeRenewalMode::ReconcileOnly;
        let permit = claim.start_permit.take();
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let (action, mut operation) = self.operation(&mut tx, claim).await?;
            self.current(&mut tx, &action).await?;
            if !can_start
                || operation.phase != Phase::Claimed
                || permit
                    .as_ref()
                    .is_none_or(|p| sha256_hex(p.as_bytes()) != operation.start_digest)
            {
                return Ok(NativeRenewalMode::ReconcileOnly);
            }
            operation.phase = Phase::Started;
            tx.put(
                &rows::key("operation", &claim.operation_id),
                &operation,
                None,
            )?;
            self.current(&mut tx, &action).await?;
            if tx.commit().await? {
                return Ok(NativeRenewalMode::RenewOnce);
            }
        }
        Err(conflict())
    }
    async fn recheck(
        &self,
        claim: &NativeRenewalClaim,
    ) -> Result<NativeRenewalFence, GatewayError> {
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let (action, _) = self.operation(&mut tx, claim).await?;
            let current = self.current(&mut tx, &action).await?;
            if tx.commit().await? {
                return Ok(current.fence);
            }
        }
        Err(conflict())
    }
    async fn published(
        &self,
        claim: &NativeRenewalClaim,
        revision: &str,
    ) -> Result<NativeRenewalPublished, GatewayError> {
        text(revision)?;
        // Managed publication atomically records its terminal proof. A bare RPC success cannot do so.
        let mut tx = self.authority.transaction(self.time(0)?)?;
        let (action, operation) = self.operation(&mut tx, claim).await?;
        if operation.phase != Phase::Published
            || operation.publication_revision.as_deref() != Some(revision)
        {
            return Err(fail());
        }
        self.current(&mut tx, &action).await?;
        if !tx.commit().await? {
            return Err(conflict());
        }
        Ok(NativeRenewalPublished {
            publication_revision: revision.into(),
        })
    }
    async fn unknown(&self, claim: &NativeRenewalClaim) -> Result<(), GatewayError> {
        for _ in 0..5 {
            // Conservative uncertainty can be recorded after cancellation or deadline loss.
            let mut tx = self.authority.transaction(self.authority.fresh_time(0)?)?;
            let (_, mut operation) = self.operation(&mut tx, claim).await?;
            if operation.phase == Phase::Published {
                return Ok(());
            }
            operation.phase = Phase::Unknown;
            tx.put(
                &rows::key("operation", &claim.operation_id),
                &operation,
                None,
            )?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(conflict())
    }
}
