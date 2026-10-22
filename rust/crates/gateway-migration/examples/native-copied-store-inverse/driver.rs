//! Private operator composition. Receipt hashes bind supplied provenance; they
//! never turn a captured record, file name or expected value into authority.
use super::store::ReadonlyStore;
use gateway_auth::native_credentials::OwnerFence;
use gateway_core::identity::MAX_SAFE_INTEGER;
use gateway_migration::{
    ArtifactContext,
    native_operator::{ConfiguredNativeCustody, NativeCustodyRegistration, write_private_latest},
    operational::ArtifactInput,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, DirBuilder, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileFact {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub home: PathBuf,
    pub fence: OwnerFence,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub v: u32,
    pub now_ms: i64,
    pub backup_receipt: FileFact,
    pub authority_receipt: FileFact,
    pub registrations: Vec<Registration>,
    pub artifacts: ArtifactInput,
    pub native_nonce_capture: Option<FileFact>,
    pub output_directory: PathBuf,
}

/// This is the completed read-only online-backup recipe's metadata-only receipt.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupReceipt {
    method: String,
    source_mode: String,
    source: PathBuf,
    destination: PathBuf,
    source_inode: u64,
    source_device: u64,
    started_at: String,
    consistent_backup_complete: bool,
    progress: Progress,
    finished_at: String,
    bytes: u64,
    destination_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    status: u32,
    remaining: u64,
    total: u64,
}

/// Independently recorded by the trusted runtime operator when observing the
/// source object and making its backup. The driver checks this separate file's
/// pinned digest and its binding to the actual backup receipt, not an echoed
/// expected-object field in the invocation. It is provenance DATA, not a seal.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthorityReceipt {
    v: u32,
    operation: String,
    backup_receipt_sha256: String,
    source_database: PathBuf,
    source_inode: u64,
    source_device: u64,
    namespace: String,
    object_name: String,
    object_id: String,
    source_git_sha: String,
    source_git_tree: String,
    wasm_sha256: String,
    native_sha256: String,
    observed_at_ms: i64,
}

#[derive(Serialize)]
pub struct OutputFact {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct Receipt {
    v: u32,
    operation: &'static str,
    input: OutputFact,
    backup_receipt_sha256: String,
    authority_receipt_sha256: String,
    provenance: &'static str,
    authority_namespace: String,
    authority_object_name: String,
    authority_object_id: String,
    now_ms: i64,
    source_rows: usize,
    source: OutputFact,
    custody: OutputFact,
    artifacts: ArtifactContext,
    input_unchanged: bool,
    activation_authorized: bool,
}

pub fn execute(input: Input) -> Result<Receipt> {
    if input.v != 1 || !(0..=MAX_SAFE_INTEGER).contains(&input.now_ms) {
        return Err(refused());
    }
    let mut backup_guard = Guard::open(&input.backup_receipt.path)?;
    let backup: BackupReceipt = backup_guard.json(&input.backup_receipt.sha256)?;
    let mut authority_guard = Guard::open(&input.authority_receipt.path)?;
    let authority: AuthorityReceipt = authority_guard.json(&input.authority_receipt.sha256)?;
    validate_binding(&input, &backup, &authority)?;
    let mut database_guard = Guard::open(&backup.destination)?;
    if database_guard.metadata.len() != backup.bytes
        || database_guard.digest()? != backup.destination_sha256
        || (database_guard.metadata.dev() == backup.source_device
            && database_guard.metadata.ino() == backup.source_inode)
    {
        return Err(refused());
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = backup.destination.as_os_str().to_os_string();
        name.push(suffix);
        if Path::new(&name).try_exists()? {
            return Err(refused());
        }
    }
    let mut nonce_guard = match (
        &input.native_nonce_capture,
        &input.artifacts.native_nonce_capture_sha256,
    ) {
        (Some(fact), Some(expected)) if &fact.sha256 == expected => {
            let mut guard = Guard::open(&fact.path)?;
            if guard.digest()? != *expected {
                return Err(refused());
            }
            Some(guard)
        }
        (None, None) => None,
        _ => return Err(refused()),
    };
    let store = ReadonlyStore::open(&backup.destination, input.now_ms)?;
    let registrations = input
        .registrations
        .into_iter()
        .map(|r| NativeCustodyRegistration::existing(r.home, r.fence))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let custody = ConfiguredNativeCustody::new(registrations)?;
    let artifacts: ArtifactContext = input.artifacts.into();
    absolute(&input.output_directory)?;
    DirBuilder::new()
        .mode(0o700)
        .create(&input.output_directory)?;
    let source_path = input.output_directory.join("source.private.json");
    let custody_path = input.output_directory.join("custody.private.json");
    let mut source_file = output(&source_path)?;
    let mut custody_file = output(&custody_path)?;
    let rows = run(write_private_latest(
        &store,
        input.now_ms,
        &custody,
        artifacts.clone(),
        &mut source_file,
        &mut custody_file,
    ))?;
    source_file.sync_all()?;
    custody_file.sync_all()?;
    drop(source_file);
    drop(custody_file);
    database_guard.unchanged(&backup.destination_sha256)?;
    backup_guard.unchanged(&input.backup_receipt.sha256)?;
    authority_guard.unchanged(&input.authority_receipt.sha256)?;
    if let Some(guard) = &mut nonce_guard {
        guard.unchanged(
            artifacts
                .native_nonce_capture_sha256
                .as_deref()
                .ok_or_else(refused)?,
        )?;
    }
    let receipt = Receipt {
        v: 1,
        operation: "copied_store_latest_inverse",
        input: OutputFact {
            path: backup.destination,
            sha256: backup.destination_sha256,
            bytes: backup.bytes,
        },
        backup_receipt_sha256: input.backup_receipt.sha256,
        authority_receipt_sha256: input.authority_receipt.sha256,
        provenance: "hash_bound_trusted_operator_receipts; no authority or live-source currentness minted",
        authority_namespace: authority.namespace,
        authority_object_name: authority.object_name,
        authority_object_id: authority.object_id,
        now_ms: input.now_ms,
        source_rows: rows,
        source: fact(&source_path)?,
        custody: fact(&custody_path)?,
        artifacts,
        input_unchanged: true,
        activation_authorized: false,
    };
    // A partial source/custody file is never accepted without this last receipt.
    let mut receipt_file = output(&input.output_directory.join("receipt.json"))?;
    serde_json::to_writer(&mut receipt_file, &receipt)?;
    receipt_file.write_all(b"\n")?;
    receipt_file.sync_all()?;
    File::open(&input.output_directory)?.sync_all()?;
    Ok(receipt)
}

fn validate_binding(
    input: &Input,
    backup: &BackupReceipt,
    authority: &AuthorityReceipt,
) -> Result<()> {
    absolute(&backup.source)?;
    absolute(&backup.destination)?;
    let source_file = format!("{}.sqlite", authority.object_id);
    if backup.method != "sqlite3.Connection.backup"
        || backup.source == backup.destination
        || backup.source_mode != "ro"
        || !backup.consistent_backup_complete
        || backup.progress.status != 101
        || backup.progress.remaining != 0
        || backup.progress.total == 0
        || backup.started_at.is_empty()
        || backup.finished_at.is_empty()
        || backup.bytes == 0
        || !hex(&backup.destination_sha256, 64)
        || authority.v != 1
        || authority.operation != "observed_workerd_authority"
        || authority.backup_receipt_sha256 != input.backup_receipt.sha256
        || authority.source_database != backup.source
        || authority.source_inode != backup.source_inode
        || authority.source_device != backup.source_device
        || authority.namespace.is_empty()
        || authority.namespace.len() > 256
        || !authority
            .namespace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        || authority.object_name != "gateway-authority-v1"
        || !hex(&authority.object_id, 64)
        || backup.source.file_name().and_then(|s| s.to_str()) != Some(source_file.as_str())
        || backup
            .source
            .parent()
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            != Some(authority.namespace.as_str())
        || !(0..=input.now_ms).contains(&authority.observed_at_ms)
        || authority.source_git_sha != input.artifacts.rust_git_sha
        || authority.source_git_tree != input.artifacts.rust_git_tree
        || authority.wasm_sha256 != input.artifacts.wasm_sha256
        || authority.native_sha256 != input.artifacts.native_sha256
    {
        return Err(refused());
    }
    Ok(())
}

fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err(refused());
    }
    Ok(())
}

fn output(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?)
}

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

struct Guard {
    path: PathBuf,
    file: File,
    metadata: fs::Metadata,
}

impl Guard {
    fn open(path: &Path) -> Result<Self> {
        absolute(path)?;
        let before = fs::symlink_metadata(path)?;
        if !before.is_file() || before.mode() & 0o077 != 0 || before.nlink() != 1 {
            return Err(refused());
        }
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if !same(&before, &metadata) {
            return Err(refused());
        }
        Ok(Self {
            path: path.into(),
            file,
            metadata,
        })
    }

    fn digest(&mut self) -> Result<String> {
        self.file.seek(SeekFrom::Start(0))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 65_536];
        loop {
            let size = self.file.read(&mut buffer)?;
            if size == 0 {
                break;
            }
            hasher.update(&buffer[..size]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn json<T: serde::de::DeserializeOwned>(&mut self, expected: &str) -> Result<T> {
        if !hex(expected, 64) || self.metadata.len() > 65_536 || self.digest()? != expected {
            return Err(refused());
        }
        self.file.seek(SeekFrom::Start(0))?;
        let value = serde_json::from_reader((&mut self.file).take(65_537))?;
        self.unchanged(expected)?;
        Ok(value)
    }

    fn unchanged(&mut self, expected: &str) -> Result<()> {
        if !same(&self.metadata, &fs::symlink_metadata(&self.path)?)
            || !same(&self.metadata, &self.file.metadata()?)
            || self.digest()? != expected
        {
            return Err(refused());
        }
        Ok(())
    }
}

fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.is_file()
        && b.is_file()
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}

fn fact(path: &Path) -> Result<OutputFact> {
    let mut guard = Guard::open(path)?;
    let sha256 = guard.digest()?;
    guard.unchanged(&sha256)?;
    Ok(OutputFact {
        path: path.into(),
        sha256,
        bytes: guard.metadata.len(),
    })
}

fn refused() -> Box<dyn std::error::Error> {
    std::io::Error::other("Private copied-store inverse refused").into()
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    use std::{
        sync::Arc,
        task::{Context, Poll, Wake, Waker},
    };
    struct Current(std::thread::Thread);
    impl Wake for Current {
        fn wake(self: Arc<Self>) {
            self.0.unpark()
        }
    }
    let waker = Waker::from(Arc::new(Current(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}
