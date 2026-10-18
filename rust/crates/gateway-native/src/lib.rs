//! Narrow native capabilities. No shell, arbitrary URL/path or generic JSON-RPC ingress.
pub mod access_publication;
pub mod control_publication;
pub mod credentials;
pub mod redaction;
pub mod supervisor;
#[cfg(unix)]
pub mod supervisor_brief;
#[cfg(unix)]
pub mod supervisor_data;
#[cfg(unix)]
pub mod supervisor_inventory;
#[cfg(unix)]
pub mod supervisor_metadata;
#[cfg(unix)]
pub mod supervisor_rollout;
pub mod transport;
#[cfg(unix)]
pub mod unix;

pub use credentials::*;
pub use supervisor::*;
pub use transport::*;
