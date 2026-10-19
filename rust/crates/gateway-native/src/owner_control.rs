//! Fixed native owner-effect injection. The shared authority implementation
//! owns action preparation, current-fact checks, claims and reconciliation.
use std::time::{SystemTime, UNIX_EPOCH};
use std::{future::Future, time::Instant};

use gateway_auth::{
    GatewayError,
    native_auth::{AuthenticatedNativeOwner, NativeAuthHeaders},
    native_control::{NativeControlEnvelope, NativeControlResponse},
};

pub struct NativeControlContext<'a> {
    deadline: Instant,
    disconnected: &'a dyn Fn() -> bool,
    original_auth: NativeAuthHeaders<'a>,
}
impl<'a> NativeControlContext<'a> {
    #[cfg(unix)]
    pub(crate) fn admitted(
        deadline: Instant,
        disconnected: &'a dyn Fn() -> bool,
        original_auth: NativeAuthHeaders<'a>,
    ) -> Self {
        Self {
            deadline,
            disconnected,
            original_auth,
        }
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
    }
    pub fn original_auth_headers(&self) -> NativeAuthHeaders<'a> {
        self.original_auth
    }
    pub fn now_ms(&self) -> Result<i64, GatewayError> {
        let value = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .filter(|value| *value <= gateway_core::identity::MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                GatewayError::unavailable(
                    "Native control clock is unavailable",
                    "native_clock_unavailable",
                )
            })?;
        Ok(value)
    }
    pub fn cancelled(&self) -> bool {
        Instant::now() >= self.deadline || (self.disconnected)()
    }
    pub fn check(&self) -> Result<(), GatewayError> {
        if self.cancelled() {
            return Err(GatewayError::unavailable(
                "Native control was interrupted; reconcile the original action",
                "native_control_outcome_unknown",
            ));
        }
        Ok(())
    }
}

/// This is not a deserializable authorization or a generic operation callback.
/// Implementations must reconstruct/claim the prepared action in the SAME
/// authority, check before dispatch and after awaits, and reconcile an unknown
/// original operation without invoking another upstream refresh.
pub trait NativeOwnerRenewalHandler: Send + Sync {
    fn renew(
        &self,
        proof: &AuthenticatedNativeOwner,
        request: &NativeControlEnvelope,
        raw_body: &[u8],
        context: &NativeControlContext<'_>,
    ) -> Result<NativeControlResponse, GatewayError>;
}

/// Constructor-owned bridge to the original durable action. The start hook
/// must atomically commit possible-effect intent and refuse replay/unknown.
/// None of these methods can be supplied by deserializing request fields.
pub trait NativeRenewalGuard {
    fn now_ms(&self) -> Result<i64, GatewayError>;
    fn ensure_current(&self) -> impl Future<Output = Result<(), GatewayError>>;
    fn start_refresh(&self) -> impl Future<Output = Result<(), GatewayError>>;
}
