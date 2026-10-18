use std::cell::RefCell;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context as PollContext, Poll};

use futures_util::Stream;
use gateway_core::lifecycle::{
    BodyOutcome, DeliveryOutcome, ReaderTermination, SemanticTerminal, TransportObservation,
};
use worker::Context;

use super::outbound::{Cancellation, Deadline};

pub type FinishFuture = Pin<Box<dyn Future<Output = ()>>>;
pub type FinishHook = Box<dyn FnOnce(TransportObservation) -> FinishFuture>;

#[derive(Clone, Default)]
pub struct ObservationHandle(Rc<RefCell<TransportObservation>>);

impl ObservationHandle {
    /// Only the actual provider decoder may publish its observed semantic event.
    pub fn semantic_terminal(&self, terminal: SemanticTerminal) {
        self.0.borrow_mut().semantic_terminal = Some(terminal);
    }

    pub fn snapshot(&self) -> TransportObservation {
        *self.0.borrow()
    }
}

/// One outgoing body with one finalization hook. It never clones/tees the body.
/// Finalization uses waitUntil but must leave durable pending state recoverable
/// when the platform's post-disconnect lifetime expires.
pub struct ObservedStream<S> {
    source: S,
    observation: ObservationHandle,
    context: Rc<Context>,
    cancellation: Rc<Cancellation>,
    _deadline: Option<Deadline>,
    finish: Option<FinishHook>,
}

impl<S> ObservedStream<S> {
    pub fn new(
        source: S,
        observation: ObservationHandle,
        context: Rc<Context>,
        cancellation: Rc<Cancellation>,
        deadline: Option<Deadline>,
        finish: FinishHook,
    ) -> Self {
        Self {
            source,
            observation,
            context,
            cancellation,
            _deadline: deadline,
            finish: Some(finish),
        }
    }

    fn finalize(&mut self, reader: ReaderTermination, body: BodyOutcome) {
        let Some(finish) = self.finish.take() else {
            return;
        };
        let observed = {
            let mut state = self.observation.0.borrow_mut();
            state.reader_termination = Some(reader);
            state.body = Some(body);
            state.delivery = if self.cancellation.client_aborted() {
                DeliveryOutcome::Interrupted
            } else {
                DeliveryOutcome::Unobserved
            };
            *state
        };
        self.context.wait_until(finish(observed));
    }
}

impl<S> Stream for ObservedStream<S>
where
    S: Stream<Item = worker::Result<Vec<u8>>> + Unpin,
{
    type Item = worker::Result<Vec<u8>>;

    fn poll_next(
        mut self: Pin<&mut Self>,
        context: &mut PollContext<'_>,
    ) -> Poll<Option<Self::Item>> {
        if self.finish.is_none() {
            return Poll::Ready(None);
        }
        if self.cancellation.signal().aborted() {
            let reader = if self.cancellation.client_aborted() {
                ReaderTermination::Cancelled
            } else {
                ReaderTermination::Deadline
            };
            self.finalize(reader, BodyOutcome::Interrupted);
            return Poll::Ready(Some(Err(worker::Error::RustError(
                "Upstream stream interrupted".to_owned(),
            ))));
        }
        match Pin::new(&mut self.source).poll_next(context) {
            Poll::Ready(None) => {
                self.finalize(ReaderTermination::Eof, BodyOutcome::Drained);
                Poll::Ready(None)
            }
            Poll::Ready(Some(Err(error))) => {
                self.finalize(ReaderTermination::ReadError, BodyOutcome::Failed);
                Poll::Ready(Some(Err(error)))
            }
            result => result,
        }
    }
}

impl<S> Drop for ObservedStream<S> {
    fn drop(&mut self) {
        if self.finish.is_some() {
            self.cancellation.abort();
            self.finalize(ReaderTermination::Cancelled, BodyOutcome::Interrupted);
        }
    }
}
