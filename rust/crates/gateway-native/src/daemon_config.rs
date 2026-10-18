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
}
impl NativeDaemonConfig {
    pub fn read_stdin(input: impl Read) -> Result<PreparedNativeDaemonConfig, GatewayError> {
        let mut bytes = Vec::new();
        input
            .take(65_537)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        if bytes.len() > 65_536 {
            return Err(invalid());
        }
        let config: Self = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        config.prepare()
    }
    fn prepare(self) -> Result<PreparedNativeDaemonConfig, GatewayError> {
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
        let identity = NativeTransportIdentity::new(
            self.identity.key_id,
            self.identity.owner_id,
            self.identity.owner_epoch,
            key,
            BTreeSet::from([NativeCapability::SupervisorRead]),
        )?;
        Ok(PreparedNativeDaemonConfig {
            listen: self.listen,
            identity,
            nonce_database: self.nonce_database,
            sources: self.sources,
        })
    }
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Native daemon startup configuration is invalid",
        "native_configuration_invalid",
    )
}
