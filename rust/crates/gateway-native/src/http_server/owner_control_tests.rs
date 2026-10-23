//! Real confined HTTP/parser/MAC/capability fixture. This synthetic handler
//! deliberately returns unknown and does not pretend to publish credentials.
use super::*;
use crate::confinement::{NativeConfinement, enforce};
use gateway_auth::{crypto::base64url, native_auth::AuthenticatedNativeOwner};
use std::{collections::BTreeSet, path::PathBuf, sync::atomic::AtomicU64};

struct Fixture {
    root: PathBuf,
    pairs: std::sync::Mutex<std::collections::VecDeque<(TcpStream, TcpStream)>>,
    worker: std::sync::Mutex<Option<ControlWorker>>,
}
struct Exchange {
    service: Arc<NativeHttpService>,
    stream: TcpStream,
    done: std::sync::mpsc::Sender<()>,
}
struct ControlWorker {
    sender: std::sync::mpsc::Sender<Exchange>,
    join: std::thread::JoinHandle<()>,
}
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
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut pairs = std::collections::VecDeque::new();
        for _ in 0..2 {
            let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (server, _) = listener.accept().unwrap();
            pairs.push_back((client, server));
        }
        Self {
            root: path,
            pairs: std::sync::Mutex::new(pairs),
            worker: std::sync::Mutex::new(None),
        }
    }
    fn service(&self, identity: NativeTransportIdentity) -> NativeHttpService {
        NativeHttpService::configured(
            identity,
            SqliteNonceStore::open(&self.root.join("replay/nonces.sqlite3")).unwrap(),
            SupervisorData::configured(Vec::new()).unwrap(),
        )
    }
    fn exchange(&self, service: Arc<NativeHttpService>, wire: &[u8]) -> Vec<u8> {
        let (mut client, stream) = self
            .pairs
            .lock()
            .unwrap()
            .pop_front()
            .expect("original fixture uses at most two exchanges");
        let mut worker = self.worker.lock().unwrap();
        if worker.is_none() {
            let private = self.root.join("replay");
            let outside = self.root.join("outside");
            let (sender, receiver) = std::sync::mpsc::channel::<Exchange>();
            let join = std::thread::spawn(move || {
                assert!(std::fs::read(&outside).is_ok());
                observe_kernel_contract();
                enforce(&NativeConfinement {
                    readonly_paths: vec![],
                    list_directories: vec![],
                    replay_directory: private,
                    unix_sockets: vec![],
                })
                .unwrap();
                assert!(std::fs::read(&outside).is_err());
                assert!(std::process::Command::new("/bin/true").status().is_err());
                while let Ok(exchange) = receiver.recv() {
                    let Exchange {
                        service,
                        mut stream,
                        done,
                    } = exchange;
                    if let Err(error) = service.handle(&mut stream) {
                        write_error(&mut stream, error).unwrap();
                    }
                    drop(stream);
                    done.send(()).unwrap();
                }
            });
            *worker = Some(ControlWorker { sender, join });
        }
        let (done, completed) = std::sync::mpsc::channel();
        worker
            .as_ref()
            .unwrap()
            .sender
            .send(Exchange {
                service,
                stream,
                done,
            })
            .unwrap();
        drop(worker);
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(wire).unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        completed.recv_timeout(Duration::from_secs(5)).unwrap();
        response
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(ControlWorker { sender, join }) = self.worker.get_mut().unwrap().take() {
            drop(sender);
            let result = join.join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
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
    run_owned_case(
        "http_server::owner_control_tests::isolated_control_case_child",
        b"0",
        "CONTROL_CHILD_ACCEPTED",
    );
}
fn confined_control_http_authenticates_unknown_result_and_redacts_handler_error_body() {
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
    run_owned_case(
        "http_server::owner_control_tests::isolated_control_case_child",
        b"1",
        "CONTROL_CHILD_ACCEPTED",
    );
}
fn confined_supervisor_capability_and_strict_control_body_refuse_before_handler_body() {
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
    run_owned_case(
        "http_server::owner_control_tests::isolated_control_case_child",
        b"2",
        "CONTROL_CHILD_ACCEPTED",
    );
}
fn confined_control_rejects_content_length_before_reading_an_oversized_body_body() {
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

#[test]
#[ignore = "fixed actual case child selected only by the original acceptance parents"]
fn isolated_control_case_child() {
    let case: u8 = serde_json::from_reader(std::io::stdin().lock()).unwrap();
    match case {
        0 => confined_control_http_authenticates_unknown_result_and_redacts_handler_error_body(),
        1 => confined_supervisor_capability_and_strict_control_body_refuse_before_handler_body(),
        2 => confined_control_rejects_content_length_before_reading_an_oversized_body_body(),
        _ => panic!("unknown fixed native control fixture case"),
    }
    println!("CONTROL_CHILD_ACCEPTED");
}

// A seccomp TSYNC policy is process-wide: these actual cases must not share
// the parallel library-test process. Each child remains inside the runner's
// existing namespace and applies the original native policy exactly once.
struct OwnedCaseChild(Option<std::process::Child>);
impl Drop for OwnedCaseChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }
}
fn run_owned_case(selector: &str, input: &[u8], marker: &str) {
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let mut owned = OwnedCaseChild(Some(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                selector,
                "--nocapture",
                "--test-threads=1",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    let child = owned.0.as_mut().unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let drain = |stream: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.take(1_048_577).read_to_end(&mut bytes).unwrap();
            bytes
        })
    };
    let out = drain(Box::new(stdout));
    let err = drain(Box::new(stderr));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "owned native fixture exceeded twenty seconds"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    owned.0.take();
    let stdout = out.join().unwrap();
    let stderr = err.join().unwrap();
    assert!(
        stdout.len() <= 1_048_576 && stderr.len() <= 1_048_576,
        "bounded child diagnostics exceeded"
    );
    assert!(
        status.success(),
        "actual isolated native case failed: {} {}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
    assert!(
        String::from_utf8_lossy(&stdout).contains(marker),
        "real child acceptance marker missing"
    );
}
fn observe_kernel_contract() {
    use landlock::{
        ABI, Access, AccessFs, AccessNet, CompatLevel, Compatible, Ruleset, RulesetAttr, Scope,
    };
    let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|s| s.trim().to_owned())
        .unwrap_or_else(|error| format!("unreadable:{:?}", error.kind()));
    let construction: Result<(), String> = (|| {
        let rules = Ruleset::default()
            .set_compatibility(CompatLevel::HardRequirement)
            .handle_access(AccessFs::from_all(ABI::V9))
            .map_err(|error| format!("fs:{error:?}"))?
            .handle_access(AccessNet::from_all(ABI::V9))
            .map_err(|error| format!("net:{error:?}"))?
            .scope(Scope::AbstractUnixSocket | Scope::Signal)
            .map_err(|error| format!("scope:{error:?}"))?
            .create()
            .map_err(|error| format!("create:{error:?}"))?;
        drop(rules);
        Ok(())
    })();
    // Creating/dropping this observation ruleset never restricts any thread.
    // It is diagnostic only: the original required enforce() remains below,
    // with no ABI downgrade, capability-dependent success or skipped assertion.
    eprintln!("LINUX_NATIVE_KERNEL kernel={kernel} required=ABI_V9 construction={construction:?}");
}
