#![cfg(unix)]

use gateway_auth::crypto::base64url;
use gateway_native::{
    unix::{NativeOwnerLocation, UnixOwnerTransport, UnixSupervisor},
    *,
};
use serde_json::{Value, json};
use std::{
    fs,
    future::Future,
    os::unix::net::UnixListener,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    task::{Context, Poll, Waker},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Message, accept_hdr,
    handshake::server::{Callback, ErrorResponse, Request, Response},
};

struct HeaderCheck;
impl Callback for HeaderCheck {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        assert_eq!(request.headers().get("host").unwrap(), "localhost");
        assert!(!request.headers().contains_key("sec-websocket-extensions"));
        Ok(response)
    }
}

fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}

struct FixtureHome(PathBuf);
impl FixtureHome {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "m6-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(path.join("app-server-control")).unwrap();
        Self(path)
    }
    fn socket(&self) -> PathBuf {
        self.0.join("app-server-control/app-server-control.sock")
    }
}
impl Drop for FixtureHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn document(refresh: &str, timestamp: &str) -> Value {
    let jwt = format!(
        "e30.{}.fixture",
        base64url(
            json!({"exp":2000,"email":"fixture@example.invalid"})
                .to_string()
                .as_bytes()
        )
    );
    json!({"auth_mode":"chatgpt","tokens":{"access_token":jwt,"id_token":jwt,"refresh_token":refresh,"account_id":"workspace"},"last_refresh":timestamp})
}

#[test]
fn fixed_registry_requires_one_or_two_distinct_owners_and_homes() {
    let first = FixtureHome::new();
    let second = FixtureHome::new();
    let third = FixtureHome::new();
    let location = |id: &str, home: &FixtureHome| {
        NativeOwnerLocation::configured(NativeOwnerId(id.into()), home.0.clone()).unwrap()
    };
    assert!(UnixOwnerTransport::new(Vec::new()).is_err());
    assert!(UnixOwnerTransport::new(vec![location("first", &first)]).is_ok());
    assert!(
        UnixOwnerTransport::new(vec![location("first", &first), location("second", &second)])
            .is_ok()
    );
    assert!(
        UnixOwnerTransport::new(vec![
            location("first", &first),
            location("second", &second),
            location("third", &third)
        ])
        .is_err()
    );
    assert!(
        UnixOwnerTransport::new(vec![location("first", &first), location("first", &second)])
            .is_err()
    );
    assert!(
        UnixOwnerTransport::new(vec![location("first", &first), location("second", &first)])
            .is_err()
    );
}

#[test]
fn second_registered_home_and_opaque_old_new_generations_stay_independent() {
    let first = FixtureHome::new();
    let second = FixtureHome::new();
    let first_doc = document("opaque-refresh-old", "2026-10-18T12:00:00.000000001Z");
    let mut second_doc = document("opaque-second-refresh", "2026-10-18T12:00:00.000000001Z");
    second_doc["tokens"]["account_id"] = json!("workspace-secondary");
    fs::write(
        first.0.join("auth.json"),
        serde_json::to_vec(&first_doc).unwrap(),
    )
    .unwrap();
    fs::write(
        second.0.join("auth.json"),
        serde_json::to_vec(&second_doc).unwrap(),
    )
    .unwrap();
    let first_owner = NativeOwnerId("first-owner".into());
    let second_owner = NativeOwnerId("second-owner".into());
    let transport = UnixOwnerTransport::new(vec![
        NativeOwnerLocation::configured(first_owner.clone(), first.0.clone()).unwrap(),
        NativeOwnerLocation::configured(second_owner.clone(), second.0.clone()).unwrap(),
    ])
    .unwrap();
    let old = run(transport.read_credentials(&first_owner)).unwrap();
    let second_before = run(transport.read_credentials(&second_owner)).unwrap();
    assert_eq!(second_before.account_id, "workspace-secondary");
    let new_doc = document("opaque-refresh-new", "2026-10-18T12:00:00.000000002Z");
    fs::write(
        first.0.join("auth.json"),
        serde_json::to_vec(&new_doc).unwrap(),
    )
    .unwrap();
    let new = run(transport.read_credentials(&first_owner)).unwrap();
    assert_ne!(new.generation_hash(), old.generation_hash());
    assert_eq!(new.refresh_token.expose(), "opaque-refresh-new");
    assert_eq!(
        run(transport.read_credentials(&second_owner))
            .unwrap()
            .generation_hash(),
        second_before.generation_hash()
    );
    assert!(run(transport.read_credentials(&NativeOwnerId("unregistered-owner".into()))).is_err());
}

#[test]
fn actual_unix_supervisor_uses_localhost_header_and_read_only_method() {
    run(async {
        let home = FixtureHome::new();
        let listener = UnixListener::bind(home.socket()).unwrap();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let seen = observed.clone();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut socket = accept_hdr(stream, HeaderCheck).unwrap();
            while let Ok(message) = socket.read() {
                if matches!(message, Message::Close(_)) {
                    break;
                }
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                let method = value["method"].as_str().unwrap();
                seen.lock().unwrap().push(method.to_owned());
                if let Some(id) = value.get("id") {
                    assert!(matches!(method, "initialize" | "thread/read"));
                    socket.send(Message::Text(json!({"id":id,"result":{"thread":{"id":"known","status":{"type":"active"}}}}).to_string().into())).unwrap();
                }
            }
        });
        let mut client = UnixSupervisor::configured_socket(&home.socket()).unwrap();
        let reply = client
            .call(
                SupervisorMethod::ThreadRead,
                json!({"threadId":"known","includeTurns":false}),
            )
            .await
            .unwrap();
        assert_eq!(reply["thread"]["id"], "known");
        client.close().await.unwrap();
        server.join().unwrap();
        assert_eq!(
            *observed.lock().unwrap(),
            ["initialize", "initialized", "thread/read"]
        );
    });
}

#[test]
fn renewal_outer_deadline_bounds_an_actual_stalled_handshake() {
    let home = FixtureHome::new();
    let listener = UnixListener::bind(home.socket()).unwrap();
    let server = thread::spawn(move || {
        let (_stream, _) = listener.accept().unwrap();
        thread::sleep(Duration::from_millis(400));
    });
    let owner = NativeOwnerId("fixture-deadline".into());
    let start = Instant::now();
    let transport = UnixOwnerTransport::until(
        vec![NativeOwnerLocation::configured(owner.clone(), home.0.clone()).unwrap()],
        start + Duration::from_millis(120),
    )
    .unwrap();
    assert!(run(transport.request(&owner, RenewalStep::Initialize)).is_err());
    assert!(start.elapsed() < Duration::from_millis(350));
    server.join().unwrap();
}

#[test]
fn expired_renewal_deadline_refuses_before_opening_registered_socket() {
    let home = FixtureHome::new();
    let listener = UnixListener::bind(home.socket()).unwrap();
    listener.set_nonblocking(true).unwrap();
    let owner = NativeOwnerId("fixture-expired".into());
    let transport = UnixOwnerTransport::until(
        vec![NativeOwnerLocation::configured(owner.clone(), home.0.clone()).unwrap()],
        Instant::now(),
    )
    .unwrap();
    assert!(run(transport.request(&owner, RenewalStep::Initialize)).is_err());
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
}

fn renewal_fixture(
    persist_generation: bool,
) -> Result<NativeGeneration, gateway_core::GatewayError> {
    renewal_with_guard(persist_generation, GuardPolicy::Allow)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum GuardPolicy {
    Allow,
    RefuseStart,
    RevokeAfterIdentity,
    AdoptDuringHandshake,
}

type ObservedRequests = Vec<(String, Option<Value>)>;

struct FixtureGuard {
    observed: Arc<Mutex<ObservedRequests>>,
    policy: GuardPolicy,
}
impl gateway_native::owner_control::NativeRenewalGuard for FixtureGuard {
    fn now_ms(&self) -> Result<i64, gateway_core::GatewayError> {
        Ok(1_000_000)
    }
    async fn ensure_current(&self) -> Result<(), gateway_core::GatewayError> {
        if self.policy == GuardPolicy::RevokeAfterIdentity
            && self.observed.lock().unwrap().len() >= 3
        {
            return Err(gateway_core::GatewayError::new(
                409,
                "Synthetic current authority changed",
                Some("native_owner_changed"),
            ));
        }
        Ok(())
    }
    async fn start_refresh(&self) -> Result<(), gateway_core::GatewayError> {
        if self.policy == GuardPolicy::RefuseStart {
            return Err(gateway_core::GatewayError::unavailable(
                "Synthetic original operation is already started",
                "native_control_outcome_unknown",
            ));
        }
        Ok(())
    }
}

fn renewal_with_guard(
    persist_generation: bool,
    policy: GuardPolicy,
) -> Result<NativeGeneration, gateway_core::GatewayError> {
    run(async {
        let home = FixtureHome::new();
        let old = document("fixture-refresh-a", "2026-10-18T12:00:00.000000001Z");
        fs::write(home.0.join("auth.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        let current = parse_native_document(&old).unwrap();
        let owner = NativeOwnerId("fixture-primary".into());
        let fence = OwnerFence {
            owner: owner.clone(),
            account_id: "workspace".into(),
            generation_hash: current.generation_hash(),
            authority_revision: "fixture-authority-revision".into(),
        };
        let listener = UnixListener::bind(home.socket()).unwrap();
        let server_home = home.0.clone();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let seen = observed.clone();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut socket = tungstenite::accept(stream).unwrap();
            while let Ok(message) = socket.read() {
                if matches!(message, Message::Close(_)) {
                    break;
                }
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                let method = value["method"].as_str().unwrap();
                seen.lock()
                    .unwrap()
                    .push((method.to_owned(), value.get("params").cloned()));
                let Some(id) = value.get("id") else {
                    continue;
                };
                let result = match method {
                    "initialize" => json!({"codexHome":server_home}),
                    "account/read" => {
                        if persist_generation
                            && (value["params"]["refreshToken"] == true
                                || policy == GuardPolicy::AdoptDuringHandshake)
                        {
                            let next =
                                document("fixture-refresh-b", "2026-10-18T12:00:00.000000002Z");
                            fs::write(
                                server_home.join("auth.json"),
                                serde_json::to_vec(&next).unwrap(),
                            )
                            .unwrap();
                        }
                        json!({"account":{"type":"chatgpt","email":"fixture@example.invalid"},"workspaceRouting":{"chatgptAccountId":"workspace"}})
                    }
                    _ => panic!("unexpected native method"),
                };
                socket
                    .send(Message::Text(
                        json!({"id":id,"result":result}).to_string().into(),
                    ))
                    .unwrap();
            }
        });
        let transport = UnixOwnerTransport::new(vec![
            NativeOwnerLocation::configured(owner, home.0.clone()).unwrap(),
        ])
        .unwrap();
        let guard = FixtureGuard {
            observed: observed.clone(),
            policy,
        };
        let result = renew_owned_guarded(&transport, &guard, fence, &current).await;
        server.join().unwrap();
        let observed = observed.lock().unwrap();
        assert_eq!(
            observed.len(),
            if policy == GuardPolicy::Allow { 4 } else { 3 }
        );
        assert_eq!(observed[0].0, "initialize");
        assert_eq!(observed[1].0, "initialized");
        assert_eq!(observed[2].1.as_ref().unwrap()["refreshToken"], false);
        if policy == GuardPolicy::Allow {
            assert_eq!(observed[3].1.as_ref().unwrap()["refreshToken"], true);
        }
        result
    })
}

#[test]
fn current_authority_replacement_or_replayed_start_prevents_actual_refresh_rpc() {
    assert_eq!(
        renewal_with_guard(true, GuardPolicy::RevokeAfterIdentity)
            .unwrap_err()
            .status,
        409
    );
    assert_eq!(
        renewal_with_guard(true, GuardPolicy::RefuseStart)
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("native_control_outcome_unknown")
    );
}

#[test]
fn newer_fixed_file_during_identity_handshake_is_adopted_without_refresh_rpc() {
    let result = renewal_with_guard(true, GuardPolicy::AdoptDuringHandshake).unwrap();
    assert_eq!(
        result.credentials.refresh_token.expose(),
        "fixture-refresh-b"
    );
}

#[test]
fn actual_renewal_requires_a_persisted_generation_after_fixed_identity_handshake() {
    let result = renewal_fixture(true).unwrap();
    assert_eq!(
        result.credentials.refresh_token.expose(),
        "fixture-refresh-b"
    );
    let error = renewal_fixture(false).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("codex_auth_refresh_failed")
    );
}

#[test]
fn oversized_frame_poisoning_refuses_reuse_and_close_without_a_second_read() {
    run(async {
        let home = FixtureHome::new();
        let listener = UnixListener::bind(home.socket()).unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut socket = accept_hdr(stream, HeaderCheck).unwrap();
            while let Ok(message) = socket.read() {
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                let Some(id) = value.get("id") else {
                    continue;
                };
                if value["method"] == "initialize" {
                    socket
                        .send(Message::Text(
                            json!({"id":id,"result":{"protocolVersion":1}})
                                .to_string()
                                .into(),
                        ))
                        .unwrap();
                } else {
                    assert_eq!(value["method"], "thread/turns/list");
                    let _ =
                        socket.send(Message::Text("x".repeat(SUPERVISOR_FRAME_LIMIT + 1).into()));
                    break;
                }
            }
        });
        let mut client = UnixSupervisor::configured_socket(&home.socket()).unwrap();
        assert!(
            client
                .call(
                    SupervisorMethod::ThreadTurnsList,
                    json!({"threadId":"known","itemsView":"full"})
                )
                .await
                .is_err()
        );
        assert!(
            client
                .call(SupervisorMethod::ThreadRead, json!({"threadId":"known"}))
                .await
                .is_err()
        );
        client.close().await.unwrap();
        client.close().await.unwrap();
        server.join().unwrap();
    });
}

#[test]
fn healthy_unix_close_retains_the_bounded_peer_handshake_grace() {
    run(async {
        let home = FixtureHome::new();
        let listener = UnixListener::bind(home.socket()).unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut socket = accept_hdr(stream, HeaderCheck).unwrap();
            let mut acknowledged = false;
            while let Ok(message) = socket.read() {
                if message.is_close() {
                    thread::sleep(Duration::from_millis(75));
                    // The pinned server reports ConnectionClosed only after
                    // writing its queued close acknowledgement successfully.
                    acknowledged = matches!(
                        socket.flush(),
                        Ok(()) | Err(tungstenite::Error::ConnectionClosed)
                    );
                    break;
                }
                let Message::Text(text) = message else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                if let Some(id) = value.get("id") {
                    socket
                        .send(Message::Text(
                            json!({"id":id,"result":{"protocolVersion":1}})
                                .to_string()
                                .into(),
                        ))
                        .unwrap();
                }
            }
            acknowledged
        });
        let mut client = UnixSupervisor::configured_socket(&home.socket()).unwrap();
        client.close().await.unwrap();
        assert!(
            server.join().unwrap(),
            "peer acknowledgement must reach the healthy client before shutdown"
        );
    });
}
