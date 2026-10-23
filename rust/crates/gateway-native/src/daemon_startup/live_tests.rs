use super::*;
use crate::live_bridge::{LiveDialContext, NativeLiveConnector};
use gateway_auth::{
    crypto::base64url,
    native::*,
    native_auth::{NativeAuthHeaders, NativeNonceAuthority, NativeTransportIdentity},
    native_live::{NATIVE_LIVE_ACTION_HEADER, NATIVE_LIVE_AUTHORITY_PATH, NativeLiveAuthenticator},
};
use gateway_authority::native_live::{
    NativeLiveAccess, NativeLiveAuthorityRequest, NativeLiveAuthorityResponse, NativeLiveFence,
};
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};
use tungstenite::{
    Message,
    client::IntoClientRequest,
    protocol::frame::{CloseFrame, coding::CloseCode},
};

const CA: &[u8] = include_bytes!("../../tests/fixtures/native-live-startup/ca.der");
const CERT: &[u8] = include_bytes!("../../tests/fixtures/native-live-startup/leaf.der");
// Deliberately committed synthetic offline fixture key, never a runtime identity.
const KEY: &[u8] = include_bytes!("../../tests/fixtures/native-live-startup/leaf.pk8.der");
pub(super) fn authority_roots() -> ureq::tls::RootCerts {
    ureq::tls::RootCerts::new_with_certs(&[ureq::tls::Certificate::from_der(CA).to_owned()])
}
pub(super) fn provider_tls() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(CA.to_vec())).unwrap();
    Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}
fn server_tls() -> Arc<ServerConfig> {
    Arc::new(
        ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(CERT.to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec())),
            )
            .unwrap(),
    )
}
fn fence() -> NativeLiveFence {
    NativeLiveFence {
        call_id: "fixture-call".into(),
        account_id: "fixture-account".into(),
        account_id_hash: "account-hash".into(),
        credential_version: "credential".into(),
        source_revision: "source".into(),
        normalized_revision: "normalized".into(),
        mapping_revision: "mapping".into(),
        owner_id: "fixture-owner".into(),
        owner_epoch: "fixture-epoch".into(),
        owner_revision: "owner-revision".into(),
        principal: "api-key:fixture".into(),
        principal_policy_digest: "policy".into(),
        access_expires_at_ms: None,
    }
}
fn access() -> NativeLiveAccess {
    serde_json::from_str(r#"{"access_token":"synthetic-only-access"}"#).unwrap()
}
struct Nonces;
impl NativeNonceAuthority for Nonces {
    async fn consume_nonce(&self, _: &str, _: &str, _: i64, _: i64) -> Result<(), GatewayError> {
        Ok(())
    }
}
fn request(stream: &mut impl Read) -> (BTreeMap<String, String>, Vec<u8>) {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        assert!(head.len() < 8192);
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    let text = std::str::from_utf8(&head).unwrap();
    let mut lines = text.split("\r\n");
    assert_eq!(
        lines.next().unwrap(),
        format!("POST {NATIVE_LIVE_AUTHORITY_PATH} HTTP/1.1")
    );
    let headers: BTreeMap<_, _> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let length: usize = headers["content-length"].parse().unwrap();
    assert!(length <= 65_536);
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    (headers, body)
}
fn authority_peer(
    listener: TcpListener,
    identity: NativeTransportIdentity,
    mode: &'static str,
    calls: Arc<AtomicUsize>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut tls = StreamOwned::new(ServerConnection::new(server_tls()).unwrap(), socket);
        let count = if mode == "lost" { 1 } else { 4 };
        for index in 0..count {
            let (headers, body) = request(&mut tls);
            let now = crate::http_server::now_ms().unwrap();
            let proof = futures_executor::block_on(
                NativeLiveAuthenticator::new(&identity, &Nonces).authenticate_authority(
                    NativeAuthHeaders {
                        version: &headers[NATIVE_VERSION_HEADER],
                        key_id: &headers[NATIVE_KEY_HEADER],
                        time_ms: &headers[NATIVE_TIME_HEADER],
                        nonce: &headers[NATIVE_NONCE_HEADER],
                        mac: &headers[NATIVE_MAC_HEADER],
                    },
                    &body,
                    now,
                ),
            )
            .unwrap();
            proof.require_authority_request(&body, now).unwrap();
            let mut current = fence();
            if mode == "changed" && index == 3 {
                current.mapping_revision = "changed-mapping".into();
            }
            let reply = match NativeLiveAuthorityRequest::parse(&body).unwrap() {
                NativeLiveAuthorityRequest::Authorize { .. } => {
                    assert_eq!(index, 0);
                    NativeLiveAuthorityResponse::Authorize {
                        v: 1,
                        authorization_ref: "authorization".into(),
                        fence: current,
                        access: access(),
                    }
                }
                NativeLiveAuthorityRequest::Recheck { .. } => {
                    assert!(index > 0);
                    NativeLiveAuthorityResponse::Recheck {
                        v: 1,
                        fence: current,
                        access: access(),
                    }
                }
                NativeLiveAuthorityRequest::Retire { .. } => panic!("normal close must not retire"),
            };
            let reply = serde_json::to_vec(&reply).unwrap();
            let signature = identity
                .sign_live_authority_response(&headers[NATIVE_NONCE_HEADER], &body, 200, &reply)
                .unwrap();
            let connection = if mode == "lost" {
                "close"
            } else {
                "keep-alive"
            };
            write!(tls,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {connection}\r\n{NATIVE_RESPONSE_MAC_HEADER}: {signature}\r\n\r\n",reply.len()).unwrap();
            tls.write_all(&reply).unwrap();
            tls.flush().unwrap();
            calls.fetch_add(1, Ordering::SeqCst);
        }
    })
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

#[test]
fn actual_startup_composer_reuses_reverse_tls_for_currentness_and_native_101_frames_and_close() {
    for mode in ["normal", "lost", "changed"] {
        let directory = std::env::temp_dir().join(format!(
            "uos-native-live-startup-{}-{mode}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let config = serde_json::json!({"v":3,"listen":"127.0.0.1:0","identity":{"key_id":"fixture-key","owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_base64url":base64url(&[73;32])},"nonce_database":directory.join("nonces.sqlite3"),"sources":[],"live_sideband":{"authority_origin":"https://rust-candidate.ai.ubq.fi"}});
        let config =
            crate::daemon_config::NativeDaemonConfig::read_stdin(config.to_string().as_bytes())
                .unwrap();
        let identity = config.identity.clone();
        let authority_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let reverse = TcpStream::connect(authority_listener.local_addr().unwrap()).unwrap();
        let rpc = Arc::new(AtomicUsize::new(0));
        let authority = authority_peer(authority_listener, identity.clone(), mode, rpc.clone());
        let upstream_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_address = upstream_listener.local_addr().unwrap();
        let upstream = if mode == "lost" {
            None
        } else {
            Some(thread::spawn(move || {
                let (socket, _) = upstream_listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let tls = StreamOwned::new(ServerConnection::new(server_tls()).unwrap(), socket);
                let mut socket = tungstenite::accept(tls).unwrap();
                if mode == "normal" {
                    socket.send(Message::Text("upstream".into())).unwrap();
                    assert_eq!(socket.read().unwrap(), Message::Text("downstream".into()));
                    socket.send(Message::Text("echo".into())).unwrap();
                    socket
                        .close(Some(CloseFrame {
                            code: CloseCode::Normal,
                            reason: "normal".into(),
                        }))
                        .unwrap();
                } else {
                    let _ = socket.send(Message::Text("must-not-reach-client".into()));
                    assert!(matches!(socket.read(), Err(_) | Ok(Message::Close(_))));
                }
            }))
        };
        let dials = Arc::new(AtomicUsize::new(0));
        let service = request_service(
            config,
            Arc::new(Connector {
                address: upstream_address,
                calls: dials.clone(),
            }),
            Some(reverse),
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let native = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            service.serve_connection(&mut socket).unwrap();
        });
        let mut request = format!("ws://{address}/v1/native/live")
            .into_client_request()
            .unwrap();
        let now = crate::http_server::now_ms().unwrap();
        let nonce = base64url(&[7; 32]);
        let mac = identity
            .sign_live_request(now, &nonce, "fixture-action")
            .unwrap();
        for (key, value) in [
            (NATIVE_VERSION_HEADER, "1".to_owned()),
            (NATIVE_KEY_HEADER, identity.key_id().to_owned()),
            (NATIVE_TIME_HEADER, now.to_string()),
            (NATIVE_NONCE_HEADER, nonce),
            (NATIVE_MAC_HEADER, mac),
            (NATIVE_LIVE_ACTION_HEADER, "fixture-action".to_owned()),
        ] {
            request.headers_mut().insert(
                tungstenite::http::HeaderName::from_bytes(key.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        let socket = TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (mut client, response) = tungstenite::client(request, socket).unwrap();
        assert_eq!(response.status(), 101);
        if mode == "normal" {
            client.send(Message::Text("downstream".into())).unwrap();
            assert_eq!(client.read().unwrap(), Message::Text("upstream".into()));
            assert_eq!(client.read().unwrap(), Message::Text("echo".into()));
            assert!(
                matches!(client.read().unwrap(),Message::Close(Some(frame)) if frame.code==CloseCode::Normal)
            );
        } else {
            assert!(
                matches!(client.read().unwrap(),Message::Close(Some(frame)) if u16::from(frame.code)==1011)
            );
        }
        drop(client);
        native.join().unwrap();
        authority.join().unwrap();
        if let Some(upstream) = upstream {
            upstream.join().unwrap();
        }
        assert_eq!(
            rpc.load(Ordering::SeqCst),
            if mode == "lost" { 1 } else { 4 }
        );
        assert_eq!(dials.load(Ordering::SeqCst), usize::from(mode != "lost"));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
