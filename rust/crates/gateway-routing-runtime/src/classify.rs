//! Exact source Codex429 and entitlement proofs; an HTTP status alone is not quota.
use chrono::{DateTime, Utc};
use gateway_authority::routing::{QuotaBlock, QuotaBlockSource};
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
        observed_at_ms: now,
        reset_at_ms: stable.then_some(deadline),
        reset_is_stable: stable,
        reset_ambiguous: conflict,
        recovery_pending: false,
    })
}
pub fn unsupported_model(
    status: Option<u16>,
    bytes: &[u8],
    complete: bool,
    model: &str,
) -> Option<String> {
    if status != Some(400) {
        return None;
    }
    let body = complete_json(bytes, complete)?;
    let detail = body.get("detail")?.as_str()?;
    (detail
        == format!("The '{model}' model is not supported when using Codex with a ChatGPT account."))
    .then(|| detail.to_owned())
}
pub fn retry_after_millis(headers: &Headers, now: i64) -> Option<i64> {
    retry_after(headers, now).map(|(time, _)| time - now)
}
