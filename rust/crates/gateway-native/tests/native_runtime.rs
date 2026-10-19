#![cfg(target_os = "linux")]
use gateway_auth::{
    crypto::base64url, native_auth::NativeNonceAuthority, native_replay::StoreNonceAuthority,
};
use gateway_core::state::{AuthorityStore, RecordKey};
use gateway_native::{daemon_config::NativeDaemonConfig, nonce_sqlite::SqliteNonceStore};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "uos-native-runtime-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn native_nonce_fences_survive_actual_database_close_and_restart() {
    let fixture = Fixture::new();
    let path = fixture.0.join("nonces.sqlite3");
    let nonce = base64url(&[7; 32]);
    {
        let store = SqliteNonceStore::open(&path).unwrap();
        let authority = StoreNonceAuthority::new(&store);
        futures_executor::block_on(authority.consume_nonce("fixture-key", &nonce, 31_000, 1_000))
            .unwrap();
        assert!(
            futures_executor::block_on(store.read(&RecordKey("not-the-fixed-native-key".into())))
                .is_err()
        );
    }
    let store = SqliteNonceStore::open(&path).unwrap();
    let authority = StoreNonceAuthority::new(&store);
    let replay =
        futures_executor::block_on(authority.consume_nonce("fixture-key", &nonce, 31_000, 31_000))
            .unwrap_err();
    assert_eq!(
        replay.envelope.error.code.as_deref(),
        Some("native_nonce_replayed")
    );
    futures_executor::block_on(authority.consume_nonce("fixture-key", &nonce, 61_001, 31_001))
        .unwrap();
}

#[test]
fn replay_database_refuses_foreign_sqlite_without_modifying_it_or_its_directory() {
    let fixture = Fixture::new();
    let path = fixture.0.join("foreign.sqlite3");
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("CREATE TABLE retained(value TEXT);INSERT INTO retained VALUES('synthetic-retained-value');").unwrap();
    drop(database);
    let before = fs::read(&path).unwrap();
    let mut entries = fs::read_dir(&fixture.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    entries.sort();
    assert!(SqliteNonceStore::open(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    let mut after = fs::read_dir(&fixture.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    after.sort();
    assert_eq!(entries, after);
}

#[test]
fn daemon_stdin_requires_explicit_loopback_sources_and_canonical_dedicated_key() {
    let value = json!({"v":1,"listen":"127.0.0.1:0","identity":{"key_id":"fixture-key","owner_id":"fixture-owner","owner_epoch":"fixture-epoch","key_base64url":base64url(&[11;32])},"nonce_database":"/tmp/fixture-only/nonces.sqlite3","sources":[{"id":"fixture","name":"Synthetic Source","socket_path":"/tmp/fixture-only/source.sock","codex_home":null}]});
    let parsed = NativeDaemonConfig::read_stdin(value.to_string().as_bytes()).unwrap();
    assert!(parsed.listen.ip().is_loopback());
    assert_eq!(parsed.sources[0].id(), "fixture");
    let mut outside = value.clone();
    outside["listen"] = json!("0.0.0.0:8071");
    assert!(NativeDaemonConfig::read_stdin(outside.to_string().as_bytes()).is_err());
    let mut key = value.clone();
    key["identity"]["key_base64url"] = json!(format!("{}=", base64url(&[11; 32])));
    assert!(NativeDaemonConfig::read_stdin(key.to_string().as_bytes()).is_err());
    let mut injected = value;
    injected["command"] = json!("not-an-operation");
    assert!(NativeDaemonConfig::read_stdin(injected.to_string().as_bytes()).is_err());
}

#[test]
fn actual_kernel_profile_refuses_unconfigured_files_sockets_network_and_exec() {
    use std::{net::TcpListener, os::unix::net::UnixListener, process::Command};
    let fixture = Fixture::new();
    let allowed = fixture.0.join("allowed.txt");
    let outside = fixture.0.join("outside.txt");
    let private = fixture.0.join("replay");
    fs::write(&allowed, "synthetic-allowed").unwrap();
    fs::write(&outside, "synthetic-outside-control").unwrap();
    fs::create_dir(&private).unwrap();
    let socket = fixture.0.join("allowed.sock");
    let other = fixture.0.join("outside.sock");
    let _allowed = UnixListener::bind(&socket).unwrap();
    let _outside = UnixListener::bind(&other).unwrap();
    let tcp = TcpListener::bind("127.0.0.1:0").unwrap();
    let input = json!({"allowed":allowed,"outside":outside,"private":private,"socket":socket,"other_socket":other,"tcp":tcp.local_addr().unwrap().to_string()});
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "confinement_child", "--nocapture"])
        .env("UOS_NATIVE_TEST_PROFILE", input.to_string())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "child profile failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("NATIVE_PROFILE_ACCEPTED"));
    assert_eq!(
        fs::read_to_string(&outside).unwrap(),
        "synthetic-outside-control"
    );
}

#[test]
#[ignore = "isolated child entered only by the kernel profile acceptance test"]
fn confinement_child() {
    use gateway_native::confinement::{NativeConfinement, enforce};
    use std::{net::TcpStream, os::unix::net::UnixStream, process::Command};
    let input: serde_json::Value =
        serde_json::from_str(&std::env::var("UOS_NATIVE_TEST_PROFILE").unwrap()).unwrap();
    let path = |key: &str| PathBuf::from(input[key].as_str().unwrap());
    let allowed = path("allowed");
    let outside = path("outside");
    let private = path("private");
    let socket = path("socket");
    let other = path("other_socket");
    let tcp = input["tcp"].as_str().unwrap().to_owned();
    assert!(fs::read(&outside).is_ok());
    assert!(UnixStream::connect(&other).is_ok());
    assert!(TcpStream::connect(&tcp).is_ok());
    enforce(&NativeConfinement {
        readonly_paths: vec![allowed.clone()],
        list_directories: vec![],
        replay_directory: private.clone(),
        unix_sockets: vec![socket.clone()],
    })
    .unwrap();
    assert_eq!(fs::read_to_string(&allowed).unwrap(), "synthetic-allowed");
    assert!(fs::read(&outside).is_err());
    assert!(fs::write(&outside, "must-not-write").is_err());
    fs::write(private.join("fixture-write"), "owned").unwrap();
    assert!(UnixStream::connect(&socket).is_ok());
    assert!(UnixStream::connect(&other).is_err());
    assert!(TcpStream::connect(&tcp).is_err());
    assert!(Command::new("/bin/true").status().is_err());
    assert_eq!(std::thread::spawn(|| 17).join().unwrap(), 17);
    println!("NATIVE_PROFILE_ACCEPTED");
}
