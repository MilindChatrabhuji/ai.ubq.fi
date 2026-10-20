//! Existing source assembly shared by the prelaunch request worker and policy.
use crate::{
    confinement::NativeConfinement,
    daemon_config::PreparedNativeDaemonConfig,
    http_server::NativeHttpService,
    nonce_sqlite::SqliteNonceStore,
    supervisor::SourceId,
    supervisor_data::{SupervisorData, SupervisorSourceConfig},
};
use gateway_auth::GatewayError;
use std::path::PathBuf;
pub(crate) fn source_policy(
    config: &PreparedNativeDaemonConfig,
) -> Result<(SupervisorData, NativeConfinement), GatewayError> {
    let mut sources = Vec::new();
    let mut readonly_paths = Vec::new();
    let mut unix_sockets = Vec::new();
    let mut list_directories = Vec::new();
    for source in &config.sources {
        let socket = source.socket_path().to_owned();
        unix_sockets.push(socket.clone());
        if let Some(home) = source.codex_home() {
            if !home.is_dir() {
                sources.push(SupervisorSourceConfig::configured(
                    SourceId::parse(source.id())?,
                    source.name().into(),
                    socket,
                    source.codex_home().map(PathBuf::from),
                )?);
                continue;
            }
            let canonical_home = std::fs::canonicalize(home).map_err(|_| {
                gateway_auth::GatewayError::unavailable(
                    "Configured source home is unavailable",
                    "native_source_unavailable",
                )
            })?;
            list_directories.push(canonical_home.clone());
            for entry in std::fs::read_dir(home).map_err(|_| {
                gateway_auth::GatewayError::unavailable(
                    "Configured source directory is unavailable",
                    "native_source_unavailable",
                )
            })? {
                let entry = entry.map_err(|_| {
                    gateway_auth::GatewayError::unavailable(
                        "Configured source entry is unavailable",
                        "native_source_unavailable",
                    )
                })?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if matches!(name.as_ref(), "sessions" | "archived_sessions")
                    || name
                        .strip_prefix("state_")
                        .and_then(|name| name.strip_suffix(".sqlite"))
                        .is_some_and(|number| {
                            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
                        })
                {
                    let canonical = std::fs::canonicalize(entry.path()).map_err(|_| {
                        gateway_auth::GatewayError::unavailable(
                            "Configured source path is unavailable",
                            "native_source_unavailable",
                        )
                    })?;
                    if !canonical.starts_with(&canonical_home) {
                        return Err(gateway_auth::GatewayError::unavailable(
                            "Configured source path escapes its home",
                            "native_source_unavailable",
                        ));
                    }
                    readonly_paths.push(canonical);
                    for suffix in ["-wal", "-shm"] {
                        let companion =
                            PathBuf::from(format!("{}{suffix}", entry.path().display()));
                        if companion.is_file() {
                            readonly_paths.push(companion);
                        }
                    }
                }
            }
        }
        sources.push(SupervisorSourceConfig::configured(
            SourceId::parse(source.id())?,
            source.name().into(),
            socket,
            source.codex_home().map(PathBuf::from),
        )?);
    }
    let hostname = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty());
    let data = SupervisorData::configured(sources)?.with_metadata(hostname, Vec::new());
    let replay_directory = config
        .nonce_database
        .parent()
        .ok_or_else(unavailable)?
        .to_owned();
    Ok((
        data,
        NativeConfinement {
            readonly_paths,
            list_directories,
            replay_directory,
            unix_sockets,
        },
    ))
}
pub(crate) fn request_service(
    config: PreparedNativeDaemonConfig,
) -> Result<NativeHttpService, GatewayError> {
    if config.owner_renewal.is_some() {
        return Err(unavailable());
    }
    let (data, _) = source_policy(&config)?;
    let nonces = SqliteNonceStore::open(&config.nonce_database)?;
    Ok(NativeHttpService::configured(config.identity, nonces, data))
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Private native request startup unavailable",
        "native_request_unavailable",
    )
}
