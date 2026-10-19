//! Pure provider protocols. This crate performs no network, credential, storage or quota I/O.
//! Callers own authoritative admission and must mark transport dispatch immediately before fetch.
pub mod anthropic;
pub mod chat;
mod claude_chat_stream;
pub mod extras;
pub mod finalize;
pub mod lithos;
pub mod paid_lookup;
pub mod policy;
pub mod replay;
pub mod request;
pub mod response;
pub mod sse;
pub mod tools;
pub mod types;
pub mod usage;
pub mod writer;
pub use request::prepare_request;
pub use response::decode_response;
pub use sse::StreamDecoder;
pub use types::*;
