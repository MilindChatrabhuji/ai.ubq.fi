use std::cell::{Cell, RefCell};
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use gateway_admission::{
    Acquisition, AdmissionCancellation, AdmissionClock, AdmissionController, AdmissionLimits,
    AdmissionRequest, AdmissionResult, AdmissionWait, DEFAULT_LIMITS, LocalOverloadCause, Permit,
    RETRY_AFTER_SECONDS, WaitFuture, cancellation_error, overload_error, requires_admission,
};

#[derive(Default)]
struct Clock(Cell<Duration>);

impl AdmissionClock for Clock {
    fn now(&self) -> Duration {
        self.0.get()
    }
}

impl Clock {
    fn advance(&self, millis: u64) {
        self.0.set(self.now() + Duration::from_millis(millis));
    }
}

#[derive(Default)]
struct Cancellation(Cell<bool>);

impl AdmissionCancellation for Cancellation {
    fn is_cancelled(&self) -> bool {
        self.0.get()
    }
}

struct Host {
    clock: Rc<Clock>,
    waits: Cell<usize>,
    detached: Rc<Cell<usize>>,
    wakers: RefCell<Vec<Waker>>,
}

impl Host {
    fn new(clock: Rc<Clock>) -> Self {
        Self {
            clock,
            waits: Cell::new(0),
            detached: Rc::new(Cell::new(0)),
            wakers: RefCell::new(Vec::new()),
        }
    }

    fn notify(&self) {
        for waker in self.wakers.borrow_mut().drain(..) {
            waker.wake();
        }
    }
}

struct Wait<'a> {
    host: &'a Host,
    deadline: Duration,
    cancellation: &'a dyn AdmissionCancellation,
}

impl Future for Wait<'_> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        if self.cancellation.is_cancelled() || self.host.clock.now() >= self.deadline {
            Poll::Ready(())
        } else {
            self.host.wakers.borrow_mut().push(context.waker().clone());
            Poll::Pending
        }
    }
}

impl Drop for Wait<'_> {
    fn drop(&mut self) {
        self.host.detached.set(self.host.detached.get() + 1);
    }
}

impl AdmissionWait for Host {
    fn wait_until<'a>(
        &'a self,
        deadline: Duration,
        cancellation: &'a dyn AdmissionCancellation,
    ) -> WaitFuture<'a> {
        self.waits.set(self.waits.get() + 1);
        Box::pin(Wait {
            host: self,
            deadline,
            cancellation,
        })
    }
}

#[derive(Default)]
struct WakeCount(AtomicUsize);

impl Wake for WakeCount {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

fn poll(acquisition: &mut Acquisition<'_>) -> Poll<AdmissionResult> {
    let waker = Waker::from(Arc::new(WakeCount::default()));
    Pin::new(acquisition).poll(&mut Context::from_waker(&waker))
}

fn result(acquisition: &mut Acquisition<'_>) -> AdmissionResult {
    match poll(acquisition) {
        Poll::Ready(result) => result,
        Poll::Pending => panic!("Expected a settled admission"),
    }
}

fn admitted(acquisition: &mut Acquisition<'_>) -> (Permit, u64) {
    match result(acquisition) {
        AdmissionResult::Admitted { permit, waited_ms } => (permit, waited_ms),
        _ => panic!("Expected admission"),
    }
}

fn request(principal: Option<&str>, id: &str) -> AdmissionRequest {
    AdmissionRequest {
        principal: principal.map(str::to_owned),
        request_id: id.to_owned(),
        route: "responses".to_owned(),
        cancellation: Rc::new(Cancellation::default()),
    }
}

fn controller(
    clock: Rc<Clock>,
    active: usize,
    waiting: usize,
    wait_ms: u64,
) -> AdmissionController {
    AdmissionController::with_limits(
        clock,
        AdmissionLimits {
            max_active: active,
            max_waiting: waiting,
            max_queue_wait_ms: wait_ms,
        },
    )
    .unwrap()
}

#[test]
fn production_saturation_is_global_and_recovers_without_principal_caps() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = AdmissionController::new(clock.clone());
    assert_eq!(
        DEFAULT_LIMITS,
        AdmissionLimits {
            max_active: 64,
            max_waiting: 128,
            max_queue_wait_ms: 5_000,
        }
    );
    let active: Vec<_> = (0..64)
        .map(|_| admitted(&mut guard.acquire(request(Some("one"), "same-id"), &host)).0)
        .collect();
    let mut waiting: Vec<_> = (0..128)
        .map(|_| guard.acquire(request(Some("one"), "same-id"), &host))
        .collect();
    let snapshot = guard.snapshot();
    assert_eq!(
        (snapshot.active, snapshot.waiting, snapshot.principals),
        (64, 128, 1)
    );
    assert!(matches!(
        result(&mut guard.acquire(request(Some("unrelated"), "new"), &host)),
        AdmissionResult::LocalOverload {
            cause: LocalOverloadCause::QueueLimit,
            waited_ms: 0
        }
    ));
    clock.advance(17);
    active[0].release();
    let (promoted, waited) = admitted(&mut waiting[0]);
    assert_eq!(waited, 17);
    assert_eq!(promoted.request_id(), "same-id");
    assert_eq!(promoted.route(), "responses");
    assert_eq!(
        (guard.snapshot().active, guard.snapshot().waiting),
        (64, 127)
    );
    drop(waiting);
    drop(active);
    drop(promoted);
    assert_eq!(
        (
            guard.snapshot().active,
            guard.snapshot().waiting,
            guard.snapshot().principals
        ),
        (0, 0, 0)
    );
    assert_eq!(
        admitted(&mut guard.acquire(request(None, "fresh"), &host)).1,
        0
    );
    assert_eq!(guard.snapshot().active, 0);
}

#[test]
fn waiting_rotates_principals_and_preserves_each_fifo() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 12, 500);
    let (mut held, _) = admitted(&mut guard.acquire(request(Some("a"), "holder"), &host));
    let mut a0 = guard.acquire(request(Some("a"), "a0"), &host);
    let mut a1 = guard.acquire(request(Some("a"), "a1"), &host);
    let mut a2 = guard.acquire(request(Some("a"), "a2"), &host);
    let mut b = guard.acquire(request(Some("b"), "b"), &host);
    let mut c = guard.acquire(request(Some("c"), "c"), &host);
    assert_eq!(guard.snapshot().principals, 3);
    for (next, expected) in [
        (&mut a0, "a0"),
        (&mut b, "b"),
        (&mut c, "c"),
        (&mut a1, "a1"),
        (&mut a2, "a2"),
    ] {
        held.release();
        held = admitted(next).0;
        assert_eq!(held.request_id(), expected);
    }
    assert_eq!(guard.snapshot().waiting, 0);
    assert_eq!(guard.snapshot().principals, 0);
    drop(held);
    assert_eq!(guard.snapshot().active, 0);
}

#[test]
fn absent_principals_share_fifo_but_empty_string_has_its_own_turn() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 4, 500);
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder"), &host));
    let mut first = guard.acquire(request(None, "first"), &host);
    let mut second = guard.acquire(request(None, "second"), &host);
    let mut empty = guard.acquire(request(Some(""), "empty"), &host);
    assert_eq!(guard.snapshot().principals, 2);
    drop(held);
    drop(admitted(&mut first).0);
    assert!(poll(&mut second).is_pending());
    drop(admitted(&mut empty).0);
    drop(admitted(&mut second).0);
    assert_eq!(guard.snapshot().principals, 0);
}

#[test]
fn timeout_removes_waiter_and_cancellation_wins_at_deadline() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock.clone(), 1, 4, 25);
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder"), &host));
    let cancelled = Rc::new(Cancellation::default());
    let mut cancelled_request = request(Some("cancel"), "cancel");
    cancelled_request.cancellation = cancelled.clone();
    let mut a = guard.acquire(cancelled_request, &host);
    let mut b = guard.acquire(request(Some("expire"), "expire"), &host);
    assert!(poll(&mut a).is_pending());
    assert!(poll(&mut b).is_pending());
    assert_eq!(host.waits.get(), 2);
    clock.advance(25);
    cancelled.0.set(true);
    host.notify();
    assert!(matches!(
        result(&mut a),
        AdmissionResult::CallerAborted { waited_ms: 25 }
    ));
    assert!(matches!(
        result(&mut b),
        AdmissionResult::LocalOverload {
            cause: LocalOverloadCause::QueueWaitTimeout,
            waited_ms: 25
        }
    ));
    assert_eq!(host.detached.get(), 2);
    assert_eq!(
        (guard.snapshot().waiting, guard.snapshot().principals),
        (0, 0)
    );
    assert_eq!(guard.snapshot().active, 1);
    drop(held);
}

#[test]
fn cancelled_caller_never_queues_and_frees_its_principal_promptly() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 2, 1_000);
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder"), &host));
    let cancellation = Rc::new(Cancellation(Cell::new(true)));
    let mut input = request(Some("cancelled"), "cancelled");
    input.cancellation = cancellation.clone();
    assert!(matches!(
        result(&mut guard.acquire(input, &host)),
        AdmissionResult::CallerAborted { waited_ms: 0 }
    ));
    assert_eq!(guard.snapshot().waiting, 0);
    cancellation.0.set(false);
    let mut input = request(Some("cancelled"), "cancelled");
    input.cancellation = cancellation.clone();
    let mut waiting = guard.acquire(input, &host);
    let mut kept = guard.acquire(request(Some("kept"), "kept"), &host);
    assert!(poll(&mut waiting).is_pending());
    cancellation.0.set(true);
    host.notify();
    assert!(matches!(
        result(&mut waiting),
        AdmissionResult::CallerAborted { .. }
    ));
    assert_eq!(
        (guard.snapshot().waiting, guard.snapshot().principals),
        (1, 1)
    );
    drop(held);
    drop(admitted(&mut kept).0);
    assert_eq!(guard.snapshot().active, 0);
}

#[test]
fn delayed_host_callbacks_expire_head_and_preserve_its_principals_turn() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock.clone(), 1, 6, 25);
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder"), &host));
    let mut overdue = guard.acquire(request(Some("a"), "overdue"), &host);
    clock.advance(40);
    let mut next = guard.acquire(request(Some("a"), "next"), &host);
    let mut other = guard.acquire(request(Some("b"), "other"), &host);
    // Never poll the overdue future: no host callback can have run.
    drop(held);
    assert!(matches!(
        result(&mut overdue),
        AdmissionResult::LocalOverload {
            cause: LocalOverloadCause::QueueWaitTimeout,
            waited_ms: 40
        }
    ));
    let (next, _) = admitted(&mut next);
    assert_eq!(next.request_id(), "next");
    assert!(poll(&mut other).is_pending());
    drop(next);
    drop(admitted(&mut other).0);
    assert_eq!(guard.snapshot().principals, 0);
}

#[test]
fn release_rechecks_unpolled_cancellation_without_consuming_a_turn() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 4, 500);
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder"), &host));
    let cancellation = Rc::new(Cancellation::default());
    let mut input = request(Some("a"), "cancelled");
    input.cancellation = cancellation.clone();
    let mut cancelled = guard.acquire(input, &host);
    let mut next = guard.acquire(request(Some("a"), "next"), &host);
    let mut other = guard.acquire(request(Some("b"), "other"), &host);
    cancellation.0.set(true);
    drop(held);
    assert!(matches!(
        result(&mut cancelled),
        AdmissionResult::CallerAborted { waited_ms: 0 }
    ));
    drop(admitted(&mut next).0);
    drop(admitted(&mut other).0);
    assert_eq!(guard.snapshot().active, 0);
}

#[test]
fn permit_is_held_after_cancellation_and_repeated_release_is_idempotent() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 2, 500);
    let cancellation = Rc::new(Cancellation::default());
    let mut input = request(None, "holder");
    input.cancellation = cancellation.clone();
    let (held, _) = admitted(&mut guard.acquire(input, &host));
    let mut queued = guard.acquire(request(None, "queued"), &host);
    cancellation.0.set(true);
    assert_eq!(guard.snapshot().active, 1);
    assert!(poll(&mut queued).is_pending());
    held.release();
    held.release();
    let (next, _) = admitted(&mut queued);
    drop(held);
    assert_eq!(guard.snapshot().active, 1);
    next.release();
    next.release();
    drop(next);
    assert_eq!(guard.snapshot().active, 0);
}

#[test]
fn dropping_acquisition_before_poll_or_after_grant_cannot_leak_capacity() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 2, 500);
    let held = guard.acquire(request(None, "unpolled-holder"), &host);
    let abandoned = guard.acquire(request(Some("abandoned"), "abandoned"), &host);
    drop(abandoned);
    assert_eq!(
        (guard.snapshot().waiting, guard.snapshot().principals),
        (0, 0)
    );
    let granted = guard.acquire(request(None, "granted-unpolled"), &host);
    drop(held);
    assert_eq!(guard.snapshot().active, 1);
    drop(granted);
    assert_eq!(guard.snapshot().active, 0);
}

#[test]
fn release_wakes_waiting_future_and_drops_its_host_subscription() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 1, 500);
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder"), &host));
    let mut queued = guard.acquire(request(None, "queued"), &host);
    let wakes = Arc::new(WakeCount::default());
    let waker = Waker::from(wakes.clone());
    assert!(
        Pin::new(&mut queued)
            .poll(&mut Context::from_waker(&waker))
            .is_pending()
    );
    drop(held);
    assert_eq!(wakes.0.load(Ordering::Relaxed), 1);
    drop(admitted(&mut queued).0);
    assert_eq!(host.detached.get(), 1);
}

#[test]
fn fractional_elapsed_rounding_and_backwards_clock_match_source() {
    let clock = Rc::new(Clock(Cell::new(Duration::from_millis(100))));
    let host = Host::new(clock.clone());
    let guard = controller(clock.clone(), 1, 2, 25);
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder"), &host));
    let mut queued = guard.acquire(request(None, "queued"), &host);
    clock.0.set(Duration::from_micros(124_500));
    drop(held);
    assert!(matches!(
        result(&mut queued),
        AdmissionResult::LocalOverload {
            cause: LocalOverloadCause::QueueWaitTimeout,
            waited_ms: 25
        }
    ));
    let (held, _) = admitted(&mut guard.acquire(request(None, "holder2"), &host));
    let mut queued = guard.acquire(request(None, "queued2"), &host);
    clock.0.set(Duration::ZERO);
    drop(held);
    assert_eq!(admitted(&mut queued).1, 0);
}

#[test]
fn only_exact_source_routes_consume_resources() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let guard = controller(clock, 1, 0, 0);
    for route in [
        "embeddings",
        "embeddings.jobs.create",
        "embeddings.jobs.get",
        "chat.completions",
        "responses",
        "systemone",
        "images.generations",
        "images.edits",
    ] {
        assert!(requires_admission(route));
        let mut input = request(None, route);
        input.route = route.to_owned();
        assert_eq!(admitted(&mut guard.acquire(input, &host)).1, 0);
    }
    for route in [
        "models",
        "/v1/models",
        "live",
        "/v1/live",
        "responses.extra",
        "health",
    ] {
        assert!(!requires_admission(route));
        let mut input = request(None, route);
        input.route = route.to_owned();
        assert!(matches!(
            result(&mut guard.acquire(input, &host)),
            AdmissionResult::Bypassed
        ));
    }
    assert_eq!(guard.snapshot().active, 0);
}

#[test]
fn zero_waiting_and_zero_timeout_are_source_supported_finite_bounds() {
    let clock = Rc::new(Clock::default());
    let host = Host::new(clock.clone());
    let no_waiting = controller(clock.clone(), 1, 0, 500);
    let (held, _) = admitted(&mut no_waiting.acquire(request(None, "holder"), &host));
    assert!(matches!(
        result(&mut no_waiting.acquire(request(None, "full"), &host)),
        AdmissionResult::LocalOverload {
            cause: LocalOverloadCause::QueueLimit,
            ..
        }
    ));
    drop(held);
    let no_wait = controller(clock, 1, 1, 0);
    let (held, _) = admitted(&mut no_wait.acquire(request(None, "holder"), &host));
    let mut queued = no_wait.acquire(request(None, "expire"), &host);
    drop(held);
    assert!(matches!(
        result(&mut queued),
        AdmissionResult::LocalOverload {
            cause: LocalOverloadCause::QueueWaitTimeout,
            waited_ms: 0
        }
    ));
}

#[test]
fn exact_refusal_envelope_distinguishes_cancellation_from_local_overload() {
    assert_eq!(RETRY_AFTER_SECONDS, 5);
    for cause in [
        LocalOverloadCause::QueueLimit,
        LocalOverloadCause::QueueWaitTimeout,
    ] {
        let error = overload_error(cause);
        assert_eq!(error.status, 503);
        assert_eq!(
            error.envelope.error.code.as_deref(),
            Some("local_inference_overload")
        );
        assert_eq!(error.envelope.error.error_type, "server_error");
        assert_eq!(error.envelope.error.param, Some(None));
    }
    let cancellation = cancellation_error();
    assert_eq!(cancellation.status, 499);
    assert_eq!(
        cancellation.envelope.error.code.as_deref(),
        Some("request_cancelled")
    );
    assert_eq!(cancellation.envelope.error.param, Some(None));
}

#[test]
fn constructor_rejects_unbounded_or_zero_active_limits() {
    let clock = Rc::new(Clock::default());
    for limits in [
        AdmissionLimits {
            max_active: 0,
            ..DEFAULT_LIMITS
        },
        AdmissionLimits {
            max_queue_wait_ms: u64::MAX,
            ..DEFAULT_LIMITS
        },
    ] {
        assert!(AdmissionController::with_limits(clock.clone(), limits).is_err());
    }
}
