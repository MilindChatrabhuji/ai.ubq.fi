//! Finite isolate-local resource admission, ported from src/inference-admission.ts.
//! One controller is shared across requests, principals and inference routes in an
//! isolate. This is neither a quota ledger nor a durable/distributed scheduler.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use gateway_core::GatewayError;

pub const LOCAL_INFERENCE_OVERLOAD_CODE: &str = "local_inference_overload";
pub const RETRY_AFTER_SECONDS: u64 = 5;
pub const DEFAULT_LIMITS: AdmissionLimits = AdmissionLimits {
    max_active: 64,
    max_waiting: 128,
    max_queue_wait_ms: 5_000,
};

/// Fixed at controller construction; not an environment or request setting.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdmissionLimits {
    pub max_active: usize,
    pub max_waiting: usize,
    pub max_queue_wait_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdmissionSnapshot {
    pub active: usize,
    pub waiting: usize,
    pub principals: usize,
    pub max_active: usize,
    pub max_waiting: usize,
}

/// The host supplies a real clock in one consistent domain for this controller
/// and its wait implementation. A monotonic clock is preferred to wall time.
pub trait AdmissionClock {
    fn now(&self) -> Duration;
}

pub trait AdmissionCancellation {
    fn is_cancelled(&self) -> bool;
}

pub type WaitFuture<'a> = Pin<Box<dyn Future<Output = ()> + 'a>>;

/// A single request-owned wait, not a periodic job. It completes on the deadline
/// or caller cancellation, waking the acquisition future. Dropping this future
/// must detach the host's timer and cancellation subscription.
pub trait AdmissionWait {
    fn wait_until<'a>(
        &'a self,
        deadline: Duration,
        cancellation: &'a dyn AdmissionCancellation,
    ) -> WaitFuture<'a>;
}

pub struct AdmissionRequest {
    /// Only waiting turns use this identity. None is one shared FIFO group;
    /// Some("") remains a different group, just as in the source Map.
    pub principal: Option<String>,
    /// Diagnostic context only; repeated IDs do not reserve or deduplicate work.
    pub request_id: String,
    /// The source terminal-route label, not an HTTP path.
    pub route: String,
    pub cancellation: Rc<dyn AdmissionCancellation>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalOverloadCause {
    QueueLimit,
    QueueWaitTimeout,
}

pub enum AdmissionResult {
    Admitted {
        permit: Permit,
        waited_ms: u64,
    },
    Bypassed,
    LocalOverload {
        cause: LocalOverloadCause,
        waited_ms: u64,
    },
    CallerAborted {
        waited_ms: u64,
    },
}

/// Exact src/handler/admission.ts labels. Models and realtime are excluded.
pub fn requires_admission(route: &str) -> bool {
    matches!(
        route,
        "embeddings"
            | "embeddings.jobs.create"
            | "embeddings.jobs.get"
            | "chat.completions"
            | "responses"
            | "systemone"
            | "images.generations"
            | "images.edits"
    )
}

/// The adapter must also attach Retry-After: RETRY_AFTER_SECONDS. This error is
/// local overload and must never serve as provider quota/capacity proof.
pub fn overload_error(cause: LocalOverloadCause) -> GatewayError {
    let message = match cause {
        LocalOverloadCause::QueueLimit => {
            "The gateway is at its concurrent inference limit and its waiting queue is full."
        }
        LocalOverloadCause::QueueWaitTimeout => {
            "The gateway could not admit this request within 5000ms."
        }
    };
    GatewayError::unavailable(message, LOCAL_INFERENCE_OVERLOAD_CODE).with_param(None)
}

pub fn cancellation_error() -> GatewayError {
    GatewayError::new(499, "Request was cancelled.", Some("request_cancelled"))
        .with_type("server_error")
        .with_param(None)
}

#[derive(Clone)]
pub struct AdmissionController(Rc<Inner>);

struct Inner {
    clock: Rc<dyn AdmissionClock>,
    limits: AdmissionLimits,
    state: RefCell<State>,
}

#[derive(Default)]
struct State {
    active: usize,
    waiting_count: usize,
    waiting: BTreeMap<Option<String>, VecDeque<Rc<RefCell<Waiter>>>>,
    turns: VecDeque<Option<String>>,
}

struct Waiter {
    principal: Option<String>,
    queued_at: Duration,
    cancellation: Rc<dyn AdmissionCancellation>,
    queued: bool,
    result: Option<Decision>,
    waker: Option<Waker>,
}

enum Decision {
    Admitted(u64),
    Bypassed,
    Overloaded(LocalOverloadCause, u64),
    Aborted(u64),
}

/// Source Math.max(0, Math.round(now - queuedAt)), including fractional ms.
fn elapsed_ms(now: Duration, since: Duration) -> u64 {
    let elapsed = now.saturating_sub(since);
    let rounded = elapsed.as_millis() + u128::from(elapsed.subsec_nanos() % 1_000_000 >= 500_000);
    u64::try_from(rounded).unwrap_or(u64::MAX)
}

impl AdmissionController {
    pub fn new(clock: Rc<dyn AdmissionClock>) -> Self {
        Self::with_limits(clock, DEFAULT_LIMITS).expect("Valid fixed source admission limits")
    }

    /// Internal deterministic test seam, matching createInferenceAdmissionController.
    pub fn with_limits(
        clock: Rc<dyn AdmissionClock>,
        limits: AdmissionLimits,
    ) -> Result<Self, GatewayError> {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        if limits.max_active == 0
            || limits.max_active as u128 > u128::from(MAX_SAFE_INTEGER)
            || limits.max_waiting as u128 > u128::from(MAX_SAFE_INTEGER)
            || limits.max_queue_wait_ms > MAX_SAFE_INTEGER
        {
            return Err(GatewayError::new(
                500,
                "Inference admission limits must be bounded safe integers with positive max_active.",
                Some("invalid_admission_limits"),
            ));
        }
        Ok(Self(Rc::new(Inner {
            clock,
            limits,
            state: RefCell::new(State::default()),
        })))
    }

    /// Enqueues synchronously, like the source Promise constructor. Abandoning
    /// the returned future removes its queue slot or returns its granted permit.
    pub fn acquire<'a>(
        &self,
        request: AdmissionRequest,
        host: &'a dyn AdmissionWait,
    ) -> Acquisition<'a> {
        let queued_at = self.0.clock.now();
        let cancellation = request.cancellation;
        let mut state = self.0.state.borrow_mut();
        let result = if !requires_admission(&request.route) {
            Some(Decision::Bypassed)
        } else if cancellation.is_cancelled() {
            Some(Decision::Aborted(0))
        } else if state.active < self.0.limits.max_active && state.waiting_count == 0 {
            state.active += 1;
            Some(Decision::Admitted(0))
        } else if state.waiting_count >= self.0.limits.max_waiting {
            Some(Decision::Overloaded(LocalOverloadCause::QueueLimit, 0))
        } else {
            None
        };
        let waiter = Rc::new(RefCell::new(Waiter {
            principal: request.principal,
            queued_at,
            cancellation: cancellation.clone(),
            queued: result.is_none(),
            result,
            waker: None,
        }));
        if waiter.borrow().queued {
            let principal = waiter.borrow().principal.clone();
            if !state.waiting.contains_key(&principal) {
                state.turns.push_back(principal.clone());
            }
            state
                .waiting
                .entry(principal)
                .or_default()
                .push_back(waiter.clone());
            state.waiting_count += 1;
        }
        drop(state);
        Acquisition {
            inner: self.0.clone(),
            waiter,
            cancellation,
            host,
            wait: None,
            request_id: request.request_id,
            route: request.route,
            finished: false,
        }
    }

    pub fn snapshot(&self) -> AdmissionSnapshot {
        let state = self.0.state.borrow();
        AdmissionSnapshot {
            active: state.active,
            waiting: state.waiting_count,
            principals: state.waiting.len(),
            max_active: self.0.limits.max_active,
            max_waiting: self.0.limits.max_waiting,
        }
    }
}

impl State {
    fn detach(&mut self, waiter: &Rc<RefCell<Waiter>>) {
        let mut entry = waiter.borrow_mut();
        if !entry.queued {
            return;
        }
        entry.queued = false;
        let principal = &entry.principal;
        if let Some(queue) = self.waiting.get_mut(principal) {
            queue.retain(|candidate| !Rc::ptr_eq(candidate, waiter));
            self.waiting_count -= 1;
            if queue.is_empty() {
                self.waiting.remove(principal);
                self.turns.retain(|turn| turn != principal);
            }
        }
    }

    fn settle(&mut self, waiter: &Rc<RefCell<Waiter>>, decision: Decision, wakes: &mut Vec<Waker>) {
        self.detach(waiter);
        let mut entry = waiter.borrow_mut();
        entry.result = Some(decision);
        if let Some(waker) = entry.waker.take() {
            wakes.push(waker);
        }
    }

    fn pump(&mut self, now: Duration, limits: AdmissionLimits, wakes: &mut Vec<Waker>) {
        while self.active < limits.max_active && self.waiting_count > 0 {
            let Some(principal) = self.turns.pop_front() else {
                break;
            };
            let Some(waiter) = self
                .waiting
                .get(&principal)
                .and_then(|queue| queue.front())
                .cloned()
            else {
                continue;
            };
            let entry = waiter.borrow();
            let waited = elapsed_ms(now, entry.queued_at);
            let refused = if entry.cancellation.is_cancelled() {
                Some(Decision::Aborted(waited))
            } else if waited >= limits.max_queue_wait_ms {
                Some(Decision::Overloaded(
                    LocalOverloadCause::QueueWaitTimeout,
                    waited,
                ))
            } else {
                None
            };
            drop(entry);
            if let Some(reason) = refused {
                self.settle(&waiter, reason, wakes);
                // An expired/aborted head does not consume its principal's turn.
                if self.waiting.contains_key(&principal) {
                    self.turns.push_front(principal);
                }
            } else {
                self.active += 1;
                self.settle(&waiter, Decision::Admitted(waited), wakes);
                if self.waiting.contains_key(&principal) {
                    self.turns.push_back(principal);
                }
            }
        }
    }
}

impl Inner {
    fn release(&self) {
        let mut wakes = Vec::new();
        {
            let mut state = self.state.borrow_mut();
            state.active = state
                .active
                .checked_sub(1)
                .expect("A held permit is active");
            state.pump(self.clock.now(), self.limits, &mut wakes);
        }
        for waker in wakes {
            waker.wake();
        }
    }
}

/// Non-clone ownership follows the response body through finish/drop. Aborting
/// after admission does not release automatically while that body still lives.
#[must_use = "Hold the permit until the response lifecycle has settled"]
pub struct Permit {
    inner: Rc<Inner>,
    released: Cell<bool>,
    request_id: String,
    route: String,
}

impl Permit {
    pub fn release(&self) {
        if !self.released.replace(true) {
            self.inner.release();
        }
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn route(&self) -> &str {
        &self.route
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.release();
    }
}

pub struct Acquisition<'a> {
    inner: Rc<Inner>,
    waiter: Rc<RefCell<Waiter>>,
    cancellation: Rc<dyn AdmissionCancellation>,
    host: &'a dyn AdmissionWait,
    wait: Option<WaitFuture<'a>>,
    request_id: String,
    route: String,
    finished: bool,
}

impl Future for Acquisition<'_> {
    type Output = AdmissionResult;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        assert!(!this.finished, "Admission future polled after completion");
        if this.waiter.borrow().result.is_none() {
            this.waiter.borrow_mut().waker = Some(context.waker().clone());
            // The host future owns its cancellation subscription. Cloning the
            // Rc into it avoids a self-borrowing acquisition/future lifetime.
            if this.wait.is_none() {
                let cancellation = this.cancellation.clone();
                let deadline = this.waiter.borrow().queued_at
                    + Duration::from_millis(this.inner.limits.max_queue_wait_ms);
                let host = this.host;
                this.wait = Some(Box::pin(async move {
                    host.wait_until(deadline, cancellation.as_ref()).await;
                }));
            }
            let now = this.inner.clock.now();
            let waited = elapsed_ms(now, this.waiter.borrow().queued_at);
            let cancelled = this.cancellation.is_cancelled();
            let wait_ready = this
                .wait
                .as_mut()
                .is_some_and(|wait| wait.as_mut().poll(context).is_ready());
            if cancelled || waited >= this.inner.limits.max_queue_wait_ms || wait_ready {
                let decision = if this.cancellation.is_cancelled() {
                    Decision::Aborted(waited)
                } else {
                    Decision::Overloaded(LocalOverloadCause::QueueWaitTimeout, waited)
                };
                // This future is already being polled, so its waker need not
                // wake itself after removal. Other pending futures are intact.
                this.waiter.borrow_mut().waker = None;
                this.inner
                    .state
                    .borrow_mut()
                    .settle(&this.waiter, decision, &mut Vec::new());
            }
        }
        let Some(decision) = this.waiter.borrow_mut().result.take() else {
            return Poll::Pending;
        };
        this.finished = true;
        this.wait = None;
        Poll::Ready(match decision {
            Decision::Admitted(waited_ms) => AdmissionResult::Admitted {
                permit: Permit {
                    inner: this.inner.clone(),
                    released: Cell::new(false),
                    request_id: std::mem::take(&mut this.request_id),
                    route: std::mem::take(&mut this.route),
                },
                waited_ms,
            },
            Decision::Bypassed => AdmissionResult::Bypassed,
            Decision::Overloaded(cause, waited_ms) => {
                AdmissionResult::LocalOverload { cause, waited_ms }
            }
            Decision::Aborted(waited_ms) => AdmissionResult::CallerAborted { waited_ms },
        })
    }
}

impl Drop for Acquisition<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if matches!(self.waiter.borrow().result, Some(Decision::Admitted(_))) {
            self.inner.release();
        } else {
            self.inner.state.borrow_mut().detach(&self.waiter);
        }
    }
}
