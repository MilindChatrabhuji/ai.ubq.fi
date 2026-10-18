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
    time::Duration,
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
        let path = PathBuf::from("/tmp").join(format!(
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

fn renewal_fixture(
    persist_generation: bool,
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
                        if value["params"]["refreshToken"] == true && persist_generation {
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
        let result = renew_owned(&transport, fence, &current, 1_000_000).await;
        server.join().unwrap();
        let observed = observed.lock().unwrap();
        assert_eq!(observed.len(), 4);
        assert_eq!(observed[0].0, "initialize");
        assert_eq!(observed[1].0, "initialized");
        assert_eq!(observed[2].1.as_ref().unwrap()["refreshToken"], false);
        assert_eq!(observed[3].1.as_ref().unwrap()["refreshToken"], true);
        result
    })
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
