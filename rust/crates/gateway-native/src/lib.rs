//! Narrow native capabilities. No shell, arbitrary URL/path or generic JSON-RPC ingress.
/// A compile-time fixture artifact is never an ordinary native service, even
/// when dependency feature unification enabled it without the native feature.
pub fn require_production_artifact() -> Result<(), gateway_auth::GatewayError> {
    if gateway_authority::NATIVE_IMPORT_FIXTURE_ENABLED {
        return Err(gateway_auth::GatewayError::unavailable(
            "Fixture-enabled artifacts cannot run native services",
            "native_fixture_artifact_forbidden",
        ));
    }
    Ok(())
}
#[cfg(unix)]
#[doc(hidden)]
pub mod connector_fd;
#[cfg(unix)]
#[doc(hidden)]
pub mod connector_policy;
#[cfg(unix)]
#[doc(hidden)]
pub mod connector_protocol;
#[cfg(unix)]
mod connector_supervisor;
#[cfg(unix)]
#[doc(hidden)]
pub mod connector_worker;
#[cfg(unix)]
mod daemon_startup;
#[cfg(unix)]
mod native_request_process;
#[cfg(unix)]
pub use connector_supervisor::run_native_supervisor;
#[cfg(unix)]
pub use connector_worker::run_native_connector;
#[cfg(unix)]
pub use existing_account_import::import_process::run_native_import;
#[cfg(all(unix, feature = "native-import-fixture"))]
pub use existing_account_import::import_process::run_native_import_fixture;
#[cfg(unix)]
pub use native_request_process::run_native_request;
pub mod access_publication;
#[cfg(unix)]
pub mod authority_http;
pub mod confinement;
pub mod control_publication;
pub mod credentials;
pub mod daemon_config;
#[cfg(unix)]
pub mod existing_account_import;
#[cfg(unix)]
pub mod http_server;
#[cfg(unix)]
pub mod import_client;
#[cfg(unix)]
mod import_custody_protocol;
#[cfg(unix)]
mod import_ingress;
#[cfg(unix)]
pub mod live_bridge;
#[cfg(unix)]
pub mod managed_publication_http;
pub mod native_import;
#[cfg(unix)]
pub mod nonce_sqlite;
pub mod owner_control;
#[cfg(unix)]
pub mod owner_renewal;
#[cfg(unix)]
mod private_https;
#[cfg(unix)]
pub mod publication_http;
pub mod redaction;
pub mod supervisor;
#[cfg(unix)]
pub mod supervisor_brief;
#[cfg(unix)]
pub mod supervisor_data;
#[cfg(unix)]
pub mod supervisor_inventory;
#[cfg(unix)]
pub mod supervisor_metadata;
#[cfg(unix)]
pub mod supervisor_rollout;
pub mod transport;
#[cfg(unix)]
pub mod unix;

pub use credentials::*;
pub use supervisor::*;
pub use transport::*;
