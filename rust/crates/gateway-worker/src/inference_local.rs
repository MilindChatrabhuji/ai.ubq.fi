//! Actual local builder, earlier response selection and original-admission fallback.
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformHost, PlatformTokens},
    inference_capture::Capture,
    inference_lifecycle::Session,
    inference_local_lifecycle::{LocalLifecycle, response_error, wrapper_error},
    routing_host,
    transport::stream::{ObservationHandle, ObservedStream},
};
use futures_util::{Stream, task::AtomicWaker};
use gateway_compaction::types::{CompactionOutcome, ResponseOptions};
use gateway_core::lifecycle::{BodyOutcome, ReaderTermination, TransportObservation};
use gateway_routing_runtime::{
    local_work::{
        LocalAdmissionInput, LocalRequestMetadata, LocalWorkHandle,
        completion::response::LocalWireKind,
    },
    session::RoutingSession,
    types::RoutingError,
};
use gateway_schema::source_request::SourceRequestDocument;
use std::{
    cell::{Cell, RefCell},
    future::{Future, poll_fn},
    pin::Pin,
    rc::Rc,
    task::{Context as PollContext, Poll},
};
use worker::{Context, Response};
pub(crate) type Local =
    LocalWorkHandle<RemoteAuthorityStore, PlatformTokens, PlatformClock, routing_host::Host>;
pub(crate) enum Start {
    Ordinary(Rc<Session>),
    Response(Response),
}
pub(crate) struct Started {
    pub(crate) route: Start,
    pub(crate) permit: Option<gateway_admission::Permit>,
}
struct ResultSlot {
    value: RefCell<Option<Result<Started, RoutingError>>>,
    waiting: Cell<bool>,
    waker: AtomicWaker,
}
struct Receiver(Rc<ResultSlot>);
impl Drop for Receiver {
    fn drop(&mut self) {
        self.0.waiting.set(false);
    }
}

pub(crate) async fn start(
    metadata: LocalRequestMetadata,
    document: SourceRequestDocument,
    store: RemoteAuthorityStore,
    routing: routing_host::Host,
    context: Rc<Context>,
    capture: Rc<Capture>,
    mut permit: Option<gateway_admission::Permit>,
) -> Result<Started, RoutingError> {
    let slot = Rc::new(ResultSlot {
        value: RefCell::new(None),
        waiting: Cell::new(true),
        waker: AtomicWaker::new(),
    });
    let receiver = Receiver(slot.clone());
    let tasks = context.clone();
    context.wait_until(async move {
        let result = start_inner(
            metadata,
            document,
            store,
            routing,
            tasks,
            capture,
            &mut permit,
        )
        .await;
        if !slot.waiting.get() {
            if let Ok(Start::Ordinary(session)) = result {
                let _cleanup = session.finish(Default::default()).await;
            }
            return;
        }
        *slot.value.borrow_mut() = Some(result.map(|route| Started { route, permit }));
        slot.waker.wake();
    });
    poll_fn(|cx| {
        receiver.0.waker.register(cx.waker());
        receiver
            .0
            .value
            .borrow_mut()
            .take()
            .map_or(Poll::Pending, Poll::Ready)
    })
    .await
}

async fn start_inner(
    metadata: LocalRequestMetadata,
    document: SourceRequestDocument,
    store: RemoteAuthorityStore,
    routing: routing_host::Host,
    context: Rc<Context>,
    capture: Rc<Capture>,
    permit: &mut Option<gateway_admission::Permit>,
) -> Result<Start, RoutingError> {
    let host = routing.platform.clone();
    let local = RoutingSession::begin_local_compaction(
        LocalAdmissionInput {
            metadata,
            original: document.clone(),
        },
        store,
        routing,
        PlatformClock,
        PlatformTokens,
    )
    .await?;
    let built = crate::inference_currentness::run_local(&local, host.cancellation.clone(), async {
        let stream = document
            .stream()
            .map_err(gateway_routing_runtime::types::RoutingError::from)?;
        capture
            .begin_local(local.original_context(), document.original_source(), stream)
            .await;
        let result = match crate::compaction_host::PlatformCompactionHost::new(host.clone()) {
            Ok(builder) => {
                gateway_compaction::build_compaction_response(
                    document.original_source(),
                    &builder,
                    ResponseOptions {
                        stream,
                        hybrid: crate::host::setting(&host.env, "JEV_COMPACTION_HYBRID").as_deref()
                            != Some("0"),
                    },
                )
                .await
            }
            Err(error) => Err(error),
        };
        Ok::<_, RoutingError>((result, stream))
    })
    .await;
    let (outcome, stream) = match built {
        Ok(Ok(value)) => value,
        Ok(Err(_error)) | Err(_error) => {
            if !host.cancellation.signal().aborted() {
                return fallback(local).await;
            }
            let original = cancelled_response();
            let mut refusal = local
                .retain_built_response()
                .err()
                .ok_or_else(wrapper_error)?;
            let selected = refusal.select_cancelled_response().await?;
            return finish(
                selected,
                original,
                false,
                context,
                &host,
                capture,
                permit.take(),
            )
            .await
            .map(Start::Response);
        }
    };
    let successful = outcome.is_ok();
    if !successful && !host.cancellation.signal().aborted() {
        return fallback(local).await;
    }
    // No await between the actual successful builder/final observed abort and capture.
    let choice = local.retain_built_response();
    // Retain any actual construction failure with the genuine owner through earlier release.
    let original = match outcome {
        Ok(outcome) => built_response(outcome),
        Err(_) => cancelled_response(),
    };
    let (selected, original) = match choice {
        Ok(mut built) => (built.select_response().await?, original),
        Err(mut refusal) => {
            let original = if successful {
                cancelled_response()
            } else {
                original
            };
            (refusal.select_cancelled_response().await?, original)
        }
    };
    finish(
        selected,
        original,
        stream && successful,
        context,
        &host,
        capture,
        permit.take(),
    )
    .await
    .map(Start::Response)
}
async fn fallback(local: Local) -> Result<Start, RoutingError> {
    RoutingSession::from_local_admission(local.resume_original().await?)
        .await
        .map(|session| Start::Ordinary(Rc::new(session)))
}
fn built_response(outcome: CompactionOutcome) -> Result<Response, RoutingError> {
    let mut response = Response::from_bytes(outcome.body)
        .map_err(|_| wrapper_error())?
        .with_status(outcome.status);
    response
        .headers_mut()
        .set("content-type", outcome.content_type)
        .map_err(|_| wrapper_error())?;
    response
        .headers_mut()
        .set("cache-control", "no-store")
        .map_err(|_| wrapper_error())?;
    for (name, value) in outcome.headers {
        response
            .headers_mut()
            .set(&name, &value)
            .map_err(|_| wrapper_error())?;
    }
    Ok(response)
}
fn cancelled_response() -> Result<Response, RoutingError> {
    // Frozen compaction.ts643-655 uses cancelledResponse for every observed abort.
    crate::runtime::auth_response(gateway_auth::AuthResponse::error(
        gateway_admission::cancellation_error(),
    ))
    .map_err(Into::into)
}

async fn finish(
    mut selected: crate::inference_local_lifecycle::Selected,
    original: Result<Response, RoutingError>,
    streamed: bool,
    context: Rc<Context>,
    host: &PlatformHost,
    capture: Rc<Capture>,
    permit: Option<gateway_admission::Permit>,
) -> Result<Response, RoutingError> {
    if selected.take_early_accounting_error().is_some() {
        worker::console_error!("Source unused quota release cleanup remains unresolved.");
    }
    let decision = selected.take_wire_decision();
    let lifecycle = LocalLifecycle::new(selected, permit);
    let Some(decision) = decision else {
        lifecycle.wrapper_failed(&context);
        return Err(wrapper_error());
    };
    let success = decision.kind() == LocalWireKind::OriginalSuccess;
    let response = match decision.kind() {
        LocalWireKind::QuotaReplacement => match decision.into_quota_error() {
            Some(error) => response_error(&error),
            None => Err(wrapper_error()),
        },
        _ => original,
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            lifecycle.wrapper_failed(&context);
            return Err(error);
        }
    };
    let streamed = streamed && success;
    capture.configure_local(response.status_code(), streamed, success);
    if !streamed {
        // Source terminal-log469-490 returns the selected buffered Response itself.
        // No late cancellation-sensitive stream is inserted after accounting.
        lifecycle.registered_chain(&context).await;
        capture.finish_buffered_local(&response).await;
        lifecycle.release_permit();
        return Ok(response);
    }
    let (builder, body) = response.into_parts();
    let bytes = match body {
        worker::ResponseBody::Body(bytes) => bytes,
        worker::ResponseBody::Empty => Vec::new(),
        _ => {
            lifecycle.wrapper_failed(&context);
            return Err(wrapper_error());
        }
    };
    let armed = Rc::new(Armed {
        ready: Cell::new(false),
        waker: AtomicWaker::new(),
    });
    let source = ReadyBody {
        bytes: Some(bytes),
        armed: armed.clone(),
        lifecycle: lifecycle.clone(),
        context: context.clone(),
        eof: None,
    };
    let hook_owner = lifecycle.clone();
    let hook_capture = capture.clone();
    let stream = ObservedStream::new(
        capture.client(source),
        ObservationHandle::default(),
        context.clone(),
        host.cancellation.clone(),
        None,
        Box::new(move |observation| {
            Box::pin(async move {
                hook_owner.observe(observation);
                hook_owner.chain().await;
                hook_capture.finish_local(observation).await;
                hook_owner.release_permit();
            })
        }),
    );
    let wrapped = match stream.into_response() {
        Ok(response) => response,
        Err(_) => {
            lifecycle.wrapper_failed(&context);
            return Err(wrapper_error());
        }
    };
    armed.ready.set(true);
    armed.waker.wake();
    let (_, body) = wrapped.into_parts();
    Ok(builder.body(body))
}
struct Armed {
    ready: Cell<bool>,
    waker: AtomicWaker,
}
struct ReadyBody {
    bytes: Option<Vec<u8>>,
    armed: Rc<Armed>,
    lifecycle: Rc<LocalLifecycle>,
    context: Rc<Context>,
    eof: Option<Pin<Box<dyn Future<Output = ()>>>>,
}
impl Stream for ReadyBody {
    type Item = worker::Result<Vec<u8>>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut PollContext<'_>) -> Poll<Option<Self::Item>> {
        self.armed.waker.register(cx.waker());
        if !self.armed.ready.get() {
            return Poll::Pending;
        }
        match self.bytes.take() {
            Some(bytes) => {
                self.lifecycle.spawn_chain(&self.context);
                Poll::Ready(Some(Ok(bytes)))
            }
            None => {
                if self.eof.is_none() {
                    // Actual producer EOF is body/read evidence, never native delivery.
                    self.lifecycle.observe(TransportObservation {
                        reader_termination: Some(ReaderTermination::Eof),
                        body: Some(BodyOutcome::Drained),
                        ..Default::default()
                    });
                    let lifecycle = self.lifecycle.clone();
                    let context = self.context.clone();
                    self.eof = Some(Box::pin(async move {
                        lifecycle.registered_chain(&context).await;
                    }));
                }
                match self
                    .eof
                    .as_mut()
                    .expect("EOF future was initialized")
                    .as_mut()
                    .poll(cx)
                {
                    Poll::Ready(()) => Poll::Ready(None),
                    Poll::Pending => Poll::Pending,
                }
            }
        }
    }
}
