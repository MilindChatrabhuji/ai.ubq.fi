//! Passive request-owned replay evidence. It never authorizes dispatch or settlement.
use futures_util::Stream;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    lifecycle::{BodyOutcome, ReaderTermination, SemanticTerminal, TransportObservation},
    model::ModelId,
    provider::UpstreamProvider,
    source_json::SourceJson,
    source_serialization as source,
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
    local_completed: Cell<bool>,
    terminal_request: RefCell<Option<TerminalRequest>>,
    provider_request_id: RefCell<Option<String>>,
    client: RefCell<ClientWire>,
}
#[derive(Clone)]
struct TerminalRequest {
    context: gateway_core::identity::RequestContext,
    model: Option<JsString16>,
    reasoning: Option<JsString16>,
    prompt_cache_key_present: bool,
}
struct ClientWire {
    status: u16,
    stream: bool,
    provider: String,
    parser: Option<SseParser>,
    valid: bool,
    terminal: Option<String>,
    error_code: Option<String>,
    error_param: Option<JsString16>,
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
            local_completed: Cell::new(false),
            terminal_request: RefCell::new(None),
            provider_request_id: RefCell::new(None),
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
    pub async fn begin(
        &self,
        context: &gateway_core::identity::RequestContext,
        model: &ModelId,
        raw: &SourceJson,
        stream: bool,
    ) {
        if let Some(request) = self.terminal_request.borrow_mut().as_mut() {
            request.model = Some(model.as_js_string().clone());
        }
        self.begin_request(context, Some(model.as_js_string()), raw, stream)
            .await;
    }
    pub(crate) async fn begin_local(
        &self,
        context: &gateway_core::identity::RequestContext,
        raw: &SourceJson,
        stream: bool,
    ) {
        let model = source::member(raw, "model")
            .as_ref()
            .and_then(source::string);
        self.begin_request(context, model.as_ref(), raw, stream)
            .await;
    }
    async fn begin_request(
        &self,
        context: &gateway_core::identity::RequestContext,
        model: Option<&JsString16>,
        raw: &SourceJson,
        stream: bool,
    ) {
        if self.terminal_request.borrow().is_some() {
            return;
        }
        let reasoning = source::member(raw, "reasoning")
            .and_then(|value| source::member(&value, "effort"))
            .and_then(|value| source::string(&value))
            .or_else(|| {
                source::member(raw, "reasoning_effort").and_then(|value| source::string(&value))
            });
        let prompt_cache_key_present = source::member(raw, "prompt_cache_key")
            .and_then(|value| source::string(&value))
            .is_some_and(|key| {
                key.as_units().iter().any(|unit| {
                    !char::from_u32(u32::from(*unit))
                        .is_some_and(gateway_schema::util::js_whitespace)
                })
            });
        *self.terminal_request.borrow_mut() = Some(TerminalRequest {
            context: context.clone(),
            model: model.cloned(),
            reasoning: reasoning.clone(),
            prompt_cache_key_present,
        });
        if let Some(key) = &context.key_id {
            let result = async {
                // This generated scalar metadata is not an original request/body shadow.
                let scalar = serde_json::json!({"id":context.request_id.0,"key_id":key.0,"route":context.route,"path":crate::normalized_path(&self.request.path()),"method":self.request.method().to_string(),"created_at_ms":context.started_at_ms,"status_code":0,"stream":stream});
                let scalar = SourceJson::from_serializable(&scalar)?;
                let mut fields = scalar.object_entries()?;
                fields.push((JsString16::from_utf8("model"), SourceJson::from_serializable(&model)?));
                fields.push((JsString16::from_utf8("reasoning"), SourceJson::from_serializable(&reasoning)?));
                let record = source::object_keys(fields)?;
                self.runtime.record_request_log_source(&key.0, &record).await
            }.await;
            if let Err(error) = result {
                worker::console_error!(
                    "Request log creation remains unavailable: {}",
                    error.envelope.error.message
                );
            }
        }
    }

    async fn record_terminal(
        &self,
        observation: TransportObservation,
        usage: Option<&serde_json::Value>,
        paid: Option<&gateway_authority::paid::PaidAttempt>,
    ) {
        let Some(request) = self.terminal_request.borrow().clone() else {
            return;
        };
        let (status, provider, stream, observed_terminal) = {
            let wire = self.client.borrow();
            (
                wire.status,
                wire.provider.clone(),
                wire.stream,
                wire.terminal.clone(),
            )
        };
        let extracted = gateway_core::source_usage::extract_usage_tokens(usage);
        let completed = self.local_completed.get() || source_completed(observation);
        let mut event = gateway_observability::prompt::PromptEvent {
            provider: Some(provider.clone()),
            model: request.model.clone(),
            route: request.context.route.clone(),
            status,
            completed,
            usage_telemetry_status: "missing".into(),
            input_tokens: None,
            cached_input_tokens: None,
            cache_write_input_tokens: None,
            cache_write_tokens_present: false,
            prompt_cache_key_present: request.prompt_cache_key_present,
            prompt_cache_mode: None,
            fallback_reason: None,
        };
        event.set_source_usage(extracted.as_ref());
        let _telemetry = self
            .runtime
            .record_prompt_telemetry(&event, env!("UOS_RUST_BUILD_GIT_SHA"))
            .await;
        let _analytics = self
            .runtime
            .record_prompt_analytics(&event, env!("UOS_RUST_BUILD_GIT_SHA"))
            .await;
        if let Err(error) = self
            .runtime
            .record_terminal_usage_rollup(
                gateway_observability::ledger::terminal_rollup::TerminalUsageRollup {
                    model: request.model.as_ref(),
                    provider: Some(&provider),
                    request_id: &self.request_id,
                    request_created_at_ms: Some(request.context.started_at_ms as f64),
                    usage: extracted.as_ref(),
                },
            )
            .await
        {
            worker::console_error!(
                "Terminal usage rollup remains unavailable: {}",
                error.envelope.error.message
            );
        }
        let error_observation = async {
            let at = now_ms()?;
            let terminal = observation
                .semantic_terminal
                .map(|terminal| {
                    match terminal {
                        SemanticTerminal::Completed => "response.completed",
                        SemanticTerminal::Failed => "response.failed",
                        SemanticTerminal::Incomplete => "response.incomplete",
                        SemanticTerminal::Error => "error",
                    }
                    .to_owned()
                })
                .or(observed_terminal)
                .or_else(|| match observation.reader_termination {
                    Some(ReaderTermination::ReadError) => Some("error".into()),
                    Some(ReaderTermination::Deadline) => Some("deadline".into()),
                    Some(ReaderTermination::Eof) if stream => Some("eof".into()),
                    _ => None,
                });
            let failure_kind = match observation.reader_termination {
                Some(ReaderTermination::ReadError) => Some("gateway_stream_read_error".into()),
                Some(ReaderTermination::Deadline) => Some("gateway_timeout".into()),
                _ => None,
            };
            self.runtime
                .record_admin_error(&gateway_observability::ledger::ErrorObservation {
                    request_id: self.request_id.clone(),
                    route: request.context.route.clone(),
                    status,
                    provider: provider.clone(),
                    model: request.model.clone(),
                    reasoning: request.reasoning.clone(),
                    stream: Some(stream),
                    terminal_type: terminal,
                    failure_kind,
                    delivery_outcome: observation.delivery,
                    created_at_ms: at,
                    latency_ms: at.saturating_sub(request.context.started_at_ms).max(0),
                    git_sha: Some(env!("UOS_RUST_BUILD_GIT_SHA").into()),
                    deno_revision: Some(env!("UOS_RUST_BUILD_DEPLOYMENT_ID").into()),
                })
                .await
        }
        .await;
        if let Err(error) = error_observation {
            worker::console_error!(
                "Administrative error observation remains unavailable: {}",
                error.envelope.error.message
            );
        }
        if let Some(key) = &request.context.key_id {
            let result = async {
                let at = now_ms()?;
                let mut patch = serde_json::json!({"status_code":status,"provider":provider,"completed_at_ms":at,"latency_ms":at.saturating_sub(request.context.started_at_ms).max(0),"input_tokens":extracted.as_ref().and_then(|usage|usage.input_tokens),"output_tokens":extracted.as_ref().and_then(|usage|usage.output_tokens),"provider_request_id":self.provider_request_id.borrow().clone()});
                if let Some(paid) = paid {
                    let billing = match paid.billing_state { gateway_core::lifecycle::BillingState::Pending => "pending", gateway_core::lifecycle::BillingState::Settled => "reconciled", gateway_core::lifecycle::BillingState::NotBilled => "not_billed", gateway_core::lifecycle::BillingState::Unresolved => "unresolved" };
                    patch["billing_status"] = serde_json::json!(billing);
                    patch["provider_request_id"] = serde_json::json!(paid.provider_request_id);
                    patch["provider_quota"] = serde_json::json!(paid.provider_quota);
                    patch["quota_per_credit"] = serde_json::json!(paid.quota_per_credit);
                    patch["spend_microcredits"] = serde_json::json!(paid.spend_microcredits);
                    patch["paid_fallback_window_reset_at_ms"] = serde_json::json!(paid.reservation.window_reset_at_ms);
                } else if matches!(provider.as_str(), "surplus" | "metered") { patch["billing_status"] = serde_json::json!("unresolved"); }
                let scalar = SourceJson::from_serializable(&patch)?;
                let mut fields = scalar.object_entries()?;
                fields.push((JsString16::from_utf8("model"), SourceJson::from_serializable(&request.model)?));
                fields.push((JsString16::from_utf8("reasoning"), SourceJson::from_serializable(&request.reasoning)?));
                let patch = source::object_keys(fields)?;
                self.runtime.update_request_log_source(&key.0, request.context.started_at_ms, &self.request_id, &patch).await
            }.await;
            if let Err(error) = result {
                worker::console_error!(
                    "Request terminal log remains unavailable: {}",
                    error.envelope.error.message
                );
            }
        }
    }

    pub fn correlate(&self, provider_request_id: Option<&str>) {
        *self.provider_request_id.borrow_mut() = provider_request_id.map(str::to_owned);
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
    /// Only the genuine K2 one-shot wire choice supplies local completion data.
    pub(crate) fn configure_local(&self, status: u16, stream: bool, completed: bool) {
        self.local_completed.set(completed);
        let mut client = self.client.borrow_mut();
        client.status = status;
        client.stream = stream;
        client.provider = "gateway".into();
        client.parser = stream.then(|| SseParser::new(MAX_RESPONSES_EVENT_BYTES));
    }
    pub(crate) async fn finish_local(&self, observation: TransportObservation) {
        self.finish(observation, None, None).await;
    }
    pub(crate) async fn finish_buffered_local(&self, response: &Response) {
        if let ResponseBody::Body(bytes) = response.body() {
            self.bytes(bytes);
        }
        // A buffered value being ready is not an actual transport delivery receipt.
        self.finish_local(TransportObservation::default()).await;
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
    pub async fn finish(
        &self,
        observation: TransportObservation,
        usage: Option<&serde_json::Value>,
        paid: Option<&gateway_authority::paid::PaidAttempt>,
    ) {
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
        self.record_terminal(observation, usage, paid).await;
        self.trace.dispose();
    }
    pub async fn failure(&self, error: &GatewayError, cancelled: bool) {
        if self.finished.replace(true) {
            return;
        }
        self.client.borrow_mut().status = error.status;
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
        client.error_param = error
            .envelope
            .error
            .param
            .as_ref()
            .and_then(|value| value.as_ref())
            .map(|value| JsString16::from_utf8(value));
        if let Err(error) = self.store(internal, client).await {
            worker::console_error!(
                "Failure capture remains unavailable: {}",
                error.envelope.error.message
            );
        }
        self.record_terminal(TransportObservation::default(), None, None)
            .await;
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
        self.finish(TransportObservation::default(), None, None)
            .await;
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
            let completed = self.local_completed.get() || source_completed(observation);
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
                    .await?;
            }
        }
        Ok(())
    }
}
fn source_completed(observation: TransportObservation) -> bool {
    observation.semantic_terminal == Some(SemanticTerminal::Completed)
        && !matches!(
            observation.reader_termination,
            Some(
                ReaderTermination::ReadError
                    | ReaderTermination::Cancelled
                    | ReaderTermination::Deadline
            )
        )
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
            self.error_param =
                field(&error, "param").and_then(|v| v.deserialize::<JsString16>().ok());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observed_completion_never_hides_a_reader_failure() {
        let mut observation = TransportObservation {
            semantic_terminal: Some(SemanticTerminal::Completed),
            reader_termination: Some(ReaderTermination::Eof),
            ..Default::default()
        };
        assert!(source_completed(observation));
        for end in [
            ReaderTermination::ReadError,
            ReaderTermination::Cancelled,
            ReaderTermination::Deadline,
        ] {
            observation.reader_termination = Some(end);
            assert!(!source_completed(observation));
        }
    }

    fn wire() -> ClientWire {
        ClientWire {
            status: 200,
            stream: true,
            provider: "gateway".into(),
            parser: None,
            valid: true,
            terminal: None,
            error_code: None,
            error_param: None,
            body: Vec::new(),
            body_bytes: 0,
        }
    }

    #[test]
    fn actual_client_failure_frame_preserves_terminal_and_error_fields() {
        let mut client = wire();
        let mut parser = SseParser::new(MAX_RESPONSES_EVENT_BYTES);
        for frame in parser.push(br#"data: {"type":"response.failed","response":{"error":{"code":"actual_failure","param":"input"}}}

"#).unwrap() { client.frame(frame); }
        assert!(client.valid);
        assert_eq!(client.terminal.as_deref(), Some("response.failed"));
        assert_eq!(client.error_code.as_deref(), Some("actual_failure"));
        assert_eq!(client.error_param, Some(JsString16::from_utf8("input")));
    }

    #[test]
    fn actual_client_error_param_retains_lone_units_before_policy_filter() {
        let mut client = wire();
        let mut parser = SseParser::new(MAX_RESPONSES_EVENT_BYTES);
        for frame in parser
            .push(
                br#"data: {"type":"response.failed","response":{"error":{"param":"i\ud800"}}}

"#,
            )
            .unwrap()
        {
            client.frame(frame);
        }
        assert!(client.valid);
        assert_eq!(
            client.error_param,
            Some(JsString16::from_units(vec![105, 0xd800]))
        );
    }

    #[test]
    fn malformed_client_frame_and_raw_eof_do_not_mint_completion() {
        let mut client = wire();
        let mut parser = SseParser::new(MAX_RESPONSES_EVENT_BYTES);
        for frame in parser.push(b"data: not-json\n\n").unwrap() {
            client.frame(frame);
        }
        for frame in parser.finish().unwrap() {
            client.frame(frame);
        }
        assert!(!client.valid);
        assert!(client.terminal.is_none());
    }
}
