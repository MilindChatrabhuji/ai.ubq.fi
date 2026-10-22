//! Trusted local startup input only. There is no dotenv discovery, default
//! listener, public configuration route, command or caller-selected source path.
use crate::SourceId;
use gateway_auth::{
    GatewayError,
    crypto::{base64url, decode_base64url},
    native_auth::{NativeCapability, NativeTransportIdentity},
};
use serde::Deserialize;
use std::{collections::BTreeSet, io::Read, net::SocketAddr, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeDaemonConfig {
    v: u8,
    listen: SocketAddr,
    identity: TransportIdentityConfig,
    nonce_database: PathBuf,
    sources: Vec<SupervisorSourceConfig>,
}
/// Version 2 adds only the already-approved fixed native-owner renewal action.
/// Version 1 continues rejecting every field it did not originally understand.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeDaemonConfigV2 {
    v: u8,
    listen: SocketAddr,
    identity: TransportIdentityConfig,
    nonce_database: PathBuf,
    sources: Vec<SupervisorSourceConfig>,
    owner_renewal: Option<OwnerRenewalConfig>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeDaemonConfigV3 {
    v: u8,
    listen: SocketAddr,
    identity: TransportIdentityConfig,
    nonce_database: PathBuf,
    sources: Vec<SupervisorSourceConfig>,
    owner_renewal: Option<OwnerRenewalConfig>,
    live_sideband: LiveSidebandConfig,
}
/// The candidate's reverse channel is startup-owned, never a request destination.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveSidebandConfig {
    authority_origin: String,
}
impl LiveSidebandConfig {
    pub fn authority_origin(&self) -> &str {
        &self.authority_origin
    }
    fn validate(&self) -> Result<(), GatewayError> {
        if self.authority_origin != "https://rust-candidate.ai.ubq.fi" {
            return Err(invalid());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnerRenewalConfig {
    authority_origin: String,
    owners: Vec<NativeOwnerConfig>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeOwnerConfig {
    owner_id: String,
    codex_home: PathBuf,
}
impl OwnerRenewalConfig {
    pub fn authority_origin(&self) -> &str {
        &self.authority_origin
    }
    pub fn owners(&self) -> &[NativeOwnerConfig] {
        &self.owners
    }
    #[cfg(unix)]
    fn validate(&self) -> Result<(), GatewayError> {
        let origin = url::Url::parse(&self.authority_origin).map_err(|_| invalid())?;
        if origin.scheme() != "https"
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || self.owners.is_empty()
            || self.owners.len() > 2
        {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        let mut homes = BTreeSet::new();
        for owner in &self.owners {
            if owner.owner_id.is_empty()
                || owner.owner_id.len() > 256
                || !owner.owner_id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
                })
                || !owner.codex_home.is_absolute()
                || !seen.insert(&owner.owner_id)
                || !homes.insert(&owner.codex_home)
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    fn validate(&self) -> Result<(), GatewayError> {
        Err(invalid())
    }
}
impl NativeOwnerConfig {
    pub fn owner_id(&self) -> &str {
        &self.owner_id
    }
    pub fn codex_home(&self) -> &std::path::Path {
        &self.codex_home
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransportIdentityConfig {
    key_id: String,
    owner_id: String,
    owner_epoch: String,
    key_base64url: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupervisorSourceConfig {
    id: String,
    name: String,
    socket_path: PathBuf,
    codex_home: Option<PathBuf>,
}
impl SupervisorSourceConfig {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn socket_path(&self) -> &std::path::Path {
        &self.socket_path
    }
    pub fn codex_home(&self) -> Option<&std::path::Path> {
        self.codex_home.as_deref()
    }
}
pub struct PreparedNativeDaemonConfig {
    pub listen: SocketAddr,
    pub identity: NativeTransportIdentity,
    pub nonce_database: PathBuf,
    pub sources: Vec<SupervisorSourceConfig>,
    pub owner_renewal: Option<OwnerRenewalConfig>,
    pub live_sideband: Option<LiveSidebandConfig>,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum NativeDaemonRole {
    Ordinary,
    Import,
}
impl NativeDaemonConfig {
    pub fn read_stdin(input: impl Read) -> Result<PreparedNativeDaemonConfig, GatewayError> {
        Self::read_for_role(input, NativeDaemonRole::Ordinary)
    }
    /// Fixed first-party import Child only. No wire flag or caller-selected capability.
    pub(crate) fn read_import_stdin(
        input: impl Read,
    ) -> Result<PreparedNativeDaemonConfig, GatewayError> {
        Self::read_for_role(input, NativeDaemonRole::Import)
    }
    fn read_for_role(
        input: impl Read,
        role: NativeDaemonRole,
    ) -> Result<PreparedNativeDaemonConfig, GatewayError> {
        let mut bytes = Vec::new();
        input
            .take(65_537)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        if bytes.len() > 65_536 {
            return Err(invalid());
        }
        let version: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if version.get("v").and_then(serde_json::Value::as_u64) == Some(3) {
            let config: NativeDaemonConfigV3 =
                serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if config.v != 3 || role == NativeDaemonRole::Import {
                return Err(invalid());
            }
            config.live_sideband.validate()?;
            if let Some(renewal) = &config.owner_renewal {
                renewal.validate()?;
            }
            let mut prepared = Self {
                v: 1,
                listen: config.listen,
                identity: config.identity,
                nonce_database: config.nonce_database,
                sources: config.sources,
            }
            .prepare(config.owner_renewal.is_some(), role, true)?;
            prepared.owner_renewal = config.owner_renewal;
            prepared.live_sideband = Some(config.live_sideband);
            Ok(prepared)
        } else if version.get("v").and_then(serde_json::Value::as_u64) == Some(2) {
            let config: NativeDaemonConfigV2 =
                serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if config.v != 2 {
                return Err(invalid());
            }
            if let Some(renewal) = &config.owner_renewal {
                renewal.validate()?;
            }
            if role == NativeDaemonRole::Import && config.owner_renewal.is_none() {
                return Err(invalid());
            }
            let mut prepared = Self {
                v: 1,
                listen: config.listen,
                identity: config.identity,
                nonce_database: config.nonce_database,
                sources: config.sources,
            }
            .prepare(config.owner_renewal.is_some(), role, false)?;
            prepared.owner_renewal = config.owner_renewal;
            Ok(prepared)
        } else {
            let config: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            config.prepare(false, role, false)
        }
    }
    fn prepare(
        self,
        owner_renewal: bool,
        role: NativeDaemonRole,
        live_sideband: bool,
    ) -> Result<PreparedNativeDaemonConfig, GatewayError> {
        if role == NativeDaemonRole::Import && !owner_renewal {
            return Err(invalid());
        }
        if self.v != 1
            || !self.listen.ip().is_loopback()
            || !self.nonce_database.is_absolute()
            || self.sources.len() > crate::supervisor::MAX_SOURCES
        {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        for source in &self.sources {
            SourceId::parse(&source.id)?;
            if !seen.insert(&source.id)
                || source.name.is_empty()
                || source.name.encode_utf16().count() > 64
                || !source.socket_path.is_absolute()
                || source
                    .codex_home
                    .as_ref()
                    .is_some_and(|home| !home.is_absolute())
            {
                return Err(invalid());
            }
        }
        let bytes = decode_base64url(&self.identity.key_base64url)?;
        if bytes.len() != 32 || base64url(&bytes) != self.identity.key_base64url {
            return Err(invalid());
        }
        let key: [u8; 32] = bytes.try_into().map_err(|_| invalid())?;
        let capabilities = if role == NativeDaemonRole::Import {
            BTreeSet::from([NativeCapability::CodexAuthImport])
        } else {
            let mut ordinary = BTreeSet::from([NativeCapability::SupervisorRead]);
            if owner_renewal {
                ordinary.insert(NativeCapability::OwnerRenewal);
                ordinary.insert(NativeCapability::AccessPublish);
            }
            if live_sideband {
                ordinary.insert(NativeCapability::LiveSideband);
            }
            ordinary
        };
        let identity = NativeTransportIdentity::new(
            self.identity.key_id,
            self.identity.owner_id,
            self.identity.owner_epoch,
            key,
            capabilities,
        )?;
        Ok(PreparedNativeDaemonConfig {
            listen: self.listen,
            identity,
            nonce_database: self.nonce_database,
            sources: self.sources,
            owner_renewal: None,
            live_sideband: None,
        })
    }
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Native daemon startup configuration is invalid",
        "native_configuration_invalid",
    )
}
