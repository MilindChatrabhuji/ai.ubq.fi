//! One durable request lifetime and source-derived terminal billing; telemetry never mints authority.
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformTokens},
    routing_host,
    transport::stream::FinishHook,
};
use gateway_core::GatewayError;
use gateway_routing_runtime::{
    session::RoutingSession,
    types::{AttemptUsage, PreparedAttempt},
};
use serde_json::Value;
use std::{cell::RefCell, rc::Rc};
pub(crate) type Usage = Rc<RefCell<Option<Value>>>;

pub(crate) type Session =
    RoutingSession<RemoteAuthorityStore, PlatformTokens, PlatformClock, routing_host::Host>;

pub(crate) struct Lifecycle {
    pub(crate) session: Rc<Session>,
    pub(crate) currentness: crate::inference_currentness::CurrentnessGuard,
    pub(crate) attempt: PreparedAttempt,
    pub(crate) principal: gateway_auth::AuthPrincipal,
    pub(crate) provider_request_id: Option<String>,
    pub(crate) status: u16,
    pub(crate) store: RemoteAuthorityStore,
    pub(crate) pricing: Option<gateway_core::source_json::SourceJson>,
}

impl Lifecycle {
    pub(crate) async fn observe_terminal(
        &self,
        observation: gateway_core::lifecycle::TransportObservation,
        usage: Option<Value>,
    ) -> Result<(), GatewayError> {
        let extracted = gateway_core::source_usage::extract_usage_tokens(usage.as_ref());
        let paid = match &self.attempt.paid {
            Some(reservation) => {
                crate::paid_lookup::terminal_usage(
                    &self.store,
                    reservation,
                    extracted.as_ref(),
                    self.pricing.as_ref(),
                )
                .await?
            }
            None => None,
        };
        self.session
            .observe_terminal(
                &self.attempt,
                observation,
                AttemptUsage {
                    usage,
                    provider_request_id: self.provider_request_id.clone(),
                    status: Some(self.status),
                    paid,
                },
            )
            .await
            .map_err(|error| *error.error)
    }
    pub(crate) async fn finish(
        &self,
        observation: gateway_core::lifecycle::TransportObservation,
        usage: Option<Value>,
    ) -> Result<(), GatewayError> {
        self.observe_terminal(observation, usage).await?;
        self.session
            .finish(observation)
            .await
            .map_err(|error| *error.error)?;
        self.currentness.stop();
        Ok(())
    }
}

pub(crate) fn finish_hook(
    lifecycle: Rc<Lifecycle>,
    usage: Usage,
    permit: Option<gateway_admission::Permit>,
    capture: Rc<crate::inference_capture::Capture>,
) -> FinishHook {
    Box::new(move |observation| {
        Box::pin(async move {
            let usage = usage.borrow().clone();
            if let Err(error) = lifecycle.finish(observation, usage.clone()).await {
                worker::console_error!(
                    "Durable request settlement remains pending: {}",
                    error.envelope.error.message
                );
            }
            let paid = match &lifecycle.attempt.paid {
                Some(reservation) => {
                    match crate::paid_lookup::stored_attempt(&lifecycle.store, reservation).await {
                        Ok(row) => Some(row),
                        Err(error) => {
                            worker::console_error!(
                                "Paid terminal log observation remains unavailable: {}",
                                error.envelope.error.message
                            );
                            None
                        }
                    }
                }
                None => None,
            };
            capture
                .finish(observation, usage.as_ref(), paid.as_ref())
                .await;
            drop(permit);
        })
    })
}
