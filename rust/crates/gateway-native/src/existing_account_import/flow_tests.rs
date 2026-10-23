//! Actual debug-only two-process native import fixtures. No v3 row rewriting,
//! credential provider traffic, fake Start, raw-response issuer or live UID work.
use super::foundation_tests::assert_owned_canonical_directory;
use super::*;
use crate::http_server::import_http_tests as base;
use gateway_auth::{
    AuthRequest,
    crypto::{Secret, base64url, sha256_hex},
    native::*,
    native_auth::{NativeAuthHeaders, NativeCapability, NativeTransportIdentity},
    native_import::*,
    passkeys::{self, PasskeySession, PasskeyUser},
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, CodexSourcePool, MANAGED_NATIVE_SOURCE_VERSION,
        ManagedNativeSource, codex_source_pool_key,
    },
    session_index,
};
use gateway_authority::{
    Authority, keys,
    native_control::{NativeRenewalAuthority, RegisteredRenewalOwner, actor},
    paid_control::PaidControlOwner,
    routing::{PoolAccount, SubscriptionPool},
};
use gateway_core::{
    identity::{PoolVersionstamp, PrincipalId, RequestContext, RequestId},
    source_json::SourceJson,
    state::AuthorityStore,
};
use gateway_publication::{
    control_publication::{ConfiguredPaidInputs, PreparedConfigurationPublication},
    transport::{OwnedNativeAuthHeaders, PublicationReceiver, PublicationRequest},
};
use rustls::{ServerConfig, ServerConnection, StreamOwned, pki_types::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

struct FlowTokens;
impl gateway_authority::TokenSource for FlowTokens {
    fn next_token(&self) -> Result<String, gateway_core::GatewayError> {
        static NEXT: AtomicUsize = AtomicUsize::new(1);
        Ok(format!(
            "native-flow-token-{}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
fn authority(store: &base::Store) -> Authority<base::Store, FlowTokens> {
    Authority::with_clock(store.clone(), FlowTokens, store.clone())
}
impl gateway_core::query::QueryStore for base::Store {
    async fn query(
        &self,
        request: gateway_core::query::QueryRequest,
    ) -> Result<gateway_core::query::QueryPage, gateway_core::GatewayError> {
        use gateway_core::{
            query::{QueryEntry, QueryPage},
            state::RecordKey,
            tuple_key::TupleKey,
        };
        let checked = request.validate()?;
        let rows = self.rows.lock().unwrap();
        let mut matching = Vec::new();
        for (key, record) in rows.iter() {
            let key = RecordKey(key.clone());
            if checked.accepts_record(&key, record)? {
                matching.push((
                    TupleKey::from_record_key(&key)?.sort_bytes().to_vec(),
                    QueryEntry {
                        key,
                        record: record.clone(),
                    },
                ));
            }
        }
        matching.sort_by(|a, b| a.0.cmp(&b.0));
        if checked.reverse {
            matching.reverse();
        }
        let more = matching.len() > checked.limit as usize;
        matching.truncate(checked.limit as usize);
        let entries = matching
            .into_iter()
            .map(|(_, entry)| entry)
            .collect::<Vec<_>>();
        let next_cursor = if more {
            entries
                .last()
                .map(|entry| checked.cursor_after(&entry.key))
                .transpose()?
        } else {
            None
        };
        Ok(QueryPage {
            entries,
            next_cursor,
        })
    }
}
const MODELS: &[u8] = br#"{"models":[{"slug":"synthetic-model","display_name":"Synthetic","supported_reasoning_levels":[{"effort":"none","description":"None"}]}]}"#;
fn key(parts: &[&str]) -> gateway_core::state::RecordKey {
    gateway_core::tuple_key::TupleKey::from_scalar_parts(
        &parts
            .iter()
            .map(|part| gateway_core::tuple_key::ScalarKeyPart::String(part))
            .collect::<Vec<_>>(),
    )
    .to_record_key()
}
const OLD: &[u8] = br#"{"tokens":{"access_token":"SYNTHETIC_OLD_ACCESS","refresh_token":"SYNTHETIC_OLD_REFRESH","account_id":"synthetic-account"},"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT","unrelated":"\ud800"}"#;
const NEW: &[u8] = br#"{"auth":{"tokens":{"access_token":"SYNTHETIC_NEW_ACCESS","refresh_token":"SYNTHETIC_NEW_REFRESH","account_id":"synthetic-account"}},"models":{"client_version":"0.163.0"}}"#;
fn now() -> i64 {
    crate::http_server::now_ms().unwrap()
}
fn id() -> NativeTransportIdentity {
    NativeTransportIdentity::new(
        "native-flow".into(),
        "fixture-host".into(),
        "epoch".into(),
        [83; 32],
        BTreeSet::from([
            NativeCapability::CodexAuthImport,
            NativeCapability::AccessPublish,
        ]),
    )
    .unwrap()
}
fn credentials() -> gateway_auth::native_credentials::NativeCredentials {
    super::import_documents::credentials(&SourceJson::parse_bytes(OLD).unwrap()).unwrap()
}
fn inputs() -> ConfiguredPaidInputs {
    ConfiguredPaidInputs::new(
        None,
        None,
        None,
        serde_json::json!({"fixture":"genuine-native-flow"}),
    )
    .unwrap()
}
fn setup(store: &base::Store, home: &Path) -> String {
    let identity = id();
    store.seed(
        keys::paid_control_owner(),
        "owner-before",
        PaidControlOwner {
            v: 1,
            owner_id: identity.owner_id().into(),
            owner_epoch: identity.owner_epoch().into(),
            key_fingerprint: identity.key_fingerprint().into(),
        },
    );
    let old = credentials();
    let mut account = CodexSourceAccount {
        account_id: old.account_id.clone(),
        access_token: old.access_token.clone(),
        refresh_token: Secret::new(String::new()),
        updated_at_ms: now() as f64,
        native_owner: Some(CodexNativeOwner {
            codex_home: home.to_str().unwrap().into(),
            generation_hash: String::new(),
            native_refreshed_at: None,
            external_user_id: None,
            managed_source: Some(ManagedNativeSource {
                v: MANAGED_NATIVE_SOURCE_VERSION,
                generation_hash: old.generation_hash(),
            }),
        }),
    };
    let projected = account.identity();
    account.native_owner.as_mut().unwrap().generation_hash =
        projected.native_generation_hash.clone();
    let hash = projected.routing_account_hash.0.clone();
    store.seed(
        codex_source_pool_key(),
        "source-before",
        CodexSourcePool {
            accounts: vec![account],
            updated_at_ms: now() as f64,
        }
        .private_source_value(),
    );
    store.seed(
        keys::pool(),
        "pool-before",
        SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp("source-before".into()),
            accounts: vec![PoolAccount {
                account_id_hash: projected.routing_account_hash,
                admin_account_hash: projected.administrative_account_hash,
                credential_version: projected.credential_version,
                enabled: true,
            }],
        },
    );
    let captured = futures_executor::block_on(PreparedConfigurationPublication::capture(
        store,
        &identity,
        &inputs(),
        "config-before",
        now(),
    ))
    .unwrap();
    store.seed(
        keys::paid_control_config(),
        "config-before",
        captured.configuration(),
    );
    hash
}
fn admin_actor(store: &base::Store) -> actor::NativeRenewalActor {
    let token = "uos_ai_session_SYNTHETIC_FLOW";
    store.seed(
        passkeys::key("users", "flow-user"),
        "user-before",
        PasskeyUser {
            id: "flow-user".into(),
            handle: "operator".into(),
            is_admin: true,
            credential_ids: vec!["credential".into()],
            created_at_ms: 1,
            updated_at_ms: 1,
        },
    );
    let session = PasskeySession {
        token: token.into(),
        user_id: "flow-user".into(),
        created_at_ms: 1,
        expires_at_ms: now() + 600_000,
        audience_origin: None,
    };
    store.seed(passkeys::key("sessions", token), "session-before", &session);
    store.rows.lock().unwrap().insert(
        session_index::index_key(&session_index::digest(token))
            .unwrap()
            .0,
        session_index::record_for_session(&session, "session-before", None).unwrap(),
    );
    let authority = authority(store);
    let config = base::config();
    let request = AuthRequest {
        method: "POST".into(),
        url: "https://ai.ubq.fi/v1/responses".into(),
        headers: BTreeMap::from([("authorization".into(), format!("Bearer {token}"))]),
        ..Default::default()
    };
    let context = RequestContext {
        request_id: RequestId("native-flow-original-request".into()),
        principal: PrincipalId("passkey-user:flow-user".into()),
        key_id: None,
        route: "responses".into(),
        started_at_ms: now(),
    };
    futures_executor::block_on(actor::authenticate_admin_actor(
        &authority,
        &base::Host,
        &config,
        &request,
        &context,
    ))
    .unwrap()
}
struct CaseRoot {
    base: PathBuf,
    root: PathBuf,
}
impl CaseRoot {
    fn base(&self) -> &Path {
        &self.base
    }
    fn path(&self) -> &Path {
        &self.root
    }
}
fn assert_fixture_child_binding(base: &Path, root: &Path, home: &Path) {
    assert_owned_canonical_directory(base);
    assert_owned_canonical_directory(root);
    assert_eq!(root.parent(), Some(base));
    assert_eq!(home, root.join("home"));
    assert_owned_canonical_directory(home);
}
impl CaseRoot {
    fn new() -> Self {
        static N: AtomicUsize = AtomicUsize::new(0);
        let parent = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            fs::canonicalize(std::env::temp_dir()).unwrap()
        };
        let sequence = N.fetch_add(1, Ordering::SeqCst);
        let base = parent.join(format!(
            "native-flow-base-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&base).unwrap();
        fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
        let root = base.join(format!("native-flow-{}-{sequence}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["home", "replay"] {
            fs::create_dir(root.join(name)).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        for (name, bytes) in [("auth.json", OLD), (".uos-owner.lock", b"".as_slice())] {
            let mut f = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(root.join("home").join(name))
                .unwrap();
            f.write_all(bytes).unwrap();
            f.sync_all().unwrap();
        }
        Self { base, root }
    }
}
impl Drop for CaseRoot {
    fn drop(&mut self) {
        if thread::panicking() {
            eprintln!("PRESERVED_NATIVE_FLOW {}", self.base.display());
        } else {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }
}
#[test]
fn fixture_child_paths_refuse_escaping_and_symlinked_bindings() {
    let root = CaseRoot::new();
    let base = root.base().to_path_buf();
    let home = root.path().join("home");
    assert_fixture_child_binding(&base, root.path(), &home);
    assert!(
        std::panic::catch_unwind(|| {
            assert_fixture_child_binding(&base, &home, &home.join("home"));
        })
        .is_err()
    );
    assert!(
        std::panic::catch_unwind(|| {
            assert_fixture_child_binding(&base, root.path(), &base);
        })
        .is_err()
    );
    let alias = root.path().join("root-alias");
    std::os::unix::fs::symlink(root.path(), &alias).unwrap();
    assert!(
        std::panic::catch_unwind(|| {
            assert_fixture_child_binding(&base, &alias, &home);
        })
        .is_err()
    );
}
fn artifact(name: &str) -> PathBuf {
    let path = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(name);
    assert!(
        path.is_file(),
        "build exact fixture artifact before controlled parent"
    );
    fs::canonicalize(path).unwrap()
}

#[derive(Default)]
struct Traffic {
    authority: Mutex<Vec<Vec<u8>>>,
    models: AtomicUsize,
    oauth: AtomicUsize,
    drop_publication: AtomicBool,
    pause: Mutex<Option<Arc<negatives::PhasePause>>>,
    accepted: [AtomicUsize; 3],
    accepted_nonblocking: [AtomicUsize; 3],
    tls_complete: [AtomicUsize; 3],
    requests: [AtomicUsize; 3],
    phases: Mutex<Vec<&'static str>>,
    errors: Mutex<Vec<String>>,
}
impl Traffic {
    fn retain(&self, path: &Path) {
        let counts = |values: &[AtomicUsize; 3]| {
            values
                .iter()
                .map(|n| n.load(Ordering::SeqCst))
                .collect::<Vec<_>>()
        };
        let value = serde_json::json!({"accepted":counts(&self.accepted),"accepted_nonblocking":counts(&self.accepted_nonblocking),"tls_complete":counts(&self.tls_complete),"requests":counts(&self.requests),
            "closed_phases":self.phases.lock().unwrap().iter().take(64).copied().collect::<Vec<_>>(),"error_codes":self.errors.lock().unwrap().iter().take(64).cloned().collect::<Vec<_>>()});
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(&serde_json::to_vec(&value).unwrap())
            .unwrap();
    }
}
struct Servers {
    authority: std::net::SocketAddr,
    models: std::net::SocketAddr,
    oauth: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    joins: Vec<thread::JoinHandle<()>>,
    traffic: Arc<Traffic>,
    structural_path: PathBuf,
}
impl Servers {
    fn start(store: base::Store, home: PathBuf) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let traffic = Arc::new(Traffic::default());
        let mut joins = Vec::new();
        let mut addresses = Vec::new();
        for role in 0..3 {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            addresses.push(listener.local_addr().unwrap());
            listener.set_nonblocking(true).unwrap();
            let stop = stop.clone();
            let traffic = traffic.clone();
            let store = store.clone();
            let home = home.clone();
            joins.push(thread::spawn(move || {
                let mut tasks = Vec::new();
                while !stop.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            traffic.accepted[role as usize].fetch_add(1, Ordering::SeqCst);
                            if rustix::fs::fcntl_getfl(&socket)
                                .unwrap()
                                .contains(rustix::fs::OFlags::NONBLOCK)
                            {
                                traffic.accepted_nonblocking[role as usize]
                                    .fetch_add(1, Ordering::SeqCst);
                            }
                            let store = store.clone();
                            let home = home.clone();
                            let traffic = traffic.clone();
                            tasks.push(thread::spawn(move || {
                                serve_tls(socket, role, store, &home, traffic)
                            }));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2))
                        }
                        Err(e) => panic!("fixture listener {e}"),
                    }
                }
                for task in tasks {
                    task.join().unwrap();
                }
            }));
        }
        Self {
            authority: addresses[0],
            models: addresses[1],
            oauth: addresses[2],
            stop,
            joins,
            traffic,
            structural_path: home.parent().unwrap().join("server-structural.json"),
        }
    }
}
impl Drop for Servers {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for join in self.joins.drain(..) {
            join.join().unwrap();
        }
        self.traffic.retain(&self.structural_path);
    }
}
fn tls(socket: TcpStream) -> StreamOwned<ServerConnection, TcpStream> {
    socket.set_nonblocking(false).unwrap();
    assert!(
        !rustix::fs::fcntl_getfl(&socket)
            .unwrap()
            .contains(rustix::fs::OFlags::NONBLOCK),
        "actual accepted fixture TLS socket must be blocking before handshake"
    );
    socket
        .set_read_timeout(Some(Duration::from_secs(55)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let cert = include_bytes!("../../tests/fixtures/import-tls/leaf.der");
    let key = include_bytes!("../../tests/fixtures/import-tls/leaf.pk8.der");
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.to_vec())),
        )
        .unwrap();
    StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), socket)
}
fn read_request(
    tls: &mut StreamOwned<ServerConnection, TcpStream>,
    traffic: &Traffic,
    role: usize,
    tls_recorded: &mut bool,
) -> Option<(String, BTreeMap<String, String>, Vec<u8>)> {
    let mut bytes = Vec::new();
    loop {
        if let Some(end) = bytes.windows(4).position(|p| p == b"\r\n\r\n") {
            let text = std::str::from_utf8(&bytes[..end]).ok()?;
            let mut lines = text.split("\r\n");
            let path = lines.next()?.split_whitespace().nth(1)?.to_owned();
            let headers: BTreeMap<String, String> = lines
                .map(|line| line.split_once(':'))
                .collect::<Option<Vec<_>>>()?
                .into_iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_owned()))
                .collect();
            let len: usize = headers
                .get("content-length")
                .map(|v| v.parse().ok())
                .unwrap_or(Some(0))?;
            if len
                > gateway_authority::native_control::import::import_publication_max_bytes()
                    .max(gateway_auth::native::NATIVE_MAX_BODY_BYTES)
            {
                return None;
            }
            if bytes.len() >= end + 4 + len {
                return Some((path, headers, bytes[end + 4..end + 4 + len].to_vec()));
            }
        }
        let mut part = [0u8; 8192];
        let read = tls.read(&mut part);
        if !*tls_recorded && !tls.conn.is_handshaking() {
            traffic.tls_complete[role].fetch_add(1, Ordering::SeqCst);
            *tls_recorded = true;
        }
        let n = match read {
            Ok(n) => n,
            Err(error) => {
                let code = match error
                    .get_ref()
                    .and_then(|e| e.downcast_ref::<rustls::Error>())
                {
                    Some(rustls::Error::AlertReceived(alert)) => format!("tls_alert_{alert:?}"),
                    _ => format!("tls_io_{:?}", error.kind()),
                };
                traffic.errors.lock().unwrap().push(code);
                return None;
            }
        };
        if n == 0 {
            return None;
        }
        bytes.extend_from_slice(&part[..n]);
    }
}
fn serve_tls(socket: TcpStream, role: u8, store: base::Store, home: &Path, traffic: Arc<Traffic>) {
    let mut stream = tls(socket);
    let mut tls_recorded = false;
    while let Some((path, headers, body)) =
        read_request(&mut stream, &traffic, role as usize, &mut tls_recorded)
    {
        traffic.requests[role as usize].fetch_add(1, Ordering::SeqCst);
        let phase = if path == NATIVE_PUBLICATION_PATH {
            "publication"
        } else if let Ok(request) =
            gateway_auth::native_import::authority::ImportAuthorityRequestData::parse(&body)
        {
            use gateway_auth::native_import::authority::ImportAuthorityCommand as C;
            match request.command {
                C::Admit { .. } => "admit",
                C::FinishCurrent { .. } => "finish",
                C::Current { .. } => "current",
                C::Claim { .. } => "claim",
                C::Start { .. } => "start",
                C::Unknown { .. } => "unknown",
                C::Terminal { .. } => "terminal",
                C::CustodyTerminal { .. } => "custody_terminal",
            }
        } else if gateway_auth::native_import::catalog_seed::ImportCatalogSeedRequestData::parse(
            &body,
        )
        .is_ok()
        {
            "catalog_seed"
        } else if role == 1 {
            "models"
        } else if role == 2 {
            "oauth"
        } else {
            "started_handler"
        };
        traffic.phases.lock().unwrap().push(phase);
        let pause = traffic.pause.lock().unwrap().clone();
        if let Some(pause) = pause {
            pause.reached(phase);
        }
        let (status, mut response, response_headers) = if role == 0 {
            traffic.authority.lock().unwrap().push(body.clone());
            let identity = id();
            let authority = authority(&store);
            let config = base::config();
            let owner = RegisteredRenewalOwner::configured(
                "native-owner".into(),
                home.to_str().unwrap().into(),
            )
            .unwrap();
            let cancel = base::Cancel;
            let control =
                NativeRenewalAuthority::configured(&authority, &identity, &owner, &config, &cancel);
            let owned = OwnedNativeAuthHeaders::from_pairs(headers.clone()).unwrap();
            if path == NATIVE_PUBLICATION_PATH {
                let receiver =
                    PublicationReceiver::configured(id(), inputs(), Vec::new(), now).unwrap();
                let reply = futures_executor::block_on(receiver.handle_import(
                    &control,
                    PublicationRequest {
                        method: "POST".into(),
                        path: path.clone(),
                        headers: owned,
                        raw_body: body.clone(),
                    },
                ));
                if traffic.drop_publication.swap(false, Ordering::SeqCst) && reply.status == 200 {
                    return;
                }
                (reply.status, reply.raw_body, reply.headers)
            } else {
                let result = futures_executor::block_on(async {
                    let peer = control
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
                    if gateway_auth::native_import::catalog_seed::ImportCatalogSeedRequestData::parse(&body).is_ok(){control.handle_import_catalog_seed(&peer,&body).await}else if gateway_auth::native_import::authority::ImportAuthorityRequestData::parse(&body).is_ok(){control.handle_import_authority(&peer,&body).await}else{control.handle_import_started(&peer,&body).await}
                });
                let (status, reply) = match result {
                    Ok(reply) => (200, reply),
                    Err(error) => {
                        traffic.errors.lock().unwrap().push(
                            error
                                .envelope
                                .error
                                .code
                                .clone()
                                .unwrap_or_else(|| "no_code".into()),
                        );
                        (error.status, serde_json::to_vec(&error.envelope).unwrap())
                    }
                };
                let nonce = headers.get(NATIVE_NONCE_HEADER).unwrap();
                let signature = identity
                    .sign_authority_response(nonce, &body, status, &reply)
                    .unwrap();
                (
                    status,
                    reply,
                    vec![(NATIVE_RESPONSE_MAC_HEADER.into(), signature)],
                )
            }
        } else if role == 1 {
            traffic.models.fetch_add(1, Ordering::SeqCst);
            (200, MODELS.to_vec(), Vec::new())
        } else {
            traffic.oauth.fetch_add(1, Ordering::SeqCst);
            (200,br#"{"access_token":"SYNTHETIC_ROTATED_ACCESS","refresh_token":"SYNTHETIC_ROTATED_REFRESH"}"#.to_vec(),Vec::new())
        };
        let mut head = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: keep-alive\r\n",
            response.len()
        );
        for (k, v) in response_headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        if stream
            .write_all(head.as_bytes())
            .and_then(|_| stream.write_all(&response))
            .and_then(|_| stream.flush())
            .is_err()
        {
            return;
        }
        response.fill(0);
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProcessSetup {
    home: PathBuf,
    config: serde_json::Value,
    authority: std::net::SocketAddr,
    models: std::net::SocketAddr,
    oauth: std::net::SocketAddr,
    account_id_hash: String,
}
#[test]
#[ignore = "fixed actual child-process entry; only the controlled parent selects it"]
fn controlled_custodian_process() {
    use std::os::fd::AsFd;
    let root = std::env::current_dir().unwrap();
    let base = root.parent().unwrap();
    assert_fixture_child_binding(base, &root, &root.join("home"));
    let setup: ProcessSetup =
        serde_json::from_slice(&fs::read(root.join("process.json")).unwrap()).unwrap();
    assert_fixture_child_binding(&base, &root, &setup.home);
    let registered = RegisteredRenewalOwner::configured(
        "native-owner".into(),
        setup.home.to_str().unwrap().into(),
    )
    .unwrap();
    let store = ExistingAccountImportStore::configured(&registered, setup.account_id_hash).unwrap();
    let inspector = artifact("uos-native-owner-inspect");
    let inspector_hash = sha256_hex(&fs::read(&inspector).unwrap());
    let uid = rustix::process::getuid().as_raw();
    let owner = store
        .prepare_exclusive_owner(
            &registered,
            uid,
            &[uid + 1],
            &inspector,
            &inspector_hash,
            Instant::now() + Duration::from_secs(15),
        )
        .unwrap();
    let mut runtime = owner.prepare_runtime().unwrap();
    let executable = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let digest = sha256_hex(&fs::read(&executable).unwrap());
    let quote = |p: &Path| serde_json::to_string(p.to_str().unwrap()).unwrap();
    let profile = format!(
        "(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath {})) (deny process-fork) (deny process-exec*) (allow process-exec (literal {}))",
        quote(&setup.home),
        quote(&executable)
    );
    runtime
        .spawn_fixture(
            &executable,
            &digest,
            &[
                "--exact",
                "existing_account_import::foundation_tests::controlled_async_writer_child",
                "--nocapture",
                "--ignored",
            ],
            &profile,
            Instant::now() + Duration::from_secs(15),
        )
        .unwrap();
    let limit = Instant::now() + Duration::from_secs(5);
    while !setup.home.join("writer-ready").is_file() {
        assert!(Instant::now() < limit);
        thread::sleep(Duration::from_millis(5));
    }
    let mut runtime = runtime.into_custodian().unwrap();
    let input = std::io::stdin().as_fd().try_clone_to_owned().unwrap();
    let listener = TcpListener::from(input);
    assert!(listener.local_addr().unwrap().ip().is_loopback());
    let (client, _) = listener.accept().unwrap();
    drop(listener);
    let actor = artifact("examples/uos-native-import-fixture");
    let actor_hash = sha256_hex(&fs::read(&actor).unwrap());
    let endpoints = super::import_endpoints::ResolvedImportEndpoints::fixture(
        setup.authority,
        setup.models,
        setup.oauth,
    )
    .unwrap();
    let result = runtime.serve_fixture(
        client,
        &serde_json::to_vec(&setup.config).unwrap(),
        &actor,
        &actor_hash,
        endpoints,
    );
    if let Err(error) = result {
        drop(runtime);
        eprintln!(
            "CONTROLLED_NATIVE_REFUSAL {}",
            error
                .envelope
                .error
                .code
                .as_deref()
                .unwrap_or("native_import_unavailable")
        );
        std::process::exit(79);
    }
}

struct OwnedGroup {
    child: Option<Child>,
    group: u32,
}
impl OwnedGroup {
    fn wait_clean(&mut self) {
        let limit = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.as_mut().unwrap().try_wait().unwrap() {
                assert!(
                    status.success(),
                    "actual custodian must clean-exit, never signal/crash-as-pass"
                );
                self.child.take();
                return;
            }
            assert!(
                Instant::now() < limit,
                "custodian/actor group did not settle"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for OwnedGroup {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if let Some(group) = rustix::process::Pid::from_raw(self.group as i32) {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            }
            let _ = child.wait();
        }
    }
}
fn native_config(root: &Path, listen: std::net::SocketAddr) -> serde_json::Value {
    serde_json::json!({"v":2,"listen":listen,"identity":{"key_id":"native-flow","owner_id":"fixture-host","owner_epoch":"epoch","key_base64url":base64url(&[83;32])},"nonce_database":root.join("replay/nonces.sqlite3"),"sources":[],"owner_renewal":{"authority_origin":"https://localhost/","owners":[{"owner_id":"native-owner","codex_home":root.join("home")}]}})
}
fn start_custodian(
    root: &CaseRoot,
    servers: &Servers,
    account: String,
) -> (OwnedGroup, std::net::SocketAddr) {
    use std::os::fd::OwnedFd;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let setup = ProcessSetup {
        home: root.path().join("home"),
        config: native_config(root.path(), address),
        authority: servers.authority,
        models: servers.models,
        oauth: servers.oauth,
        account_id_hash: account,
    };
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(root.path().join("process.json"))
        .unwrap();
    file.write_all(&serde_json::to_vec(&setup).unwrap())
        .unwrap();
    file.sync_all().unwrap();
    let out = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(root.path().join("custodian.stdout"))
        .unwrap();
    let err = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(root.path().join("custodian.stderr"))
        .unwrap();
    let input: OwnedFd = listener.into();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "existing_account_import::flow_tests::controlled_custodian_process",
            "--nocapture",
            "--ignored",
        ])
        .current_dir(root.path())
        .env_clear()
        .env("TMPDIR", std::env::temp_dir())
        .stdin(Stdio::from(input))
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .process_group(0)
        .spawn()
        .unwrap();
    let group = child.id();
    (
        OwnedGroup {
            child: Some(child),
            group,
        },
        address,
    )
}
fn request(
    store: &base::Store,
    home: &Path,
    account: String,
    address: std::net::SocketAddr,
    body: &[u8],
) -> (Vec<u8>, NativeImportMetadata) {
    let authority = authority(store);
    let identity = id();
    let config = base::config();
    let cancel = base::Cancel;
    let owner =
        RegisteredRenewalOwner::configured("native-owner".into(), home.to_str().unwrap().into())
            .unwrap();
    let actor = admin_actor(store);
    let client = crate::import_client::NativeImportClient::configured(
        address, &authority, &identity, &owner, &config, &cancel,
    )
    .unwrap();
    let prepared = futures_executor::block_on(client.prepare(
        &actor,
        NativeImportTarget::ExistingAccount {
            account_id_hash: account,
        },
    ))
    .unwrap();
    let packet = client
        .request(prepared, body, now(), &base64url(&[9; 32]))
        .unwrap();
    let metadata = packet.metadata().clone();
    let mut socket = TcpStream::connect(packet.endpoint()).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(50)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut head = format!(
        "POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n",
        packet.path(),
        packet.body().len()
    );
    for (k, v) in packet.headers() {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    socket.write_all(head.as_bytes()).unwrap();
    socket.write_all(packet.body()).unwrap();
    let mut response = Vec::new();
    if let Err(error) = socket.read_to_end(&mut response) {
        let path = home.parent().unwrap().join("partial-native-response.bin");
        let mut saved = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        saved
            .write_all(&response[..response.len().min(8192)])
            .unwrap();
        panic!(
            "native response read failed ({:?}); {} bytes observed, bounded private response retained",
            error.kind(),
            response.len()
        );
    }
    (response, metadata)
}
#[test]
fn actual_existing_account_original_start_owned_child_custody_durability_and_publication() {
    let root = CaseRoot::new();
    let store = base::Store::default();
    let account = setup(&store, &root.path().join("home"));
    let servers = Servers::start(store.clone(), root.path().join("home"));
    let (mut child, address) = start_custodian(&root, &servers, account.clone());
    let (response, _metadata) = request(&store, &root.path().join("home"), account, address, NEW);
    assert!(
        response.starts_with(b"HTTP/1.1 200 "),
        "real source success required, not a dummy200 or narrowed unavailable path: {}",
        String::from_utf8_lossy(&response)
    );
    child.wait_clean();
    let header_end = response
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap()
        + 4;
    let headers = String::from_utf8_lossy(&response[..header_end]).to_ascii_lowercase();
    assert!(headers.contains("x-uos-upstream: chatgpt_codex\r\n"));
    let result: serde_json::Value = serde_json::from_slice(&response[header_end..]).unwrap();
    assert_eq!(
        result.as_object().unwrap().len(),
        12,
        "source completion fields may not be silently omitted"
    );
    assert_eq!(result["stored"], true);
    assert_eq!(result["refreshed"], false);
    assert_eq!(result["account_id"], "synthetic-account");
    assert_eq!(result["account_count"], 1);
    assert_eq!(
        result["account_ids"],
        serde_json::json!(["synthetic-account"])
    );
    assert!(result["access_token_expires_at_ms"].is_null());
    assert_eq!(result["upstream_status"], 200);
    assert_eq!(
        result["upstream_content_type"],
        "application/json; charset=utf-8"
    );
    assert_eq!(result["normalized_snapshot_updated"], true);
    assert_eq!(
        result["catalog_seeded"], true,
        "normal source success must actually seed its versioned cache"
    );
    assert_eq!(result["models"]["count"], 1);
    assert_eq!(result["models"]["source"], "chatgpt_codex");
    assert_eq!(result["models"]["client_version"], "0.163.0");
    let pool_record = futures_executor::block_on(store.read(&codex_source_pool_key()))
        .unwrap()
        .unwrap();
    let pool = gateway_auth::provider_credentials::parse_codex_source_pool(
        pool_record.json_value().unwrap(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        result["updated_at_ms"].as_f64(),
        Some(pool.accounts[0].updated_at_ms)
    );
    assert_eq!(
        pool.accounts[0].access_token.expose(),
        "SYNTHETIC_NEW_ACCESS"
    );
    assert!(pool.accounts[0].refresh_token.expose().is_empty());
    let generation =
        futures_executor::block_on(store.read(&key(&["ubq_ai", "codex_catalog_auth_generation"])))
            .unwrap()
            .unwrap();
    let cache =
        futures_executor::block_on(store.read(&key(&["ubq_ai", "codex_catalog", "0.163.0"])))
            .unwrap()
            .unwrap();
    let cache = cache.json_value().unwrap();
    assert_eq!(cache["auth_generation"], generation.value);
    assert_eq!(cache["source_sha256"], sha256_hex(MODELS));
    assert!(cache["chunk_count"].as_u64().unwrap() > 0);
    assert!(cache["source_chunk_count"].as_u64().unwrap() > 0);
    assert_eq!(cache["content_type"], "application/json; charset=utf-8");
    let bytes = fs::read(root.path().join("home/auth.json")).unwrap();
    let document = SourceJson::parse_bytes(&bytes).unwrap();
    let next = super::import_documents::credentials(&document).unwrap();
    assert_eq!(next.access_token.expose(), "SYNTHETIC_NEW_ACCESS");
    assert_eq!(next.refresh_token.expose(), "SYNTHETIC_NEW_REFRESH");
    assert_eq!(
        super::import_documents::member(&document, "OPENAI_API_KEY")
            .unwrap()
            .unwrap()
            .as_str(),
        r#""SYNTHETIC_INDEPENDENT""#
    );
    assert_eq!(
        super::import_documents::member(&document, "unrelated")
            .unwrap()
            .unwrap()
            .as_str(),
        r#""\ud800""#
    );
    let witness = fs::read(root.path().join("home/async-native-write")).unwrap();
    thread::sleep(Duration::from_millis(25));
    assert_eq!(
        fs::read(root.path().join("home/async-native-write")).unwrap(),
        witness,
        "actual writer must have stopped/reaped before credential mutation"
    );
    assert_eq!(servers.traffic.models.load(Ordering::SeqCst), 1);
    assert_eq!(servers.traffic.oauth.load(Ordering::SeqCst), 0);
    let captured = servers.traffic.authority.lock().unwrap();
    assert!(captured.iter().any(|body| {
        body.windows(b"codex_auth_import_publish".len())
            .any(|w| w == b"codex_auth_import_publish")
    }));
    for wire in captured.iter() {
        let text = String::from_utf8_lossy(wire);
        assert!(!text.contains("SYNTHETIC_NEW_REFRESH"));
        assert!(!text.contains(&sha256_hex(NEW)));
        assert!(!text.contains(&sha256_hex(&bytes)));
    }
}

mod negatives;
