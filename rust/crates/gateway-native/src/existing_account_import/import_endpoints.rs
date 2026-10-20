//! Trusted prelaunch resolution, then fixed once-connected actor transports.
use crate::import_custody_protocol::unavailable;
use gateway_authority::native_control::NativeRenewalCancellation;
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use std::{
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

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
        let authority = resolve(
            origin.host_str().ok_or_else(unavailable)?,
            origin.port_or_known_default().ok_or_else(unavailable)?,
        )?;
        let data = ImportEndpointData {
            authority,
            models: resolve("chatgpt.com", 443)?,
            oauth: resolve("auth.openai.com", 443)?,
        };
        data.validate()?;
        Ok(Self {
            origin: origin.into(),
            data,
        })
    }
    #[cfg(all(test, feature = "native-import-fixture"))]
    pub(super) fn fixture(
        authority: SocketAddr,
        models: SocketAddr,
        oauth: SocketAddr,
    ) -> Result<Self, GatewayError> {
        let data = ImportEndpointData {
            authority,
            models,
            oauth,
        };
        data.validate()?;
        if data
            .addresses()
            .iter()
            .any(|address| !address.ip().is_loopback())
        {
            return Err(unavailable());
        }
        Ok(Self {
            origin: "https://localhost/".into(),
            data,
        })
    }
    pub(super) fn require_origin(&self, origin: &str) -> Result<(), GatewayError> {
        let origin: String = checked_origin(origin)?.into();
        if self.origin != origin {
            return Err(unavailable());
        }
        self.data.validate()
    }
    pub(super) fn data(&self) -> Result<ImportEndpointData, GatewayError> {
        self.data.validate()?;
        Ok(ImportEndpointData {
            authority: self.data.authority,
            models: self.data.models,
            oauth: self.data.oauth,
        })
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
    pub(super) fn addresses(&self) -> [SocketAddr; 3] {
        [self.authority, self.models, self.oauth]
    }
    pub(super) fn connect<C: NativeRenewalCancellation>(
        self,
        cancellation: &C,
        deadline: Instant,
    ) -> Result<ConnectedImportEndpoints, GatewayError> {
        self.validate()?;
        let connect = |address: SocketAddr| {
            if cancellation.cancelled() {
                return Err(unavailable());
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|d| !d.is_zero())
                .ok_or_else(unavailable)?;
            let socket =
                TcpStream::connect_timeout(&address, remaining.min(Duration::from_secs(5)))
                    .map_err(|_| unavailable())?;
            socket.set_nonblocking(false).map_err(|_| unavailable())?;
            if cancellation.cancelled()
                || Instant::now() >= deadline
                || socket.peer_addr().map_err(|_| unavailable())? != address
            {
                return Err(unavailable());
            }
            Ok(socket)
        };
        // Distinct streams; no application byte proxy or shared ureq agent.
        Ok(ConnectedImportEndpoints {
            authority: connect(self.authority)?,
            publication: connect(self.authority)?,
            models: connect(self.models)?,
            oauth: connect(self.oauth)?,
        })
    }
}
fn checked_origin(value: &str) -> Result<url::Url, GatewayError> {
    let origin = url::Url::parse(value).map_err(|_| unavailable())?;
    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return Err(unavailable());
    }
    Ok(origin)
}
fn resolve(host: &str, port: u16) -> Result<SocketAddr, GatewayError> {
    (host, port)
        .to_socket_addrs()
        .map_err(|_| unavailable())?
        .find(|address| {
            address.port() != 0 && !address.ip().is_unspecified() && !address.ip().is_multicast()
        })
        .ok_or_else(unavailable)
}

pub(super) fn fixed_authority_client<'a, C: NativeRenewalCancellation>(
    origin: &str,
    socket: TcpStream,
    identity: gateway_auth::native_auth::NativeTransportIdentity,
    cancellation: &'a C,
    deadline: Instant,
) -> Result<gateway_authority::native_control::import::RemoteImportAuthority<'a, C>, GatewayError> {
    let origin = checked_origin(origin)?;
    #[cfg(feature = "native-import-fixture")]
    {
        if origin.host_str() != Some("localhost") {
            return Err(unavailable());
        }
        gateway_authority::native_control::import::RemoteImportAuthority::from_fixture_connected(
            socket,
            identity,
            cancellation,
            deadline,
        )
    }
    #[cfg(not(feature = "native-import-fixture"))]
    {
        let target = origin
            .join(gateway_auth::native::NATIVE_RENEWAL_AUTHORITY_PATH)
            .map_err(|_| unavailable())?;
        gateway_authority::native_control::import::RemoteImportAuthority::from_connected(
            target.as_str(),
            socket,
            identity,
            cancellation,
            deadline,
        )
    }
}
pub(super) fn validation_roots() -> ureq::tls::RootCerts {
    #[cfg(feature = "native-import-fixture")]
    {
        ureq::tls::RootCerts::new_with_certs(&[ureq::tls::Certificate::from_der(include_bytes!(
            "../../tests/fixtures/import-tls/ca.der"
        ))
        .to_owned()])
    }
    #[cfg(not(feature = "native-import-fixture"))]
    {
        ureq::tls::RootCerts::WebPki
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::TcpListener,
        sync::atomic::{AtomicBool, Ordering},
    };
    struct Cancellation(AtomicBool);
    impl NativeRenewalCancellation for Cancellation {
        fn cancelled(&self) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }
    #[test]
    fn actual_fixed_role_sockets_are_distinct_and_cancellation_opens_none() {
        let authority = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let models = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let oauth = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let data = || ImportEndpointData {
            authority: authority.local_addr().unwrap(),
            models: models.local_addr().unwrap(),
            oauth: oauth.local_addr().unwrap(),
        };
        let cancellation = Cancellation(AtomicBool::new(false));
        let connected = data()
            .connect(&cancellation, Instant::now() + Duration::from_secs(2))
            .unwrap();
        assert_ne!(
            connected.authority.local_addr().unwrap(),
            connected.publication.local_addr().unwrap()
        );
        for (listener, socket) in [
            (&authority, &connected.authority),
            (&authority, &connected.publication),
            (&models, &connected.models),
            (&oauth, &connected.oauth),
        ] {
            let (accepted, peer) = listener.accept().unwrap();
            assert_eq!(peer, socket.local_addr().unwrap());
            assert_eq!(accepted.local_addr().unwrap(), socket.peer_addr().unwrap());
        }
        drop(connected);
        cancellation.0.store(true, Ordering::SeqCst);
        assert!(
            data()
                .connect(&cancellation, Instant::now() + Duration::from_secs(2))
                .is_err()
        );
        for listener in [&authority, &models, &oauth] {
            listener.set_nonblocking(true).unwrap();
            assert!(
                matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
            );
        }
    }
    #[test]
    fn closed_endpoint_data_rejects_mixed_fields_zero_ports_and_unfixed_origins() {
        for origin in [
            "http://localhost/",
            "https://localhost/path",
            "https://user@localhost/",
            "https://localhost/?target=x",
            "https://localhost/#x",
        ] {
            assert!(checked_origin(origin).is_err());
        }
        let raw = r#"{"authority":"127.0.0.1:443","models":"127.0.0.1:443","oauth":"127.0.0.1:443","provider":"anything"}"#;
        assert!(serde_json::from_str::<ImportEndpointData>(raw).is_err());
        let data = ImportEndpointData {
            authority: "127.0.0.1:443".parse().unwrap(),
            models: "127.0.0.1:0".parse().unwrap(),
            oauth: "127.0.0.1:443".parse().unwrap(),
        };
        assert!(data.validate().is_err());
    }
}
