//! Passive request-owned replay evidence. It never authorizes dispatch or settlement.
use futures_util::Stream;
use gateway_core::{
    GatewayError,
    lifecycle::{BodyOutcome, ReaderTermination, SemanticTerminal, TransportObservation},
    provider::UpstreamProvider,
    source_json::SourceJson,
};
use gateway_observability::{
    replay_producer::{ClientFailureObservation, FailureObservation, should_persist},
    replay_trace::{AttemptTrace, TraceProvider, TraceRecorder, TraceTerminal},
};
use gateway_providers::sse::{
    MAX_CHAT_EVENT_BYTES, MAX_RESPONSES_EVENT_BYTES, SseFrame, SseParser,
};
use std::{
    cell::{Cell, RefCell},
    pin::Pin,
    rc::Rc,
    task::{Context, Poll},
};
use worker::{Request, Response, ResponseBody};

use crate::{
    authority::RemoteAuthorityStore,
    host::PlatformHost,
    observability_host::{self, CaptureInput},
    storage::now_ms,
    transport::outbound::Cancellation,
};

pub struct Capture {
    runtime: observability_host::Runtime,
    request_id: String,
    request: Request,
    trace: TraceRecorder,
    trace_valid: Cell<bool>,
    finished: Cell<bool>,
    client: RefCell<ClientWire>,
}
struct ClientWire {
    status: u16,
    stream: bool,
    provider: String,
    parser: Option<SseParser>,
    valid: bool,
    terminal: Option<String>,
    error_code: Option<String>,
    error_param: Option<String>,
    body: Vec<u8>,
    body_bytes: usize,
}
impl Capture {
    pub fn new(
        request: Request,
        original: &[u8],
        store: RemoteAuthorityStore,
        platform: &PlatformHost,
        context: Rc<worker::Context>,
    ) -> Rc<Self> {
        Rc::new(Self {
            request_id: platform.request_id.0.clone(),
            runtime: observability_host::bind(
                &platform.request_id,
                original,
                store,
                platform,
                context,
            ),
            request,
            trace: TraceRecorder::default(),
            trace_valid: Cell::new(true),
            finished: Cell::new(false),
            client: RefCell::new(ClientWire {
                status: 500,
                stream: false,
                provider: "gateway".into(),
                parser: None,
                valid: true,
                terminal: None,
                error_code: None,
                error_param: None,
                body: Vec::new(),
                body_bytes: 0,
            }),
        })
    }
    pub fn start(&self, provider: UpstreamProvider) -> Option<AttemptTrace> {
        self.client.borrow_mut().provider =
            gateway_providers::policy::direct_provider_label(provider).into();
        let provider = match provider {
            UpstreamProvider::ChatgptCodex => TraceProvider::ChatgptCodex,
            UpstreamProvider::Surplus => TraceProvider::Surplus,
            UpstreamProvider::Metered => TraceProvider::Metered,
            UpstreamProvider::Cerebras => TraceProvider::Cerebras,
            UpstreamProvider::Deepseek => TraceProvider::Deepseek,
            UpstreamProvider::Lithos => TraceProvider::Lithos,
            UpstreamProvider::Openrouter => TraceProvider::Openrouter,
            UpstreamProvider::ClaudeCode => TraceProvider::ClaudeCode,
            _ => {
                self.trace_valid.set(false);
                return None;
            }
        };
        match now_ms() {
            Ok(at) => Some(self.trace.start(provider, at)),
            Err(_) => {
                self.trace_valid.set(false);
                None
            }
        }
    }
    pub fn configure(
        &self,
        status: u16,
        stream: bool,
        responses: bool,
        provider: UpstreamProvider,
    ) {
        let mut client = self.client.borrow_mut();
        client.status = status;
        client.stream = stream;
        client.provider = gateway_providers::policy::direct_provider_label(provider).into();
        client.parser = stream.then(|| {
            SseParser::new(if responses {
                MAX_RESPONSES_EVENT_BYTES
            } else {
                MAX_CHAT_EVENT_BYTES
            })
        });
    }
    pub fn client<S>(self: &Rc<Self>, source: S) -> ClientStream<S> {
        ClientStream {
            source,
            capture: self.clone(),
        }
    }
    fn bytes(&self, bytes: &[u8]) {
        let mut client = self.client.borrow_mut();
        client.body_bytes = client.body_bytes.saturating_add(bytes.len());
        let keep = bytes
            .len()
            .min(65_536usize.saturating_sub(client.body.len()));
        client.body.extend_from_slice(&bytes[..keep]);
        if let Some(parser) = &mut client.parser {
            match parser.push(bytes) {
                Ok(frames) => {
                    for frame in frames {
                        client.frame(frame)
                    }
                }
                Err(_) => client.valid = false,
            }
        }
    }
    pub async fn finish(&self, observation: TransportObservation) {
        if self.finished.replace(true) {
            return;
        }
        let result = self.persist(observation).await;
        if let Err(error) = result {
            worker::console_error!(
                "Failure capture remains unavailable: {}",
                error.envelope.error.message
            );
        }
        self.trace.dispose();
    }
    pub async fn failure(&self, error: &GatewayError, cancelled: bool) {
        if self.finished.replace(true) {
            return;
        }
        let internal = FailureObservation {
            status: error.status,
            stream: None,
            completed: false,
            terminal_type: Some(if cancelled { "cancelled" } else { "error" }.into()),
            failure_kind: Some("GatewayError".into()),
            synthetic_terminal_type: None,
            provider_route: self.client.borrow().provider.clone(),
        };
        let mut client = ClientFailureObservation::from_internal(&internal);
        client.error_code = error.envelope.error.code.clone();
        client.error_param = error.envelope.error.param.clone().flatten();
        if let Err(error) = self.store(internal, client).await {
            worker::console_error!(
                "Failure capture remains unavailable: {}",
                error.envelope.error.message
            );
        }
        self.trace.dispose();
    }
    pub async fn immediate(&self, status: u16, body: &[u8]) {
        {
            let mut wire = self.client.borrow_mut();
            wire.status = status;
            wire.stream = false;
            wire.parser = None;
        }
        self.bytes(body);
        self.finish(TransportObservation::default()).await;
    }
    async fn persist(&self, observation: TransportObservation) -> Result<(), GatewayError> {
        let (internal, client) = {
            let mut wire = self.client.borrow_mut();
            if let Some(parser) = &mut wire.parser {
                match parser.finish() {
                    Ok(frames) => {
                        for frame in frames {
                            wire.frame(frame)
                        }
                    }
                    Err(_) => wire.valid = false,
                }
            }
            let cancelled = observation.reader_termination == Some(ReaderTermination::Cancelled);
            let terminal = if cancelled {
                Some("cancelled".into())
            } else {
                observation
                    .semantic_terminal
                    .map(|v| {
                        match v {
                            SemanticTerminal::Completed => "response.completed",
                            SemanticTerminal::Failed => "response.failed",
                            SemanticTerminal::Incomplete => "response.incomplete",
                            SemanticTerminal::Error => "error",
                        }
                        .into()
                    })
                    .or_else(|| match observation.reader_termination {
                        Some(ReaderTermination::ReadError) => Some("error".into()),
                        Some(ReaderTermination::Deadline) => Some("deadline".into()),
                        Some(ReaderTermination::Eof) if wire.stream => Some("eof".into()),
                        _ => None,
                    })
            };
            let completed = observation.semantic_terminal == Some(SemanticTerminal::Completed);
            let failure = match observation.reader_termination {
                Some(ReaderTermination::ReadError) => Some("gateway_stream_read_error".into()),
                Some(ReaderTermination::Deadline) => Some("gateway_timeout".into()),
                _ => None,
            };
            let internal = FailureObservation {
                status: wire.status,
                stream: Some(wire.stream),
                completed,
                terminal_type: terminal,
                failure_kind: failure,
                synthetic_terminal_type: None,
                provider_route: wire.provider.clone(),
            };
            let mut client = ClientFailureObservation::from_internal(&internal);
            // This is actual parsed protocol evidence, never a delivery receipt.
            client.framing_valid = !wire.stream || (wire.valid && wire.terminal.is_some());
            client.completed =
                completed && observation.body == Some(BodyOutcome::Drained) && client.framing_valid;
            if wire.stream {
                client.terminal_type = wire.terminal.clone().or(client.terminal_type);
            }
            client.error_code = wire.error_code.clone();
            client.error_param = wire.error_param.clone();
            if wire.status >= 400
                || wire.terminal.as_deref().is_some_and(|v| {
                    matches!(v, "error" | "response.failed" | "response.incomplete")
                })
            {
                client.observed_body(&wire.body);
                client.terminal_body_truncated = wire.body_bytes > wire.body.len();
            }
            client.prefer_internal_cause(&internal);
            (internal, client)
        };
        self.store(internal, client).await
    }
    async fn store(
        &self,
        internal: FailureObservation,
        client: ClientFailureObservation,
    ) -> Result<(), GatewayError> {
        if !should_persist(&internal, &client) {
            return Ok(());
        }
        if !self.trace_valid.get() {
            return Err(GatewayError::unavailable(
                "The actual upstream trace is incomplete.",
                "replay_trace_unavailable",
            ));
        }
        match observability_host::capture_input(&self.runtime, &self.request, self.trace.seal())? {
            CaptureInput::Ready(input) => {
                let _disposition =
                    observability_host::persist_failure(&self.runtime, input, internal, client)
                        .await?;
            }
            CaptureInput::Omitted(reason) => {
                self.runtime
                    .record_capture_omission(&self.request_id, reason)
                    .await?
            }
        }
        Ok(())
    }
}
fn field(value: &SourceJson, name: &str) -> Option<SourceJson> {
    value
        .object_entries()
        .ok()?
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, value)| value)
}
impl ClientWire {
    fn frame(&mut self, frame: SseFrame) {
        if frame.data.trim() == "[DONE]" {
            self.terminal.get_or_insert_with(|| "done".into());
            return;
        }
        if frame.data.is_empty() {
            return;
        }
        let Ok(value) = SourceJson::parse(&frame.data) else {
            self.valid = false;
            return;
        };
        let kind = field(&value, "type").and_then(|v| v.deserialize::<String>().ok());
        if let Some(kind) = kind.filter(|v| {
            matches!(
                v.as_str(),
                "response.completed" | "response.failed" | "response.incomplete" | "error"
            )
        }) {
            self.terminal = Some(kind);
        }
        let error = field(&value, "error")
            .or_else(|| field(&value, "response").and_then(|response| field(&response, "error")));
        if let Some(error) = error {
            self.error_code = field(&error, "code").and_then(|v| v.deserialize::<String>().ok());
            self.error_param = field(&error, "param").and_then(|v| v.deserialize::<String>().ok());
        }
    }
}

pub struct ClientStream<S> {
    source: S,
    capture: Rc<Capture>,
}
impl<S: Stream<Item = worker::Result<Vec<u8>>> + Unpin> Stream for ClientStream<S> {
    type Item = worker::Result<Vec<u8>>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.source).poll_next(context) {
            Poll::Ready(Some(Ok(bytes))) => {
                self.capture.bytes(&bytes);
                Poll::Ready(Some(Ok(bytes)))
            }
            other => other,
        }
    }
}
struct UpstreamStream {
    source: worker::ByteStream,
    trace: AttemptTrace,
    cancellation: Rc<Cancellation>,
    done: bool,
}
impl Stream for UpstreamStream {
    type Item = worker::Result<Vec<u8>>;
    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let result = Pin::new(&mut self.source).poll_next(context);
        if let Ok(at) = now_ms() {
            match &result {
                Poll::Ready(Some(Ok(bytes))) => self.trace.consumed(bytes, at),
                Poll::Ready(Some(Err(_))) => {
                    self.done = true;
                    self.trace.finish(
                        if self.cancellation.signal().aborted() {
                            TraceTerminal::Cancelled
                        } else {
                            TraceTerminal::ReadError
                        },
                        at,
                    );
                }
                Poll::Ready(None) => {
                    self.done = true;
                    self.trace.finish(TraceTerminal::Eof, at);
                }
                _ => {}
            }
        }
        result
    }
}
impl Drop for UpstreamStream {
    fn drop(&mut self) {
        if !self.done
            && let Ok(at) = now_ms()
        {
            self.trace.finish(TraceTerminal::Cancelled, at);
        }
    }
}

pub fn upstream(
    mut response: Response,
    trace: Option<AttemptTrace>,
    cancellation: Rc<Cancellation>,
    observed_at_ms: i64,
) -> Result<Response, GatewayError> {
    let Some(trace) = trace else {
        return Ok(response);
    };
    let headers = response.headers().entries().collect();
    trace.headers(
        response.status_code(),
        &headers,
        observed_at_ms,
        matches!(response.body(), ResponseBody::Empty),
    );
    if matches!(response.body(), ResponseBody::Empty) {
        return Ok(response);
    }
    let status = response.status_code();
    let headers = response.headers().clone();
    let source = response.stream().map_err(|_| {
        GatewayError::unavailable("The upstream stream is unavailable.", "upstream_read_error")
    })?;
    Response::from_stream(UpstreamStream {
        source,
        trace,
        cancellation,
        done: false,
    })
    .map(|response| response.with_status(status).with_headers(headers))
    .map_err(|_| {
        GatewayError::unavailable("The upstream stream is unavailable.", "upstream_read_error")
    })
}
