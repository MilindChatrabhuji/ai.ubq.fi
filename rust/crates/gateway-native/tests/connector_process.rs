#![cfg(unix)]
use std::{
    io::{Read, Write},
    net::TcpListener,
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
fn fixture() -> std::path::PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/uos-native-connector-fixture")
}
struct OwnedChild(Child);
impl OwnedChild {
    fn start(name: &str, stream: UnixStream) -> Self {
        Self::start_at(name, stream, None)
    }
    fn start_at(name: &str, stream: UnixStream, address: Option<std::net::SocketAddr>) -> Self {
        let fd: OwnedFd = stream.into();
        let mut command = Command::new(fixture());
        command.arg(name).env_clear();
        if let Some(address) = address {
            command.arg(address.to_string());
        }
        Self(
            command
                .stdin(Stdio::from(fd))
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        )
    }
    fn wait(&mut self, duration: Duration) -> ExitStatus {
        let deadline = Instant::now() + duration;
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                return self.0.wait().map(|_| status).unwrap();
            }
            assert!(
                Instant::now() < deadline,
                "child failed to settle before deadline"
            );
            thread::sleep(Duration::from_millis(2));
        }
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn send_connect(raw: &mut UnixStream) {
    let body = br#"{"operation":"connect","v":1,"channel":"provider_live","action_ref":"action-1","connection_id":"connection-1","authorization_ref":"authority_1"}"#;
    raw.write_all(&u32::try_from(body.len()).unwrap().to_be_bytes())
        .unwrap();
    raw.write_all(body).unwrap();
}
#[test]
fn blocked_dns_is_killed_by_control_eof_without_a_surviving_resolver() {
    let (local, mut raw) = UnixStream::pair().unwrap();
    let mut child = OwnedChild::start("blocked-dns", local);
    send_connect(&mut raw);
    thread::sleep(Duration::from_millis(30));
    drop(raw);
    assert_eq!(child.wait(Duration::from_secs(2)).code(), Some(75));
}
#[test]
fn blocked_dns_deadline_terminates_the_actual_process() {
    let (local, mut raw) = UnixStream::pair().unwrap();
    let mut child = OwnedChild::start("blocked-dns", local);
    send_connect(&mut raw);
    let start = Instant::now();
    assert_eq!(child.wait(Duration::from_secs(12)).code(), Some(81));
    assert!(start.elapsed() >= Duration::from_secs(9));
}
#[test]
fn actual_cancel_during_blocked_dns_is_acknowledged_and_reaped() {
    let (local, mut raw) = UnixStream::pair().unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut child = OwnedChild::start("blocked-dns", local);
    send_connect(&mut raw);
    let body = br#"{"operation":"cancel","v":1,"connection_id":"connection-1"}"#;
    raw.write_all(&u32::try_from(body.len()).unwrap().to_be_bytes())
        .unwrap();
    raw.write_all(body).unwrap();
    let mut header = [0; 4];
    raw.read_exact(&mut header).unwrap();
    let mut bytes = vec![0; usize::try_from(u32::from_be_bytes(header)).unwrap()];
    raw.read_exact(&mut bytes).unwrap();
    let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["operation"], "cancelled");
    assert_eq!(child.wait(Duration::from_secs(2)).code(), Some(73));
}
#[test]
fn idle_production_connector_dies_without_dns_or_connect_when_parent_closes() {
    let (local, raw) = UnixStream::pair().unwrap();
    let mut child = OwnedChild::start("production-idle", local);
    drop(raw);
    assert_eq!(child.wait(Duration::from_secs(2)).code(), Some(75));
}
#[test]
fn actual_tcp_descriptor_outlives_dial_process_and_control_channel() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    server.set_nonblocking(true).unwrap();
    let (dial, receiver) = UnixStream::pair().unwrap();
    let mut dial = OwnedChild::start_at("loopback-dial", dial, Some(address));
    let mut receiver = OwnedChild::start_at("retained-loopback", receiver, Some(address));
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut actual = loop {
        match server.accept() {
            Ok((stream, _)) => break stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(2));
            }
            Err(e) => panic!("{e}"),
        }
    };
    actual.set_nonblocking(false).unwrap();
    actual
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut bytes = [0; 11];
    actual.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"retained-fd");
    assert_eq!(dial.wait(Duration::from_secs(2)).code(), Some(0));
    actual.write_all(b"complete").unwrap();
    assert_eq!(receiver.wait(Duration::from_secs(2)).code(), Some(0));
    assert_eq!(actual.read(&mut [0]).unwrap(), 0);
}
