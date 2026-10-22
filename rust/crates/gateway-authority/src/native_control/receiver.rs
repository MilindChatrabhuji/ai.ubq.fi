use super::{
    NativeRenewalAction, NativeRenewalCancellation, NativeRenewalClaim, NativeRenewalControl,
    NativeRenewalFence, NativeRenewalMode, NativeRenewalPublished, OWNER_RENEWAL_MAX_MS, facts,
    rows::{self, ActionRow, GenerationEffect, OperationRow, Phase, conflict, fail},
};
use crate::{Authority, TokenSource, add, store::Transaction, text};
use gateway_auth::{
    AuthConfig, AuthHost, AuthRequest,
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
        // Worker validates a configured native POSIX resource name, not its own
        // filesystem. wasm32-unknown-unknown Path::is_absolute always refuses it.
        // Actual native filesystem/custody enforcement remains separately owned.
        #[cfg(target_arch = "wasm32")]
        let absolute = home.starts_with('/');
        #[cfg(not(target_arch = "wasm32"))]
        let absolute = std::path::Path::new(&home).is_absolute();
        if !absolute {
            return Err(fail());
        }
        Ok(Self { id, home })
    }
    pub fn native_owner_id(&self) -> &str {
        &self.id
    }
    /// Read-only configured native mapping, never a caller-selected path or permission.
    pub fn registered_home(&self) -> &str {
        &self.home
    }
}

pub struct NativeRenewalAuthority<'a, S, I, C> {
    pub(super) authority: &'a Authority<S, I>,
    pub(super) identity: &'a NativeTransportIdentity,
    pub(super) registered: &'a RegisteredRenewalOwner,
    pub(super) current_config: &'a AuthConfig,
    pub(super) cancellation: &'a C,
}
impl<'a, S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'a, S, I, C>
{
    pub fn configured(
        authority: &'a Authority<S, I>,
        identity: &'a NativeTransportIdentity,
        registered: &'a RegisteredRenewalOwner,
        current_config: &'a AuthConfig,
        cancellation: &'a C,
    ) -> Self {
        Self {
            authority,
            identity,
            registered,
            current_config,
            cancellation,
        }
    }
    pub(super) fn time(&self, anchor: i64) -> Result<i64, GatewayError> {
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
        if row.v != 2
            || now >= row.deadline_ms
            || row.deadline_ms > add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
        {
            return Err(fail());
        }
        tx.now = now;
        let current = self
            .read_context(
                tx,
                &row.actor,
                &row.fence.original_request_id,
                &row.fence.context,
            )
            .await?;
        tx.now = self.time(tx.now)?;
        super::actor::validate_current_time(&row.actor, tx.now)?;
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
            .read_source_control(&rows::key("action", reference))
            .await?
            .ok_or_else(fail)?;
        if action.action_ref != reference
            || action.v != 2
            || action.fence.v != super::NATIVE_RENEWAL_FENCE_VERSION
        {
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
            if let Some(terminal) = &row.terminal {
                self.verify_terminal(&mut tx, &action, terminal).await?;
            } else {
                self.current(&mut tx, &action).await?;
            }
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
                    publication_revision: row.publication_revision,
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

    /// A signed native response alone cannot publish credentials into the Worker.
    pub async fn verify_action_publication(
        &self,
        action: &NativeRenewalAction,
        operation_id: &str,
        publication_revision: &str,
    ) -> Result<NativeRenewalFence, GatewayError> {
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let row = self.action(&mut tx, action.action_ref()).await?;
            let operation: OperationRow = tx
                .read(&rows::key("operation", operation_id))
                .await?
                .ok_or_else(fail)?;
            if row.fence != *action.fence()
                || row.operation_id.as_deref() != Some(operation_id)
                || operation.v != 1
                || operation.operation_id != operation_id
                || operation.action_ref != row.action_ref
                || operation.phase != Phase::Published
                || operation.publication_revision.as_deref() != Some(publication_revision)
            {
                return Err(fail());
            }
            let terminal = operation.terminal.as_ref().ok_or_else(fail)?;
            let fence = self.verify_terminal(&mut tx, &row, terminal).await?;
            if tx.commit().await? {
                return Ok(fence);
            }
        }
        Err(conflict())
    }

    /// Existing routing convenience; all permission comes from actual original AuthService minting.
    pub async fn authenticate_and_prepare<H: AuthHost>(
        &self,
        host: &H,
        config: &AuthConfig,
        request: &AuthRequest,
        request_id: &str,
    ) -> Result<NativeRenewalAction, GatewayError> {
        let mut tx = self.authority.transaction(self.time(0)?)?;
        let context = facts::session_context(&mut tx, request_id).await?;
        if context.request_id.0 != request_id {
            return Err(fail());
        }
        let actor = super::actor::authenticate_client_actor(
            self.authority,
            host,
            config,
            request,
            &context,
        )
        .await?;
        self.prepare_routing(&actor).await
    }
    pub async fn prepare_routing(
        &self,
        actor: &super::actor::NativeRenewalActor,
    ) -> Result<NativeRenewalAction, GatewayError> {
        let request_id = &actor.context().request_id.0;
        for _ in 0..5 {
            let now = self.time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let context = facts::session_context(&mut tx, request_id).await?;
            if &context != actor.context() {
                return Err(fail());
            }
            let current = facts::read(
                &mut tx,
                actor.stored(),
                request_id,
                None,
                self.identity,
                self.current_config,
                self.registered,
            )
            .await?;
            if current.fence.principal_policy_digest != actor.policy_digest() {
                return Err(fail());
            }
            let reference = facts::digest(&(
                "uos-native-renewal-action-v2",
                request_id,
                &current.fence.context,
                &current.fence.source_native_generation,
            ))?;
            let key = rows::key("action", &reference);
            let existing: Option<ActionRow> = tx.read_source_control(&key).await?;
            let row = if let Some(row) = existing {
                if row.actor != *actor.stored()
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
                    deadline_ms: add(now, OWNER_RENEWAL_MAX_MS)?,
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
            tx.now = self.time(tx.now)?;
            super::actor::validate_current_time(&row.actor, tx.now)?;
            if tx.now >= row.deadline_ms {
                return Err(fail());
            }
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
            if action
                .operation_id
                .as_ref()
                .is_some_and(|id| id != operation_id)
            {
                return Err(conflict());
            }
            let key = rows::key("operation", operation_id);
            let existing: Option<OperationRow> = tx.read(&key).await?;
            let generation_key = rows::generation_key(&action.fence)?;
            let generation: Option<GenerationEffect> = tx.read(&generation_key).await?;
            if generation.as_ref().is_some_and(|g| g.v != 1) {
                return Err(fail());
            }
            let (operation, mode, start_permit) = if let Some(mut row) = existing {
                if row.v != 1
                    || row.action_ref != reference
                    || row.operation_id != operation_id
                    || row.request_digest != digest
                    || generation.is_none()
                {
                    return Err(conflict());
                }
                let terminal = row
                    .terminal
                    .clone()
                    .or_else(|| generation.as_ref().and_then(|g| g.terminal.clone()));
                if let Some(terminal) = terminal {
                    self.verify_terminal(&mut tx, &action, &terminal).await?;
                    if row.terminal.is_none() {
                        row.phase = Phase::Published;
                        row.publication_revision = Some(terminal.publication_revision.clone());
                        row.terminal = Some(terminal);
                        tx.put(&key, &row, None)?;
                    }
                } else {
                    self.current(&mut tx, &action).await?;
                }
                (row, NativeRenewalMode::ReconcileOnly, None)
            } else {
                self.current(&mut tx, &action).await?;
                let permit = self.authority.tokens.next_token()?;
                text(&permit)?;
                let fresh = generation.is_none();
                let row = OperationRow {
                    v: 1,
                    action_ref: reference.into(),
                    operation_id: operation_id.into(),
                    request_digest: digest.clone(),
                    claim_ref: self.authority.tokens.next_token()?,
                    start_digest: sha256_hex(permit.as_bytes()),
                    phase: if fresh {
                        Phase::Claimed
                    } else {
                        Phase::Unknown
                    },
                    publication_revision: None,
                    native_source_generation: None,
                    access_generation: None,
                    terminal: None,
                };
                tx.put(&key, &row, None)?;
                if fresh {
                    tx.put(
                        &generation_key,
                        &GenerationEffect {
                            v: 1,
                            operation_id: operation_id.into(),
                            claim_ref: row.claim_ref.clone(),
                            publication_revision: None,
                            terminal: None,
                        },
                        None,
                    )?;
                }
                (
                    row,
                    if fresh {
                        NativeRenewalMode::RenewOnce
                    } else {
                        NativeRenewalMode::ReconcileOnly
                    },
                    fresh.then_some(permit),
                )
            };
            if action.operation_id.is_none() {
                action.operation_id = Some(operation_id.into());
                tx.put_source_control(&rows::key("action", reference), &action, None)?;
            }
            if let Some(terminal) = &operation.terminal {
                self.verify_terminal(&mut tx, &action, terminal).await?;
            } else {
                self.current(&mut tx, &action).await?;
            }
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
                    publication_revision: operation.publication_revision,
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
            let generation: GenerationEffect = tx
                .read(&rows::generation_key(&action.fence)?)
                .await?
                .ok_or_else(fail)?;
            if !can_start
                || operation.phase != Phase::Claimed
                || generation.v != 1
                || generation.operation_id != claim.operation_id
                || generation.claim_ref != claim.claim_ref
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
            let (action, operation) = self.operation(&mut tx, claim).await?;
            let fence = if let Some(terminal) = &operation.terminal {
                self.verify_terminal(&mut tx, &action, terminal).await?
            } else {
                self.current(&mut tx, &action).await?.fence
            };
            if tx.commit().await? {
                return Ok(fence);
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
        let terminal = operation.terminal.as_ref().ok_or_else(fail)?;
        self.verify_terminal(&mut tx, &action, terminal).await?;
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

#[cfg(test)]
mod registered_home_tests {
    use super::RegisteredRenewalOwner;

    #[test]
    fn native_registered_home_keeps_absolute_syntax_and_rejects_relative_metadata() {
        assert!(
            RegisteredRenewalOwner::configured("owner".into(), "/tmp/native-profile".into())
                .is_ok()
        );
        for home in ["relative-profile", "./profile", "../profile", ""] {
            assert!(RegisteredRenewalOwner::configured("owner".into(), home.into()).is_err());
        }
    }
}
