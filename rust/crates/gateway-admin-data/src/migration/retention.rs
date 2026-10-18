use super::starts;
use crate::integer;
use serde_json::Value;
pub const DAY: i64 = 86_400_000;
pub const USAGE_RETENTION: i64 = 7 * DAY;
pub const REQUEST_RETENTION: i64 = 365 * DAY;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Expiry {
    Durable,
    At(i64),
    Skip,
}
pub fn bounded_expiry(anchor: Option<i64>, retention: i64, now: i64) -> Expiry {
    anchor
        .and_then(|a| a.checked_add(retention))
        .filter(|v| *v <= 9_007_199_254_740_991 && *v > now)
        .map(Expiry::At)
        .unwrap_or(Expiry::Skip)
}
pub fn request_window_reset(parts: &[Value]) -> Option<i64> {
    if parts.len() != 8 {
        return None;
    }
    let version = parts[5].as_str()?;
    let start = parts[6]
        .as_i64()
        .filter(|v| *v >= 0 && *v <= 9_007_199_254_740_991)?;
    let span = version
        .strip_prefix("v3:")?
        .parse::<i64>()
        .ok()
        .filter(|v| *v > 0)?;
    if version != format!("v3:{span}") {
        return None;
    }
    start
        .checked_add(span)
        .filter(|v| *v <= 9_007_199_254_740_991)
}
pub fn migration_expiry(parts: &[Value], value: &Value, now: i64) -> Expiry {
    if starts(parts, &["uos_ai", "api_key_usage", "v3", "window"]) {
        return bounded_expiry(integer(value, "window_reset_at_ms"), USAGE_RETENTION, now);
    }
    if starts(parts, &["uos_ai", "api_key_usage", "v3", "request"]) {
        return bounded_expiry(request_window_reset(parts), USAGE_RETENTION, now);
    }
    if starts(parts, &["ubq_ai", "api_keys", "request_log"])
        || starts(parts, &["uos_ai", "paid_fallback", "ledger"])
    {
        return bounded_expiry(integer(value, "created_at_ms"), REQUEST_RETENTION, now);
    }
    if starts(parts, &["uos_ai", "paid_fallback", "v3", "window"]) {
        return bounded_expiry(integer(value, "window_reset_at_ms"), REQUEST_RETENTION, now);
    }
    if starts(parts, &["uos_ai", "paid_fallback", "v3", "request"]) {
        return bounded_expiry(integer(value, "created_at_ms"), REQUEST_RETENTION, now);
    }
    if starts(parts, &["uos_ai", "paid_fallback", "v3", "pending"]) {
        return Expiry::Durable;
    }
    if starts(
        parts,
        &["uos_ai", "paid_fallback", "v3", "reconciliation_lease"],
    ) {
        return bounded_expiry(integer(value, "expires_at_ms"), 0, now);
    }
    if starts(parts, &["embeddings", "idempotency", "v1", "response"]) {
        return now
            .checked_add(8 * DAY)
            .map(Expiry::At)
            .unwrap_or(Expiry::Skip);
    }
    if starts(parts, &["embeddings", "idempotency", "v1"]) {
        let anchor = if value.get("updated_at_ms").is_some_and(|v| !v.is_null()) {
            integer(value, "updated_at_ms")
        } else if value.get("created_at_ms").is_some_and(|v| !v.is_null()) {
            integer(value, "created_at_ms")
        } else {
            Some(now)
        };
        return bounded_expiry(anchor, 7 * DAY, now);
    }
    if starts(parts, &["uos_ai", "kernel_quota", "v2", "repo_window"])
        || starts(parts, &["uos_ai", "kernel_quota", "v2", "org_window"])
    {
        return bounded_expiry(integer(value, "usage_reset_at_ms"), 7 * DAY, now);
    }
    if starts(parts, &["uos_ai", "kernel_quota", "v2", "repo_reservation"])
        || starts(parts, &["uos_ai", "kernel_quota", "v2", "org_reservation"])
    {
        return bounded_expiry(integer(value, "window_reset_at_ms"), 7 * DAY, now);
    }
    Expiry::Durable
}
