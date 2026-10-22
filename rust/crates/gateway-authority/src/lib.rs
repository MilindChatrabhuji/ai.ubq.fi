//! Source-derived authority transitions. All provider/native I/O remains outside transactions.
//! The store must atomically commit every check and mutation, durably, before returning.
//! Independent records preserve history without a bounded whole-ledger snapshot.

#[cfg(all(feature = "native-import-fixture", not(debug_assertions)))]
compile_error!("native-import-fixture is forbidden in non-debug production builds");
/// Denial marker only. Native service entrypoints must refuse when this is true.
pub const NATIVE_IMPORT_FIXTURE_ENABLED: bool = cfg!(feature = "native-import-fixture");

pub mod cache_experiment;
pub mod capacity;
mod capacity_rules;
pub mod claude;
pub mod full_pool_reset;
pub mod initial_control_owner;
mod kernel;
pub mod keys;
pub mod local_api_release;
pub mod local_completion;
pub mod manual_reset;
pub mod native_control;
pub mod native_live;
pub mod paid;
pub mod paid_backfill;
pub mod paid_control;
mod paid_types;
mod probes;
pub mod quota;
pub mod reset;
mod reset_recovery;
mod reset_types;
pub mod routing;
mod routing_codec;
mod routing_rules;
mod routing_types;
mod source_models;
mod store;

pub use paid_types::model_map as source_model_map;
pub use store::{Authority, AuthorityClock, TokenSource};

use gateway_core::GatewayError;
use gateway_core::identity::{MAX_SAFE_INTEGER, UnixMillis};

pub const MINUTE_MS: i64 = 60_000;
pub const DAY_MS: i64 = 86_400_000;
pub const QUOTA_RETENTION_MS: i64 = 7 * DAY_MS;
pub const PAID_RETENTION_MS: i64 = 365 * DAY_MS;
pub const REQUEST_LEASE_MS: i64 = 5 * MINUTE_MS;
pub const PROBE_LEASE_MS: i64 = 30_000;

pub(crate) fn unavailable(code: &str, message: &str) -> GatewayError {
    GatewayError::unavailable(message, code)
}

pub(crate) fn invalid(message: &str) -> GatewayError {
    unavailable("authority_state_invalid", message)
}

pub(crate) fn quota_error(message: &str, code: &str) -> GatewayError {
    GatewayError::new(429, message, Some(code))
}

pub(crate) fn validate_time(now: UnixMillis) -> Result<(), GatewayError> {
    nonnegative(now).map(|_| ())
}

pub(crate) fn nonnegative(value: i64) -> Result<i64, GatewayError> {
    if (0..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(value)
    } else {
        Err(invalid("Expected a nonnegative safe integer."))
    }
}

pub(crate) fn positive(value: i64) -> Result<i64, GatewayError> {
    if value > 0 {
        nonnegative(value)
    } else {
        Err(invalid("Expected a positive safe integer."))
    }
}

pub(crate) fn add(left: i64, right: i64) -> Result<i64, GatewayError> {
    nonnegative(
        left.checked_add(right)
            .ok_or_else(|| invalid("Authority counter overflow."))?,
    )
}

pub(crate) fn generation(value: u64) -> Result<u64, GatewayError> {
    if value <= MAX_SAFE_INTEGER as u64 {
        Ok(value)
    } else {
        Err(invalid("Invalid authority generation."))
    }
}

pub(crate) fn next_generation(value: u64) -> Result<u64, GatewayError> {
    generation(
        value
            .checked_add(1)
            .ok_or_else(|| invalid("Authority generation overflow."))?,
    )
}

pub(crate) fn text(value: &str) -> Result<(), GatewayError> {
    if !value.trim().is_empty() && value.len() <= 4096 {
        Ok(())
    } else {
        Err(invalid("Missing or oversized authority identity."))
    }
}

pub(crate) fn retention(anchor: i64, duration: i64) -> Result<i64, GatewayError> {
    add(anchor, duration)
}
