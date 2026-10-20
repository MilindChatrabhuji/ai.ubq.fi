//! One prelaunch OS policy per child. This is never an advisory permission flag.
use crate::{confinement::NativeConfinement, connector_protocol::ControlError};
use std::{net::SocketAddr, path::Path};
fn quoted(path: &Path) -> Result<String, ControlError> {
    if !path.is_absolute() {
        return Err(ControlError::InvalidFrame);
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| ControlError::InvalidFrame)?;
    let path = canonical.to_str().ok_or(ControlError::InvalidFrame)?;
    if !path.starts_with('/') || path.contains(['\n', '\r', '\0']) {
        return Err(ControlError::InvalidFrame);
    }
    serde_json::to_string(path).map_err(|_| ControlError::InvalidFrame)
}
fn base(binary: &Path) -> Result<String, ControlError> {
    if !cfg!(target_os = "macos") {
        return Err(ControlError::UnsupportedPlatform);
    }
    Ok(format!(
        r#"(version 1)
(deny default)
(allow process-exec (literal {}))
(deny process-fork)
(allow file-read-metadata)
(allow file-read-data (literal "/") (literal "/dev/fd") (literal {}) (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null") (literal "/private/etc/localtime"))
(allow file-write-data (literal "/dev/null"))
(allow sysctl-read)
"#,
        quoted(binary)?,
        quoted(binary)?
    ))
}
pub(crate) fn connector(binary: &Path) -> Result<String, ControlError> {
    let mut policy = base(binary)?;
    policy.push_str(r#"(allow mach-lookup (global-name "com.apple.mDNSResponder"))
(allow file-read-data (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/var/run/resolv.conf"))
(allow network-outbound (remote tcp "*:443"))
"#);
    Ok(policy)
}
pub(crate) fn request(
    binary: &Path,
    capabilities: &NativeConfinement,
    local: SocketAddr,
    peer: SocketAddr,
) -> Result<String, ControlError> {
    if !local.ip().is_loopback() || !peer.ip().is_loopback() {
        return Err(ControlError::InvalidFrame);
    }
    let mut policy = base(binary)?;
    for path in &capabilities.readonly_paths {
        policy.push_str(&format!("(allow file-read* (subpath {}))\n", quoted(path)?));
    }
    for path in &capabilities.list_directories {
        policy.push_str(&format!(
            "(allow file-read-data file-read-metadata (literal {}))\n",
            quoted(path)?
        ));
    }
    policy.push_str(&format!(
        "(allow file-read* file-write* (subpath {}))\n",
        quoted(&capabilities.replay_directory)?
    ));
    for path in &capabilities.unix_sockets {
        if !path.exists() {
            continue;
        }
        policy.push_str(&format!(
            "(allow network-outbound (remote unix-socket (path {})))\n",
            quoted(path)?
        ));
    }
    // Only the inherited downstream tuple is granted. No new external connect
    // or wildcard loopback authority is inferred from the accepted socket.
    policy.push_str(&format!("(allow network-inbound network-outbound (require-all (local tcp \"localhost:{}\") (remote tcp \"localhost:{}\")))\n", local.port(), peer.port()));
    Ok(policy)
}

/// Observe descriptor numbers only; never adopt or close a numeric FD. This
/// runs before role threads/clones, so the directory iterator's FD is replaced
/// by the safe marker after the iterator closes, without a concurrent opener.
pub(crate) fn inherited_only_stdio() -> Result<(), ControlError> {
    use std::{collections::BTreeSet, fs::File, os::fd::AsRawFd};
    let descriptors = std::fs::read_dir("/dev/fd").map_err(|_| ControlError::InvalidDescriptor)?;
    let mut numbers = BTreeSet::new();
    for entry in descriptors {
        let entry = entry.map_err(|_| ControlError::InvalidDescriptor)?;
        let number = entry
            .file_name()
            .to_str()
            .ok_or(ControlError::InvalidDescriptor)?
            .parse::<i32>()
            .map_err(|_| ControlError::InvalidDescriptor)?;
        numbers.insert(number);
    }
    let marker = File::open("/dev/null").map_err(|_| ControlError::InvalidDescriptor)?;
    if !numbers.remove(&marker.as_raw_fd()) || numbers != BTreeSet::from([0, 1, 2]) {
        return Err(ControlError::InvalidDescriptor);
    }
    Ok(())
}

pub(crate) fn validate_unix_control(
    control: &std::os::unix::net::UnixStream,
) -> Result<(), ControlError> {
    if rustix::net::sockopt::socket_type(control).map_err(|_| ControlError::InvalidDescriptor)?
        != rustix::net::SocketType::STREAM
    {
        return Err(ControlError::InvalidDescriptor);
    }
    let address = match rustix::net::getpeername(control) {
        Ok(address) => address,
        Err(error) => {
            let ended =
                crate::connector_worker::channel_events(control, std::time::Duration::ZERO)?
                    .contains(rustix::event::PollFlags::HUP);
            if error != rustix::io::Errno::INVAL || !ended {
                return Err(ControlError::InvalidDescriptor);
            }
            // A closed Darwin Unix peer loses its peer address (EINVAL).
            // Validate the local domain instead; leave queued data/rights for
            // the actual receive path rather than treating HUP as EOF.
            Some(rustix::net::getsockname(control).map_err(|_| ControlError::InvalidDescriptor)?)
        }
    };
    if let Some(address) = address
        && address.address_family() != rustix::net::AddressFamily::UNIX
    {
        return Err(ControlError::InvalidDescriptor);
    }
    Ok(())
}

/// Credential mutation belongs only to the fixed native import child, never the inference connector.
pub(crate) fn import_actor(
    binary: &Path,
    root: &Path,
    replay: &Path,
    client_local: SocketAddr,
    client_peer: SocketAddr,
    custody_local: SocketAddr,
    custody_peer: SocketAddr,
    endpoints: &[SocketAddr; 3],
) -> Result<String, ControlError> {
    let mut policy = base(binary)?;
    let root = quoted(root)?;
    let root: String = serde_json::from_str(&root).map_err(|_| ControlError::InvalidFrame)?;
    policy.push_str(&format!(
        "(allow file-read* (subpath {}))\n",
        serde_json::to_string(&root).map_err(|_| ControlError::InvalidFrame)?
    ));
    // Only auth and this protocol's fixed temporary/backup/receipt names are writable.
    // The actor cannot alter the custodian's lock or dirty runtime epoch.
    let literal = serde_json::to_string(&format!("{root}/auth.json"))
        .map_err(|_| ControlError::InvalidFrame)?;
    let escaped = root
        .replace('\\', "\\\\")
        .replace('.', "\\.")
        .replace('+', "\\+")
        .replace('(', "\\(")
        .replace(')', "\\)")
        .replace('[', "\\[")
        .replace(']', "\\]")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('^', "\\^")
        .replace('$', "\\$")
        .replace('*', "\\*")
        .replace('?', "\\?")
        .replace('|', "\\|");
    let pattern =
        format!("^{escaped}/\\.uos-import-[0-9a-f]{{64}}\\.(tmp|previous|rotated|receipt|receipt\\.tmp)$");
    policy.push_str(&format!(
        "(allow file-write* (literal {literal}) (regex #{}))\n",
        serde_json::to_string(&pattern).map_err(|_| ControlError::InvalidFrame)?
    ));
    policy.push_str(&format!(
        "(allow file-read* file-write* (subpath {}))\n",
        quoted(replay)?
    ));
    for endpoint in endpoints {
        if endpoint.port() == 0 || endpoint.ip().is_unspecified() || endpoint.ip().is_multicast() {
            return Err(ControlError::InvalidFrame);
        }
        policy.push_str(&format!("(allow network-outbound (remote tcp \"{endpoint}\"))\n"));
    }
    for (local, peer) in [(client_local, client_peer), (custody_local, custody_peer)] {
        if !local.ip().is_loopback() || !peer.ip().is_loopback() {
            return Err(ControlError::InvalidFrame);
        }
        policy.push_str(&format!("(allow network-inbound network-outbound (require-all (local tcp \"localhost:{}\") (remote tcp \"localhost:{}\")))\n", local.port(), peer.port()));
    }
    Ok(policy)
}
