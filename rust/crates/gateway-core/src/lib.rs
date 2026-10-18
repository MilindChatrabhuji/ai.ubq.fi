//! Shared gateway contracts. No provider I/O, credentials, or persistence is implemented here.

pub mod claude;
pub mod error;
pub mod health;
pub mod identity;
pub mod js_string;
pub mod lifecycle;
pub mod provider;
pub mod query;
pub mod redaction;
pub mod source_graph;
pub mod source_json;
pub mod state;
pub mod tuple_key;
pub mod value;

pub use error::GatewayError;
