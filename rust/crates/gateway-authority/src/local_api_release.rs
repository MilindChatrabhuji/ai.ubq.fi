//! Exact local unused-release source errors, not a generic HTTP/error capability.
use crate::quota::ApiReservation;
use crate::{Authority, TokenSource};
use gateway_core::{GatewayError, state::AuthorityStore};

#[derive(Clone, Copy)]
pub(crate) enum ReleaseFailureOrigin {
    Malformed,
    ChangedConcurrently,
    Unavailable,
}
pub(crate) struct ReleaseFailure {
    origin: ReleaseFailureOrigin,
    diagnostic: GatewayError,
}
impl ReleaseFailure {
    pub(crate) fn malformed(diagnostic: GatewayError) -> Self {
        Self {
            origin: ReleaseFailureOrigin::Malformed,
            diagnostic,
        }
    }
    pub(crate) fn unavailable(diagnostic: GatewayError) -> Self {
        Self {
            origin: ReleaseFailureOrigin::Unavailable,
            diagnostic,
        }
    }
    pub(crate) fn changed(diagnostic: GatewayError) -> Self {
        Self {
            origin: ReleaseFailureOrigin::ChangedConcurrently,
            diagnostic,
        }
    }
    pub(crate) fn into_diagnostic(self) -> GatewayError {
        self.diagnostic
    }
    fn into_local(self) -> LocalApiReleaseQuotaError {
        LocalApiReleaseQuotaError {
            origin: self.origin,
        }
    }
}

/// Actual completed release/no-op data. Never admission or inference permission.
#[derive(Debug)]
pub struct LocalApiReleaseCompletion {
    released: bool,
}
impl LocalApiReleaseCompletion {
    pub fn was_released(&self) -> bool {
        self.released
    }
}
/// Closed source quota error with no caller-selected status, body or headers.
pub struct LocalApiReleaseQuotaError {
    origin: ReleaseFailureOrigin,
}
impl LocalApiReleaseQuotaError {
    pub fn as_gateway_error(&self) -> GatewayError {
        let message = match self.origin {
            ReleaseFailureOrigin::Malformed => "API key quota reservation is malformed",
            ReleaseFailureOrigin::ChangedConcurrently => {
                "API key quota reservation changed concurrently"
            }
            ReleaseFailureOrigin::Unavailable => "API key quota reservation is unavailable",
        };
        GatewayError::unavailable(message, "api_key_quota_reservation_unavailable")
    }
}
impl std::fmt::Debug for LocalApiReleaseQuotaError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("LocalApiReleaseQuotaError")
            .field(&self.as_gateway_error())
            .finish()
    }
}
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn release_local_response_api(
        &self,
        reservation: &ApiReservation,
        now: i64,
    ) -> Result<LocalApiReleaseCompletion, LocalApiReleaseQuotaError> {
        self.release_api_key_classified(
            reservation,
            false,
            "route_completed_without_provider_dispatch",
            now,
        )
        .await
        .map(|released| LocalApiReleaseCompletion { released })
        .map_err(ReleaseFailure::into_local)
    }
}

#[cfg(test)]
mod tests;
