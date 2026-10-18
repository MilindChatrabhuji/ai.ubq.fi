use gateway_core::{GatewayError, state::AuthorityStore};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    crypto::{Secret, sha256_base64url},
    store, unauthorized,
};

pub const NO_LIMIT: i64 = -1;
pub const WEEK_MS: i64 = 604_800_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ApiKeyHashRecord {
    pub id: String,
    pub expires_at_ms: i64,
    pub revoked_at_ms: Option<i64>,
    pub usage_limit_requests: i64,
    pub usage_requests: i64,
    pub usage_reset_at_ms: i64,
    pub window_ms: i64,
    pub usage_quota_version: u32,
    pub paid_fallback_enabled: bool,
    pub paid_fallback_limit_microcredits: i64,
    pub paid_fallback_spent_microcredits: i64,
    pub paid_fallback_reserved_microcredits: i64,
    pub paid_fallback_reservation_request_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ApiKeyPolicy {
    pub token_hash: String,
    pub key_id: String,
    pub expires_at_ms: i64,
    pub usage_limit_requests: i64,
    pub window_ms: i64,
    pub window_start_ms: i64,
    pub usage_reset_at_ms: i64,
    pub policy_version: String,
    pub paid_fallback_enabled: bool,
    pub paid_fallback_limit_microcredits: i64,
    pub paid_fallback_spent_microcredits: i64,
    pub paid_fallback_reserved_microcredits: i64,
    pub paid_fallback_reservation_request_id: Option<String>,
}

pub fn api_key_shape(token: &str) -> bool {
    token.len() == 66
        && token.starts_with("u_")
        && token.as_bytes()[2..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

pub fn generate_token(bytes: &[u8]) -> Result<Secret, GatewayError> {
    if bytes.len() != 32 {
        return Err(GatewayError::unavailable(
            "Random source returned the wrong length",
            "auth_random_unavailable",
        ));
    }
    Ok(Secret::new(format!(
        "u_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )))
}

pub fn hash_key(hash: &str) -> gateway_core::state::RecordKey {
    store::key(json!(["ubq_ai", "api_keys", "hash", hash]))
}
pub fn id_key(id: &str) -> gateway_core::state::RecordKey {
    store::key(json!(["ubq_ai", "api_keys", "id", id]))
}

pub fn current_window(reset: i64, window: i64, now: i64) -> Result<(i64, i64), GatewayError> {
    if window <= 0 || reset < 0 || now < 0 {
        return Err(GatewayError::unavailable(
            "API key quota policy is corrupt",
            "api_key_policy_invalid",
        ));
    }
    let initial = reset.checked_sub(window).ok_or_else(|| {
        GatewayError::unavailable("API key quota policy overflows", "api_key_policy_invalid")
    })?;
    if now < reset {
        return Ok((initial, reset));
    }
    let elapsed = (now - initial).div_euclid(window);
    let start = initial
        .checked_add(elapsed.checked_mul(window).ok_or_else(|| {
            GatewayError::unavailable("API key quota policy overflows", "api_key_policy_invalid")
        })?)
        .ok_or_else(|| {
            GatewayError::unavailable("API key quota policy overflows", "api_key_policy_invalid")
        })?;
    let end = start.checked_add(window).ok_or_else(|| {
        GatewayError::unavailable("API key quota policy overflows", "api_key_policy_invalid")
    })?;
    Ok((start, end))
}

pub fn policy_from_record(
    hash: String,
    record: ApiKeyHashRecord,
    now: i64,
) -> Result<ApiKeyPolicy, GatewayError> {
    if record.revoked_at_ms.is_some()
        || (record.expires_at_ms != NO_LIMIT && record.expires_at_ms <= now)
    {
        return Err(unauthorized());
    }
    if record.usage_quota_version != 3
        || record.usage_limit_requests < NO_LIMIT
        || record.paid_fallback_limit_microcredits < NO_LIMIT
        || record.paid_fallback_spent_microcredits < 0
        || record.paid_fallback_reserved_microcredits < 0
    {
        return Err(GatewayError::unavailable(
            "API key quota migration is incomplete",
            "server_error",
        ));
    }
    let window = if record.window_ms > 0 {
        record.window_ms
    } else {
        WEEK_MS
    };
    let (start, reset) = current_window(record.usage_reset_at_ms, window, now)?;
    Ok(ApiKeyPolicy {
        token_hash: hash,
        key_id: record.id,
        expires_at_ms: record.expires_at_ms,
        usage_limit_requests: record.usage_limit_requests,
        window_ms: window,
        window_start_ms: start,
        usage_reset_at_ms: reset,
        policy_version: format!("v3:{window}"),
        paid_fallback_enabled: record.paid_fallback_enabled,
        paid_fallback_limit_microcredits: record.paid_fallback_limit_microcredits,
        paid_fallback_spent_microcredits: record.paid_fallback_spent_microcredits,
        paid_fallback_reserved_microcredits: record.paid_fallback_reserved_microcredits,
        paid_fallback_reservation_request_id: record.paid_fallback_reservation_request_id,
    })
}

pub async fn authenticate<S: AuthorityStore>(
    store: &S,
    token: &str,
    now: i64,
) -> Result<ApiKeyPolicy, GatewayError> {
    if !api_key_shape(token) {
        return Err(unauthorized());
    }
    let hash = sha256_base64url(token.as_bytes());
    let row = store.read(&hash_key(&hash)).await?;
    let Some(row) = row else {
        return Err(unauthorized());
    };
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|exp| exp <= now) {
        return Err(unauthorized());
    }
    if row.json_value()?.get("revoked_at_ms") != Some(&serde_json::Value::Null) {
        return Err(unauthorized());
    }
    let record = serde_json::from_value(row.json_value()?.clone()).map_err(|_| {
        GatewayError::unavailable("API key quota migration is incomplete", "server_error")
    })?;
    // Authentication reads policy only. Admission/dispatch owns V3 quota reservations.
    policy_from_record(hash, record, now)
}
