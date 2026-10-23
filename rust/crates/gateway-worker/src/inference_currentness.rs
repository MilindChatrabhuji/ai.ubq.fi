//! Invocation-owned observation and renewal of one original ordinary admission.
use crate::{
    inference_lifecycle::Session,
    storage::now_ms,
    transport::outbound::{Cancellation, Deadline},
};
use futures_util::{
    future::{Either, select},
    task::AtomicWaker,
};
use gateway_core::GatewayError;
use gateway_routing_runtime::{
    currentness::{ObservedRoutingLease, RoutingLeaseState},
    local_work::KERNEL_RENEWAL_INTERVAL_MS,
    types::RoutingError,
};
use std::{
    cell::{Cell, RefCell},
    future::poll_fn,
    rc::Rc,
    task::Poll,
};
use worker::Context;

struct State {
    stopped: Cell<bool>,
    waker: AtomicWaker,
    expiry: RefCell<Option<Deadline>>,
    cancellation: Rc<Cancellation>,
}
impl State {
    fn stop(&self) {
        self.stopped.set(true);
        self.expiry.borrow_mut().take();
        self.waker.wake();
    }
    async fn stopped(&self) {
        poll_fn(|cx| {
            self.waker.register(cx.waker());
            if self.stopped.get() {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await
    }
    fn observe(&self, lease: ObservedRoutingLease) -> Result<(), GatewayError> {
        if self.stopped.get() {
            return Ok(());
        }
        if lease.state() == RoutingLeaseState::Settled {
            self.stop();
            return Ok(());
        }
        // Coordination/API expiry never becomes a client timeout. Only the
        // actual confirmed kernel reservation owns this source abort deadline.
        // Construct first: a failed renewal/arming retains the prior timer.
        let timer = kernel_timer_delay(lease.kernel_expires_at_ms(), now_ms)?
            .map(|delay| self.cancellation.set_timeout_ms(delay))
            .transpose()?;
        *self.expiry.borrow_mut() = timer;
        Ok(())
    }
}

/// Borrow the genuine local owner only while the actual builder future runs.
pub(crate) async fn run_local<F: std::future::Future>(
    local: &crate::inference_local::Local,
    cancellation: Rc<Cancellation>,
    work: F,
) -> Result<F::Output, RoutingError> {
    let lease = local.currentness().checkpoint().await?;
    let state = Rc::new(State {
        stopped: Cell::new(false),
        waker: AtomicWaker::new(),
        expiry: RefCell::new(None),
        cancellation,
    });
    if let Some(delay) = kernel_timer_delay(lease.kernel_expires_at_ms(), now_ms)? {
        *state.expiry.borrow_mut() = Some(state.cancellation.set_timeout_ms(delay)?);
    }
    let _guard = CurrentnessGuard {
        state: state.clone(),
    };
    let renewal = async {
        loop {
            worker::Delay::from(std::time::Duration::from_millis(
                KERNEL_RENEWAL_INTERVAL_MS as u64,
            ))
            .await;
            if state.stopped.get() {
                return;
            }
            match local.currentness().renew_kernel().await {
                Ok(observed) => {
                    let timer = kernel_timer_delay(observed.kernel_expires_at_ms(), now_ms)
                        .and_then(|delay| {
                            delay
                                .map(|delay| state.cancellation.set_timeout_ms(delay))
                                .transpose()
                        });
                    match timer {
                        Ok(timer) => *state.expiry.borrow_mut() = timer,
                        Err(_) => {
                            worker::console_error!("Local confirmed lease timer remains unchanged.")
                        }
                    }
                }
                Err(_) => worker::console_error!(
                    "Local original coordination renewal remains unconfirmed."
                ),
            }
        }
    };
    match select(Box::pin(work), Box::pin(renewal)).await {
        Either::Left((result, _)) => Ok(result),
        Either::Right(_) => Err(unavailable().into()),
    }
}

pub(crate) struct CurrentnessGuard {
    state: Rc<State>,
}
impl CurrentnessGuard {
    pub(crate) async fn start(
        session: Rc<Session>,
        cancellation: Rc<Cancellation>,
        context: Rc<Context>,
    ) -> Result<Self, RoutingError> {
        let lease = session.currentness().checkpoint().await?;
        if lease.state() != RoutingLeaseState::Live {
            return Err(unavailable().into());
        }
        let state = Rc::new(State {
            stopped: Cell::new(false),
            waker: AtomicWaker::new(),
            expiry: RefCell::new(None),
            cancellation,
        });
        state.observe(lease)?;
        let guard = Self {
            state: state.clone(),
        };
        let mut next = now_ms()?
            .checked_add(KERNEL_RENEWAL_INTERVAL_MS)
            .ok_or_else(unavailable)?;
        context.wait_until(async move {
            while !state.stopped.get() {
                let delay = match now_ms().and_then(|now| timer_delay(next, now)) {
                    Ok(delay) => {
                        worker::Delay::from(std::time::Duration::from_millis(delay as u64))
                    }
                    Err(error) => {
                        worker::console_error!(
                            "Coordination renewal clock remains unconfirmed: {}",
                            error.envelope.error.message
                        );
                        worker::Delay::from(std::time::Duration::from_millis(
                            KERNEL_RENEWAL_INTERVAL_MS as u64,
                        ))
                    }
                };
                if matches!(
                    select(Box::pin(delay), Box::pin(state.stopped())).await,
                    Either::Right(_)
                ) {
                    break;
                }
                let view = session.currentness();
                let result =
                    match select(Box::pin(view.renew_kernel()), Box::pin(state.stopped())).await {
                        Either::Left((result, _)) => result,
                        Either::Right(_) => break,
                    };
                match result {
                    Ok(observed) => {
                        if let Err(error) = state.observe(observed) {
                            worker::console_error!(
                                "Confirmed request lease timer remains unchanged: {}",
                                error.envelope.error.message
                            );
                        }
                    }
                    Err(error) => worker::console_error!(
                        "Original request lease renewal remains unconfirmed: {}",
                        error.error.envelope.error.message
                    ),
                }
                next = match now_ms().and_then(|now| next_tick(next, now)) {
                    Ok(next) => next,
                    Err(error) => {
                        worker::console_error!(
                            "Coordination renewal tick remains unconfirmed: {}",
                            error.envelope.error.message
                        );
                        next.saturating_add(KERNEL_RENEWAL_INTERVAL_MS)
                    }
                };
            }
        });
        Ok(guard)
    }
    pub(crate) fn stop(&self) {
        self.state.stop();
    }
}
impl Drop for CurrentnessGuard {
    fn drop(&mut self) {
        self.stop();
    }
}
fn kernel_timer_delay(
    expiry: Option<i64>,
    now: impl FnOnce() -> Result<i64, GatewayError>,
) -> Result<Option<i32>, GatewayError> {
    expiry.map(|expiry| timer_delay(expiry, now()?)).transpose()
}
fn timer_delay(expiry: i64, now: i64) -> Result<i32, GatewayError> {
    i32::try_from(expiry.saturating_sub(now).max(1)).map_err(|_| unavailable())
}
fn next_tick(previous: i64, now: i64) -> Result<i64, GatewayError> {
    let ticks = now.saturating_sub(previous).max(0) / KERNEL_RENEWAL_INTERVAL_MS + 1;
    previous
        .checked_add(
            ticks
                .checked_mul(KERNEL_RENEWAL_INTERVAL_MS)
                .ok_or_else(unavailable)?,
        )
        .ok_or_else(unavailable)
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The original request lease could not be observed.",
        "routing_currentness_unavailable",
    )
}
#[cfg(test)]
mod tests {
    #[test]
    fn no_kernel_never_uses_coordination_expiry_or_reads_an_abort_clock() {
        assert_eq!(
            super::kernel_timer_delay(None, || panic!("no kernel clock")).unwrap(),
            None
        );
        assert_eq!(
            super::kernel_timer_delay(Some(60_000), || Ok(59_000)).unwrap(),
            Some(1_000)
        );
    }
    #[test]
    fn timer_uses_confirmed_absolute_expiry_not_acknowledgement_time() {
        assert_eq!(super::timer_delay(60_000, 59_000).unwrap(), 1_000);
        assert_eq!(super::timer_delay(60_000, 90_000).unwrap(), 1);
    }
    #[test]
    fn renewal_keeps_original_tick_grid_and_skips_in_flight_ticks() {
        assert_eq!(super::next_tick(60_000, 70_000).unwrap(), 120_000);
        assert_eq!(super::next_tick(60_000, 190_000).unwrap(), 240_000);
    }
}
