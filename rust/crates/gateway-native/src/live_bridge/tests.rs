use super::*;
use gateway_auth::{
    native::*,
    native_auth::{
        NativeAuthHeaders, NativeCapability, NativeNonceAuthority, NativeTransportIdentity,
    },
    native_live::{NATIVE_LIVE_ACTION_HEADER, NativeLiveAuthenticator},
};
use gateway_authority::native_live::{NativeLiveAccess, NativeLiveFence};
use rustls::{
    ServerConfig, ServerConnection, StreamOwned,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName},
};
use std::{
    collections::BTreeSet,
    io::Read,
    net::{SocketAddr, TcpListener},
    sync::atomic::AtomicUsize,
};
use tungstenite::{
    client::IntoClientRequest,
    handshake::server::{Callback, ErrorResponse, Request, Response},
};

struct Nonces;
impl NativeNonceAuthority for Nonces {
    async fn consume_nonce(&self, _: &str, _: &str, _: i64, _: i64) -> Result<(), GatewayError> {
        Ok(())
    }
}
fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-live".into(),
        "owner".into(),
        "epoch".into(),
        [37; 32],
        BTreeSet::from([NativeCapability::LiveSideband]),
    )
    .unwrap()
}
fn access() -> NativeLiveAccess {
    serde_json::from_str(r#"{"access_token":"synthetic-access"}"#).unwrap()
}
fn fence() -> NativeLiveFence {
    NativeLiveFence {
        call_id: "rtc_call/one".into(),
        account_id: "synthetic-account".into(),
        account_id_hash: "hash".into(),
        credential_version: "generation".into(),
        source_revision: "source".into(),
        normalized_revision: "normalized".into(),
        mapping_revision: "mapping".into(),
        owner_id: "owner".into(),
        owner_epoch: "epoch".into(),
        owner_revision: "owner-revision".into(),
        principal: "api-key:fixture".into(),
        principal_policy_digest: "policy".into(),
        access_expires_at_ms: None,
    }
}
#[derive(Default)]
struct Authority {
    retired: AtomicUsize,
}
impl NativeLiveAuthority for Authority {
    fn authorize(
        &self,
        action_ref: &str,
        connection_id: &str,
        _: Instant,
    ) -> Result<LiveAuthorization, GatewayError> {
        Ok(LiveAuthorization {
            action_ref: action_ref.into(),
            connection_id: connection_id.into(),
            authorization_ref: "authorization".into(),
            fence: fence(),
            access: Some(access()),
        })
    }
    fn recheck(
        &self,
        _: &LiveAuthorization,
        _: Instant,
    ) -> Result<(NativeLiveFence, NativeLiveAccess), GatewayError> {
        Ok((fence(), access()))
    }
    fn retire(
        &self,
        _: &LiveAuthorization,
        status: u16,
        _: Instant,
    ) -> Result<NativeLiveRetirement, GatewayError> {
        assert!(status == 404 || status == 410);
        self.retired.fetch_add(1, Ordering::SeqCst);
        Ok(NativeLiveRetirement::Retired)
    }
}
struct Connector {
    address: SocketAddr,
    calls: Arc<AtomicUsize>,
}
impl NativeLiveConnector for Connector {
    fn connect(&self, context: &LiveDialContext) -> Result<TcpStream, GatewayError> {
        context.check()?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        TcpStream::connect_timeout(&self.address, context.remaining()?).map_err(|_| unavailable())
    }
}
pub(super) fn configs() -> (Arc<ServerConfig>, Arc<rustls::ClientConfig>) {
    let cert =
        CertificateDer::from(include_bytes!("../../tests/fixtures/native-tls/leaf.der").to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        include_bytes!("../../tests/fixtures/native-tls/leaf.pk8.der").to_vec(),
    ));
    let server = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from(
            include_bytes!("../../tests/fixtures/native-tls/ca.der").to_vec(),
        ))
        .unwrap();
    (
        Arc::new(server),
        Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        ),
    )
}
fn read_head(stream: &mut TcpStream) -> (Vec<(String, String)>, Vec<u8>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            let head = std::str::from_utf8(&bytes[..end]).unwrap();
            assert_eq!(head.lines().next(), Some("GET /v1/native/live HTTP/1.1"));
            let headers = head
                .lines()
                .skip(1)
                .map(|line| {
                    let (k, v) = line.split_once(':').unwrap();
                    (k.to_lowercase(), v.trim().into())
                })
                .collect();
            return (headers, bytes[end + 4..].to_vec());
        }
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 65_536);
    }
}
fn start(service: NativeLiveService) -> (SocketAddr, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let (headers, buffered) = read_head(&mut stream);
        let one = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .unwrap()
                .1
                .as_str()
        };
        let action_ref = one(NATIVE_LIVE_ACTION_HEADER).to_owned();
        let identity = identity();
        let proof = futures_executor::block_on(
            NativeLiveAuthenticator::new(&identity, &Nonces).authenticate_upgrade(
                NativeAuthHeaders {
                    version: one(NATIVE_VERSION_HEADER),
                    key_id: one(NATIVE_KEY_HEADER),
                    time_ms: one(NATIVE_TIME_HEADER),
                    nonce: one(NATIVE_NONCE_HEADER),
                    mac: one(NATIVE_MAC_HEADER),
                },
                &action_ref,
                crate::http_server::now_ms().unwrap(),
            ),
        )
        .unwrap();
        assert!(
            service
                .handle(
                    &mut stream,
                    NativeLiveUpgradeRequest {
                        action_ref,
                        headers,
                        buffered
                    },
                    proof
                )
                .is_ok()
        );
    });
    (address, handle)
}
fn request(address: SocketAddr) -> tungstenite::handshake::client::Request {
    let mut request = format!("ws://{address}/v1/native/live")
        .into_client_request()
        .unwrap();
    let now = crate::http_server::now_ms().unwrap();
    let nonce = base64url(&[19; 32]);
    let identity = identity();
    let mac = identity
        .sign_live_request(now, &nonce, "action-ref")
        .unwrap();
    for (name, value) in [
        (NATIVE_VERSION_HEADER, "1".into()),
        (NATIVE_KEY_HEADER, identity.key_id().into()),
        (NATIVE_TIME_HEADER, now.to_string()),
        (NATIVE_NONCE_HEADER, nonce),
        (NATIVE_MAC_HEADER, mac),
        (NATIVE_LIVE_ACTION_HEADER, "action-ref".into()),
    ] {
        request.headers_mut().insert(
            tungstenite::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    request
}

struct FixedUpstreamHeaders;
impl Callback for FixedUpstreamHeaders {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        assert_eq!(request.uri().path(), "/v1/live/rtc_call%2Fone");
        assert_eq!(
            request.headers()["authorization"],
            "Bearer synthetic-access"
        );
        assert_eq!(request.headers()["chatgpt-account-id"], "synthetic-account");
        assert_eq!(request.headers()["openai-alpha"], "quicksilver=v2");
        assert!(request.headers().get("sec-websocket-extensions").is_none());
        Ok(response)
    }
}

#[test]
fn actual_tls_upgrade_preserves_fixed_headers_immediate_binary_text_and_close_without_retiring() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = listener.local_addr().unwrap();
    let (server, tls) = configs();
    let peer = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        thread::sleep(Duration::from_millis(100));
        let tls = StreamOwned::new(ServerConnection::new(server).unwrap(), stream);
        let mut socket = tungstenite::accept_hdr_with_config(
            tls,
            FixedUpstreamHeaders,
            Some(queue::websocket_config()),
        )
        .unwrap();
        socket
            .send(Message::Binary(b"ignored".to_vec().into()))
            .unwrap();
        socket.send(Message::Text("upstream".into())).unwrap();
        assert_eq!(socket.read().unwrap(), Message::Text("first".into()));
        socket.send(Message::Text("echo:first".into())).unwrap();
        socket
            .close(Some(CloseFrame {
                code: CloseCode::Library(3001),
                reason: "closed".into(),
            }))
            .unwrap();
    });
    let authority = Arc::new(Authority::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let service = NativeLiveService {
        authority: authority.clone(),
        connector: Arc::new(Connector {
            address: upstream,
            calls: calls.clone(),
        }),
        tls,
        server_name: ServerName::try_from("127.0.0.1").unwrap(),
    };
    let (address, bridge) = start(service);
    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let (mut client, response) = tungstenite::client(request(address), stream).unwrap();
    assert_eq!(response.status(), 101);
    client
        .send(Message::Binary(
            vec![0xef, 0xbb, 0xbf, b'f', b'i', b'r', b's', b't'].into(),
        ))
        .unwrap();
    assert_eq!(client.read().unwrap(), Message::Text("upstream".into()));
    assert_eq!(client.read().unwrap(), Message::Text("echo:first".into()));
    assert!(
        matches!(client.read().unwrap(),Message::Close(Some(frame)) if u16::from(frame.code)==3001&&frame.reason=="closed")
    );
    bridge.join().unwrap();
    peer.join().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(authority.retired.load(Ordering::SeqCst), 0);
}

#[test]
fn actual_tls_terminal_404_retires_before_failure_close() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = listener.local_addr().unwrap();
    let (server, tls) = configs();
    let peer = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut tls = StreamOwned::new(ServerConnection::new(server).unwrap(), stream);
        let mut bytes = Vec::new();
        while !bytes.windows(4).any(|s| s == b"\r\n\r\n") {
            let mut chunk = [0; 1024];
            let count = tls.read(&mut chunk).unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
        }
        tls.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
        tls.flush().unwrap();
    });
    let authority = Arc::new(Authority::default());
    let service = NativeLiveService {
        authority: authority.clone(),
        connector: Arc::new(Connector {
            address: upstream,
            calls: Arc::new(AtomicUsize::new(0)),
        }),
        tls,
        server_name: ServerName::try_from("127.0.0.1").unwrap(),
    };
    let (address, bridge) = start(service);
    let stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let (mut client, _) = tungstenite::client(request(address), stream).unwrap();
    assert!(
        matches!(client.read().unwrap(),Message::Close(Some(frame))if u16::from(frame.code)==1011)
    );
    assert_eq!(authority.retired.load(Ordering::SeqCst), 1);
    bridge.join().unwrap();
    peer.join().unwrap();
}

#[test]
fn actual_source_version_8_pipelined_close_before_dial_makes_zero_upstream_connections() {
    let (_, tls) = configs();
    let calls = Arc::new(AtomicUsize::new(0));
    let service = NativeLiveService {
        authority: Arc::new(Authority::default()),
        connector: Arc::new(Connector {
            address: "127.0.0.1:9".parse().unwrap(),
            calls: calls.clone(),
        }),
        tls,
        server_name: ServerName::try_from("127.0.0.1").unwrap(),
    };
    let (address, bridge) = start(service);
    let mut request = request(address);
    request
        .headers_mut()
        .insert("sec-websocket-version", "8".parse().unwrap());
    let mut raw = b"GET /v1/native/live HTTP/1.1\r\n".to_vec();
    for (name, value) in request.headers() {
        raw.extend_from_slice(format!("{name}: {}\r\n", value.to_str().unwrap()).as_bytes());
    }
    raw.extend_from_slice(b"\r\n\x88\x80\x01\x02\x03\x04");
    let mut client = TcpStream::connect(address).unwrap();
    client.write_all(&raw).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut byte = [0; 1];
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        assert_eq!(client.read(&mut byte).unwrap(), 1);
        head.push(byte[0]);
    }
    assert!(head.starts_with(b"HTTP/1.1 101"));
    bridge.join().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn actual_socket_error_after_101_is_transport_unknown_without_a_second_http_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let outcome = response_committed(&mut stream, |stream| {
            stream
                .write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
                .map_err(|_| unavailable())?;
            stream.flush().map_err(|_| unavailable())?;
            Err(failure("controlled post-upgrade transport failure"))
        });
        assert_eq!(outcome, NativeLiveOutcome::TransportUnknown);
    });
    let mut client = TcpStream::connect(address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut received = Vec::new();
    client.read_to_end(&mut received).unwrap();
    assert!(received.starts_with(b"HTTP/1.1 101 "));
    assert_eq!(
        received
            .windows(8)
            .filter(|bytes| *bytes == b"HTTP/1.1")
            .count(),
        1
    );
    assert!(received.ends_with(b"\r\n\r\n"));
    server.join().unwrap();
}
