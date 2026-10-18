//! Claude subscription selection and source quota publication in the common authority.
//! Admission/settlement and paid authorization remain the existing m14/m03 owners.
pub mod quota;
pub mod response;
pub mod host;
mod pool;
mod persistence;
mod workspace;

pub use host::*;
pub use pool::ClaudePoolSession;
pub use persistence::{clear_guards,quota_key};

use gateway_core::GatewayError;
pub(crate) fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message,"claude_code_upstream_unreachable")
}
pub(crate) fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400,message,Some("claude_code_request_invalid"))
}
