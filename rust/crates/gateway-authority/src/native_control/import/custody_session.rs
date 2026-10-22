//! Finite binding data and a read-only observation of the actual current original Started claim.
//! No native effect, new start, nonce consumption or deserialized permission.
use super::super::rows::{GenerationEffect, OperationRow, Phase};
use super::*;
use gateway_auth::{
    native::NATIVE_RENEWAL_AUTHORITY_PATH,
    native_auth::{AuthenticatedNativeOwner, NativeCapability},
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCustodyStartedRequest {
    pub v: u8,
    pub operation_id: String,
    pub action_ref: String,
    pub claim_ref: String,
    pub native_owner_id: String,
    pub account_id_hash: String,
    pub source_native_generation: String,
    pub owner_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub started_revision: String,
    pub deadline_ms: i64,
}
impl ImportCustodyStartedRequest {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 1 {
            return Err(unavailable());
        }
        NativeImportMetadata {
            v: 1,
            operation_id: self.operation_id.clone(),
            action_ref: self.action_ref.clone(),
        }
        .validate()?;
        NativeImportMetadata {
            v: 1,
            operation_id: self.claim_ref.clone(),
            action_ref: self.action_ref.clone(),
        }
        .validate()?;
        for hash in [
            &self.action_ref,
            &self.account_id_hash,
            &self.source_native_generation,
        ] {
            super::super::custody::hash(hash)?;
        }
        for text in [
            &self.native_owner_id,
            &self.owner_revision,
            &self.source_revision,
            &self.normalized_revision,
            &self.started_revision,
        ] {
            crate::text(text)?;
        }
        crate::validate_time(self.deadline_ms)
    }
    /// Canonical nonsecret request frame; the existing actual HMAC proof must bind these exact bytes.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, GatewayError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|_| unavailable())
    }
}
/// A fresh CAS-checked original Started observation, NOT a stop/write/publication capability.
/// ```compile_fail
/// use gateway_authority::native_control::import::VerifiedCurrentImportStarted;
/// let forged:VerifiedCurrentImportStarted=serde_json::from_str("{}").unwrap();
/// ```
/// ```compile_fail
/// use gateway_authority::native_control::import::{ImportCustodyStartedRequest,VerifiedCurrentImportStarted};
/// fn forge(request:ImportCustodyStartedRequest)->VerifiedCurrentImportStarted {
///     VerifiedCurrentImportStarted{request,verified_at_ms:0}
/// }
/// ```
pub struct VerifiedCurrentImportStarted {
    pub(super) request: ImportCustodyStartedRequest,
    pub(super) verified_at_ms: i64,
}
impl VerifiedCurrentImportStarted {
    pub fn request(&self) -> &ImportCustodyStartedRequest {
        &self.request
    }
    pub fn verified_at_ms(&self) -> i64 {
        self.verified_at_ms
    }
    pub fn deadline_ms(&self) -> i64 {
        self.request.deadline_ms
    }
}
impl<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>
    NativeRenewalAuthority<'_, S, I, C>
{
    /// Requires a genuine existing native HMAC peer. The new finite transport dispatch is
    /// deliberately unwired; caller-created binding DATA or a historical stopped marker is not proof.
    pub async fn verify_started_custody(
        &self,
        peer: &AuthenticatedNativeOwner,
        request: &ImportCustodyStartedRequest,
    ) -> Result<VerifiedCurrentImportStarted, GatewayError> {
        let bytes = request.canonical_bytes()?;
        self.require_custody_peer(peer, &bytes, self.time(0)?)?;
        for _ in 0..5 {
            let mut tx = self.authority.transaction(self.time(0)?)?;
            let row: ImportActionRow = tx
                .read_source_control(&rows::key("action", &request.action_ref))
                .await?
                .ok_or_else(unavailable)?;
            if !row.unfinished()
                || row.metadata.operation_id != request.operation_id
                || row.metadata.action_ref != request.action_ref
                || row.metadata.v != 1
                || row.facts.native_owner_id != request.native_owner_id
                || row.facts.account_id_hash != request.account_id_hash
                || row.facts.source_native_generation != request.source_native_generation
                || row.facts.owner_revision != request.owner_revision
                || row.facts.source_revision != request.source_revision
                || row.facts.normalized_revision != request.normalized_revision
                || row.deadline_ms != request.deadline_ms
            {
                return Err(unavailable());
            }
            row.metadata.validate()?;
            self.current_import_row(&mut tx, &row).await?;
            let key = rows::key("operation", &request.operation_id);
            let op: OperationRow = tx.read(&key).await?.ok_or_else(unavailable)?;
            let digest = super::super::facts::digest(&(
                "uos-native-import-effect-v2",
                &row.metadata,
                &row.target,
                &row.facts,
                &row.context,
                row.created_at_ms,
                row.deadline_ms,
            ))?;
            if op.v != 1
                || op.operation_id != request.operation_id
                || op.action_ref != request.action_ref
                || op.claim_ref != request.claim_ref
                || tx.revision(&key).as_deref() != Some(request.started_revision.as_str())
                || op.phase != Phase::Started
                || op.request_digest != digest
                || op.terminal.is_some()
                || op.publication_revision.is_some()
                || op.native_source_generation.is_some()
                || op.access_generation.is_some()
            {
                return Err(unavailable());
            }
            let generation: GenerationEffect = tx
                .read(&effects::generation_key(&row)?)
                .await?
                .ok_or_else(unavailable)?;
            if generation.v != 1
                || generation.operation_id != request.operation_id
                || generation.claim_ref != request.claim_ref
                || generation.publication_revision.is_some()
                || generation.terminal.is_some()
            {
                return Err(unavailable());
            }
            self.current_import_row(&mut tx, &row).await?;
            tx.now = self.time(tx.now)?;
            self.require_custody_peer(peer, &bytes, tx.now)?;
            if tx.now >= request.deadline_ms {
                return Err(unavailable());
            }
            // Empty CAS establishes the exact coherent read snapshot. It allocates no revision/token.
            if tx.commit().await? {
                let now = self.time(row.created_at_ms)?;
                actor::validate_current_time(&row.actor, now)?;
                self.require_custody_peer(peer, &bytes, now)?;
                if now >= request.deadline_ms {
                    return Err(unavailable());
                }
                let request: ImportCustodyStartedRequest =
                    serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
                return Ok(VerifiedCurrentImportStarted {
                    request,
                    verified_at_ms: now,
                });
            }
        }
        Err(unavailable())
    }
    fn require_custody_peer(
        &self,
        peer: &AuthenticatedNativeOwner,
        bytes: &[u8],
        now: i64,
    ) -> Result<(), GatewayError> {
        peer.require_request(
            NativeCapability::CodexAuthImport,
            NATIVE_RENEWAL_AUTHORITY_PATH,
            bytes,
            now,
        )?;
        if peer.owner_id() != self.identity.owner_id()
            || peer.owner_epoch() != self.identity.owner_epoch()
            || peer.transport_key_fingerprint() != self.identity.key_fingerprint()
        {
            return Err(unavailable());
        }
        Ok(())
    }
}
