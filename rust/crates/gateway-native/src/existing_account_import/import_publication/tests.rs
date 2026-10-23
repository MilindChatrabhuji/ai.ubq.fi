//! Actual TLS and response authentication only, never a durable completion issuer.
use super::*;
use gateway_authority::native_control::import::{
    ImportPublicationDataV1, NativeImportPublicationDisposition,
};
use gateway_core::source_json::SourceJson;
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
    thread,
    time::Duration,
};

fn identity() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "publication-fixture".into(),
        "owner".into(),
        "epoch".into(),
        [43; 32],
        BTreeSet::from([gateway_auth::native_auth::NativeCapability::CodexAuthImport]),
    )
    .unwrap()
}
fn command(limited: bool) -> ImportPublicationCommandData {
    let credentials = codex_credential_identity(
        "synthetic-account",
        &Secret::new("SYNTHETIC_ACCESS".into()),
        &Secret::new(String::new()),
    );
    ImportPublicationCommandData {
        operation: "codex_auth_import_publish".into(),
        v: 1,
        action_ref: "a".repeat(64),
        operation_id: "operation".into(),
        claim_ref: "claim".into(),
        native_owner_id: "owner".into(),
        owner_revision: "owner-r1".into(),
        source_revision: "source-r1".into(),
        normalized_revision: "normalized-r1".into(),
        publication_revision: "publication-r1".into(),
        account_id_hash: credentials.routing_account_hash.0,
        previous_native_source_generation: "c".repeat(64),
        native_source_generation: "d".repeat(64),
        access_generation: credentials.native_generation_hash,
        native_receipt_ref: "receipt-r1".into(),
        document: ImportAccessDocument {
            account_id: "synthetic-account".into(),
            access_token: "SYNTHETIC_ACCESS".into(),
            updated_at_ms: 1_000.0,
            native_refreshed_at: None,
        },
        catalog: if limited {
            ImportCatalogData::AuthenticatedLimited {
                upstream_status: 429,
            }
        } else {
            ImportCatalogData::Normalized {
                snapshot: SourceJson::parse(r#"{"models":[{"slug":"synthetic"}]}"#).unwrap(),
                client_version: "0.163.0".into(),
                upstream_status: 200,
            }
        },
    }
}
fn reply(command: &ImportPublicationCommandData) -> NativeImportPublication {
    let version = codex_credential_identity(
        &command.document.account_id,
        &Secret::new(command.document.access_token.clone()),
        &Secret::new(String::new()),
    );
    let revision = command.publication_revision.clone();
    NativeImportPublication {
        v: 1,
        operation_id: command.operation_id.clone(),
        action_ref: command.action_ref.clone(),
        disposition: NativeImportPublicationDisposition::Applied,
        publication: ImportPublicationDataV1 {
            v: 1,
            operation_id: command.operation_id.clone(),
            claim_ref: command.claim_ref.clone(),
            publication_revision: revision.clone(),
            native_receipt_ref: command.native_receipt_ref.clone(),
            native_source_generation: command.native_source_generation.clone(),
            access_generation: command.access_generation.clone(),
            credential_version: version.credential_version.0,
            source_revision: revision.clone(),
            normalized_revision: revision.clone(),
            catalog_revision: Some(revision.clone()),
            runtime_revision: Some(revision.clone()),
            auth_generation_revision: Some(revision.clone()),
            paid_control_config_revision: Some(revision),
            publication_request_digest: sha256_hex(&command.bytes().unwrap()),
            catalog_disposition: command.catalog.disposition(),
        },
    }
}
#[derive(Clone, Copy)]
enum Response {
    Valid,
    LargeValid,
    ForgedMac,
    Dropped,
    Redirect,
    OversizedError,
}
struct Observed {
    sni: String,
    line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
struct Peer {
    socket: TcpStream,
    task: thread::JoinHandle<Option<Observed>>,
    listener: TcpListener,
}
impl Peer {
    fn start(command: &ImportPublicationCommandData, response: Response) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let server = listener.try_clone().unwrap();
        let expected = command.bytes().unwrap();
        let mut publication = reply(command);
        if matches!(response, Response::LargeValid) {
            assert!(matches!(
                command.catalog,
                ImportCatalogData::AuthenticatedLimited { .. }
            ));
            let retained = "\u{1}".repeat(4096);
            publication.publication.catalog_revision = Some(retained.clone());
            publication.publication.runtime_revision = Some(retained.clone());
            publication.publication.auth_generation_revision = Some(retained.clone());
            publication.publication.paid_control_config_revision = Some(retained);
        }
        let valid_reply = serde_json::to_vec(&publication).unwrap();
        NativeImportPublication::parse_for(&valid_reply, &expected)
            .expect("Canonical source-bound synthetic reply");
        if matches!(response, Response::LargeValid) {
            assert!(valid_reply.len() > 65_536);
        }
        let task = thread::spawn(move || {
            let (socket, _) = server.accept().ok()?;
            socket.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .ok()?;
            let cert = include_bytes!("../../../tests/fixtures/native-tls/leaf.der");
            let key = include_bytes!("../../../tests/fixtures/native-tls/leaf.pk8.der");
            let config = ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from(cert.to_vec())],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.to_vec())),
                )
                .ok()?;
            let mut tls = StreamOwned::new(ServerConnection::new(Arc::new(config)).ok()?, socket);
            let mut bytes = Vec::new();
            let (line, headers, body) = loop {
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let header = std::str::from_utf8(&bytes[..end]).ok()?;
                    let mut lines = header.split("\r\n");
                    let line = lines.next()?.to_owned();
                    let headers: BTreeMap<_, _> = lines
                        .map(|line| line.split_once(':'))
                        .collect::<Option<Vec<_>>>()?
                        .into_iter()
                        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
                        .collect();
                    let length: usize = headers.get("content-length")?.parse().ok()?;
                    if bytes.len() >= end + 4 + length {
                        break (line, headers, bytes[end + 4..end + 4 + length].to_vec());
                    }
                }
                if bytes.len()
                    > gateway_authority::native_control::import::import_publication_max_bytes()
                        + 16_384
                {
                    return None;
                }
                let mut chunk = [0; 8192];
                let n = tls.read(&mut chunk).ok()?;
                if n == 0 {
                    return None;
                }
                bytes.extend_from_slice(&chunk[..n]);
            };
            if body != expected {
                return None;
            }
            let auth = identity();
            let nonce = headers.get(NATIVE_NONCE_HEADER)?;
            let time: i64 = headers.get(NATIVE_TIME_HEADER)?.parse().ok()?;
            if headers.get(NATIVE_MAC_HEADER)?
                != &auth
                    .sign(NATIVE_PUBLICATION_PATH, time, nonce, &body)
                    .ok()?
            {
                return None;
            }
            let observed = Observed {
                sni: tls.conn.server_name()?.into(),
                line,
                headers,
                body,
            };
            if matches!(response, Response::Dropped) {
                return Some(observed);
            }
            let status = if matches!(response, Response::Redirect) {
                302
            } else if matches!(response, Response::OversizedError) {
                503
            } else {
                200
            };
            let payload = if matches!(response, Response::OversizedError) {
                vec![b'x'; 65_537]
            } else {
                valid_reply
            };
            let signature = if matches!(response, Response::Valid | Response::LargeValid) {
                auth.sign_publication_response(
                    observed.headers.get(NATIVE_NONCE_HEADER)?,
                    &observed.body,
                    status,
                    &payload,
                )
                .ok()?
            } else {
                base64url(&[0; 32])
            };
            let head = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nLocation: https://forbidden.invalid/collect\r\n{NATIVE_RESPONSE_MAC_HEADER}: {signature}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = tls
                .write_all(head.as_bytes())
                .and_then(|_| tls.write_all(&payload))
                .and_then(|_| tls.flush());
            Some(observed)
        });
        Self {
            socket,
            task,
            listener,
        }
    }
}
#[test]
fn actual_signed_publication_reply_matches_original_bytes_and_retains_old_limits() {
    for (limited, response) in [
        (false, Response::Valid),
        (true, Response::Valid),
        (true, Response::LargeValid),
    ] {
        let command = command(limited);
        let Peer {
            socket,
            task,
            listener,
        } = Peer::start(&command, response);
        let sender = ImportPublicationHttp::fixture(
            "https://localhost/uos/native/publication",
            socket,
            identity(),
            include_bytes!("../../../tests/fixtures/native-tls/ca.der"),
        )
        .unwrap();
        let result = sender
            .exchange_data(&command, Instant::now() + Duration::from_secs(3))
            .unwrap();
        assert_eq!(
            result.request_digest(),
            sha256_hex(&command.bytes().unwrap())
        );
        assert_eq!(
            result.publication().publication.native_receipt_ref,
            command.native_receipt_ref
        );
        let observed = task.join().unwrap().unwrap();
        assert_eq!(observed.sni, "localhost");
        assert_eq!(observed.line, "POST /uos/native/publication HTTP/1.1");
        assert_eq!(observed.body, command.bytes().unwrap());
        assert_eq!(
            observed.headers.get(NATIVE_KEY_HEADER).map(String::as_str),
            Some("publication-fixture")
        );
        assert!(
            sender
                .exchange_data(&command, Instant::now() + Duration::from_millis(100))
                .is_err()
        );
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }
}
#[test]
fn actual_unsigned_dropped_redirect_and_oversized_error_never_issue_authenticated_reply() {
    for response in [
        Response::ForgedMac,
        Response::Dropped,
        Response::Redirect,
        Response::OversizedError,
    ] {
        let command = command(false);
        let Peer {
            socket,
            task,
            listener,
        } = Peer::start(&command, response);
        let sender = ImportPublicationHttp::fixture(
            "https://localhost/uos/native/publication",
            socket,
            identity(),
            include_bytes!("../../../tests/fixtures/native-tls/ca.der"),
        )
        .unwrap();
        assert!(
            sender
                .exchange_data(&command, Instant::now() + Duration::from_secs(3))
                .is_err()
        );
        assert!(task.join().unwrap().is_some());
        assert!(
            sender
                .exchange_data(&command, Instant::now() + Duration::from_millis(100))
                .is_err()
        );
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }
}

#[test]
fn actual_ordinary_private_https_reader_keeps_65536_even_for_a_new_import_body() {
    let command = command(true);
    let body = command.bytes().unwrap();
    let Peer {
        socket,
        task,
        listener: _,
    } = Peer::start(&command, Response::LargeValid);
    let transport = PrivateHttps::from_connected(
        "https://localhost/uos/native/publication",
        NATIVE_PUBLICATION_PATH,
        socket,
        ureq::tls::RootCerts::new_with_certs(&[ureq::tls::Certificate::from_der(include_bytes!(
            "../../../tests/fixtures/native-tls/ca.der"
        ))
        .to_owned()]),
    )
    .unwrap();
    let nonce = base64url(&[7; 32]);
    let now = crate::http_server::now_ms().unwrap();
    let id = identity();
    let headers = vec![
        (NATIVE_VERSION_HEADER.into(), "1".into()),
        (NATIVE_KEY_HEADER.into(), id.key_id().into()),
        (NATIVE_TIME_HEADER.into(), now.to_string()),
        (NATIVE_NONCE_HEADER.into(), nonce.clone()),
        (
            NATIVE_MAC_HEADER.into(),
            id.sign(NATIVE_PUBLICATION_PATH, now, &nonce, &body)
                .unwrap(),
        ),
    ];
    assert!(
        transport
            .send(
                &headers,
                &body,
                Instant::now() + Duration::from_secs(3),
                65_536
            )
            .is_err()
    );
    assert!(task.join().unwrap().is_some());
}
