//! Required negatives use the same real actors, authority, TLS and native writer.
//! The pause controls only server scheduling; it issues no proof or outcome.
use super::*;
use std::{net::Shutdown, sync::Condvar};

pub(super) struct PhasePause {
    phase: &'static str,
    occurrence: usize,
    seen: AtomicUsize,
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}
struct PauseHandle(Arc<PhasePause>);
impl PhasePause {
    pub(super) fn reached(&self, phase: &'static str) {
        if phase != self.phase || self.seen.fetch_add(1, Ordering::SeqCst) + 1 != self.occurrence {
            return;
        }
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        let (state, limit) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(55), |state| !state.1)
            .unwrap();
        assert!(
            !limit.timed_out() && state.1,
            "controlled server pause was not released"
        );
    }
}
impl PauseHandle {
    fn install(servers: &Servers, phase: &'static str, occurrence: usize) -> Self {
        let pause = Arc::new(PhasePause {
            phase,
            occurrence,
            seen: AtomicUsize::new(0),
            state: Mutex::new((false, false)),
            changed: Condvar::new(),
        });
        *servers.traffic.pause.lock().unwrap() = Some(pause.clone());
        Self(pause)
    }
    fn wait(&self) {
        let (state, timeout) = self
            .0
            .changed
            .wait_timeout_while(
                self.0.state.lock().unwrap(),
                Duration::from_secs(35),
                |state| !state.0,
            )
            .unwrap();
        assert!(
            !timeout.timed_out() && state.0,
            "real native flow did not reach the selected authority phase"
        );
    }
    fn resume(&self) {
        self.0.state.lock().unwrap().1 = true;
        self.0.changed.notify_all();
    }
}
impl Drop for PauseHandle {
    fn drop(&mut self) {
        self.resume();
    }
}
struct RequestRun {
    socket: TcpStream,
    deadline_ms: i64,
    reply: thread::JoinHandle<Vec<u8>>,
}
fn original_request(
    store: &base::Store,
    root: &CaseRoot,
    account: String,
    address: std::net::SocketAddr,
) -> RequestRun {
    let authority = authority(store);
    let identity = id();
    let config = base::config();
    let cancel = base::Cancel;
    let owner = RegisteredRenewalOwner::configured(
        "native-owner".into(),
        root.path().join("home").to_str().unwrap().into(),
    )
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
    let deadline_ms = prepared.deadline_ms();
    let packet = client
        .request(prepared, NEW, now(), &base64url(&[9; 32]))
        .unwrap();
    let socket = TcpStream::connect(packet.endpoint()).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(50)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut worker = socket.try_clone().unwrap();
    let mut head = format!(
        "POST {} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n",
        packet.path(),
        packet.body().len()
    );
    for (key, value) in packet.headers() {
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let body = packet.body().to_vec();
    let reply = thread::spawn(move || {
        worker.write_all(head.as_bytes()).unwrap();
        worker.write_all(&body).unwrap();
        let mut bytes = Vec::new();
        let read = worker.read_to_end(&mut bytes);
        if let Err(error) = read {
            assert!(
                matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
                ),
                "unexpected native read error {error}"
            );
        }
        bytes
    });
    RequestRun {
        socket,
        deadline_ms,
        reply,
    }
}
fn wait_failure(group: &mut OwnedGroup) {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        if let Some(status) = group.child.as_mut().unwrap().try_wait().unwrap() {
            assert_eq!(
                status.code(),
                Some(79),
                "fixture refusal must be a normal explicit error, not a signal or crash"
            );
            group.child.take();
            return;
        }
        assert!(
            Instant::now() < deadline,
            "controlled refusal did not settle its actual Child"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
fn no_publication(servers: &Servers) {
    let phases = servers.traffic.phases.lock().unwrap();
    assert!(!phases.contains(&"publication") && !phases.contains(&"catalog_seed"));
    assert_eq!(servers.traffic.oauth.load(Ordering::SeqCst), 0);
}
fn no_native_effect(root: &CaseRoot, servers: &Servers, response: &[u8]) {
    assert!(
        !response.starts_with(b"HTTP/1.1 200 "),
        "an aborted real import must never return source success"
    );
    assert_eq!(fs::read(root.path().join("home/auth.json")).unwrap(), OLD);
    assert!(
        fs::read_dir(root.path().join("home"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".uos-import-")),
        "no native tempfile/receipt is allowed before the denied effect"
    );
    no_publication(servers);
}
fn revoke_admin(store: &base::Store) {
    let key = passkeys::key("users", "flow-user");
    let current = futures_executor::block_on(store.read(&key))
        .unwrap()
        .unwrap();
    let mut user: PasskeyUser =
        serde_json::from_value(current.json_value().unwrap().clone()).unwrap();
    user.is_admin = false;
    store.seed(key, "user-revoked", user);
}
fn assert_writer_stopped(root: &CaseRoot) {
    let path = root.path().join("home/async-native-write");
    let witness = fs::read(&path).unwrap();
    thread::sleep(Duration::from_millis(25));
    assert_eq!(
        fs::read(path).unwrap(),
        witness,
        "actual owned writer must already be stopped and reaped"
    );
}
#[test]
fn actual_quiet_client_eof_before_and_after_started_never_writes_or_publishes() {
    for phase in ["start", "started_handler"] {
        let root = CaseRoot::new();
        let store = base::Store::default();
        let account = setup(&store, &root.path().join("home"));
        let servers = Servers::start(store.clone(), root.path().join("home"));
        let pause = PauseHandle::install(&servers, phase, 1);
        let (mut child, address) = start_custodian(&root, &servers, account.clone());
        let request = original_request(&store, &root, account, address);
        pause.wait();
        request.socket.shutdown(Shutdown::Both).unwrap();
        pause.resume();
        let response = request.reply.join().unwrap();
        wait_failure(&mut child);
        no_native_effect(&root, &servers, &response);
    }
}
#[test]
fn actual_custodian_death_after_stop_closes_live_actor_without_late_effect() {
    let root = CaseRoot::new();
    let store = base::Store::default();
    let account = setup(&store, &root.path().join("home"));
    let servers = Servers::start(store.clone(), root.path().join("home"));
    let pause = PauseHandle::install(&servers, "started_handler", 3);
    let (mut child, address) = start_custodian(&root, &servers, account.clone());
    let request = original_request(&store, &root, account, address);
    pause.wait();
    assert_writer_stopped(&root);
    // Kill only the retained actual custodian Child, not an inferred PID/group.
    let mut custodian = child.child.take().unwrap();
    custodian.kill().unwrap();
    assert!(!custodian.wait().unwrap().success());
    pause.resume();
    let response = request.reply.join().unwrap();
    no_native_effect(&root, &servers, &response);
    assert_writer_stopped(&root);
}
#[test]
fn actual_admin_revocation_before_native_write_refuses_the_same_started_claim() {
    let root = CaseRoot::new();
    let store = base::Store::default();
    let account = setup(&store, &root.path().join("home"));
    let servers = Servers::start(store.clone(), root.path().join("home"));
    let pause = PauseHandle::install(&servers, "started_handler", 3);
    let (mut child, address) = start_custodian(&root, &servers, account.clone());
    let request = original_request(&store, &root, account, address);
    pause.wait();
    assert_writer_stopped(&root);
    revoke_admin(&store);
    pause.resume();
    let response = request.reply.join().unwrap();
    wait_failure(&mut child);
    no_native_effect(&root, &servers, &response);
    assert_eq!(
        servers
            .traffic
            .phases
            .lock()
            .unwrap()
            .iter()
            .filter(|phase| **phase == "start")
            .count(),
        1
    );
}
#[test]
fn actual_original_deadline_expiry_after_stop_never_renews_mutation_authority() {
    let root = CaseRoot::new();
    let store = base::Store::default();
    let account = setup(&store, &root.path().join("home"));
    let servers = Servers::start(store.clone(), root.path().join("home"));
    let pause = PauseHandle::install(&servers, "started_handler", 3);
    let (mut child, address) = start_custodian(&root, &servers, account.clone());
    let request = original_request(&store, &root, account, address);
    pause.wait();
    assert_writer_stopped(&root);
    let remaining = request.deadline_ms.checked_sub(now()).unwrap();
    assert!(remaining > 0 && remaining <= 45_000);
    thread::sleep(Duration::from_millis(remaining as u64 + 30));
    pause.resume();
    let response = request.reply.join().unwrap();
    wait_failure(&mut child);
    no_native_effect(&root, &servers, &response);
}
#[test]
fn actual_revoked_publication_retains_native_receipt_but_never_source_success() {
    let root = CaseRoot::new();
    let store = base::Store::default();
    let account = setup(&store, &root.path().join("home"));
    let servers = Servers::start(store.clone(), root.path().join("home"));
    let pause = PauseHandle::install(&servers, "publication", 1);
    let (mut child, address) = start_custodian(&root, &servers, account.clone());
    let request = original_request(&store, &root, account, address);
    pause.wait();
    assert_writer_stopped(&root);
    assert_ne!(fs::read(root.path().join("home/auth.json")).unwrap(), OLD);
    assert!(
        fs::read_dir(root.path().join("home"))
            .unwrap()
            .any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".receipt")
            })
    );
    revoke_admin(&store);
    pause.resume();
    let response = request.reply.join().unwrap();
    wait_failure(&mut child);
    assert!(!response.starts_with(b"HTTP/1.1 200 "));
    let record = futures_executor::block_on(store.read(&codex_source_pool_key()))
        .unwrap()
        .unwrap();
    let pool =
        gateway_auth::provider_credentials::parse_codex_source_pool(record.json_value().unwrap())
            .unwrap()
            .unwrap();
    assert_eq!(
        pool.accounts[0].access_token.expose(),
        "SYNTHETIC_OLD_ACCESS"
    );
    assert_ne!(
        fs::read(root.path().join("home/auth.json")).unwrap(),
        OLD,
        "uncertain native durability must not be rolled back or erased"
    );
    assert!(
        !servers
            .traffic
            .phases
            .lock()
            .unwrap()
            .contains(&"catalog_seed")
    );
    assert_eq!(servers.traffic.oauth.load(Ordering::SeqCst), 0);
}
#[test]
fn actual_lost_publication_reply_reconciles_only_the_same_native_receipt() {
    let root = CaseRoot::new();
    let store = base::Store::default();
    let account = setup(&store, &root.path().join("home"));
    let servers = Servers::start(store.clone(), root.path().join("home"));
    servers
        .traffic
        .drop_publication
        .store(true, Ordering::SeqCst);
    let (mut child, address) = start_custodian(&root, &servers, account.clone());
    let (response, _) = request(&store, &root.path().join("home"), account, address, NEW);
    assert!(response.starts_with(b"HTTP/1.1 200 "));
    child.wait_clean();
    let phases = servers.traffic.phases.lock().unwrap();
    assert_eq!(phases.iter().filter(|phase| **phase == "start").count(), 1);
    assert_eq!(
        phases
            .iter()
            .filter(|phase| **phase == "publication")
            .count(),
        1,
        "no HTTP publication retry or new request digest is allowed"
    );
    assert_eq!(
        fs::read_dir(root.path().join("home"))
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".receipt"))
            .count(),
        1
    );
    assert_eq!(servers.traffic.models.load(Ordering::SeqCst), 1);
    assert_eq!(servers.traffic.oauth.load(Ordering::SeqCst), 0);
    assert_writer_stopped(&root);
}

#[test]
fn fixture_enabled_ordinary_entrypoints_refuse_before_reading_stdin() {
    assert!(crate::require_production_artifact().is_err());
    for name in [
        "uos-native",
        "uos-native-supervisor",
        "uos-native-request",
        "uos-native-connector",
        "uos-native-import",
    ] {
        let binary = artifact(name);
        // The write end remains open and empty. Any stdin read would block.
        let mut child = Command::new(binary)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(
                    status.code(),
                    Some(if name == "uos-native" { 1 } else { 78 }),
                    "ordinary entrypoint {name}"
                );
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("fixture-enabled {name} did not refuse before stdin");
            }
            thread::sleep(Duration::from_millis(5));
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.stdout.is_empty(),
            "no listener or service startup may occur"
        );
        if name == "uos-native" {
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("native_fixture_artifact_forbidden")
            );
        }
    }
}
