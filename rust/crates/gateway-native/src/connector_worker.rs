//! Credential-free, request-owned fixed provider dial. Never a byte proxy.
use crate::{
    connector_fd::{ControlEndpoint, ReceiveProcess, Side},
    connector_protocol::{ControlError, ControlFrame, WIRE_VERSION},
};
use socket2::SockRef;
use std::{
    io,
    mem::MaybeUninit,
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
    ReceiveProcess::run(|process| {
        let owned = std::io::stdin()
            .as_fd()
            .try_clone_to_owned()
            .map_err(io_error)?;
        let stream = UnixStream::from(owned);
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

// The private injection point is compiled into the named test fixture only via
// its same-module source inclusion, never a product destination/configuration.
pub(crate) fn run_dial(
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
    stream.set_read_timeout(None).map_err(io_error)?;
    let received = endpoint.receive()?;
    let ControlFrame::Connect { connection_id, .. } = received.frame else {
        return Err(ControlError::WrongState);
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    stream.set_nonblocking(true).map_err(io_error)?;
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
        match SockRef::from(&stream).peek(&mut [MaybeUninit::uninit(); 1]) {
            Ok(0) => return Err(ControlError::PeerClosed),
            Ok(_) => {
                stream.set_nonblocking(false).map_err(io_error)?;
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
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(io_error(error)),
        }
        match rx.try_recv() {
            Ok(Ok(connected)) => {
                resolver.join().map_err(|_| ControlError::Closed)?;
                let descriptor: OwnedFd = connected.into();
                stream.set_nonblocking(false).map_err(io_error)?;
                return endpoint.send(
                    ControlFrame::Connected {
                        v: WIRE_VERSION,
                        connection_id,
                    },
                    Some(descriptor),
                );
            }
            Ok(Err(_)) => {
                stream.set_nonblocking(false).map_err(io_error)?;
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
