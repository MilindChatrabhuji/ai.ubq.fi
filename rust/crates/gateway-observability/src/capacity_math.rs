//! Exact chart transitions and hourly research folds from source capacity-history/rollups.
use crate::capacity_shapes::{BUCKET_MS, HOUR_MS, source};
use serde_json::{Value, json};
pub fn same_cohort(a: &Value, b: &Value) -> bool {
    a["account_cohort_id"].is_string() && a["account_cohort_id"] == b["account_cohort_id"]
}
pub fn preserve_transition(previous: &Value, current: &Value) -> bool {
    if previous["sampled_at_ms"].as_i64() >= current["sampled_at_ms"].as_i64() {
        return false;
    }
    for slot in [1, 2] {
        let (Some(p), Some(c)) = (source(previous, slot), source(current, slot)) else {
            continue;
        };
        if !same_cohort(p, c) {
            continue;
        }
        if (p["state"] == "unavailable") != (c["state"] == "unavailable") {
            return true;
        }
        if p["state"] == "unavailable" || c["state"] == "unavailable" {
            continue;
        }
        for name in ["primary", "secondary"] {
            let (a, b) = (&p["windows"][name], &c["windows"][name]);
            if a["used_percent"].as_f64().is_some_and(|n| n >= 90.0)
                && b["used_percent"].as_f64().is_some_and(|n| n <= 20.0)
                && a["reset_at_ms"] == b["reset_at_ms"]
            {
                return true;
            }
        }
    }
    false
}
pub fn rate_limit_events(previous: Option<&Value>, current: &Value, last: &[Value]) -> Vec<Value> {
    let Some(now) = current["snapshot_at_ms"].as_i64() else {
        return vec![];
    };
    if previous.is_some_and(|p| p["snapshot_at_ms"].as_i64().is_some_and(|t| t >= now)) {
        return vec![];
    }
    let mut out = Vec::new();
    for slot in [1, 2] {
        let Some(c) = source(current, slot).filter(|s| s["state"] != "unavailable") else {
            continue;
        };
        let (p, at) = if let Some(p) = previous.and_then(|p| {
            source(p, slot)
                .filter(|s| s["state"] != "unavailable" && same_cohort(s, c))
                .map(|s| (s, p["snapshot_at_ms"].as_i64().unwrap_or(0)))
        }) {
            p
        } else {
            let Some(v) = last.iter().find(|v| {
                v["source"]["slot"] == slot
                    && v["sampled_at_ms"].as_i64().is_some_and(|t| t < now)
                    && same_cohort(&v["source"], c)
            }) else {
                continue;
            };
            (&v["source"], v["sampled_at_ms"].as_i64().unwrap_or(0))
        };
        for name in ["primary", "secondary"] {
            let (a, b) = (&p["windows"][name], &c["windows"][name]);
            let (Some(old), Some(new), Some(old_reset), Some(reset)) = (
                a["used_percent"].as_f64(),
                b["used_percent"].as_f64(),
                a["reset_at_ms"].as_i64(),
                b["reset_at_ms"].as_i64(),
            ) else {
                continue;
            };
            let gain = old - new;
            if reset <= old_reset || gain < 25.0 {
                continue;
            }
            out.push(json!({"v":1,"event_id":format!("openai-{slot}-{name}-{at}-{now}"),"provider":"openai","slot":slot,"window":name,"observed_at_ms":now,"previous_sampled_at_ms":at,"previous_reset_at_ms":old_reset,"reset_at_ms":reset,"previous_used_percent":old,"current_used_percent":new,"capacity_gain_percentage_points":gain}));
        }
    }
    out
}
fn empty_window() -> Value {
    json!({"samples":0,"limit_window_seconds":null,"min_used_percent":null,"max_used_percent":null,"last_used_percent":null,"last_reset_at_ms":null})
}
pub fn merge_rollup(previous: Option<&Value>, point: &Value) -> Value {
    let at = point["sampled_at_ms"].as_i64().expect("history clock");
    let bucket = point["bucket_start_at_ms"]
        .as_i64()
        .expect("history bucket")
        / HOUR_MS
        * HOUR_MS;
    let previous = previous.filter(|p| p["bucket_start_at_ms"] == bucket);
    let mut slots = Vec::new();
    for slot in [1, 2] {
        let input = source(point, slot);
        let p = previous.and_then(|p| p["slots"].as_array()?.iter().find(|v| v["slot"] == slot));
        let state = input
            .map(|s| s["state"].clone())
            .unwrap_or_else(|| json!("unavailable"));
        let mut row = json!({"slot":slot,"available_sample_count":p.and_then(|p|p["available_sample_count"].as_u64()).unwrap_or(0)+u64::from(state=="available"),"last_state":state});
        for name in ["primary", "secondary"] {
            let mut window = p.map(|p| p[name].clone()).unwrap_or_else(empty_window);
            if let Some(w) = input.map(|v| &v["windows"][name]).filter(|w| w.is_object()) {
                window["samples"] = json!(window["samples"].as_u64().unwrap_or(0) + 1);
                for (f, target) in [
                    ("limit_window_seconds", "limit_window_seconds"),
                    ("used_percent", "last_used_percent"),
                    ("reset_at_ms", "last_reset_at_ms"),
                ] {
                    if !w[f].is_null() {
                        window[target] = w[f].clone()
                    }
                }
                if let Some(used) = w["used_percent"].as_f64() {
                    window["min_used_percent"] = json!(
                        window["min_used_percent"]
                            .as_f64()
                            .map(|v| v.min(used))
                            .unwrap_or(used)
                    );
                    window["max_used_percent"] = json!(
                        window["max_used_percent"]
                            .as_f64()
                            .map(|v| v.max(used))
                            .unwrap_or(used)
                    );
                }
            }
            row[name] = window;
        }
        slots.push(row);
    }
    json!({"v":1,"bucket_start_at_ms":bucket,"sample_count":previous.and_then(|p|p["sample_count"].as_u64()).unwrap_or(0)+1,"first_sampled_at_ms":previous.and_then(|p|p["first_sampled_at_ms"].as_i64()).map(|p|p.min(at)).unwrap_or(at),"last_sampled_at_ms":previous.and_then(|p|p["last_sampled_at_ms"].as_i64()).map(|p|p.max(at)).unwrap_or(at),"slots":slots})
}
pub fn merge_remote_history(
    local: &[Value],
    remote: &[(String, Value)],
    compare: impl Fn(&str, &str) -> Result<std::cmp::Ordering, gateway_core::GatewayError>,
) -> Result<Vec<Value>, gateway_core::GatewayError> {
    let mut ordered = local.to_vec();
    ordered.sort_by_key(|p| {
        (
            p["sampled_at_ms"].as_i64(),
            p["bucket_start_at_ms"].as_i64(),
        )
    });
    let local_buckets: std::collections::BTreeSet<i64> = ordered
        .iter()
        .filter_map(|p| crate::store::safe_i64(&p["bucket_start_at_ms"]))
        .collect();
    let mut gaps: std::collections::BTreeMap<
        i64,
        std::collections::BTreeMap<String, std::collections::BTreeMap<i64, Value>>,
    > = std::collections::BTreeMap::new();
    for (host, point) in remote {
        let (Some(bucket), Some(sample)) = (
            crate::store::safe_i64(&point["bucket_start_at_ms"]),
            crate::store::safe_i64(&point["sampled_at_ms"]),
        ) else {
            continue;
        };
        if local_buckets.contains(&bucket) {
            continue;
        }
        let mut configured = 0;
        let available = [1, 2].into_iter().all(|slot| {
            source(point, slot).is_some_and(|s| {
                if s["failure_kind"] == "not_configured" {
                    true
                } else {
                    configured += 1;
                    s["state"] == "available" && s["account_cohort_id"].is_string()
                }
            })
        });
        if !available || configured == 0 {
            continue;
        }
        let i = ordered
            .partition_point(|p| crate::store::safe_i64(&p["sampled_at_ms"]).unwrap_or(0) < sample);
        let matches = |p: &Value| {
            [1, 2].into_iter().all(|slot| {
                let identity = |p: &Value| {
                    source(p, slot).map(|s| {
                        if s["failure_kind"] == "not_configured" {
                            json!("not_configured")
                        } else {
                            s["account_cohort_id"].clone()
                        }
                    })
                };
                let a = identity(p);
                a.is_some() && a != Some(Value::Null) && a == identity(point)
            })
        };
        if !i
            .checked_sub(1)
            .and_then(|i| ordered.get(i))
            .is_some_and(matches)
            && !ordered.get(i).is_some_and(matches)
        {
            continue;
        }
        gaps.entry(bucket)
            .or_default()
            .entry(host.clone())
            .or_default()
            .insert(sample, point.clone());
    }
    for hosts in gaps.into_values() {
        let mut hosts: Vec<_> = hosts.into_iter().collect();
        let mut error = None;
        hosts.sort_by(|(a, _), (b, _)| match compare(a, b) {
            Ok(order) => order,
            Err(e) => {
                error = Some(e);
                std::cmp::Ordering::Equal
            }
        });
        if let Some(error) = error {
            return Err(error);
        }
        if let Some((_, points)) = hosts.into_iter().next() {
            ordered.extend(points.into_values())
        }
    }
    ordered.sort_by_key(|p| {
        (
            p["sampled_at_ms"].as_i64(),
            p["bucket_start_at_ms"].as_i64(),
        )
    });
    Ok(ordered)
}
pub fn bucketed(point: &Value) -> bool {
    crate::store::safe_i64(&point["bucket_start_at_ms"])
        .zip(crate::store::safe_i64(&point["sampled_at_ms"]))
        .is_some_and(|(b, t)| b % BUCKET_MS == 0 && t >= b && t < b + BUCKET_MS)
}
