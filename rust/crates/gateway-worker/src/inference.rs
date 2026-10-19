//! Actual schema -> admission -> provider -> terminal transport path.
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use futures_util::StreamExt;
use gateway_auth::AuthPrincipal;
use gateway_core::{
    GatewayError, identity::RequestId, lifecycle::SemanticTerminal, provider::UpstreamProvider,
};
use gateway_providers::{ClientSurface, ProviderEvent, StreamDecoder, decode_response};
use gateway_routing_runtime::{
    AttemptFailure, FailureOrigin, PreparedAttempt, RefusalDecision, RoutingInput, RoutingSession,
    TransportState,
};
use gateway_schema::{
    content,
    request::{self},
};
use serde_json::{Value, json};
use worker::{Context, Method, Request, Response, ResponseBody};

use crate::{
    authority::RemoteAuthorityStore,
    catalog::CatalogState,
    host::PlatformHost,
    host::{PlatformClock, PlatformTokens},
    inference_lifecycle::{Lifecycle, Session, Usage, finish_hook},
    routing_host,
    storage::now_ms,
    transport::{
        body,
        outbound::{DispatchAttempt, PinnedDestination, send_http},
        stream::{ObservationHandle, ObservedStream},
    },
};

const ATTEMPT_DEADLINE_MS: i32 = 1_800_000;

pub struct RequestResources {
    pub context: Rc<Context>,
    pub permit: Option<gateway_admission::Permit>,
}

async fn dispatch_attempts(
    session: Rc<Session>,
    cancellation: Rc<crate::transport::outbound::Cancellation>,
    capture: Rc<crate::inference_capture::Capture>,
) -> Result<(Response, PreparedAttempt), gateway_routing_runtime::RoutingError> {
    let mut pending: Option<(gateway_routing_runtime::WorkspaceContinuation, Vec<u8>)> = None;
    loop {
        let (attempt, continuation, retained_wire) =
            if let Some((continuation, wire)) = pending.take() {
                (
                    continuation.attempt().clone(),
                    Some(continuation),
                    Some(wire),
                )
            } else {
                let attempt = session.next_attempt().await?.ok_or_else(|| {
                    GatewayError::unavailable(
                        "No eligible provider remains for this request.",
                        "provider_routing_unavailable",
                    )
                })?;
                (attempt, None, None)
            };
        let continuing = continuation.is_some();
        let target = PinnedDestination::new(&attempt.request.url)?;
        let wire = match retained_wire {
            Some(wire) => wire,
            None => serde_json::to_vec(&attempt.request.body)
                .map_err(|_| invalid("Request could not be encoded."))?,
        };
        let gate_session = session.clone();
        let gate_attempt = attempt.clone();
        let gate_cancel = cancellation.clone();
        let gate_capture = capture.clone();
        let passive_trace = Rc::new(RefCell::new(None));
        let gate_trace = passive_trace.clone();
        let result = send_http(
            &target,
            Method::Post,
            &attempt.request.headers,
            &wire,
            &cancellation,
            || async move {
                if let Some(continuation) = continuation {
                    gate_session
                        .before_workspace_dispatch(continuation)
                        .await
                        .map_err(|error| *error.error)?;
                } else {
                    gate_session
                        .before_dispatch(&gate_attempt)
                        .await
                        .map_err(|error| *error.error)?;
                }
                // No await follows this real dispatch gate before the actual fetch.
                if !gate_cancel.signal().aborted() {
                    *gate_trace.borrow_mut() = gate_capture.start(gate_attempt.request.provider);
                }
                Ok(())
            },
        )
        .await;
        let trace = passive_trace.borrow_mut().take();
        let (mut response, observed_at_ms) = match result {
            Ok(response) => {
                let observed_at_ms = now_ms()?;
                let response = crate::inference_capture::upstream(
                    response,
                    trace,
                    cancellation.clone(),
                    observed_at_ms,
                )?;
                (response, observed_at_ms)
            }
            Err(failure) => {
                if let Some(trace) = trace
                    && let Ok(at) = now_ms()
                {
                    if cancellation.signal().aborted() {
                        trace.finish(
                            gateway_observability::replay_trace::TraceTerminal::Cancelled,
                            at,
                        );
                    } else {
                        trace.fetch_error(at);
                    }
                }
                let decision = session
                    .refusal(
                        &attempt,
                        AttemptFailure {
                            origin: if failure.origin
                                == crate::transport::outbound::DispatchOrigin::Gateway
                            {
                                FailureOrigin::Gateway
                            } else if cancellation.signal().aborted()
                                && !cancellation.client_aborted()
                            {
                                FailureOrigin::GatewayDeadline
                            } else {
                                FailureOrigin::Transport
                            },
                            status: None,
                            headers: Default::default(),
                            body: Vec::new(),
                            body_complete: false,
                            failure: if cancellation.client_aborted() {
                                gateway_providers::policy::HopFailure::Cancelled
                            } else if cancellation.signal().aborted() {
                                gateway_providers::policy::HopFailure::Deadline
                            } else {
                                gateway_providers::policy::HopFailure::Transport
                            },
                            transport: if continuing || failure.attempt == DispatchAttempt::Started
                            {
                                TransportState::Started
                            } else {
                                TransportState::NotStarted
                            },
                            semantic_committed: false,
                            cancelled: cancellation.signal().aborted(),
                        },
                    )
                    .await?;
                if decision == RefusalDecision::Continue {
                    continue;
                }
                return Err(failure.error.into());
            }
        };
        // Header time was captured before the first observer or ledger await.
        let status = response.status_code();
        let headers = response
            .headers()
            .entries()
            .collect::<gateway_providers::Headers>();
        if !continuing {
            session.transport_started(&attempt).await?;
        }
        let observed = session
            .observe_response(
                &attempt,
                gateway_routing_runtime::ResponseHead {
                    status,
                    headers: headers.clone(),
                    provider_request_id: correlation(attempt.request.provider, &headers)
                        .map(str::to_owned),
                    observed_at_ms,
                },
            )
            .await?;
        if status < 400 {
            session
                .resolve_response(
                    &attempt,
                    observed,
                    gateway_core::claude::ClaudeErrorEvidence::from_prefix(None, false)?,
                    None,
                )
                .await?;
            return Ok((response, attempt));
        }
        let (capture, evidence) = if attempt.request.provider == UpstreamProvider::ClaudeCode {
            let captured =
                crate::transport::claude_body::capture(&mut response, &cancellation).await;
            (
                body::ResponseCapture::default(),
                gateway_core::claude::ClaudeErrorEvidence::from_prefix(
                    captured.prefix,
                    captured.complete,
                )?,
            )
        } else {
            let capture = match (attempt.request.provider, status) {
                (UpstreamProvider::ChatgptCodex, 400) => {
                    body::refusal_probe(&mut response, &cancellation, 250).await
                }
                (UpstreamProvider::ChatgptCodex, 429)
                | (UpstreamProvider::Metered, 403)
                | (UpstreamProvider::Surplus, 402) => {
                    body::refusal_probe(
                        &mut response,
                        &cancellation,
                        body::REFUSAL_PROBE_TIMEOUT_MS,
                    )
                    .await
                }
                _ => body::ResponseCapture::default(),
            };
            (
                capture,
                gateway_core::claude::ClaudeErrorEvidence::from_prefix(None, false)?,
            )
        };
        let decision = session
            .resolve_response(
                &attempt,
                observed,
                evidence,
                Some(AttemptFailure {
                    origin: FailureOrigin::Provider,
                    status: Some(status),
                    headers,
                    body: capture.bytes,
                    body_complete: capture.complete,
                    failure: gateway_providers::policy::HopFailure::Status(status),
                    transport: TransportState::Started,
                    semantic_committed: false,
                    cancelled: cancellation.signal().aborted(),
                }),
            )
            .await;
        match decision {
            Ok(gateway_routing_runtime::ResponseDecision::Return) => {
                return Ok((response, attempt));
            }
            Ok(gateway_routing_runtime::ResponseDecision::Continue) => {
                body::discard_response(&mut response);
            }
            Ok(gateway_routing_runtime::ResponseDecision::WorkspaceContinuation(continuation)) => {
                body::discard_response(&mut response);
                pending = Some((*continuation, wire));
            }
            Err(error) => {
                body::discard_response(&mut response);
                return Err(error);
            }
        }
    }
}

pub async fn run(
    mut request: Request,
    resources: RequestResources,
    principal: &AuthPrincipal,
    store: RemoteAuthorityStore,
    catalog: CatalogState,
    host: &PlatformHost,
    request_id: RequestId,
) -> Result<Response, GatewayError> {
    let RequestResources { context, permit } = resources;
    let responses = crate::normalized_path(&request.path()) == "/v1/responses";
    let surface = if responses {
        ClientSurface::Responses
    } else {
        ClientSurface::Chat
    };
    let route = if responses {
        "responses"
    } else {
        "chat.completions"
    };
    let bytes = body::inference_bytes(&mut request).await?;
    let client_version = request
        .headers()
        .get("user-agent")
        .ok()
        .flatten()
        .and_then(|value| {
            value.strip_prefix("codex_cli_rs/").map(|value| {
                value
                    .split_whitespace()
                    .next()
                    .unwrap_or("0.100.0")
                    .to_owned()
            })
        })
        .unwrap_or_else(|| "0.100.0".into());
    let capture = crate::inference_capture::Capture::new(
        request,
        &bytes,
        store.clone(),
        host,
        context.clone(),
    );
    let result = async {
        let mut raw = request::parse_json_body(&bytes)?;
        let default = catalog
            .runtime
            .as_ref()
            .and_then(|value| value.get("default_model"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                catalog
                    .input
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.default_model())
            });
        let model = request::resolve_model(raw.get("model"), default.as_deref())?;
        raw["model"] = json!(model);
        let client_stream = request::parse_stream(raw.get("stream"))?;
        if responses {
            raw["input"] = json!(content::normalize_responses_input(raw.get("input"))?);
            request::parse_instructions(raw.get("instructions"))?;
            gateway_schema::reasoning::parse_reasoning(raw.get("reasoning"))?;
        } else {
            content::normalize_chat_messages(raw.get("messages").unwrap_or(&Value::Null))?;
            request::parse_chat_stream_options(raw.get("stream_options"))?;
            request::parse_max_completion_tokens(raw.get("max_completion_tokens"))?;
            gateway_schema::reasoning::parse_effort(
                raw.get("reasoning_effort"),
                "reasoning_effort",
            )?;
        }
        let original = gateway_core::identity::RequestContext {
            request_id,
            principal: gateway_core::identity::PrincipalId(crate::lifecycle::principal_id(
                principal,
            )),
            key_id: match &principal.method {
                gateway_auth::AuthMethod::KvApiKey { key_id, .. } => {
                    Some(gateway_core::identity::ApiKeyId(key_id.clone()))
                }
                _ => None,
            },
            route: route.to_owned(),
            started_at_ms: now_ms()?,
        };
        capture.begin(&original, &model, &raw, client_stream).await;
        let surplus_models = catalog
            .input
            .providers
            .get("surplus")
            .map(|provider| provider.models.clone())
            .unwrap_or_default();
        let session = Rc::new(
            RoutingSession::begin(
                RoutingInput {
                    context: original.clone(),
                    principal: principal.clone(),
                    raw,
                    surface,
                    catalog: catalog.input,
                    runtime: catalog.runtime,
                    client_version,
                    native_session_id: None,
                    retry_prohibited: false,
                },
                store.clone(),
                routing_host::Host::new(
                    store.clone(),
                    host.clone(),
                    context.clone(),
                    original.clone(),
                ),
                PlatformClock,
                PlatformTokens,
            )
            .await
            .map_err(|error| *error.error)?,
        );
        let deadline = host.cancellation.set_timeout_ms(ATTEMPT_DEADLINE_MS)?;
        let (mut upstream, attempt) =
            match dispatch_attempts(session.clone(), host.cancellation.clone(), capture.clone())
                .await
            {
                Ok(dispatched) => dispatched,
                Err(error) => {
                    session
                        .finish(Default::default())
                        .await
                        .map_err(|error| *error.error)?;
                    if let Some(body) = error.source_body {
                        let mut response = Response::from_bytes(body.as_bytes().to_vec())
                            .map_err(|_| invalid("The routing refusal could not be rendered."))?
                            .with_status(error.error.status);
                        response
                            .headers_mut()
                            .set("content-type", "application/json")
                            .map_err(|_| invalid("Invalid routing refusal header."))?;
                        response
                            .headers_mut()
                            .set("cache-control", "no-store")
                            .map_err(|_| invalid("Invalid routing refusal header."))?;
                        capture.immediate(error.error.status, body.as_bytes()).await;
                        for (name, value) in error.headers {
                            response
                                .headers_mut()
                                .set(&name, &value)
                                .map_err(|_| invalid("Invalid routing refusal header."))?;
                        }
                        return Ok(response);
                    }
                    return Err(*error.error);
                }
            };
        let status = upstream.status_code();
        let provider = attempt.request.decode.provider;
        let prepared = attempt.request.clone();
        let headers = upstream
            .headers()
            .entries()
            .collect::<gateway_providers::Headers>();
        capture.correlate(correlation(provider, &headers));
        let lifecycle = Rc::new(Lifecycle {
            session,
            attempt,
            provider_request_id: correlation(provider, &headers).map(str::to_owned),
            status,
            store: store.clone(),
            pricing: surplus_models
                .into_iter()
                .find(|row| {
                    row.get("id").and_then(Value::as_str)
                        == Some(prepared.decode.upstream_model.as_str())
                })
                .map(|mut row| {
                    if prepared.url.ends_with("/messages") {
                        row["require_provider_cost"] = json!(true);
                    }
                    row
                })
                .or_else(|| {
                    prepared
                        .url
                        .ends_with("/messages")
                        .then(|| json!({"require_provider_cost":true}))
                }),
        });
        let event_stream = headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("content-type") && value.contains("text/event-stream")
        });
        let observation = ObservationHandle::default();
        let usage = Rc::new(RefCell::new(None));
        let finish = finish_hook(lifecycle.clone(), usage.clone(), permit, capture.clone());
        if status >= 400 {
            capture.configure(status, event_stream, responses, provider);
            let observation = ObservationHandle::default();
            let (builder, raw_body) = upstream.into_parts();
            let source: std::pin::Pin<
                Box<dyn futures_util::Stream<Item = worker::Result<Vec<u8>>>>,
            > = match raw_body {
                ResponseBody::Empty => Box::pin(futures_util::stream::empty()),
                ResponseBody::Body(bytes) => Box::pin(futures_util::stream::iter([Ok(bytes)])),
                ResponseBody::Stream(source) => Box::pin(worker::ByteStream::from(source)),
            };
            let stream = ObservedStream::new(
                capture.client(source),
                observation,
                context,
                host.cancellation.clone(),
                Some(deadline),
                finish,
            );
            let (_, raw_body) = stream
                .into_response()
                .map_err(|_| invalid("The downstream refusal body is unavailable."))?
                .into_parts();
            let mut response = builder.body(raw_body);
            provider_correlation(&mut response, provider, &headers)?;
            apply_warnings(&mut response, &prepared.warnings)?;
            return Ok(response);
        }
        if client_stream && event_stream && status < 400 {
            capture.configure(status, true, responses, provider);
            let source = upstream
                .stream()
                .map_err(|_| invalid("Upstream stream is unavailable."))?;
            let relay = Relay {
                source,
                plan: prepared.decode.clone(),
                decoder: StreamDecoder::new(prepared.decode),
                queue: VecDeque::new(),
                done: false,
                observation: observation.clone(),
                usage,
                deadline: Some(deadline),
                cancellation: host.cancellation.clone(),
                lifecycle: lifecycle.clone(),
                next_sequence: 0,
                heartbeat: Box::pin(worker::Delay::from(std::time::Duration::from_millis(
                    gateway_providers::sse::KEEPALIVE_INTERVAL_MS,
                ))),
            };
            let source = Box::pin(futures_util::stream::unfold(
                relay,
                |mut state| async move {
                    loop {
                        if let Some(bytes) = state.queue.pop_front() {
                            return Some((Ok(bytes), state));
                        }
                        if state.done {
                            return None;
                        }
                        let incoming = {
                            match futures_util::future::select(
                                Box::pin(state.source.next()),
                                state.heartbeat.as_mut(),
                            )
                            .await
                            {
                                futures_util::future::Either::Left((incoming, _remaining)) => {
                                    Some(incoming)
                                }
                                futures_util::future::Either::Right(((), remaining)) => {
                                    drop(remaining);
                                    None
                                }
                            }
                        };
                        let Some(incoming) = incoming else {
                            state.heartbeat =
                                Box::pin(worker::Delay::from(std::time::Duration::from_millis(
                                    gateway_providers::sse::KEEPALIVE_INTERVAL_MS,
                                )));
                            return Some((Ok(b": keep-alive\n\n".to_vec()), state));
                        };
                        let result = match incoming {
                            Some(Ok(bytes)) => state.decoder.push(&bytes),
                            Some(Err(_)) => {
                                Err(invalid("Upstream Chat Completions stream failed."))
                            }
                            None => {
                                state.done = true;
                                state.decoder.finish()
                            }
                        };
                        match result {
                            Ok(events) => {
                                *state.usage.borrow_mut() = state.decoder.observed_usage().cloned();
                                if !events.is_empty() {
                                    match state.cancellation.set_timeout_ms(ATTEMPT_DEADLINE_MS) {
                                        Ok(deadline) => state.deadline = Some(deadline),
                                        Err(error) => {
                                            state.cancellation.abort();
                                            state.done = true;
                                            return Some((
                                                Err(worker::Error::RustError(
                                                    error.envelope.error.message,
                                                )),
                                                state,
                                            ));
                                        }
                                    }
                                }
                                for event in events {
                                    state.next_sequence = event
                                        .data
                                        .get("sequence_number")
                                        .and_then(Value::as_u64)
                                        .map_or(state.next_sequence + 1, |number| number + 1);
                                    observe_event(&state.observation, &event);
                                    state.queue.push_back(event.encode_sse().into_bytes());
                                }
                                let terminal_usage = state.usage.borrow().clone();
                                if state.observation.snapshot().semantic_terminal.is_some()
                                    && let Err(error) = state
                                        .lifecycle
                                        .observe_terminal(
                                            state.observation.snapshot(),
                                            terminal_usage,
                                        )
                                        .await
                                {
                                    state.done = true;
                                    state.queue.clear();
                                    return Some((
                                        Err(worker::Error::RustError(error.envelope.error.message)),
                                        state,
                                    ));
                                }
                            }
                            Err(_) => {
                                state.done = true;
                                if state.cancellation.client_aborted() {
                                    return None;
                                }
                                // Source stream-relay.failStream emits a declared
                                // failure terminal for read/truncation errors.
                                // A Rust stream exception alone tears down HTTP.
                                let event = state.failure_event();
                                state.observation.semantic_terminal(
                                    if state.plan.surface == ClientSurface::Chat {
                                        SemanticTerminal::Error
                                    } else {
                                        SemanticTerminal::Failed
                                    },
                                );
                                let terminal_usage = state.usage.borrow().clone();
                                if let Err(error) = state
                                    .lifecycle
                                    .observe_terminal(state.observation.snapshot(), terminal_usage)
                                    .await
                                {
                                    return Some((
                                        Err(worker::Error::RustError(error.envelope.error.message)),
                                        state,
                                    ));
                                }
                                return Some((Ok(event.encode_sse().into_bytes()), state));
                            }
                        }
                    }
                },
            ));
            let stream = ObservedStream::new(
                capture.client(source),
                observation,
                context,
                host.cancellation.clone(),
                None,
                finish,
            );
            let mut response = stream
                .into_response()
                .map_err(|_| invalid("The downstream stream is unavailable."))?
                .with_status(status);
            response
                .headers_mut()
                .set("Content-Type", "text/event-stream")
                .map_err(|_| invalid("Invalid response header."))?;
            copy_headers(&mut response, &headers)?;
            response
                .headers_mut()
                .set(
                    "x-uos-upstream",
                    gateway_providers::policy::direct_provider_label(provider),
                )
                .map_err(|_| invalid("Invalid response header."))?;
            provider_correlation(&mut response, provider, &headers)?;
            apply_warnings(&mut response, &prepared.warnings)?;
            return Ok(response);
        }
        let bytes = match body::response_bytes(
            &mut upstream,
            body::INFERENCE_JSON_MAX_BYTES,
            &host.cancellation.signal(),
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                lifecycle.finish(Default::default(), None).await?;
                return Err(error);
            }
        };
        let decoded = match decode_response(&prepared.decode, status, &headers, &bytes) {
            Ok(decoded) => decoded,
            Err(error) => {
                lifecycle.finish(Default::default(), None).await?;
                return Err(error);
            }
        };
        if let Some(terminal) = decoded.terminal {
            observation.semantic_terminal(terminal);
        }
        if observation.snapshot().semantic_terminal.is_some() {
            lifecycle
                .observe_terminal(observation.snapshot(), decoded.usage.clone())
                .await?;
        }
        *usage.borrow_mut() = decoded.usage;
        let payload = if client_stream && !decoded.events.is_empty() {
            decoded
                .events
                .iter()
                .map(ProviderEvent::encode_sse)
                .collect::<String>()
                .into_bytes()
        } else if let Some(raw) = decoded.raw_body {
            raw
        } else {
            serde_json::to_vec(&decoded.body)
                .map_err(|_| invalid("Upstream response cannot be encoded."))?
        };
        capture.configure(
            decoded.status,
            client_stream && !decoded.events.is_empty(),
            responses,
            provider,
        );
        let source = futures_util::stream::iter(vec![Ok(payload)]);
        let stream = ObservedStream::new(
            capture.client(source),
            observation,
            context,
            host.cancellation.clone(),
            Some(deadline),
            finish,
        );
        let mut response = stream
            .into_response()
            .map_err(|_| invalid("The downstream body is unavailable."))?
            .with_status(decoded.status);
        for (name, value) in decoded.headers {
            response
                .headers_mut()
                .set(&name, &value)
                .map_err(|_| invalid("Invalid response header."))?;
        }
        provider_correlation(&mut response, provider, &headers)?;
        apply_warnings(&mut response, &prepared.warnings)?;
        Ok(response)
    }
    .await;
    if let Err(error) = &result {
        capture
            .failure(error, host.cancellation.client_aborted())
            .await;
    }
    result
}

fn apply_warnings(response: &mut Response, warnings: &[String]) -> Result<(), GatewayError> {
    if warnings.is_empty() {
        return Ok(());
    }
    let mut values = response
        .headers()
        .get("x-uos-warning")
        .map_err(|_| invalid("Invalid provider warning header."))?
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for warning in warnings {
        if !values.contains(warning) {
            values.push(warning.clone());
        }
    }
    response
        .headers_mut()
        .set("x-uos-warning", &values.join(", "))
        .map_err(|_| invalid("Invalid provider warning header."))
}

struct Relay {
    source: worker::ByteStream,
    plan: gateway_providers::DecodePlan,
    decoder: StreamDecoder,
    queue: VecDeque<Vec<u8>>,
    done: bool,
    observation: ObservationHandle,
    usage: Usage,
    deadline: Option<crate::transport::outbound::Deadline>,
    cancellation: Rc<crate::transport::outbound::Cancellation>,
    lifecycle: Rc<Lifecycle>,
    next_sequence: u64,
    heartbeat: std::pin::Pin<Box<worker::Delay>>,
}

impl Relay {
    fn failure_event(&self) -> ProviderEvent {
        let code = match self.plan.provider {
            UpstreamProvider::Deepseek => "deepseek_upstream_stream_error",
            UpstreamProvider::Lithos => "lithos_upstream_stream_error",
            _ => "upstream_stream_error",
        };
        let error = json!({"code":code,"message":"Upstream Chat Completions stream failed."});
        if self.plan.surface == ClientSurface::Chat {
            ProviderEvent::chat(json!({"error":error}))
        } else {
            ProviderEvent::responses(
                json!({"type":"response.failed","sequence_number":self.next_sequence,"response":{"id":self.plan.response_id,"object":"response","status":"failed","error":error}}),
            )
        }
    }
}

fn observe_event(observation: &ObservationHandle, event: &ProviderEvent) {
    let terminal = match event.data.get("type").and_then(Value::as_str) {
        Some("response.completed") => Some(SemanticTerminal::Completed),
        Some("response.incomplete") => Some(SemanticTerminal::Incomplete),
        Some("response.failed") => Some(SemanticTerminal::Failed),
        Some("error") => Some(SemanticTerminal::Error),
        _ if event.data.get("error").is_some() => Some(SemanticTerminal::Error),
        _ => event
            .data
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find_map(
                |choice| match choice.get("finish_reason").and_then(Value::as_str) {
                    Some("stop" | "tool_calls" | "function_call") => {
                        Some(SemanticTerminal::Completed)
                    }
                    Some("length" | "content_filter") => Some(SemanticTerminal::Incomplete),
                    _ => None,
                },
            ),
    };
    if let Some(terminal) = terminal {
        observation.semantic_terminal(terminal);
    }
}

fn copy_headers(
    response: &mut Response,
    headers: &gateway_providers::Headers,
) -> Result<(), GatewayError> {
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if lower == "retry-after"
            || lower.starts_with("x-ratelimit-")
            || [
                "x-request-id",
                "request-id",
                "x-uos-warning",
                "x-should-retry",
            ]
            .contains(&lower.as_str())
        {
            response
                .headers_mut()
                .set(name, value)
                .map_err(|_| invalid("Invalid response header."))?;
        }
    }
    Ok(())
}

fn correlation(provider: UpstreamProvider, headers: &gateway_providers::Headers) -> Option<&str> {
    let names: &[&str] = if provider == UpstreamProvider::Deepseek {
        &["x-request-id", "x-ds-request-id", "x-deepseek-request-id"]
    } else if provider == UpstreamProvider::Cerebras {
        &[
            "x-request-id",
            "x-api-request-id",
            "x-oneapi-request-id",
            "x-cerebras-request-id",
        ]
    } else {
        &["x-request-id", "request-id"]
    };
    names
        .iter()
        .find_map(|wanted| {
            headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
                .map(|(_, value)| value.trim())
        })
        .filter(|id| {
            !id.is_empty() && id.len() <= 256 && !id.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        })
}

fn provider_correlation(
    response: &mut Response,
    provider: UpstreamProvider,
    headers: &gateway_providers::Headers,
) -> Result<(), GatewayError> {
    let id = correlation(provider, headers);
    for name in [
        "x-request-id",
        "x-api-request-id",
        "x-oneapi-request-id",
        "x-cerebras-request-id",
        "x-ds-request-id",
        "x-deepseek-request-id",
        "x-uos-provider-request-id",
        "request-id",
    ] {
        response
            .headers_mut()
            .delete(name)
            .map_err(|_| invalid("Invalid response header."))?;
    }
    if let Some(id) = id {
        response
            .headers_mut()
            .set("x-uos-provider-request-id", id)
            .map_err(|_| invalid("Invalid response header."))?;
    }
    Ok(())
}

fn invalid(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("upstream_transport_error"))
}
