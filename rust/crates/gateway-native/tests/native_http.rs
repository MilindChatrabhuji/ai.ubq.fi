#![cfg(target_os = "linux")]

use gateway_auth::{
    crypto::base64url,
    native::{NATIVE_FOLLOW_PATH, NATIVE_MAX_BODY_BYTES, NATIVE_RPC_PATH},
    native_auth::{NativeCapability, NativeTransportIdentity},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "uos-http-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("replay")).unwrap();
        Self(path)
    }
    fn configuration(&self) -> Value {
        json!({"v":1,"listen":"127.0.0.1:0","identity":{"key_id":"fixture-key","owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_base64url":base64url(&[11;32])},"nonce_database":self.0.join("replay/nonces.sqlite3"),"sources":[{"id":"fixture","name":"Synthetic Machine","socket_path":self.0.join("source.sock"),"codex_home":null}]})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Peer {
    socket: PathBuf,
    stop: Arc<AtomicBool>,
    follow_calls: Arc<AtomicUsize>,
    join: Option<thread::JoinHandle<()>>,
}
impl Peer {
    fn start(path: &Path) -> Self {
        let listener = UnixListener::bind(path).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let follow_calls = Arc::new(AtomicUsize::new(0));
        let calls = follow_calls.clone();
        let join = thread::spawn(move || {
            let mut connections = Vec::new();
            for stream in listener.incoming() {
                let stream = stream.unwrap();
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                let calls = calls.clone();
                connections.push(thread::spawn(move || {
                    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
                    let Ok(mut socket) = tungstenite::accept(stream) else { return; };
                    while let Ok(message) = socket.read() {
                        if message.is_close() {
                            let _ = socket.flush();
                            break;
                        }
                        let Ok(value) = serde_json::from_slice::<Value>(&message.into_data()) else { continue; };
                        let Some(id) = value.get("id") else { continue; };
                        let result = match value["method"].as_str().unwrap() {
                            "initialize" => json!({"protocolVersion":1}),
                            "thread/loaded/list" => json!({"data":["thread-a"]}),
                            "account/rateLimits/read" => json!({"rateLimits":{"usedPercent":35,"windowDurationMins":300,"resetsAt":1700000100}}),
                            "thread/list" => json!({"data":[{"id":"thread-a","name":"fixture session","source":"cli","updatedAt":1700000001000i64}],"nextCursor":null}),
                            "thread/read" => json!({"thread":{"id":"thread-a","status":{"type":"active"},"updatedAt":1700000002000i64}}),
                            "thread/turns/list" => {
                                calls.fetch_add(1, Ordering::AcqRel);
                                json!({"data":[{"id":"turn-a","status":"inProgress","items":[{"type":"agentMessage","id":"visible-message","text":"fixture-visible password=synthetic-hidden-value"},{"type":"reasoning","id":"private-message","text":"fixture-private-reasoning"}]}],"nextCursor":null})
                            }
                            other => panic!("unexpected native fixture method: {other}"),
                        };
                        if socket.send(tungstenite::Message::Text(json!({"id":id,"result":result}).to_string().into())).is_err() {
                            break;
                        }
                    }
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            socket: path.into(),
            stop,
            follow_calls,
            join: Some(join),
        }
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = UnixStream::connect(&self.socket);
        self.join.take().unwrap().join().unwrap();
    }
}

struct Daemon {
    child: Child,
    address: Option<SocketAddr>,
    reader: Option<thread::JoinHandle<()>>,
}
impl Daemon {
    fn start(configuration: &Value) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_uos-native"))
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut daemon = Self {
            child,
            address: None,
            reader: None,
        };
        daemon
            .child
            .stdin
            .take()
            .unwrap()
            .write_all(configuration.to_string().as_bytes())
            .unwrap();
        let stdout = daemon.child.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        daemon.reader = Some(thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).unwrap();
            let _ = send.send(line);
        }));
        let line = receive
            .recv_timeout(Duration::from_secs(10))
            .expect("actual native executable did not become ready");
        let event: Value =
            serde_json::from_str(&line).expect("native executable must emit its readiness receipt");
        assert_eq!(event["event"], "native_listener_ready");
        daemon.address = Some(event["address"].as_str().unwrap().parse().unwrap());
        daemon.reader.take().unwrap().join().unwrap();
        daemon
    }
    fn connect(&self) -> TcpStream {
        let stream = TcpStream::connect(self.address.unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
    }
    fn exchange(&self, request: &[u8]) -> Vec<u8> {
        let mut stream = self.connect();
        stream.write_all(request).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        response
    }
}
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
    }
}

fn signed_request(path: &str, body: &Value, nonce: u8, chunked: bool) -> Vec<u8> {
    let identity = NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [11; 32],
        BTreeSet::from([NativeCapability::SupervisorRead]),
    )
    .unwrap();
    let body = serde_json::to_vec(body).unwrap();
    let now = gateway_native::http_server::now_ms().unwrap();
    let nonce = base64url(&[nonce; 32]);
    let mac = identity.sign(path, now, &nonce, &body).unwrap();
    let framing = if chunked {
        "Transfer-Encoding: chunked".into()
    } else {
        format!("Content-Length: {}", body.len())
    };
    let mut request = format!("POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n{framing}\r\nx-uos-native-version: 1\r\nx-uos-native-key-id: fixture-key\r\nx-uos-native-time-ms: {now}\r\nx-uos-native-nonce: {nonce}\r\nx-uos-native-mac: {mac}\r\n\r\n").into_bytes();
    if chunked {
        for chunk in body.chunks(17) {
            request.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            request.extend_from_slice(chunk);
            request.extend_from_slice(b"\r\n");
        }
        request.extend_from_slice(b"0\r\n\r\n");
    } else {
        request.extend_from_slice(&body);
    }
    request
}
fn response(bytes: &[u8]) -> (u16, Value) {
    let boundary = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap();
    let head = std::str::from_utf8(&bytes[..boundary]).unwrap();
    let status = head
        .split_ascii_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes[boundary + 4..]).unwrap(),
    )
}

#[test]
fn actual_confined_daemon_serves_authenticated_http_sse_and_persistent_replay_fences() {
    let fixture = Fixture::new();
    let peer = Peer::start(&fixture.0.join("source.sock"));
    let configuration = fixture.configuration();
    let daemon = Daemon::start(&configuration);
    let sessions = json!({"v":1,"request":{"operation":"supervisor_sessions"}});
    let original = signed_request(NATIVE_RPC_PATH, &sessions, 1, true);
    let (status, body) = response(&daemon.exchange(&original));
    assert_eq!(status, 200);
    assert_eq!(body["status"], 200);
    assert!(body["body"].to_string().contains("thread-a"));
    let (status, replay) = response(&daemon.exchange(&original));
    assert_ne!(status, 200);
    assert_eq!(replay["error"]["code"], "native_nonce_replayed");

    let output = json!({"v":1,"request":{"operation":"supervisor_output","source_id":"fixture","thread_id":"thread-a","cursor":null}});
    let (status, output) =
        response(&daemon.exchange(&signed_request(NATIVE_RPC_PATH, &output, 2, false)));
    assert_eq!(status, 200);
    assert_eq!(output["status"], 200);
    assert_eq!(output["stream"]["kind"], "supervisor_follow");
    let mut follow = daemon.connect();
    follow
        .write_all(&signed_request(
            NATIVE_FOLLOW_PATH,
            &output["stream"],
            3,
            true,
        ))
        .unwrap();
    let mut observed = Vec::new();
    while !String::from_utf8_lossy(&observed)
        .split("event: entries")
        .nth(1)
        .is_some_and(|event| event.contains("\n\n"))
    {
        let mut buffer = [0; 4096];
        let length = follow.read(&mut buffer).unwrap();
        assert_ne!(length, 0, "follow must provide actual SSE entries");
        observed.extend_from_slice(&buffer[..length]);
        assert!(observed.len() < 65_536);
    }
    let events = String::from_utf8(observed).unwrap();
    assert!(events.starts_with("HTTP/1.1 200"));
    assert!(events.contains("Content-Type: text/event-stream"));
    assert!(events.contains("event: ready"));
    assert!(events.contains("fixture-visible"));
    assert!(!events.contains("synthetic-hidden-value"));
    assert!(!events.contains("fixture-private-reasoning"));
    drop(follow);
    thread::sleep(Duration::from_millis(200));
    let stopped = peer.follow_calls.load(Ordering::Acquire);
    thread::sleep(Duration::from_millis(2_200));
    assert_eq!(
        peer.follow_calls.load(Ordering::Acquire),
        stopped,
        "disconnect must stop follow polling"
    );

    let request = signed_request(NATIVE_RPC_PATH, &sessions, 4, false);
    let duplicate = String::from_utf8(request.clone()).unwrap().replacen(
        "\r\n\r\n",
        "\r\nx-uos-native-nonce: duplicate\r\n\r\n",
        1,
    );
    assert_ne!(response(&daemon.exchange(duplicate.as_bytes())).0, 200);
    assert_eq!(response(&daemon.exchange(&request)).0, 200);
    let oversized = format!(
        "POST {NATIVE_RPC_PATH} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
        NATIVE_MAX_BODY_BYTES + 1
    );
    assert_eq!(response(&daemon.exchange(oversized.as_bytes())).0, 413);
    let unknown = json!({"v":1,"request":{"operation":"supervisor_output","source_id":"not-configured","thread_id":"thread-a","cursor":null}});
    let (_, refusal) =
        response(&daemon.exchange(&signed_request(NATIVE_RPC_PATH, &unknown, 5, false)));
    assert_ne!(refusal["status"], 200);
    drop(daemon);
    let restarted = Daemon::start(&configuration);
    let (_, replay) = response(&restarted.exchange(&original));
    assert_eq!(replay["error"]["code"], "native_nonce_replayed");
    assert_eq!(
        response(&restarted.exchange(&signed_request(NATIVE_RPC_PATH, &sessions, 6, false))).0,
        200
    );
}
