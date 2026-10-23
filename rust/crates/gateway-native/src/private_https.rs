//! One constructor-preconnected socket, fixed URI and normal Rustls validation.
//! No DNS, new network socket, proxy, redirect or reconnection after confinement.
use gateway_auth::GatewayError;
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Mutex,
    time::{Duration, Instant},
};
use ureq::{
    config::Config,
    http::Uri,
    unversioned::{
        resolver::{ResolvedSocketAddrs, Resolver},
        transport::{
            Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, RustlsConnector,
            Transport,
        },
    },
};

#[derive(Debug)]
struct PreconnectedTcp {
    socket: TcpStream,
    buffers: LazyBuffers,
}
impl Transport for PreconnectedTcp {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.socket.set_write_timeout(io_timeout(timeout)?)?;
        self.socket
            .write_all(&self.buffers.output()[..amount])
            .map_err(|error| io_error(error, timeout))
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.socket.set_read_timeout(io_timeout(timeout)?)?;
        let count = self
            .socket
            .read(self.buffers.input_append_buf())
            .map_err(|error| io_error(error, timeout))?;
        self.buffers.input_appended(count);
        Ok(count > 0)
    }
    fn is_open(&mut self) -> bool {
        if self.socket.set_nonblocking(true).is_err() {
            return false;
        }
        let idle = matches!(self.socket.peek(&mut[0u8;1]),Err(error) if error.kind()==io::ErrorKind::WouldBlock);
        let restored = self.socket.set_nonblocking(false).is_ok();
        idle && restored
    }
}
fn io_timeout(timeout: NextTimeout) -> Result<Option<Duration>, ureq::Error> {
    use ureq::unversioned::transport::time::Duration as TransportDuration;
    match timeout.after {
        TransportDuration::NotHappening => Ok(None),
        TransportDuration::Exact(duration) if duration.is_zero() => {
            Err(ureq::Error::Timeout(timeout.reason))
        }
        TransportDuration::Exact(duration) => Ok(Some(duration)),
    }
}
fn io_error(error: io::Error, timeout: NextTimeout) -> ureq::Error {
    if matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    ) {
        ureq::Error::Timeout(timeout.reason)
    } else {
        error.into()
    }
}

#[derive(Debug)]
struct FixedResolver {
    uri: Uri,
    address: SocketAddr,
}
impl Resolver for FixedResolver {
    fn resolve(
        &self,
        uri: &Uri,
        _: &Config,
        _: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        if uri != &self.uri {
            return Err(ureq::Error::ConnectionFailed);
        }
        let mut addresses = self.empty();
        addresses.push(self.address);
        Ok(addresses)
    }
}

#[derive(Debug)]
struct OnceConnector {
    uri: Uri,
    socket: Mutex<Option<TcpStream>>,
}
impl Connector for OnceConnector {
    type Out = PreconnectedTcp;
    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        if details.uri != &self.uri {
            return Err(ureq::Error::ConnectionFailed);
        }
        let socket = self
            .socket
            .lock()
            .map_err(|_| ureq::Error::ConnectionFailed)?
            .take()
            .ok_or(ureq::Error::ConnectionFailed)?;
        Ok(Some(PreconnectedTcp {
            socket,
            buffers: LazyBuffers::new(8192, 8192),
        }))
    }
}

pub(crate) struct PrivateHttps {
    target: String,
    agent: ureq::Agent,
}
pub(crate) struct PrivateResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl PrivateHttps {
    /// The caller prepares the connected FD before the real OS profile. The
    /// configured TLS roots and hostname are still independently verified.
    pub fn from_connected(
        target: &str,
        path: &'static str,
        socket: TcpStream,
        roots: ureq::tls::RootCerts,
    ) -> Result<Self, GatewayError> {
        let url = url::Url::parse(target).map_err(|_| unavailable())?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != path
        {
            return Err(unavailable());
        }
        Self::connected_url(url, socket, roots)
    }
    /// Only the native import ModelsValidation operation may use this fixed GET/query target.
    pub(crate) fn models_connected(
        socket: TcpStream,
        roots: ureq::tls::RootCerts,
        client_version: &str,
    ) -> Result<Self, GatewayError> {
        let mut url = url::Url::parse("https://chatgpt.com/backend-api/codex/models")
            .map_err(|_| unavailable())?;
        url.query_pairs_mut()
            .append_pair("client_version", client_version);
        Self::connected_url(url, socket, roots)
    }
    fn connected_url(
        url: url::Url,
        socket: TcpStream,
        roots: ureq::tls::RootCerts,
    ) -> Result<Self, GatewayError> {
        let uri: Uri = url.as_str().parse().map_err(|_| unavailable())?;
        let address = socket.peer_addr().map_err(|_| unavailable())?;
        let config = ureq::Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(45)))
            .max_idle_connections(1)
            .max_idle_connections_per_host(1)
            .max_idle_age(Duration::from_secs(600))
            .tls_config(ureq::tls::TlsConfig::builder().root_certs(roots).build())
            .build();
        let connector = ()
            .chain(OnceConnector {
                uri: uri.clone(),
                socket: Mutex::new(Some(socket)),
            })
            .chain(RustlsConnector::default());
        let agent = ureq::Agent::with_parts(config, connector, FixedResolver { uri, address });
        Ok(Self {
            target: url.into(),
            agent,
        })
    }
    /// Fixed models GET only. This does not widen any old POST target or old response limit.
    pub(crate) fn get_models(
        &self,
        headers: &[(String, String)],
        deadline: Instant,
    ) -> Result<PrivateResponse, GatewayError> {
        let target = url::Url::parse(&self.target).map_err(|_| unavailable())?;
        if target.host_str() != Some("chatgpt.com") || target.path() != "/backend-api/codex/models"
        {
            return Err(unavailable());
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(unavailable)?;
        let mut request = self
            .agent
            .get(&self.target)
            .header("Accept", "application/json");
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let mut response = request
            .config()
            .timeout_global(Some(remaining))
            .build()
            .call()
            .map_err(|_| unknown())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
                    .map_err(|_| unknown())
            })
            .collect::<Result<Vec<_>, _>>()?;
        // The original upload validation buffers response.text() without a new numeric raw-body cap.
        // The existing safe normalized snapshot ceiling is enforced by the shared catalog planner.
        let body = response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(|_| unknown())?;
        Ok(PrivateResponse {
            status,
            headers,
            body,
        })
    }
    pub fn send(
        &self,
        headers: &[(String, String)],
        body: &[u8],
        deadline: Instant,
        max_response: usize,
    ) -> Result<PrivateResponse, GatewayError> {
        self.send_bounded(headers, body, deadline, max_response, max_response)
    }
    /// Only this fully decoded new operation obtains the versioned derived success cap.
    pub(crate) fn send_import_publication(
        &self,
        headers: &[(String, String)],
        body: &[u8],
        deadline: Instant,
    ) -> Result<PrivateResponse, GatewayError> {
        let target = url::Url::parse(&self.target).map_err(|_| unavailable())?;
        if target.path() != gateway_auth::native::NATIVE_PUBLICATION_PATH {
            return Err(unavailable());
        }
        gateway_authority::native_control::import::ImportPublicationCommandData::parse(body)?;
        self.send_bounded(
            headers,
            body,
            deadline,
            gateway_auth::native_import::publication::import_publication_reply_max_bytes(),
            65_536,
        )
    }
    fn send_bounded(
        &self,
        headers: &[(String, String)],
        body: &[u8],
        deadline: Instant,
        max_success: usize,
        max_error: usize,
    ) -> Result<PrivateResponse, GatewayError> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|duration| !duration.is_zero())
            .ok_or_else(unavailable)?;
        let mut request = self
            .agent
            .post(&self.target)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json");
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let mut response = request
            .config()
            .timeout_global(Some(remaining))
            .build()
            .send(body)
            .map_err(|_| unknown())?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
                    .map_err(|_| unknown())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let body = response
            .body_mut()
            .with_config()
            .limit(if status == 200 {
                max_success
            } else {
                max_error
            } as u64)
            .read_to_vec()
            .map_err(|_| unknown())?;
        Ok(PrivateResponse {
            status,
            headers,
            body,
        })
    }
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The fixed preconnected native HTTPS capability is unavailable",
        "native_https_unavailable",
    )
}
fn unknown() -> GatewayError {
    GatewayError::unavailable(
        "Native HTTPS outcome is unknown; reconcile the original operation",
        "native_control_outcome_unknown",
    )
}

#[cfg(test)]
mod import_tests;
