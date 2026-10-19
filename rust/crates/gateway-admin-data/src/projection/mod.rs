//! Source: src/quota-projection.ts at dc6be2c3; caller supplies locale comparison explicitly.
mod refill;
mod source;
pub use source::project_quota_source;

use crate::{json_number, number, positive, present, text};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::{BTreeSet, HashMap},
};

pub const HOUR_MS: f64 = 3_600_000.0;
pub const WINDOW_DAYS: [u32; 3] = [7, 30, 90];
pub type LocaleCompare = fn(&str, &str) -> Ordering;

/// Mirrors the internal view. Public HTTP output must use public_quota_view().
pub fn metered_quota_runway_view(snapshot: Option<&Value>) -> Value {
    let fields = [
        "cache_state",
        "confidence",
        "balance_quota",
        "baseline_quota",
        "quota_per_credit",
        "balance_credits",
        "baseline_credits",
        "remaining_percent",
        "used_percent",
        "total_available",
        "total_granted",
        "total_used",
        "observed_at_ms",
        "cycle_started_at_ms",
        "last_credit_at_ms",
        "last_inferred_credit_quota",
        "latest_refill_amount_credits",
        "latest_refill_completed_at_ms",
    ];
    let Some(snapshot) = snapshot else {
        let mut view = serde_json::Map::new();
        view.insert("configured".into(), json!(false));
        view.insert("available".into(), json!(false));
        view.insert("unlimited_quota".into(), json!(false));
        for field in fields {
            view.insert(field.into(), Value::Null);
        }
        return Value::Object(view);
    };
    let state = &snapshot["state"];
    let token = snapshot["unlimited_quota"] == true
        || !snapshot["total_available"].is_null()
        || !snapshot["total_used"].is_null();
    let mut view = json!({"configured":true,"available":true,"cache_state":present(snapshot,"cache_state"),"confidence":if token {Value::Null}else{present(state,"confidence")},"unlimited_quota":token && snapshot["unlimited_quota"] == true,"balance_quota":if token{Value::Null}else{present(state,"current_balance_quota")},"baseline_quota":if token{Value::Null}else{present(state,"post_refill_baseline_quota")},"quota_per_credit":present(state,"quota_per_credit"),"observed_at_ms":present(state,"observed_at_ms"),"latest_refill_amount_credits":present(state,"latest_refill_amount_credits"),"latest_refill_completed_at_ms":present(state,"latest_refill_completed_at_ms")});
    for field in [
        "balance_credits",
        "baseline_credits",
        "remaining_percent",
        "used_percent",
    ] {
        view[field] = present(snapshot, field);
    }
    for field in ["total_available", "total_granted", "total_used"] {
        view[field] = if token {
            present(snapshot, field)
        } else {
            Value::Null
        };
    }
    for field in [
        "cycle_started_at_ms",
        "last_credit_at_ms",
        "last_inferred_credit_quota",
    ] {
        view[field] = if token {
            Value::Null
        } else {
            present(state, field)
        };
    }
    view
}

pub fn public_quota_view(view: &Value) -> Value {
    let mut public = view.clone();
    if let Some(object) = public.as_object_mut() {
        object.remove("last_inferred_credit_quota");
    }
    public
}

/// The source uses localeCompare. Supplying it avoids guessing a locale in the pure layer.
pub fn group_paid_fallback_usage_rollups(rollups: &[Value], compare: LocaleCompare) -> Vec<Value> {
    let mut indexes: HashMap<String, usize> = HashMap::new();
    let mut grouped: Vec<(String, Vec<Value>)> = vec![];
    for row in rollups {
        let identity = format!(
            "{}\0{}",
            text(row, "model").unwrap_or(""),
            text(row, "provider").unwrap_or("")
        );
        if let Some(index) = indexes.get(&identity) {
            grouped[*index].1.push(row.clone());
        } else {
            indexes.insert(identity.clone(), grouped.len());
            grouped.push((identity, vec![row.clone()]));
        }
    }
    let mut result: Vec<Value> = grouped
        .into_iter()
        .map(|(identity, mut buckets)| {
            buckets.sort_by(|a, b| {
                number(a, "bucket_start_at_ms")
                    .unwrap_or(f64::NAN)
                    .total_cmp(&number(b, "bucket_start_at_ms").unwrap_or(f64::NAN))
            });
            let mut fields = identity.split('\0');
            let model = fields.next().unwrap_or("");
            let provider = fields.next().unwrap_or("");
            json!({"model":model,"provider":provider,"buckets":buckets})
        })
        .collect();
    result.sort_by(|a, b| {
        compare(
            text(a, "model").unwrap_or(""),
            text(b, "model").unwrap_or(""),
        )
        .then_with(|| {
            compare(
                text(a, "provider").unwrap_or(""),
                text(b, "provider").unwrap_or(""),
            )
        })
    });
    result
}

fn summarize_windows(all_buckets: &[Value], now_ms: f64) -> Vec<Value> {
    WINDOW_DAYS.iter().map(|days| {
        let start=((now_ms-f64::from(*days)*24.0*HOUR_MS)/HOUR_MS).floor()*HOUR_MS;
        let buckets:Vec<&Value>=all_buckets.iter().filter(|row|number(row,"bucket_start_at_ms").is_some_and(|v|v>=start)).collect();
        let sum=|field| buckets.iter().map(|row|number(row,field).unwrap_or(f64::NAN)).sum::<f64>();
        let count=sum("request_count"); let quota=sum("quota_sum");
        let distinct:BTreeSet<u64>=buckets.iter().filter_map(|row|number(row,"bucket_start_at_ms").map(|v|if v==0.0{0}else{v.to_bits()})).collect();
        let mut output=json!({"window_days":days,"bucket_count":distinct.len(),"first_bucket_start_at_ms":buckets.first().map(|v|present(v,"bucket_start_at_ms")),"last_bucket_start_at_ms":buckets.last().map(|v|present(v,"bucket_start_at_ms"))});
        for field in ["request_count","quota_sum","spend_microcredits","input_tokens","cached_input_tokens","output_tokens"] { output[field]=json_number(Some(sum(field))); }
        output["avg_quota_per_request"]=json_number((count>0.0).then_some(quota/count));
        output["quota_per_hour"]=json_number(Some(quota/(f64::from(*days)*24.0)));
        output
    }).collect()
}

pub fn summarize_paid_fallback_usage(series: &[Value], now_ms: f64) -> Vec<Value> {
    series.iter().map(|series| {
        let windows = summarize_windows(series["buckets"].as_array().map_or(&[],Vec::as_slice),now_ms);
        json!({"model":present(series,"model"),"provider":present(series,"provider"),"windows":windows})
    }).collect()
}

pub fn project_paid_fallback_runway(
    usage: &Value,
    quota: &Value,
    now_ms: f64,
    history: Option<&[Value]>,
) -> Vec<Value> {
    project_runway_numbers(
        text(usage, "provider") == Some("metered"),
        usage["windows"].as_array().map_or(&[], Vec::as_slice),
        quota,
        now_ms,
        history,
    )
}

fn project_runway_numbers(
    metered: bool,
    windows: &[Value],
    quota: &Value,
    now_ms: f64,
    history: Option<&[Value]>,
) -> Vec<Value> {
    if !metered {
        return vec![];
    }
    let unlimited = quota["unlimited_quota"] == true;
    let balance = if unlimited {
        None
    } else {
        number(quota, "balance_quota")
            .or_else(|| number(quota, "total_available"))
            .map(|v| v.max(0.0))
    };
    let baseline = if unlimited {
        None
    } else {
        number(quota, "baseline_quota")
            .map(|v| v.max(0.0))
            .or_else(|| positive(number(quota, "total_granted")))
    };
    windows.iter().map(|window| {
        let avg=positive(number(window,"avg_quota_per_request")); let burn=positive(number(window,"quota_per_hour"));
        let requests=balance.zip(avg).map(|(b,a)|(b/a).floor()); let time=balance.zip(burn).map(|(b,r)|(b/r*HOUR_MS).trunc());
        let forecast=if unlimited {refill::empty()}else{refill::project(quota,balance,burn,history,now_ms)};
        let mut out=json!({"window_days":present(window,"window_days"),"unlimited":unlimited,"stale_balance":quota["cache_state"]=="stale","requests_remaining":json_number(requests),"time_remaining_ms":json_number(time),"refill_aware_status":forecast["status"],"refill_aware_time_remaining_ms":forecast["time"],"refill_aware_exhausted_at_ms":forecast["exhausted"],"refill_amount_credits":forecast["amount"],"refill_cadence_ms":forecast["cadence"],"refill_rate_quota_per_hour":forecast["rate"],"next_refill_at_ms":forecast["next"],"exhausted_at_ms":json_number(time.map(|t|now_ms+t))});
        out["percent_per_request_vs_balance"]=json_number(balance.filter(|v|*v>0.0).zip(avg).map(|(b,a)|a/b*100.0));
        out["percent_per_request_vs_baseline"]=json_number(baseline.filter(|v|*v>0.0).zip(avg).map(|(b,a)|a/b*100.0)); out
    }).collect()
}

fn model_projection_numbers(
    metered: bool,
    paid: bool,
    windows: &[Value],
    quota: &Value,
    now_ms: f64,
    history: Option<&[Value]>,
    window_days: u32,
) -> Value {
    json!({"quota_source":if metered{json!("metered")}else{Value::Null},"usage_source":if paid{"paid_fallback"}else{"observability"},"usage":windows.iter().filter(|w|w["window_days"]==window_days).cloned().collect::<Vec<_>>(),"estimates":project_runway_numbers(metered,windows,quota,now_ms,history).into_iter().filter(|w|w["window_days"]==window_days).collect::<Vec<_>>()})
}

/// Returns only the pure portion of the admin response; host-owned I/O telemetry is separate.
pub fn project_quota(
    rollups: Option<&[Value]>,
    snapshot: Option<&Value>,
    history: Option<&[Value]>,
    now_ms: f64,
    window_days: u32,
    compare: LocaleCompare,
) -> Value {
    let quota = metered_quota_runway_view(snapshot);
    let usage = summarize_paid_fallback_usage(
        &group_paid_fallback_usage_rollups(rollups.unwrap_or(&[]), compare),
        now_ms,
    );
    let models: Vec<Value> = usage
        .iter()
        .map(|entry| {
            let metered = entry["provider"] == "metered";
            let numbers = model_projection_numbers(
                metered,
                metered || entry["provider"] == "surplus",
                entry["windows"].as_array().map_or(&[], Vec::as_slice),
                &quota,
                now_ms,
                history,
                window_days,
            );
            let mut out = json!({"model":entry["model"],"provider":entry["provider"]});
            for (key, value) in numbers.as_object().expect("numeric projection object") {
                out[key] = value.clone();
            }
            out
        })
        .collect();
    json!({"snapshot_at_ms":json_number(Some(now_ms)),"window_days":window_days,"quota":public_quota_view(&quota),"models":models,"rollup_scan":if rollups.is_some(){"ok"}else{"unavailable"},"balance_history_scan":if history.is_some(){"ok"}else{"unavailable"}})
}
