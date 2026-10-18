use std::cell::RefCell;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context as PollContext, Poll};

use futures_util::Stream;
use futures_util::task::AtomicWaker;
use gateway_core::lifecycle::{
    BodyOutcome, DeliveryOutcome, ReaderTermination, SemanticTerminal, TransportObservation,
};
use worker::Context;

use super::outbound::{Cancellation, Deadline};

pub type FinishFuture = Pin<Box<dyn Future<Output = ()>>>;
pub type FinishHook = Box<dyn FnOnce(TransportObservation) -> FinishFuture>;

struct FinishSignal {
    observation: RefCell<Option<TransportObservation>>,
    waker: AtomicWaker,
}

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
    cancellation: Rc<Cancellation>,
    _deadline: Option<Deadline>,
    finish: Option<Rc<FinishSignal>>,
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
        let signal = Rc::new(FinishSignal {
            observation: RefCell::new(None),
            waker: AtomicWaker::new(),
        });
        let receiver = signal.clone();
        // Register while the invocation is alive. Registering only after a
        // disconnect can be too late to retain the durable terminal writer.
        context.wait_until(async move {
            let observed = poll_fn(|context| {
                receiver.waker.register(context.waker());
                receiver
                    .observation
                    .borrow_mut()
                    .take()
                    .map_or(Poll::Pending, Poll::Ready)
            })
            .await;
            finish(observed).await;
        });
        Self {
            source,
            observation,
            cancellation,
            _deadline: deadline,
            finish: Some(signal),
        }
    }

    fn finalize(&mut self, reader: ReaderTermination, body: BodyOutcome) {
        let Some(signal) = self.finish.take() else {
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
        *signal.observation.borrow_mut() = Some(observed);
        signal.waker.wake();
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
        self.cancellation.register_waker(context.waker());
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
                if self.cancellation.client_aborted() {
                    self.finalize(ReaderTermination::Cancelled, BodyOutcome::Interrupted);
                } else {
                    self.finalize(ReaderTermination::Eof, BodyOutcome::Drained);
                }
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
