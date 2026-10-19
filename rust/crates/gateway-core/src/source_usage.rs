//! One source extractUsageTokens engine for inference, telemetry and the fixed cache experiment.
//! Missing usage is not an invalid object, and unreported counters never become zero.
use serde::Serialize;
use serde_json::{Map, Value};

use crate::{GatewayError, source_json::SourceJson};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus {
    Reported,
    Partial,
    Invalid,
}
impl UsageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reported => "reported",
            Self::Partial => "partial",
            Self::Invalid => "invalid",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub status: UsageStatus,
    /// Outer None means absent; Some(None) is a present malformed source charge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buyer_cost_micro: Option<Option<u64>>,
    #[serde(skip)]
    cache_write_present: bool,
}
impl UsageTokens {
    pub fn cache_write_tokens_present(&self) -> bool {
        self.cache_write_present
    }
}
#[derive(Default)]
struct Count {
    value: Option<u64>,
    invalid: bool,
}
fn count(value: Option<&Value>) -> Count {
    let Some(value) = value else {
        return Count::default();
    };
    let number = value.as_f64().filter(|number| {
        number.is_finite()
            && *number >= 0.0
            && *number <= crate::identity::MAX_SAFE_INTEGER as f64
            && number.fract() == 0.0
    });
    Count {
        value: number.map(|number| number as u64),
        invalid: number.is_none(),
    }
}
/// None is the source's undefined/absent usage; Some(Null) is present and invalid.
/// Integer-valued JSON floats and negative zero follow Number.isSafeInteger semantics.
pub fn extract_usage_tokens(value: Option<&Value>) -> Option<UsageTokens> {
    let value = value?;
    let object = value.as_object();
    let field = |name: &str| object.and_then(|object| object.get(name));
    let input = count(field("input_tokens"));
    let output = count(field("output_tokens"));
    let total = count(field("total_tokens"));
    let details_field = field("input_tokens_details");
    let details = details_field.and_then(Value::as_object);
    let cached = count(details.and_then(|details| details.get("cached_tokens")));
    let write_field = details.and_then(|details| details.get("cache_write_tokens"));
    let write = count(write_field);
    let core_missing = input.value.is_none() || output.value.is_none() || total.value.is_none();
    let inconsistent = input
        .value
        .zip(output.value)
        .zip(total.value)
        .is_some_and(|((input, output), total)| input + output != total);
    let cached_exceeds_input = input
        .value
        .zip(cached.value)
        .is_some_and(|(input, cached)| cached > input);
    let invalid = object.is_none()
        || input.invalid
        || output.invalid
        || total.invalid
        || (details_field.is_some() && details.is_none())
        || cached.invalid
        || write.invalid
        || cached_exceeds_input
        || inconsistent;
    Some(UsageTokens {
        input_tokens: input.value,
        cached_input_tokens: cached.value,
        cache_write_input_tokens: write.value,
        output_tokens: output.value,
        total_tokens: total.value,
        status: if invalid {
            UsageStatus::Invalid
        } else if core_missing || cached.value.is_none() {
            UsageStatus::Partial
        } else {
            UsageStatus::Reported
        },
        buyer_cost_micro: field("buyer_cost_micro").map(|value| count(Some(value)).value),
        cache_write_present: write_field.is_some(),
    })
}
/// Raw JSON frontend retains last-member-wins and ignores unrelated UTF-16 values.
/// Only source numeric fields are projected; every present non-number remains invalid.
/// The status, consistency and provenance engine above is shared, not reimplemented.
pub fn extract_source_usage_tokens(
    value: Option<&SourceJson>,
) -> Result<Option<UsageTokens>, GatewayError> {
    let Some(value) = value else { return Ok(None) };
    if !value.as_str().trim_start().starts_with('{') {
        return Ok(extract_usage_tokens(Some(&Value::Null)));
    }
    let mut object = Map::new();
    for (name, value) in value.object_entries()? {
        for field in [
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "buyer_cost_micro",
            "input_tokens_details",
        ] {
            if !name.as_units().iter().copied().eq(field.encode_utf16()) {
                continue;
            }
            if field != "input_tokens_details" {
                object.insert(field.into(), source_number(&value));
            } else if value.as_str().trim_start().starts_with('{') {
                let mut details = Map::new();
                for (name, value) in value.object_entries()? {
                    for field in ["cached_tokens", "cache_write_tokens"] {
                        if name.as_units().iter().copied().eq(field.encode_utf16()) {
                            details.insert(field.into(), source_number(&value));
                        }
                    }
                }
                object.insert(field.into(), Value::Object(details));
            } else {
                object.insert(field.into(), Value::Null);
            }
        }
    }
    Ok(extract_usage_tokens(Some(&Value::Object(object))))
}
fn source_number(value: &SourceJson) -> Value {
    value
        .deserialize::<f64>()
        .ok()
        .and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}
#[cfg(test)]
#[path = "source_usage_tests.rs"]
mod tests;
