//! Shared gateway contracts. No provider I/O, credentials, or persistence is implemented here.

pub mod claude;
pub mod error;
pub mod health;
pub mod identity;
pub mod js_string;
pub mod js_string_case;
pub mod lifecycle;
pub mod local_completion;
pub mod local_work;
pub mod model;
pub mod provider;
pub mod query;
pub mod redaction;
pub mod source_control;
pub mod source_graph;
pub mod source_json;
pub mod source_serialization;
pub mod source_usage;
pub mod state;
pub mod tuple_key;
pub mod value;

pub use error::GatewayError;
