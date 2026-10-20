//! One prelaunch OS policy per child. This is never an advisory permission flag.
use crate::{confinement::NativeConfinement, connector_protocol::ControlError};
use std::{net::SocketAddr, path::Path};
fn quoted(path: &Path) -> Result<String, ControlError> {
    let path = path.to_str().ok_or(ControlError::InvalidFrame)?;
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
(allow file-read-data (literal {}) (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null") (literal "/private/etc/localtime"))
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
