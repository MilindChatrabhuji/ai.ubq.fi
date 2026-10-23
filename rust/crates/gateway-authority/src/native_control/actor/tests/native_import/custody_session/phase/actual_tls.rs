//! Actual loopback TLS + MAC + same authority store, not a reply-reader mock.
use super::*;
use crate::native_control::import::RemoteImportAuthority;
use gateway_auth::native::*;
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[cfg(not(feature = "native-import-fixture"))]
const CA: &[u8] =
    include_bytes!("../../../../../../../../gateway-native/tests/fixtures/import-tls/ca.der");
const CERT: &[u8] =
    include_bytes!("../../../../../../../../gateway-native/tests/fixtures/import-tls/leaf.der");
const KEY: &[u8] =
    include_bytes!("../../../../../../../../gateway-native/tests/fixtures/import-tls/leaf.pk8.der");
const PRIVATE_BODY: &[u8] = b"PRIVATE_SYNTHETIC_IMPORT_BODY_MUST_STAY_NATIVE";
fn wall() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}
fn prepare() -> (Fixture, NativeImportMetadata) {
    let f = Fixture::new();
    f.store.now.store(wall(), Ordering::SeqCst);
    f.catalog_seed();
    let token = session_setup(&f.store, true, true);
    let session = PasskeySession {
        token: token.clone(),
        user_id: "user-fixture".into(),
        created_at_ms: f.store.now.load(Ordering::SeqCst) - 1,
        expires_at_ms: f.store.now.load(Ordering::SeqCst) + 90_000,
        audience_origin: None,
    };
    f.store
        .seed(passkeys::key("sessions", &token), "session-1", &session);
    f.store.rows.lock().unwrap().insert(
        session_index::index_key(&session_index::digest(&token))
            .unwrap()
            .0,
        session_index::record_for_session(&session, "session-1", None).unwrap(),
    );
    let metadata = run(async {
        let mut ctx = context("passkey-user:user-fixture", None);
        ctx.started_at_ms = f.store.now.load(Ordering::SeqCst);
        let actor = actor::authenticate_admin_actor(
            &f.authority,
            &Host::new(&f.store),
            &f.cfg,
            &request(&token),
            &ctx,
        )
        .await
        .unwrap();
        f.control()
            .prepare_import(
                &actor,
                NativeImportTarget::ExistingAccount {
                    account_id_hash: f.hash.clone(),
                },
            )
            .await
            .unwrap()
            .metadata()
            .clone()
    });
    (f, metadata)
}
fn admission(metadata: &NativeImportMetadata, salt: u8) -> NativeImportAdmission {
    run(async {
        let id = identity();
        let now = wall();
        let nonce = base64url(&[salt; 32]);
        let digest = sha256_hex(PRIVATE_BODY);
        let time = now.to_string();
        let mac = id
            .sign_import(NativeImportKind::CodexAuth, metadata, &digest, now, &nonce)
            .unwrap();
        NativeAuthenticator::new(&id, &Replay::default())
            .admit_import(
                NativeImportKind::CodexAuth,
                NativeImportAuthHeaders {
                    auth: NativeAuthHeaders {
                        version: "1",
                        key_id: id.key_id(),
                        time_ms: &time,
                        nonce: &nonce,
                        mac: &mac,
                    },
                    body_sha256: &digest,
                },
                metadata,
                now,
            )
            .await
            .unwrap()
    })
}
#[derive(Clone, Copy)]
enum Fault {
    None,
    WrongMac,
    LoseStart,
    RevokeFinish,
}
struct ResultPeer {
    bodies: Vec<Vec<u8>>,
    final_rows: serde_json::Value,
}
struct Peer {
    socket: TcpStream,
    task: thread::JoinHandle<ResultPeer>,
}
fn read_http(stream: &mut impl Read) -> Option<(BTreeMap<String, String>, Vec<u8>)> {
    let mut header = Vec::new();
    let mut byte = [0u8];
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() > 16_384 || stream.read(&mut byte).ok()? != 1 {
            return None;
        }
        header.push(byte[0]);
    }
    let text = std::str::from_utf8(&header).ok()?;
    let mut lines = text.split("\r\n");
    assert_eq!(
        lines.next()?,
        format!("POST {NATIVE_RENEWAL_AUTHORITY_PATH} HTTP/1.1")
    );
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
        .collect::<BTreeMap<_, _>>();
    let length: usize = headers.get("content-length")?.parse().ok()?;
    if length > gateway_auth::native_import::authority::import_authority_request_max_bytes() {
        return None;
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).ok()?;
    Some((headers, body))
}
fn peer(f: Fixture, fault: Fault) -> Peer {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let socket = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let task = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        drop(listener);
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(CERT.to_vec())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(KEY.to_vec())),
            )
            .unwrap();
        let mut tls = StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), socket);
        let mut bodies = Vec::new();
        while let Some((headers, body)) = read_http(&mut tls) {
            assert_eq!(tls.conn.server_name(), Some("localhost"));
            f.store.now.store(wall(), Ordering::SeqCst);
            let command = Request::parse(&body).ok();
            if matches!(fault, Fault::RevokeFinish)
                && command
                    .as_ref()
                    .is_some_and(|request| matches!(request.command, Command::FinishCurrent { .. }))
            {
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .remove(&passkeys::key("users", "user-fixture").0);
            }
            let result = run(async {
                let control = f.control();
                let owner = control
                    .authenticate_import_authority(
                        NativeAuthHeaders {
                            version: &headers[NATIVE_VERSION_HEADER],
                            key_id: &headers[NATIVE_KEY_HEADER],
                            time_ms: &headers[NATIVE_TIME_HEADER],
                            nonce: &headers[NATIVE_NONCE_HEADER],
                            mac: &headers[NATIVE_MAC_HEADER],
                        },
                        &body,
                    )
                    .await?;
                if gateway_auth::native_import::authority::ImportCustodyStartedWire::parse(&body)
                    .is_ok()
                {
                    control.handle_import_started(&owner, &body).await
                } else {
                    control.handle_import_authority(&owner, &body).await
                }
            });
            bodies.push(body.clone());
            if matches!(fault, Fault::LoseStart)
                && command
                    .as_ref()
                    .is_some_and(|request| matches!(request.command, Command::Start { .. }))
            {
                assert!(result.is_ok());
                break;
            }
            let (status, response) = match result {
                Ok(bytes) => (200, bytes),
                Err(error) => (error.status, serde_json::to_vec(&error.envelope).unwrap()),
            };
            let mac = if matches!(fault, Fault::WrongMac) {
                base64url(&[0; 32])
            } else {
                f.id.sign_authority_response(
                    &headers[NATIVE_NONCE_HEADER],
                    &body,
                    status,
                    &response,
                )
                .unwrap()
            };
            let header = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{NATIVE_RESPONSE_MAC_HEADER}: {mac}\r\n\r\n",
                response.len()
            );
            if tls
                .write_all(header.as_bytes())
                .and_then(|_| tls.write_all(&response))
                .and_then(|_| tls.flush())
                .is_err()
            {
                break;
            }
        }
        ResultPeer {
            bodies,
            final_rows: f.snapshot(),
        }
    });
    Peer { socket, task }
}
fn client<'a>(socket: TcpStream, cancel: &'a CancelNow) -> RemoteImportAuthority<'a, CancelNow> {
    #[cfg(feature = "native-import-fixture")]
    let authority = RemoteImportAuthority::from_fixture_connected(
        socket,
        identity(),
        cancel,
        Instant::now() + Duration::from_secs(40),
    );
    #[cfg(not(feature = "native-import-fixture"))]
    let authority = RemoteImportAuthority::fixture_connected(
        &format!("https://localhost{NATIVE_RENEWAL_AUTHORITY_PATH}"),
        socket,
        identity(),
        cancel,
        Instant::now() + Duration::from_secs(40),
        CA,
    );
    authority.unwrap()
}
#[test]
fn actual_tls_local_body_mac_original_claim_start_and_readonly_b1_agree() {
    let (f, metadata) = prepare();
    let Peer { socket, task } = peer(f, Fault::None);
    let cancel = CancelNow::default();
    let client = client(socket, &cancel);
    let admitted = client.admit_import(admission(&metadata, 101)).unwrap();
    assert_eq!(admitted.native_owner_id(), "native-owner");
    let NativeImportTarget::ExistingAccount { account_id_hash } = admitted.target() else {
        panic!("admission must retain the actual existing-account target");
    };
    assert_eq!(admitted.account_id_hash(), account_id_hash);
    let proof = client.finish_import(admitted, PRIVATE_BODY).unwrap();
    assert_eq!(proof.metadata(), &metadata);
    proof.require_body(PRIVATE_BODY, wall()).unwrap();
    assert!(proof.require_body(b"OTHER", wall()).is_err());
    let mut claim = client.claim_import(&proof).unwrap();
    assert_eq!(claim.mode(), NativeImportMode::ImportOnce);
    let start = client.start_import(&mut claim, &proof).unwrap().unwrap();
    let started = start.custody_request().unwrap();
    let observed = client.verify_started_custody(&started).unwrap();
    assert_eq!(
        observed.request().canonical_bytes().unwrap(),
        started.canonical_bytes().unwrap()
    );
    assert!(client.start_import(&mut claim, &proof).unwrap().is_none());
    client.recheck_import(&proof).unwrap();
    client.recheck_import_claim(&claim).unwrap();
    assert_eq!(
        client.observe_import_catalog(&proof).unwrap().revision(),
        Some("catalog-before")
    );
    client.unknown_import(&claim).unwrap();
    cancel.0.store(true, Ordering::SeqCst);
    assert!(client.recheck_import(&proof).is_err());
    drop(client);
    let result = task.join().unwrap();
    for body in &result.bodies {
        let text = String::from_utf8_lossy(body);
        assert!(!text.contains(std::str::from_utf8(PRIVATE_BODY).unwrap()));
        assert!(!text.contains(&sha256_hex(PRIVATE_BODY)));
    }
    let key = crate::native_control::rows::key("operation", &metadata.operation_id);
    assert_eq!(result.final_rows[&key.0]["value"]["phase"], "unknown");
}
#[test]
fn wrong_body_or_mac_and_revoked_finish_cannot_mint_remote_body_proof() {
    for fault in [Fault::None, Fault::WrongMac, Fault::RevokeFinish] {
        let (f, metadata) = prepare();
        let Peer { socket, task } = peer(f, fault);
        let cancel = CancelNow::default();
        let client = client(socket, &cancel);
        let admitted = client.admit_import(admission(&metadata, 102));
        if matches!(fault, Fault::WrongMac) {
            assert!(admitted.is_err());
        } else {
            let admitted = admitted.unwrap();
            let body = if matches!(fault, Fault::None) {
                &b"WRONG_BODY"[..]
            } else {
                PRIVATE_BODY
            };
            assert!(client.finish_import(admitted, body).is_err());
        }
        drop(client);
        let result = task.join().unwrap();
        assert_eq!(
            result.bodies.len(),
            if matches!(fault, Fault::RevokeFinish) {
                2
            } else {
                1
            }
        );
        let key = crate::native_control::rows::key("operation", &metadata.operation_id);
        assert!(result.final_rows.get(&key.0).is_none());
    }
}
#[test]
fn lost_actual_start_reply_consumes_client_permit_and_cannot_repeat_effect() {
    let (f, metadata) = prepare();
    let Peer { socket, task } = peer(f, Fault::LoseStart);
    let cancel = CancelNow::default();
    let client = client(socket, &cancel);
    let admitted = client.admit_import(admission(&metadata, 103)).unwrap();
    let proof = client.finish_import(admitted, PRIVATE_BODY).unwrap();
    let mut claim = client.claim_import(&proof).unwrap();
    assert!(client.start_import(&mut claim, &proof).is_err());
    assert_eq!(claim.mode(), NativeImportMode::ReconcileOnly);
    assert!(client.start_import(&mut claim, &proof).unwrap().is_none());
    drop(client);
    let result = task.join().unwrap();
    let key = crate::native_control::rows::key("operation", &metadata.operation_id);
    assert_eq!(result.final_rows[&key.0]["value"]["phase"], "started");
    assert_eq!(result.bodies.len(), 4);
}

mod terminal;
