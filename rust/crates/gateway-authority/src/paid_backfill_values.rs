use crate::{PAID_RETENTION_MS, add, nonnegative, paid::PaidAttempt, validate_time};
use gateway_core::{GatewayError, identity::MAX_SAFE_INTEGER};
use serde_json::{Value, json};

pub(super) fn expiry(anchor: i64, now: i64) -> Result<i64, GatewayError> {
    validate_time(anchor)?;
    Ok(add(anchor, PAID_RETENTION_MS)?.max(add(now, 1)?))
}
fn safe(value: &Value, minimum: i64) -> Option<i64> {
    value
        .as_f64()
        .filter(|number| {
            number.fract() == 0.0 && *number >= minimum as f64 && *number <= MAX_SAFE_INTEGER as f64
        })
        .map(|number| number as i64)
}
fn nonnegative_finite(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|number| number.is_finite() && *number >= 0.0)
}
pub(super) fn window_anchor(value: &Value) -> Option<i64> {
    if value["v"].as_f64() != Some(3.0)
        || !value["key_id"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 200)
        || !value["policy_version"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        || !(safe(&value["limit_microcredits"], 1).is_some()
            || value["limit_microcredits"].as_f64() == Some(-1.0))
        || [
            "settled_microcredits",
            "reserved_microcredits",
            "pending_count",
        ]
        .iter()
        .any(|field| safe(&value[*field], 0).is_none())
        || safe(&value["updated_at_ms"], 1).is_none()
    {
        return None;
    }
    safe(&value["window_reset_at_ms"], 1)
}
fn valid_rollup(value: &Value) -> bool {
    value["v"].as_f64() == Some(1.0)
        && ["model", "provider"]
            .iter()
            .all(|field| value[*field].as_str().is_some_and(|s| !s.is_empty()))
        && [
            "bucket_start_at_ms",
            "request_count",
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "first_request_at_ms",
            "last_request_at_ms",
            "updated_at_ms",
        ]
        .iter()
        .all(|field| safe(&value[*field], 0).is_some())
        && ["quota_sum", "spend_microcredits"]
            .iter()
            .all(|field| nonnegative_finite(&value[*field]).is_some())
}
pub(super) fn merge_rollup(
    existing: Option<&Value>,
    row: &PaidAttempt,
    model: &str,
    provider: &str,
    bucket: i64,
    now: i64,
) -> Result<Value, GatewayError> {
    let existing = existing.filter(|value| valid_rollup(value));
    let count = |field: &str| {
        existing
            .and_then(|value| safe(&value[field], 0))
            .unwrap_or(0)
    };
    let finite = |field: &str| {
        existing
            .and_then(|value| nonnegative_finite(&value[field]))
            .unwrap_or(0.0)
    };
    let input = nonnegative(row.input_tokens.unwrap_or(0))?;
    let cached = nonnegative(row.cached_input_tokens.unwrap_or(0))?;
    let output = nonnegative(row.output_tokens.unwrap_or(0))?;
    let spend = nonnegative(
        row.spend_microcredits
            .ok_or_else(|| crate::invalid("Paid backfill spend missing."))?,
    )?;
    let quota = row
        .provider_quota
        .filter(|quota| quota.is_finite() && *quota >= 0.0)
        .ok_or_else(|| crate::invalid("Paid backfill quota invalid."))?;
    let quota = finite("quota_sum") + quota;
    let spend = finite("spend_microcredits") + spend as f64;
    if !quota.is_finite() || !spend.is_finite() {
        return Err(crate::invalid("Paid backfill rollup overflow."));
    }
    // Source JSON.stringify emits safe integral numbers without a decimal suffix.
    // Preserve that representation for the existing live settlement DTO; retain
    // genuine fractional/large source spend rather than rounding or inventing it.
    let spend = if spend.fract() == 0.0 && spend <= MAX_SAFE_INTEGER as f64 {
        json!(spend as i64)
    } else {
        json!(spend)
    };
    Ok(json!({
        "v":1,
        "bucket_start_at_ms":existing.map(|value| value["bucket_start_at_ms"].clone()).unwrap_or(json!(bucket)),
        "model":existing.map(|value| value["model"].clone()).unwrap_or(json!(model)),
        "provider":existing.map(|value| value["provider"].clone()).unwrap_or(json!(provider)),
        "request_count":add(count("request_count"),1)?,
        "quota_sum":quota,
        "input_tokens":add(count("input_tokens"),input)?,
        "cached_input_tokens":add(count("cached_input_tokens"),cached)?,
        "output_tokens":add(count("output_tokens"),output)?,
        "spend_microcredits":spend,
        "first_request_at_ms":existing.and_then(|value| safe(&value["first_request_at_ms"],0)).map_or(row.reservation.created_at_ms,|old| old.min(row.reservation.created_at_ms)),
        "last_request_at_ms":existing.and_then(|value| safe(&value["last_request_at_ms"],0)).map_or(row.reservation.created_at_ms,|old| old.max(row.reservation.created_at_ms)),
        "updated_at_ms":now,
    }))
}
