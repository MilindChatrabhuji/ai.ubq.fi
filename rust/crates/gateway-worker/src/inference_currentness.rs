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
    ObservedRoutingLease, RoutingError, RoutingLeaseState, local_work::KERNEL_RENEWAL_INTERVAL_MS,
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
        let expiry = lease
            .kernel_expires_at_ms()
            .map_or(lease.request_expires_at_ms(), |kernel| {
                kernel.min(lease.request_expires_at_ms())
            });
        // Construct first: a failed renewal/arming must leave the old confirmed timer intact.
        let timer = self
            .cancellation
            .set_timeout_ms(timer_delay(expiry, now_ms()?)?)?;
        *self.expiry.borrow_mut() = Some(timer);
        Ok(())
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
                    Err(_) => {
                        state.cancellation.abort();
                        state.stop();
                        break;
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
                    Err(_) => {
                        state.cancellation.abort();
                        state.stop();
                        break;
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
