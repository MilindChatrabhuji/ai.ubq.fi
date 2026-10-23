//! One real local selected owner; wire availability is independent of accounting.
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformTokens},
    routing_host,
};
use futures_util::task::AtomicWaker;
use gateway_core::{GatewayError, lifecycle::TransportObservation};
use gateway_routing_runtime::local_work::completion::response::{
    LocalAccountingProgress, LocalObservationSink, LocalSelectedResponse,
};
use std::{
    cell::{Cell, RefCell},
    future::poll_fn,
    rc::Rc,
    task::Poll,
};
use worker::Context;

pub(crate) type Selected =
    LocalSelectedResponse<RemoteAuthorityStore, PlatformTokens, PlatformClock, routing_host::Host>;
pub(crate) struct LocalLifecycle {
    owner: RefCell<Option<Selected>>,
    sink: LocalObservationSink,
    running: Cell<bool>,
    again: Cell<bool>,
    waker: AtomicWaker,
    permit: RefCell<Option<gateway_admission::Permit>>,
}
impl LocalLifecycle {
    pub(crate) fn new(owner: Selected, permit: Option<gateway_admission::Permit>) -> Rc<Self> {
        Rc::new(Self {
            sink: owner.observation_sink(),
            owner: RefCell::new(Some(owner)),
            running: Cell::new(false),
            again: Cell::new(false),
            waker: AtomicWaker::new(),
            permit: RefCell::new(permit),
        })
    }
    pub(crate) fn observe(&self, observation: TransportObservation) {
        if self
            .sink
            .observe(
                observation.reader_termination,
                observation.body,
                observation.delivery,
            )
            .is_err()
        {
            worker::console_error!("Local body observation conflicts with prior actual facts.");
        }
    }
    async fn idle(&self) {
        poll_fn(|cx| {
            self.waker.register(cx.waker());
            if self.running.get() {
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        })
        .await
    }
    /// Each event re-enters the existing source three-attempt chain, never a durability wire gate.
    pub(crate) async fn chain(self: &Rc<Self>) {
        if self.running.replace(true) {
            self.again.set(true);
            self.idle().await;
            return;
        }
        loop {
            self.again.set(false);
            let Some(mut owner) = self.owner.borrow_mut().take() else {
                break;
            };
            for _ in 0..3 {
                match owner.attempt_terminal().await {
                    LocalAccountingProgress::Confirmed(_) => break,
                    LocalAccountingProgress::Unconfirmed(_) => worker::console_error!(
                        "Local terminal accounting acknowledgement remains unknown."
                    ),
                    LocalAccountingProgress::Conflict => worker::console_error!(
                        "Local terminal accounting conflicts with current authority."
                    ),
                    LocalAccountingProgress::Error(_) => {
                        worker::console_error!("Local terminal accounting remains unresolved.")
                    }
                }
            }
            *self.owner.borrow_mut() = Some(owner);
            if !self.again.get() {
                break;
            }
        }
        self.running.set(false);
        self.waker.wake();
    }
    pub(crate) async fn registered_chain(self: &Rc<Self>, context: &Rc<Context>) {
        let done = Rc::new((Cell::new(false), AtomicWaker::new()));
        let signal = done.clone();
        let this = self.clone();
        context.wait_until(async move {
            this.chain().await;
            signal.0.set(true);
            signal.1.wake();
        });
        poll_fn(|cx| {
            done.1.register(cx.waker());
            if done.0.get() {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await
    }
    pub(crate) fn spawn_chain(self: &Rc<Self>, context: &Rc<Context>) {
        let this = self.clone();
        context.wait_until(async move {
            this.chain().await;
        });
    }
    pub(crate) fn wrapper_failed(self: &Rc<Self>, context: &Rc<Context>) {
        // Mark synchronously before a failed constructor's registered hook can run.
        let owner = self.owner.borrow_mut().take();
        if let Some(mut owner) = owner {
            if owner.note_wrapper_failure().is_err() {
                worker::console_error!(
                    "Local wrapper failure conflicts with an existing terminal choice."
                );
            }
            *self.owner.borrow_mut() = Some(owner);
        } else {
            worker::console_error!(
                "Local wrapper failure arrived after terminal ownership was taken."
            );
        }
        // Source terminal-route releases the process permit before best-effort cleanup.
        self.release_permit();
        self.spawn_chain(context);
    }
    pub(crate) fn release_permit(&self) {
        self.permit.borrow_mut().take();
    }
}

pub(crate) fn response_error(
    error: &gateway_routing_runtime::types::RoutingError,
) -> Result<worker::Response, gateway_routing_runtime::types::RoutingError> {
    let mut response = if let Some(body) = &error.source_body {
        let mut wire = worker::Response::from_bytes(body.as_bytes().to_vec())
            .map_err(|_| wrapper_error())?
            .with_status(error.error.status);
        wire.headers_mut()
            .set(
                "content-type",
                match body {
                    gateway_routing_runtime::types::SourceRefusalBody::Json(_) => {
                        "application/json"
                    }
                    gateway_routing_runtime::types::SourceRefusalBody::InternalServerError => {
                        "text/plain; charset=utf-8"
                    }
                },
            )
            .map_err(|_| wrapper_error())?;
        wire.headers_mut()
            .set("cache-control", "no-store")
            .map_err(|_| wrapper_error())?;
        wire
    } else {
        crate::runtime::auth_response(gateway_auth::AuthResponse::error((*error.error).clone()))?
    };
    for (name, value) in &error.headers {
        response
            .headers_mut()
            .set(name, value)
            .map_err(|_| wrapper_error())?;
    }
    Ok(response)
}
pub(super) fn wrapper_error() -> gateway_routing_runtime::types::RoutingError {
    gateway_routing_runtime::types::RoutingError {
        error: Box::new(
            GatewayError::new(500, "Internal Server Error", None).with_type("server_error"),
        ),
        source_body: Some(gateway_routing_runtime::types::SourceRefusalBody::InternalServerError),
        headers: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn constructor_failure_uses_existing_plain_runtime_500_not_new_quota_error() {
        let error = super::wrapper_error();
        assert_eq!(error.error.status, 500);
        assert_eq!(error.error.envelope.error.code, None);
        assert_eq!(
            error.source_body.unwrap().as_bytes(),
            b"Internal Server Error"
        );
        assert!(error.headers.is_empty());
    }
}
