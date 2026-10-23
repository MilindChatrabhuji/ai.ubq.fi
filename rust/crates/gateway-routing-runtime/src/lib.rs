//! Source inference orchestration. Network/body ownership remains in the Worker adapter.
mod attempt;
pub mod classify;
pub mod currentness;
pub mod custody;
mod dispatch;
pub mod extras;
mod journal;
pub mod local_work;
pub mod policy;
mod response_head;
pub mod session;
pub mod settlement;
pub mod types;
mod wire;
