//! Credential-free, request-owned fixed provider dial. Never a byte proxy.
use crate::{
    connector_fd::{ControlEndpoint, ReceiveProcess, Side},
    connector_protocol::{ControlError, ControlFrame, WIRE_VERSION},
};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use std::{
    io,
    net::{TcpStream, ToSocketAddrs},
    os::{
        fd::{AsFd, OwnedFd},
        unix::net::UnixStream,
    },
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

pub fn run_native_connector() -> ! {
    if crate::require_production_artifact().is_err() {
        std::process::exit(ControlError::UnsupportedPlatform.exit_code());
    }
    ReceiveProcess::run(|process| {
        crate::connector_policy::inherited_only_stdio()?;
        let owned = std::io::stdin()
            .as_fd()
            .try_clone_to_owned()
            .map_err(io_error)?;
        let stream = UnixStream::from(owned);
        crate::connector_policy::validate_unix_control(&stream)?;
        run_dial(stream, process.clone(), fixed_provider_dial)
    })
}

fn fixed_provider_dial(deadline: Instant) -> io::Result<TcpStream> {
    // Only this compiled literal supplies DNS and port. No proxy, URL or caller
    // target is consumed, and no provider/authentication material enters here.
    let mut last = io::Error::from(io::ErrorKind::NotConnected);
    for address in ("api.openai.com", 443).to_socket_addrs()? {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(io::ErrorKind::TimedOut)?;
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = error,
        }
    }
    Err(last)
}

// The private injection point is reachable only from the named test fixture
// module, never from a product destination or configuration.
pub fn run_dial(
    stream: UnixStream,
    process: Arc<ReceiveProcess>,
    dial: impl FnOnce(Instant) -> io::Result<TcpStream> + Send + 'static,
) -> Result<(), ControlError> {
    let mut endpoint = ControlEndpoint::new(
        stream.try_clone().map_err(io_error)?,
        Side::Connector,
        Duration::from_secs(10),
        process,
    )?;
    if let Err(error) = stream.set_read_timeout(None) {
        let events = channel_events(&stream, Duration::ZERO)?;
        if error.kind() != io::ErrorKind::InvalidInput || !events.contains(PollFlags::HUP) {
            return Err(io_error(error));
        }
    }
    let received = endpoint.receive()?;
    let ControlFrame::Connect { connection_id, .. } = received.frame else {
        return Err(ControlError::WrongState);
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    if channel_events(&stream, Duration::ZERO)?.contains(PollFlags::HUP) {
        return Err(ControlError::PeerClosed);
    }
    let (tx, rx) = mpsc::sync_channel(1);
    // DNS may block inside libc. This process's control loop remains able to
    // exit the entire process on EOF/cancel/deadline; no resolver survives it.
    let resolver = thread::spawn(move || {
        let _ = tx.send(dial(deadline));
    });
    loop {
        if Instant::now() >= deadline {
            return Err(ControlError::Io(io::ErrorKind::TimedOut));
        }
        let events = channel_events(&stream, Duration::from_millis(2))?;
        // Readability takes precedence over HUP: a valid final frame/rights can
        // still be queued when the peer has already exited.
        if events.contains(PollFlags::IN) {
            let received = endpoint.receive()?;
            return match received.frame {
                ControlFrame::Cancel {
                    connection_id: id, ..
                } if id == connection_id => {
                    endpoint.send(
                        ControlFrame::Cancelled {
                            v: WIRE_VERSION,
                            connection_id,
                        },
                        None,
                    )?;
                    Err(ControlError::Cancelled)
                }
                _ => Err(ControlError::WrongState),
            };
        }
        if events.intersects(PollFlags::HUP | PollFlags::ERR) {
            return Err(ControlError::PeerClosed);
        }
        match rx.try_recv() {
            Ok(Ok(connected)) => {
                resolver.join().map_err(|_| ControlError::Closed)?;
                let descriptor: OwnedFd = connected.into();
                return endpoint.send(
                    ControlFrame::Connected {
                        v: WIRE_VERSION,
                        connection_id,
                    },
                    Some(descriptor),
                );
            }
            Ok(Err(_)) => {
                resolver.join().map_err(|_| ControlError::Closed)?;
                return endpoint.send(
                    ControlFrame::Unavailable {
                        v: WIRE_VERSION,
                        connection_id,
                    },
                    None,
                );
            }
            Err(mpsc::TryRecvError::Disconnected) => return Err(ControlError::Closed),
            Err(mpsc::TryRecvError::Empty) => thread::sleep(Duration::from_millis(2)),
        }
    }
}
fn io_error(error: io::Error) -> ControlError {
    ControlError::Io(error.kind())
}

pub(crate) fn channel_events(
    stream: &UnixStream,
    wait: Duration,
) -> Result<PollFlags, ControlError> {
    let timeout = Timespec::try_from(wait).map_err(|_| ControlError::InvalidFrame)?;
    let mut descriptors = [PollFd::new(stream, PollFlags::IN)];
    poll(&mut descriptors, Some(&timeout)).map_err(|error| io_error(error.into()))?;
    let events = descriptors[0].revents();
    if events.contains(PollFlags::NVAL) {
        return Err(ControlError::InvalidDescriptor);
    }
    Ok(events)
}
