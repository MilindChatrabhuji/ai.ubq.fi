//! An inherited native client is served in one expendable process. No listener.
use crate::{
    connector_fd::{ControlEndpoint, ReceiveProcess, Side},
    connector_protocol::{ControlError, ControlFrame},
    daemon_config::NativeDaemonConfig,
    live_bridge::{LiveDialContext, NativeLiveConnector},
};
use gateway_auth::GatewayError;
use rustix::event::PollFlags;
use std::{
    io::{self, Read},
    net::TcpStream,
    os::{fd::AsFd, unix::net::UnixStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
pub fn run_native_request() -> ! {
    if crate::require_production_artifact().is_err() {
        std::process::exit(ControlError::UnsupportedPlatform.exit_code());
    }
    ReceiveProcess::run(|process| {
        crate::connector_policy::inherited_only_stdio()?;
        let mode = rustix::fs::fstat(std::io::stdin())
            .map_err(|_| ControlError::InvalidDescriptor)?
            .st_mode;
        let input_type = rustix::fs::FileType::from_raw_mode(mode);
        if !matches!(
            input_type,
            rustix::fs::FileType::Fifo | rustix::fs::FileType::Socket
        ) {
            return Err(ControlError::InvalidDescriptor);
        }
        let bootstrap = if input_type == rustix::fs::FileType::Socket {
            let channel = UnixStream::from(
                std::io::stdin()
                    .as_fd()
                    .try_clone_to_owned()
                    .map_err(io_error)?,
            );
            crate::connector_policy::validate_unix_control(&channel)?;
            crate::daemon_startup::live_bootstrap::read_timeout(
                &channel,
                Some(Duration::from_secs(10)),
            )?;
            Some(channel)
        } else {
            None
        };
        let mut bytes = if let Some(channel) = &bootstrap {
            crate::daemon_startup::live_bootstrap::read_config(channel, process)?
        } else {
            // The retained FIFO transport has no ancillary channel. Keep its
            // exact bounded, unbuffered framing and existing version rules.
            let mut input = std::fs::File::from(
                std::io::stdin()
                    .as_fd()
                    .try_clone_to_owned()
                    .map_err(io_error)?,
            );
            let mut header = [0; 4];
            input.read_exact(&mut header).map_err(io_error)?;
            let length = usize::try_from(u32::from_be_bytes(header))
                .map_err(|_| ControlError::InvalidFrame)?;
            if length == 0 || length > 65_536 {
                return Err(ControlError::FrameTooLarge);
            }
            let mut bytes = vec![0; length];
            input.read_exact(&mut bytes).map_err(io_error)?;
            bytes
        };
        let config = NativeDaemonConfig::read_stdin(bytes.as_slice())
            .map_err(|_| ControlError::InvalidFrame)?;
        // No guess for the separate reverse authority origin/FD bootstrap.
        if config.owner_renewal.is_some() {
            return Err(ControlError::UnsupportedPlatform);
        }
        let (reverse, bootstrap) = if config.live_sideband.is_some() {
            if input_type != rustix::fs::FileType::Socket {
                return Err(ControlError::InvalidDescriptor);
            }
            let channel = bootstrap.ok_or(ControlError::InvalidDescriptor)?;
            let socket = crate::daemon_startup::live_bootstrap::receive(&channel, &bytes, process)?;
            crate::daemon_startup::live_bootstrap::read_timeout(&channel, None)?;
            (Some(socket), Some(channel))
        } else {
            if input_type != rustix::fs::FileType::Fifo {
                return Err(ControlError::InvalidDescriptor);
            }
            (None, None)
        };
        bytes.fill(0);
        if rustix::net::sockopt::socket_type(std::io::stdout())
            .map_err(|_| ControlError::InvalidDescriptor)?
            != rustix::net::SocketType::STREAM
        {
            return Err(ControlError::InvalidDescriptor);
        }
        let mut client = TcpStream::from(
            std::io::stdout()
                .as_fd()
                .try_clone_to_owned()
                .map_err(io_error)?,
        );
        if !client.peer_addr().map_err(io_error)?.ip().is_loopback() {
            return Err(ControlError::InvalidDescriptor);
        }
        let control = UnixStream::from(
            std::io::stderr()
                .as_fd()
                .try_clone_to_owned()
                .map_err(io_error)?,
        );
        let completed = Arc::new(AtomicBool::new(false));
        let connector = Arc::new(RequestConnector::new(
            control,
            process.clone(),
            completed.clone(),
        )?);
        let command_process = process.clone();
        thread::spawn(move || {
            // The supervisor is the sole writer. EOF or a finite cancel byte
            // terminates even while another request thread is blocked in I/O.
            loop {
                let command = if let Some(channel) = &bootstrap {
                    crate::daemon_startup::live_bootstrap::completion(channel, &command_process)
                } else {
                    let mut command = [0];
                    match std::io::stdin().read(&mut command) {
                        Ok(1) => Ok(command[0]),
                        _ => Err(ControlError::Cancelled),
                    }
                };
                match command {
                    Ok(1) => completed.store(true, Ordering::Release),
                    _ => std::process::exit(ControlError::Cancelled.exit_code()),
                }
            }
        });
        crate::daemon_startup::request_service(config, connector, reverse)
            .map_err(|_| ControlError::InvalidFrame)?
            .serve_connection(&mut client)
            .map_err(|_| ControlError::Closed)
    })
}

pub(crate) struct RequestConnector {
    control: Mutex<Option<UnixStream>>,
    process: Arc<ReceiveProcess>,
    completed: Arc<AtomicBool>,
}
impl RequestConnector {
    pub(crate) fn new(
        control: UnixStream,
        process: Arc<ReceiveProcess>,
        completed: Arc<AtomicBool>,
    ) -> Result<Self, ControlError> {
        crate::connector_policy::validate_unix_control(&control)?;
        Ok(Self {
            control: Mutex::new(Some(control)),
            process,
            completed,
        })
    }
}
impl NativeLiveConnector for RequestConnector {
    fn connect(&self, context: &LiveDialContext) -> Result<TcpStream, GatewayError> {
        context.check()?;
        let frame = context.connector_frame()?;
        let control = self
            .control
            .lock()
            .map_err(|_| unavailable())?
            .take()
            .ok_or_else(unavailable)?;
        let mut endpoint = ControlEndpoint::new(
            control.try_clone().map_err(|_| unavailable())?,
            Side::Parent,
            context.remaining()?,
            self.process.clone(),
        )
        .map_err(|_| unavailable())?;
        context.check()?;
        endpoint.send(frame, None).map_err(|_| unavailable())?;
        loop {
            if let Err(error) = context.check() {
                // Drop both local owned channel handles; the whole request
                // process then exits through its ordinary terminal path.
                endpoint.close();
                return Err(error);
            }
            let events =
                crate::connector_worker::channel_events(&control, Duration::from_millis(2))
                    .map_err(|_| unavailable())?;
            if events.contains(PollFlags::IN) {
                break;
            }
            if events.intersects(PollFlags::HUP | PollFlags::ERR) {
                return Err(unavailable());
            }
        }
        if let Err(error) = control.set_read_timeout(Some(context.remaining()?)) {
            let ended = crate::connector_worker::channel_events(&control, Duration::ZERO)
                .map_err(|_| unavailable())?
                .contains(PollFlags::HUP);
            if error.kind() != io::ErrorKind::InvalidInput || !ended {
                return Err(unavailable());
            }
        }
        let received = endpoint.receive().map_err(|_| unavailable())?;
        context.check()?;
        if !matches!(received.frame, ControlFrame::Connected { .. }) {
            return Err(unavailable());
        }
        let stream = TcpStream::from(received.descriptor.ok_or_else(unavailable)?);
        if stream.peer_addr().map_err(|_| unavailable())?.port() != 443 {
            return Err(unavailable());
        }
        // Provider TLS/bearer use waits for the supervisor's actual clean
        // connector Child wait; receiving a descriptor alone is insufficient.
        while !self.completed.load(Ordering::Acquire) {
            context.check()?;
            thread::sleep(Duration::from_millis(2));
        }
        context.check()?;
        Ok(stream)
    }
}
fn io_error(error: io::Error) -> ControlError {
    ControlError::Io(error.kind())
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Private native connector unavailable",
        "native_connector_unavailable",
    )
}

#[cfg(all(test, target_os = "macos"))]
mod tests;
