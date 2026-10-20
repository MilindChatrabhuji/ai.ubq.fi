//! Trusted prelaunch resolution, then fixed once-connected actor transports.
use crate::import_custody_protocol::unavailable;
use gateway_authority::native_control::NativeRenewalCancellation;
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use std::{net::{SocketAddr, TcpStream, ToSocketAddrs}, time::{Duration, Instant}};

/// DATA from the actual parent's sole bootstrap pipe, never an HTTP option.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportEndpointData {
    pub(super) authority: SocketAddr,
    pub(super) models: SocketAddr,
    pub(super) oauth: SocketAddr,
}
/// Only trusted bootstrap resolves these. The actor cannot select another URL.
pub(super) struct ResolvedImportEndpoints {
    origin: String,
    data: ImportEndpointData,
}
pub(super) struct ConnectedImportEndpoints {
    pub(super) authority: TcpStream,
    pub(super) publication: TcpStream,
    pub(super) models: TcpStream,
    pub(super) oauth: TcpStream,
}
impl ResolvedImportEndpoints {
    pub(super) fn resolve(authority_origin: &str) -> Result<Self, GatewayError> {
        let origin = checked_origin(authority_origin)?;
        let authority = resolve(origin.host_str().ok_or_else(unavailable)?, origin.port_or_known_default().ok_or_else(unavailable)?)?;
        let data = ImportEndpointData { authority, models: resolve("chatgpt.com", 443)?, oauth: resolve("auth.openai.com", 443)? };
        data.validate()?;
        Ok(Self { origin: origin.into(), data })
    }
    pub(super) fn require_origin(&self, origin: &str) -> Result<(), GatewayError> {
        let origin: String = checked_origin(origin)?.into();
        if self.origin != origin { return Err(unavailable()); }
        self.data.validate()
    }
    pub(super) fn data(&self) -> Result<ImportEndpointData, GatewayError> {
        self.data.validate()?;
        Ok(ImportEndpointData { authority: self.data.authority, models: self.data.models, oauth: self.data.oauth })
    }
}
impl ImportEndpointData {
    pub(super) fn validate(&self) -> Result<(), GatewayError> {
        for address in self.addresses() {
            if address.port() == 0 || address.ip().is_unspecified() || address.ip().is_multicast() {
                return Err(unavailable());
            }
        }
        Ok(())
    }
    pub(super) fn addresses(&self) -> [SocketAddr; 3] { [self.authority, self.models, self.oauth] }
    pub(super) fn connect<C: NativeRenewalCancellation>(
        self, cancellation: &C, deadline: Instant,
    ) -> Result<ConnectedImportEndpoints, GatewayError> {
        self.validate()?;
        let connect = |address: SocketAddr| {
            if cancellation.cancelled() { return Err(unavailable()); }
            let remaining = deadline.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()).ok_or_else(unavailable)?;
            let socket = TcpStream::connect_timeout(&address, remaining.min(Duration::from_secs(5))).map_err(|_| unavailable())?;
            socket.set_nonblocking(false).map_err(|_| unavailable())?;
            if cancellation.cancelled() || Instant::now() >= deadline || socket.peer_addr().map_err(|_| unavailable())? != address {
                return Err(unavailable());
            }
            Ok(socket)
        };
        // Distinct streams; no application byte proxy or shared ureq agent.
        Ok(ConnectedImportEndpoints { authority: connect(self.authority)?, publication: connect(self.authority)?,
            models: connect(self.models)?, oauth: connect(self.oauth)? })
    }
}
fn checked_origin(value: &str) -> Result<url::Url, GatewayError> {
    let origin = url::Url::parse(value).map_err(|_| unavailable())?;
    if origin.scheme() != "https" || origin.host_str().is_none() || !origin.username().is_empty()
        || origin.password().is_some() || origin.path() != "/" || origin.query().is_some() || origin.fragment().is_some() {
        return Err(unavailable());
    }
    Ok(origin)
}
fn resolve(host: &str, port: u16) -> Result<SocketAddr, GatewayError> {
    (host, port).to_socket_addrs().map_err(|_| unavailable())?
        .find(|address| address.port() != 0 && !address.ip().is_unspecified() && !address.ip().is_multicast()).ok_or_else(unavailable)
}
