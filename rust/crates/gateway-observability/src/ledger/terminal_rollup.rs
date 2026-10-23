//! Source recordTerminalUsageRollup: one event-owned, bounded write to the existing rollup.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{records::valid_usage_rollup_source, store};
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    js_string::JsString16,
    query::QueryStore,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    source_usage::UsageTokens,
    state::RecordMutation,
    tuple_key::{KeyPart, TupleKey},
};
use serde_json::{Value, json};

pub struct TerminalUsageRollup<'a> {
    pub model: Option<&'a JsString16>,
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
        let model = input.model.map(crate::records::trim).unwrap_or_default();
        let provider = input.provider.map(store::trim).unwrap_or_default();
        if model.as_units().is_empty()
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
        let key_bucket = number(bucket)?;
        let key = TupleKey::from_parts(&[
            KeyPart::String("uos_ai".into()),
            KeyPart::String("paid_fallback".into()),
            KeyPart::String("v3".into()),
            KeyPart::String("usage_rollup".into()),
            KeyPart::Number(
                key_bucket
                    .as_f64()
                    .ok_or_else(|| store::error("Invalid rollup bucket"))?,
            ),
            KeyPart::source_string_utf16(model.as_units()),
            KeyPart::String(provider.into()),
            KeyPart::Number(f64::from(gateway_authority::paid::rollup_shard(&request))),
        ])?
        .to_record_key();
        for _ in 0..3 {
            let row = self.store.read(&key).await?;
            let document = row
                .as_ref()
                .filter(|row| row.expires_at_ms.is_none_or(|expiry| expiry > now))
                .map(decode_source_control_record)
                .transpose()?;
            let existing = document
                .as_ref()
                .filter(|value| valid_usage_rollup_source(value));
            let field = |name: &str| existing.and_then(|value| source::member(value, name));
            let old = |name: &str| {
                field(name)
                    .and_then(|value| value.deserialize::<f64>().ok())
                    .unwrap_or(0.0)
            };
            let numeric = |value| SourceJson::from_serializable(&number(value)?);
            let next = source::object(vec![
                ("v", SourceJson::from_serializable(&1)?),
                (
                    "bucket_start_at_ms",
                    field("bucket_start_at_ms").unwrap_or(numeric(bucket)?),
                ),
                ("model", field("model").unwrap_or(model.to_source_json()?)),
                (
                    "provider",
                    field("provider").unwrap_or(SourceJson::from_serializable(provider)?),
                ),
                ("request_count", numeric(old("request_count") + 1.0)?),
                ("quota_sum", numeric(old("quota_sum"))?),
                ("input_tokens", numeric(old("input_tokens") + input_tokens)?),
                (
                    "cached_input_tokens",
                    numeric(
                        old("cached_input_tokens")
                            + count(usage.cached_input_tokens).unwrap_or(0.0),
                    )?,
                ),
                (
                    "output_tokens",
                    numeric(old("output_tokens") + output_tokens)?,
                ),
                ("spend_microcredits", numeric(old("spend_microcredits"))?),
                (
                    "first_request_at_ms",
                    numeric(existing.map_or(created, |_| old("first_request_at_ms").min(created)))?,
                ),
                (
                    "last_request_at_ms",
                    numeric(existing.map_or(created, |_| old("last_request_at_ms").max(created)))?,
                ),
                ("updated_at_ms", SourceJson::from_serializable(&now)?),
            ])?;
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&key, row.as_ref())],
                vec![RecordMutation::Put {
                    key: key.clone(),
                    record: encode_source_control_record(
                        store::uuid(self.host.as_ref())?,
                        &next,
                        None,
                    )?,
                }],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
