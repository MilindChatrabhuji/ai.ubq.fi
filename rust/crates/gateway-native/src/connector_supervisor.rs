//! Trusted prelaunch authority. Owns child handles, never ancillary/provider I/O.
use crate::{
    connector_policy, connector_protocol::ControlError, daemon_config::NativeDaemonConfig,
    http_server, nonce_sqlite::SqliteNonceStore,
};
use gateway_auth::{GatewayError, crypto::sha256_hex};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::PathBuf,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Duration,
};

pub fn run_native_supervisor() -> ! {
    if crate::require_production_artifact().is_err() {
        std::process::exit(ControlError::UnsupportedPlatform.exit_code());
    }
    let code = match run() {
        Ok(()) => 0,
        Err(error) => error.exit_code(),
    };
    std::process::exit(code)
}
fn run() -> Result<(), ControlError> {
    if !cfg!(target_os = "macos") {
        return Err(ControlError::UnsupportedPlatform);
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    let config =
        NativeDaemonConfig::read_stdin(bytes.as_slice()).map_err(|_| ControlError::InvalidFrame)?;
    if config.owner_renewal.is_some() {
        return Err(ControlError::UnsupportedPlatform);
    }
    let (_, capabilities) =
        crate::daemon_startup::source_policy(&config).map_err(|_| ControlError::InvalidFrame)?;
    // Preserve the dedicated replay-directory invariant before any child starts.
    let name = config
        .nonce_database
        .file_name()
        .ok_or(ControlError::InvalidFrame)?
        .to_string_lossy();
    for item in fs::read_dir(&capabilities.replay_directory).map_err(io_error)? {
        let item = item.map_err(io_error)?;
        if ![
            name.to_string(),
            format!("{name}-wal"),
            format!("{name}-shm"),
        ]
        .iter()
        .any(|n| item.file_name() == std::ffi::OsStr::new(n))
        {
            return Err(ControlError::InvalidFrame);
        }
    }
    drop(SqliteNonceStore::open(&config.nonce_database).map_err(|_| ControlError::InvalidFrame)?);
    let directory = std::env::current_exe()
        .map_err(io_error)?
        .parent()
        .ok_or(ControlError::InvalidFrame)?
        .to_owned();
    let request = Binary::read(directory.join("uos-native-request"))?;
    let connector = Binary::read(directory.join("uos-native-connector"))?;
    let connector_profile = connector_policy::connector(&connector.path)?;
    let listener = TcpListener::bind(config.listen).map_err(io_error)?;
    println!(
        "{}",
        serde_json::json!({"event":"native_listener_ready","v":1,"address":listener.local_addr().map_err(io_error)?.to_string()})
    );
    let active = Arc::new(AtomicUsize::new(0));
    let bytes = Arc::new(bytes);
    for stream in listener.incoming() {
        let mut stream = stream.map_err(io_error)?;
        if active.fetch_add(1, Ordering::AcqRel) >= 64 {
            active.fetch_sub(1, Ordering::AcqRel);
            let _ = http_server::write_error(
                &mut stream,
                GatewayError::unavailable(
                    "Native listener is at capacity",
                    "native_listener_capacity",
                ),
            );
            continue;
        }
        let policy = connector_policy::request(
            &request.path,
            &capabilities,
            stream.local_addr().map_err(io_error)?,
            stream.peer_addr().map_err(io_error)?,
        )?;
        let mut children = launch(
            stream,
            &bytes,
            &request,
            &connector,
            &policy,
            &connector_profile,
            config
                .live_sideband
                .as_ref()
                .map(preconnect_live_authority)
                .transpose()?,
        )?;
        let request_pid = children.request.as_ref().ok_or(ControlError::Closed)?.id();
        let connector_pid = children
            .connector
            .as_ref()
            .ok_or(ControlError::Closed)?
            .id();
        println!(
            "{}",
            serde_json::json!({"event":"native_request_process_started","request_pid":request_pid,"connector_pid":connector_pid,"request_executable_sha256":request.hash,"connector_executable_sha256":connector.hash,"request_profile_sha256":sha256_hex(policy.as_bytes()),"connector_profile_sha256":sha256_hex(connector_profile.as_bytes())})
        );
        let active = active.clone();
        thread::spawn(move || {
            let result = children.wait();
            println!(
                "{}",
                serde_json::json!({"event":"native_request_process_settled","request_pid":request_pid,"connector_pid":connector_pid,"code":result.ok().and_then(|s| s.code())})
            );
            active.fetch_sub(1, Ordering::AcqRel);
        });
    }
    Ok(())
}
struct Binary {
    path: PathBuf,
    hash: String,
}
impl Binary {
    fn read(path: PathBuf) -> Result<Self, ControlError> {
        let path = fs::canonicalize(path).map_err(io_error)?;
        let hash = sha256_hex(&fs::read(&path).map_err(io_error)?);
        Ok(Self { path, hash })
    }
    fn command(&self, profile: &str) -> Result<Command, ControlError> {
        if sha256_hex(&fs::read(&self.path).map_err(io_error)?) != self.hash {
            return Err(ControlError::InvalidFrame);
        }
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .args(["-p", profile])
            .arg(&self.path)
            .env_clear()
            .current_dir(self.path.parent().ok_or(ControlError::InvalidFrame)?);
        Ok(command)
    }
}
fn launch(
    client: TcpStream,
    bytes: &[u8],
    request: &Binary,
    connector: &Binary,
    main_profile: &str,
    connector_profile: &str,
    reverse: Option<TcpStream>,
) -> Result<RequestChildren, ControlError> {
    // Accept can inherit nonblocking state on Darwin. The owned client enters
    // the existing timed HTTP parser in blocking mode, verified before spawn.
    client.set_nonblocking(false).map_err(io_error)?;
    let flags = rustix::fs::fcntl_getfl(&client).map_err(|error| io_error(error.into()))?;
    if flags.contains(rustix::fs::OFlags::NONBLOCK) {
        return Err(ControlError::InvalidDescriptor);
    }
    let (main_control, dial_control) = UnixStream::pair().map_err(io_error)?;
    let mut dial_command = connector.command(connector_profile)?;
    let dial_fd: OwnedFd = dial_control.into();
    let dial = dial_command
        .stdin(Stdio::from(dial_fd))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(io_error)?;
    let mut children = RequestChildren {
        request: None,
        connector: Some(dial),
        input: None,
    };
    let main_fd: OwnedFd = main_control.into();
    let client_fd: OwnedFd = client.into();
    let mut command = request.command(main_profile)?;
    let (bootstrap, child_input) = if reverse.is_some() {
        let (parent, child) = UnixStream::pair().map_err(io_error)?;
        parent
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(io_error)?;
        let child: OwnedFd = child.into();
        (Some(parent), Stdio::from(child))
    } else {
        (None, Stdio::piped())
    };
    let mut child = command
        .stdin(child_input)
        .stdout(Stdio::from(client_fd))
        .stderr(Stdio::from(main_fd))
        .spawn()
        .map_err(io_error)?;
    let input = match bootstrap {
        Some(channel) => RequestInput::Unix(channel),
        None => RequestInput::Pipe(child.stdin.take().ok_or(ControlError::Closed)?),
    };
    children.request = Some(child);
    children.input = Some(input);
    children
        .input
        .as_mut()
        .ok_or(ControlError::Closed)?
        .write_all(
            &u32::try_from(bytes.len())
                .map_err(|_| ControlError::FrameTooLarge)?
                .to_be_bytes(),
        )
        .map_err(io_error)?;
    children
        .input
        .as_mut()
        .ok_or(ControlError::Closed)?
        .write_all(bytes)
        .map_err(io_error)?;
    if let Some(socket) = reverse {
        let Some(RequestInput::Unix(channel)) = children.input.as_ref() else {
            return Err(ControlError::InvalidDescriptor);
        };
        crate::daemon_startup::live_bootstrap::send(channel, bytes, socket)?;
    }
    Ok(children)
}
fn preconnect_live_authority(
    config: &crate::daemon_config::LiveSidebandConfig,
) -> Result<TcpStream, ControlError> {
    use std::net::ToSocketAddrs;
    let origin =
        url::Url::parse(config.authority_origin()).map_err(|_| ControlError::InvalidFrame)?;
    let host = origin.host_str().ok_or(ControlError::InvalidFrame)?;
    for address in (host, 443).to_socket_addrs().map_err(io_error)? {
        if let Ok(socket) = TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            return Ok(socket);
        }
    }
    Err(ControlError::Closed)
}
enum RequestInput {
    Pipe(ChildStdin),
    Unix(UnixStream),
}
impl Write for RequestInput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        match self {
            Self::Pipe(pipe) => pipe.write(bytes),
            Self::Unix(socket) => socket.write(bytes),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Self::Pipe(pipe) => pipe.flush(),
            Self::Unix(socket) => socket.flush(),
        }
    }
}
pub(crate) struct RequestChildren {
    request: Option<Child>,
    connector: Option<Child>,
    input: Option<RequestInput>,
}
impl RequestChildren {
    fn wait(&mut self) -> Result<ExitStatus, ControlError> {
        loop {
            if let Some(status) = self
                .request
                .as_mut()
                .ok_or(ControlError::Closed)?
                .try_wait()
                .map_err(io_error)?
            {
                self.request.take();
                self.input.take();
                self.stop_connector()?;
                return Ok(status);
            }
            if let Some(child) = &mut self.connector
                && let Some(status) = child.try_wait().map_err(io_error)?
            {
                child.wait().map_err(io_error)?;
                self.connector.take();
                if !status.success() {
                    self.stop_request()?;
                    return Err(ControlError::Closed);
                }
                self.input
                    .as_mut()
                    .ok_or(ControlError::Closed)?
                    .write_all(&[1])
                    .map_err(io_error)?;
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
    fn stop_request(&mut self) -> Result<(), ControlError> {
        self.input.take();
        stop(&mut self.request)
    }
    fn stop_connector(&mut self) -> Result<(), ControlError> {
        stop(&mut self.connector)
    }
}
fn stop(child: &mut Option<Child>) -> Result<(), ControlError> {
    if let Some(mut child) = child.take() {
        if child.try_wait().map_err(io_error)?.is_none() {
            let _ = child.kill();
        }
        child.wait().map_err(io_error)?;
    }
    Ok(())
}
impl Drop for RequestChildren {
    fn drop(&mut self) {
        let _ = self.stop_request();
        let _ = self.stop_connector();
    }
}
fn io_error(error: std::io::Error) -> ControlError {
    ControlError::Io(error.kind())
}
