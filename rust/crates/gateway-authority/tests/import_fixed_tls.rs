#![cfg(unix)]
//! Actual path-module transport checks, not production registration or private proof tests.
mod remote_tls;
use gateway_auth::{crypto::base64url, native::*};
use remote_tls::{ImportAuthorityTls, Roots};
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
const CA: &[u8] = include_bytes!("../../gateway-native/tests/fixtures/import-tls/ca.der");
const CERT: &[u8] = include_bytes!("../../gateway-native/tests/fixtures/import-tls/leaf.der");
const KEY: &[u8] = include_bytes!("../../gateway-native/tests/fixtures/import-tls/leaf.pk8.der");
struct Observation {
    sni: String,
    line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
struct Peer {
    socket: Option<TcpStream>,
    listener: TcpListener,
    task: thread::JoinHandle<Vec<Observation>>,
}
impl Peer {
    fn start(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let acceptor = listener.try_clone().unwrap();
        let task = thread::spawn(move || {
            let (socket, _) = acceptor.accept().unwrap();
            drop(acceptor);
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let config = ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(CERT.to_vec())],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec())),
                )
                .unwrap();
            let mut tls =
                StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), socket);
            let mut observed = Vec::new();
            for response in responses {
                let Some((line, headers, body)) = read_request(&mut tls) else {
                    break;
                };
                observed.push(Observation {
                    sni: tls.conn.server_name().unwrap().into(),
                    line,
                    headers,
                    body,
                });
                if tls.write_all(&response).is_err() || tls.flush().is_err() {
                    break;
                }
            }
            observed
        });
        Self {
            socket: Some(socket),
            listener,
            task,
        }
    }
    fn transport(&mut self, host: &str, fixture: bool) -> ImportAuthorityTls {
        let roots = if fixture {
            Roots::fixture(CA)
        } else {
            Roots::webpki()
        };
        ImportAuthorityTls::from_connected(
            &format!("https://{host}{NATIVE_RENEWAL_AUTHORITY_PATH}"),
            self.socket.take().unwrap(),
            roots,
        )
        .unwrap()
    }
}
fn read_request(stream: &mut impl Read) -> Option<(String, BTreeMap<String, String>, Vec<u8>)> {
    let mut bytes = Vec::new();
    loop {
        if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            let header = std::str::from_utf8(&bytes[..end]).ok()?;
            let mut lines = header.split("\r\n");
            let line = lines.next()?.to_owned();
            let headers: BTreeMap<String, String> = lines
                .filter_map(|l| l.split_once(':'))
                .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
                .collect();
            let length: usize = headers.get("content-length")?.parse().ok()?;
            if bytes.len() >= end + 4 + length {
                return Some((line, headers, bytes[end + 4..end + 4 + length].to_vec()));
            }
        }
        if bytes.len() >= 262_144 {
            return None;
        }
        let mut part = [0; 8192];
        let n = stream.read(&mut part).ok()?;
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&part[..n]);
    }
}
fn headers(counter: u8) -> Vec<(String, String)> {
    vec![
        (NATIVE_VERSION_HEADER.into(), "1".into()),
        (NATIVE_KEY_HEADER.into(), "synthetic-key".into()),
        (NATIVE_TIME_HEADER.into(), "1".into()),
        (NATIVE_NONCE_HEADER.into(), base64url(&[counter; 32])),
        (NATIVE_MAC_HEADER.into(), base64url(&[7; 32])),
    ]
}
fn response(status: u16, body: &[u8], connection: &str) -> Vec<u8> {
    let mut bytes = format!("HTTP/1.1 {status} Native\r\nContent-Type: application/json\r\nX-Uos-Native-Response-Mac: synthetic-reply-mac\r\nContent-Length: {}\r\nConnection: {connection}\r\n\r\n", body.len()).into_bytes();
    bytes.extend_from_slice(body);
    bytes
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
#[test]
fn actual_sequential_same_tls_connection_has_fixed_sni_path_headers_and_body() {
    let mut peer = Peer::start(vec![
        response(200, b"first", "keep-alive"),
        response(200, b"second", "close"),
    ]);
    let transport = peer.transport("localhost", true);
    let bound = deadline();
    for (i, (request, expected)) in [
        (b"one".as_slice(), b"first".as_slice()),
        (b"two".as_slice(), b"second".as_slice()),
    ]
    .into_iter()
    .enumerate()
    {
        let reply = transport
            .send(&headers(i as u8), request, bound, 16)
            .unwrap();
        assert_eq!(reply.status(), 200);
        assert_eq!(reply.body(), expected);
        assert!(
            reply
                .headers()
                .iter()
                .any(|(k, v)| k == "x-uos-native-response-mac" && v == "synthetic-reply-mac")
        );
    }
    let observed = peer.task.join().unwrap();
    assert_eq!(observed.len(), 2);
    for (i, row) in observed.iter().enumerate() {
        assert_eq!(row.sni, "localhost");
        assert_eq!(
            row.line,
            format!("POST {NATIVE_RENEWAL_AUTHORITY_PATH} HTTP/1.1")
        );
        assert_eq!(
            row.headers.get("host").map(String::as_str),
            Some("localhost")
        );
        assert_eq!(
            row.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
        for (name, value) in headers(i as u8) {
            assert_eq!(row.headers.get(&name), Some(&value));
        }
        assert_eq!(
            row.body,
            if i == 0 {
                b"one".as_slice()
            } else {
                b"two".as_slice()
            }
        );
    }
    assert!(transport.send(&headers(3), b"never", bound, 16).is_err());
    peer.listener.set_nonblocking(true).unwrap();
    assert!(matches!(peer.listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}
#[test]
fn normal_webpki_wrong_hostname_and_wrong_targets_refuse_actual_tls() {
    for (host, fixture) in [("localhost", false), ("not-in-fixture.invalid", true)] {
        let mut peer = Peer::start(vec![response(200, b"never", "close")]);
        let transport = peer.transport(host, fixture);
        assert!(
            transport
                .send(&headers(1), b"never", deadline(), 16)
                .is_err()
        );
        drop(transport);
        assert!(peer.task.join().unwrap().is_empty());
    }
    let mut redirect = Peer::start(vec![b"HTTP/1.1 302 Native\r\nLocation: https://forbidden.invalid/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()]);
    let transport = redirect.transport("localhost", true);
    assert_eq!(
        transport
            .send(&headers(1), b"no-follow", deadline(), 16)
            .unwrap()
            .status(),
        302
    );
    assert_eq!(redirect.task.join().unwrap().len(), 1);
    redirect.listener.set_nonblocking(true).unwrap();
    assert!(
        matches!(redirect.listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock)
    );
    for target in [
        "http://localhost/uos/native/renewal-authority",
        "https://user@localhost/uos/native/renewal-authority",
        "https://localhost/wrong",
        "https://localhost/uos/native/renewal-authority?x=1",
        "https://localhost/uos/native/renewal-authority#x",
    ] {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        assert!(ImportAuthorityTls::from_connected(target, socket, Roots::fixture(CA)).is_err());
    }
}
#[test]
fn caller_host_hop_headers_duplicates_and_invalid_native_values_never_reach_peer() {
    let mut peer = Peer::start(vec![response(200, b"valid", "close")]);
    let transport = peer.transport("localhost", true);
    for name in [
        "Host",
        "Connection",
        "Transfer-Encoding",
        "Content-Length",
        "x-unknown",
    ] {
        let mut bad = headers(1);
        bad[0] = (name.into(), "attacker".into());
        assert!(
            transport
                .send(&bad, b"must-not-send", deadline(), 16)
                .is_err()
        );
    }
    let mut duplicate = headers(1);
    duplicate[0] = duplicate[1].clone();
    assert!(
        transport
            .send(&duplicate, b"must-not-send", deadline(), 16)
            .is_err()
    );
    for (index, value) in [
        (0, "2"),
        (1, "bad.key"),
        (2, "01"),
        (3, "bad"),
        (4, "bad\r\nHost: attacker"),
    ] {
        let mut bad = headers(1);
        bad[index].1 = value.into();
        assert!(
            transport
                .send(&bad, b"must-not-send", deadline(), 16)
                .is_err()
        );
    }
    assert_eq!(
        transport
            .send(&headers(2), b"actual", deadline(), 16)
            .unwrap()
            .body(),
        b"valid"
    );
    let observed = peer.task.join().unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].body, b"actual");
}
#[test]
fn bounded_truncated_chunked_and_original_error_limits_poison_without_reconnect() {
    let cases = [b"HTTP/1.1 200 Native\r\nContent-Length: 999999999\r\nConnection: close\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 Native\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc".to_vec(),
        b"HTTP/1.1 200 Native\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n11\r\n12345678901234567\r\n0\r\n\r\n".to_vec(),
        response(503, &vec![b'x'; 4097], "close")];
    for (index, bytes) in cases.into_iter().enumerate() {
        let mut peer = Peer::start(vec![bytes]);
        let transport = peer.transport("localhost", true);
        assert!(
            transport
                .send(
                    &headers(1),
                    b"bounded",
                    deadline(),
                    if index == 3 { 100_000 } else { 16 }
                )
                .is_err()
        );
        assert!(
            transport
                .send(&headers(2), b"no-retry", deadline(), 100_000)
                .is_err()
        );
        drop(transport);
        let observed = peer.task.join().unwrap();
        assert_eq!(observed.len(), 1);
        peer.listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(peer.listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock)
        );
    }
    for (status, length, cap) in [(200, 16, 16), (503, 4096, 100_000)] {
        let mut peer = Peer::start(vec![response(status, &vec![b'x'; length], "close")]);
        let transport = peer.transport("localhost", true);
        let reply = transport
            .send(&headers(1), b"exact-bound", deadline(), cap)
            .unwrap();
        assert_eq!(reply.status(), status);
        assert_eq!(reply.body().len(), length);
        assert_eq!(peer.task.join().unwrap().len(), 1);
    }
}
#[test]
fn original_monotonic_deadline_cannot_be_extended_or_refreshed() {
    let mut peer = Peer::start(vec![response(200, b"first", "keep-alive")]);
    let transport = peer.transport("localhost", true);
    assert!(
        transport
            .send(&headers(1), b"expired", Instant::now(), 16)
            .is_err()
    );
    assert!(
        transport
            .send(
                &headers(1),
                b"too-long",
                Instant::now() + Duration::from_secs(46),
                16
            )
            .is_err()
    );
    let original = Instant::now() + Duration::from_millis(300);
    assert_eq!(
        transport
            .send(&headers(1), b"once", original, 16)
            .unwrap()
            .body(),
        b"first"
    );
    thread::sleep(original.saturating_duration_since(Instant::now()) + Duration::from_millis(1));
    assert!(
        transport
            .send(&headers(2), b"renewed", deadline(), 16)
            .is_err()
    );
    drop(transport);
    assert_eq!(peer.task.join().unwrap().len(), 1);
}
