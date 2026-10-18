#[cfg(unix)]
fn main() {
    if let Err(error) = run() {
        eprintln!(
            "[uos-native] {}",
            error
                .envelope
                .error
                .code
                .as_deref()
                .unwrap_or("native_startup_failed")
        );
        std::process::exit(1);
    }
}
#[cfg(not(unix))]
fn main() {
    eprintln!("[uos-native] native_confinement_unavailable");
    std::process::exit(1);
}

#[cfg(unix)]
fn run() -> Result<(), gateway_auth::GatewayError> {
    use gateway_native::{
        confinement::{NativeConfinement, enforce},
        daemon_config::NativeDaemonConfig,
        http_server::NativeHttpService,
        nonce_sqlite::SqliteNonceStore,
        supervisor::SourceId,
        supervisor_data::{SupervisorData, SupervisorSourceConfig},
    };
    use std::{net::TcpListener, path::PathBuf};
    let config = NativeDaemonConfig::read_stdin(std::io::stdin().lock())?;
    let replay_directory = config
        .nonce_database
        .parent()
        .ok_or_else(|| {
            gateway_auth::GatewayError::unavailable(
                "Replay database has no parent",
                "native_nonce_store_unavailable",
            )
        })?
        .to_owned();
    let database_name = config
        .nonce_database
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            gateway_auth::GatewayError::unavailable(
                "Replay database name is invalid",
                "native_nonce_store_unavailable",
            )
        })?;
    let allowed = [
        database_name.to_owned(),
        format!("{database_name}-wal"),
        format!("{database_name}-shm"),
    ];
    for entry in std::fs::read_dir(&replay_directory).map_err(|_| {
        gateway_auth::GatewayError::unavailable(
            "Private replay directory is unavailable",
            "native_nonce_store_unavailable",
        )
    })? {
        let entry = entry.map_err(|_| {
            gateway_auth::GatewayError::unavailable(
                "Private replay directory is unavailable",
                "native_nonce_store_unavailable",
            )
        })?;
        if !allowed
            .iter()
            .any(|name| entry.file_name() == std::ffi::OsStr::new(name))
        {
            return Err(gateway_auth::GatewayError::unavailable(
                "Replay storage must have a dedicated directory",
                "native_nonce_store_unavailable",
            ));
        }
    }
    let listener = TcpListener::bind(config.listen).map_err(|_| {
        gateway_auth::GatewayError::unavailable(
            "Native listener could not bind",
            "native_listener_unavailable",
        )
    })?;
    let address = listener.local_addr().map_err(|_| {
        gateway_auth::GatewayError::unavailable(
            "Native listener has no address",
            "native_listener_unavailable",
        )
    })?;
    let nonces = SqliteNonceStore::open(&config.nonce_database)?;
    let mut sources = Vec::new();
    let mut readonly_paths = Vec::new();
    let mut unix_sockets = Vec::new();
    let mut list_directories = Vec::new();
    for source in config.sources {
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
    enforce(&NativeConfinement {
        readonly_paths,
        list_directories,
        replay_directory,
        unix_sockets,
    })?;
    println!(
        "{}",
        serde_json::json!({"event":"native_listener_ready","v":1,"address":address.to_string()})
    );
    NativeHttpService::configured(config.identity, nonces, data).serve(listener)
}
