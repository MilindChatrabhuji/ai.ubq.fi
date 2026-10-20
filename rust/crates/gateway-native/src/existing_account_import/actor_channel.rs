//! Safe fixed-role Child/bootstrap channel. Neither an accepted socket nor JSON is custody.
use super::exclusive_owner::PinnedExecutable;
use crate::import_custody_protocol::{self as wire, Frame, Header, HeaderView, Stopped, unavailable};
use gateway_auth::crypto::sha256_hex;
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use std::{io::{Read, Write}, net::{SocketAddr, TcpListener, TcpStream}, os::fd::{AsFd, OwnedFd},
    path::Path, process::{Child, ChildStdin, Command, Stdio}, time::{Duration, Instant}};
const SANDBOX_SHA: &str = "e3d7a792c58a5d3783d2f7274c82d70062393830d8cb1ded713ca554a470bd2f";
const BOOTSTRAP_MAX: usize = 512;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Bootstrap {
    v: u8,
    session_ref: String,
    client_local: SocketAddr,
    client_peer: SocketAddr,
    custody_local: SocketAddr,
    custody_peer: SocketAddr,
}
impl Bootstrap {
    fn validate(&self) -> Result<(), GatewayError> {
        if self.v != 1 || !wire::hash(&self.session_ref)
            || [self.client_local, self.client_peer, self.custody_local, self.custody_peer]
                .iter().any(|a| !a.ip().is_loopback() || a.port() == 0)
            || self.custody_local == self.custody_peer {
            return Err(unavailable());
        }
        Ok(())
    }
}
/// A command obtained only by a live actual Child's retained opposite channel.
/// It is deliberately not a wire-deserializable authorization.
pub(super) struct ImportChildCommand {
    frame: Frame,
    digest: String,
}
impl ImportChildCommand {
    pub(super) fn header(&self) -> HeaderView<'_> { self.frame.header() }
    pub(super) fn is_quiesce(&self) -> bool { matches!(self.frame, Frame::Quiesce(_)) }
    pub(super) fn is_check(&self) -> bool { matches!(self.frame, Frame::CheckStopped(_)) }
    pub(super) fn is_cancel(&self) -> bool { matches!(self.frame, Frame::Cancel(_)) }
    pub(super) fn publication_revision(&self) -> Option<&str> {
        if let Frame::ReleaseAfterVerifiedTerminal(release) = &self.frame { Some(&release.publication_revision) } else { None }
    }
}
pub(super) struct OwnedImportChildChannel {
    child: Option<Child>,
    input: Option<ChildStdin>,
    socket: TcpStream,
    boot: Bootstrap,
    deadline: Instant,
    next_sequence: u64,
    pending: Option<String>,
    first_consumed: bool,
    binding: Option<Vec<u8>>,
    challenge: Option<String>,
}
impl OwnedImportChildChannel {
    // Fixed role only: no caller arguments, executable choice, environment or arbitrary profile API.
    // The sole trusted supervisor passes its hash-bound adjacent actor and generated exact policy.
    pub(super) fn launch(
        binary: &Path, digest: &str, client: TcpStream, daemon_config: &[u8],
        owner_root: &Path, replay_directory: &Path,
    ) -> Result<Self, GatewayError> {
        if !cfg!(target_os = "macos") || daemon_config.is_empty() || daemon_config.len() > 65_536 {
            return Err(unavailable());
        }
        let actor = PinnedExecutable::verify(binary, digest)?;
        let sandbox = PinnedExecutable::verify(Path::new("/usr/bin/sandbox-exec"), SANDBOX_SHA)?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|_| unavailable())?;
        let actor_socket = TcpStream::connect(listener.local_addr().map_err(|_| unavailable())?).map_err(|_| unavailable())?;
        let (socket, _) = listener.accept().map_err(|_| unavailable())?;
        drop(listener);
        let boot = Bootstrap { v: 1, session_ref: wire::random_ref()?,
            client_local: client.local_addr().map_err(|_| unavailable())?,
            client_peer: client.peer_addr().map_err(|_| unavailable())?,
            custody_local: actor_socket.local_addr().map_err(|_| unavailable())?,
            custody_peer: actor_socket.peer_addr().map_err(|_| unavailable())? };
        boot.validate()?;
        let profile = crate::connector_policy::import_actor(actor.path(), owner_root, replay_directory,
            boot.client_local, boot.client_peer, boot.custody_local, boot.custody_peer)
            .map_err(|_| unavailable())?;
        client.set_nonblocking(false).map_err(|_| unavailable())?;
        actor_socket.set_nonblocking(false).map_err(|_| unavailable())?;
        if rustix::fs::fcntl_getfl(&client).map_err(|_| unavailable())?.contains(rustix::fs::OFlags::NONBLOCK) {
            return Err(unavailable());
        }
        actor.recheck()?; sandbox.recheck()?;
        let client: OwnedFd = client.into();
        let control: OwnedFd = actor_socket.into();
        let mut child = Command::new(sandbox.path()).args(["-p", &profile]).arg(actor.path())
            .env_clear().current_dir(actor.path().parent().ok_or_else(unavailable)?)
            .stdin(Stdio::piped()).stdout(Stdio::from(client)).stderr(Stdio::from(control))
            .spawn().map_err(|_| unavailable())?;
        let input = child.stdin.take().ok_or_else(unavailable)?;
        let mut this = Self { child: Some(child), input: Some(input), socket, boot,
            deadline: Instant::now() + Duration::from_secs(50), next_sequence: 1,
            pending: None, first_consumed: false, binding: None, challenge: None };
        let bootstrap = serde_json::to_vec(&this.boot).map_err(|_| unavailable())?;
        if bootstrap.len() > BOOTSTRAP_MAX { return Err(unavailable()); }
        let input = this.input.as_mut().ok_or_else(unavailable)?;
        for bytes in [daemon_config, bootstrap.as_slice()] {
            input.write_all(&u32::try_from(bytes.len()).map_err(|_| unavailable())?.to_be_bytes()).map_err(|_| unavailable())?;
            input.write_all(bytes).map_err(|_| unavailable())?;
        }
        this.check_live()?;
        Ok(this)
    }
    pub(super) fn deadline(&self) -> Instant { self.deadline }
    pub(super) fn check_live(&mut self) -> Result<(), GatewayError> {
        if Instant::now() >= self.deadline || self.input.is_none()
            || self.child.as_mut().ok_or_else(unavailable)?.try_wait().map_err(|_| unavailable())?.is_some()
            || self.socket.local_addr().map_err(|_| unavailable())? != self.boot.custody_peer
            || self.socket.peer_addr().map_err(|_| unavailable())? != self.boot.custody_local {
            return Err(unavailable());
        }
        Ok(())
    }
    pub(super) fn receive(&mut self) -> Result<ImportChildCommand, GatewayError> {
        self.check_live()?;
        if self.pending.is_some() { return Err(unavailable()); }
        let frame = wire::receive(&mut self.socket, self.deadline, None)?;
        self.check_live()?;
        let h = frame.header();
        if h.sequence != self.next_sequence || h.session_ref != self.boot.session_ref
            || !matches!(frame, Frame::Quiesce(_) | Frame::CheckStopped(_) | Frame::Cancel(_) | Frame::ReleaseAfterVerifiedTerminal(_)) {
            return Err(unavailable());
        }
        let binding = h.binding.canonical_bytes()?;
        match (&self.binding, &self.challenge) {
            (Some(expected), Some(challenge)) if *expected == binding && challenge == h.challenge => (),
            (None, None) if matches!(frame, Frame::Quiesce(_) | Frame::Cancel(_)) => {
                self.binding = Some(binding); self.challenge = Some(h.challenge.into());
            },
            _ => return Err(unavailable()),
        }
        if self.first_consumed && matches!(frame, Frame::Quiesce(_)) { return Err(unavailable()); }
        let digest = sha256_hex(&frame.encode()?);
        self.pending = Some(digest.clone());
        Ok(ImportChildCommand { frame, digest })
    }
    pub(super) fn require_pending(&mut self, command: &ImportChildCommand) -> Result<(), GatewayError> {
        self.check_live()?;
        if self.pending.as_deref() != Some(command.digest.as_str())
            || sha256_hex(&command.frame.encode()?) != command.digest { return Err(unavailable()); }
        Ok(())
    }
    pub(super) fn consume_first_quiesce(&mut self, command: &ImportChildCommand) -> Result<Header, GatewayError> {
        self.require_pending(command)?;
        if self.first_consumed || !command.is_quiesce() { return Err(unavailable()); }
        self.first_consumed = true;
        command.header().copy_data()
    }
    pub(super) fn stopped(&mut self, command: &ImportChildCommand, snapshot: super::custodian_runtime::KernelSnapshot) -> Result<(), GatewayError> {
        self.require_pending(command)?;
        let h = command.header().copy_data()?;
        let response = Frame::Stopped(Stopped { v: 1, sequence: h.sequence, session_ref: h.session_ref,
            challenge: h.challenge, binding: h.binding, epoch: snapshot.epoch,
            root_device: snapshot.root_device, root_inode: snapshot.root_inode });
        self.reply(command, response)
    }
    fn reply(&mut self, command: &ImportChildCommand, response: Frame) -> Result<(), GatewayError> {
        self.require_pending(command)?;
        wire::send(&mut self.socket, &response, self.deadline, None)?;
        self.check_live()?;
        self.next_sequence = self.next_sequence.checked_add(1).ok_or_else(unavailable)?;
        self.pending.take();
        Ok(())
    }
    pub(super) fn refuse(&mut self, command: &ImportChildCommand) -> Result<(), GatewayError> {
        self.reply(command, Frame::Unknown(command.header().copy_data()?))
    }
}
impl Drop for OwnedImportChildChannel {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
        if let Some(mut child) = self.child.take() {
            if child.try_wait().ok().flatten().is_none() { let _ = child.kill(); }
            let _ = child.wait();
        }
    }
}

pub(super) struct InheritedCustodyChannel {
    pub(super) socket: TcpStream,
    pub(super) session_ref: String,
    pub(super) next_sequence: u64,
}
pub(super) struct ActorBootstrap {
    pub(super) config: Vec<u8>,
    pub(super) client: TcpStream,
    pub(super) custody: InheritedCustodyChannel,
}
impl ActorBootstrap {
    // Only the fixed parameterless import role calls this, before any thread or FD clone.
    pub(super) fn from_stdio() -> Result<Self, GatewayError> {
        crate::connector_policy::inherited_only_stdio().map_err(|_| unavailable())?;
        let stdin = std::io::stdin();
        if rustix::fs::FileType::from_raw_mode(rustix::fs::fstat(&stdin).map_err(|_| unavailable())?.st_mode)
            != rustix::fs::FileType::Fifo { return Err(unavailable()); }
        let mut input = stdin.lock();
        let config = bootstrap_part(&mut input, 65_536)?;
        let boot: Bootstrap = serde_json::from_slice(&bootstrap_part(&mut input, BOOTSTRAP_MAX)?).map_err(|_| unavailable())?;
        boot.validate()?;
        let stdout = std::io::stdout(); let stderr = std::io::stderr();
        for fd in [stdout.as_fd(), stderr.as_fd()] {
            if rustix::net::sockopt::socket_type(fd).map_err(|_| unavailable())? != rustix::net::SocketType::STREAM {
                return Err(unavailable());
            }
        }
        let client = TcpStream::from(stdout.as_fd().try_clone_to_owned().map_err(|_| unavailable())?);
        let socket = TcpStream::from(stderr.as_fd().try_clone_to_owned().map_err(|_| unavailable())?);
        if client.local_addr().map_err(|_| unavailable())? != boot.client_local
            || client.peer_addr().map_err(|_| unavailable())? != boot.client_peer
            || socket.local_addr().map_err(|_| unavailable())? != boot.custody_local
            || socket.peer_addr().map_err(|_| unavailable())? != boot.custody_peer { return Err(unavailable()); }
        Ok(Self { config, client, custody: InheritedCustodyChannel { socket, session_ref: boot.session_ref, next_sequence: 1 } })
    }
}
fn bootstrap_part(input: &mut impl Read, maximum: usize) -> Result<Vec<u8>, GatewayError> {
    let mut length = [0; 4]; input.read_exact(&mut length).map_err(|_| unavailable())?;
    let length = usize::try_from(u32::from_be_bytes(length)).map_err(|_| unavailable())?;
    if length == 0 || length > maximum { return Err(unavailable()); }
    let mut bytes = vec![0; length]; input.read_exact(&mut bytes).map_err(|_| unavailable())?;
    Ok(bytes)
}
