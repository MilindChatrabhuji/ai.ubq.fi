//! The import uses the original operation/generation rows, not a second effect ledger.
use super::super::rows::{GenerationEffect, OperationRow, Phase};
use super::*;
use crate::store::Transaction;
use gateway_auth::crypto::sha256_hex;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeImportBinding {
    pub action_ref: String,
    pub operation_id: String,
    pub claim_ref: String,
    pub native_owner_id: String,
    pub account_id_hash: String,
    pub source_native_generation: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeImportMode {
    ImportOnce,
    ReconcileOnly,
}
pub struct NativeImportClaim {
    pub(super) binding: NativeImportBinding,
    pub(super) state: ImportActionState,
    pub(super) permit: Option<String>,
    pub(super) mode: NativeImportMode,
}
impl NativeImportClaim {
    pub fn binding(&self) -> &NativeImportBinding {
        &self.binding
    }
    pub fn mode(&self) -> NativeImportMode {
        self.mode
    }
}
/// Consumed by the fixed native importer, never deserialized from caller data.
/// ```compile_fail
/// use gateway_authority::native_control::import::NativeImportStart;
/// let forged: NativeImportStart<'_> = serde_json::from_str("{}").unwrap();
/// ```
pub struct NativeImportStart<'a> {
    pub(super) proof: &'a AuthenticatedNativeImport,
    pub(super) binding: NativeImportBinding,
    pub(super) started_revision: String,
}
impl NativeImportStart<'_> {
    pub fn binding(&self) -> &NativeImportBinding {
        &self.binding
    }
    pub fn require_body(&self, body: &[u8], now: i64) -> Result<(), GatewayError> {
        self.proof.require_body(body, now)
    }
    /// DATA from this actual committed Start; never caller-selected revisions or time.
    pub fn custody_request(&self) -> Result<ImportCustodyStartedRequest, GatewayError> {
        let binding = &self.binding;
        let request = ImportCustodyStartedRequest {
            v: 1,
            operation_id: binding.operation_id.clone(),
            action_ref: binding.action_ref.clone(),
            claim_ref: binding.claim_ref.clone(),
            native_owner_id: binding.native_owner_id.clone(),
            account_id_hash: binding.account_id_hash.clone(),
            source_native_generation: binding.source_native_generation.clone(),
            owner_revision: binding.owner_revision.clone(),
            source_revision: binding.source_revision.clone(),
            normalized_revision: binding.normalized_revision.clone(),
            started_revision: self.started_revision.clone(),
            deadline_ms: self.proof.deadline_ms(),
        };
        request.validate()?;
        Ok(request)
    }
}
pub(super) fn generation_key(
    row: &ImportActionRow,
) -> Result<gateway_core::state::RecordKey, GatewayError> {
    Ok(rows::key(
        "generation",
        &super::super::facts::digest(&(
            "uos-native-renewal-generation-v1",
            &row.facts.native_owner_id,
            &row.facts.account_id_hash,
            &row.facts.source_native_generation,
        ))?,
    ))
}
fn binding(row: &ImportActionRow, claim_ref: String) -> NativeImportBinding {
    NativeImportBinding {
        action_ref: row.metadata.action_ref.clone(),
        operation_id: row.metadata.operation_id.clone(),
        claim_ref,
        native_owner_id: row.facts.native_owner_id.clone(),
        account_id_hash: row.facts.account_id_hash.clone(),
        source_native_generation: row.facts.source_native_generation.clone(),
        owner_revision: row.facts.owner_revision.clone(),
        source_revision: row.facts.source_revision.clone(),
        normalized_revision: row.facts.normalized_revision.clone(),
    }
}
impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    pub(super) async fn current_import_row(
        &self,
        tx: &mut Transaction<'_, S, I>,
        row: &ImportActionRow,
    ) -> Result<(), GatewayError> {
        tx.now = self.time(row.created_at_ms)?;
        if !row.unfinished()
            || row.kind != NativeImportKind::CodexAuth
            || row.kind != row.target.kind()
            || row.deadline_ms != crate::add(row.created_at_ms, OWNER_RENEWAL_MAX_MS)?
        {
            return Err(unavailable());
        }
        let current = sources::read(self, tx, &row.actor, &row.target).await?;
        if current != row.facts {
            return Err(unavailable());
        }
        tx.now = self.time(tx.now)?;
        actor::validate_current_time(&row.actor, tx.now)?;
        if tx.now >= row.deadline_ms {
            return Err(unavailable());
        }
        Ok(())
    }
    pub(super) async fn import_operation(
        &self,
        tx: &mut Transaction<'_, S, I>,
        claim: &NativeImportClaim,
    ) -> Result<(ImportActionRow, OperationRow), GatewayError> {
        let row: ImportActionRow = tx
            .read_source_control(&rows::key("action", &claim.binding.action_ref))
            .await?
            .ok_or_else(unavailable)?;
        let op: OperationRow = tx
            .read(&rows::key("operation", &claim.binding.operation_id))
            .await?
            .ok_or_else(unavailable)?;
        let original = claim.state.local()?;
        if !row.unfinished()
            || row.metadata != original.metadata
            || row.facts != original.facts
            || row.actor != original.actor
            || row.context != original.context
            || row.target != original.target
            || row.created_at_ms != original.created_at_ms
            || row.deadline_ms != original.deadline_ms
            || op.v != 1
            || op.operation_id != claim.binding.operation_id
            || op.action_ref != claim.binding.action_ref
            || op.claim_ref != claim.binding.claim_ref
            || op.terminal.is_some()
            || op.publication_revision.is_some()
            || op.phase == Phase::Published
        {
            return Err(unavailable());
        }
        Ok((row, op))
    }
    pub async fn claim_import(
        &self,
        proof: &AuthenticatedNativeImport,
    ) -> Result<NativeImportClaim, GatewayError> {
        self.recheck_import(proof).await?;
        self.claim_import_row(proof.state.local()?).await
    }
    pub(super) async fn claim_import_row(
        &self,
        row: &ImportActionRow,
    ) -> Result<NativeImportClaim, GatewayError> {
        let request_digest = super::super::facts::digest(&(
            "uos-native-import-effect-v2",
            &row.metadata,
            &row.target,
            &row.facts,
            &row.context,
            row.created_at_ms,
            row.deadline_ms,
        ))?;
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let current: ImportActionRow = tx
                .read_source_control(&rows::key("action", &row.metadata.action_ref))
                .await?
                .ok_or_else(unavailable)?;
            if serde_json::to_vec(&current).map_err(|_| unavailable())?
                != serde_json::to_vec(row).map_err(|_| unavailable())?
            {
                return Err(unavailable());
            }
            self.current_import_row(&mut tx, row).await?;
            let key = rows::key("operation", &row.metadata.operation_id);
            let prior: Option<OperationRow> = tx.read(&key).await?;
            let generation_key = generation_key(row)?;
            let generation: Option<GenerationEffect> = tx.read(&generation_key).await?;
            if generation.as_ref().is_some_and(|g| g.v != 1) {
                return Err(unavailable());
            }
            let (op, permit, mode) = if let Some(op) = prior {
                if op.v != 1
                    || op.action_ref != row.metadata.action_ref
                    || op.operation_id != row.metadata.operation_id
                    || op.request_digest != request_digest
                    || generation.is_none()
                    || op.terminal.is_some()
                    || op.publication_revision.is_some()
                    || op.native_source_generation.is_some()
                    || op.access_generation.is_some()
                    || op.phase == Phase::Published
                {
                    return Err(unavailable());
                }
                (op, None, NativeImportMode::ReconcileOnly)
            } else {
                let permit = self.authority.tokens.next_token()?;
                crate::text(&permit)?;
                let fresh = generation.is_none();
                let op = OperationRow {
                    v: 1,
                    action_ref: row.metadata.action_ref.clone(),
                    operation_id: row.metadata.operation_id.clone(),
                    request_digest: request_digest.clone(),
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
                tx.put(&key, &op, None)?;
                if fresh {
                    tx.put(
                        &generation_key,
                        &GenerationEffect {
                            v: 1,
                            operation_id: op.operation_id.clone(),
                            claim_ref: op.claim_ref.clone(),
                            publication_revision: None,
                            terminal: None,
                        },
                        None,
                    )?;
                }
                (
                    op,
                    fresh.then_some(permit),
                    if fresh {
                        NativeImportMode::ImportOnce
                    } else {
                        NativeImportMode::ReconcileOnly
                    },
                )
            };
            self.current_import_row(&mut tx, row).await?;
            if tx.commit().await? {
                return Ok(NativeImportClaim {
                    binding: binding(row, op.claim_ref),
                    state: ImportActionState::Local(Box::new(row.clone())),
                    permit,
                    mode,
                });
            }
        }
        Err(unavailable())
    }
    pub async fn start_import<'a>(
        &self,
        claim: &mut NativeImportClaim,
        proof: &'a AuthenticatedNativeImport,
    ) -> Result<Option<NativeImportStart<'a>>, GatewayError> {
        let fresh = claim.mode == NativeImportMode::ImportOnce;
        claim.mode = NativeImportMode::ReconcileOnly;
        let permit = claim.permit.take();
        proof.body.require_owner(self.identity, self.time(0)?)?;
        proof.state.local()?;
        if proof.metadata() != &claim.state.local()?.metadata {
            return Err(unavailable());
        }
        let revision = self.start_import_revision(claim, fresh, permit).await?;
        Ok(revision.map(|started_revision| NativeImportStart {
            proof,
            binding: claim.binding.clone(),
            started_revision,
        }))
    }
    pub(super) async fn start_import_revision(
        &self,
        claim: &NativeImportClaim,
        fresh: bool,
        permit: Option<String>,
    ) -> Result<Option<String>, GatewayError> {
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let (row, mut op) = self.import_operation(&mut tx, claim).await?;
            self.current_import_row(&mut tx, &row).await?;
            let generation: GenerationEffect = tx
                .read(&generation_key(&row)?)
                .await?
                .ok_or_else(unavailable)?;
            if !fresh
                || op.phase != Phase::Claimed
                || generation.v != 1
                || generation.operation_id != op.operation_id
                || generation.claim_ref != op.claim_ref
                || permit
                    .as_ref()
                    .is_none_or(|p| sha256_hex(p.as_bytes()) != op.start_digest)
            {
                return Ok(None);
            }
            op.phase = Phase::Started;
            let operation_key = rows::key("operation", &op.operation_id);
            tx.put(&operation_key, &op, None)?;
            let started_revision = tx
                .post_checks()
                .into_iter()
                .find(|check| check.key == operation_key)
                .and_then(|check| check.expected_revision)
                .ok_or_else(unavailable)?;
            self.current_import_row(&mut tx, &row).await?;
            if tx.commit().await? {
                return Ok(Some(started_revision));
            }
        }
        Err(unavailable())
    }
    pub async fn recheck_import_claim(
        &self,
        claim: &NativeImportClaim,
    ) -> Result<(), GatewayError> {
        let mut tx = self.authority.transaction(self.time(0)?)?;
        let (row, _) = self.import_operation(&mut tx, claim).await?;
        self.current_import_row(&mut tx, &row).await?;
        if !tx.commit().await? {
            return Err(unavailable());
        }
        Ok(())
    }
    pub async fn unknown_import(&self, claim: &NativeImportClaim) -> Result<(), GatewayError> {
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.authority.fresh_time(0)?)?;
            let (_, mut op) = self.import_operation(&mut tx, claim).await?;
            if op.phase == Phase::Published {
                return Ok(());
            }
            op.phase = Phase::Unknown;
            tx.put(&rows::key("operation", &op.operation_id), &op, None)?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable())
    }
}
