//! Kernel facts are observations, never permission reconstructed from JSON or caller booleans.
use super::{ExistingAccountImportStore, acl_inspector, owner_runtime};
use gateway_auth::crypto::sha256_hex;
use gateway_authority::native_control::RegisteredRenewalOwner;
use gateway_core::GatewayError;
use rustix::fs::{AtFlags, Mode, OFlags, fstat, openat, statat};
use std::{
    fs::File,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Facts {
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub links: u64,
    pub size: u64,
    pub ctime: i64,
    pub ctime_nsec: i64,
}
impl Facts {
    pub(super) fn same_object(&self, other: &Self) -> bool {
        self.device == other.device
            && self.inode == other.inode
            && self.uid == other.uid
            && self.gid == other.gid
            && self.mode == other.mode
    }
    pub(super) fn read(file: &File) -> Result<Self, GatewayError> {
        let m = file.metadata().map_err(|_| fail())?;
        Ok(Self {
            device: m.dev(),
            inode: m.ino(),
            uid: m.uid(),
            gid: m.gid(),
            mode: m.mode(),
            links: m.nlink(),
            size: m.size(),
            ctime: m.ctime(),
            ctime_nsec: m.ctime_nsec(),
        })
    }
}
/// Hash plus descriptor metadata; no caller can turn a digest into a live kernel lease.
pub(super) struct PinnedExecutable {
    file: File,
    path: PathBuf,
    pub facts: Facts,
    digest: String,
}
impl PinnedExecutable {
    pub(super) fn verify(path: &Path, digest: &str) -> Result<Self, GatewayError> {
        if !path.is_absolute()
            || !gateway_auth::provider_credentials::valid_native_generation(digest)
        {
            return Err(fail());
        }
        let file = File::from(
            openat(
                rustix::fs::CWD,
                path,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        let facts = Facts::read(&file)?;
        if facts.mode & 0o170000 != 0o100000
            || facts.mode & 0o022 != 0
            || facts.links != 1
            || facts.size > 300_000_000
        {
            return Err(fail());
        }
        // Seatbelt literals match resolved kernel paths, not the /tmp alias spelling.
        // The original final component was already opened NOFOLLOW; inode/hash must match again.
        let canonical = std::fs::canonicalize(path).map_err(|_| fail())?;
        let this = Self {
            file,
            path: canonical,
            facts,
            digest: digest.into(),
        };
        this.recheck()?;
        Ok(this)
    }
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
    pub(super) fn recheck(&self) -> Result<(), GatewayError> {
        let reopened = File::from(
            openat(
                rustix::fs::CWD,
                &self.path,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        if Facts::read(&self.file)? != self.facts || Facts::read(&reopened)? != self.facts {
            return Err(fail());
        }
        let mut bytes = Vec::new();
        reopened
            .take(self.facts.size + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| fail())?;
        if bytes.len() as u64 != self.facts.size || sha256_hex(&bytes) != self.digest {
            return Err(fail());
        }
        Ok(())
    }
}
struct Anchor {
    directory: File,
    facts: Facts,
    component: Option<std::ffi::OsString>,
}
/// Verified kernel custody, NOT permission to mutate. No public constructor/serde/Clone/Debug.
/// ```compile_fail
/// use gateway_native::existing_account_import::ExclusiveManagedOwner;
/// let forged: ExclusiveManagedOwner = serde_json::from_str("{}").unwrap();
/// ```
pub struct ExclusiveManagedOwner {
    anchors: Vec<Anchor>,
    pub(super) inspector: PinnedExecutable,
    pub(super) home: PathBuf,
    pub(super) writer_uid: u32,
    pub(super) native_owner_id: String,
    pub(super) account_id_hash: String,
}
impl ExclusiveManagedOwner {
    pub(super) fn prepare(
        store: &ExistingAccountImportStore,
        registered: &RegisteredRenewalOwner,
        writer: u32,
        clients: &[u32],
        inspector: &Path,
        digest: &str,
        deadline: Instant,
    ) -> Result<Self, GatewayError> {
        let uid = rustix::process::getuid();
        let effective = rustix::process::geteuid();
        if uid.is_root()
            || uid != effective
            || uid.as_raw() != writer
            || clients.is_empty()
            || clients
                .iter()
                .any(|client| *client == 0 || *client == writer)
            || registered.native_owner_id() != store.native_owner_id
            || Path::new(registered.registered_home()) != store.home
        {
            return Err(fail());
        }
        let inspector = PinnedExecutable::verify(inspector, digest)?;
        let mut anchors = Vec::new();
        let root = File::from(
            openat(
                rustix::fs::CWD,
                "/",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        let facts = Facts::read(&root)?;
        anchors.push(Anchor {
            directory: root,
            facts,
            component: None,
        });
        for component in store.home.components() {
            let Component::Normal(name) = component else {
                if matches!(component, Component::RootDir) {
                    continue;
                }
                return Err(fail());
            };
            let previous = anchors.last().ok_or_else(fail)?;
            let directory = File::from(
                openat(
                    &previous.directory,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| fail())?,
            );
            let facts = Facts::read(&directory)?;
            anchors.push(Anchor {
                directory,
                facts,
                component: Some(name.into()),
            });
        }
        let this = Self {
            anchors,
            inspector,
            home: store.home.clone(),
            writer_uid: writer,
            native_owner_id: store.native_owner_id.clone(),
            account_id_hash: store.account_id_hash.clone(),
        };
        this.recheck(deadline)?;
        let leaf = this.anchors.last().ok_or_else(fail)?;
        if leaf.facts.uid != writer
            || leaf.facts.mode & 0o777 != 0o700
            || !Facts::read(&store.directory)?.same_object(&leaf.facts)
        {
            return Err(fail());
        }
        Ok(this)
    }
    pub fn recheck(&self, deadline: Instant) -> Result<(), GatewayError> {
        for (index, anchor) in self.anchors.iter().enumerate() {
            if Instant::now() >= deadline
                || !Facts::read(&anchor.directory)?.same_object(&anchor.facts)
                || anchor.facts.mode & 0o170000 != 0o040000
                || ![0, self.writer_uid].contains(&anchor.facts.uid)
            {
                return Err(fail());
            }
            // A common root-owned sticky directory protects an owner-owned child from OTHER UIDs.
            // This never claims protection from another process with our own writer UID.
            if anchor.facts.mode & 0o022 != 0
                && !(anchor.facts.uid == 0 && anchor.facts.mode & 0o1000 != 0)
            {
                return Err(fail());
            }
            if let Some(name) = &anchor.component {
                let parent = &self.anchors[index - 1];
                let current = statat(&parent.directory, name, AtFlags::SYMLINK_NOFOLLOW)
                    .map_err(|_| fail())?;
                let pinned = fstat(&anchor.directory).map_err(|_| fail())?;
                if current.st_dev != pinned.st_dev
                    || current.st_ino != pinned.st_ino
                    || current.st_mode != pinned.st_mode
                    || current.st_uid != pinned.st_uid
                {
                    return Err(fail());
                }
            }
            acl_inspector::observe(&anchor.directory, &self.inspector, deadline)?;
        }
        let root_now = File::from(
            openat(
                rustix::fs::CWD,
                &self.home,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| fail())?,
        );
        if !Facts::read(&root_now)?.same_object(&self.anchors.last().ok_or_else(fail)?.facts) {
            return Err(fail());
        }
        self.inspector.recheck()
    }
    pub fn native_owner_id(&self) -> &str {
        &self.native_owner_id
    }
    pub fn account_id_hash(&self) -> &str {
        &self.account_id_hash
    }
    pub(super) fn directory(&self) -> Result<&File, GatewayError> {
        Ok(&self.anchors.last().ok_or_else(fail)?.directory)
    }
    pub fn prepare_runtime(self) -> Result<owner_runtime::OwnedRuntime, GatewayError> {
        owner_runtime::OwnedRuntime::prepare(self)
    }
}
pub(super) fn fail() -> GatewayError {
    GatewayError::unavailable(
        "Exclusive native owner custody is unavailable or changed",
        "native_import_owner_exclusion_unavailable",
    )
}
