//! Actual task-owned OS observations. No real credentials/UID provisioning/Codex launch.
use super::*;
use super::{
    acl_inspector,
    exclusive_owner::{Facts, PinnedExecutable},
};
use gateway_auth::crypto::sha256_hex;
use gateway_authority::native_control::RegisteredRenewalOwner;
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        static ID: AtomicU64 = AtomicU64::new(0);
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(base.starts_with("/private/tmp/ai-rust-wasm-20261018"));
        let path = base.join(format!(
            "exclusive-owner-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let mut auth = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path.join("auth.json"))
            .unwrap();
        auth.write_all(b"SYNTHETIC_OWNER_DATA").unwrap();
        auth.sync_all().unwrap();
        let lock = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path.join(".uos-owner.lock"))
            .unwrap();
        lock.sync_all().unwrap();
        Self(path)
    }
    fn store(&self) -> (ExistingAccountImportStore, RegisteredRenewalOwner) {
        let registration = RegisteredRenewalOwner::configured(
            "synthetic-exclusive-owner".into(),
            self.0.to_str().unwrap().into(),
        )
        .unwrap();
        let store = ExistingAccountImportStore::configured(
            &registration,
            sha256_hex(b"synthetic-existing-account"),
        )
        .unwrap();
        (store, registration)
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!("PRESERVED_SYNTHETIC_OWNER_FIXTURE {}", self.0.display());
            if let Ok(bytes) = fs::read(self.0.join(".uos-owner-fixture.stderr")) {
                eprintln!(
                    "OWNED_CHILD_DIAGNOSTIC {}",
                    String::from_utf8_lossy(&bytes[..bytes.len().min(16384)])
                );
            }
            return;
        }
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn helper() -> (PathBuf, String) {
    let binary = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("uos-native-owner-inspect");
    assert!(
        binary.is_file(),
        "build exact inspector bin before these tests"
    );
    let digest = sha256_hex(&fs::read(&binary).unwrap());
    (binary, digest)
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(15)
}
fn owner(home: &Home) -> ExclusiveManagedOwner {
    let (store, registered) = home.store();
    let (helper, hash) = helper();
    let uid = rustix::process::getuid().as_raw();
    store
        .prepare_exclusive_owner(&registered, uid, &[uid + 1], &helper, &hash, deadline())
        .unwrap()
}
#[test]
fn actual_anchored_inspector_no_acl_preserves_parent_cwd_and_rejects_real_ace() {
    let home = Home::new();
    let file = fs::File::open(&home.0).unwrap();
    let (helper, hash) = helper();
    let helper = PinnedExecutable::verify(&helper, &hash).unwrap();
    let cwd = std::env::current_dir().unwrap();
    acl_inspector::observe(&file, &helper, deadline()).unwrap();
    assert_eq!(std::env::current_dir().unwrap(), cwd);
    let output = Command::new("/usr/bin/id")
        .arg("-un")
        .env_clear()
        .output()
        .unwrap();
    assert!(output.status.success() && output.stderr.is_empty());
    let username = std::str::from_utf8(&output.stdout)
        .unwrap()
        .trim_end_matches('\n');
    assert!(
        !username.is_empty()
            && username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    );
    let ace = format!("user:{username} allow readsecurity");
    let status = Command::new("/bin/chmod")
        .args(["+a", &ace])
        .arg(&home.0)
        .status()
        .unwrap();
    assert!(status.success());
    assert!(acl_inspector::observe(&file, &helper, deadline()).is_err());
    let status = Command::new("/bin/chmod")
        .args(["-a", &ace])
        .arg(&home.0)
        .status()
        .unwrap();
    assert!(status.success());
    acl_inspector::observe(&file, &helper, deadline()).unwrap();
    assert_eq!(std::env::current_dir().unwrap(), cwd);
}
#[test]
fn full_numeric_header_parser_rejects_prefixes_acl_control_unknown_and_stat_mismatch() {
    let home = Home::new();
    let facts = Facts::read(&fs::File::open(&home.0).unwrap()).unwrap();
    let header = format!(
        "drwx------@ {} {} {} {} Oct 20 04:55 .\n",
        facts.links, facts.uid, facts.gid, facts.size
    );
    acl_inspector::parse(header.as_bytes(), &facts).unwrap();
    for bytes in [
        header.trim_end().as_bytes().to_vec(),
        format!(" {header}").into_bytes(),
        header.replace(".\n", ". \n").into_bytes(),
        header.replace(" 20 ", " 020 ").into_bytes(),
        format!("{header} 0: user:501 allow write\n").into_bytes(),
        format!("{header}\n").into_bytes(),
        header.replace("04:55", "99:99").into_bytes(),
        header.replace(".\n", "\u{001b}.\n").into_bytes(),
        header.replace("drwx------@", "drwx------+ ").into_bytes(),
        vec![b' '; 1025],
    ] {
        assert!(acl_inspector::parse(&bytes, &facts).is_err());
    }
    let mut changed = facts;
    changed.uid += 1;
    assert!(acl_inspector::parse(header.as_bytes(), &changed).is_err());
}
#[test]
fn actual_principal_path_inode_mode_and_executable_mismatches_never_grant_mutation() {
    let home = Home::new();
    let (store, registered) = home.store();
    let (helper, hash) = helper();
    let uid = rustix::process::getuid().as_raw();
    assert!(
        store
            .prepare_exclusive_owner(&registered, uid, &[uid], &helper, &hash, deadline())
            .is_err()
    );
    assert!(
        store
            .prepare_exclusive_owner(&registered, uid + 1, &[uid], &helper, &hash, deadline())
            .is_err()
    );
    assert!(
        store
            .prepare_exclusive_owner(
                &registered,
                uid,
                &[uid + 1],
                &helper,
                &sha256_hex(b"wrong"),
                deadline()
            )
            .is_err()
    );
    let owner = owner(&home);
    assert!(store.require_mutation_owner().is_err());
    fs::set_permissions(&home.0, fs::Permissions::from_mode(0o777)).unwrap();
    assert!(owner.recheck(deadline()).is_err());
    fs::set_permissions(&home.0, fs::Permissions::from_mode(0o700)).unwrap();
    let renamed = home.0.with_extension("retained");
    fs::rename(&home.0, &renamed).unwrap();
    fs::create_dir(&home.0).unwrap();
    fs::set_permissions(&home.0, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(owner.recheck(deadline()).is_err());
    fs::remove_dir(&home.0).unwrap();
    fs::rename(renamed, &home.0).unwrap();
    let link = home.0.join("alias");
    std::os::unix::fs::symlink(&helper, &link).unwrap();
    assert!(PinnedExecutable::verify(&link, &hash).is_err());
}
#[test]
fn insecure_nonsticky_parent_and_hardlinked_auth_refuse_runtime() {
    let home = Home::new();
    let owner = owner(&home);
    fs::hard_link(home.0.join("auth.json"), home.0.join("auth-copy")).unwrap();
    assert!(owner.prepare_runtime().is_err());
    let outer = Home::new();
    fs::set_permissions(&outer.0, fs::Permissions::from_mode(0o777)).unwrap();
    let inner = outer.0.join("owner");
    fs::create_dir(&inner).unwrap();
    fs::set_permissions(&inner, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(inner.join("auth.json"), b"SYNTHETIC").unwrap();
    fs::set_permissions(inner.join("auth.json"), fs::Permissions::from_mode(0o600)).unwrap();
    let registered =
        RegisteredRenewalOwner::configured("fixture".into(), inner.to_str().unwrap().into())
            .unwrap();
    let store =
        ExistingAccountImportStore::configured(&registered, sha256_hex(b"account")).unwrap();
    let (helper, hash) = helper();
    let uid = rustix::process::getuid().as_raw();
    assert!(
        store
            .prepare_exclusive_owner(&registered, uid, &[uid + 1], &helper, &hash, deadline())
            .is_err()
    );
}
fn fixture_profile(executable: &Path, home: &Path) -> String {
    let quoted = |path: &Path| serde_json::to_string(path.to_str().unwrap()).unwrap();
    format!(
        "(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath {})) (deny process-fork) (deny process-exec*) (allow process-exec (literal {}))",
        quoted(home),
        quoted(executable)
    )
}
#[test]
fn actual_owned_async_child_stop_wait_and_dirty_epoch_do_not_infer_external_absence() {
    let home = Home::new();
    let custody = owner(&home);
    let mut runtime = custody.prepare_runtime().unwrap();
    assert!(!runtime.has_settled_owned_writer());
    let exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let hash = sha256_hex(&fs::read(&exe).unwrap());
    let profile = fixture_profile(&exe, &home.0);
    // The first-party test child obtains only a synthetic output path through argv after '--'.
    runtime
        .spawn_fixture(
            &exe,
            &hash,
            &[
                "--exact",
                "existing_account_import::foundation_tests::controlled_async_writer_child",
                "--nocapture",
                "--ignored",
            ],
            &profile,
            deadline(),
        )
        .unwrap();
    // No fake successful child handshake is accepted. The child test entry below performs the
    // actual fork/exec denial check; this test validates actual Child ownership and settlement.
    wait_ready(&home);
    assert!(!runtime.has_settled_owned_writer());
    assert!(
        fs::read(home.0.join("async-native-write"))
            .unwrap()
            .starts_with(b"synthetic-write-")
    );
    // Drop is deliberately UNKNOWN even when best-effort cleanup reaps our actual child.
    drop(runtime);
    let replacement = owner(&home);
    assert!(replacement.prepare_runtime().is_err());
}
#[test]
fn actual_owned_child_reap_records_stopped_but_reopened_marker_grants_no_lease() {
    let home = Home::new();
    let custody = owner(&home);
    let mut runtime = custody.prepare_runtime().unwrap();
    let exe = fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
    let hash = sha256_hex(&fs::read(&exe).unwrap());
    let profile = fixture_profile(&exe, &home.0);
    runtime
        .spawn_fixture(
            &exe,
            &hash,
            &[
                "--exact",
                "existing_account_import::foundation_tests::controlled_async_writer_child",
                "--nocapture",
                "--ignored",
            ],
            &profile,
            deadline(),
        )
        .unwrap();
    wait_ready(&home);
    super::owner_runtime::fixture_stop(&mut runtime, deadline()).unwrap();
    assert!(runtime.has_settled_owned_writer());
    let final_bytes = fs::read(home.0.join("async-native-write")).unwrap();
    std::thread::sleep(Duration::from_millis(25));
    assert_eq!(
        fs::read(home.0.join("async-native-write")).unwrap(),
        final_bytes
    );
    drop(runtime);
    let replacement = owner(&home).prepare_runtime().unwrap();
    assert!(!replacement.has_settled_owned_writer());
}
#[test]
#[ignore = "Only the fixed owned-process fixture launcher executes this child"]
fn controlled_async_writer_child() {
    assert!(
        Command::new("/bin/true").spawn().is_err(),
        "mandatory fixed profile must deny unlisted exec"
    );
    assert!(
        Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .spawn()
            .is_err(),
        "mandatory process-fork denial must also block the otherwise allowed executable"
    );
    let home = PathBuf::from(std::env::var_os("UOS_NATIVE_OWNER_TEST_DIRECTORY").unwrap());
    assert!(home.starts_with("/private/tmp/ai-rust-wasm-20261018"));
    fs::write(home.join("writer-ready"), b"process-denial-observed").unwrap();
    for count in 0u64.. {
        fs::write(
            home.join("async-native-write"),
            format!("synthetic-write-{count}"),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_ready(home: &Home) {
    let limit = deadline();
    while !home.0.join("async-native-write").exists() {
        assert!(
            Instant::now() < limit,
            "owned child failed readiness/no-descendant control"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fs::read(home.0.join("writer-ready")).unwrap(),
        b"process-denial-observed"
    );
}
