//! Real confined HTTP/parser/MAC/capability fixture. This synthetic handler
//! deliberately returns unknown and does not pretend to publish credentials.
use super::*;
use crate::confinement::{NativeConfinement, enforce};
use gateway_auth::{crypto::base64url, native_auth::AuthenticatedNativeOwner};
use std::{collections::BTreeSet, path::PathBuf, sync::atomic::AtomicU64};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "uos-owner-control-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::create_dir(path.join("replay")).unwrap();
        std::fs::write(path.join("outside"), b"synthetic-outside-file").unwrap();
        Self(path)
    }
    fn service(&self, identity: NativeTransportIdentity) -> NativeHttpService {
        NativeHttpService::configured(
            identity,
            SqliteNonceStore::open(&self.0.join("replay/nonces.sqlite3")).unwrap(),
            SupervisorData::configured(Vec::new()).unwrap(),
        )
    }
    fn exchange(&self, service: Arc<NativeHttpService>, wire: &[u8]) -> Vec<u8> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let private = self.0.join("replay");
        let outside = self.0.join("outside");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            assert!(std::fs::read(&outside).is_ok());
            enforce(&NativeConfinement {
                readonly_paths: vec![],
                list_directories: vec![],
                replay_directory: private,
                unix_sockets: vec![],
            })
            .unwrap();
            assert!(std::fs::read(&outside).is_err());
            assert!(std::process::Command::new("/bin/true").status().is_err());
            if let Err(error) = service.handle(&mut stream) {
                write_error(&mut stream, error).unwrap();
            }
        });
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(wire).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        server.join().unwrap();
        response
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn identity(capability: NativeCapability) -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [11; 32],
        BTreeSet::from([capability]),
    )
    .unwrap()
}
fn request(identity: &NativeTransportIdentity, nonce: &str, body: &[u8]) -> Vec<u8> {
    let now = now_ms().unwrap();
    let mac = identity
        .sign(NATIVE_CONTROL_PATH, now, nonce, body)
        .unwrap();
    let mut request = format!("POST {NATIVE_CONTROL_PATH} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{NATIVE_VERSION_HEADER}: 1\r\n{NATIVE_KEY_HEADER}: fixture-key\r\n{NATIVE_TIME_HEADER}: {now}\r\n{NATIVE_NONCE_HEADER}: {nonce}\r\n{NATIVE_MAC_HEADER}: {mac}\r\n\r\n", body.len()).into_bytes();
    request.extend_from_slice(body);
    request
}
const BODY: &[u8] = br#"{"v":1,"operation_id":"fixture-operation","request":{"operation":"codex_renew_access","action_ref":"fixture-action"}}"#;

struct UnknownHandler(Arc<AtomicUsize>);
impl NativeOwnerRenewalHandler for UnknownHandler {
    fn renew(
        &self,
        proof: &AuthenticatedNativeOwner,
        request: &NativeControlEnvelope,
        raw: &[u8],
        context: &NativeControlContext<'_>,
    ) -> Result<NativeControlResponse, GatewayError> {
        context.check()?;
        proof.require_request(
            NativeCapability::OwnerRenewal,
            NATIVE_CONTROL_PATH,
            raw,
            context.now_ms()?,
        )?;
        assert_eq!(request.operation_id, "fixture-operation");
        self.0.fetch_add(1, Ordering::Relaxed);
        Err(GatewayError::unavailable(
            "synthetic-secret-must-not-escape",
            "fixture-unclassified-error",
        ))
    }
}

#[test]
fn confined_control_http_authenticates_unknown_result_and_redacts_handler_error() {
    let fixture = Fixture::new();
    let identity = identity(NativeCapability::OwnerRenewal);
    let calls = Arc::new(AtomicUsize::new(0));
    let service = Arc::new(
        fixture
            .service(identity.clone())
            .with_owner_renewal(UnknownHandler(calls.clone())),
    );
    let nonce = base64url(&[7; 32]);
    let request = request(&identity, &nonce, BODY);
    let wire = fixture.exchange(service.clone(), &request);
    let end = wire
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap();
    let headers = std::str::from_utf8(&wire[..end]).unwrap();
    assert!(headers.starts_with("HTTP/1.1 200 "));
    let mac = headers
        .lines()
        .find_map(|line| {
            line.split_once(": ")
                .filter(|(name, _)| name.eq_ignore_ascii_case(NATIVE_RESPONSE_MAC_HEADER))
                .map(|(_, value)| value)
        })
        .unwrap();
    let body = &wire[end + 4..];
    identity
        .verify_control_response(&nonce, BODY, 200, body, mac)
        .unwrap();
    assert!(
        identity
            .verify_publication_response(&nonce, BODY, 200, body, mac)
            .is_err()
    );
    let result: NativeControlResponse = serde_json::from_slice(body).unwrap();
    result
        .validate_for(&NativeControlEnvelope::parse(BODY).unwrap())
        .unwrap();
    assert_eq!(result.disposition, NativeControlDisposition::Unknown);
    assert!(!String::from_utf8_lossy(&wire).contains("synthetic-secret"));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    let replay = fixture.exchange(service, &request);
    assert!(String::from_utf8_lossy(&replay).starts_with("HTTP/1.1 409 "));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn confined_supervisor_capability_and_strict_control_body_refuse_before_handler() {
    let fixture = Fixture::new();
    let read_identity = identity(NativeCapability::SupervisorRead);
    let calls = Arc::new(AtomicUsize::new(0));
    let service = Arc::new(
        fixture
            .service(read_identity.clone())
            .with_owner_renewal(UnknownHandler(calls.clone())),
    );
    let wire = fixture.exchange(
        service,
        &request(&read_identity, &base64url(&[8; 32]), BODY),
    );
    assert!(String::from_utf8_lossy(&wire).starts_with("HTTP/1.1 403 "));
    let renew_identity = identity(NativeCapability::OwnerRenewal);
    let service = Arc::new(
        fixture
            .service(renew_identity.clone())
            .with_owner_renewal(UnknownHandler(calls.clone())),
    );
    let invalid = br#"{"v":1,"operation_id":"fixture-operation","request":{"operation":"codex_renew_access","action_ref":"fixture-action","authorized":true}}"#;
    let wire = fixture.exchange(
        service,
        &request(&renew_identity, &base64url(&[9; 32]), invalid),
    );
    assert!(String::from_utf8_lossy(&wire).starts_with("HTTP/1.1 400 "));
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[test]
fn confined_control_rejects_content_length_before_reading_an_oversized_body() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service(identity(NativeCapability::OwnerRenewal)));
    let wire = fixture.exchange(
        service,
        format!(
            "POST {NATIVE_CONTROL_PATH} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
            NATIVE_CONTROL_MAX_BYTES + 1
        )
        .as_bytes(),
    );
    assert!(String::from_utf8_lossy(&wire).starts_with("HTTP/1.1 413 "));
}
