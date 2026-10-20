use super::{LiveAuthorization, NativeLiveAuthority, unavailable};
use gateway_auth::GatewayError;
use rustls::{ClientConfig, ClientConnection, StreamOwned, pki_types::ServerName};
use std::{
    io::{self, Read, Write},
    net::TcpStream,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tungstenite::{WebSocket, client::IntoClientRequest, handshake::HandshakeError};

/// A fixed destination capability. Implementations must prove the OS boundary
/// and may never derive a destination from an action, URL, account or bearer.
pub trait NativeLiveConnector: Send + Sync {
    fn connect(&self, context: &LiveDialContext) -> Result<TcpStream, GatewayError>;
}
pub struct LiveDialContext {
    alive: Arc<AtomicBool>,
    downstream: TcpStream,
    deadline: Instant,
    connector_frame: Option<crate::connector_protocol::ControlFrame>,
}
impl LiveDialContext {
    pub(super) fn new(alive: Arc<AtomicBool>, downstream: TcpStream, deadline: Instant) -> Self {
        Self {
            alive,
            downstream,
            deadline,
            connector_frame: None,
        }
    }
    fn for_authorization(&self, authorization: &LiveAuthorization) -> Result<Self, GatewayError> {
        self.check()?;
        let mut context = Self::new(
            self.alive.clone(),
            self.downstream.try_clone().map_err(|_| unavailable())?,
            self.deadline,
        );
        let frame = crate::connector_protocol::ControlFrame::Connect {
            v: 1,
            channel: crate::connector_protocol::Channel::ProviderLive,
            action_ref: authorization.action_ref.clone(),
            connection_id: authorization.connection_id.clone(),
            authorization_ref: authorization.authorization_ref.clone(),
        };
        frame.validate().map_err(|_| unavailable())?;
        context.connector_frame = Some(frame);
        Ok(context)
    }
    pub(crate) fn connector_frame(
        &self,
    ) -> Result<crate::connector_protocol::ControlFrame, GatewayError> {
        self.check()?;
        self.connector_frame.clone().ok_or_else(unavailable)
    }
    pub fn check(&self) -> Result<(), GatewayError> {
        if !self.alive.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
            || matches!(self.downstream.peek(&mut [0; 1]), Ok(0))
        {
            return Err(unavailable());
        }
        Ok(())
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
    pub fn remaining(&self) -> Result<Duration, GatewayError> {
        self.check()?;
        self.deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(unavailable)
    }
}
pub struct DeadlineSocket {
    stream: TcpStream,
    deadline: Option<Instant>,
}
impl DeadlineSocket {
    fn timeout(&self) -> io::Result<Option<Duration>> {
        self.deadline
            .map(|at| {
                at.checked_duration_since(Instant::now())
                    .filter(|d| !d.is_zero())
                    .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
            })
            .transpose()
    }
}
impl Read for DeadlineSocket {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.stream.set_read_timeout(self.timeout()?)?;
        self.stream.read(bytes)
    }
}
impl Write for DeadlineSocket {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(self.timeout()?)?;
        self.stream.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}
pub(super) type UpstreamSocket = StreamOwned<ClientConnection, DeadlineSocket>;
pub(super) enum DialResult {
    Connected(Box<WebSocket<UpstreamSocket>>),
    Rejected(Box<LiveAuthorization>, u16),
    Failed,
}

pub(super) fn dial(
    authority: &dyn NativeLiveAuthority,
    connector: &dyn NativeLiveConnector,
    tls: Arc<ClientConfig>,
    server_name: ServerName<'static>,
    mut authorization: LiveAuthorization,
    context: &LiveDialContext,
) -> DialResult {
    // The initial short-lived projection is no longer needed after admission.
    // Every actual dial obtains the current same-account projection independently.
    drop(authorization.access.take());
    let result = (|| {
        context.check()?;
        let (fence, access) = authority.recheck(&authorization, context.deadline())?;
        drop(access);
        authorization.fence = fence;
        context.check()?;
        let stream = connector.connect(&context.for_authorization(&authorization)?)?;
        context.check()?;
        let mut conn = ClientConnection::new(tls, server_name).map_err(|_| unavailable())?;
        // Only one charged WebSocket frame enters TLS at a time. Its complete
        // charge remains until StreamOwned::flush drains ciphertext as well.
        conn.set_buffer_limit(Some(super::MAX_PAYLOAD_BYTES + 64));
        let mut socket = DeadlineSocket {
            stream,
            deadline: Some(context.deadline()),
        };
        while conn.is_handshaking() {
            context.check()?;
            conn.complete_io(&mut socket).map_err(|_| unavailable())?;
        }
        context.check()?;
        let (fence, access) = authority.recheck(&authorization, context.deadline())?;
        authorization.fence = fence;
        let call = encode_component(&authorization.fence.call_id);
        let mut request = format!("wss://api.openai.com/v1/live/{call}")
            .into_client_request()
            .map_err(|_| unavailable())?;
        let headers = request.headers_mut();
        for (name, value) in [
            ("authorization", format!("Bearer {}", access.expose())),
            ("chatgpt-account-id", authorization.fence.account_id.clone()),
            ("originator", "codex_cli_rs".into()),
            ("user-agent", "codex_cli_rs/0.100.0 (ai.ubq.fi)".into()),
            ("openai-alpha", "quicksilver=v2".into()),
        ] {
            headers.insert(
                tungstenite::http::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| unavailable())?,
                value.parse().map_err(|_| unavailable())?,
            );
        }
        drop(access);
        context.check()?;
        let stream = StreamOwned::new(conn, socket);
        let mut socket = match tungstenite::client::client_with_config(
            request,
            stream,
            Some(super::queue::websocket_config()),
        ) {
            Ok((socket, _)) => socket,
            Err(HandshakeError::Failure(tungstenite::Error::Http(response))) => {
                return Ok(Err(response.status().as_u16()));
            }
            Err(_) => return Err(unavailable()),
        };
        context.check()?;
        let (current, access) = authority.recheck(&authorization, context.deadline())?;
        drop(access);
        if current.credential_version != authorization.fence.credential_version {
            return Err(unavailable());
        }
        socket.get_mut().sock.deadline = None;
        socket
            .get_mut()
            .sock
            .stream
            .set_nonblocking(true)
            .map_err(|_| unavailable())?;
        Ok(Ok(socket))
    })();
    match result {
        Ok(Ok(socket)) => DialResult::Connected(Box::new(socket)),
        Ok(Err(status)) => DialResult::Rejected(Box::new(authorization), status),
        Err(_) => DialResult::Failed,
    }
}
pub(super) fn encode_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            output.push(char::from(byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            output.push('%');
            output.push(char::from(HEX[usize::from(byte >> 4)]));
            output.push(char::from(HEX[usize::from(byte & 15)]));
        }
    }
    output
}
