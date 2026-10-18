//! Fixed native owner-effect injection. The shared authority implementation
//! owns action preparation, current-fact checks, claims and reconciliation.
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

use gateway_auth::{
    GatewayError,
    native_auth::AuthenticatedNativeOwner,
    native_control::{NativeControlEnvelope, NativeControlResponse},
};

pub struct NativeControlContext<'a> {
    deadline: Instant,
    disconnected: &'a dyn Fn() -> bool,
}
impl<'a> NativeControlContext<'a> {
    pub(crate) fn admitted(deadline: Instant, disconnected: &'a dyn Fn() -> bool) -> Self {
        Self {
            deadline,
            disconnected,
        }
    }
    pub fn deadline(&self) -> Instant {
        self.deadline
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
