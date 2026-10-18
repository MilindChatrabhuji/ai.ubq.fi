//! Claude subscription selection and source quota publication in the common authority.
//! Admission/settlement and paid authorization remain the existing m14/m03 owners.
pub mod host;
mod persistence;
mod pool;
pub mod quota;
pub mod response;
mod workspace;

pub use host::*;
pub use persistence::{clear_guards, quota_key};
pub use pool::ClaudePoolSession;

use gateway_core::GatewayError;
pub(crate) fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "claude_code_upstream_unreachable")
}
pub(crate) fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("claude_code_request_invalid"))
}
