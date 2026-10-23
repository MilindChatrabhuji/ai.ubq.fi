//! Fixed authenticated HTTP companion. No generic URL, command, file or
//! configuration ingress. Supervisor data remains readonly and source sampled.
use crate::{
    live_bridge::{NativeLiveHandler, NativeLiveUpgradeRequest},
    nonce_sqlite::SqliteNonceStore,
    owner_control::{NativeControlContext, NativeOwnerRenewalHandler},
    supervisor::{FOLLOW_MAX_DURATION_MS, FOLLOW_POLL_MS, follow_update},
    supervisor_data::SupervisorData,
    unix::UnixSupervisor,
};
use gateway_auth::{
    GatewayError,
    native::*,
    native_auth::{
        NativeAuthHeaders, NativeAuthenticator, NativeCapability, NativeTransportIdentity,
    },
    native_control::{
        NATIVE_CONTROL_MAX_BYTES, NATIVE_RENEWAL_MAX_MS, NativeControlDisposition,
        NativeControlEnvelope, NativeControlReason, NativeControlResponse,
    },
    native_live::{NATIVE_LIVE_ACTION_HEADER, NATIVE_LIVE_PATH, NativeLiveAuthenticator},
    native_replay::StoreNonceAuthority,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub struct NativeHttpService {
    identity: NativeTransportIdentity,
    nonces: SqliteNonceStore,
    data: SupervisorData,
    renewal: Option<Arc<dyn NativeOwnerRenewalHandler>>,
    live_sideband: Option<Arc<dyn NativeLiveHandler>>,
    imports: Option<Arc<dyn crate::import_ingress::ImportReceiver>>,
}
impl NativeHttpService {
    pub fn configured(
        identity: NativeTransportIdentity,
        nonces: SqliteNonceStore,
        data: SupervisorData,
    ) -> Self {
        Self {
            identity,
            nonces,
            data,
            renewal: None,
            live_sideband: None,
            imports: None,
        }
    }
    pub fn with_owner_renewal(mut self, handler: impl NativeOwnerRenewalHandler + 'static) -> Self {
        self.renewal = Some(Arc::new(handler));
        self
    }
    pub fn with_live_sideband(mut self, handler: impl NativeLiveHandler + 'static) -> Self {
        self.live_sideband = Some(Arc::new(handler));
        self
    }
    /// Fixed trusted import construction: real shared authority/owner/config, no auth callback.
    pub fn with_imports<S, I, H>(
        mut self,
        authority: gateway_authority::Authority<S, I>,
        owner: gateway_authority::native_control::RegisteredRenewalOwner,
        current_config: gateway_auth::AuthConfig,
        handler: H,
    ) -> Self
    where
        S: gateway_core::state::AuthorityStore + Send + Sync + 'static,
        I: gateway_authority::TokenSource + Send + Sync + 'static,
        H: crate::native_import::NativeImportHandler + 'static,
    {
        self.imports = Some(crate::import_ingress::configured(
            authority,
            owner,
            current_config,
            handler,
        ));
        self
    }
    pub fn serve(self, listener: TcpListener) -> Result<(), GatewayError> {
        crate::require_production_artifact()?;
        let service = Arc::new(self);
        let active = Arc::new(AtomicUsize::new(0));
        for stream in listener.incoming() {
            let stream = stream.map_err(|_| unavailable())?;
            if active.fetch_add(1, Ordering::AcqRel) >= 64 {
                active.fetch_sub(1, Ordering::AcqRel);
                let mut stream = stream;
                let _ = write_error(
                    &mut stream,
                    GatewayError::unavailable(
                        "Native listener is at capacity",
                        "native_listener_capacity",
                    ),
                );
                continue;
            }
            let service = service.clone();
            let active = active.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                if let Err(error) = service.handle(&mut stream) {
                    let _ = write_error(&mut stream, error);
                }
                active.fetch_sub(1, Ordering::AcqRel);
            });
        }
        Ok(())
    }
    pub(crate) fn serve_connection(&self, stream: &mut TcpStream) -> Result<(), GatewayError> {
        crate::require_production_artifact()?;
        if let Err(error) = self.handle(stream) {
            write_error(stream, error)?;
        }
        Ok(())
    }
    fn handle(&self, stream: &mut TcpStream) -> Result<(), GatewayError> {
        let peer = stream.peer_addr().map_err(|_| unavailable())?;
        if !peer.ip().is_loopback() {
            return Err(forbidden());
        }
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| unavailable())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| unavailable())?;
        let request = match read_request(stream)? {
            IncomingRequest::Legacy(request) => request,
            IncomingRequest::Import(head) => {
                return self.imports.as_ref().ok_or_else(unavailable)?.receive(
                    stream,
                    head,
                    &self.identity,
                    &self.nonces,
                );
            }
        };
        let live_upgrade = request.method == "GET" && request.path == NATIVE_LIVE_PATH;
        if !live_upgrade
            && (request.method != "POST"
                || !matches!(
                    request.path.as_str(),
                    NATIVE_RPC_PATH | NATIVE_FOLLOW_PATH | NATIVE_CONTROL_PATH
                ))
        {
            return Err(GatewayError::new(
                404,
                "Unknown native operation",
                Some("native_route_invalid"),
            ));
        }
        let one = |name: &str| -> Result<&str, GatewayError> {
            let values: Vec<_> = request
                .headers
                .iter()
                .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                .collect();
            if values.len() != 1 {
                return Err(forbidden());
            }
            Ok(values[0].1.as_str())
        };
        let headers = NativeAuthHeaders {
            version: one(NATIVE_VERSION_HEADER)?,
            key_id: one(NATIVE_KEY_HEADER)?,
            time_ms: one(NATIVE_TIME_HEADER)?,
            nonce: one(NATIVE_NONCE_HEADER)?,
            mac: one(NATIVE_MAC_HEADER)?,
        };
        let authority = StoreNonceAuthority::new(&self.nonces);
        if live_upgrade {
            validate_live_upgrade(&request)?;
            let action_ref = one(NATIVE_LIVE_ACTION_HEADER)?.to_owned();
            let proof = futures_executor::block_on(
                NativeLiveAuthenticator::new(&self.identity, &authority).authenticate_upgrade(
                    headers,
                    &action_ref,
                    now_ms()?,
                ),
            )?;
            let handler = self.live_sideband.as_ref().ok_or_else(unavailable)?;
            return handler
                .handle(
                    stream,
                    NativeLiveUpgradeRequest {
                        action_ref,
                        headers: request.headers,
                        buffered: request.buffered,
                    },
                    proof,
                )
                .map(|_transport_outcome| ());
        }
        let proof = futures_executor::block_on(
            NativeAuthenticator::new(&self.identity, &authority).authenticate(
                &request.path,
                headers,
                &request.body,
                now_ms()?,
            ),
        )?;
        if request.path == NATIVE_CONTROL_PATH {
            proof.require_request(
                NativeCapability::OwnerRenewal,
                NATIVE_CONTROL_PATH,
                &request.body,
                now_ms()?,
            )?;
            let envelope = NativeControlEnvelope::parse(&request.body)?;
            let disconnected = || disconnected(stream);
            let context = NativeControlContext::admitted(
                Instant::now() + Duration::from_millis(NATIVE_RENEWAL_MAX_MS as u64),
                &disconnected,
                headers,
            );
            context.check()?;
            let result = self.renewal.as_ref().map_or_else(
                || {
                    Ok(NativeControlResponse {
                        v: 1,
                        operation_id: envelope.operation_id.clone(),
                        disposition: NativeControlDisposition::Unavailable,
                        publication_revision: None,
                        reason: Some(NativeControlReason::OwnerUnavailable),
                    })
                },
                |handler| handler.renew(&proof, &envelope, &request.body, &context),
            );
            let response = match result {
                Ok(response) => response,
                Err(error) => {
                    // Never copy native/socket/provider text into a response.
                    // An unclassified handler failure is unknown, even if the
                    // caller disappeared before receiving a durable receipt.
                    let conflict = error.status == 409;
                    NativeControlResponse {
                        v: 1,
                        operation_id: envelope.operation_id.clone(),
                        disposition: if conflict {
                            NativeControlDisposition::Conflict
                        } else {
                            NativeControlDisposition::Unknown
                        },
                        publication_revision: None,
                        reason: Some(if conflict {
                            NativeControlReason::AuthorityChanged
                        } else {
                            NativeControlReason::OutcomeUnknown
                        }),
                    }
                }
            };
            response.validate_for(&envelope)?;
            let body = serde_json::to_vec(&response).map_err(|_| unavailable())?;
            let mac = self.identity.sign_control_response(
                one(NATIVE_NONCE_HEADER)?,
                &request.body,
                200,
                &body,
            )?;
            stream.write_all(format!("HTTP/1.1 200 Native\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n{NATIVE_RESPONSE_MAC_HEADER}: {mac}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).map_err(|_|unavailable())?;
            return stream.write_all(&body).map_err(|_| unavailable());
        }
        proof.require_request(
            NativeCapability::SupervisorRead,
            &request.path,
            &request.body,
            now_ms()?,
        )?;
        if request.path == NATIVE_RPC_PATH {
            let envelope: NativeRpcEnvelope =
                serde_json::from_slice(&request.body).map_err(|_| invalid())?;
            envelope.validate()?;
            let result = (|| -> Result<NativeRpcResponse, GatewayError> {
                Ok(match &envelope.request {
                    NativeReadRequest::SupervisorSessions => NativeRpcResponse {
                        v: 1,
                        status: 200,
                        body: self.data.snapshot(now_ms()?)?,
                        stream: None,
                    },
                    NativeReadRequest::SupervisorOutput {
                        source_id,
                        thread_id,
                        cursor,
                    } => {
                        self.data.select(source_id, thread_id, now_ms()?)?;
                        NativeRpcResponse {
                            v: 1,
                            status: 200,
                            body: Value::Null,
                            stream: Some(AuthStream::SupervisorFollow {
                                source_id: source_id.clone(),
                                thread_id: thread_id.clone(),
                                cursor: cursor.clone(),
                            }),
                        }
                    }
                    NativeReadRequest::SupervisorBrief {
                        source_id,
                        thread_id,
                    } => {
                        let selected = self.data.select(source_id, thread_id, now_ms()?)?;
                        let context = self.data.brief_context(&selected, now_ms()?)?;
                        NativeRpcResponse {
                            v: 1,
                            status: 200,
                            body: json!({"sampledAtMs":selected.sampled_at_ms(),"context":context}),
                            stream: None,
                        }
                    }
                })
            })();
            let result = match result {
                Ok(response) => response,
                Err(error) => NativeRpcResponse {
                    v: 1,
                    status: error.status,
                    body: serde_json::to_value(&error.envelope).map_err(|_| unavailable())?,
                    stream: None,
                },
            };
            result.validate_for(&envelope)?;
            let body = serde_json::to_vec(&result).map_err(|_| unavailable())?;
            if body.len() > NATIVE_MAX_BODY_BYTES {
                return Err(unavailable());
            }
            write_json(stream, 200, &body)
        } else {
            let descriptor: AuthStream =
                serde_json::from_slice(&request.body).map_err(|_| invalid())?;
            let AuthStream::SupervisorFollow {
                source_id,
                thread_id,
                cursor,
            } = descriptor;
            let selected = self.data.select(&source_id, &thread_id, now_ms()?)?;
            if cursor.as_ref().is_some_and(|value| value.len() > 240) {
                return Err(invalid());
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n").map_err(|_|unavailable())?;
            if send_event(stream,"ready",json!({"sourceId":source_id,"threadId":thread_id,"machine":selected.machine(),"mode":"recorded","note":"Updates as Codex records output (about every 2s), not a token-level stream. Only assistant messages and command output are shown."})).is_err(){return Ok(());}
            let started = Instant::now();
            let mut revisions = BTreeMap::new();
            let mut cursor = cursor.unwrap_or_default();
            let mut polls = 0u64;
            let mut unavailable_polls = 0u64;
            let mut last_unavailable = String::new();
            while started.elapsed().as_millis() < FOLLOW_MAX_DURATION_MS as u128 {
                if disconnected(stream) {
                    return Ok(());
                }
                let update = UnixSupervisor::configured_socket_until(
                    selected.configured_socket(),
                    Instant::now() + Duration::from_secs(4),
                )
                .and_then(|mut transport| {
                    futures_executor::block_on(follow_update(
                        &mut transport,
                        selected.known_thread(),
                        &cursor,
                        &mut revisions,
                    ))
                });
                let event = match update {
                    Ok(update) => {
                        cursor = update.cursor.clone();
                        polls += 1;
                        if !update.entries.is_empty() {
                            let entries=update.entries.iter().map(|entry|json!({"key":entry.key,"revision":entry.revision,"kind":entry.kind,"turnId":entry.turn_id,"text":entry.text,"command":entry.command,"status":entry.status,"exitCode":entry.exit_code,"atMs":entry.at_ms})).collect::<Vec<_>>();
                            Some((
                                "entries",
                                json!({"entries":entries,"cursor":cursor,"turnId":update.turn_id,"turnStatus":update.turn_status,"enriched":update.enriched,"sampledAtMs":now_ms()?}),
                            ))
                        } else if polls.is_multiple_of(5) {
                            Some((
                                "heartbeat",
                                json!({"turnId":update.turn_id,"turnStatus":update.turn_status,"sampledAtMs":now_ms()?}),
                            ))
                        } else {
                            None
                        }
                    }
                    Err(error) => {
                        unavailable_polls += 1;
                        let message = error.envelope.error.message;
                        if message != last_unavailable || unavailable_polls.is_multiple_of(5) {
                            last_unavailable = message.clone();
                            Some((
                                "unavailable",
                                json!({"message":message,"sampledAtMs":now_ms()?}),
                            ))
                        } else {
                            None
                        }
                    }
                };
                if event.is_some_and(|(name, value)| send_event(stream, name, value).is_err()) {
                    return Ok(());
                }
                let until = Instant::now() + Duration::from_millis(FOLLOW_POLL_MS);
                while Instant::now() < until {
                    if disconnected(stream) {
                        return Ok(());
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            let _ = send_event(
                stream,
                "end",
                json!({"reason":"follow duration limit reached"}),
            );
            Ok(())
        }
    }
}
struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    buffered: Vec<u8>,
}
fn validate_live_upgrade(request: &HttpRequest) -> Result<(), GatewayError> {
    let one = |name: &str| -> Result<&str, GatewayError> {
        let values = request
            .headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .collect::<Vec<_>>();
        if values.len() != 1 || values[0].1.is_empty() {
            return Err(invalid());
        }
        Ok(&values[0].1)
    };
    if !one("upgrade")?.eq_ignore_ascii_case("websocket")
        || !one("connection")?
            .split(',')
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    {
        return Err(invalid());
    }
    one("host")?;
    one("sec-websocket-key")?;
    one("sec-websocket-version")?;
    Ok(())
}
fn read_more(
    stream: &mut TcpStream,
    bytes: &mut Vec<u8>,
    deadline: Instant,
) -> Result<(), GatewayError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|value| !value.is_zero())
        .ok_or_else(invalid)?;
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| invalid())?;
    let mut buffer = [0u8; 8192];
    let count = stream.read(&mut buffer).map_err(|_| invalid())?;
    if count == 0 {
        return Err(invalid());
    }
    bytes.extend_from_slice(&buffer[..count]);
    Ok(())
}
enum IncomingRequest {
    Legacy(HttpRequest),
    Import(crate::import_ingress::ImportHead),
}
pub(crate) fn read_import_head(
    stream: &mut TcpStream,
) -> Result<crate::import_ingress::ImportHead, GatewayError> {
    match read_request(stream)? {
        IncomingRequest::Import(head) => Ok(head),
        IncomingRequest::Legacy(_) => Err(invalid()),
    }
}
fn read_request(stream: &mut TcpStream) -> Result<IncomingRequest, GatewayError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut bytes = Vec::new();
    let mut first_line_complete = false;
    let mut import_header_only = false;
    let header_end = loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            if end + 4 > 16_384 {
                return Err(invalid());
            }
            break end + 4;
        }
        if bytes.len() > 16_384 {
            return Err(invalid());
        }
        if !first_line_complete || import_header_only {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|value| !value.is_zero())
                .ok_or_else(invalid)?;
            stream
                .set_read_timeout(Some(remaining))
                .map_err(|_| invalid())?;
            let mut byte = [0u8; 1];
            if stream.read(&mut byte).map_err(|_| invalid())? == 0 {
                return Err(invalid());
            }
            bytes.push(byte[0]);
            if !first_line_complete && bytes.ends_with(b"\r\n") {
                let mut slots = [httparse::EMPTY_HEADER; 64];
                let mut line = httparse::Request::new(&mut slots);
                line.parse(&bytes).map_err(|_| invalid())?;
                import_header_only = line.path.and_then(crate::import_ingress::kind).is_some();
                first_line_complete = true;
            }
        } else {
            read_more(stream, &mut bytes, deadline)?;
        }
    };
    let mut slots = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut slots);
    if !parsed
        .parse(&bytes[..header_end])
        .map_err(|_| invalid())?
        .is_complete()
    {
        return Err(invalid());
    }
    let method = parsed.method.ok_or_else(invalid)?.to_owned();
    let path = parsed.path.ok_or_else(invalid)?.to_owned();
    let headers = parsed
        .headers
        .iter()
        .map(|header| {
            Ok((
                header.name.to_owned(),
                std::str::from_utf8(header.value)
                    .map_err(|_| invalid())?
                    .trim()
                    .to_owned(),
            ))
        })
        .collect::<Result<Vec<_>, GatewayError>>()?;
    if let Some(kind) = crate::import_ingress::kind(&path) {
        if bytes.len() != header_end || method != "POST" || parsed.version != Some(1) {
            return Err(invalid());
        }
        return Ok(IncomingRequest::Import(crate::import_ingress::ImportHead {
            kind,
            path,
            headers,
            framing_deadline: deadline,
        }));
    }
    let lengths: Vec<_> = headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .collect();
    let encodings: Vec<_> = headers
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("transfer-encoding"))
        .collect();
    if lengths.len() > 1 || encodings.len() > 1 || !lengths.is_empty() && !encodings.is_empty() {
        return Err(invalid());
    }
    if method == "GET" {
        if parsed.version != Some(1)
            || !encodings.is_empty()
            || lengths.first().is_some_and(|header| header.1 != "0")
        {
            return Err(invalid());
        }
        return Ok(IncomingRequest::Legacy(HttpRequest {
            method,
            path,
            headers,
            body: Vec::new(),
            buffered: bytes[header_end..].to_vec(),
        }));
    }
    let max_body = if path == NATIVE_CONTROL_PATH {
        NATIVE_CONTROL_MAX_BYTES
    } else {
        NATIVE_MAX_BODY_BYTES
    };
    let body = if let Some(length) = lengths.first() {
        if length.1.is_empty() || !length.1.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        let length = length.1.parse::<usize>().map_err(|_| invalid())?;
        if length > max_body {
            return Err(too_large());
        }
        while bytes.len() < header_end + length {
            read_more(stream, &mut bytes, deadline)?;
        }
        if bytes.len() != header_end + length {
            return Err(invalid());
        }
        bytes[header_end..].to_vec()
    } else if encodings
        .first()
        .is_some_and(|header| header.1.eq_ignore_ascii_case("chunked"))
    {
        let mut offset = header_end;
        let mut output = Vec::new();
        loop {
            let (header, length) = loop {
                match httparse::parse_chunk_size(&bytes[offset..]).map_err(|_| invalid())? {
                    httparse::Status::Complete(value) => break value,
                    httparse::Status::Partial => {
                        if bytes.len() - offset > 1024 {
                            return Err(invalid());
                        }
                        read_more(stream, &mut bytes, deadline)?;
                    }
                }
            };
            let length = usize::try_from(length).map_err(|_| too_large())?;
            if length > max_body - output.len() {
                return Err(too_large());
            }
            offset += header;
            while bytes.len() - offset < length + 2 {
                read_more(stream, &mut bytes, deadline)?;
            }
            if &bytes[offset + length..offset + length + 2] != b"\r\n" {
                return Err(invalid());
            }
            output.extend_from_slice(&bytes[offset..offset + length]);
            offset += length + 2;
            if length == 0 {
                if bytes.len() != offset {
                    return Err(invalid());
                }
                break;
            }
            if offset > 8192 {
                bytes.drain(..offset);
                offset = 0;
            }
        }
        output
    } else {
        return Err(invalid());
    };
    Ok(IncomingRequest::Legacy(HttpRequest {
        method,
        path,
        headers,
        body,
        buffered: Vec::new(),
    }))
}
fn too_large() -> GatewayError {
    GatewayError::new(
        413,
        "Native request body is too large",
        Some("native_body_too_large"),
    )
}

fn send_event(stream: &mut TcpStream, name: &str, value: Value) -> Result<(), GatewayError> {
    let body = serde_json::to_string(&value).map_err(|_| unavailable())?;
    stream
        .write_all(format!("event: {name}\ndata: {body}\n\n").as_bytes())
        .map_err(|_| unavailable())?;
    stream.flush().map_err(|_| unavailable())
}
pub(crate) fn disconnected(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return true;
    }
    let closed = match stream.peek(&mut [0u8; 1]) {
        Ok(0) => true,
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => false,
        Err(_) => true,
        _ => false,
    };
    let reset = stream.set_nonblocking(false);
    closed || reset.is_err()
}
fn write_json(stream: &mut TcpStream, status: u16, body: &[u8]) -> Result<(), GatewayError> {
    let mut response = format!("HTTP/1.1 {status} Native\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).into_bytes();
    response.extend_from_slice(body);
    // One framed write prevents an early refusal's body from being left behind
    // a separately flushed header when unread peer data makes close reset TCP.
    stream.write_all(&response).map_err(|_| unavailable())
}
pub(crate) fn write_error(stream: &mut TcpStream, error: GatewayError) -> Result<(), GatewayError> {
    let body = serde_json::to_vec(&error.envelope).map_err(|_| unavailable())?;
    write_json(stream, error.status, &body)
}
pub fn now_ms() -> Result<i64, GatewayError> {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| unavailable())?
        .as_millis();
    i64::try_from(value).map_err(|_| unavailable())
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Native operation is unavailable",
        "native_operation_unavailable",
    )
}
fn invalid() -> GatewayError {
    GatewayError::new(
        400,
        "Invalid native HTTP request",
        Some("native_request_invalid"),
    )
}
fn forbidden() -> GatewayError {
    GatewayError::new(
        401,
        "Native request authentication failed",
        Some("native_auth_invalid"),
    )
}

#[cfg(all(test, target_os = "linux"))]
mod owner_control_tests;

#[cfg(test)]
mod live_http_tests;

#[cfg(test)]
pub(crate) mod import_http_tests;
