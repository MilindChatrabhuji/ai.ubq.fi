//! Kernel/actual Child/epoch only. This module never opens or decodes credential documents.
use super::{OwnedRuntime, actor_channel::{ImportChildCommand, OwnedImportChildChannel}};
use crate::import_custody_protocol::{Header, unavailable};
use gateway_authority::native_control::import::VerifiedCurrentImportStarted;
use gateway_core::GatewayError;
use std::time::{Duration, Instant};

pub(crate) struct KernelSnapshot {
    pub(crate) epoch: String,
    pub(crate) root_device: u64,
    pub(crate) root_inode: u64,
}
struct Session {
    binding: Vec<u8>,
    session_ref: String,
    challenge: String,
    stopped: bool,
    deadline: Instant,
}
/// Not a serializable lease or a renamed credential-bearing owner-settlement API.
/// Its private constructor accepts actual already-owned Child custody, never a PID/Boolean.
/// ```compile_fail
/// use gateway_native::existing_account_import::CustodianRuntime;
/// let forged: CustodianRuntime = serde_json::from_str("{}").unwrap();
/// ```
pub struct CustodianRuntime {
    runtime: OwnedRuntime,
    session: Option<Session>,
}
impl CustodianRuntime {
    pub(super) fn from_owned(runtime: OwnedRuntime) -> Result<Self, GatewayError> {
        runtime.require_owned_child()?;
        Ok(Self { runtime, session: None })
    }
    pub(super) fn open_import_session(
        &mut self,
        peer: &mut OwnedImportChildChannel,
        command: &ImportChildCommand,
        fresh: VerifiedCurrentImportStarted,
    ) -> Result<(), GatewayError> {
        if self.session.is_some() { return Err(unavailable()); }
        let request = peer.consume_first_quiesce(command)?;
        self.match_observation(&request, &fresh)?;
        let now = crate::http_server::now_ms()?;
        let remaining = fresh.deadline_ms().checked_sub(now)
            .filter(|ms| *ms > 0 && *ms <= gateway_auth::native_control::NATIVE_RENEWAL_MAX_MS)
            .ok_or_else(unavailable)?;
        let deadline = peer.deadline().min(Instant::now() + Duration::from_millis(remaining as u64));
        // Install the live session before any possible effect. Every later error keeps it consumed.
        self.session = Some(Session { binding: request.binding.canonical_bytes()?,
            session_ref: request.session_ref, challenge: request.challenge, stopped: false, deadline });
        self.runtime.custody_stop(deadline)?;
        peer.check_live()?;
        self.runtime.custody_snapshot(deadline)?;
        self.session.as_mut().ok_or_else(unavailable)?.stopped = true;
        Ok(())
    }
    fn match_observation(&self, request: &Header, fresh: &VerifiedCurrentImportStarted) -> Result<(), GatewayError> {
        if fresh.request().canonical_bytes()? != request.binding.canonical_bytes()?
            || !self.runtime.matches_custody_owner(&request.binding.native_owner_id, &request.binding.account_id_hash)
            || fresh.verified_at_ms() > crate::http_server::now_ms()?
            || fresh.deadline_ms() <= crate::http_server::now_ms()? {
            return Err(unavailable());
        }
        Ok(())
    }
    pub(super) fn recheck_import_session(
        &mut self,
        peer: &mut OwnedImportChildChannel,
        command: &ImportChildCommand,
        fresh: VerifiedCurrentImportStarted,
    ) -> Result<KernelSnapshot, GatewayError> {
        peer.require_pending(command)?;
        let header = command.header();
        let session = self.session.as_ref().ok_or_else(unavailable)?;
        if !session.stopped || header.session_ref != session.session_ref
            || header.challenge != session.challenge || header.binding.canonical_bytes()? != session.binding
            || fresh.request().canonical_bytes()? != session.binding
            || fresh.deadline_ms() <= crate::http_server::now_ms()? {
            return Err(unavailable());
        }
        peer.check_live()?;
        self.runtime.custody_snapshot(session.deadline)
    }
}
impl OwnedRuntime {
    pub(crate) fn into_custodian(self) -> Result<CustodianRuntime, GatewayError> {
        CustodianRuntime::from_owned(self)
    }
}
