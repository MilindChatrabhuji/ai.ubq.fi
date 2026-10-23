use super::*;
use crate::live_bridge::NativeLiveOutcome;
use gateway_auth::{crypto::base64url, native_live::AuthenticatedNativeLive};
use std::{collections::BTreeSet, fs, net::Shutdown, path::PathBuf, sync::Mutex};

#[derive(Default)]
struct Observed {
    actions: Vec<String>,
    immediate: Vec<Vec<u8>>,
}
struct Handler(Arc<Mutex<Observed>>);
impl NativeLiveHandler for Handler {
    fn handle(
        &self,
        stream: &mut TcpStream,
        request: NativeLiveUpgradeRequest,
        proof: AuthenticatedNativeLive,
    ) -> Result<NativeLiveOutcome, GatewayError> {
        proof.require_upgrade(&request.action_ref, now_ms()?)?;
        let mut immediate = request.buffered;
        stream
            .read_to_end(&mut immediate)
            .map_err(|_| unavailable())?;
        let mut observed = self.0.lock().unwrap();
        observed.actions.push(request.action_ref);
        observed.immediate.push(immediate);
        stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
            .map_err(|_| unavailable())?;
        Ok(NativeLiveOutcome::TransportUnknown)
    }
}
struct Fixture {
    root: PathBuf,
    identity: NativeTransportIdentity,
    service: Arc<NativeHttpService>,
    observed: Arc<Mutex<Observed>>,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = std::env::temp_dir().join(format!(
            "uos-native-live-http-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let identity = NativeTransportIdentity::new(
            "fixture-key".into(),
            "fixture-owner".into(),
            "fixture-epoch".into(),
            [41; 32],
            BTreeSet::from([NativeCapability::LiveSideband]),
        )
        .unwrap();
        let nonces = SqliteNonceStore::open(&root.join("nonces.sqlite3")).unwrap();
        let observed = Arc::new(Mutex::new(Observed::default()));
        let service = Arc::new(
            NativeHttpService::configured(
                identity.clone(),
                nonces,
                SupervisorData::configured(Vec::new()).unwrap(),
            )
            .with_live_sideband(Handler(observed.clone())),
        );
        Self {
            root,
            identity,
            service,
            observed,
        }
    }
    fn request(&self, nonce_byte: u8, post_signature: bool) -> Vec<u8> {
        let time = now_ms().unwrap();
        let nonce = base64url(&[nonce_byte; 32]);
        let mac = if post_signature {
            self.identity
                .sign(NATIVE_RPC_PATH, time, &nonce, b"{}")
                .unwrap()
        } else {
            self.identity
                .sign_live_request(time, &nonce, "fixture-action")
                .unwrap()
        };
        format!("GET {NATIVE_LIVE_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{NATIVE_VERSION_HEADER}: 1\r\n{NATIVE_KEY_HEADER}: fixture-key\r\n{NATIVE_TIME_HEADER}: {time}\r\n{NATIVE_NONCE_HEADER}: {nonce}\r\n{NATIVE_MAC_HEADER}: {mac}\r\n{NATIVE_LIVE_ACTION_HEADER}: fixture-action\r\n\r\n").into_bytes()
    }
    fn exchange(&self, request: &[u8]) -> Vec<u8> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let service = self.service.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            if let Err(error) = service.handle(&mut stream) {
                write_error(&mut stream, error).unwrap();
            }
        });
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(request).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        server.join().unwrap();
        response
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn insert_header(request: &[u8], line: &str) -> Vec<u8> {
    let mut request = request[..request.len() - 2].to_vec();
    request.extend_from_slice(line.as_bytes());
    request.extend_from_slice(b"\r\n\r\n");
    request
}

#[test]
fn real_get_dispatch_authenticates_opaque_action_and_preserves_immediate_frame_bytes() {
    let fixture = Fixture::new();
    let mut request = fixture.request(1, false);
    let frame = [0x81, 0x83, 1, 2, 3, 4, 0x60, 0x60, 0x60];
    request.extend_from_slice(&frame);
    let response = fixture.exchange(&request);
    assert!(response.starts_with(b"HTTP/1.1 101"));
    let observed = fixture.observed.lock().unwrap();
    assert_eq!(observed.actions, ["fixture-action"]);
    assert_eq!(observed.immediate, [frame.to_vec()]);
}

#[test]
fn post_mac_cannot_authorize_get_and_invalid_auth_does_not_consume_nonce() {
    let fixture = Fixture::new();
    assert!(
        !fixture
            .exchange(&fixture.request(2, true))
            .starts_with(b"HTTP/1.1 101")
    );
    assert!(fixture.observed.lock().unwrap().actions.is_empty());
    assert!(
        fixture
            .exchange(&fixture.request(2, false))
            .starts_with(b"HTTP/1.1 101")
    );
    assert_eq!(fixture.observed.lock().unwrap().actions.len(), 1);
}

#[test]
fn real_get_replay_and_duplicate_action_headers_never_reenter_handler() {
    let fixture = Fixture::new();
    let request = fixture.request(3, false);
    assert!(fixture.exchange(&request).starts_with(b"HTTP/1.1 101"));
    assert!(!fixture.exchange(&request).starts_with(b"HTTP/1.1 101"));
    let next = fixture.request(4, false);
    let duplicate = insert_header(
        &next,
        &format!("{NATIVE_LIVE_ACTION_HEADER}: fixture-action"),
    );
    assert!(!fixture.exchange(&duplicate).starts_with(b"HTTP/1.1 101"));
    assert_eq!(fixture.observed.lock().unwrap().actions.len(), 1);
    assert!(fixture.exchange(&next).starts_with(b"HTTP/1.1 101"));
}

#[test]
fn live_get_refuses_http_bodies_chunked_encoding_and_query_selected_routes() {
    let fixture = Fixture::new();
    let base = fixture.request(5, false);
    let mut body = insert_header(&base, "Content-Length: 1");
    body.push(b'x');
    assert!(fixture.exchange(&body).starts_with(b"HTTP/1.1 400"));
    let chunked = insert_header(&base, "Transfer-Encoding: chunked");
    assert!(fixture.exchange(&chunked).starts_with(b"HTTP/1.1 400"));
    let query = String::from_utf8(base).unwrap().replacen(
        NATIVE_LIVE_PATH,
        &format!("{NATIVE_LIVE_PATH}?action=caller"),
        1,
    );
    assert!(
        fixture
            .exchange(query.as_bytes())
            .starts_with(b"HTTP/1.1 404")
    );
    assert!(fixture.observed.lock().unwrap().actions.is_empty());
}
