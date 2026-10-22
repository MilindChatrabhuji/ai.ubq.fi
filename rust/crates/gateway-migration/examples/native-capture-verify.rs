//! Private EOF/inventory verification for one streamed native capture file.
//! It opens no source VM database, target, credential, service or writer.
#![cfg(all(unix, not(target_arch = "wasm32")))]
use gateway_migration::native_stage::Captured;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    v: u32,
    capture: PathBuf,
    directory: PathBuf,
    expected_entries: usize,
    expected_sha256: String,
}
#[derive(Serialize)]
struct Receipt {
    v: u32,
    kind: &'static str,
    capture: String,
    bytes: u64,
    sha256: String,
    entries: usize,
    eof: bool,
    spool_directory: String,
}
fn failure(message: &str) -> gateway_migration::MigrationError {
    gateway_core::GatewayError::unavailable(message, "m20_capture_verify_invalid").into()
}
fn main() -> Result<(), gateway_migration::MigrationError> {
    assert_eq!(std::env::args_os().len(), 1, "Private input is stdin only");
    let mut raw = Vec::new();
    std::io::stdin()
        .take(1024 * 1024)
        .read_to_end(&mut raw)
        .map_err(|_| failure("Private input cannot be read"))?;
    let input: Input =
        serde_json::from_slice(&raw).map_err(|_| failure("Private input is invalid"))?;
    if input.v != 1 || !input.capture.is_absolute() || !input.directory.is_absolute() {
        return Err(failure("Private capture verification options are invalid"));
    }
    let bytes = std::fs::metadata(&input.capture)
        .map_err(|_| failure("Private capture metadata is unavailable"))?
        .len();
    let mut file =
        File::open(&input.capture).map_err(|_| failure("Private capture cannot be read"))?;
    let mut hash = Sha256::new();
    let mut chunk = vec![0; 1024 * 1024];
    loop {
        let read = file
            .read(&mut chunk)
            .map_err(|_| failure("Private capture cannot be read"))?;
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
    }
    let sha256: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if sha256 != input.expected_sha256 {
        return Err(failure(
            "Private capture hash differs from its producer receipt",
        ));
    }
    let directory = gateway_migration::native_stage::directory(&input.directory)?;
    let capture = Captured::read(&input.capture, &directory)?;
    if capture.count() != input.expected_entries {
        return Err(failure(
            "Private capture inventory count differs from its producer receipt",
        ));
    }
    let receipt = Receipt {
        v: 1,
        kind: "m20_native_capture_verify",
        capture: input.capture.to_string_lossy().into_owned(),
        bytes,
        sha256,
        entries: capture.count(),
        eof: true,
        spool_directory: directory.to_string_lossy().into_owned(),
    };
    serde_json::to_writer(std::io::stdout().lock(), &receipt)
        .map_err(|_| failure("Private capture receipt cannot be printed"))?;
    println!();
    Ok(())
}
