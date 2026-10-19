//! One actual admin/source-bound import preparation. No body/digest is persisted.
use super::{
    NativeRenewalAuthority, NativeRenewalCancellation, OWNER_RENEWAL_MAX_MS,
    actor::{self, NativeActorScope, NativeRenewalActor, StoredNativeActor},
    rows,
};
use crate::TokenSource;
use gateway_auth::native_import::{
    NativeImportAdmission, NativeImportKind, NativeImportMetadata, NativeImportTarget,
    VerifiedNativeImportBody,
};
use gateway_core::{GatewayError, state::AuthorityStore};
use serde::{Deserialize, Serialize};
mod sources;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ImportActionRow {
    v: u8,
    kind: NativeImportKind,
    metadata: NativeImportMetadata,
    target: NativeImportTarget,
    actor: StoredNativeActor,
    context: gateway_core::identity::RequestContext,
    created_at_ms: i64,
    deadline_ms: i64,
    facts: sources::ImportFacts,
}
pub struct PreparedNativeImport {
    row: ImportActionRow,
}
impl PreparedNativeImport {
    pub fn metadata(&self) -> &NativeImportMetadata {
        &self.row.metadata
    }
    pub fn target(&self) -> &NativeImportTarget {
        &self.row.target
    }
    pub fn deadline_ms(&self) -> i64 {
        self.row.deadline_ms
    }
}
pub struct AdmittedNativeImport {
    admission: NativeImportAdmission,
    row: ImportActionRow,
}
/// An observed-current original action plus exact authenticated native document.
/// ```compile_fail
/// use gateway_authority::native_control::import::AuthenticatedNativeImport;
/// let forged:AuthenticatedNativeImport=serde_json::from_str("{}").unwrap();
/// ```
pub struct AuthenticatedNativeImport {
    body: VerifiedNativeImportBody,
    row: ImportActionRow,
}
impl AuthenticatedNativeImport {
    pub fn metadata(&self) -> &NativeImportMetadata {
        &self.row.metadata
    }
    pub fn target(&self) -> &NativeImportTarget {
        &self.row.target
    }
    pub fn deadline_ms(&self) -> i64 {
        self.row.deadline_ms
    }
    pub fn require_body(&self, body: &[u8], now: i64) -> Result<(), GatewayError> {
        if now >= self.row.deadline_ms {
            return Err(unavailable());
        }
        self.body.require_body(body, now)
    }
}
impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    pub async fn prepare_import(
        &self,
        actor: &NativeRenewalActor,
        target: NativeImportTarget,
    ) -> Result<PreparedNativeImport, GatewayError> {
        target.validate()?;
        if actor.scope() != NativeActorScope::Admin {
            return Err(unavailable());
        }
        for _ in 0..5 {
            let now = self.time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let current = sources::read(self, &mut tx, actor.stored(), &target).await?;
            let reference = super::facts::digest(&(
                "uos-native-import-action-v1",
                actor.context(),
                actor.policy_digest(),
                &target,
                &current,
            ))?;
            let key = rows::key("action", &reference);
            let prior: Option<ImportActionRow> = tx.read_source_control(&key).await?;
            let row = if let Some(row) = prior {
                if row.v != 1
                    || row.actor != *actor.stored()
                    || row.context != *actor.context()
                    || row.target != target
                    || row.facts != current
                {
                    return Err(unavailable());
                }
                row
            } else {
                let metadata = NativeImportMetadata {
                    v: 1,
                    operation_id: self.authority.tokens.next_token()?,
                    action_ref: reference.clone(),
                };
                metadata.validate()?;
                let row = ImportActionRow {
                    v: 1,
                    kind: target.kind(),
                    metadata,
                    target: target.clone(),
                    actor: actor.stored().clone(),
                    context: actor.context().clone(),
                    created_at_ms: now,
                    deadline_ms: crate::add(now, OWNER_RENEWAL_MAX_MS)?,
                    facts: current,
                };
                tx.put_source_control(&key, &row, None)?;
                row
            };
            row.metadata.validate()?;
            if row.metadata.action_ref != reference
                || now < row.created_at_ms
                || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
            {
                return Err(unavailable());
            }
            actor.bind_preparation(&mut tx).await?;
            tx.now = self.time(tx.now)?;
            actor::validate_current_time(&row.actor, tx.now)?;
            if tx.now >= row.deadline_ms {
                return Err(unavailable());
            }
            if tx.commit().await? {
                let now = self.time(now)?;
                actor::validate_current_time(&row.actor, now)?;
                if now >= row.deadline_ms {
                    return Err(unavailable());
                }
                return Ok(PreparedNativeImport { row });
            }
        }
        Err(unavailable())
    }
    async fn current_import(
        &self,
        metadata: &NativeImportMetadata,
        expected: Option<&ImportActionRow>,
    ) -> Result<ImportActionRow, GatewayError> {
        metadata.validate()?;
        for _ in 0..5 {
            let now = self.time(0)?;
            let mut tx = self.authority.transaction(now)?;
            let row: ImportActionRow = tx
                .read_source_control(&rows::key("action", &metadata.action_ref))
                .await?
                .ok_or_else(unavailable)?;
            if row.v != 1
                || row.kind != NativeImportKind::CodexAuth
                || row.kind != row.target.kind()
                || row.metadata != *metadata
                || now < row.created_at_ms
                || now >= row.deadline_ms
                || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
                || expected.is_some_and(|old| {
                    old.created_at_ms != row.created_at_ms
                        || old.deadline_ms != row.deadline_ms
                        || old.metadata != row.metadata
                        || old.target != row.target
                        || old.context != row.context
                        || old.actor != row.actor
                        || old.facts != row.facts
                })
            {
                return Err(unavailable());
            }
            let current = sources::read(self, &mut tx, &row.actor, &row.target).await?;
            if current != row.facts {
                return Err(unavailable());
            }
            tx.now = self.time(tx.now)?;
            actor::validate_current_time(&row.actor, tx.now)?;
            if tx.now >= row.deadline_ms {
                return Err(unavailable());
            }
            if tx.commit().await? {
                let now = self.time(now)?;
                actor::validate_current_time(&row.actor, now)?;
                if now >= row.deadline_ms {
                    return Err(unavailable());
                }
                return Ok(row);
            }
        }
        Err(unavailable())
    }
    pub async fn admit_import(
        &self,
        admission: NativeImportAdmission,
    ) -> Result<AdmittedNativeImport, GatewayError> {
        admission.require_owner(self.identity, self.time(0)?)?;
        let row = self.current_import(admission.metadata(), None).await?;
        if admission.kind() != row.target.kind() {
            return Err(unavailable());
        }
        admission.require_owner(self.identity, self.time(0)?)?;
        Ok(AdmittedNativeImport { admission, row })
    }
    pub async fn finish_import(
        &self,
        admitted: AdmittedNativeImport,
        original_body: &[u8],
    ) -> Result<AuthenticatedNativeImport, GatewayError> {
        let body = admitted
            .admission
            .verify_body(original_body, self.time(0)?)?;
        let row = self
            .current_import(body.metadata(), Some(&admitted.row))
            .await?;
        body.require_owner(self.identity, self.time(0)?)?;
        body.require_body(original_body, self.time(0)?)?;
        Ok(AuthenticatedNativeImport { body, row })
    }
    pub async fn recheck_import(
        &self,
        proof: &AuthenticatedNativeImport,
    ) -> Result<(), GatewayError> {
        proof.body.require_owner(self.identity, self.time(0)?)?;
        self.current_import(proof.metadata(), Some(&proof.row))
            .await?;
        proof.body.require_owner(self.identity, self.time(0)?)
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native import preparation is unavailable, changed, expired, or unsupported.",
        "native_import_authority_unavailable",
    )
}

/// DATA-ONLY exact import row validation; never reconstructs any live actor/proof.
pub(super) fn validate_custody(
    value: &gateway_core::source_json::SourceJson,
    id: &str,
) -> Result<(), GatewayError> {
    let row: ImportActionRow = value.deserialize().map_err(|_| unavailable())?;
    row.metadata.validate()?;
    row.target.validate()?;
    let NativeImportTarget::ExistingAccount { account_id_hash } = &row.target else {
        return Err(unavailable());
    };
    if row.v != 1
        || row.kind != NativeImportKind::CodexAuth
        || row.metadata.action_ref != id
        || row.facts.account_id_hash != *account_id_hash
        || row.actor.scope() != NativeActorScope::Admin
        || row.context.principal.0 != row.actor.principal()
        || row.facts.slot > gateway_core::identity::MAX_SAFE_INTEGER as u64
        || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
    {
        return Err(unavailable());
    }
    for hash in [
        id,
        account_id_hash,
        &row.facts.credential_version,
        &row.facts.native_generation,
        &row.facts.checks_digest,
    ] {
        super::custody::hash(hash)?;
    }
    for text in [
        &row.facts.owner_id,
        &row.facts.owner_epoch,
        &row.facts.native_owner_id,
        &row.context.request_id.0,
        &row.context.route,
    ] {
        crate::text(text)?;
    }
    for time in [
        row.created_at_ms,
        row.deadline_ms,
        row.context.started_at_ms,
    ] {
        crate::validate_time(time)?;
    }
    let scalar: serde_json::Value = value.deserialize().map_err(|_| unavailable())?;
    if serde_json::to_value(&row).map_err(|_| unavailable())? != scalar {
        return Err(unavailable());
    }
    super::custody::actor_shape(&scalar["actor"])?;
    Ok(())
}
