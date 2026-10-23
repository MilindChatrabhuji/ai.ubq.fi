//! Actor-local sealed live channel capability; wire stopped DATA cannot construct it.
use super::{ExistingAccountImportStore, actor_channel::InheritedCustodyChannel};
use crate::{
    import_custody_protocol::{self as wire, Frame, Header, Release, Stopped, unavailable},
    native_import::NativeImportContext,
};
use gateway_authority::native_control::import::{
    AuthenticatedImportTerminal, AuthenticatedNativeImport, ImportCustodyStartedRequest,
    NativeImportBinding, NativeImportStart,
};
use gateway_core::GatewayError;
use std::{
    os::unix::fs::MetadataExt,
    time::{Duration, Instant},
};

/// Only the fixed actor's genuine original Start plus its inherited live peer can issue this.
/// ```compile_fail
/// use gateway_native::existing_account_import::LiveImportCustody;
/// let forged: LiveImportCustody<'_> = serde_json::from_str("{}").unwrap();
/// ```
pub struct LiveImportCustody<'a> {
    channel: InheritedCustodyChannel,
    original_start: NativeImportStart<'a>,
    binding: ImportCustodyStartedRequest,
    challenge: String,
    epoch: String,
    root_device: u64,
    root_inode: u64,
    deadline: Instant,
    uncertain: bool,
    released: bool,
    publication_ref: Option<String>,
    publication_digest: Option<String>,
}
impl<'a> LiveImportCustody<'a> {
    pub(super) fn begin_live_custody(
        mut channel: InheritedCustodyChannel,
        start: NativeImportStart<'a>,
        proof: &AuthenticatedNativeImport,
        original_body: &[u8],
        context: &NativeImportContext<'_>,
    ) -> Result<Self, GatewayError> {
        context.check_document(proof, proof.metadata(), original_body)?;
        start.require_body(original_body, context.now_ms()?)?;
        if start.binding().action_ref != proof.metadata().action_ref
            || start.binding().operation_id != proof.metadata().operation_id
            || channel.next_sequence != 1
        {
            return Err(unavailable());
        }
        let binding = start.custody_request()?;
        let remaining = binding
            .deadline_ms
            .checked_sub(context.now_ms()?)
            .filter(|ms| *ms > 0 && *ms <= gateway_auth::native_control::NATIVE_RENEWAL_MAX_MS)
            .ok_or_else(unavailable)?;
        let deadline = context
            .deadline()
            .min(Instant::now() + Duration::from_millis(remaining as u64));
        let challenge = wire::random_ref()?;
        let header = Header {
            v: 1,
            sequence: 1,
            session_ref: channel.session_ref.clone(),
            challenge: challenge.clone(),
            binding: wire::copy_binding(&binding)?,
        };
        wire::send(
            &mut channel.socket,
            &Frame::Quiesce(header),
            deadline,
            Some(context),
        )?;
        let response = wire::receive(&mut channel.socket, deadline, Some(context))?;
        let Frame::Stopped(stopped) = response else {
            return Err(unavailable());
        };
        verify(&stopped, &binding, &channel.session_ref, &challenge, 1)?;
        context.check_document(proof, proof.metadata(), original_body)?;
        channel.next_sequence = 2;
        Ok(Self {
            channel,
            original_start: start,
            binding,
            challenge,
            epoch: stopped.epoch,
            root_device: stopped.root_device,
            root_inode: stopped.root_inode,
            deadline,
            uncertain: false,
            released: false,
            publication_ref: None,
            publication_digest: None,
        })
    }
    pub(super) fn publication_reference(&mut self) -> Result<String, GatewayError> {
        if self.uncertain || self.released {
            return Err(unavailable());
        }
        if self.publication_ref.is_none() {
            self.publication_ref = Some(wire::random_ref()?);
        }
        self.publication_ref.clone().ok_or_else(unavailable)
    }
    pub(super) fn bind_publication(&mut self, digest: &str) -> Result<(), GatewayError> {
        if self.uncertain
            || self.released
            || !wire::hash(digest)
            || self
                .publication_digest
                .as_deref()
                .is_some_and(|original| original != digest)
        {
            return Err(unavailable());
        }
        self.publication_digest = Some(digest.into());
        Ok(())
    }
    /// This is a live actual peer exchange after publication, not a historical
    /// B1 recheck or a caller-created Published/Boolean completion input.
    pub(super) fn release_after_verified_terminal(
        &mut self,
        terminal: &AuthenticatedImportTerminal,
        context: &NativeImportContext<'_>,
    ) -> Result<(), GatewayError> {
        if self.uncertain
            || self.released
            || Instant::now() >= self.deadline
            || terminal.binding() != self.binding()
            || self.publication_ref.as_deref()
                != Some(terminal.terminal().publication_revision.as_str())
            || self.publication_digest.as_deref()
                != Some(terminal.terminal().publication_request_digest.as_str())
            || terminal.observed_at_ms() > context.now_ms()?
        {
            return Err(unavailable());
        }
        context.check_document(
            context.original_proof(),
            context.original_proof().metadata(),
            context.original_body(),
        )?;
        self.original_start
            .require_body(context.original_body(), context.now_ms()?)?;
        self.uncertain = true;
        let sequence = self.channel.next_sequence;
        wire::send(
            &mut self.channel.socket,
            &Frame::ReleaseAfterVerifiedTerminal(Release {
                v: 1,
                sequence,
                session_ref: self.channel.session_ref.clone(),
                challenge: self.challenge.clone(),
                binding: wire::copy_binding(&self.binding)?,
                publication_revision: terminal.terminal().publication_revision.clone(),
            }),
            self.deadline,
            Some(context),
        )?;
        let response = wire::receive(&mut self.channel.socket, self.deadline, Some(context))?;
        let Frame::Released(header) = response else {
            return Err(unavailable());
        };
        if header.v != 1
            || header.sequence != sequence
            || header.session_ref != self.channel.session_ref
            || header.challenge != self.challenge
            || header.binding.canonical_bytes()? != self.binding.canonical_bytes()?
        {
            return Err(unavailable());
        }
        context.check_document(
            context.original_proof(),
            context.original_proof().metadata(),
            context.original_body(),
        )?;
        self.channel.next_sequence = sequence.checked_add(1).ok_or_else(unavailable)?;
        self.released = true;
        self.uncertain = false;
        Ok(())
    }
    pub(super) fn binding(&self) -> &NativeImportBinding {
        self.original_start.binding()
    }
    pub(super) fn check_live(
        &mut self,
        store: &ExistingAccountImportStore,
        proof: &AuthenticatedNativeImport,
        original_body: &[u8],
        context: &NativeImportContext<'_>,
    ) -> Result<(), GatewayError> {
        if self.uncertain || self.released || Instant::now() >= self.deadline {
            return Err(unavailable());
        }
        self.uncertain = true;
        context.check_document(proof, proof.metadata(), original_body)?;
        self.original_start
            .require_body(original_body, context.now_ms()?)?;
        store.require_binding(self.original_start.binding())?;
        let root = store.directory.metadata().map_err(|_| unavailable())?;
        let reopened = super::durability::open_home(&store.home)?;
        let current = reopened.metadata().map_err(|_| unavailable())?;
        if root.dev() != self.root_device
            || root.ino() != self.root_inode
            || current.dev() != root.dev()
            || current.ino() != root.ino()
        {
            return Err(unavailable());
        }
        let sequence = self.channel.next_sequence;
        let header = Header {
            v: 1,
            sequence,
            session_ref: self.channel.session_ref.clone(),
            challenge: self.challenge.clone(),
            binding: wire::copy_binding(&self.binding)?,
        };
        wire::send(
            &mut self.channel.socket,
            &Frame::CheckStopped(header),
            self.deadline,
            Some(context),
        )?;
        let response = wire::receive(&mut self.channel.socket, self.deadline, Some(context))?;
        let Frame::Stopped(stopped) = response else {
            return Err(unavailable());
        };
        verify(
            &stopped,
            &self.binding,
            &self.channel.session_ref,
            &self.challenge,
            sequence,
        )?;
        if stopped.epoch != self.epoch
            || stopped.root_device != self.root_device
            || stopped.root_inode != self.root_inode
        {
            return Err(unavailable());
        }
        self.channel.next_sequence = sequence.checked_add(1).ok_or_else(unavailable)?;
        context.check_document(proof, proof.metadata(), original_body)?;
        self.uncertain = false;
        Ok(())
    }
}
fn verify(
    stopped: &Stopped,
    binding: &ImportCustodyStartedRequest,
    session_ref: &str,
    challenge: &str,
    sequence: u64,
) -> Result<(), GatewayError> {
    if stopped.v != 1
        || stopped.sequence != sequence
        || stopped.session_ref != session_ref
        || stopped.challenge != challenge
        || stopped.binding.canonical_bytes()? != binding.canonical_bytes()?
        || !wire::hash(&stopped.epoch)
        || stopped.root_inode == 0
    {
        return Err(unavailable());
    }
    Ok(())
}
impl Drop for LiveImportCustody<'_> {
    fn drop(&mut self) {
        // Closing the actual endpoint releases no stopped-state claim and never restarts a daemon.
        let _ = self.channel.socket.shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests;
