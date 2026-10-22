//! Authentication policy and durable ceremonies. Host capabilities never decide authorization.

pub mod api_keys;
pub mod bootstrap;
pub mod crypto;
pub mod managed_access;
pub mod native;
pub mod native_auth;
pub mod native_control;
pub mod native_credentials;
pub mod native_import;
pub mod native_live;
pub mod native_replay;
pub mod origin;
pub mod passkeys;
pub mod passport;
pub mod provider_credentials;
pub mod resolve;
pub mod session_index;
pub mod store;
pub mod types;
pub mod upstream;
pub mod webauthn;

pub use gateway_core::GatewayError;
pub use passkeys::PasskeyService;
pub use resolve::AuthService;
pub use types::*;
