//! One finite native sideband connection. The trusted connector is fixed to the
//! approved destination; no URL or credential is accepted from the upgrade.
mod authority;
mod queue;
mod socket;
pub use authority::{LiveAuthorization, NativeLiveAuthority, NativeLiveAuthorityHttp};
use gateway_auth::{GatewayError, crypto::base64url, native_live::AuthenticatedNativeLive};
use gateway_authority::native_live::NativeLiveRetirement;
use queue::{PendingSocket, PreopenQueue, blocked, websocket_config};
pub use socket::{LiveDialContext, NativeLiveConnector};
use std::{
    io::Write,
    net::TcpStream,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Message, WebSocket,
    handshake::server::{create_response, write_response},
    protocol::{
        Role,
        frame::{CloseFrame, coding::CloseCode},
    },
};

pub const MAX_PAYLOAD_BYTES: usize = 4 * 1_048_576;
pub const MAX_BUFFERED_BYTES: usize = 8 * 1_048_576;
pub const PREOPEN_MAX_FRAMES: usize = 32;
pub const HANDSHAKE_TIMEOUT_MS: u64 = 10_000;

pub struct NativeLiveUpgradeRequest {
    pub action_ref: String,
    pub headers: Vec<(String, String)>,
    /// Bytes already read after the HTTP header, including immediate frames.
    pub buffered: Vec<u8>,
}
/// Neither variant is an upstream or delivery-success receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeLiveOutcome {
    CloseRequested { code: u16 },
    TransportUnknown,
}
pub trait NativeLiveHandler: Send + Sync {
    fn handle(
        &self,
        stream: &mut TcpStream,
        request: NativeLiveUpgradeRequest,
        proof: AuthenticatedNativeLive,
    ) -> Result<NativeLiveOutcome, GatewayError>;
}
pub struct NativeLiveService {
    authority: Arc<dyn NativeLiveAuthority>,
    connector: Arc<dyn NativeLiveConnector>,
    tls: Arc<rustls::ClientConfig>,
    server_name: rustls::pki_types::ServerName<'static>,
}
impl NativeLiveService {
    #[cfg(test)]
    pub(crate) fn with_test_tls(mut self, tls: Arc<rustls::ClientConfig>) -> Self {
        self.tls = tls;
        self
    }
    /// Constructor-only fixed-destination connector. No unrestricted connector
    /// is installed by default. Runtime configuration must prove OS enforcement.
    pub fn configured(
        authority: Arc<dyn NativeLiveAuthority>,
        connector: Arc<dyn NativeLiveConnector>,
    ) -> Result<Self, GatewayError> {
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        Ok(Self {
            authority,
            connector,
            tls: Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            ),
            server_name: rustls::pki_types::ServerName::try_from("api.openai.com")
                .map_err(|_| unavailable())?,
        })
    }
}
impl NativeLiveHandler for NativeLiveService {
    fn handle(
        &self,
        stream: &mut TcpStream,
        request: NativeLiveUpgradeRequest,
        proof: AuthenticatedNativeLive,
    ) -> Result<NativeLiveOutcome, GatewayError> {
        proof.require_upgrade(&request.action_ref, crate::http_server::now_ms()?)?;
        let mut random = [0; 32];
        getrandom::fill(&mut random).map_err(|_| unavailable())?;
        let connection_id = base64url(&random);
        let authorization = self.authority.authorize(
            &request.action_ref,
            &connection_id,
            Instant::now() + Duration::from_secs(10),
        )?;
        if authorization.fence.owner_id != proof.owner_id()
            || authorization.fence.owner_epoch != proof.owner_epoch()
        {
            return Err(unavailable());
        }
        let mut builder = tungstenite::http::Request::builder()
            .method("GET")
            .uri(gateway_auth::native_live::NATIVE_LIVE_PATH);
        let mut version_seen = false;
        let mut key_seen = false;
        for (name, value) in &request.headers {
            if name.eq_ignore_ascii_case("sec-websocket-version") {
                if version_seen || !(value == "8" || value == "13") {
                    return Err(unavailable());
                }
                version_seen = true;
                // RFC6455 framing is shared. The source ws server accepts both
                // 8 and 13; tungstenite's response builder accepts 13 only.
                builder = builder.header(name, "13");
                continue;
            }
            if name.eq_ignore_ascii_case("sec-websocket-key") {
                if key_seen
                    || value.len() != 24
                    || !value.ends_with("==")
                    || !value.as_bytes()[..22]
                        .iter()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
                {
                    return Err(unavailable());
                }
                key_seen = true;
            }
            builder = builder.header(name, value);
        }
        let upgrade = builder.body(()).map_err(|_| unavailable())?;
        let response = create_response(&upgrade).map_err(|_| unavailable())?;
        // Once a101 write begins, the HTTP dispatcher must never receive an
        // error that it could render as a second JSON/HTTP response.
        let outcome = response_committed(stream, |stream| {
            write_response(&mut *stream, &response).map_err(|_| unavailable())?;
            stream.flush().map_err(|_| unavailable())?;
            stream.set_nonblocking(true).map_err(|_| unavailable())?;
            let socket = WebSocket::from_partially_read(
                stream.try_clone().map_err(|_| unavailable())?,
                request.buffered,
                Role::Server,
                Some(websocket_config()),
            );
            let mut downstream = PendingSocket::new(socket, Role::Server);
            let mut preopen = PreopenQueue::default();
            // Consume already-buffered frames and close before the first upstream
            // dial. The same reader stays active while the dial thread awaits TLS.
            match read_downstream::<socket::UpstreamSocket>(&mut downstream, None, &mut preopen) {
                Ok(Some((code, reason))) => {
                    close_peer(&mut downstream, code, &reason, false);
                    return Ok(NativeLiveOutcome::CloseRequested { code });
                }
                Err(error) => {
                    close_peer(&mut downstream, 1011, &error.envelope.error.message, false);
                    return Ok(NativeLiveOutcome::CloseRequested { code: 1011 });
                }
                Ok(None) => {}
            }
            let alive = Arc::new(AtomicBool::new(true));
            let context = LiveDialContext::new(
                alive.clone(),
                stream.try_clone().map_err(|_| unavailable())?,
                Instant::now() + Duration::from_millis(HANDSHAKE_TIMEOUT_MS),
            );
            let authority = self.authority.clone();
            let connector = self.connector.clone();
            let tls = self.tls.clone();
            let server_name = self.server_name.clone();
            let (sender, receiver) = mpsc::sync_channel(1);
            let dial = thread::spawn(move || {
                let result = socket::dial(
                    authority.as_ref(),
                    connector.as_ref(),
                    tls,
                    server_name,
                    authorization,
                    &context,
                );
                let _ = sender.send(result);
            });
            let mut upstream = None;
            let mut retired = None;
            let finish = 'relay: loop {
                match read_downstream(&mut downstream, upstream.as_mut(), &mut preopen) {
                    Ok(Some(close)) => break close,
                    Ok(None) => {}
                    Err(error) => break (1011, error.envelope.error.message),
                }
                if upstream.is_none() && retired.is_none() {
                    match receiver.try_recv() {
                        Ok(socket::DialResult::Connected(socket)) => {
                            let mut peer = PendingSocket::new(*socket, Role::Client);
                            let frames = std::mem::take(&mut preopen);
                            let mut failed = false;
                            for text in frames.drain() {
                                if peer.send(text).is_err() {
                                    failed = true;
                                    break;
                                }
                            }
                            if failed {
                                break (1011, "realtime upstream is not draining frames".into());
                            }
                            upstream = Some(peer);
                        }
                        Ok(socket::DialResult::Rejected(authorization, status)) => {
                            retired = Some((authorization, status, Instant::now()));
                        }
                        Ok(socket::DialResult::Failed) => {
                            break (1011, "realtime upstream unavailable".into());
                        }
                        Err(mpsc::TryRecvError::Disconnected) => {
                            break (1011, "realtime upstream unavailable".into());
                        }
                        Err(mpsc::TryRecvError::Empty) => {}
                    }
                }
                if let Some((authorization, status, retry_at)) = &mut retired {
                    if *status != 404 && *status != 410 {
                        break (1011, "realtime upstream rejected the sideband".into());
                    }
                    if Instant::now() >= *retry_at {
                        match self.authority.retire(
                            authorization,
                            *status,
                            Instant::now() + Duration::from_secs(10),
                        ) {
                            Ok(NativeLiveRetirement::Retired) => {
                                break (1011, "realtime upstream rejected the sideband".into());
                            }
                            Ok(NativeLiveRetirement::Pending | NativeLiveRetirement::Unknown)
                            | Err(_) => *retry_at = Instant::now() + Duration::from_millis(250),
                        }
                    }
                }
                if let Some(peer) = upstream.as_mut() {
                    loop {
                        match peer.read() {
                            Ok(Message::Text(text)) => {
                                if downstream.send(text.to_string()).is_err() {
                                    break 'relay (
                                        1011,
                                        "realtime sideband is not writable".into(),
                                    );
                                }
                            }
                            Ok(Message::Close(frame)) => {
                                let (code, reason) = close_value(frame);
                                alive.store(false, Ordering::Release);
                                close_peer(peer, code, &reason, true);
                                close_peer(&mut downstream, code, &reason, false);
                                let _ = dial.join();
                                return Ok(NativeLiveOutcome::CloseRequested { code });
                            }
                            Ok(_) => {}
                            Err(error) if blocked(&error) => break,
                            Err(_) => {
                                alive.store(false, Ordering::Release);
                                close_peer(peer, 1011, "realtime upstream error", true);
                                close_peer(&mut downstream, 1011, "realtime upstream error", false);
                                let _ = dial.join();
                                return Ok(NativeLiveOutcome::CloseRequested { code: 1011 });
                            }
                        }
                    }
                    if peer.pump().is_err() {
                        break (1011, "realtime upstream is not draining frames".into());
                    }
                }
                if downstream.pump().is_err() {
                    break (1011, "realtime sideband is not writable".into());
                }
                thread::sleep(Duration::from_millis(2));
            };
            alive.store(false, Ordering::Release);
            if let Some(peer) = upstream.as_mut() {
                close_peer(peer, finish.0, &finish.1, true);
            }
            close_peer(&mut downstream, finish.0, &finish.1, false);
            let _ = dial.join();
            Ok(NativeLiveOutcome::CloseRequested { code: finish.0 })
        });
        Ok(outcome)
    }
}

fn response_committed(
    stream: &mut TcpStream,
    operation: impl FnOnce(&mut TcpStream) -> Result<NativeLiveOutcome, GatewayError>,
) -> NativeLiveOutcome {
    match operation(stream) {
        Ok(outcome) => outcome,
        Err(_) => {
            let _ = stream.shutdown(std::net::Shutdown::Both);
            NativeLiveOutcome::TransportUnknown
        }
    }
}

fn read_downstream<S: std::io::Read + Write>(
    down: &mut PendingSocket<TcpStream>,
    mut up: Option<&mut PendingSocket<S>>,
    preopen: &mut PreopenQueue,
) -> Result<Option<(u16, String)>, GatewayError> {
    loop {
        let text = match down.read() {
            Ok(Message::Text(text)) => Some(text.to_string()),
            Ok(Message::Binary(bytes)) => Some(decode_text(&bytes)),
            Ok(Message::Close(frame)) => return Ok(Some(close_value(frame))),
            Ok(_) => None,
            Err(error) if blocked(&error) => return Ok(None),
            Err(_) => return Err(failure("realtime sideband frame exceeds payload limit")),
        };
        if let Some(text) = text {
            if text.len() > MAX_PAYLOAD_BYTES {
                return Err(failure("realtime sideband frame exceeds payload limit"));
            }
            if let Some(peer) = up.as_mut() {
                peer.send(text)?;
            } else {
                preopen.push(text)?;
            }
        }
    }
}
fn decode_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)).into_owned()
}
fn close_value(frame: Option<CloseFrame>) -> (u16, String) {
    frame.map_or((1005, String::new()), |frame| {
        (u16::from(frame.code), frame.reason.to_string())
    })
}
fn close_peer<S: std::io::Read + Write>(
    peer: &mut PendingSocket<S>,
    code: u16,
    reason: &str,
    upstream: bool,
) {
    let allowed = if upstream {
        code == 1000 || (3000..=4999).contains(&code)
    } else {
        (1000..=4999).contains(&code) && ![1005, 1006, 1015].contains(&code)
    };
    let reason = String::from_utf16_lossy(&reason.encode_utf16().take(100).collect::<Vec<_>>());
    let frame = if allowed && reason.len() <= 123 {
        Some(CloseFrame {
            code: CloseCode::from(code),
            reason: reason.into(),
        })
    } else {
        None
    };
    if peer.socket.close(frame).is_err() {
        let _ = peer.socket.close(None);
    }
    let _ = peer.socket.flush();
}
pub(super) fn failure(reason: &str) -> GatewayError {
    GatewayError::unavailable(reason, "native_live_transport_failed")
}
pub(super) fn unavailable() -> GatewayError {
    failure("Native live transport is unavailable")
}

#[cfg(test)]
mod tests;
