//! Registry-bound Unix websocket adapter. This module never launches a process or refreshes OAuth itself.
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use gateway_core::GatewayError;
use serde_json::{Value, json};
use socket2::{Domain, SockAddr, Socket as OsSocket, Type};
use tungstenite::{
    Message, WebSocket,
    client::{IntoClientRequest, client_with_config},
    protocol::WebSocketConfig,
};

use crate::{
    NativeCredentials, NativeOwnerId, NativeOwnerTransport, RenewalStep, SupervisorMethod,
    SupervisorTransport, owner_unavailable, parse_native_document,
    supervisor::{RENEWAL_FRAME_LIMIT, SUPERVISOR_FRAME_LIMIT},
};

struct DeadlineStream {
    stream: UnixStream,
    deadline: Instant,
}
impl DeadlineStream {
    fn remaining(&self) -> io::Result<Duration> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Native transport deadline elapsed",
            ))
        } else {
            Ok(remaining)
        }
    }
}
impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(buffer)
    }
}
impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.flush()
    }
}

struct Socket {
    socket: WebSocket<DeadlineStream>,
    serial: u64,
    call_timeout: Duration,
    overall_deadline: Option<Instant>,
    failed: bool,
}
impl Socket {
    fn open_until(
        path: &Path,
        max_payload: usize,
        call_timeout: Duration,
        overall_deadline: Option<Instant>,
    ) -> Result<Self, GatewayError> {
        let handshake_deadline = overall_deadline
            .map_or(Instant::now() + Duration::from_secs(3), |deadline| {
                deadline.min(Instant::now() + Duration::from_secs(3))
            });
        let remaining = handshake_deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(owner_unavailable)?;
        let socket =
            OsSocket::new(Domain::UNIX, Type::STREAM, None).map_err(|_| owner_unavailable())?;
        let address = SockAddr::unix(path).map_err(|_| owner_unavailable())?;
        socket
            .connect_timeout(&address, remaining)
            .map_err(|_| owner_unavailable())?;
        let owned_fd: std::os::fd::OwnedFd = socket.into();
        let stream = DeadlineStream {
            stream: UnixStream::from(owned_fd),
            deadline: handshake_deadline,
        };
        let mut request = "ws://localhost/"
            .into_client_request()
            .map_err(|_| owner_unavailable())?;
        request.headers_mut().insert(
            "host",
            tungstenite::http::HeaderValue::from_static("localhost"),
        );
        // No Sec-WebSocket-Extensions offer: permessage-deflate stays disabled.
        let config = WebSocketConfig::default()
            .max_message_size(Some(max_payload))
            .max_frame_size(Some(max_payload));
        let (socket, _) =
            client_with_config(request, stream, Some(config)).map_err(|_| owner_unavailable())?;
        Ok(Self {
            socket,
            serial: 0,
            call_timeout,
            overall_deadline,
            failed: false,
        })
    }
    fn notify_initialized(&mut self) -> Result<(), GatewayError> {
        self.socket
            .send(Message::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .map_err(|_| owner_unavailable())
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Value, GatewayError> {
        if self.failed {
            return Err(owner_unavailable());
        }
        let result = self.call_inner(method, params);
        if result.is_err() {
            // The pinned parser can retain a rejected frame header. Never read
            // that connection again, including during close or a later RPC.
            self.failed = true;
            let _ = self.socket.get_mut().stream.shutdown(Shutdown::Both);
        }
        result
    }
    fn call_inner(&mut self, method: &str, params: Value) -> Result<Value, GatewayError> {
        self.serial = self.serial.checked_add(1).ok_or_else(owner_unavailable)?;
        let id = self.serial;
        let call_deadline = Instant::now() + self.call_timeout;
        let deadline = self
            .overall_deadline
            .map_or(call_deadline, |overall| overall.min(call_deadline));
        self.socket.get_mut().deadline = deadline;
        self.socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .map_err(|_| owner_unavailable())?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(owner_unavailable());
            }
            let message = self.socket.read().map_err(|_| owner_unavailable())?;
            let text = match message {
                Message::Text(text) => text.to_string(),
                Message::Binary(bytes) => {
                    String::from_utf8(bytes.to_vec()).map_err(|_| owner_unavailable())?
                }
                Message::Ping(_) => {
                    self.socket.flush().map_err(|_| owner_unavailable())?;
                    continue;
                }
                Message::Close(_) => return Err(owner_unavailable()),
                _ => continue,
            };
            let Ok(reply) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if reply.get("error").is_some() {
                return Err(owner_unavailable());
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    fn close(&mut self) {
        if self.failed {
            let _ = self.socket.get_mut().stream.shutdown(Shutdown::Both);
            return;
        }
        let grace = Duration::from_millis(250);
        let close_deadline = Instant::now() + grace;
        self.socket.get_mut().deadline = self
            .overall_deadline
            .map_or(close_deadline, |overall| overall.min(close_deadline));
        if self.socket.close(None).is_ok() && self.socket.flush().is_ok() {
            // Healthy connections retain the source's bounded close grace.
            // Stop at the first error: a rejected header must not be read twice.
            while Instant::now() < self.socket.get_ref().deadline {
                match self.socket.read() {
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }
        let _ = self.socket.get_mut().stream.shutdown(Shutdown::Both);
        self.failed = true;
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        let _ = self.socket.get_mut().stream.shutdown(Shutdown::Both);
    }
}

/// Constructed only from local operator-owned configuration, never HTTP payloads.
#[derive(Clone, Debug)]
pub struct NativeOwnerLocation {
    pub owner: NativeOwnerId,
    home: PathBuf,
}
impl NativeOwnerLocation {
    pub fn configured(owner: NativeOwnerId, home: PathBuf) -> Result<Self, GatewayError> {
        if !home.is_absolute() || owner.0.is_empty() {
            return Err(owner_unavailable());
        }
        Ok(Self { owner, home })
    }
}

pub struct UnixOwnerTransport {
    locations: BTreeMap<String, PathBuf>,
    sockets: RefCell<BTreeMap<String, Socket>>,
    deadline: Option<Instant>,
}
impl UnixOwnerTransport {
    pub fn new(locations: Vec<NativeOwnerLocation>) -> Result<Self, GatewayError> {
        Self::configured(locations, None)
    }
    /// The control receiver supplies its original absolute 45-second lease.
    /// Handshakes and individual RPCs retain their smaller source deadlines.
    pub fn until(
        locations: Vec<NativeOwnerLocation>,
        deadline: Instant,
    ) -> Result<Self, GatewayError> {
        Self::configured(locations, Some(deadline))
    }
    fn configured(
        locations: Vec<NativeOwnerLocation>,
        deadline: Option<Instant>,
    ) -> Result<Self, GatewayError> {
        if !(1..=2).contains(&locations.len()) {
            return Err(owner_unavailable());
        }
        let mut homes = BTreeMap::new();
        for location in locations {
            if homes.values().any(|home| home == &location.home) {
                return Err(owner_unavailable());
            }
            if homes.insert(location.owner.0, location.home).is_some() {
                return Err(owner_unavailable());
            }
        }
        Ok(Self {
            locations: homes,
            sockets: RefCell::new(BTreeMap::new()),
            deadline,
        })
    }
    fn home(&self, owner: &NativeOwnerId) -> Result<&PathBuf, GatewayError> {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(owner_unavailable());
        }
        self.locations.get(&owner.0).ok_or_else(owner_unavailable)
    }
}

impl NativeOwnerTransport for UnixOwnerTransport {
    async fn read_credentials(
        &self,
        owner: &NativeOwnerId,
    ) -> Result<NativeCredentials, GatewayError> {
        let home = self.home(owner)?;
        let path = home.join("auth.json");
        let metadata = fs::metadata(&path).map_err(|_| owner_unavailable())?;
        if !metadata.is_file() || metadata.len() > 1_048_576 {
            return Err(owner_unavailable());
        }
        let bytes = fs::read(path).map_err(|_| owner_unavailable())?;
        let value = serde_json::from_slice(&bytes).map_err(|_| owner_unavailable())?;
        parse_native_document(&value)
    }
    async fn request(
        &self,
        owner: &NativeOwnerId,
        step: RenewalStep,
    ) -> Result<Value, GatewayError> {
        let home = self.home(owner)?;
        let mut sockets = self.sockets.borrow_mut();
        if step == RenewalStep::Initialize {
            if let Some(mut old) = sockets.remove(&owner.0) {
                old.close();
            }
            let socket = Socket::open_until(
                &home.join("app-server-control/app-server-control.sock"),
                RENEWAL_FRAME_LIMIT,
                Duration::from_secs(12),
                self.deadline,
            )?;
            sockets.insert(owner.0.clone(), socket);
        }
        let socket = sockets.get_mut(&owner.0).ok_or_else(owner_unavailable)?;
        let (method, params) = step.wire();
        socket.call(method, params)
    }
    async fn verify_initialized_home(
        &self,
        owner: &NativeOwnerId,
        reply: &Value,
    ) -> Result<(), GatewayError> {
        let configured = fs::canonicalize(self.home(owner)?).map_err(|_| owner_unavailable())?;
        let reported = reply
            .get("codexHome")
            .and_then(Value::as_str)
            .ok_or_else(owner_unavailable)?;
        if fs::canonicalize(reported).map_err(|_| owner_unavailable())? != configured {
            return Err(owner_unavailable());
        }
        Ok(())
    }
    async fn initialized(&self, owner: &NativeOwnerId) -> Result<(), GatewayError> {
        self.sockets
            .borrow_mut()
            .get_mut(&owner.0)
            .ok_or_else(owner_unavailable)?
            .notify_initialized()
    }
    async fn close(&self, owner: &NativeOwnerId) -> Result<(), GatewayError> {
        if let Some(mut socket) = self.sockets.borrow_mut().remove(&owner.0) {
            socket.close();
        }
        Ok(())
    }
}

pub struct UnixSupervisor {
    socket: Socket,
}
impl UnixSupervisor {
    /// Path comes only from the trusted native source registry, never a public request.
    pub fn configured_socket(path: &Path) -> Result<Self, GatewayError> {
        Self::configured(path, None)
    }
    pub fn configured_socket_until(path: &Path, deadline: Instant) -> Result<Self, GatewayError> {
        Self::configured(path, Some(deadline))
    }
    fn configured(path: &Path, deadline: Option<Instant>) -> Result<Self, GatewayError> {
        if !path.is_absolute() {
            return Err(owner_unavailable());
        }
        let mut socket = Socket::open_until(
            path,
            SUPERVISOR_FRAME_LIMIT,
            Duration::from_secs(4),
            deadline,
        )?;
        socket.call(SupervisorMethod::Initialize.as_str(),json!({"clientInfo":{"name":"uos_supervisor","version":"1"},"capabilities":{"experimentalApi":true}}))?;
        socket.notify_initialized()?;
        Ok(Self { socket })
    }
}
impl SupervisorTransport for UnixSupervisor {
    async fn call(
        &mut self,
        method: SupervisorMethod,
        params: Value,
    ) -> Result<Value, GatewayError> {
        self.socket.call(method.as_str(), params)
    }
    async fn close(&mut self) -> Result<(), GatewayError> {
        self.socket.close();
        Ok(())
    }
}
