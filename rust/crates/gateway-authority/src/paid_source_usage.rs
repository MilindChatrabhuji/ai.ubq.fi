//! Source recordSurplusUsage adapter over the one already-extracted usage object.
//! It produces correlated billing input only; it does not settle or infer a terminal.
use super::{PaidAttempt, PaidCorrelation, PaidUsage};
use gateway_core::{identity::MAX_SAFE_INTEGER, provider::PaidProvider, source_usage::UsageTokens};
use serde_json::Value;

fn count(value: Option<u64>) -> Option<i64> {
    value
        .filter(|value| *value <= MAX_SAFE_INTEGER as u64)
        .map(|value| value as i64)
}
fn price(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
}
fn cache_price(value: Option<&Value>, input: f64) -> Option<f64> {
    match value {
        None | Some(Value::Null) => Some(input),
        value => price(value),
    }
}
/// The attempt must be the actual stored row for the original paid reservation.
/// Pricing is the captured source SurplusBillingPricing object, never a new catalog lookup.
/// Missing charges may estimate; a present malformed charge can never fall back to pricing.
pub fn surplus_usage_from_source(
    attempt: &PaidAttempt,
    usage: Option<&UsageTokens>,
    pricing: Option<&Value>,
) -> Option<PaidUsage> {
    if attempt.reservation.provider != PaidProvider::Surplus
        || gateway_schema::util::js_trim(&attempt.reservation.attempt_id.0).is_empty()
        || gateway_schema::util::js_trim(&attempt.model).is_empty()
        || attempt.quota_per_credit <= 0
        || attempt.quota_per_credit > MAX_SAFE_INTEGER
    {
        return None;
    }
    let usage = usage?;
    let input = count(usage.input_tokens)?;
    let output = count(usage.output_tokens)?;
    let cached = count(Some(usage.cached_input_tokens.unwrap_or(0)))?;
    let write = count(Some(usage.cache_write_input_tokens.unwrap_or(0)))?;
    if cached > input || write > input {
        return None;
    }
    let (credits, exact) = match usage.buyer_cost_micro {
        Some(None) => return None,
        Some(Some(value)) => {
            let cost = count(Some(value))?;
            (cost as f64 / 1_000_000.0, Some(cost))
        }
        None => {
            let pricing = pricing?;
            if pricing.get("require_provider_cost") == Some(&Value::Bool(true)) {
                return None;
            }
            let input_price = price(pricing.get("input_price_per_token"))?;
            let output_price = price(pricing.get("output_price_per_token"))?;
            let read_price = cache_price(pricing.get("cache_read_price_per_token"), input_price)?;
            let write_price = cache_price(pricing.get("cache_write_price_per_token"), input_price)?;
            let credits = (input - cached) as f64 * input_price
                + cached as f64 * read_price
                + write as f64 * write_price
                + output as f64 * output_price;
            (credits, None)
        }
    };
    let quota = (credits * attempt.quota_per_credit as f64).round();
    if !quota.is_finite() || quota < 0.0 || quota > MAX_SAFE_INTEGER as f64 {
        return None;
    }
    Some(PaidUsage {
        provider_quota: quota,
        input_tokens: input,
        cached_input_tokens: if exact.is_some() {
            usage
                .cached_input_tokens
                .and_then(|value| count(Some(value)))
        } else {
            Some(cached)
        },
        output_tokens: output,
        correlation: PaidCorrelation::SurplusReservation {
            attempt_id: attempt.reservation.attempt_id.clone(),
            buyer_cost_micro: exact,
        },
    })
}
