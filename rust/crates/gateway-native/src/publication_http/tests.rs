use super::*;
use gateway_auth::{
    native::NATIVE_RESPONSE_MAC_HEADER,
    native_auth::{NativeCapability, NativeTransportIdentity},
};
use gateway_authority::paid_control::{PAID_CONTROL_CONFIG_VERSION, PaidControlConfig};
use gateway_publication::{
    transport::NativePublicationSender,
    wire::{PreparedPublicationCommand, PublicationDisposition, PublicationReceipt},
};
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::Instant,
};

fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [17; 32],
        BTreeSet::from([NativeCapability::ConfigurationPublish]),
    )
    .unwrap()
}
fn configuration() -> PaidControlConfig {
    PaidControlConfig {
        v: PAID_CONTROL_CONFIG_VERSION,
        owner_id: "fixture-owner".into(),
        owner_epoch: "fixture-epoch".into(),
        generation: "fixture-generation".into(),
        configuration_fingerprint: "fixture-fingerprint".into(),
        surplus_binding: None,
        openlux_discovery_binding: Some("fixture-discovery-binding".into()),
        openlux_binding: Some("fixture-spend-binding".into()),
        source_checks: vec![],
    }
}
fn read_request(stream: &mut impl Read) -> Option<(BTreeMap<String, String>, Vec<u8>)> {
    let mut request = Vec::new();
    loop {
        if request.len() > 65_536 {
            return None;
        }
        if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
            let head = std::str::from_utf8(&request[..end]).ok()?;
            let mut lines = head.split("\r\n");
            assert_eq!(
                lines.next()?,
                format!("POST {NATIVE_PUBLICATION_PATH} HTTP/1.1")
            );
            let headers: BTreeMap<_, _> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            let length: usize = headers.get("content-length")?.parse().ok()?;
            if request.len() >= end + 4 + length {
                return Some((headers, request[end + 4..end + 4 + length].to_vec()));
            }
        }
        let mut buffer = [0; 4096];
        let length = stream.read(&mut buffer).ok()?;
        if length == 0 {
            return None;
        }
        request.extend_from_slice(&buffer[..length]);
    }
}
struct Peer {
    target: String,
    join: Option<thread::JoinHandle<bool>>,
}
impl Peer {
    fn start(tamper: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let target = format!(
            "https://{}{NATIVE_PUBLICATION_PATH}",
            listener.local_addr().unwrap()
        );
        let join = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let stream: TcpStream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        thread::sleep(Duration::from_millis(5))
                    }
                    _ => return false,
                }
            };
            stream.set_nonblocking(false).unwrap();
            assert!(
                !rustix::fs::fcntl_getfl(&stream)
                    .unwrap()
                    .contains(rustix::fs::OFlags::NONBLOCK)
            );
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let cert = CertificateDer::from(
                include_bytes!("../../tests/fixtures/native-tls/leaf.der").to_vec(),
            );
            let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                include_bytes!("../../tests/fixtures/native-tls/leaf.pk8.der").to_vec(),
            ));
            let config = ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(vec![cert], key)
                .unwrap();
            let mut tls =
                StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), stream);
            let Some((headers, body)) = read_request(&mut tls) else {
                return false;
            };
            let identity = identity();
            assert_eq!(
                headers.get("x-uos-native-key-id").unwrap(),
                identity.key_id()
            );
            let nonce = headers.get("x-uos-native-nonce").unwrap();
            let now = headers
                .get("x-uos-native-time-ms")
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(
                *headers.get("x-uos-native-mac").unwrap(),
                identity
                    .sign(NATIVE_PUBLICATION_PATH, now, nonce, &body)
                    .unwrap()
            );
            let config = configuration();
            let receipt = PublicationReceipt {
                v: 1,
                operation: "config_publish".into(),
                disposition: PublicationDisposition::Applied,
                owner_id: config.owner_id,
                owner_epoch: config.owner_epoch,
                owner_revision: "fixture-owner-r1".into(),
                publication_revision: "fixture-config-r1".into(),
                configuration_revision: Some("fixture-config-r1".into()),
                configuration_generation: Some(config.generation),
                configuration_fingerprint: Some(config.configuration_fingerprint),
                source_revision: None,
                normalized_revision: None,
                pool_versionstamp: None,
                native_owner_id: None,
                account_id_hash: None,
                credential_version: None,
                native_generation: None,
            };
            let mut reply = serde_json::to_vec(&receipt).unwrap();
            let mac = identity
                .sign_publication_response(nonce, &body, 200, &reply)
                .unwrap();
            if tamper {
                reply.push(b' ');
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{NATIVE_RESPONSE_MAC_HEADER}: {mac}\r\nConnection: close\r\n\r\n",
                reply.len()
            );
            tls.write_all(head.as_bytes()).unwrap();
            tls.write_all(&reply).unwrap();
            tls.flush().unwrap();
            true
        });
        Self {
            target,
            join: Some(join),
        }
    }
    fn finish(&mut self) -> bool {
        self.join.take().unwrap().join().unwrap()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        if let Some(join) = self.join.take() {
            join.join().unwrap();
        }
    }
}

#[test]
fn real_https_transport_verifies_peer_and_signed_publication_receipts() {
    for (fixture_trust, tamper) in [(false, false), (true, false), (true, true)] {
        let mut peer = Peer::start(tamper);
        let mut carrier = HttpsPublicationCarrier::configured(&peer.target).unwrap();
        assert!(!carrier.agent.config().tls_config().disable_verification());
        if fixture_trust {
            let ca = ureq::tls::Certificate::from_der(include_bytes!(
                "../../tests/fixtures/native-tls/ca.der"
            ))
            .to_owned();
            // This private unit-only anchor changes no public constructor or
            // production trust. Every other transport option is shared.
            carrier.agent = configured_agent(ureq::tls::RootCerts::new_with_certs(&[ca]));
        }
        let identity = identity();
        let command = PreparedPublicationCommand::configuration_from_expected(
            configuration(),
            "fixture-owner-r1".into(),
            None,
            "fixture-config-r1".into(),
        )
        .unwrap();
        let result = futures_executor::block_on(
            NativePublicationSender::configured(&identity, &carrier).send(
                &command,
                [9; 32],
                crate::http_server::now_ms().unwrap(),
            ),
        );
        let reached_http = peer.finish();
        if !fixture_trust {
            assert!(
                !reached_http,
                "untrusted TLS must fail before the authenticated HTTP request"
            );
            assert_eq!(
                result.unwrap_err().envelope.error.code.as_deref(),
                Some("native_publication_outcome_unknown")
            );
        } else if tamper {
            assert!(reached_http);
            assert_eq!(
                result.unwrap_err().envelope.error.code.as_deref(),
                Some("native_publication_response_unverified")
            );
        } else {
            assert!(reached_http);
            let receipt = result.unwrap();
            assert_eq!(receipt.disposition, PublicationDisposition::Applied);
            assert_eq!(
                receipt.configuration_revision.as_deref(),
                Some("fixture-config-r1")
            );
        }
    }
    assert!(
        HttpsPublicationCarrier::configured("http://127.0.0.1/uos/native/publication").is_err()
    );
}
