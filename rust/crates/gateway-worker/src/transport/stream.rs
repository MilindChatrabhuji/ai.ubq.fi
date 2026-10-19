use std::cell::{Cell, RefCell};
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context as PollContext, Poll};

use futures_util::Stream;
use futures_util::task::AtomicWaker;
use gateway_core::lifecycle::{
    BodyOutcome, DeliveryOutcome, ReaderTermination, SemanticTerminal, TransportObservation,
};
use worker::wasm_bindgen_futures::JsFuture;
use worker::{Context, Response, ResponseBody};

use super::outbound::{Cancellation, Deadline};

pub type FinishFuture = Pin<Box<dyn Future<Output = ()>>>;
pub type FinishHook = Box<dyn FnOnce(TransportObservation) -> FinishFuture>;

struct FinishSignal {
    observation: RefCell<Option<TransportObservation>>,
    waker: AtomicWaker,
    completed: Cell<bool>,
}

impl FinishSignal {
    fn complete(&self, observation: TransportObservation) {
        if self.completed.replace(true) {
            return;
        }
        *self.observation.borrow_mut() = Some(observation);
        self.waker.wake();
    }
}

/// A failed wrapper constructor has abandoned its body, not observed native delivery.
fn constructor_result<T, E>(
    result: std::result::Result<T, E>,
    signal: &Option<Rc<FinishSignal>>,
    observation: &ObservationHandle,
) -> std::result::Result<T, E> {
    if result.is_err()
        && let Some(signal) = signal
    {
        let mut observed = observation.snapshot();
        observed.reader_termination = Some(ReaderTermination::Cancelled);
        observed.body = Some(BodyOutcome::Interrupted);
        observed.delivery = DeliveryOutcome::Unobserved;
        signal.complete(observed);
    }
    result
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
    context: Rc<Context>,
    cancellation: Rc<Cancellation>,
    _deadline: Option<Deadline>,
    finish: Option<Rc<FinishSignal>>,
    native_pipe: bool,
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
            completed: Cell::new(false),
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
            context,
            cancellation,
            _deadline: deadline,
            finish: Some(signal),
            native_pipe: false,
        }
    }

    fn finalize(&mut self, reader: ReaderTermination, body: BodyOutcome) {
        let Some(signal) = self.finish.take() else {
            return;
        };
        if signal.completed.get() {
            return;
        }
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
        if !self.native_pipe {
            signal.complete(observed);
        }
    }
}

impl<S> ObservedStream<S>
where
    S: Stream<Item = worker::Result<Vec<u8>>> + Unpin + 'static,
{
    pub fn into_response(mut self) -> worker::Result<Response> {
        self.native_pipe = true;
        let context = self.context.clone();
        let signal = self.finish.as_ref().cloned();
        let observation = self.observation.clone();
        let cancellation = self.cancellation.clone();
        let response = constructor_result(Response::from_stream(self), &signal, &observation)?;
        let (builder, body) = response.into_parts();
        let ResponseBody::Stream(source) = body else {
            return constructor_result(
                Err(worker::Error::RustError(
                    "Missing streaming response body".into(),
                )),
                &signal,
                &observation,
            );
        };
        let bridge = constructor_result(
            worker::web_sys::TransformStream::new()
                .map_err(|_| worker::Error::RustError("Native stream bridge unavailable".into())),
            &signal,
            &observation,
        )?;
        let pipe = source.pipe_to(&bridge.writable());
        // Observe native pipe cancellation independently of a pending Rust pull.
        // Pipe completion remains producer/body evidence, never delivery proof.
        context.wait_until(async move {
            let failed = JsFuture::from(pipe).await.is_err();
            if let Some(signal) = signal
                && !signal.completed.get()
            {
                let mut observed = observation.snapshot();
                if failed {
                    cancellation.abort();
                    observed.reader_termination = Some(ReaderTermination::Cancelled);
                    observed.body = Some(BodyOutcome::Interrupted);
                } else {
                    observed.reader_termination = Some(ReaderTermination::Eof);
                    observed.body = Some(BodyOutcome::Drained);
                }
                observed.delivery = if cancellation.client_aborted() {
                    DeliveryOutcome::Interrupted
                } else {
                    DeliveryOutcome::Unobserved
                };
                signal.complete(observed);
            }
        });
        Ok(builder.stream(bridge.readable()))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use std::task::{Wake, Waker};
    #[derive(Default)]
    struct WakeCount(AtomicUsize);
    impl Wake for WakeCount {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn failure_settles_once(error: &'static str) {
        let signal = Rc::new(FinishSignal {
            observation: RefCell::new(None),
            waker: AtomicWaker::new(),
            completed: Cell::new(false),
        });
        let count = Arc::new(WakeCount::default());
        signal.waker.register(&Waker::from(count.clone()));
        let facts = ObservationHandle::default();
        facts.semantic_terminal(SemanticTerminal::Completed);
        let result: std::result::Result<(), _> =
            constructor_result(Err(error), &Some(signal.clone()), &facts);
        assert_eq!(result, Err(error));
        assert!(signal.completed.get());
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
        let observed = signal.observation.borrow_mut().take().unwrap();
        assert_eq!(
            observed.semantic_terminal,
            Some(SemanticTerminal::Completed)
        );
        assert_eq!(
            observed.reader_termination,
            Some(ReaderTermination::Cancelled)
        );
        assert_eq!(observed.body, Some(BodyOutcome::Interrupted));
        assert_eq!(observed.delivery, DeliveryOutcome::Unobserved);
        signal.complete(TransportObservation::default());
        assert!(signal.observation.borrow().is_none());
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn failed_response_constructor_settles_registered_signal_once() {
        failure_settles_once("response constructor");
    }
    #[test]
    fn failed_bridge_constructor_settles_registered_signal_once() {
        failure_settles_once("bridge constructor");
    }
    #[test]
    fn successful_constructor_keeps_existing_waiter_pending() {
        let signal = Rc::new(FinishSignal {
            observation: RefCell::new(None),
            waker: AtomicWaker::new(),
            completed: Cell::new(false),
        });
        let result = constructor_result::<_, ()>(
            Ok(7),
            &Some(signal.clone()),
            &ObservationHandle::default(),
        );
        assert_eq!(result, Ok(7));
        assert!(!signal.completed.get());
        assert!(signal.observation.borrow().is_none());
    }
}
