//! Genuine original Start, actual live custody and native durable receipt only.
use super::{
    DurableNativeImport, ExistingAccountImportStore, LiveImportCustody,
    actor_channel::InheritedCustodyChannel,
    durability,
    import_publication::{
        AuthenticatedImportPublicationReply, ImportPublicationHttp, PreparedImportPublication,
    },
    validation::{CatalogValidation, ImportValidation, ValidatedNativeImport, ValidationOutcome},
};
use crate::{import_custody_protocol::unavailable, native_import::NativeImportContext};
use gateway_authority::native_control::{
    NativeRenewalCancellation,
    import::{
        AuthenticatedImportTerminal, NativeImportClaim, NativeImportMode, RemoteImportAuthority,
    },
};
use gateway_core::GatewayError;

/// No caller-created document, Started DATA or receipt marker can construct it.
/// This is still not final publication/completion authority.
pub(super) struct PreparedExistingImport<'a> {
    pub(super) claim: NativeImportClaim,
    pub(super) custody: LiveImportCustody<'a>,
    pub(super) candidate: ValidatedNativeImport<'a>,
    pub(super) receipt: DurableNativeImport,
    pub(super) publication: PreparedImportPublication<'a>,
}
/// Genuine native durability, a fresh matching authoritative terminal and the
/// SAME live stopped peer's release exchange. No DATA/Boolean constructor.
pub(super) struct VerifiedImportPublication<'a> {
    pub(super) prepared: PreparedExistingImport<'a>,
    pub(super) terminal: AuthenticatedImportTerminal,
    reply: Option<AuthenticatedImportPublicationReply>,
}
impl VerifiedImportPublication<'_> {
    pub(super) fn publication_revision(&self) -> &str {
        &self.terminal.terminal().publication_revision
    }
    pub(super) fn native_receipt_ref(&self) -> &str {
        &self.terminal.terminal().native_receipt_ref
    }
    pub(super) fn candidate(&self) -> &ValidatedNativeImport<'_> {
        &self.prepared.candidate
    }
    pub(super) fn disposition(
        &self,
    ) -> gateway_authority::native_control::import::NativeImportPublicationDisposition {
        self.reply.as_ref().map(|reply| reply.publication().disposition)
            .unwrap_or(gateway_authority::native_control::import::NativeImportPublicationDisposition::AlreadyCurrent)
    }
}
impl<'a> PreparedExistingImport<'a> {
    pub(super) fn publish<C: NativeRenewalCancellation>(
        mut self,
        authority: &RemoteImportAuthority<'_, C>,
        sender: &ImportPublicationHttp,
        store: &ExistingAccountImportStore,
        context: &NativeImportContext<'_>,
    ) -> Result<VerifiedImportPublication<'a>, GatewayError> {
        let result = (|| {
            authority.recheck_import_claim(&self.claim)?;
            let reply = sender
                .publish(
                    &self.publication,
                    store,
                    &mut self.custody,
                    context,
                    &self.receipt,
                )
                .ok();
            // A lost/ambiguous publication reply may only reconcile the SAME
            // native receipt and command. Never rewrite, refresh or mint Start.
            let terminal = authority.observe_publication(
                &self.claim,
                self.publication.command().publication_revision.as_str(),
                &self.receipt.receipt_ref(),
                &self.publication.request_digest(),
            )?;
            self.publication
                .require_terminal(&terminal, &self.receipt, reply.as_ref())?;
            context.check_document(
                context.original_proof(),
                context.original_proof().metadata(),
                context.original_body(),
            )?;
            durability::recheck(store, &self.receipt)?;
            self.custody
                .release_after_verified_terminal(&terminal, context)?;
            context.check_document(
                context.original_proof(),
                context.original_proof().metadata(),
                context.original_body(),
            )?;
            durability::recheck(store, &self.receipt)?;
            // A fresh original-claim terminal check after actual live release
            // closes the last cancellation/revocation/publication window.
            let current = authority.observe_publication(
                &self.claim,
                self.publication.command().publication_revision.as_str(),
                &self.receipt.receipt_ref(),
                &self.publication.request_digest(),
            )?;
            self.publication
                .require_terminal(&current, &self.receipt, reply.as_ref())?;
            context.check()?;
            Ok((current, reply))
        })();
        match result {
            Ok((terminal, reply)) => Ok(VerifiedImportPublication {
                prepared: self,
                terminal,
                reply,
            }),
            Err(error) => {
                let _ = authority.unknown_import(&self.claim);
                Err(error)
            }
        }
    }
    pub(super) fn prepare<C: NativeRenewalCancellation>(
        authority: &RemoteImportAuthority<'_, C>,
        context: &NativeImportContext<'a>,
        store: &ExistingAccountImportStore,
        channel: InheritedCustodyChannel,
        mut validation: ImportValidation,
    ) -> Result<Self, GatewayError> {
        let proof = context.original_proof();
        let body = context.original_body();
        context.check_document(proof, proof.metadata(), body)?;
        authority.recheck_import(proof)?;
        let candidate = validation.probe(context)?;
        context.check_document(proof, proof.metadata(), body)?;
        authority.recheck_import(proof)?;
        if let ValidationOutcome::Valid(candidate) = &candidate {
            require_catalog(authority, context, candidate)?;
        }
        let mut claim = authority.claim_import(proof)?;
        if claim.mode() != NativeImportMode::ImportOnce {
            // A replay/current observation cannot stop a new daemon or issue a
            // new live session. Receipt-only reconciliation grants no mutation.
            return Err(unavailable());
        }
        let result = (|| {
            context.check_document(proof, proof.metadata(), body)?;
            let start = authority
                .start_import(&mut claim, proof)?
                .ok_or_else(unavailable)?;
            let mut custody =
                LiveImportCustody::begin_live_custody(channel, start, proof, body, context)?;
            authority.recheck_import_claim(&claim)?;
            let candidate = match candidate {
                ValidationOutcome::Valid(candidate) => candidate,
                ValidationOutcome::Original401(pending) => {
                    validation.refresh_once(pending, &mut custody, store, proof, body, context)?
                }
            };
            require_catalog(authority, context, &candidate)?;
            authority.recheck_import_claim(&claim)?;
            context.check_document(proof, proof.metadata(), body)?;
            let receipt =
                durability::persist_live(store, &mut custody, proof, body, context, &candidate)?;
            authority.recheck_import_claim(&claim)?;
            let publication = PreparedImportPublication::from_durable(
                store,
                &mut custody,
                context,
                &candidate,
                &receipt,
            )?;
            context.check_document(proof, proof.metadata(), body)?;
            Ok((custody, candidate, receipt, publication))
        })();
        match result {
            Ok((custody, candidate, receipt, publication)) => Ok(Self {
                claim,
                custody,
                candidate,
                receipt,
                publication,
            }),
            Err(error) => {
                // The SAME original claim remains uncertain. A failed unknown
                // exchange is not permission to retry OAuth, stop or file writes.
                let _ = authority.unknown_import(&claim);
                Err(error)
            }
        }
    }
}
fn require_catalog<C: NativeRenewalCancellation>(
    authority: &RemoteImportAuthority<'_, C>,
    context: &NativeImportContext<'_>,
    candidate: &ValidatedNativeImport<'_>,
) -> Result<(), GatewayError> {
    context.check()?;
    authority.recheck_import(context.original_proof())?;
    if matches!(candidate.catalog, CatalogValidation::AuthenticatedLimited)
        && authority
            .observe_import_catalog(context.original_proof())?
            .revision()
            .is_none()
    {
        return Err(GatewayError::new(
            409,
            "Cannot store rate-limited Codex auth without an existing model catalog",
            Some("codex_catalog_required"),
        ));
    }
    context.check()
}
