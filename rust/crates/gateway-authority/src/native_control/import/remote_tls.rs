//! Actual import-private fixed TLS exchange; never a proof/permission constructor.
use gateway_auth::{
    crypto::{base64url, decode_base64url},
    native::{
        NATIVE_KEY_HEADER, NATIVE_MAC_HEADER, NATIVE_NONCE_HEADER, NATIVE_RENEWAL_AUTHORITY_PATH,
        NATIVE_TIME_HEADER, NATIVE_VERSION_HEADER,
    },
    native_control::{NATIVE_CONTROL_ERROR_MAX_BYTES, NATIVE_RENEWAL_MAX_MS},
};
use gateway_core::{GatewayError, identity::MAX_SAFE_INTEGER};
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

pub(super) struct Roots(ureq::tls::RootCerts);
impl Roots {
    pub(super) fn webpki() -> Self {
        Self(ureq::tls::RootCerts::WebPki)
    }
    #[cfg(any(test, feature = "native-import-fixture"))]
    pub(super) fn fixture(certificate_der: &[u8]) -> Self {
        Self(ureq::tls::RootCerts::new_with_certs(&[
            ureq::tls::Certificate::from_der(certificate_der).to_owned(),
        ]))
    }
}
/// No serde/Clone/Debug or public response/reader constructor.
pub(super) struct ActualTlsReply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl ActualTlsReply {
    pub(super) fn status(&self) -> u16 {
        self.status
    }
    pub(super) fn headers(&self) -> &[(String, String)] {
        &self.headers
    }
    pub(super) fn body(&self) -> &[u8] {
        &self.body
    }
}
struct State {
    agent: ureq::Agent,
    original_deadline: Option<Instant>,
    unusable: bool,
}
pub(super) struct ImportAuthorityTls {
    target: String,
    state: Mutex<State>,
}
impl ImportAuthorityTls {
    pub(super) fn from_connected(
        target: &str,
        socket: TcpStream,
        roots: Roots,
    ) -> Result<Self, GatewayError> {
        if target.trim() != target || target.bytes().any(|b| b.is_ascii_control()) {
            return Err(unavailable());
        }
        let url = url::Url::parse(target).map_err(|_| unavailable())?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != NATIVE_RENEWAL_AUTHORITY_PATH
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(unavailable());
        }
        let uri: Uri = url.as_str().parse().map_err(|_| unavailable())?;
        let address = socket.peer_addr().map_err(|_| unavailable())?;
        socket.set_nonblocking(false).map_err(|_| unavailable())?;
        let config = ureq::Agent::config_builder()
            .https_only(true)
            .proxy(None)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_millis(NATIVE_RENEWAL_MAX_MS as u64)))
            .max_idle_connections(1)
            .max_idle_connections_per_host(1)
            .max_idle_age(Duration::from_secs(600))
            .tls_config(ureq::tls::TlsConfig::builder().root_certs(roots.0).build())
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
            state: Mutex::new(State {
                agent,
                original_deadline: None,
                unusable: false,
            }),
        })
    }
    pub(super) fn send(
        &self,
        native_headers: &[(String, String)],
        body: &[u8],
        original_deadline: Instant,
        operation_derived_max_response: usize,
    ) -> Result<ActualTlsReply, GatewayError> {
        validate_headers(native_headers)?;
        if operation_derived_max_response == 0 {
            return Err(unavailable());
        }
        let mut state = self.state.try_lock().map_err(|_| unavailable())?;
        if state.unusable {
            return Err(unavailable());
        }
        let now = Instant::now();
        if original_deadline <= now
            || original_deadline.duration_since(now)
                > Duration::from_millis(NATIVE_RENEWAL_MAX_MS as u64)
        {
            return Err(unavailable());
        }
        let deadline = state
            .original_deadline
            .map_or(original_deadline, |previous| {
                previous.min(original_deadline)
            });
        state.original_deadline = Some(deadline);
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(unavailable)?;
        let result = actual_exchange(
            &state.agent,
            &self.target,
            native_headers,
            body,
            remaining,
            operation_derived_max_response,
        )
        .and_then(|reply| {
            if Instant::now() >= deadline {
                Err(unavailable())
            } else {
                Ok(reply)
            }
        });
        if result.is_err() {
            state.unusable = true;
        }
        result
    }
}
fn actual_exchange(
    agent: &ureq::Agent,
    target: &str,
    native_headers: &[(String, String)],
    body: &[u8],
    remaining: Duration,
    maximum: usize,
) -> Result<ActualTlsReply, GatewayError> {
    let mut request = agent
        .post(target)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json");
    for (name, value) in native_headers {
        request = request.header(name, value);
    }
    let mut response = request
        .config()
        .timeout_global(Some(remaining))
        .build()
        .send(body)
        .map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    let maximum = if status >= 400 {
        maximum.min(NATIVE_CONTROL_ERROR_MAX_BYTES)
    } else {
        maximum
    };
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            value
                .to_str()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
                .map_err(|_| unavailable())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let lengths: Vec<_> = response
        .headers()
        .get_all("content-length")
        .iter()
        .collect();
    if lengths.len() > 1 {
        return Err(unavailable());
    }
    if let Some(length) = lengths.first() {
        let declared: u64 = length
            .to_str()
            .map_err(|_| unavailable())?
            .parse()
            .map_err(|_| unavailable())?;
        if declared > u64::try_from(maximum).map_err(|_| unavailable())? {
            return Err(unavailable());
        }
    }
    // Do not preallocate from Content-Length or an untrusted size hint. Limit is
    // enforced before each Vec extension, including chunked and unknown lengths.
    let mut reader = response
        .body_mut()
        .with_config()
        .limit(
            u64::try_from(maximum)
                .map_err(|_| unavailable())?
                .checked_add(1)
                .ok_or_else(unavailable)?,
        )
        .reader();
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = reader.read(&mut chunk).map_err(|_| unavailable())?;
        if count == 0 {
            break;
        }
        if bytes
            .len()
            .checked_add(count)
            .is_none_or(|size| size > maximum)
        {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(ActualTlsReply {
        status,
        headers,
        body: bytes,
    })
}
fn validate_headers(headers: &[(String, String)]) -> Result<(), GatewayError> {
    let required = [
        NATIVE_VERSION_HEADER,
        NATIVE_KEY_HEADER,
        NATIVE_TIME_HEADER,
        NATIVE_NONCE_HEADER,
        NATIVE_MAC_HEADER,
    ];
    if headers.len() != required.len() {
        return Err(unavailable());
    }
    let mut values = Vec::new();
    for (index, name) in required.into_iter().enumerate() {
        let matching: Vec<_> = headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .collect();
        if matching.len() != 1 {
            return Err(unavailable());
        }
        let value = matching[0].1.as_str();
        if value.len() > [1, 64, 16, 43, 43][index] {
            return Err(unavailable());
        }
        ureq::http::HeaderValue::from_str(value).map_err(|_| unavailable())?;
        values.push(value);
    }
    if values[0] != "1"
        || values[1].is_empty()
        || values[1].len() > 64
        || !values[1]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err(unavailable());
    }
    let time: i64 = values[2].parse().map_err(|_| unavailable())?;
    if !(0..=MAX_SAFE_INTEGER).contains(&time) || time.to_string() != values[2] {
        return Err(unavailable());
    }
    for value in [values[3], values[4]] {
        let decoded = decode_base64url(value).map_err(|_| unavailable())?;
        if decoded.len() != 32 || base64url(&decoded) != value {
            return Err(unavailable());
        }
    }
    Ok(())
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
            .map_err(|e| io_error(e, timeout))
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.socket.set_read_timeout(io_timeout(timeout)?)?;
        let n = self
            .socket
            .read(self.buffers.input_append_buf())
            .map_err(|e| io_error(e, timeout))?;
        self.buffers.input_appended(n);
        Ok(n > 0)
    }
    fn is_open(&mut self) -> bool {
        if self.socket.set_nonblocking(true).is_err() {
            return false;
        }
        let idle = matches!(self.socket.peek(&mut [0u8; 1]), Err(e) if e.kind() == io::ErrorKind::WouldBlock);
        self.socket.set_nonblocking(false).is_ok() && idle
    }
}
fn io_timeout(timeout: NextTimeout) -> Result<Option<Duration>, ureq::Error> {
    use ureq::unversioned::transport::time::Duration as TransportDuration;
    match timeout.after {
        TransportDuration::NotHappening => Ok(None),
        TransportDuration::Exact(d) if d.is_zero() => Err(ureq::Error::Timeout(timeout.reason)),
        TransportDuration::Exact(d) => Ok(Some(d)),
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
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Fixed native import authority TLS exchange is unavailable",
        "native_import_authority_unavailable",
    )
}
