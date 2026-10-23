//! Source cache/prompt-analytics-{core,read}.ts v2 hard namespace.
use crate::{ObservabilityRuntime, counters, store, types::ObservabilityHost};
use gateway_auth::crypto::sha256_hex;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::QueryStore,
    state::{RecordKey, RecordMutation},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
type StoredPromptBucket = (i64, Option<Value>, BTreeMap<String, u64>);

pub const BUCKET_MS: i64 = 900_000;
pub const WINDOW_MS: i64 = 7 * store::DAY;
pub const RETENTION_MS: i64 = 8 * store::DAY;
pub const PROVIDERS: [&str; 3] = ["chatgpt_codex", "metered", "surplus"];
pub const ROUTES: [&str; 2] = ["responses", "chat.completions"];
pub const DIMENSIONS: [&str; 6] = [
    "provider",
    "model",
    "route",
    "key_presence",
    "mode",
    "fallback",
];
pub const COUNTERS: [&str; 9] = [
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "cache_write_reported_sample_count",
    "sample_count",
    "request_cache_hit_sample_count",
    "usage_reported_sample_count",
    "usage_invalid_sample_count",
    "dimension_cardinality_limited_sample_count",
];
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PromptEvent {
    pub provider: Option<String>,
    pub model: Option<JsString16>,
    pub route: String,
    pub status: u16,
    pub completed: bool,
    pub usage_telemetry_status: String,
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub cache_write_tokens_present: bool,
    pub prompt_cache_key_present: bool,
    pub prompt_cache_mode: Option<String>,
    pub fallback_reason: Option<String>,
}
impl PromptEvent {
    /// Map one already-extracted shared usage result; this does not parse or validate raw upstream JSON.
    pub fn set_source_usage(&mut self, usage: Option<&gateway_core::source_usage::UsageTokens>) {
        self.usage_telemetry_status = usage
            .map_or("missing", |usage| usage.status.as_str())
            .into();
        self.input_tokens = usage.and_then(|usage| usage.input_tokens);
        self.cached_input_tokens = usage.and_then(|usage| usage.cached_input_tokens);
        self.cache_write_input_tokens = usage.and_then(|usage| usage.cache_write_input_tokens);
        // The terminal gate reports a normalized non-null count, not raw field presence.
        self.cache_write_tokens_present =
            usage.is_some_and(|usage| usage.cache_write_input_tokens.is_some());
    }
}
pub(crate) fn known_release(release: &str) -> Option<String> {
    let s = store::trim(release);
    (s.len() >= 7 && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| s.to_ascii_lowercase())
}
pub(crate) fn model_text(value: Option<&str>) -> Option<&str> {
    value
        .map(store::trim)
        .filter(|value| model_source(Some(&JsString16::from_utf8(value))).is_some())
}
fn model_source(value: Option<&JsString16>) -> Option<JsString16> {
    value.map(crate::records::trim).filter(|value| {
        !value.as_units().is_empty()
            && value.as_units().len() <= 256
            && !value
                .as_units()
                .iter()
                .any(|unit| *unit < 0x20 || *unit == 0x7f)
    })
}
pub(crate) fn model_hash(value: Option<&JsString16>, domain: &str) -> Option<String> {
    let model = model_source(value)?;
    // sha256Hex in source utils.ts uses TextEncoder: ONLY this digest preimage
    // performs USVString replacement. Raw observation models remain UTF16.
    let mut bytes = domain.as_bytes().to_vec();
    bytes.extend_from_slice(String::from_utf16_lossy(model.as_units()).as_bytes());
    Some(sha256_hex(&bytes))
}

pub(crate) fn prefix(name: &str) -> RecordKey {
    store::key(json!(["uos_ai", "prompt_cache_analytics", "v2", name]))
}
fn key(name: &str, bucket: i64, suffix: &[Value]) -> RecordKey {
    let mut parts = vec![
        json!("uos_ai"),
        json!("prompt_cache_analytics"),
        json!("v2"),
        json!(name),
        json!(bucket),
    ];
    parts.extend_from_slice(suffix);
    store::key(Value::Array(parts))
}
fn usage(event: &PromptEvent) -> (&'static str, BTreeMap<&'static str, u64>) {
    let mut deltas = BTreeMap::from([("sample_count", 1)]);
    if event.usage_telemetry_status == "reported" {
        if let (Some(input), Some(cached)) = (event.input_tokens, event.cached_input_tokens)
            && input <= 9_007_199_254_740_991
            && cached <= input
            && event
                .cache_write_input_tokens
                .is_none_or(|v| v <= 9_007_199_254_740_991)
        {
            deltas.insert("input_tokens", input);
            deltas.insert("cached_input_tokens", cached);
            deltas.insert("usage_reported_sample_count", 1);
            if cached > 0 {
                deltas.insert("request_cache_hit_sample_count", 1);
            }
            if let Some(write) = event.cache_write_input_tokens {
                deltas.insert("cache_write_input_tokens", write);
                deltas.insert("cache_write_reported_sample_count", 1);
            }
            return ("recorded", deltas);
        }
        deltas.insert("usage_invalid_sample_count", 1);
        return ("recorded_invalid_usage", deltas);
    }
    if event.usage_telemetry_status == "invalid" {
        deltas.insert("usage_invalid_sample_count", 1);
        ("recorded_invalid_usage", deltas)
    } else {
        ("recorded_without_usage", deltas)
    }
}
fn result(status: &str, reason: &str, bucket: Option<i64>) -> Value {
    json!({"status":status,"reason":reason,"bucket_start_at_ms":bucket})
}
fn cohort(event: &PromptEvent) -> Vec<Value> {
    let hash = model_hash(
        event.model.as_ref(),
        "uos-prompt-cache-analytics-model-v2\0",
    )
    .unwrap_or_else(|| "unknown".into());
    let mode = event
        .prompt_cache_mode
        .as_deref()
        .filter(|v| {
            matches!(
                *v,
                "implicit" | "explicit" | "legacy_retention" | "unspecified"
            )
        })
        .unwrap_or("unspecified");
    let fallback = match event.fallback_reason.as_deref() {
        Some(v @ ("none" | "primary_429" | "primary_quota_blocked" | "other")) => v,
        Some(v) if !store::trim(v).is_empty() => "other",
        _ => "none",
    };
    vec![
        json!(event.provider),
        json!(hash),
        json!(event.route),
        json!(if event.prompt_cache_key_present {
            "keyed"
        } else {
            "unkeyed"
        }),
        json!(mode),
        json!(fallback),
    ]
}
pub fn valid_group_by(group: &[String]) -> bool {
    group.len() <= 2
        && group
            .iter()
            .enumerate()
            .all(|(i, v)| DIMENSIONS.contains(&v.as_str()) && !group[..i].contains(v))
}
fn percent(n: f64, d: f64) -> Value {
    if d == 0.0 {
        Value::Null
    } else {
        json!((n / d * 1_000_000.0).round() / 10_000.0)
    }
}
fn ratio(n: f64, d: f64) -> Value {
    if d == 0.0 {
        Value::Null
    } else {
        json!((n / d * 10_000.0).round() / 10_000.0)
    }
}
pub fn project_bucket(
    bucket: i64,
    c: &BTreeMap<String, u64>,
    group: Option<Value>,
) -> Option<Value> {
    let count = *c.get("sample_count")?;
    let has_input = c.contains_key("input_tokens") || c.contains_key("cached_input_tokens");
    let reported = c.get("usage_reported_sample_count").copied().unwrap_or(
        if has_input && c.contains_key("input_tokens") && c.contains_key("cached_input_tokens") {
            count
        } else {
            0
        },
    );
    let invalid = c.get("usage_invalid_sample_count").copied().unwrap_or(0);
    if [count, reported, invalid]
        .iter()
        .any(|v| *v > 9_007_199_254_740_991)
        || reported > count
        || invalid > count
        || reported + invalid > count
    {
        return None;
    }
    let (input, cached) = if reported > 0 {
        let (i, cached) = (*c.get("input_tokens")?, *c.get("cached_input_tokens")?);
        if cached > i || i > 9_007_199_254_740_991 {
            return None;
        }
        (Some(i), Some(cached))
    } else {
        if has_input {
            return None;
        }
        (None, None)
    };
    let write = c.get("cache_write_input_tokens").copied();
    let write_count = c.get("cache_write_reported_sample_count").copied();
    let (write, write_count) = match (write, write_count) {
        (None, None) => (None, 0),
        (Some(w), Some(n)) if n > 0 && n <= reported && w <= 9_007_199_254_740_991 => (Some(w), n),
        _ => return None,
    };
    let hits = c
        .get("request_cache_hit_sample_count")
        .copied()
        .unwrap_or(0);
    let limited = c
        .get("dimension_cardinality_limited_sample_count")
        .copied()
        .unwrap_or(0);
    if hits > reported || limited > count {
        return None;
    }
    let hit = input
        .zip(cached)
        .map(|(i, c)| percent(c as f64, i as f64))
        .unwrap_or(Value::Null);
    let mut out = json!({"bucket_start_at_ms":bucket,"bucket_end_at_ms":bucket+BUCKET_MS,"input_tokens":input,"cached_input_tokens":cached,"cache_write_input_tokens":write,"cache_write_reported_sample_count":write_count,"cached_percentage":hit,"sample_count":count});
    if let Some(group) = group {
        out["group"] = group;
        out["token_hit_percentage"] = hit;
        out["request_cache_hit_sample_count"] = json!(hits);
        out["request_hit_percentage"] = percent(hits as f64, reported as f64);
        out["cache_reads_per_write"] = cached
            .zip(write)
            .map(|(r, w)| ratio(r as f64, w as f64))
            .unwrap_or(Value::Null);
        out["usage_reported_sample_count"] = json!(reported);
        out["usage_invalid_sample_count"] = json!(invalid);
        out["usage_missing_sample_count"] = json!(count - reported - invalid);
        out["usage_telemetry_coverage_percentage"] = percent(reported as f64, count as f64);
        out["dimension_cardinality_limited_sample_count"] = json!(limited);
    }
    Some(out)
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn record_prompt_analytics(&self, event: &PromptEvent, release: &str) -> Value {
        if known_release(release).is_none() {
            return result("ignored", "unknown_release", None);
        }
        if !event.completed || !(200..300).contains(&event.status) {
            return result("ignored", "not_completed_2xx", None);
        }
        if !event
            .provider
            .as_deref()
            .is_some_and(|p| PROVIDERS.contains(&p))
        {
            return result("ignored", "unsupported_provider", None);
        }
        if !ROUTES.contains(&event.route.as_str()) {
            return result("ignored", "unsupported_route", None);
        }
        let Ok(at) = store::now(self.host.as_ref()) else {
            return result("unavailable", "kv_unavailable", None);
        };
        let bucket = at / BUCKET_MS * BUCKET_MS;
        let values = cohort(event);
        let mut marker_suffix = values.clone();
        marker_suffix.push(json!("marker"));
        let marker = key("dimension", bucket, &marker_suffix);
        let cardinality = key("meta", bucket, &[json!("cardinality")]);
        let (reason, deltas) = usage(event);
        let outcome = async {
            for _ in 0..=32 {
                let m = self.store.read(&marker).await?;
                let card = self.store.read(&cardinality).await?;
                let admitted = store::value(m.as_ref(), at)? == Some(&Value::Bool(true));
                let count = match store::value(card.as_ref(), at)? {
                    None => 0,
                    Some(v) => store::safe_i64(v)
                        .filter(|v| *v <= 32)
                        .ok_or_else(|| store::error("Invalid prompt cohort cardinality"))?,
                };
                let capped = !admitted && count >= 32;
                let mut checks = Vec::new();
                let mut writes = Vec::new();
                if !admitted && !capped {
                    checks.extend([
                        store::check(&marker, m.as_ref()),
                        store::check(&cardinality, card.as_ref()),
                    ]);
                    writes.extend([
                        store::put(
                            self.host.as_ref(),
                            marker.clone(),
                            json!(true),
                            Some(at + RETENTION_MS),
                        )?,
                        store::put(
                            self.host.as_ref(),
                            cardinality.clone(),
                            json!(count + 1),
                            Some(at + RETENTION_MS),
                        )?,
                    ]);
                }
                let mut deltas = deltas.clone();
                if capped {
                    deltas.insert("dimension_cardinality_limited_sample_count", 1);
                }
                let mut increments = Vec::new();
                for (counter, amount) in deltas {
                    increments.push((key("all", bucket, &[json!(counter)]), amount));
                    let detail = if capped {
                        key("overflow", bucket, &[json!(counter)])
                    } else {
                        let mut suffix = values.clone();
                        suffix.push(json!(counter));
                        key("dimension", bucket, &suffix)
                    };
                    increments.push((detail, amount));
                }
                if counters::add(
                    self.store.as_ref(),
                    self.host.as_ref(),
                    at,
                    &increments,
                    checks,
                    writes,
                )
                .await?
                {
                    return Ok(result(
                        "recorded",
                        if capped {
                            "recorded_cardinality_capped"
                        } else {
                            reason
                        },
                        Some(bucket),
                    ));
                }
            }
            Err(store::error("Prompt cohort contention"))
        }
        .await;
        outcome
            .unwrap_or_else(|_: GatewayError| result("unavailable", "kv_unavailable", Some(bucket)))
    }
    pub async fn prompt_analytics(&self, group_by: &[String]) -> Result<Value, GatewayError> {
        if !valid_group_by(group_by) {
            return Err(store::invalid(
                "group_by must contain distinct approved dimensions only",
            ));
        }
        let at = store::now(self.host.as_ref())?;
        let current = at / BUCKET_MS * BUCKET_MS;
        let end = current + BUCKET_MS;
        let start = end - WINDOW_MS;
        let max = if group_by.is_empty() { 672 } else { 512 };
        let base = json!({"status":"unavailable","bucket_ms":BUCKET_MS,"window_start_at_ms":start,"window_end_at_ms":end,"group_by":group_by,"max_buckets":max,"cardinality_limited":false,"truncated":false,"buckets":[]});
        let read: Result<Value, GatewayError> = async {
            let names = if group_by.is_empty() {
                vec!["all"]
            } else {
                vec!["dimension", "overflow"]
            };
            let mut buckets: BTreeMap<String, StoredPromptBucket> = BTreeMap::new();
            let mut limited = false;
            for name in names {
                for entry in
                    store::scan(self.store.as_ref(), prefix(name), false, at, usize::MAX).await?
                {
                    let p = store::parts(&entry.key)?;
                    let Some(bucket) = p.get(4).and_then(store::safe_i64) else {
                        continue;
                    };
                    if bucket < start || bucket > current {
                        continue;
                    }
                    let Some(counter) = p
                        .last()
                        .and_then(Value::as_str)
                        .filter(|s| COUNTERS.contains(s))
                    else {
                        continue;
                    };
                    let Some(n) = counters::read(Some(&entry.record), at)
                        .ok()
                        .flatten()
                        .filter(|v| *v <= 9_007_199_254_740_991)
                    else {
                        continue;
                    };
                    let group = if name == "dimension" {
                        if p.len() != 12
                            || !p[5].as_str().is_some_and(|s| PROVIDERS.contains(&s))
                            || !p[7].as_str().is_some_and(|s| ROUTES.contains(&s))
                            || !matches!(p[8].as_str(), Some("keyed" | "unkeyed"))
                            || !p[6].as_str().is_some_and(|s| {
                                s == "unknown"
                                    || (s.len() == 64
                                        && s.bytes().all(|c| {
                                            c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
                                        }))
                            })
                        {
                            continue;
                        }
                        let mut group = json!({});
                        for d in group_by {
                            match d.as_str() {
                                "provider" => group["provider"] = p[5].clone(),
                                "model" => group["model_hash"] = p[6].clone(),
                                "route" => group["route"] = p[7].clone(),
                                "key_presence" => {
                                    group["prompt_cache_key_present"] = json!(p[8] == "keyed")
                                }
                                "mode" => group["mode"] = p[9].clone(),
                                "fallback" => group["fallback"] = p[10].clone(),
                                _ => unreachable!(),
                            }
                        }
                        Some(group)
                    } else if name == "overflow" {
                        if p.len() != 6 {
                            continue;
                        }
                        limited = true;
                        Some(json!({"cardinality_limited":true}))
                    } else {
                        if p.len() != 6 {
                            continue;
                        }
                        None
                    };
                    let identity = serde_json::to_string(&json!([bucket, group]))
                        .expect("source group serializes");
                    let row = buckets
                        .entry(identity)
                        .or_insert_with(|| (bucket, group, BTreeMap::new()));
                    let previous = *row.2.get(counter).unwrap_or(&0);
                    if previous <= 9_007_199_254_740_991 - n {
                        row.2.insert(counter.into(), previous + n);
                    }
                }
            }
            let mut rows: Vec<Value> = buckets
                .into_values()
                .filter_map(|(b, g, c)| project_bucket(b, &c, g))
                .collect();
            rows.sort_by(|a, b| {
                a["bucket_start_at_ms"]
                    .as_i64()
                    .cmp(&b["bucket_start_at_ms"].as_i64())
                    .then_with(|| a["group"].to_string().cmp(&b["group"].to_string()))
            });
            let truncate = rows.len() > max;
            let excess = rows.len().saturating_sub(max);
            if excess > 0 {
                rows.drain(..excess);
            }
            let mut out = base.clone();
            out["status"] = json!("ready");
            out["buckets"] = json!(rows);
            out["cardinality_limited"] = json!(limited);
            out["truncated"] = json!(limited || truncate);
            Ok(out)
        }
        .await;
        Ok(read.unwrap_or(base))
    }
    pub async fn prune_prompt_analytics(&self) -> Result<usize, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let cutoff = (at - RETENTION_MS).max(0) / BUCKET_MS * BUCKET_MS;
        let mut deleted = 0;
        for name in ["all", "dimension", "overflow", "meta", "legacy"] {
            let prefix = if name == "legacy" {
                store::key(json!(["uos_ai", "prompt_cache_analytics", "v1"]))
            } else {
                prefix(name)
            };
            let mut end_parts = store::parts(&prefix)?;
            end_parts.push(json!(cutoff + 1));
            let rows = store::scan_selector(
                self.store.as_ref(),
                gateway_core::query::QuerySelector::Prefix {
                    prefix,
                    start: None,
                    end: Some(store::key(json!(end_parts))),
                },
                false,
                at,
                usize::MAX,
            )
            .await?;
            for batch in rows.chunks(64) {
                let mut writes = Vec::new();
                for row in batch {
                    let p = store::parts(&row.key)?;
                    let offset = if name == "legacy" { 3 } else { 4 };
                    if p.get(offset)
                        .and_then(store::safe_i64)
                        .is_some_and(|b| b <= cutoff)
                    {
                        writes.push(RecordMutation::Delete {
                            key: row.key.clone(),
                        });
                    }
                }
                let n = writes.len();
                if n > 0 && store::commit(self.store.as_ref(), Vec::new(), writes).await? {
                    deleted += n;
                }
            }
        }
        Ok(deleted)
    }
}
