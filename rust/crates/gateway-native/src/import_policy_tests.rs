//! Actual source-generated import policies with bounded synthetic local controls.
use super::*;
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
};
struct Root(std::path::PathBuf);
impl Root {
    fn new() -> Self {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = parent.join(format!("native-import-policy-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("home")).unwrap();
        fs::create_dir(root.join("replay")).unwrap();
        Self(root)
    }
    fn home(&self) -> std::path::PathBuf {
        self.0.join("home")
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn local(port: u16) -> SocketAddr {
    SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port))
}
fn profile(binary: &Path, root: &Root, endpoints: [SocketAddr; 3]) -> Result<String, ControlError> {
    import_actor(
        binary,
        &root.home(),
        &root.0.join("replay"),
        (local(31001), local(31002)),
        (local(31003), local(31004)),
        &endpoints,
    )
}
#[test]
fn actual_import_profile_exact_names_fixed_ports_process_and_sibling_controls() {
    let root = Root::new();
    let binary = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/uos-native-connector-fixture");
    assert!(
        binary.is_file(),
        "build the selected existing policy probe before execution"
    );
    let allowed = root.home().join("auth.json");
    let outside = root.0.join("outside");
    fs::write(&allowed, b"SYNTHETIC_READ").unwrap();
    fs::write(&outside, b"SYNTHETIC_OUTSIDE").unwrap();
    let denied = std::net::TcpListener::bind(local(0)).unwrap();
    let payload = serde_json::to_vec(&serde_json::json!({"allowed":allowed,"outside":outside,"replay":root.0.join("replay"),"denied_tcp":denied.local_addr().unwrap()})).unwrap();
    let policy = profile(&binary, &root, [local(31005), local(31006), local(31007)]).unwrap();
    let mut generator = Command::new(&binary)
        .arg("print-import-policy")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    generator.stdin.take().unwrap().write_all(&payload).unwrap();
    let generated = generator.wait_with_output().unwrap();
    assert!(generated.status.success());
    assert_eq!(
        String::from_utf8(generated.stdout).unwrap(),
        policy,
        "compiled fixed probe must use the same shipping import policy"
    );
    let run_probe = |profile: Option<&str>| {
        let mut command = if let Some(profile) = profile {
            let mut command = Command::new("/usr/bin/sandbox-exec");
            command.args(["-p", profile]).arg(&binary);
            command
        } else {
            Command::new(&binary)
        };
        let mut child = command
            .arg("policy-probe")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&payload).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "policy probe must exit normally: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let baseline = run_probe(None);
    let confined = run_probe(Some(&policy));
    for key in [
        "outside_read_denied",
        "outside_write_denied",
        "exec_denied",
        "self_spawn_denied",
        "non443_denied",
    ] {
        assert_eq!(
            baseline[key], false,
            "positive outside-policy control {key}"
        );
        assert_eq!(confined[key], true, "actual import policy must deny {key}");
    }
    assert_eq!(confined["read_allowed"], true);
    assert_eq!(confined["thread_allowed"], true);
    let touch_policy = profile(
        Path::new("/usr/bin/touch"),
        &root,
        [local(31005), local(31006), local(31007)],
    )
    .unwrap();
    for (suffix, length, allowed) in [
        ("tmp", 64, true),
        ("previous", 64, true),
        ("rotated", 64, true),
        ("receipt", 64, true),
        ("receipt.tmp", 64, true),
        ("tmpx", 64, false),
        ("tmp", 63, false),
        ("tmp", 65, false),
    ] {
        let path = root
            .home()
            .join(format!(".uos-import-{}.{}", "f".repeat(length), suffix));
        let output = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &touch_policy, "/usr/bin/touch"])
            .arg(&path)
            .env_clear()
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            allowed,
            "actual named-write {suffix}/{length}"
        );
        assert_eq!(path.exists(), allowed);
    }
    for name in [".uos-owner.lock", ".uos-runtime-epoch", "arbitrary"] {
        let path = root.home().join(name);
        let output = Command::new("/usr/bin/sandbox-exec")
            .args(["-p", &touch_policy, "/usr/bin/touch"])
            .arg(&path)
            .env_clear()
            .output()
            .unwrap();
        assert!(
            !output.status.success() && !path.exists(),
            "actor may not create {name}"
        );
    }
    // No external socket is opened: this checks only the trusted constructor's
    // existing port-only grammar and its non-443 fail-closed condition.
    let external = SocketAddr::from((std::net::Ipv4Addr::new(192, 0, 2, 1), 443));
    let trusted = profile(&binary, &root, [external; 3]).unwrap();
    assert!(trusted.contains("(remote tcp \"*:443\")"));
    assert!(!trusted.contains("(remote tcp \"*:*\")"));
    assert!(profile(&binary, &root, [SocketAddr::new(external.ip(), 444); 3]).is_err());
    assert!(profile(&binary, &root, [SocketAddr::from(([0, 0, 0, 0], 443)); 3]).is_err());
    assert!(profile(&binary, &root, [SocketAddr::from(([224, 0, 0, 1], 443)); 3]).is_err());
}
