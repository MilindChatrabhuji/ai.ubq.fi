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
fn source_safe(value: Option<&gateway_core::source_json::SourceJson>, minimum: i64) -> Option<i64> {
    value
        .and_then(gateway_core::source_serialization::number)
        .filter(|number| {
            number.is_finite()
                && number.fract() == 0.0
                && *number >= minimum as f64
                && *number <= MAX_SAFE_INTEGER as f64
        })
        .map(|number| number as i64)
}
fn source_finite(value: Option<&gateway_core::source_json::SourceJson>) -> Option<f64> {
    value
        .and_then(gateway_core::source_serialization::number)
        .filter(|number| number.is_finite() && *number >= 0.0)
}
fn valid_rollup(value: &gateway_core::source_json::SourceJson) -> bool {
    use gateway_core::source_serialization as source;
    source::member(value, "v").as_ref().and_then(source::number) == Some(1.0)
        && ["model", "provider"].iter().all(|field| {
            source::member(value, field)
                .as_ref()
                .and_then(source::string)
                .is_some_and(|value| !value.as_units().is_empty())
        })
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
        .all(|field| source_safe(source::member(value, field).as_ref(), 0).is_some())
        && ["quota_sum", "spend_microcredits"]
            .iter()
            .all(|field| source_finite(source::member(value, field).as_ref()).is_some())
}
/// The sole historical merge engine. Model labels and unknown source leaves never
/// enter Value; numeric accumulation and source invalid-row replacement are unchanged.
pub(super) fn merge_source_rollup(
    existing: Option<&gateway_core::source_json::SourceJson>,
    row: &PaidAttempt,
    model: &gateway_core::model::ModelId,
    provider: &str,
    bucket: i64,
    now: i64,
) -> Result<gateway_core::source_json::SourceJson, GatewayError> {
    use gateway_core::{source_json::SourceJson, source_serialization as source};
    let existing = existing.filter(|value| valid_rollup(value));
    let field = |name: &str| existing.and_then(|value| source::member(value, name));
    let count = |name: &str| source_safe(field(name).as_ref(), 0).unwrap_or(0);
    let finite = |name: &str| source_finite(field(name).as_ref()).unwrap_or(0.0);
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
    // Keep existing source-safe integral spend emission and genuine fractions.
    let spend = if spend.fract() == 0.0 && spend <= MAX_SAFE_INTEGER as f64 {
        json!(spend as i64)
    } else {
        json!(spend)
    };
    source::object(vec![
        ("v", SourceJson::from_serializable(&1)?),
        (
            "bucket_start_at_ms",
            field("bucket_start_at_ms").unwrap_or(SourceJson::from_serializable(&bucket)?),
        ),
        ("model", field("model").unwrap_or(model.to_source_json()?)),
        (
            "provider",
            field("provider").unwrap_or(SourceJson::from_serializable(provider)?),
        ),
        (
            "request_count",
            SourceJson::from_serializable(&add(count("request_count"), 1)?)?,
        ),
        ("quota_sum", SourceJson::from_serializable(&quota)?),
        (
            "input_tokens",
            SourceJson::from_serializable(&add(count("input_tokens"), input)?)?,
        ),
        (
            "cached_input_tokens",
            SourceJson::from_serializable(&add(count("cached_input_tokens"), cached)?)?,
        ),
        (
            "output_tokens",
            SourceJson::from_serializable(&add(count("output_tokens"), output)?)?,
        ),
        ("spend_microcredits", SourceJson::from_serializable(&spend)?),
        (
            "first_request_at_ms",
            SourceJson::from_serializable(
                &source_safe(field("first_request_at_ms").as_ref(), 0)
                    .map_or(row.reservation.created_at_ms, |old| {
                        old.min(row.reservation.created_at_ms)
                    }),
            )?,
        ),
        (
            "last_request_at_ms",
            SourceJson::from_serializable(
                &source_safe(field("last_request_at_ms").as_ref(), 0)
                    .map_or(row.reservation.created_at_ms, |old| {
                        old.max(row.reservation.created_at_ms)
                    }),
            )?,
        ),
        ("updated_at_ms", SourceJson::from_serializable(&now)?),
    ])
}

#[cfg(test)]
pub(super) fn merge_rollup(
    existing: Option<&Value>,
    row: &PaidAttempt,
    model: &str,
    provider: &str,
    bucket: i64,
    now: i64,
) -> Result<Value, GatewayError> {
    let existing = existing
        .map(gateway_core::source_json::SourceJson::from_serializable)
        .transpose()?;
    merge_source_rollup(existing.as_ref(), row, &model.into(), provider, bucket, now)?.deserialize()
}
