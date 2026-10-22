//! Keep an existing delay's wake target current across successive stream pulls.
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use futures_util::task::AtomicWaker;

/// The inner delay keeps its original timer and deadline. Its retained waker
/// targets this stable relay rather than a possibly completed earlier pull.
pub(crate) struct RelayDelay<F> {
    delay: Pin<Box<F>>,
    wake: Arc<WakeLatest>,
}

struct WakeLatest {
    current: AtomicWaker,
}

impl Wake for WakeLatest {
    fn wake(self: Arc<Self>) {
        self.current.wake();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.current.wake();
    }
}

impl<F> RelayDelay<F> {
    pub(crate) fn new(delay: F) -> Self {
        Self {
            delay: Box::pin(delay),
            wake: Arc::new(WakeLatest {
                current: AtomicWaker::new(),
            }),
        }
    }
}

impl<F: Future<Output = ()>> Future for RelayDelay<F> {
    type Output = ();

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        this.wake.current.register(context.waker());
        let stable = Waker::from(Arc::clone(&this.wake));
        let mut stable_context = Context::from_waker(&stable);
        this.delay.as_mut().poll(&mut stable_context)
    }
}

#[cfg(test)]
mod tests {
    use super::RelayDelay;
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll, Wake, Waker};

    #[derive(Default)]
    struct Counter(AtomicUsize);

    impl Wake for Counter {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct Probe {
        created: usize,
        polls: usize,
        drops: usize,
        ready: bool,
        retained: Option<Waker>,
        same_retained_waker: Vec<bool>,
        deadlines: Vec<u64>,
    }

    /// Models the pinned delay: register once, preserve its deadline, clear on drop.
    struct FirstWakerDelay {
        probe: Arc<Mutex<Probe>>,
        deadline: u64,
    }

    impl Future for FirstWakerDelay {
        type Output = ();

        fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
            let mut probe = self.probe.lock().unwrap();
            probe.polls += 1;
            probe.deadlines.push(self.deadline);
            let retained = probe
                .retained
                .get_or_insert_with(|| context.waker().clone());
            let equivalent = retained.will_wake(context.waker());
            probe.same_retained_waker.push(equivalent);
            if probe.ready {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        }
    }

    impl Drop for FirstWakerDelay {
        fn drop(&mut self) {
            let mut probe = self.probe.lock().unwrap();
            probe.drops += 1;
            probe.retained = None;
        }
    }

    fn original_delay(deadline: u64) -> (FirstWakerDelay, Arc<Mutex<Probe>>) {
        let probe = Arc::new(Mutex::new(Probe {
            created: 1,
            ..Probe::default()
        }));
        (
            FirstWakerDelay {
                probe: Arc::clone(&probe),
                deadline,
            },
            probe,
        )
    }

    fn fire(probe: &Arc<Mutex<Probe>>) {
        let waker = {
            let mut probe = probe.lock().unwrap();
            probe.ready = true;
            probe.retained.as_ref().unwrap().clone()
        };
        waker.wake();
    }

    fn poll<F: Future<Output = ()> + Unpin>(delay: &mut F, waker: &Waker) -> Poll<()> {
        Pin::new(delay).poll(&mut Context::from_waker(waker))
    }

    #[test]
    fn unwrapped_control_wakes_only_the_original_task() {
        let (mut delay, probe) = original_delay(17);
        let old = Arc::new(Counter::default());
        let current = Arc::new(Counter::default());
        let old_waker = Waker::from(Arc::clone(&old));
        let current_waker = Waker::from(Arc::clone(&current));
        assert!(poll(&mut delay, &old_waker).is_pending());
        assert!(poll(&mut delay, &current_waker).is_pending());
        fire(&probe);
        assert_eq!(old.0.load(Ordering::SeqCst), 1);
        assert_eq!(current.0.load(Ordering::SeqCst), 0);
        assert_eq!(probe.lock().unwrap().same_retained_waker, [true, false]);
    }

    #[test]
    fn existing_timer_wakes_latest_task_without_restarting_deadline() {
        let (original, probe) = original_delay(17);
        let mut delay = RelayDelay::new(original);
        let old = Arc::new(Counter::default());
        let current = Arc::new(Counter::default());
        let old_waker = Waker::from(Arc::clone(&old));
        let current_waker = Waker::from(Arc::clone(&current));
        assert!(poll(&mut delay, &old_waker).is_pending());
        assert!(poll(&mut delay, &current_waker).is_pending());
        fire(&probe);
        assert_eq!(old.0.load(Ordering::SeqCst), 0);
        assert_eq!(current.0.load(Ordering::SeqCst), 1);
        assert!(poll(&mut delay, &current_waker).is_ready());
        let probe = probe.lock().unwrap();
        assert_eq!(probe.created, 1);
        assert_eq!(probe.polls, 3);
        assert_eq!(probe.deadlines, [17, 17, 17]);
        assert_eq!(probe.same_retained_waker, [true, true, true]);
    }

    #[test]
    fn drop_preserves_timer_cancellation_without_waking_a_task() {
        let (original, probe) = original_delay(23);
        let mut delay = RelayDelay::new(original);
        let old = Arc::new(Counter::default());
        let current = Arc::new(Counter::default());
        assert!(poll(&mut delay, &Waker::from(Arc::clone(&old))).is_pending());
        assert!(poll(&mut delay, &Waker::from(Arc::clone(&current))).is_pending());
        drop(delay);
        let probe = probe.lock().unwrap();
        assert_eq!(probe.created, 1);
        assert_eq!(probe.drops, 1);
        assert_eq!(probe.deadlines, [23, 23]);
        assert!(probe.retained.is_none());
        assert_eq!(old.0.load(Ordering::SeqCst), 0);
        assert_eq!(current.0.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn ready_result_is_forwarded_with_one_original_poll() {
        let (original, probe) = original_delay(29);
        probe.lock().unwrap().ready = true;
        let mut delay = RelayDelay::new(original);
        let task = Arc::new(Counter::default());
        assert!(poll(&mut delay, &Waker::from(Arc::clone(&task))).is_ready());
        let probe = probe.lock().unwrap();
        assert_eq!(probe.created, 1);
        assert_eq!(probe.polls, 1);
        assert_eq!(probe.deadlines, [29]);
        assert_eq!(task.0.load(Ordering::SeqCst), 0);
    }
}
