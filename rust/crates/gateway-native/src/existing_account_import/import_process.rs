//! Fixed request-owned import role preparation. Original proof/response remain
//! separate; bootstrap/config DATA never grants native mutation or completion.
use super::{
    ExistingAccountImportStore,
    actor_channel::{ActorBootstrap, InheritedCustodyChannel},
    import_endpoints::ImportEndpointData,
};
use crate::{
    daemon_config::NativeDaemonConfig, import_custody_protocol::unavailable,
    nonce_sqlite::SqliteNonceStore,
};
use gateway_auth::native_auth::NativeTransportIdentity;
use gateway_authority::native_control::{NativeRenewalCancellation, RegisteredRenewalOwner};
use gateway_core::GatewayError;
use std::{
    io::Read,
    net::{Shutdown, TcpStream},
    os::unix::fs::MetadataExt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) struct ActorCancellation {
    parent_dead: Arc<AtomicBool>,
    client: TcpStream,
    deadline: Instant,
}
impl NativeRenewalCancellation for ActorCancellation {
    fn cancelled(&self) -> bool {
        self.parent_dead.load(Ordering::Acquire)
            || Instant::now() >= self.deadline
            || crate::http_server::disconnected(&self.client)
    }
}
pub(super) struct PreparedImportActor {
    pub(super) client: TcpStream,
    pub(super) custody: InheritedCustodyChannel,
    pub(super) endpoints: ImportEndpointData,
    pub(super) identity: NativeTransportIdentity,
    pub(super) authority_identity: NativeTransportIdentity,
    pub(super) publication_identity: NativeTransportIdentity,
    pub(super) origin: String,
    pub(super) native_owner_id: String,
    pub(super) account_id_hash: String,
    pub(super) store: ExistingAccountImportStore,
    pub(super) nonces: SqliteNonceStore,
    pub(super) cancellation: ActorCancellation,
    pub(super) deadline: Instant,
}
impl PreparedImportActor {
    /// Fixed ActorBootstrap came from checked standard handles, not an accepted
    /// socket/config/PID constructor supplied by an HTTP caller.
    pub(super) fn from_stdio() -> Result<Self, GatewayError> {
        let mut boot = ActorBootstrap::from_stdio()?;
        let config = NativeDaemonConfig::read_import_stdin(boot.config.as_slice())?;
        let authority_config = NativeDaemonConfig::read_import_stdin(boot.config.as_slice())?;
        let publication_config = NativeDaemonConfig::read_import_stdin(boot.config.as_slice())?;
        boot.config.fill(0);
        let renewal = config.owner_renewal.as_ref().ok_or_else(unavailable)?;
        let owner = renewal
            .owners()
            .iter()
            .find(|owner| owner.owner_id() == boot.native_owner_id)
            .ok_or_else(unavailable)?;
        let metadata = std::fs::symlink_metadata(owner.codex_home()).map_err(|_| unavailable())?;
        if !metadata.is_dir()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.mode() & 0o077 != 0
        {
            return Err(unavailable());
        }
        let registered = RegisteredRenewalOwner::configured(
            owner.owner_id().into(),
            owner.codex_home().to_str().ok_or_else(unavailable)?.into(),
        )?;
        let store =
            ExistingAccountImportStore::configured(&registered, boot.account_id_hash.clone())?;
        let nonces = SqliteNonceStore::open(&config.nonce_database)?;
        let deadline = Instant::now() + Duration::from_secs(45);
        let parent_dead = Arc::new(AtomicBool::new(false));
        let cancellation = ActorCancellation {
            parent_dead: parent_dead.clone(),
            client: boot.client.try_clone().map_err(|_| unavailable())?,
            deadline,
        };
        let client_abort = boot.client.try_clone().map_err(|_| unavailable())?;
        let custody_abort = boot.custody.socket.try_clone().map_err(|_| unavailable())?;
        std::thread::spawn(move || {
            // Parent owns the sole writer after the two bounded frames. EOF or
            // any extra byte cancels; neither supplies a renewed request grant.
            let mut unexpected = [0u8; 1];
            let _ = std::io::stdin().lock().read(&mut unexpected);
            parent_dead.store(true, Ordering::Release);
            let _ = client_abort.shutdown(Shutdown::Both);
            let _ = custody_abort.shutdown(Shutdown::Both);
        });
        Ok(Self {
            client: boot.client,
            custody: boot.custody,
            endpoints: boot.endpoints,
            identity: config.identity,
            authority_identity: authority_config.identity,
            publication_identity: publication_config.identity,
            origin: renewal.authority_origin().into(),
            native_owner_id: boot.native_owner_id,
            account_id_hash: boot.account_id_hash,
            store,
            nonces,
            cancellation,
            deadline,
        })
    }
}

/// Ordinary executable always refuses fixture-enabled artifacts before stdin,
/// credentials, sockets or replay storage. The fixed test harness is separate.
pub fn run_native_import() -> ! {
    if crate::require_production_artifact().is_err() || !cfg!(target_os = "macos") {
        std::process::exit(78);
    }
    exit_actor()
}
#[cfg(feature = "native-import-fixture")]
pub fn run_native_import_fixture() -> ! {
    exit_actor()
}
fn exit_actor() -> ! {
    let code = if run_actor().is_ok() { 0 } else { 1 };
    // Stderr is the actual custody channel; never contaminate its frames with
    // diagnostics or include credential-bearing errors in process output.
    std::process::exit(code)
}
fn run_actor() -> Result<(), GatewayError> {
    if !cfg!(target_os = "macos") || std::env::args_os().count() != 1 {
        return Err(unavailable());
    }
    let actor = PreparedImportActor::from_stdio()?;
    let PreparedImportActor {
        mut client,
        custody,
        endpoints,
        identity,
        authority_identity,
        publication_identity,
        origin,
        native_owner_id,
        account_id_hash,
        store,
        nonces,
        cancellation,
        deadline,
    } = actor;
    let result = (|| {
        let head = crate::http_server::read_import_head(&mut client)?;
        let auth = head.auth_headers()?;
        let cancelled = || cancellation.cancelled();
        let original =
            crate::owner_control::NativeControlContext::admitted(deadline, &cancelled, auth);
        original.check()?;
        let connected = endpoints.connect(&cancellation, deadline)?;
        let authority = super::import_endpoints::fixed_authority_client(
            &origin,
            connected.authority,
            authority_identity,
            &cancellation,
            deadline,
        )?;
        let document = crate::import_ingress::read_remote_import(
            &mut client,
            &head,
            &identity,
            &nonces,
            &authority,
            &original,
            (&native_owner_id, &account_id_hash),
        )?;
        let context = crate::native_import::decode_context(
            &document.proof,
            &document.metadata,
            document.body(),
            &original,
        )?;
        let validation = super::validation::ImportValidation::from_connected(
            connected.models,
            Some(connected.oauth),
            context.auth_data().client_version(),
            super::import_endpoints::validation_roots(),
        )?;
        #[cfg(feature = "native-import-fixture")]
        let sender = super::import_publication::ImportPublicationHttp::from_fixture_connected(
            connected.publication,
            publication_identity,
        )?;
        #[cfg(not(feature = "native-import-fixture"))]
        let sender = {
            let target = url::Url::parse(&origin)
                .map_err(|_| unavailable())?
                .join(gateway_auth::native::NATIVE_PUBLICATION_PATH)
                .map_err(|_| unavailable())?;
            super::import_publication::ImportPublicationHttp::from_connected(
                target.as_str(),
                connected.publication,
                publication_identity,
            )?
        };
        let prepared = super::prepare_flow::PreparedExistingImport::prepare(
            &authority, &context, &store, custody, validation,
        )?;
        let verified = prepared.publish(&authority, &sender, &store, &context)?;
        let result = verified.source_result(&authority, &context)?;
        crate::import_ingress::write_result(&mut client, result)
    })();
    match result {
        Ok(()) => Ok(()),
        Err(error) => crate::http_server::write_error(&mut client, error),
    }
}
