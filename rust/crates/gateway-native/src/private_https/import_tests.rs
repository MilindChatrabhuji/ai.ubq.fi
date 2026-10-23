//! Actual loopback TLS only. These synthetic roots never enter production configuration.
use super::*;
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use std::{collections::BTreeMap, net::TcpListener, sync::Arc, thread};
struct Observed {
    sni: String,
    line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
struct Peer {
    socket: Option<TcpStream>,
    task: thread::JoinHandle<Option<Observed>>,
}
fn roots(import: bool) -> ureq::tls::RootCerts {
    let bytes: &[u8] = if import {
        include_bytes!("../../tests/fixtures/import-tls/ca.der")
    } else {
        include_bytes!("../../tests/fixtures/native-tls/ca.der")
    };
    ureq::tls::RootCerts::new_with_certs(&[ureq::tls::Certificate::from_der(bytes).to_owned()])
}
impl Peer {
    fn start(import: bool, redirect: bool) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let task = thread::spawn(move || {
            let (socket, _) = listener.accept().ok()?;
            drop(listener);
            socket.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .ok()?;
            let (cert, key): (&[u8], &[u8]) = if import {
                (
                    include_bytes!("../../tests/fixtures/import-tls/leaf.der"),
                    include_bytes!("../../tests/fixtures/import-tls/leaf.pk8.der"),
                )
            } else {
                (
                    include_bytes!("../../tests/fixtures/native-tls/leaf.der"),
                    include_bytes!("../../tests/fixtures/native-tls/leaf.pk8.der"),
                )
            };
            let config = ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(cert.to_vec())],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.to_vec())),
                )
                .ok()?;
            let mut tls = StreamOwned::new(ServerConnection::new(Arc::new(config)).ok()?, socket);
            let mut bytes = Vec::new();
            let (line, headers, request_body) = loop {
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let header = std::str::from_utf8(&bytes[..end]).ok()?;
                    let mut lines = header.split("\r\n");
                    let line = lines.next()?.to_owned();
                    let headers: BTreeMap<String, String> = lines
                        .filter_map(|l| l.split_once(':'))
                        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
                        .collect();
                    let length: usize = headers
                        .get("content-length")
                        .map(|v| v.parse().ok())
                        .unwrap_or(Some(0))?;
                    if bytes.len() >= end + 4 + length {
                        break (line, headers, bytes[end + 4..end + 4 + length].to_vec());
                    }
                }
                if bytes.len() >= 65_536 {
                    return None;
                }
                let mut part = [0; 4096];
                let n = tls.read(&mut part).ok()?;
                if n == 0 {
                    return None;
                }
                bytes.extend_from_slice(&part[..n]);
            };
            let sni = tls.conn.server_name()?.to_owned();
            let body = br#"{"models":[{"slug":"synthetic_model","display_name":"Synthetic"}]}"#;
            let head = if redirect {
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: https://forbidden.invalid/collect\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            };
            tls.write_all(head.as_bytes()).ok()?;
            tls.write_all(body).ok()?;
            tls.flush().ok()?;
            Some(Observed {
                sni,
                line,
                headers,
                body: request_body,
            })
        });
        Self {
            socket: Some(socket),
            task,
        }
    }
    fn socket(&mut self) -> TcpStream {
        self.socket.take().unwrap()
    }
}
#[test]
fn actual_import_models_tls_hostname_get_query_headers_and_no_redirect_are_fixed() {
    for redirect in [false, true] {
        let mut peer = Peer::start(true, redirect);
        let transport =
            PrivateHttps::models_connected(peer.socket(), roots(true), "0.100.0").unwrap();
        let response = transport
            .get_models(
                &[
                    ("Authorization".into(), "Bearer SYNTHETIC_ACCESS".into()),
                    ("ChatGPT-Account-ID".into(), "synthetic-account".into()),
                ],
                Instant::now() + Duration::from_secs(3),
            )
            .unwrap();
        assert_eq!(response.status, if redirect { 302 } else { 200 });
        let observed = peer.task.join().unwrap().unwrap();
        assert_eq!(observed.sni, "chatgpt.com");
        assert_eq!(
            observed.line,
            "GET /backend-api/codex/models?client_version=0.100.0 HTTP/1.1"
        );
        assert_eq!(
            observed.headers.get("authorization").map(String::as_str),
            Some("Bearer SYNTHETIC_ACCESS")
        );
        assert_eq!(
            observed
                .headers
                .get("chatgpt-account-id")
                .map(String::as_str),
            Some("synthetic-account")
        );
        assert!(observed.body.is_empty());
    }
    // Same original cert/root succeeds for its actual localhost name, then fails
    // against the fixed models hostname; expiry/untrusted roots cannot explain this pair.
    let mut control = Peer::start(false, false);
    let transport = PrivateHttps::from_connected(
        "https://localhost/oauth/token",
        "/oauth/token",
        control.socket(),
        roots(false),
    )
    .unwrap();
    assert_eq!(
        transport
            .send(&[], b"{}", Instant::now() + Duration::from_secs(3), 65_536)
            .unwrap()
            .status,
        200
    );
    assert_eq!(control.task.join().unwrap().unwrap().sni, "localhost");
    let mut wrong = Peer::start(false, false);
    let transport =
        PrivateHttps::models_connected(wrong.socket(), roots(false), "0.100.0").unwrap();
    assert!(
        transport
            .get_models(&[], Instant::now() + Duration::from_secs(3))
            .is_err()
    );
    drop(transport);
    assert!(wrong.task.join().unwrap().is_none());
}
#[test]
fn actual_import_oauth_tls_post_is_distinct_and_untrusted_roots_refuse() {
    let mut peer = Peer::start(true, false);
    let transport = PrivateHttps::from_connected(
        "https://auth.openai.com/oauth/token",
        "/oauth/token",
        peer.socket(),
        roots(true),
    )
    .unwrap();
    assert!(
        transport
            .get_models(&[], Instant::now() + Duration::from_secs(3))
            .is_err()
    );
    let body = br#"{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"SYNTHETIC_REFRESH","scope":"openid profile email"}"#;
    assert_eq!(
        transport
            .send(&[], body, Instant::now() + Duration::from_secs(3), 65_536)
            .unwrap()
            .status,
        200
    );
    let observed = peer.task.join().unwrap().unwrap();
    assert_eq!(observed.sni, "auth.openai.com");
    assert_eq!(observed.line, "POST /oauth/token HTTP/1.1");
    assert_eq!(observed.body, body);
    let mut peer = Peer::start(true, false);
    let transport =
        PrivateHttps::models_connected(peer.socket(), ureq::tls::RootCerts::WebPki, "0.100.0")
            .unwrap();
    assert!(
        transport
            .get_models(&[], Instant::now() + Duration::from_secs(3))
            .is_err()
    );
    drop(transport);
    assert!(peer.task.join().unwrap().is_none());
}
