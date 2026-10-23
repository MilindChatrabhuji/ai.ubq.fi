use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::PathBuf,
    process::{Child, ChildStdout, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
struct Supervisor {
    child: Child,
    output: BufReader<ChildStdout>,
    directory: PathBuf,
    address: String,
}
fn configuration(directory: &std::path::Path) -> Value {
    json!({"v":1,"listen":"127.0.0.1:0","identity":{"key_id":"fixture-key","owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_base64url":gateway_auth::crypto::base64url(&[11;32])},"nonce_database":directory.join("replay/nonces.sqlite3"),"sources":[]})
}
fn binary(name: &str) -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(name)
}
fn directory(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("uos-{name}-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    fs::create_dir(directory.join("replay")).unwrap();
    directory
}
impl Supervisor {
    fn start() -> Self {
        let directory = directory("parent-death");
        let mut child = Command::new(binary("uos-native-supervisor"))
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(configuration(&directory).to_string().as_bytes())
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut supervisor = Self {
            child,
            output,
            directory,
            address: String::new(),
        };
        let ready = supervisor.event();
        assert_eq!(ready["event"], "native_listener_ready");
        supervisor.address = ready["address"].as_str().unwrap().into();
        supervisor
    }
    fn event(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).expect("actual supervisor event")
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn alive(pid: u64) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}
#[test]
fn supervisor_death_closes_actual_worker_and_connector_without_orphans() {
    let mut supervisor = Supervisor::start();
    let mut client = TcpStream::connect(&supervisor.address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let started = supervisor.event();
    assert_eq!(started["event"], "native_request_process_started");
    let request = started["request_pid"].as_u64().unwrap();
    let connector = started["connector_pid"].as_u64().unwrap();
    assert!(alive(request));
    assert!(alive(connector));
    supervisor.child.kill().unwrap();
    supervisor.child.wait().unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(request) || alive(connector) {
        assert!(
            Instant::now() < deadline,
            "owned child survived parent death: {request}/{connector}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn unexpected_inherited_descriptor_is_refused_without_closing_parent_sentinel() {
    let directory = directory("inherited-sentinel");
    let path = directory.join("sentinel");
    fs::write(&path, b"sentinel").unwrap();
    let mut sentinel = fs::File::open(&path).unwrap();
    let flags = rustix::io::fcntl_getfd(&sentinel).unwrap();
    rustix::io::fcntl_setfd(&sentinel, flags - rustix::io::FdFlags::CLOEXEC).unwrap();
    let (control, peer) = UnixStream::pair().unwrap();
    let fd: OwnedFd = control.into();
    let mut child = Command::new(super::fixture())
        .arg("production-idle")
        .env_clear()
        .stdin(Stdio::from(fd))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    rustix::io::fcntl_setfd(&sentinel, flags).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("inherited descriptor was not independently rejected");
        }
        thread::sleep(Duration::from_millis(2));
    };
    assert_eq!(status.code(), Some(68));
    child.wait().unwrap();
    drop(peer);
    let mut bytes = String::new();
    sentinel.read_to_string(&mut bytes).unwrap();
    assert_eq!(bytes, "sentinel");
    fs::remove_dir_all(directory).unwrap();
}
#[test]
fn request_role_refuses_nonpipe_config_before_reading_or_serving() {
    let directory = directory("wrong-role-handle");
    let file = fs::File::open("/dev/null").unwrap();
    let fd: OwnedFd = file.into();
    let status = Command::new(binary("uos-native-request"))
        .env_clear()
        .stdin(Stdio::from(fd))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(68));
    fs::remove_dir_all(directory).unwrap();
}
