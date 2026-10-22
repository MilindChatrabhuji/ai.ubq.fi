//! Fixed actual Child service. No credentials, import document or raw fd enters it.
use super::{CustodianRuntime, actor_channel::OwnedImportChildChannel};
use crate::import_custody_protocol::unavailable;
use gateway_auth::native_auth::NativeTransportIdentity;
use gateway_authority::native_control::NativeRenewalCancellation;
use gateway_core::GatewayError;
use std::{
    net::TcpStream,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct OwnedPeerCancellation(Arc<Mutex<OwnedImportChildChannel>>);
impl NativeRenewalCancellation for OwnedPeerCancellation {
    fn cancelled(&self) -> bool {
        self.0
            .lock()
            .map(|mut peer| peer.check_live().is_err())
            .unwrap_or(true)
    }
}
pub(super) fn serve(
    runtime: &mut CustodianRuntime,
    peer: OwnedImportChildChannel,
    authority_origin: &str,
    authority_socket: TcpStream,
    identity: NativeTransportIdentity,
) -> Result<(), GatewayError> {
    let deadline = peer
        .deadline()
        .min(Instant::now() + Duration::from_secs(45));
    let peer = Arc::new(Mutex::new(peer));
    let cancellation = OwnedPeerCancellation(peer.clone());
    let authority = super::import_endpoints::fixed_authority_client(
        authority_origin,
        authority_socket,
        identity,
        &cancellation,
        deadline,
    )?;
    loop {
        let command = peer.lock().map_err(|_| unavailable())?.receive()?;
        if command.is_quiesce() {
            let fresh = authority.verify_started_custody(command.header().binding)?;
            {
                let mut peer = peer.lock().map_err(|_| unavailable())?;
                runtime.open_import_session(&mut peer, &command, fresh)?;
            }
            // Recheck CURRENT Started after actual kill/wait/kernel settlement,
            // before the first Stopped reply can reach the actor.
            let fresh = authority.verify_started_custody(command.header().binding)?;
            let mut peer = peer.lock().map_err(|_| unavailable())?;
            let snapshot = runtime.recheck_import_session(&mut peer, &command, fresh)?;
            peer.stopped(&command, snapshot)?;
        } else if command.is_check() {
            let fresh = authority.verify_started_custody(command.header().binding)?;
            let mut peer = peer.lock().map_err(|_| unavailable())?;
            let snapshot = runtime.recheck_import_session(&mut peer, &command, fresh)?;
            peer.stopped(&command, snapshot)?;
        } else if let Some(revision) = command.publication_revision() {
            let fresh = authority.verify_custody_terminal(command.header().binding, revision)?;
            let mut peer = peer.lock().map_err(|_| unavailable())?;
            runtime.release_import_session(&mut peer, &command, fresh)?;
            // Keep the sole parent pipe/channel alive until the actual actor
            // has written its response and exited. Never kill it on release.
            return peer.settle_completed();
        } else {
            let mut peer = peer.lock().map_err(|_| unavailable())?;
            peer.refuse(&command)?;
            // Cancel never stops a still-running writer, releases an uncertain
            // epoch, restarts a daemon or manufactures a terminal observation.
            return Err(unavailable());
        }
    }
}
