use std::path::PathBuf;
use std::process::Command;

fn git(root: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .expect("release provenance requires Git at build time");
    assert!(
        output.status.success(),
        "could not establish exact Git build identity"
    );
    String::from_utf8(output.stdout)
        .expect("Git metadata must be UTF-8")
        .trim()
        .to_owned()
}

fn main() {
    let manifest =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest path"));
    let root = PathBuf::from(git(&manifest, &["rev-parse", "--show-toplevel"]));
    let sha = git(&root, &["rev-parse", "HEAD"]);
    assert!(
        sha.len() == 40
            && sha
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "a full Git SHA is required"
    );
    assert!(
        git(&root, &["status", "--porcelain", "--untracked-files=all"]).is_empty(),
        "release source must match its committed Git tree"
    );
    let head = git(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-path", "HEAD"],
    );
    let reference = git(&root, &["rev-parse", "--symbolic-full-name", "HEAD"]);
    let reference_path = git(
        &root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            &reference,
        ],
    );
    println!("cargo:rerun-if-changed={head}");
    println!("cargo:rerun-if-changed={reference_path}");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rustc-env=UOS_RUST_BUILD_GIT_SHA={sha}");
    println!("cargo:rustc-env=UOS_RUST_BUILD_DEPLOYMENT_ID=cloudflare-{sha}");
}
