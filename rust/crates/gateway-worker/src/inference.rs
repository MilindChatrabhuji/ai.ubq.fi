//! Actual schema -> admission -> provider -> terminal transport path.
use std::{cell::RefCell, collections::VecDeque, rc::Rc};

use futures_util::StreamExt;
use gateway_auth::AuthPrincipal;
use gateway_core::{
    GatewayError, identity::RequestId, lifecycle::SemanticTerminal, provider::UpstreamProvider,
};
use gateway_providers::{
    AuthMaterial, ClientSurface, PrepareOptions, ProviderEvent, StreamDecoder, decode_response,
    prepare_request,
};
use gateway_schema::{
    content,
    request::{self, RequestExtensions, RequestSurface},
};
use serde_json::{Value, json};
use worker::{Context, Method, Request, Response};

use crate::{
    authority::RemoteAuthorityStore,
    catalog::CatalogState,
    host::PlatformHost,
    lifecycle::Lifecycle,
    storage::now_ms,
    transport::{
        body,
        outbound::{DispatchAttempt, PinnedDestination, send_http},
        random,
        stream::{FinishHook, ObservationHandle, ObservedStream},
    },
};

type Usage = Rc<RefCell<Option<Value>>>;
const ATTEMPT_DEADLINE_MS: i32 = 1_800_000;

fn direct_provider(model: &str) -> Option<(&'static str, UpstreamProvider)> {
    [
        ("deepseek", UpstreamProvider::Deepseek),
        ("lithos", UpstreamProvider::Lithos),
        ("cerebras", UpstreamProvider::Cerebras),
    ]
    .into_iter()
    .find(|(_, provider)| {
        gateway_providers::request::canonical_model(*provider, model, &[]).is_some()
    })
}

pub async fn run(
    mut request: Request,
    context: Rc<Context>,
    principal: &AuthPrincipal,
    store: RemoteAuthorityStore,
    catalog: CatalogState,
    host: &PlatformHost,
    request_id: RequestId,
) -> Result<Response, GatewayError> {
    let responses = request.path() == "/v1/responses";
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
    let Some((label, provider)) = direct_provider(&model) else {
        return Err(GatewayError::unavailable(
            "This model's credential publication and routing operation are not yet integrated.",
            "provider_routing_unavailable",
        ));
    };
    if !catalog.input.enabled(label) {
        return Err(GatewayError::unavailable(
            "The selected provider is disabled.",
            &format!("{label}_disabled"),
        ));
    }
    let secret = catalog.secrets.get(label).ok_or_else(|| {
        GatewayError::unavailable(
            "The requested provider is not configured.",
            &format!("{label}_api_key_missing"),
        )
    })?;
    request::validate_request_fields(
        &raw,
        if responses {
            RequestSurface::Responses
        } else {
            RequestSurface::ChatCompletions
        },
        &RequestExtensions {
            deepseek_thinking: provider == UpstreamProvider::Deepseek,
            openrouter_cache_control: false,
        },
    )?;
    let client_stream = request::parse_stream(raw.get("stream"))?;
    if responses {
        raw["input"] = json!(content::normalize_responses_input(raw.get("input"))?);
        request::parse_instructions(raw.get("instructions"))?;
        gateway_schema::reasoning::parse_reasoning(raw.get("reasoning"))?;
    } else {
        content::normalize_chat_messages(raw.get("messages").unwrap_or(&Value::Null))?;
        request::parse_chat_stream_options(raw.get("stream_options"))?;
        request::parse_max_completion_tokens(raw.get("max_completion_tokens"))?;
        gateway_schema::reasoning::parse_effort(raw.get("reasoning_effort"), "reasoning_effort")?;
    }
    let options = PrepareOptions {
        auth: AuthMaterial {
            secret: secret.clone(),
            ..Default::default()
        },
        response_id: format!("resp_{}", random::random_uuid()?.replace('-', "")),
        created_at: now_ms()? / 1000,
        ..Default::default()
    };
    let prepared = prepare_request(provider, surface, &raw, &options)?;
    let destination = PinnedDestination::new(&prepared.url)?;
    let wire =
        serde_json::to_vec(&prepared.body).map_err(|_| invalid("Request could not be encoded."))?;
    let lifecycle = Lifecycle::admit(store, principal, request_id, route).await?;
    let deadline = host.cancellation.set_timeout_ms(ATTEMPT_DEADLINE_MS)?;
    let result = send_http(
        &destination,
        Method::Post,
        &prepared.headers,
        &wire,
        &host.cancellation,
        || lifecycle.dispatch_intent(provider),
    )
    .await;
    let mut upstream = match result {
        Ok(response) => response,
        Err(failure) => {
            match failure.attempt {
                DispatchAttempt::NotStarted => lifecycle.before_transport_failure().await?,
                DispatchAttempt::Started => {
                    lifecycle.started(None).await?;
                    lifecycle.finish(Default::default(), None).await?;
                }
            }
            return Err(failure.error);
        }
    };
    let status = upstream.status_code();
    lifecycle.started(Some(status)).await?;
    let headers = upstream
        .headers()
        .entries()
        .collect::<gateway_providers::Headers>();
    let event_stream = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("content-type") && value.contains("text/event-stream")
    });
    let observation = ObservationHandle::default();
    let usage = Rc::new(RefCell::new(None));
    let finish = finish_hook(lifecycle.clone(), usage.clone());
    if client_stream && event_stream && status < 400 {
        let source = upstream
            .stream()
            .map_err(|_| invalid("Upstream stream is unavailable."))?;
        let relay = Relay {
            source,
            decoder: StreamDecoder::new(prepared.decode),
            queue: VecDeque::new(),
            done: false,
            observation: observation.clone(),
            usage,
            deadline: Some(deadline),
            cancellation: host.cancellation.clone(),
            lifecycle: lifecycle.clone(),
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
                    let result = match state.source.next().await {
                        Some(Ok(bytes)) => state.decoder.push(&bytes),
                        Some(Err(error)) => {
                            state.done = true;
                            return Some((Err(error), state));
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
                                state.deadline =
                                    state.cancellation.set_timeout_ms(ATTEMPT_DEADLINE_MS).ok();
                            }
                            for event in events {
                                observe_event(&state.observation, &event);
                                state.queue.push_back(event.encode_sse().into_bytes());
                            }
                            if state.observation.snapshot().semantic_terminal.is_some()
                                && let Err(error) = state
                                    .lifecycle
                                    .observe_terminal(state.observation.snapshot())
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
                        Err(error) => {
                            state.done = true;
                            return Some((
                                Err(worker::Error::RustError(error.envelope.error.message)),
                                state,
                            ));
                        }
                    }
                }
            },
        ));
        let stream = ObservedStream::new(
            source,
            observation,
            context,
            host.cancellation.clone(),
            None,
            finish,
        );
        let mut response = Response::from_stream(stream)
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
        lifecycle.observe_terminal(observation.snapshot()).await?;
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
    let source = futures_util::stream::iter(vec![Ok(payload)]);
    let stream = ObservedStream::new(
        source,
        observation,
        context,
        host.cancellation.clone(),
        Some(deadline),
        finish,
    );
    let mut response = Response::from_stream(stream)
        .map_err(|_| invalid("The downstream body is unavailable."))?
        .with_status(decoded.status);
    for (name, value) in decoded.headers {
        response
            .headers_mut()
            .set(&name, &value)
            .map_err(|_| invalid("Invalid response header."))?;
    }
    provider_correlation(&mut response, provider, &headers)?;
    Ok(response)
}

struct Relay {
    source: worker::ByteStream,
    decoder: StreamDecoder,
    queue: VecDeque<Vec<u8>>,
    done: bool,
    observation: ObservationHandle,
    usage: Usage,
    deadline: Option<crate::transport::outbound::Deadline>,
    cancellation: Rc<crate::transport::outbound::Cancellation>,
    lifecycle: Rc<Lifecycle>,
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

fn finish_hook(lifecycle: Rc<Lifecycle>, usage: Usage) -> FinishHook {
    Box::new(move |observation| {
        Box::pin(async move {
            let usage = usage.borrow().clone();
            if let Err(error) = lifecycle.finish(observation, usage).await {
                worker::console_error!(
                    "Durable request settlement remains pending: {}",
                    error.envelope.error.message
                );
            }
        })
    })
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

fn provider_correlation(
    response: &mut Response,
    provider: UpstreamProvider,
    headers: &gateway_providers::Headers,
) -> Result<(), GatewayError> {
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
    let id = names
        .iter()
        .find_map(|wanted| {
            headers
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
                .map(|(_, value)| value.trim())
        })
        .filter(|id| {
            !id.is_empty() && id.len() <= 256 && !id.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
        });
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
