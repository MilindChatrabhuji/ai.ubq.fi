//! Source inference orchestration. Network/body ownership remains in the Worker adapter.
mod attempt;
pub mod classify;
mod dispatch;
pub mod extras;
mod journal;
pub mod policy;
mod session;
mod settlement;
pub mod types;
mod wire;
pub use extras::{AdmissionHandle, ChildScope, DispatchTicket, ExtrasFamily};
pub use session::RoutingSession;
pub use settlement::recover_pending;
pub use types::*;
