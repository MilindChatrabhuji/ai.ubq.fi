//! Source recordTerminalUsageRollup: one event-owned, bounded write to the existing rollup.
use crate::{ObservabilityHost, ObservabilityRuntime, api::valid_usage_rollup, store};
use gateway_core::{
    GatewayError, identity::MAX_SAFE_INTEGER, query::QueryStore, source_usage::UsageTokens,
};
use serde_json::{Value, json};

pub struct TerminalUsageRollup<'a> {
    pub model: Option<&'a str>,
    pub provider: Option<&'a str>,
    pub request_id: &'a str,
    pub request_created_at_ms: Option<f64>,
    pub usage: Option<&'a UsageTokens>,
}
fn number(value: f64) -> Result<Value, GatewayError> {
    if !value.is_finite() {
        return Err(store::error("Terminal usage rollup number is not finite"));
    }
    Ok(
        if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER as f64 {
            json!(value as i64)
        } else {
            json!(value)
        },
    )
}
fn count(value: Option<u64>) -> Option<f64> {
    value
        .filter(|value| *value <= MAX_SAFE_INTEGER as u64)
        .map(|value| value as f64)
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    /// Call once from the original terminal owner; this is not a new dedup ledger or billing proof.
    pub async fn record_terminal_usage_rollup(
        &self,
        input: TerminalUsageRollup<'_>,
    ) -> Result<bool, GatewayError> {
        let model = input.model.map(store::trim).unwrap_or_default();
        let provider = input.provider.map(store::trim).unwrap_or_default();
        if model.is_empty()
            || provider.is_empty()
            || matches!(provider, "gateway" | "mixed" | "metered" | "surplus")
        {
            return Ok(false);
        }
        let Some(usage) = input.usage else {
            return Ok(false);
        };
        let (Some(input_tokens), Some(output_tokens)) =
            (count(usage.input_tokens), count(usage.output_tokens))
        else {
            return Ok(false);
        };
        let now = store::now(self.host.as_ref())?;
        let request = store::trim(input.request_id);
        let request = if request.is_empty() {
            store::uuid(self.host.as_ref())?
        } else {
            request.to_owned()
        };
        let created = input
            .request_created_at_ms
            .filter(|value| value.is_finite())
            .map_or(now as f64, |value| value.trunc().max(0.0));
        let bucket = (created / 3_600_000.0).floor() * 3_600_000.0;
        let key = store::key(json!([
            "uos_ai",
            "paid_fallback",
            "v3",
            "usage_rollup",
            number(bucket)?,
            model,
            provider,
            gateway_authority::paid::rollup_shard(&request)
        ]));
        for _ in 0..3 {
            let row = self.store.read(&key).await?;
            let existing =
                store::value(row.as_ref(), now)?.filter(|value| valid_usage_rollup(value));
            let old = |field: &str| {
                existing
                    .and_then(|value| value[field].as_f64())
                    .unwrap_or(0.0)
            };
            let next = json!({
                "v": 1,
                "bucket_start_at_ms": existing.map(|value| value["bucket_start_at_ms"].clone()).unwrap_or(number(bucket)?),
                "model": existing.map(|value| value["model"].clone()).unwrap_or(json!(model)),
                "provider": existing.map(|value| value["provider"].clone()).unwrap_or(json!(provider)),
                "request_count": number(old("request_count") + 1.0)?,
                "quota_sum": number(old("quota_sum"))?,
                "input_tokens": number(old("input_tokens") + input_tokens)?,
                "cached_input_tokens": number(old("cached_input_tokens") + count(usage.cached_input_tokens).unwrap_or(0.0))?,
                "output_tokens": number(old("output_tokens") + output_tokens)?,
                "spend_microcredits": number(old("spend_microcredits"))?,
                "first_request_at_ms": number(existing.map_or(created, |_| old("first_request_at_ms").min(created)))?,
                "last_request_at_ms": number(existing.map_or(created, |_| old("last_request_at_ms").max(created)))?,
                "updated_at_ms": now,
            });
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&key, row.as_ref())],
                vec![store::put(self.host.as_ref(), key.clone(), next, None)?],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
