//! Authentication policy and durable ceremonies. Host capabilities never decide authorization.

pub mod api_keys;
pub mod crypto;
pub mod origin;
pub mod passkeys;
pub mod resolve;
pub mod store;
pub mod types;
pub mod upstream;

pub use gateway_core::GatewayError;
pub use passkeys::PasskeyService;
pub use resolve::AuthService;
pub use types::*;
