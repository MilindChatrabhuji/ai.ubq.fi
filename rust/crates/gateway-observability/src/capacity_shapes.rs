//! Source provider/capacity-parse.ts. Unknown is never converted to zero.
use crate::store;
use serde_json::{Value, json};
pub const BUCKET_MS: i64 = 900_000;
pub const HOUR_MS: i64 = 3_600_000;
pub const RETENTION_MS: i64 = 7 * store::DAY;
pub const STALE_MS: i64 = 1_800_000;
pub const METERED_FRESH_MS: i64 = 5 * 60_000;
fn nullable(v: Option<&Value>, valid: impl Fn(&Value) -> bool) -> bool {
    v.is_some_and(|v| v.is_null() || valid(v))
}
fn finite(v: &Value) -> Option<Value> {
    v.as_f64().filter(|n| n.is_finite()).map(|_| v.clone())
}
fn percent(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
}
fn timestamp(v: &Value) -> bool {
    store::safe_i64(v).is_some()
}
fn digest(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn source_state(v: &Value) -> Option<&str> {
    v.as_str()
        .filter(|s| ["available", "stale", "unavailable"].contains(s))
}
pub fn codex_label(slot: u8, email: Option<&str>) -> String {
    email
        .map(store::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Codex account {slot}"))
}
pub fn parse_window(value: &Value, upstream: bool) -> Option<Value> {
    if !store::is_record(value) {
        return None;
    }
    if !upstream
        && ![
            ("limit_window_seconds", 0),
            ("used_percent", 1),
            ("reset_at_ms", 2),
        ]
        .iter()
        .all(|(name, kind)| {
            nullable(value.get(name), |v| {
                if *kind == 1 { percent(v) } else { timestamp(v) }
            })
        })
    {
        return None;
    }
    let seconds = store::safe_i64(&value["limit_window_seconds"]);
    let used = percent(&value["used_percent"]).then(|| value["used_percent"].clone());
    let reset = if upstream {
        store::safe_i64(&value["reset_at"])
            .and_then(|n| n.checked_mul(1000))
            .filter(|n| *n <= 9_007_199_254_740_991)
    } else {
        store::safe_i64(&value["reset_at_ms"])
    };
    if upstream && seconds.is_none() && used.is_none() && reset.is_none() {
        return None;
    }
    Some(json!({"limit_window_seconds":seconds,"used_percent":used,"reset_at_ms":reset}))
}
pub fn parse_codex_usage(value: &Value) -> Option<Value> {
    let limits = value.get("rate_limit").filter(|v| store::is_record(v))?;
    let additional:Vec<Value>=value["additional_rate_limits"].as_array().into_iter().flatten().filter_map(|v|{
        let name=v["limit_name"].as_str().map(store::trim).filter(|s|!s.is_empty())?;
        let p=parse_window(&v["rate_limit"]["primary_window"],true);let s=parse_window(&v["rate_limit"]["secondary_window"],true);if p.is_none()&&s.is_none(){return None}
        Some(json!({"limit_name":name,"metered_feature":v["metered_feature"].as_str().map(store::trim).filter(|s|!s.is_empty()),"windows":{"primary":p,"secondary":s}}))
    }).collect();
    Some(
        json!({"primary":parse_window(&limits["primary_window"],true),"secondary":parse_window(&limits["secondary_window"],true),"additional_rate_limits":additional}),
    )
}
pub fn parse_codex_overage(value: &Value) -> Option<Value> {
    let credits = value.get("credits").filter(|v| store::is_record(v))?;
    let balance = credits["balance"].as_str();
    let reached = credits["overage_limit_reached"].as_bool();
    if balance.is_none() && reached.is_none() {
        None
    } else {
        Some(json!({"balance":balance,"overage_limit_reached":reached}))
    }
}
pub fn unavailable_codex(
    slot: u8,
    at: i64,
    kind: &str,
    status: Option<u16>,
    observed: bool,
    label: Option<&str>,
    cohort: Option<&str>,
) -> Value {
    json!({"source":"codex","label":codex_label(slot,label),"slot":slot,"account_cohort_id":cohort,"state":"unavailable","source_observed_at_ms":if observed{Some(at)}else{None},"snapshot_at_ms":at,"failure_kind":kind,"failure_status":status,"windows":{"primary":null,"secondary":null},"additional_rate_limits":[]})
}
pub fn unavailable_metered(at: i64) -> Value {
    json!({"source":"metered","label":"Metered fallback","state":"unavailable","source_observed_at_ms":null,"snapshot_at_ms":at,"wallet":{"balance_credits":null,"baseline_credits":null,"refill_cycle_remaining_percent":null,"refill_cycle_used_percent":null,"unlimited_quota":null,"total_available":null,"total_granted":null,"total_used":null,"cycle_started_at_ms":null,"last_credit_at_ms":null,"confidence":null,"cache_state":null,"reset_at_ms":null}})
}
pub fn unavailable_snapshot(at: i64) -> Value {
    json!({"snapshot_at_ms":at,"stale_after_ms":STALE_MS,"sources":[unavailable_codex(1,at,"not_configured",None,false,None,None),unavailable_codex(2,at,"not_configured",None,false,None,None),unavailable_metered(at)]})
}
pub fn read_codex(value: &Value, fallback: i64) -> Option<Value> {
    if value["source"] != "codex" {
        return None;
    }
    let slot = store::safe_i64(&value["slot"]).filter(|n| *n == 1 || *n == 2)? as u8;
    let state = source_state(&value["state"])?;
    if !nullable(value.get("source_observed_at_ms"), timestamp)
        || !store::is_record(&value["windows"])
    {
        return None;
    }
    let at = if value.get("snapshot_at_ms").is_none() {
        fallback
    } else {
        store::safe_i64(&value["snapshot_at_ms"])?
    };
    let kind = match value.get("failure_kind") {
        Some(Value::Null) | None => {
            if state == "unavailable" {
                Some("not_configured")
            } else {
                None
            }
        }
        Some(v) => Some(v.as_str().filter(|s| {
            [
                "not_configured",
                "http_error",
                "upstream_error",
                "unreachable",
                "invalid_response",
            ]
            .contains(s)
        })?),
    };
    let status = value["failure_status"]
        .as_u64()
        .filter(|n| (100..=599).contains(n));
    if state == "available" && (kind.is_some() || status.is_some()) {
        return None;
    }
    let additional:Vec<Value>=value["additional_rate_limits"].as_array().into_iter().flatten().filter_map(|v|{
        let name=v["limit_name"].as_str().map(store::trim).filter(|s|!s.is_empty())?;if !store::is_record(&v["windows"])||!nullable(v.get("metered_feature"),Value::is_string){return None}
        Some(json!({"limit_name":name,"metered_feature":v["metered_feature"].as_str().map(store::trim).filter(|s|!s.is_empty()),"windows":{"primary":parse_window(&v["windows"]["primary"],false),"secondary":parse_window(&v["windows"]["secondary"],false)}}))
    }).collect();
    Some(
        json!({"source":"codex","label":codex_label(slot,value["label"].as_str()),"slot":slot,"account_cohort_id":digest(&value["account_cohort_id"]),"state":state,"source_observed_at_ms":value["source_observed_at_ms"],"snapshot_at_ms":at,"failure_kind":kind,"failure_status":status,"windows":{"primary":parse_window(&value["windows"]["primary"],false),"secondary":parse_window(&value["windows"]["secondary"],false)},"additional_rate_limits":additional}),
    )
}
pub fn read_metered(value: &Value, at: i64) -> Option<Value> {
    if value["source"] != "metered"
        || !store::is_record(&value["wallet"])
        || !nullable(value.get("source_observed_at_ms"), timestamp)
    {
        return None;
    }
    let state = source_state(&value["state"])?;
    let w = &value["wallet"];
    let mut wallet = json!({});
    for f in [
        "balance_credits",
        "baseline_credits",
        "refill_cycle_remaining_percent",
        "refill_cycle_used_percent",
        "total_available",
        "total_granted",
        "total_used",
    ] {
        wallet[f] = finite(&w[f]).unwrap_or(Value::Null)
    }
    for f in ["cycle_started_at_ms", "last_credit_at_ms"] {
        wallet[f] = json!(store::safe_i64(&w[f]));
    }
    wallet["unlimited_quota"] = json!(w["unlimited_quota"].as_bool());
    wallet["confidence"] = json!(
        w["confidence"].as_str().filter(|s| [
            "provisional",
            "refill_observed",
            "inferred_adjustment"
        ]
        .contains(s))
    );
    wallet["cache_state"] = json!(
        w["cache_state"]
            .as_str()
            .filter(|s| ["fresh", "refreshed", "stale", "wait"].contains(s))
    );
    wallet["reset_at_ms"] = Value::Null;
    Some(
        json!({"source":"metered","label":"Metered fallback","state":state,"source_observed_at_ms":value["source_observed_at_ms"],"snapshot_at_ms":at,"wallet":wallet}),
    )
}
pub fn source(value: &Value, slot: u8) -> Option<&Value> {
    value["sources"]
        .as_array()?
        .iter()
        .find(|v| v["source"] == "codex" && store::safe_i64(&v["slot"]) == Some(i64::from(slot)))
}
pub fn read_snapshot(value: &Value) -> Option<Value> {
    let at = store::safe_i64(&value["snapshot_at_ms"])?;
    let sources = value["sources"].as_array()?;
    let one = read_codex(source(value, 1)?, at)?;
    let two = read_codex(source(value, 2)?, at)?;
    let metered = read_metered(sources.iter().find(|v| v["source"] == "metered")?, at)?;
    Some(json!({"snapshot_at_ms":at,"stale_after_ms":STALE_MS,"sources":[one,two,metered]}))
}
pub fn read_history(value: &Value) -> Option<Value> {
    store::safe_i64(&value["bucket_start_at_ms"])?;
    let at = store::safe_i64(&value["sampled_at_ms"])?;
    let sources = value["sources"].as_array()?;
    Some(
        json!({"bucket_start_at_ms":value["bucket_start_at_ms"],"sampled_at_ms":value["sampled_at_ms"],"sources":[read_codex(source(value,1)?,at)?,read_codex(source(value,2)?,at)?,sources.iter().find(|v|v["source"]=="metered").and_then(|v|read_metered(v,at)).unwrap_or_else(||unavailable_metered(at))]}),
    )
}
pub fn history_point(snapshot: &Value) -> Value {
    let at = snapshot["snapshot_at_ms"]
        .as_i64()
        .expect("validated snapshot clock");
    json!({"bucket_start_at_ms":at/BUCKET_MS*BUCKET_MS,"sampled_at_ms":at,"sources":snapshot["sources"]})
}
pub fn stale_snapshot(snapshot: &Value, at: i64) -> Value {
    let mut value = snapshot.clone();
    if let Some(sources) = value["sources"].as_array_mut() {
        for source in sources {
            if source["state"] != "available" {
                continue;
            }
            let stale = if source["source"] == "codex" {
                source["snapshot_at_ms"]
                    .as_i64()
                    .is_some_and(|t| at >= t + STALE_MS)
            } else {
                source["wallet"]["cache_state"] == "stale"
                    || source["source_observed_at_ms"]
                        .as_i64()
                        .is_none_or(|t| at - t >= METERED_FRESH_MS)
            };
            if stale {
                source["state"] = json!("stale")
            }
        }
    }
    value
}
pub fn metered_source(snapshot: Option<&Value>, at: i64) -> Value {
    let Some(snapshot) = snapshot else {
        return unavailable_metered(at);
    };
    let observed = store::safe_i64(&snapshot["state"]["observed_at_ms"]);
    let stale =
        snapshot["cache_state"] == "stale" || observed.is_none_or(|t| at - t >= METERED_FRESH_MS);
    let token = snapshot["unlimited_quota"] == true
        || !snapshot["total_available"].is_null()
        || !snapshot["total_used"].is_null();
    json!({"source":"metered","label":"Metered fallback","state":if stale{"stale"}else{"available"},"source_observed_at_ms":observed,"snapshot_at_ms":at,"wallet":{"balance_credits":snapshot["balance_credits"],"baseline_credits":snapshot["baseline_credits"],"refill_cycle_remaining_percent":snapshot["remaining_percent"],"refill_cycle_used_percent":snapshot["used_percent"],"unlimited_quota":snapshot["unlimited_quota"],"total_available":snapshot["total_available"],"total_granted":snapshot["total_granted"],"total_used":snapshot["total_used"],"cycle_started_at_ms":if token{Value::Null}else{snapshot["state"]["cycle_started_at_ms"].clone()},"last_credit_at_ms":if token{Value::Null}else{snapshot["state"]["last_credit_at_ms"].clone()},"confidence":if token{Value::Null}else{snapshot["state"]["confidence"].clone()},"cache_state":snapshot["cache_state"],"reset_at_ms":null}})
}
/// The admin retains an unused additional window; routing excludes only its unanchored reset proof.
pub fn additional_for_routing(limits: &Value, at: i64) -> Vec<Value> {
    limits
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|limit| {
            let mut limit = limit.clone();
            for name in ["primary", "secondary"] {
                let w = &limit["windows"][name];
                let unanchored = w["used_percent"].as_f64() == Some(0.0)
                    && w["limit_window_seconds"]
                        .as_i64()
                        .zip(w["reset_at_ms"].as_i64())
                        .is_some_and(|(seconds, reset)| {
                            seconds
                                .checked_mul(1000)
                                .and_then(|duration| at.checked_add(duration))
                                .is_some_and(|expected| (reset - expected).abs() <= 60_000)
                        });
                if unanchored {
                    limit["windows"][name] = Value::Null
                }
            }
            (!limit["windows"]["primary"].is_null() || !limit["windows"]["secondary"].is_null())
                .then_some(limit)
        })
        .collect()
}
