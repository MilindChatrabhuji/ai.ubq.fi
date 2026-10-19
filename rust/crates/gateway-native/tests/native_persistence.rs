#![cfg(unix)]
use gateway_auth::{
    crypto::base64url, native_auth::NativeNonceAuthority, native_replay::StoreNonceAuthority,
};
use gateway_native::nonce_sqlite::SqliteNonceStore;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicUsize, Ordering},
};

#[test]
fn actual_separate_process_restart_keeps_replay_fence_and_absolute_expiry() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "uos-native-restart-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let path = root.join("nonces.sqlite3");
    let nonce = base64url(&[71; 32]);
    {
        let store = SqliteNonceStore::open(&path).unwrap();
        let authority = StoreNonceAuthority::new(&store);
        futures_executor::block_on(authority.consume_nonce("fixture-key", &nonce, 31_000, 1_000))
            .unwrap();
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "nonce_restart_child", "--nocapture"])
        .env("UOS_NATIVE_NONCE_RESTART_FIXTURE", &path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "restart child failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("NATIVE_NONCE_RESTART_ACCEPTED"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "isolated restart child entered only by the separate-process acceptance test"]
fn nonce_restart_child() {
    let path = PathBuf::from(std::env::var_os("UOS_NATIVE_NONCE_RESTART_FIXTURE").unwrap());
    let store = SqliteNonceStore::open(&path).unwrap();
    let authority = StoreNonceAuthority::new(&store);
    let nonce = base64url(&[71; 32]);
    let error =
        futures_executor::block_on(authority.consume_nonce("fixture-key", &nonce, 31_000, 31_000))
            .unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("native_nonce_replayed")
    );
    futures_executor::block_on(authority.consume_nonce("fixture-key", &nonce, 61_001, 31_001))
        .unwrap();
    println!("NATIVE_NONCE_RESTART_ACCEPTED");
}
