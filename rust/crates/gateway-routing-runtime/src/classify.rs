//! Exact source Codex429 and entitlement proofs; an HTTP status alone is not quota.
use chrono::{DateTime, Utc};
use gateway_authority::routing::{QuotaBlock, QuotaBlockSource};
use gateway_core::{
    js_string::JsString16, model::ModelId, source_json::SourceJson, source_serialization as source,
};
use gateway_providers::Headers;
use serde::{
    Deserialize, Deserializer,
    de::{Error, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};
use std::{collections::BTreeSet, fmt};

struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("complete unambiguous JSON")
            }
            fn visit_bool<E: Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(v)))
            }
            fn visit_i64<E: Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_u64<E: Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_f64<E: Error>(self, v: f64) -> Result<Unique, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("Nonfinite JSON number"))
            }
            fn visit_str<E: Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(Value::String(v.into())))
            }
            fn visit_string<E: Error>(self, v: String) -> Result<Unique, E> {
                Ok(Unique(Value::String(v)))
            }
            fn visit_unit<E: Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_none<E: Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                let mut values = vec![];
                while let Some(Unique(value)) = seq.next_element::<Unique>()? {
                    values.push(value);
                }
                Ok(Unique(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                let mut keys = BTreeSet::new();
                let mut object = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !keys.insert(key.clone()) {
                        return Err(A::Error::custom("Duplicate JSON key"));
                    }
                    object.insert(key, map.next_value::<Unique>()?.0);
                }
                Ok(Unique(Value::Object(object)))
            }
        }
        d.deserialize_any(JsonVisitor)
    }
}
pub fn complete_json(bytes: &[u8], complete: bool) -> Option<Value> {
    if !complete {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let mut decoder = serde_json::Deserializer::from_str(text);
    let value = Unique::deserialize(&mut decoder).ok()?.0;
    decoder.end().ok()?;
    Some(value)
}
fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}
fn retry_after(headers: &Headers, now: i64) -> Option<(i64, bool)> {
    let value = header(headers, "retry-after")?.trim();
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        let seconds = value.parse::<i64>().ok()?;
        let delta = seconds.checked_mul(1000)?;
        let time = now.checked_add(delta)?;
        return (delta > 0 && time <= 9_007_199_254_740_991).then_some((time, false));
    }
    let date = DateTime::parse_from_rfc2822(value)
        .ok()?
        .with_timezone(&Utc);
    let time = date.timestamp_millis();
    (time > now
        && time <= 9_007_199_254_740_991
        && date.format("%a, %d %b %Y %H:%M:%S GMT").to_string() == value)
        .then_some((time, true))
}
pub fn codex_quota(
    status: Option<u16>,
    headers: &Headers,
    bytes: &[u8],
    complete: bool,
    now: i64,
) -> Option<QuotaBlock> {
    if status != Some(429) {
        return None;
    }
    let body = complete_json(bytes, complete)?;
    if body["error"]["type"] != "usage_limit_reached" {
        return None;
    }
    let body_reset = body["error"]["resets_at"]
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v <= 9_007_199_254_740_991.0)
        .and_then(|v| (v as i64).checked_mul(1000))
        .filter(|v| *v > now && *v <= 9_007_199_254_740_991);
    let retry = retry_after(headers, now);
    let conflict = body_reset
        .zip(retry)
        .is_some_and(|(b, (r, stable))| if stable { r != b } else { r > b });
    let deadline = match (body_reset, retry) {
        (Some(body), Some((retry, _))) if conflict => body.max(retry),
        (Some(body), _) => body,
        (None, Some((retry, _))) => retry,
        _ => return None,
    };
    let stable = !conflict && (body_reset.is_some() || retry.is_some_and(|(_, s)| s));
    Some(QuotaBlock {
        blocked_until_ms: deadline,
        source: if body_reset.is_some() {
            QuotaBlockSource::BodyResetsAt
        } else {
            QuotaBlockSource::HeaderRetryAfter
        },
        legacy_fallback: false,
        observed_at_ms: Some(now),
        reset_at_ms: stable.then_some(deadline),
        reset_is_stable: stable,
        reset_ambiguous: conflict,
        recovery_pending: false,
    })
}
fn source_message(prefix: &str, model: &ModelId, suffix: &str) -> JsString16 {
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.extend_from_slice(model.as_js_string().as_units());
    units.extend(suffix.encode_utf16());
    JsString16::from_units(units)
}
fn complete_source_json(bytes: &[u8], complete: bool) -> Option<SourceJson> {
    if !complete {
        return None;
    }
    let value = SourceJson::parse_bytes(bytes).ok()?;
    fn unambiguous(value: &SourceJson) -> bool {
        match value.as_bytes().first() {
            Some(b'{') => {
                let Ok(entries) = value.object_entries() else {
                    return false;
                };
                let mut keys = BTreeSet::new();
                entries
                    .into_iter()
                    .all(|(key, value)| keys.insert(key) && unambiguous(&value))
            }
            Some(b'[') => value
                .array_items()
                .is_ok_and(|values| values.iter().all(unambiguous)),
            Some(b'"') => source::string(value).is_some(),
            _ if matches!(value.as_str(), "true" | "false" | "null") => true,
            _ => value.as_str().parse::<f64>().is_ok_and(f64::is_finite),
        }
    }
    unambiguous(&value).then_some(value)
}
pub fn unsupported_model(
    status: Option<u16>,
    bytes: &[u8],
    complete: bool,
    model: &ModelId,
) -> Option<JsString16> {
    if status != Some(400) {
        return None;
    }
    let body = complete_source_json(bytes, complete)?;
    let detail = source::member(&body, "detail").and_then(|value| source::string(&value))?;
    (detail
        == source_message(
            "The '",
            model,
            "' model is not supported when using Codex with a ChatGPT account.",
        ))
    .then_some(detail)
}
pub(crate) fn model_unavailable_error(
    model: &ModelId,
) -> gateway_schema::source_request::SourceRequestError {
    gateway_schema::source_request::SourceRequestError::new(
        404,
        source_message(
            "The model '",
            model,
            "' is not available for these subscriptions.",
        ),
        "invalid_request_error",
        Some("model_not_found"),
        None,
    )
}
pub fn retry_after_millis(headers: &Headers, now: i64) -> Option<i64> {
    retry_after(headers, now).map(|(time, _)| time - now)
}
