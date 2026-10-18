//! All administrative routes remain authenticated. External/native effects are explicit capabilities.
pub mod audit;
pub mod keys;
pub mod kernel_keys;
pub mod operations;
pub mod routes;
pub mod reads;
pub mod service;

pub use operations::*;
pub use routes::*;
pub use service::AdminService;
