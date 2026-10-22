//! All administrative routes remain authenticated. External/native effects are explicit capabilities.
pub mod audit;
pub mod kernel_auth;
pub mod kernel_keys;
pub mod keys;
pub mod operations;
pub mod reads;
pub mod routes;
pub mod service;
pub mod source_input;

pub use operations::*;
pub use routes::*;
pub use service::AdminService;
