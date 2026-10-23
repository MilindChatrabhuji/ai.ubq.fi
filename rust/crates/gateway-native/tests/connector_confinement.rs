#![cfg(target_os = "macos")]
mod lifecycle;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
};
fn fixture() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/uos-native-connector-fixture")
}
fn run(name: &str, input: &Value, profile: Option<&str>) -> std::process::Output {
    let mut command = if let Some(profile) = profile {
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.args(["-p", profile]).arg(fixture());
        c
    } else {
        Command::new(fixture())
    };
    let mut child = command
        .arg(name)
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
        .write_all(input.to_string().as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}
#[test]
fn actual_separate_prelaunch_profiles_enforce_files_processes_and_network() {
    let directory =
        std::env::temp_dir().join(format!("uos-connector-policy-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    fs::create_dir(directory.join("replay")).unwrap();
    let allowed = directory.join("allowed");
    let outside = directory.join("outside");
    fs::write(&allowed, b"synthetic-allowed").unwrap();
    fs::write(&outside, b"synthetic-outside").unwrap();
    let denied_tcp = TcpListener::bind("127.0.0.1:0").unwrap();
    let input = json!({"allowed":allowed,"outside":outside,"replay":directory.join("replay"),"denied_tcp":denied_tcp.local_addr().unwrap()});
    let control = run("policy-probe", &input, None);
    assert!(control.status.success());
    let observed: Value = serde_json::from_slice(&control.stdout).unwrap();
    for key in [
        "outside_read_denied",
        "outside_write_denied",
        "exec_denied",
        "self_spawn_denied",
        "non443_denied",
    ] {
        assert_eq!(observed[key], false, "outsidecontrol {key}");
    }
    for (name, read_allowed) in [
        ("print-main-policy", true),
        ("print-connector-policy", false),
    ] {
        let generated = run(name, &input, None);
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let profile = String::from_utf8(generated.stdout).unwrap();
        eprintln!(
            "PROFILE {name} sha256={}",
            gateway_auth::crypto::sha256_hex(profile.as_bytes())
        );
        let result = run("policy-probe", &input, Some(&profile));
        assert!(
            result.status.success(),
            "{name} {:?} {}",
            result.status,
            String::from_utf8_lossy(&result.stderr)
        );
        let observed: Value = serde_json::from_slice(&result.stdout).unwrap();
        for key in [
            "outside_read_denied",
            "outside_write_denied",
            "exec_denied",
            "self_spawn_denied",
            "non443_denied",
        ] {
            assert_eq!(observed[key], true, "{name} {key}: {observed}");
        }
        assert_eq!(observed["read_allowed"], read_allowed);
        assert_eq!(observed["thread_allowed"], true);
    }
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn actual_request_worker_uses_inherited_client_and_one_persistent_replay_fence() {
    use gateway_auth::{
        crypto::base64url,
        native_auth::{NativeCapability, NativeTransportIdentity},
    };
    use std::{
        collections::BTreeSet,
        io::{BufRead, BufReader, Read},
        net::TcpStream,
        time::Duration,
    };
    let directory =
        std::env::temp_dir().join(format!("uos-request-bootstrap-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    fs::create_dir(directory.join("replay")).unwrap();
    let config = json!({"v":1,"listen":"127.0.0.1:0","identity":{"key_id":"fixture-key","owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_base64url":base64url(&[11;32])},"nonce_database":directory.join("replay/nonces.sqlite3"),"sources":[]});
    let binary = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("uos-native-supervisor");
    let mut child = Command::new(binary)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    struct Cleanup(std::process::Child);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    child
        .stdin
        .take()
        .unwrap()
        .write_all(config.to_string().as_bytes())
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut cleanup = Cleanup(child);
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["event"], "native_listener_ready");
    let address = ready["address"].as_str().unwrap();
    let identity = NativeTransportIdentity::new(
        "fixture-key".into(),
        "fixture-owner".into(),
        "fixture-epoch".into(),
        [11; 32],
        BTreeSet::from([NativeCapability::SupervisorRead]),
    )
    .unwrap();
    let body = br#"{"v":1,"request":{"operation":"supervisor_sessions"}}"#;
    let now = gateway_native::http_server::now_ms().unwrap();
    let nonce = base64url(&[19; 32]);
    let mac = identity
        .sign(gateway_auth::native::NATIVE_RPC_PATH, now, &nonce, body)
        .unwrap();
    let mut request = format!("POST /v1/native/rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nx-uos-native-version: 1\r\nx-uos-native-key-id: fixture-key\r\nx-uos-native-time-ms: {now}\r\nx-uos-native-nonce: {nonce}\r\nx-uos-native-mac: {mac}\r\n\r\n",body.len()).into_bytes();
    request.extend_from_slice(body);
    for index in 0..2 {
        let mut socket = TcpStream::connect(address).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        socket.write_all(&request).unwrap();
        let mut bytes = Vec::new();
        let read = socket.read_to_end(&mut bytes);
        if let Err(error) = &read {
            eprintln!("request read failed: {error}");
            for _ in 0..2 {
                line.clear();
                output.read_line(&mut line).unwrap();
                eprintln!("CHILD_EVENT {}", line.trim());
            }
        }
        read.unwrap();
        let boundary = bytes
            .windows(4)
            .position(|b| b == b"\r\n\r\n")
            .expect("actual confined request must return HTTP");
        let result: Value = serde_json::from_slice(&bytes[boundary + 4..]).unwrap();
        if index == 0 {
            assert!(bytes.starts_with(b"HTTP/1.1 200"), "{result}");
        } else {
            assert_eq!(result["error"]["code"], "native_nonce_replayed");
        }
        line.clear();
        output.read_line(&mut line).unwrap();
        let started: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(started["event"], "native_request_process_started");
        line.clear();
        output.read_line(&mut line).unwrap();
        let settled: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(settled["event"], "native_request_process_settled");
        assert_eq!(settled["code"], 0);
    }
    cleanup.0.kill().unwrap();
    cleanup.0.wait().unwrap();
    fs::remove_dir_all(directory).unwrap();
}
