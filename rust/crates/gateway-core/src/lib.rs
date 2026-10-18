//! Shared gateway contracts. No provider I/O, credentials, or persistence is implemented here.

pub mod error;
pub mod health;
pub mod identity;
pub mod lifecycle;
pub mod provider;
pub mod query;
pub mod state;
pub mod tuple_key;

pub use error::GatewayError;
