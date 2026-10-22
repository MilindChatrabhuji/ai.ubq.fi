//! Owned-process custody only. Dirty state never becomes another import start permit.
use super::{
    ExclusiveManagedOwner,
    exclusive_owner::{Facts, PinnedExecutable, fail},
};
use crate::native_import::NativeImportContext;
use gateway_authority::native_control::import::{
    AuthenticatedNativeImport, NativeImportBinding, NativeImportStart,
};
use gateway_authority::{
    TokenSource,
    native_control::{NativeRenewalAuthority, NativeRenewalCancellation},
};
use gateway_core::GatewayError;
use gateway_core::state::AuthorityStore;
use rustix::fs::{AtFlags, FlockOperation, Mode, OFlags, flock, fsync, openat, renameat, statat};
use serde::{Deserialize, Serialize};
#[cfg(all(test, target_os = "macos"))]
use std::process::{Command, Stdio};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
    process::Child,
    time::{Duration, Instant},
};
const EPOCH: &str = ".uos-owner-runtime";
const EPOCH_TEMP: &str = ".uos-owner-runtime.next";
const EPOCH_LIMIT: u64 = 2048;
#[cfg(all(test, target_os = "macos"))]
const SANDBOX_SHA256S: [&str; 2] = [
    "e3d7a792c58a5d3783d2f7274c82d70062393830d8cb1ded713ca554a470bd2f",
    "abc5bb136d6b5cce8fa85d789f78e3326c51ca60cae637b2064adfb67a1dcd9a",
];
#[cfg(all(test, target_os = "macos"))]
fn fixture_sandbox_executable() -> Result<PinnedExecutable, GatewayError> {
    SANDBOX_SHA256S
        .iter()
        .find_map(|digest| {
            PinnedExecutable::verify(Path::new("/usr/bin/sandbox-exec"), digest).ok()
        })
        .filter(|binary| binary.facts.uid == 0)
        .ok_or_else(fail)
}
const CODEX_SHA: &str = "8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Epoch {
    v: u8,
    native_owner_id: String,
    account_id_hash: String,
    root_device: u64,
    root_inode: u64,
    boot: String,
    phase: Phase,
}
#[derive(Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Running,
    Stopping,
    Stopped,
}
/// Actual private process custody; a JSON marker/available flock does not mint stopped-child proof.
pub struct OwnedRuntime {
    owner: ExclusiveManagedOwner,
    lock: File,
    epoch: Option<Epoch>,
    child: Option<Child>,
    settled: bool,
}
/// An original-start-bound settled OWNED writer. No mutation API is exposed by this foundation.
/// Bootstrap exclusivity/full credential importer/publication remain separate acceptance.
/// ```compile_fail
/// use gateway_native::existing_account_import::ExclusiveOwnerLease;
/// let forged: ExclusiveOwnerLease<'_> = serde_json::from_str("{}").unwrap();
/// ```
pub struct ExclusiveOwnerLease<'a> {
    runtime: &'a mut OwnedRuntime,
    binding: NativeImportBinding,
    original: &'a AuthenticatedNativeImport,
}
impl ExclusiveOwnerLease<'_> {
    pub fn binding(&self) -> &NativeImportBinding {
        &self.binding
    }
    pub async fn recheck<S: AuthorityStore, I: TokenSource, C: NativeRenewalCancellation>(
        &self,
        authority: &NativeRenewalAuthority<'_, S, I, C>,
        original_body: &[u8],
        context: &NativeImportContext<'_>,
        deadline: Instant,
    ) -> Result<(), GatewayError> {
        context.check_document(self.original, self.original.metadata(), original_body)?;
        context.check_current(authority).await?;
        self.original
            .require_body(original_body, authority.now_ms()?)?;
        if !self.runtime.settled || self.runtime.child.is_some() {
            return Err(fail());
        }
        self.runtime.owner.recheck(deadline)?;
        self.runtime.check_epoch(Phase::Stopped)?;
        self.runtime.check_generation(&self.binding)?;
        context.check_current(authority).await?;
        context.check_document(self.original, self.original.metadata(), original_body)
    }
}
impl OwnedRuntime {
    pub(super) fn prepare(owner: ExclusiveManagedOwner) -> Result<Self, GatewayError> {
        // Readonly preparation. Initial empty/missing runtime history establishes NO daemon absence.
        let directory = owner.directory()?;
        let existing = read_epoch(directory)?;
        if existing.as_ref().is_some_and(|e| e.phase != Phase::Stopped) {
            return Err(fail());
        }
        let lock = File::from(
            openat(
                directory,
                ".uos-owner.lock",
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        let facts = Facts::read(&lock)?;
        if facts.uid != owner.writer_uid
            || facts.mode & 0o170000 != 0o100000
            || facts.mode & 0o077 != 0
            || facts.links != 1
        {
            return Err(fail());
        }
        let auth = File::from(
            openat(
                directory,
                "auth.json",
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        let auth_facts = Facts::read(&auth)?;
        if auth_facts.uid != owner.writer_uid
            || auth_facts.mode & 0o170000 != 0o100000
            || auth_facts.mode & 0o077 != 0
            || auth_facts.links != 1
        {
            return Err(fail());
        }
        // A PREPARED stable lock inode coordinates trusted actors; auth.json is replaced by import.
        // Missing pre-existing lock/custody is unavailable, never created before the original start.
        flock(&lock, FlockOperation::NonBlockingLockExclusive).map_err(|_| fail())?;
        let this = Self {
            owner,
            lock,
            epoch: existing,
            child: None,
            settled: false,
        };
        if let Some(epoch) = &this.epoch {
            this.match_epoch(epoch)?;
        }
        Ok(this)
    }
    fn match_epoch(&self, epoch: &Epoch) -> Result<(), GatewayError> {
        let facts = Facts::read(self.owner.directory()?)?;
        if epoch.v != 1
            || epoch.native_owner_id != self.owner.native_owner_id
            || epoch.account_id_hash != self.owner.account_id_hash
            || epoch.root_device != facts.device
            || epoch.root_inode != facts.inode
            || !gateway_auth::provider_credentials::valid_native_generation(&epoch.boot)
        {
            return Err(fail());
        }
        Ok(())
    }
    fn check_epoch(&self, phase: Phase) -> Result<(), GatewayError> {
        let pinned = rustix::fs::fstat(&self.lock).map_err(|_| fail())?;
        let current = statat(
            self.owner.directory()?,
            ".uos-owner.lock",
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|_| fail())?;
        if pinned.st_dev != current.st_dev
            || pinned.st_ino != current.st_ino
            || pinned.st_mode != current.st_mode
            || pinned.st_uid != current.st_uid
        {
            return Err(fail());
        }
        let epoch = read_epoch(self.owner.directory()?)?.ok_or_else(fail)?;
        self.match_epoch(&epoch)?;
        if epoch.phase != phase || self.epoch.as_ref().is_none_or(|e| e.boot != epoch.boot) {
            return Err(fail());
        }
        Ok(())
    }
    fn write_epoch(&mut self, phase: Phase) -> Result<(), GatewayError> {
        let directory = self.owner.directory()?;
        let epoch = self.epoch.as_mut().ok_or_else(fail)?;
        epoch.phase = phase;
        let bytes = serde_json::to_vec(epoch).map_err(|_| fail())?;
        if bytes.len() as u64 > EPOCH_LIMIT {
            return Err(fail());
        }
        let mut file = File::from(
            openat(
                directory,
                EPOCH_TEMP,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|_| fail())?,
        );
        file.write_all(&bytes).map_err(|_| fail())?;
        file.sync_all().map_err(|_| fail())?;
        renameat(directory, EPOCH_TEMP, directory, EPOCH).map_err(|_| fail())?;
        fsync(directory).map_err(|_| fail())?;
        self.check_epoch(phase)
    }
    /// A prepared root with unknown preexisting daemon custody cannot be promoted by this method.
    /// Actual bootstrap/owned launcher must establish its private initial custody before production use.
    pub fn launch_codex(
        &mut self,
        executable: &Path,
        deadline: Instant,
    ) -> Result<(), GatewayError> {
        let binary = PinnedExecutable::verify(executable, CODEX_SHA)?;
        self.owner.recheck(deadline)?;
        // No operator/bootstrap ownership port exists yet. A marker or process census is not that port.
        let _ = binary;
        Err(fail())
    }
    #[cfg(all(test, target_os = "macos"))]
    fn spawn_owned(
        &mut self,
        executable: &PinnedExecutable,
        arguments: &[&str],
        profile: &str,
        deadline: Instant,
    ) -> Result<(), GatewayError> {
        if self.child.is_some() || self.epoch.is_some() || Instant::now() >= deadline {
            return Err(fail());
        }
        self.owner.recheck(deadline)?;
        let sandbox = fixture_sandbox_executable()?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| fail())?;
        let root = Facts::read(self.owner.directory()?)?;
        self.epoch = Some(Epoch {
            v: 1,
            native_owner_id: self.owner.native_owner_id.clone(),
            account_id_hash: self.owner.account_id_hash.clone(),
            root_device: root.device,
            root_inode: root.inode,
            boot: gateway_auth::crypto::sha256_hex(&random),
            phase: Phase::Running,
        });
        // Dirty BEFORE spawn; even failed spawn/reap cannot silently create a clean restart.
        self.write_epoch(Phase::Running)?;
        executable.recheck()?;
        sandbox.recheck()?;
        let errors = File::from(
            openat(
                self.owner.directory()?,
                ".uos-owner-fixture.stderr",
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::RUSR | Mode::WUSR,
            )
            .map_err(|_| fail())?,
        );
        self.child = Some(
            Command::new(sandbox.path())
                .args(["-p", profile])
                .arg(executable.path())
                .args(arguments)
                .env_clear()
                .env("LC_ALL", "C")
                .env("LANG", "C")
                .env("TZ", "UTC")
                .env("UOS_NATIVE_OWNER_TEST_DIRECTORY", &self.owner.home)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::from(errors))
                .spawn()
                .map_err(|_| fail())?,
        );
        self.settled = false;
        Ok(())
    }
    fn stop_kernel(&mut self, deadline: Instant) -> Result<(), GatewayError> {
        self.check_epoch(Phase::Running)?;
        // Dirty intent is durable before any possible kill; uncertainty cannot reopen custody.
        self.write_epoch(Phase::Stopping)?;
        let child = self.child.as_mut().ok_or_else(fail)?;
        if child.try_wait().map_err(|_| fail())?.is_none() {
            child.kill().map_err(|_| fail())?;
        }
        loop {
            if child.try_wait().map_err(|_| fail())?.is_some() {
                break;
            }
            if Instant::now() >= deadline {
                return Err(fail());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        // The actual retained Child was reaped, not an arbitrary PID or socket closed.
        self.child.take();
        self.owner.recheck(deadline)?;
        fsync(self.owner.directory()?).map_err(|_| fail())?;
        self.write_epoch(Phase::Stopped)?;
        self.settled = true;
        Ok(())
    }
    fn stop_owned(&mut self, deadline: Instant) -> Result<(), GatewayError> {
        self.stop_kernel(deadline)?;
        let auth = File::from(
            openat(
                self.owner.directory()?,
                "auth.json",
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        let facts = Facts::read(&auth)?;
        if facts.uid != self.owner.writer_uid
            || facts.mode & 0o170000 != 0o100000
            || facts.links != 1
        {
            return Err(fail());
        }
        Ok(())
    }
    pub async fn settle_for_import<
        'a,
        S: AuthorityStore,
        I: TokenSource,
        C: NativeRenewalCancellation,
    >(
        &'a mut self,
        authority: &NativeRenewalAuthority<'_, S, I, C>,
        start: NativeImportStart<'a>,
        proof: &'a AuthenticatedNativeImport,
        body: &[u8],
        context: &NativeImportContext<'_>,
        deadline: Instant,
    ) -> Result<ExclusiveOwnerLease<'a>, GatewayError> {
        context.check_document(proof, proof.metadata(), body)?;
        context.check_current(authority).await?;
        start.require_body(body, authority.now_ms()?)?;
        if proof.metadata().operation_id != start.binding().operation_id
            || proof.metadata().action_ref != start.binding().action_ref
            || self.owner.native_owner_id != start.binding().native_owner_id
            || self.owner.account_id_hash != start.binding().account_id_hash
        {
            return Err(fail());
        }
        context.check_document(proof, proof.metadata(), body)?;
        self.stop_owned(deadline)?;
        self.check_generation(start.binding())?;
        context.check_current(authority).await?;
        context.check_document(proof, proof.metadata(), body)?;
        Ok(ExclusiveOwnerLease {
            runtime: self,
            binding: start.binding().clone(),
            original: proof,
        })
    }
    fn check_generation(&self, binding: &NativeImportBinding) -> Result<(), GatewayError> {
        let file = File::from(
            openat(
                self.owner.directory()?,
                "auth.json",
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        let before = Facts::read(&file)?;
        if before.mode & 0o170000 != 0o100000
            || before.uid != self.owner.writer_uid
            || before.links != 1
            || before.size > 1_048_576
        {
            return Err(fail());
        }
        let mut bytes = Vec::new();
        file.try_clone()
            .map_err(|_| fail())?
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|_| fail())?;
        if bytes.len() > 1_048_576 || Facts::read(&file)? != before {
            return Err(fail());
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| fail())?;
        let credentials = gateway_auth::native_credentials::parse_native_document(&value)?;
        if credentials.routing_account_hash() != binding.account_id_hash
            || credentials.generation_hash() != binding.source_native_generation
            || credentials.external_user_id.is_some()
        {
            return Err(fail());
        }
        Ok(())
    }
    // Kernel/actual-Child adapter only. These methods never read credential bytes or generations.
    pub(super) fn require_owned_child(&self) -> Result<(), GatewayError> {
        if self.settled || self.child.is_none() {
            return Err(fail());
        }
        self.check_epoch(Phase::Running)
    }
    pub(super) fn custody_stop(&mut self, deadline: Instant) -> Result<(), GatewayError> {
        self.require_owned_child()?;
        self.stop_kernel(deadline)
    }
    pub(super) fn custody_snapshot(
        &self,
        deadline: Instant,
    ) -> Result<super::custodian_runtime::KernelSnapshot, GatewayError> {
        if !self.settled || self.child.is_some() {
            return Err(fail());
        }
        self.owner.recheck(deadline)?;
        self.check_epoch(Phase::Stopped)?;
        let epoch = self.epoch.as_ref().ok_or_else(fail)?;
        Ok(super::custodian_runtime::KernelSnapshot {
            epoch: epoch.boot.clone(),
            root_device: epoch.root_device,
            root_inode: epoch.root_inode,
        })
    }
    pub(super) fn custody_registry(&self) -> Result<(&str, &str, &Path), GatewayError> {
        self.require_owned_child()?;
        Ok((
            &self.owner.native_owner_id,
            &self.owner.account_id_hash,
            &self.owner.home,
        ))
    }
    pub(super) fn matches_custody_owner(&self, owner: &str, account: &str) -> bool {
        self.owner.native_owner_id == owner && self.owner.account_id_hash == account
    }
    /// Runtime history is an observation; stopped disk DATA without this live Child never issues a lease.
    pub fn has_settled_owned_writer(&self) -> bool {
        self.settled && self.child.is_none()
    }
    #[cfg(all(test, target_os = "macos"))]
    pub(super) fn spawn_fixture(
        &mut self,
        executable: &Path,
        digest: &str,
        arguments: &[&str],
        profile: &str,
        deadline: Instant,
    ) -> Result<(), GatewayError> {
        let executable = PinnedExecutable::verify(executable, digest)?;
        self.spawn_owned(&executable, arguments, profile, deadline)
    }
}
impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        // Drop cannot classify cancellation as stopped or erase the dirty marker. Best-effort
        // cleanup only touches the actual retained owned Child; no replacement/start/rollback.
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = &self.lock;
    }
}
fn read_epoch(directory: &File) -> Result<Option<Epoch>, GatewayError> {
    match statat(directory, EPOCH, AtFlags::SYMLINK_NOFOLLOW) {
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(fail()),
        Ok(_) => (),
    }
    let file = File::from(
        openat(
            directory,
            EPOCH,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|_| fail())?,
    );
    let facts = Facts::read(&file)?;
    if facts.mode & 0o170000 != 0o100000
        || facts.mode & 0o077 != 0
        || facts.links != 1
        || facts.size > EPOCH_LIMIT
        || facts.uid != Facts::read(directory)?.uid
    {
        return Err(fail());
    }
    let mut bytes = Vec::new();
    file.take(EPOCH_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail())?;
    if bytes.len() as u64 > EPOCH_LIMIT {
        return Err(fail());
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| fail())
}

#[cfg(all(test, target_os = "macos"))]
pub(super) fn fixture_stop(
    runtime: &mut OwnedRuntime,
    deadline: Instant,
) -> Result<(), GatewayError> {
    runtime.stop_owned(deadline)
}

#[cfg(all(test, target_os = "macos"))]
#[test]
fn fixture_sandbox_keeps_two_exact_identities_and_full_fixed_executable_verification() {
    assert_eq!(
        SANDBOX_SHA256S,
        [
            "e3d7a792c58a5d3783d2f7274c82d70062393830d8cb1ded713ca554a470bd2f",
            "abc5bb136d6b5cce8fa85d789f78e3326c51ca60cae637b2064adfb67a1dcd9a",
        ]
    );
    for approved in SANDBOX_SHA256S {
        let replacement = if approved.ends_with('0') { '1' } else { '0' };
        let modified = format!("{}{replacement}", &approved[..63]);
        assert_ne!(approved, modified);
        assert!(!SANDBOX_SHA256S.contains(&modified.as_str()));
    }
    assert!(!SANDBOX_SHA256S.contains(&"0".repeat(64).as_str()));
    let binary = fixture_sandbox_executable().unwrap();
    assert_eq!(binary.path(), Path::new("/usr/bin/sandbox-exec"));
    assert_eq!(binary.facts.uid, 0);
    binary.recheck().unwrap();
    assert!(PinnedExecutable::verify(Path::new("/usr/bin/sandbox-exec"), &"0".repeat(64)).is_err());
}
