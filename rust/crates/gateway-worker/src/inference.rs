//! Actual schema -> admission -> provider -> terminal transport path.
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use futures_util::StreamExt;
use gateway_auth::AuthPrincipal;
use gateway_core::{
    GatewayError, identity::RequestId, lifecycle::SemanticTerminal, provider::UpstreamProvider,
};
use gateway_providers::{ClientSurface, ProviderEvent, StreamDecoder, decode_response};
use gateway_routing_runtime::{
    session::RoutingSession,
    types::{
        AttemptFailure, FailureOrigin, PreparedAttempt, RefusalDecision, RoutingInput,
        TransportState,
    },
};
use gateway_schema::source_request::{SourceRequestDocument, parse_http_body};
use serde_json::json;
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
        outbound::{DispatchAttempt, PinnedDestination, send_constructed, send_http},
        relay_delay::RelayDelay,
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
    routing: routing_host::Host,
    cancellation: Rc<crate::transport::outbound::Cancellation>,
    capture: Rc<crate::inference_capture::Capture>,
) -> Result<(Response, PreparedAttempt), gateway_routing_runtime::types::RoutingError> {
    let mut pending: Option<(
        gateway_routing_runtime::types::WorkspaceContinuation,
        Vec<u8>,
    )> = None;
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
        let target = PinnedDestination::new(attempt.request.url())?;
        let wire = match retained_wire {
            Some(wire) => wire,
            None => attempt.request.body().as_bytes().to_vec(),
        };
        let gate_session = session.clone();
        let gate_attempt = attempt.clone();
        let gate_cancel = cancellation.clone();
        let gate_capture = capture.clone();
        let passive_trace = Rc::new(RefCell::new(None));
        let gate_trace = passive_trace.clone();
        // Claude actual body exists before any same-binding material/host constructor.
        let physical = match &attempt.request {
            gateway_routing_runtime::types::PreparedWireRequest::Claude(_) => {
                Some(routing.physical_claude(&attempt)?)
            }
            gateway_routing_runtime::types::PreparedWireRequest::Ready(_) => None,
        };
        let before_dispatch = || async move {
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
                *gate_trace.borrow_mut() = gate_capture.start(gate_attempt.request.provider());
            }
            Ok(())
        };
        let result = match &attempt.request {
            gateway_routing_runtime::types::PreparedWireRequest::Ready(request) => {
                send_http(
                    &target,
                    Method::Post,
                    &request.headers,
                    &wire,
                    &cancellation,
                    before_dispatch,
                )
                .await
            }
            gateway_routing_runtime::types::PreparedWireRequest::Claude(_) => {
                send_constructed(
                    physical.ok_or_else(crate::inference_local_lifecycle::wrapper_error)?,
                    &cancellation,
                    before_dispatch,
                )
                .await
            }
        };
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
                gateway_routing_runtime::types::ResponseHead {
                    status,
                    headers: headers.clone(),
                    provider_request_id: correlation(attempt.request.provider(), &headers)
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
        let (capture, evidence) = if attempt.request.provider() == UpstreamProvider::ClaudeCode {
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
            let capture = match (attempt.request.provider(), status) {
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
            Ok(gateway_routing_runtime::types::ResponseDecision::Return) => {
                return Ok((response, attempt));
            }
            Ok(gateway_routing_runtime::types::ResponseDecision::Continue) => {
                body::discard_response(&mut response);
            }
            Ok(gateway_routing_runtime::types::ResponseDecision::WorkspaceContinuation(
                continuation,
            )) => {
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
    let RequestResources {
        context,
        mut permit,
    } = resources;
    let responses = crate::normalized_path(&request.path()) == "/v1/responses";
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
    let local_compaction = responses
        && crate::host::setting(&host.env, "JEV_COMPACTION_DISABLED").as_deref() != Some("1")
        && gateway_compaction::is_responses_compaction(
            request
                .headers()
                .get("x-codex-turn-metadata")
                .ok()
                .flatten()
                .as_deref(),
        );
    let capture = crate::inference_capture::Capture::new(
        request,
        &bytes,
        store.clone(),
        host,
        context.clone(),
    );
    let result = async {
        let document = match parse_http_body(&bytes).and_then(SourceRequestDocument::new) {
            Ok(document) => document,
            Err(error) => {
                return crate::inference_source::error_response(error.into(), &capture).await;
            }
        };
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
        let metadata = gateway_routing_runtime::local_work::LocalRequestMetadata {
            context: original.clone(),
            principal: principal.clone(),
            catalog: catalog.input,
            runtime: catalog.runtime,
            client_version,
            native_session_id: None,
            retry_prohibited: false,
        };
        // This clone shares the original Claude Binding owner across local fallback and dispatch.
        let routing = routing_host::Host::new(
            store.clone(),
            host.clone(),
            context.clone(),
            original.clone(),
        );
        let client_stream = document.stream().unwrap_or(false);
        let session = if local_compaction {
            match crate::inference_local::start(
                metadata,
                document.clone(),
                store.clone(),
                routing.clone(),
                context.clone(),
                capture.clone(),
                permit.take(),
            )
            .await
            {
                Ok(started) => {
                    permit = started.permit;
                    match started.route {
                        crate::inference_local::Start::Response(response) => return Ok(response),
                        crate::inference_local::Start::Ordinary(session) => session,
                    }
                }
                Err(error) => {
                    return crate::inference_source::error_response(error, &capture).await;
                }
            }
        } else {
            let input = RoutingInput::from_source_request(
                metadata,
                document.for_surface(if responses {
                    gateway_schema::request::RequestSurface::Responses
                } else {
                    gateway_schema::request::RequestSurface::ChatCompletions
                }),
            );
            match RoutingSession::begin(
                input,
                store.clone(),
                routing.clone(),
                PlatformClock,
                PlatformTokens,
            )
            .await
            {
                Ok(session) => Rc::new(session),
                Err(error) => {
                    return crate::inference_source::error_response(error, &capture).await;
                }
            }
        };
        let currentness = match crate::inference_currentness::CurrentnessGuard::start(
            session.clone(),
            host.cancellation.clone(),
            context.clone(),
        )
        .await
        {
            Ok(guard) => guard,
            Err(error) => {
                session
                    .finish(Default::default())
                    .await
                    .map_err(|error| *error.error)?;
                return crate::inference_source::error_response(error, &capture).await;
            }
        };
        capture
            .begin(
                &original,
                session.selected_model(),
                document.original_source(),
                client_stream,
            )
            .await;
        let deadline = host.cancellation.set_timeout_ms(ATTEMPT_DEADLINE_MS)?;
        let (mut upstream, attempt) = match dispatch_attempts(
            session.clone(),
            routing,
            host.cancellation.clone(),
            capture.clone(),
        )
        .await
        {
            Ok(dispatched) => dispatched,
            Err(error) => {
                session
                    .finish(Default::default())
                    .await
                    .map_err(|error| *error.error)?;
                return crate::inference_source::error_response(error, &capture).await;
            }
        };
        let status = upstream.status_code();
        let provider = attempt.request.decode().provider;
        let prepared = attempt.request.clone();
        let headers = upstream
            .headers()
            .entries()
            .collect::<gateway_providers::Headers>();
        let decode_plan = gateway_providers::response::response_plan(prepared.decode(), &headers);
        capture.correlate(correlation(provider, &headers));
        let pricing = crate::inference_source::pricing_metadata(
            session.surplus_billing(),
            prepared.url().ends_with("/messages"),
        )?;
        let lifecycle = Rc::new(Lifecycle {
            session,
            currentness,
            attempt,
            principal: principal.clone(),
            provider_request_id: correlation(provider, &headers).map(str::to_owned),
            status,
            store: store.clone(),
            pricing,
        });
        let event_stream = gateway_providers::response::is_event_stream(provider, status, &headers);
        let observation = ObservationHandle::default();
        let usage = Rc::new(RefCell::new(None));
        let finish = finish_hook(lifecycle.clone(), usage.clone(), permit, capture.clone());
        if status >= 400 {
            capture.configure(status, event_stream, responses, provider);
            if gateway_providers::sse::is_lithos_stream_refusal(&decode_plan, status) {
                let probe = body::refusal_probe(
                    &mut upstream,
                    &host.cancellation,
                    body::REFUSAL_PROBE_TIMEOUT_MS,
                )
                .await;
                body::discard_response(&mut upstream);
                let decoded = decode_response(&decode_plan, status, &headers, &probe.bytes)?;
                if decoded.status != 200 || decoded.events.is_empty() {
                    return Err(invalid("Lithos stream refusal could not be translated."));
                }
                observation.semantic_terminal(decoded.terminal.unwrap_or(SemanticTerminal::Failed));
                capture.configure(200, true, responses, provider);
                let payload = decoded
                    .events
                    .iter()
                    .map(ProviderEvent::encode_sse)
                    .collect::<String>()
                    .into_bytes();
                let source = futures_util::stream::iter(vec![Ok(payload)]);
                let stream = ObservedStream::new(
                    source,
                    observation.clone(),
                    context,
                    host.cancellation.clone(),
                    Some(deadline),
                    finish,
                );
                let (_, raw_body) = stream
                    .into_response()
                    .map_err(|_| invalid("The downstream refusal body is unavailable."))?
                    .into_parts();
                let mut response = Response::builder().with_status(200).body(raw_body);
                for (name, value) in decoded.headers {
                    response
                        .headers_mut()
                        .set(&name, &value)
                        .map_err(|_| invalid("Invalid response header."))?;
                }
                return Ok(response);
            }
            if provider == UpstreamProvider::Cerebras {
                let probe = body::refusal_probe(
                    &mut upstream,
                    &host.cancellation,
                    body::REFUSAL_PROBE_TIMEOUT_MS,
                )
                .await;
                body::discard_response(&mut upstream);
                let bytes = cerebras_error_body(status, &probe.bytes);
                let observation = ObservationHandle::default();
                let source = futures_util::stream::iter(vec![Ok(bytes)]);
                let stream = ObservedStream::new(
                    source,
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
                let mut response = Response::builder().with_status(status).body(raw_body);
                response
                    .headers_mut()
                    .set("Content-Type", "application/json")
                    .map_err(|_| invalid("Invalid response header."))?;
                response
                    .headers_mut()
                    .set("x-uos-upstream", "cerebras")
                    .map_err(|_| invalid("Invalid response header."))?;
                if let Some(retry) = headers
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("retry-after"))
                    .map(|(_, value)| value)
                {
                    response
                        .headers_mut()
                        .set("Retry-After", retry)
                        .map_err(|_| invalid("Invalid response header."))?;
                }
                if status == 429 {
                    for name in CEREBRAS_RATE_LIMIT_HEADERS {
                        if let Some((_, value)) = headers
                            .iter()
                            .find(|(header, _)| header.eq_ignore_ascii_case(name))
                        {
                            response
                                .headers_mut()
                                .set(name, value)
                                .map_err(|_| invalid("Invalid response header."))?;
                        }
                    }
                }
                provider_correlation(&mut response, provider, &headers)?;
                return Ok(response);
            }
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
            apply_warnings(&mut response, prepared.warnings())?;
            return Ok(response);
        }
        if client_stream && event_stream && status < 400 {
            capture.configure(status, true, responses, provider);
            let source = upstream
                .stream()
                .map_err(|_| invalid("Upstream stream is unavailable."))?;
            let relay = Relay {
                source,
                plan: decode_plan.clone(),
                decoder: StreamDecoder::new(decode_plan.clone()),
                queue: VecDeque::new(),
                done: false,
                observation: observation.clone(),
                usage,
                deadline: Some(deadline),
                cancellation: host.cancellation.clone(),
                lifecycle: lifecycle.clone(),
                next_sequence: 0,
                heartbeat: RelayDelay::new(worker::Delay::from(std::time::Duration::from_millis(
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
                                std::pin::Pin::new(&mut state.heartbeat),
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
                            state.heartbeat = RelayDelay::new(worker::Delay::from(
                                std::time::Duration::from_millis(
                                    gateway_providers::sse::KEEPALIVE_INTERVAL_MS,
                                ),
                            ));
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
                                if let Some(usage) = state.decoder.observed_usage() {
                                    *state.usage.borrow_mut() = Some(usage.clone());
                                }
                                for event in &events {
                                    if let Some(usage) = event.observed_usage() {
                                        *state.usage.borrow_mut() = Some(usage);
                                    }
                                }
                                let terminal_output = events.iter().rev().find_map(|event| {
                                    event
                                        .field("response")
                                        .and_then(|response| {
                                            serde_json::from_str::<serde_json::Value>(
                                                response.as_str(),
                                            )
                                            .ok()
                                        })
                                        .and_then(|response| {
                                            response
                                                .get("output")
                                                .and_then(serde_json::Value::as_array)
                                                .cloned()
                                        })
                                });
                                let native_replay = state.decoder.native_replay().cloned();
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
                                        .field("sequence_number")
                                        .and_then(|value| value.deserialize::<u64>().ok())
                                        .map_or(state.next_sequence + 1, |number| number + 1);
                                    observe_event(&state.observation, &event);
                                    state.queue.push_back(event.encode_sse().into_bytes());
                                }
                                let terminal_usage = state.usage.borrow().clone();
                                let terminal = state.observation.snapshot().semantic_terminal;
                                if terminal.is_some()
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
                                if terminal == Some(SemanticTerminal::Completed)
                                    && state.plan.provider == UpstreamProvider::ClaudeCode
                                    && let (Some(output), Some(native)) =
                                        (terminal_output, native_replay)
                                {
                                    let _ = crate::claude_host::remember_native(
                                        &state.lifecycle.principal,
                                        &state.lifecycle.attempt,
                                        &output,
                                        &native,
                                        crate::storage::now_ms().unwrap_or(i64::MAX),
                                    );
                                }
                                if terminal.is_some() {
                                    state.done = true;
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
            apply_warnings(&mut response, prepared.warnings())?;
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
        let decoded = match decode_response(&decode_plan, status, &headers, &bytes) {
            Ok(decoded) => decoded,
            Err(error) => {
                lifecycle.finish(Default::default(), None).await?;
                return Err(error);
            }
        };
        if let Some(terminal) = decoded.terminal {
            observation.semantic_terminal(terminal);
        }
        if decoded.terminal == Some(SemanticTerminal::Completed)
            && provider == UpstreamProvider::ClaudeCode
            && let Some(native) = decoded.native_replay.as_ref()
            && let Some(output) = serde_json::from_str::<serde_json::Value>(decoded.body.as_str())
                .ok()
                .and_then(|body| {
                    body.get("output")
                        .and_then(serde_json::Value::as_array)
                        .cloned()
                })
        {
            let _ = crate::claude_host::remember_native(
                principal,
                &lifecycle.attempt,
                &output,
                native,
                now_ms().unwrap_or(i64::MAX),
            );
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
            decoded.body.as_bytes().to_vec()
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
        apply_warnings(&mut response, prepared.warnings())?;
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

const CEREBRAS_RATE_LIMIT_HEADERS: &[&str] = &[
    "x-ratelimit-limit-requests-minute",
    "x-ratelimit-remaining-requests-minute",
    "x-ratelimit-reset-requests-minute",
    "x-ratelimit-limit-tokens-minute",
    "x-ratelimit-remaining-tokens-minute",
    "x-ratelimit-reset-tokens-minute",
    "x-ratelimit-limit-requests-day",
    "x-ratelimit-remaining-requests-day",
    "x-ratelimit-reset-requests-day",
    "x-ratelimit-limit-tokens-day",
    "x-ratelimit-remaining-tokens-day",
    "x-ratelimit-reset-tokens-day",
];

/// Source Cerebras errors forward only message/code from a bounded body.
fn cerebras_error_detail(bytes: &[u8]) -> (String, String) {
    let fallback_message = "Cerebras upstream returned an error.".to_owned();
    let fallback_code = "cerebras_upstream_error".to_owned();
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return (fallback_message, fallback_code);
    };
    let error = value.get("error").filter(|value| value.is_object());
    let text = |name: &str, limit: usize| {
        error
            .and_then(|error| error.get(name))
            .or_else(|| value.get(name))
            .and_then(serde_json::Value::as_str)
            .map(|value| {
                value
                    .chars()
                    .take(limit)
                    .collect::<String>()
                    .trim()
                    .to_owned()
            })
            .filter(|value| !value.is_empty())
    };
    (
        text("message", 1_000).unwrap_or(fallback_message),
        text("code", 200).unwrap_or(fallback_code),
    )
}

fn cerebras_error_type(status: u16) -> &'static str {
    if status >= 500 {
        "server_error"
    } else if status == 429 {
        "rate_limit_error"
    } else {
        "invalid_request_error"
    }
}

fn cerebras_error_body(status: u16, bytes: &[u8]) -> Vec<u8> {
    let (message, code) = cerebras_error_detail(bytes);
    serde_json::to_vec(&json!({
        "error": {
            "message": message,
            "type": cerebras_error_type(status),
            "code": code,
        }
    }))
    .unwrap_or_else(|_| {
        br#"{"error":{"message":"Cerebras upstream returned an error.","type":"invalid_request_error","code":"cerebras_upstream_error"}}"#.to_vec()
    })
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
    heartbeat: RelayDelay<worker::Delay>,
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
    if let Some(terminal) = event.terminal() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cerebras_payment_required_body_forwards_only_source_detail_fields() {
        let input = br#"{"error":{"message":"Payment required","code":"payment_required","param":"secret","type":"vendor"},"secret":"never"}"#;
        let body = cerebras_error_body(402, input);
        let text = String::from_utf8(body.clone()).unwrap();
        assert_eq!(
            text,
            r#"{"error":{"message":"Payment required","type":"invalid_request_error","code":"payment_required"}}"#
        );
        assert!(!text.contains("vendor"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("param"));
    }

    #[test]
    fn cerebras_payment_required_146_byte_source_shape() {
        let message = "x".repeat(65);
        let input = serde_json::to_vec(&json!({
            "error": {"message": message, "code": "payment_required"}
        }))
        .unwrap();
        let body = cerebras_error_body(402, &input);
        assert_eq!(body.len(), 146);
        assert_eq!(
            body,
            br#"{"error":{"message":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","type":"invalid_request_error","code":"payment_required"}}"#
        );
    }

    #[test]
    fn cerebras_status_types_and_bounds_follow_the_source() {
        let body = cerebras_error_body(429, br#"{"error":{"message":"slow down","code":"rate"}}"#);
        assert!(
            String::from_utf8(body)
                .unwrap()
                .contains("rate_limit_error")
        );
        let body = cerebras_error_body(503, br#"{"message":"down","code":"unavailable"}"#);
        assert!(String::from_utf8(body).unwrap().contains("server_error"));
        let oversized = serde_json::to_vec(&json!({
            "error": {"message": "m".repeat(2_000), "code": "c".repeat(400)}
        }))
        .unwrap();
        let body = String::from_utf8(cerebras_error_body(402, &oversized)).unwrap();
        assert!(!body.contains(&"m".repeat(1_001)));
        assert!(!body.contains(&"c".repeat(201)));
    }
}
