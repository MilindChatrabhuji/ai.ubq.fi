//! Finite original-import phases. Authentication and coherent authority reads,
//! never request DATA, select the actual one-use operation/start permission.
use super::super::rows::{GenerationEffect, Phase};
use super::*;
use gateway_auth::native_import::authority::{ImportCompletionData, ImportCompletionModelsData};
use gateway_auth::{
    native::NATIVE_RENEWAL_AUTHORITY_PATH,
    native_auth::{
        AuthenticatedNativeOwner, NativeAuthHeaders, NativeAuthenticator, NativeCapability,
    },
    native_import::authority::{
        IMPORT_STARTED_OPERATION, ImportAuthorityClaimMode, ImportAuthorityCommand as Command,
        ImportAuthorityReplyData as Reply, ImportAuthorityRequestData as Request,
        ImportAuthorityResult as ResultData, ImportAuthorityStateData as State,
        ImportAuthorityTerminalData, ImportCustodyStartedReplyData, ImportCustodyStartedWire,
    },
};
use gateway_schema::{catalog_store, snapshot::ModelSnapshot};
#[derive(Clone, Copy)]
enum TerminalProjection {
    ActorCompletion,
    CustodyOnly,
}

impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    pub async fn authenticate_import_authority(
        &self,
        headers: NativeAuthHeaders<'_>,
        body: &[u8],
    ) -> Result<AuthenticatedNativeOwner, GatewayError> {
        let replay = gateway_auth::native_replay::StoreNonceAuthority::new(&self.authority.store);
        let peer = NativeAuthenticator::new(self.identity, &replay)
            .authenticate(NATIVE_RENEWAL_AUTHORITY_PATH, headers, body, self.time(0)?)
            .await?;
        self.require_import_phase_peer(&peer, body)?;
        Ok(peer)
    }
    pub(super) fn require_import_phase_peer(
        &self,
        peer: &AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<(), GatewayError> {
        peer.require_request(
            NativeCapability::CodexAuthImport,
            NATIVE_RENEWAL_AUTHORITY_PATH,
            body,
            self.time(0)?,
        )?;
        if peer.owner_id() != self.identity.owner_id()
            || peer.owner_epoch() != self.identity.owner_epoch()
            || peer.transport_key_fingerprint() != self.identity.key_fingerprint()
        {
            return Err(unavailable());
        }
        Ok(())
    }
    async fn import_phase_snapshot(
        &self,
        metadata: &NativeImportMetadata,
        expected: Option<&State>,
        claim_ref: Option<&str>,
    ) -> Result<(ImportActionRow, State, Option<String>), GatewayError> {
        metadata.validate()?;
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let key = rows::key("action", &metadata.action_ref);
            let row: ImportActionRow = tx
                .read_source_control(&key)
                .await?
                .ok_or_else(unavailable)?;
            let state = remote_state::state_data(&row, tx.revision(&key).ok_or_else(unavailable)?);
            state.validate()?;
            if row.metadata != *metadata || expected.is_some_and(|old| old != &state) {
                return Err(unavailable());
            }
            self.current_import_row(&mut tx, &row).await?;
            if let Some(claim_ref) = claim_ref {
                let claim = effects::NativeImportClaim {
                    binding: remote_state::phase_binding(&state, claim_ref.into()),
                    state: ImportActionState::Local(Box::new(row.clone())),
                    permit: None,
                    mode: NativeImportMode::ReconcileOnly,
                };
                let (_, op) = self.import_operation(&mut tx, &claim).await?;
                let generation: GenerationEffect = tx
                    .read(&effects::generation_key(&row)?)
                    .await?
                    .ok_or_else(unavailable)?;
                if op.request_digest != publication::effect_digest(&row)?
                    || generation.v != 1
                    || generation.operation_id != op.operation_id
                    || generation.claim_ref != op.claim_ref
                    || generation.publication_revision.is_some()
                    || generation.terminal.is_some()
                    || !matches!(op.phase, Phase::Claimed | Phase::Started | Phase::Unknown)
                {
                    return Err(unavailable());
                }
            }
            let catalog: Option<ModelSnapshot> = tx
                .read_source_control(&catalog_store::codex_snapshot_key())
                .await?;
            let catalog_revision =
                catalog.and_then(|_| tx.revision(&catalog_store::codex_snapshot_key()));
            tx.now = self.time(row.created_at_ms)?;
            actor::validate_current_time(&row.actor, tx.now)?;
            if tx.now >= row.deadline_ms {
                return Err(unavailable());
            }
            if tx.commit().await? {
                if self.time(row.created_at_ms)? >= row.deadline_ms {
                    return Err(unavailable());
                }
                return Ok((row, state, catalog_revision));
            }
        }
        Err(unavailable())
    }
    /// Finite DATA response. The existing fixed carrier signs these exact bytes;
    /// they do not construct native body, Started or durability proof types.
    pub async fn handle_import_authority(
        &self,
        peer: &AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<Vec<u8>, GatewayError> {
        self.require_import_phase_peer(peer, body)?;
        let request = Request::parse(body)?;
        let result = match &request.command {
            Command::CustodyTerminal {
                started,
                publication_revision,
            } => {
                let terminal = self
                    .current_custody_terminal(started, publication_revision)
                    .await?;
                ResultData::CustodyTerminal {
                    started: started.clone(),
                    publication_revision: publication_revision.clone(),
                    terminal: Box::new(terminal),
                }
            }
            Command::Admit { metadata } => {
                let (_, state, _) = self.import_phase_snapshot(metadata, None, None).await?;
                ResultData::Admit { state }
            }
            Command::FinishCurrent { state } => {
                self.import_phase_snapshot(&state.metadata, Some(state), None)
                    .await?;
                ResultData::FinishCurrent {
                    state: state.clone(),
                }
            }
            Command::Claim { state } => {
                let (row, _, _) = self
                    .import_phase_snapshot(&state.metadata, Some(state), None)
                    .await?;
                let mut claim = self.claim_import_row(&row).await?;
                let mode = if claim.mode == NativeImportMode::ImportOnce {
                    ImportAuthorityClaimMode::ImportOnce
                } else {
                    ImportAuthorityClaimMode::ReconcileOnly
                };
                ResultData::Claim {
                    state: state.clone(),
                    claim_ref: claim.binding.claim_ref.clone(),
                    mode,
                    start_permit: claim.permit.take(),
                }
            }
            Command::Start {
                state,
                claim_ref,
                start_permit,
            } => {
                let (row, _, _) = self
                    .import_phase_snapshot(&state.metadata, Some(state), Some(claim_ref))
                    .await?;
                let claim = effects::NativeImportClaim {
                    binding: remote_state::phase_binding(state, claim_ref.clone()),
                    state: ImportActionState::Local(Box::new(row)),
                    permit: None,
                    mode: NativeImportMode::ReconcileOnly,
                };
                let started_revision = self
                    .start_import_revision(&claim, true, Some(start_permit.clone()))
                    .await?;
                ResultData::Start {
                    state: state.clone(),
                    claim_ref: claim_ref.clone(),
                    started_revision,
                }
            }
            Command::Current { state, claim_ref } => {
                let (_, _, catalog_revision) = self
                    .import_phase_snapshot(&state.metadata, Some(state), claim_ref.as_deref())
                    .await?;
                ResultData::Current {
                    state: state.clone(),
                    claim_ref: claim_ref.clone(),
                    catalog_revision,
                }
            }
            Command::Unknown { state, claim_ref } => {
                let (row, _, _) = self
                    .import_phase_snapshot(&state.metadata, Some(state), Some(claim_ref))
                    .await?;
                let claim = effects::NativeImportClaim {
                    binding: remote_state::phase_binding(state, claim_ref.clone()),
                    state: ImportActionState::Local(Box::new(row)),
                    permit: None,
                    mode: NativeImportMode::ReconcileOnly,
                };
                self.unknown_import(&claim).await?;
                ResultData::Unknown {
                    state: state.clone(),
                    claim_ref: claim_ref.clone(),
                }
            }
            Command::Terminal {
                state,
                claim_ref,
                publication_revision,
                native_receipt_ref,
                publication_request_digest,
            } => {
                let (state, terminal, completion) = self
                    .import_phase_terminal(
                        state,
                        claim_ref,
                        publication_revision,
                        native_receipt_ref,
                        publication_request_digest,
                        TerminalProjection::ActorCompletion,
                    )
                    .await?;
                ResultData::Terminal {
                    state,
                    terminal: Box::new(terminal),
                    completion: completion.ok_or_else(unavailable)?,
                }
            }
        };
        self.require_import_phase_peer(peer, body)?;
        if let ResultData::CustodyTerminal { started, .. } = &result {
            if self.time(0)? >= started.deadline_ms {
                return Err(unavailable());
            }
            let reply = Reply::new(result);
            reply.validate_for(&request)?;
            return serde_json::to_vec(&reply).map_err(|_| unavailable());
        }
        let state = match &result {
            ResultData::CustodyTerminal { .. } => return Err(unavailable()),
            ResultData::Admit { state }
            | ResultData::FinishCurrent { state }
            | ResultData::Claim { state, .. }
            | ResultData::Start { state, .. }
            | ResultData::Current { state, .. }
            | ResultData::Unknown { state, .. }
            | ResultData::Terminal { state, .. } => state,
        };
        if self.time(state.created_at_ms)? >= state.deadline_ms {
            return Err(unavailable());
        }
        let reply = Reply::new(result);
        reply.validate_for(&request)?;
        serde_json::to_vec(&reply).map_err(|_| unavailable())
    }
    // Current terminal ONLY: the overwritten Started revision is deliberately
    // request-correlated DATA, not historical proof or a new stop capability.
    async fn current_custody_terminal(
        &self,
        started: &ImportCustodyStartedWire,
        revision: &str,
    ) -> Result<ImportAuthorityTerminalData, GatewayError> {
        let key = rows::key("action", &started.action_ref);
        let record = self
            .authority
            .store
            .read(&key)
            .await?
            .ok_or_else(unavailable)?;
        let document = gateway_core::source_control::decode_source_control_record(&record)?;
        let row: ImportActionRow = document.deserialize()?;
        if row.v != 3
            || row.kind != NativeImportKind::CodexAuth
            || row.metadata.operation_id != started.operation_id
            || row.metadata.action_ref != started.action_ref
            || row.facts.native_owner_id != started.native_owner_id
            || row.facts.account_id_hash != started.account_id_hash
            || row.facts.source_native_generation != started.source_native_generation
            || row.facts.owner_revision != started.owner_revision
            || row.facts.source_revision != started.source_revision
            || row.facts.normalized_revision != started.normalized_revision
            || row.deadline_ms != started.deadline_ms
        {
            return Err(unavailable());
        }
        let publication = row.publication.as_ref().ok_or_else(unavailable)?;
        if publication.claim_ref != started.claim_ref
            || publication.publication_revision != revision
        {
            return Err(unavailable());
        }
        let state = remote_state::state_data(&row, record.revision);
        let (_, terminal, _) = self
            .import_phase_terminal(
                &state,
                &started.claim_ref,
                revision,
                &publication.native_receipt_ref,
                &publication.publication_request_digest,
                TerminalProjection::CustodyOnly,
            )
            .await?;
        Ok(terminal)
    }

    async fn import_phase_terminal(
        &self,
        original: &State,
        claim_ref: &str,
        revision: &str,
        receipt: &str,
        digest: &str,
        projection: TerminalProjection,
    ) -> Result<
        (
            State,
            ImportAuthorityTerminalData,
            Option<ImportCompletionData>,
        ),
        GatewayError,
    > {
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let key = rows::key("action", &original.metadata.action_ref);
            let row: ImportActionRow = tx
                .read_source_control(&key)
                .await?
                .ok_or_else(unavailable)?;
            let state = remote_state::state_data(&row, tx.revision(&key).ok_or_else(unavailable)?);
            let mut before = state.clone();
            before.action_revision = original.action_revision.clone();
            if &before != original {
                return Err(unavailable());
            }
            let publication = row.publication.as_ref().ok_or_else(unavailable)?;
            if publication.claim_ref != claim_ref
                || publication.publication_revision != revision
                || publication.native_receipt_ref != receipt
                || publication.publication_request_digest != digest
            {
                return Err(unavailable());
            }
            let completion = match projection {
                TerminalProjection::CustodyOnly => {
                    publication_current::verify(self, &mut tx, &row, publication).await?;
                    None
                }
                TerminalProjection::ActorCompletion => {
                    let actual =
                        publication_current::completion_metadata(self, &mut tx, &row, publication)
                            .await?;
                    Some(ImportCompletionData {
                        account_count: actual.account_count as u64,
                        account_ids: actual.account_ids,
                        updated_at_ms: actual.updated_at_ms,
                        models: ImportCompletionModelsData {
                            count: actual.models.count as u64,
                            source: actual.models.source,
                            updated_at_ms: actual.models.updated_at_ms,
                            client_version: actual.models.client_version,
                        },
                    })
                }
            };
            let terminal = ImportAuthorityTerminalData {
                publication_revision: publication.publication_revision.clone(),
                native_receipt_ref: publication.native_receipt_ref.clone(),
                publication_request_digest: publication.publication_request_digest.clone(),
                native_source_generation: publication.native_source_generation.clone(),
                access_generation: publication.access_generation.clone(),
                credential_version: publication.credential_version.clone(),
                source_revision: publication.source_revision.clone(),
                normalized_revision: publication.normalized_revision.clone(),
                catalog_revision: publication.catalog_revision.clone(),
                runtime_revision: publication.runtime_revision.clone(),
                auth_generation_revision: publication.auth_generation_revision.clone(),
                paid_control_config_revision: publication.paid_control_config_revision.clone(),
            };
            if tx.commit().await? {
                if self.time(row.created_at_ms)? >= row.deadline_ms {
                    return Err(unavailable());
                }
                return Ok((state, terminal, completion));
            }
        }
        Err(unavailable())
    }
    /// Preserve the canonical bare B1 request body and its readonly verifier.
    pub async fn handle_import_started(
        &self,
        peer: &AuthenticatedNativeOwner,
        body: &[u8],
    ) -> Result<Vec<u8>, GatewayError> {
        let wire = ImportCustodyStartedWire::parse(body)?;
        let request: ImportCustodyStartedRequest =
            serde_json::from_slice(body).map_err(|_| unavailable())?;
        let proof = self.verify_started_custody(peer, &request).await?;
        let reply = ImportCustodyStartedReplyData {
            operation: IMPORT_STARTED_OPERATION.into(),
            v: 1,
            request: wire,
            verified_at_ms: proof.verified_at_ms(),
        };
        let bytes = serde_json::to_vec(&reply).map_err(|_| unavailable())?;
        ImportCustodyStartedReplyData::parse_for(&bytes, &reply.request)?;
        Ok(bytes)
    }
}
