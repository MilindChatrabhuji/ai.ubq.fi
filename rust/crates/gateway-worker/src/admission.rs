//! Source isolate-local admission. This state holds no platform I/O or credentials.
use std::{
    future::{Future, poll_fn},
    pin::pin,
    rc::Rc,
    task::Poll,
    time::Duration,
};

use gateway_admission::{
    AdmissionCancellation, AdmissionClock, AdmissionController, AdmissionRequest, AdmissionResult,
    AdmissionWait, Permit, WaitFuture,
};
use gateway_auth::AuthPrincipal;
use gateway_core::GatewayError;
use worker::js_sys::{Function, Reflect};
use worker::wasm_bindgen::{JsCast, JsValue};

use crate::transport::outbound::Cancellation;

struct Clock;

pub fn monotonic() -> Result<Duration, GatewayError> {
    let unavailable = || {
        GatewayError::unavailable(
            "The admission clock is unavailable.",
            "admission_clock_unavailable",
        )
    };
    let performance = Reflect::get(&worker::js_sys::global(), &JsValue::from_str("performance"))
        .map_err(|_| unavailable())?;
    let now = Reflect::get(&performance, &JsValue::from_str("now"))
        .map_err(|_| unavailable())?
        .dyn_into::<Function>()
        .map_err(|_| unavailable())?;
    let milliseconds = now
        .call0(&performance)
        .map_err(|_| unavailable())?
        .as_f64()
        .ok_or_else(unavailable)?;
    Duration::try_from_secs_f64(milliseconds / 1000.0).map_err(|_| unavailable())
}

impl AdmissionClock for Clock {
    fn now(&self) -> Duration {
        // Requests validate this clock before queueing. A later platform failure
        // expires waits rather than supplying a fictitious earlier timestamp.
        monotonic().unwrap_or(Duration::MAX)
    }
}

thread_local! {
    static CONTROLLER: AdmissionController = AdmissionController::new(Rc::new(Clock));
}

impl AdmissionCancellation for Cancellation {
    fn is_cancelled(&self) -> bool {
        self.client_aborted()
    }
}

impl AdmissionWait for Cancellation {
    fn wait_until<'a>(
        &'a self,
        deadline: Duration,
        cancellation: &'a dyn AdmissionCancellation,
    ) -> WaitFuture<'a> {
        Box::pin(async move {
            let mut delay = pin!(worker::Delay::from(deadline.saturating_sub(Clock.now())));
            poll_fn(|context| {
                self.register_waker(context.waker());
                if cancellation.is_cancelled() {
                    Poll::Ready(())
                } else {
                    delay.as_mut().poll(context)
                }
            })
            .await;
        })
    }
}

pub async fn acquire(
    principal: &AuthPrincipal,
    request_id: &str,
    route: &str,
    cancellation: Rc<Cancellation>,
) -> Result<Option<Permit>, GatewayError> {
    monotonic()?;
    let request = AdmissionRequest {
        principal: Some(crate::lifecycle::principal_id(principal)),
        request_id: request_id.to_owned(),
        route: route.to_owned(),
        cancellation: cancellation.clone(),
    };
    let controller = CONTROLLER.with(Clone::clone);
    match controller.acquire(request, cancellation.as_ref()).await {
        AdmissionResult::Admitted { permit, .. } => Ok(Some(permit)),
        AdmissionResult::Bypassed => Ok(None),
        AdmissionResult::LocalOverload { cause, .. } => {
            Err(gateway_admission::overload_error(cause))
        }
        AdmissionResult::CallerAborted { .. } => Err(gateway_admission::cancellation_error()),
    }
}
