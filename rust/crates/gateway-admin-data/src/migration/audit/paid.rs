use super::{Audit, api_id, positive, reference, safe, source_fields as source, under};
use crate::migration::ObservedRow;
use crate::{integer, number, text};
use gateway_core::{
    GatewayError, source_control::decode_source_control_record, source_json::SourceJson,
    source_serialization,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Validate the existing source paid-request shape without a model/effort Value transcript.
pub fn valid_source_paid_request(v: &SourceJson) -> bool {
    source::equals(v, "v", &serde_json::json!(3))
        && api_id(source::finite(v, "key_id").as_ref())
        && api_id(source::finite(v, "request_id").as_ref())
        && ["policy_version", "route", "path", "model"]
            .iter()
            .all(|field| {
                source::member(v, field)
                    .and_then(|value| source_serialization::string(&value))
                    .is_some_and(|text| !text.as_units().is_empty())
            })
        && source::finite(v, "stream").is_some_and(|value| value.is_boolean())
        && source::nullable_string(v, "reasoning", true)
        && source::positive(v, "window_reset_at_ms")
        && source::safe(v, "reserved_microcredits")
        && source::positive(v, "quota_per_credit")
        && source::member(v, "provider").is_none_or(|value| {
            value
                .deserialize::<String>()
                .is_ok_and(|text| text == "metered" || text == "surplus")
        })
        && source::nullable_string(v, "provider_request_id", true)
        && source::member(v, "provider_quota").is_some_and(|value| {
            value.as_str() == "null"
                || source_serialization::number(&value).is_some_and(|n| n.is_finite() && n >= 0.0)
        })
        && ["input_tokens", "output_tokens", "spend_microcredits"]
            .iter()
            .all(|field| source::nullable_safe(v, field, false))
        && [
            (
                "dispatch_state",
                ["reserved", "dispatched", "not_dispatched"].as_slice(),
            ),
            (
                "terminal_state",
                [
                    "pending",
                    "completed",
                    "failed",
                    "incomplete",
                    "cancelled",
                    "ambiguous",
                ]
                .as_slice(),
            ),
            (
                "billing_state",
                ["pending", "settled", "not_billed", "unresolved"].as_slice(),
            ),
        ]
        .iter()
        .all(|(field, allowed)| {
            source::finite(v, field)
                .is_some_and(|value| allowed.contains(&crate::profile::js_string(&value).as_str()))
        })
        && source::safe(v, "reconciliation_attempts")
        && [
            "last_reconciliation_at_ms",
            "dispatched_at_ms",
            "terminal_at_ms",
            "settled_at_ms",
        ]
        .iter()
        .all(|field| source::nullable_safe(v, field, true))
        && source::positive(v, "created_at_ms")
        && source::positive(v, "updated_at_ms")
}
fn valid_window(v: &Value) -> bool {
    v["v"] == 3
        && api_id(v.get("key_id"))
        && text(v, "policy_version").is_some_and(|s| !s.is_empty())
        && positive(v.get("window_reset_at_ms"))
        && (v["limit_microcredits"] == -1 || positive(v.get("limit_microcredits")))
        && [
            "settled_microcredits",
            "reserved_microcredits",
            "pending_count",
        ]
        .iter()
        .all(|f| safe(v.get(f)))
        && positive(v.get("updated_at_ms"))
}

pub fn inspect_paid(
    rows: &[ObservedRow],
    known: &BTreeSet<String>,
    unlimited: &BTreeSet<String>,
    now: i64,
) -> Result<Audit, GatewayError> {
    let mut a = Audit::default();
    let mut windows: BTreeMap<String, &Value> = BTreeMap::new();
    let mut requests: BTreeMap<String, SourceJson> = BTreeMap::new();
    let mut pending = BTreeSet::new();
    for (segment, count_name) in [
        ("window", "paid_fallback_v3_windows"),
        ("request", "paid_fallback_v3_requests"),
        ("pending", "paid_fallback_v3_pending"),
        (
            "reconciliation_lease",
            "paid_fallback_v3_reconciliation_leases",
        ),
        ("deletion_guard", "paid_fallback_v3_deletion_guards"),
    ] {
        for row in rows
            .iter()
            .filter(|r| under(&r.parts, &["uos_ai", "paid_fallback", "v3", segment]))
        {
            a.count(count_name);
            let p = &row.parts;
            let id = p.get(4).and_then(Value::as_str).unwrap_or("");
            if segment == "request" {
                let value = decode_source_control_record(&row.record)?;
                if p.len() != 6
                    || !api_id(p.get(4))
                    || !api_id(p.get(5))
                    || !valid_source_paid_request(&value)
                    || !source::equals(&value, "key_id", &p[4])
                    || !source::equals(&value, "request_id", &p[5])
                {
                    a.errors.push(
                        format!("paid fallback V3 request is malformed: {}", reference(p))
                            .as_str()
                            .into(),
                    );
                    continue;
                }
                if !known.contains(id) {
                    a.errors.push(
                        format!(
                            "paid fallback V3 request is orphaned: {id}/{}",
                            p[5].as_str().unwrap_or("")
                        )
                        .as_str()
                        .into(),
                    );
                }
                requests.insert(reference(&p[4..]), value);
                continue;
            }
            let v = row.value()?;
            let diagnostic = match segment {
                "window" => "window",
                "request" => "request",
                "pending" => "pending marker",
                "reconciliation_lease" => "reconciliation lease",
                _ => "deletion guard",
            };
            let valid = match segment {
                "window" => {
                    p.len() == 6
                        && api_id(p.get(4))
                        && positive(p.get(5))
                        && valid_window(v)
                        && v["key_id"] == p[4]
                        && v["window_reset_at_ms"] == p[5]
                }
                "pending" => {
                    p.len() == 6
                        && api_id(p.get(4))
                        && api_id(p.get(5))
                        && v.is_object()
                        && positive(v.get("created_at_ms"))
                        && positive(v.get("next_reconciliation_at_ms"))
                        && number(v, "next_reconciliation_at_ms") >= number(v, "created_at_ms")
                        && v.get("key_id").is_none_or(|v| *v == p[4])
                        && v.get("request_id").is_none_or(|v| *v == p[5])
                }
                "reconciliation_lease" => {
                    p.len() == 5
                        && api_id(p.get(4))
                        && v.is_object()
                        && text(v, "token").is_some_and(|s| !s.is_empty())
                        && positive(v.get("expires_at_ms"))
                }
                _ => {
                    p.len() == 5
                        && api_id(p.get(4))
                        && v.is_object()
                        && positive(v.get("created_at_ms"))
                }
            };
            if !valid {
                a.errors.push(
                    format!(
                        "paid fallback V3 {diagnostic} is malformed: {}",
                        reference(p)
                    )
                    .as_str()
                    .into(),
                );
                continue;
            }
            if ["window", "request", "reconciliation_lease"].contains(&segment)
                && !known.contains(id)
            {
                a.errors.push(
                    format!(
                        "paid fallback V3 {diagnostic} is orphaned: {}",
                        if segment == "request" {
                            format!("{id}/{}", p[5].as_str().unwrap_or(""))
                        } else {
                            id.to_owned()
                        }
                    )
                    .as_str()
                    .into(),
                );
            }
            match segment {
                "window" => {
                    windows.insert(reference(&p[4..]), v);
                }
                "pending" => {
                    pending.insert(reference(&p[4..]));
                }
                _ => {}
            }
        }
    }
    for (r, v) in &requests {
        let outstanding = source::equals(v, "billing_state", &serde_json::json!("pending"))
            || source::equals(v, "billing_state", &serde_json::json!("unresolved"));
        let id = source::text(v, "key_id").unwrap_or_default();
        let request = source::text(v, "request_id").unwrap_or_default();
        if outstanding && !pending.contains(r) {
            a.errors.push(
                format!("paid fallback V3 request is missing its pending marker: {id}/{request}")
                    .as_str()
                    .into(),
            );
        }
        if !outstanding && pending.contains(r) {
            a.errors.push(
                format!(
                    "paid fallback V3 terminal request retains a pending marker: {id}/{request}"
                )
                .as_str()
                .into(),
            );
        }
        let wr = reference(&[
            source::finite(v, "key_id").unwrap_or(Value::Null),
            source::finite(v, "window_reset_at_ms").unwrap_or(Value::Null),
        ]);
        if !unlimited.contains(&id)
            && (source::number(v, "reserved_microcredits").unwrap_or(0.0) > 0.0
                || (source::equals(v, "billing_state", &serde_json::json!("settled"))
                    && source::number(v, "spend_microcredits").unwrap_or(0.0) > 0.0))
            && !windows.contains_key(&wr)
        {
            a.errors.push(
                format!("paid fallback V3 bounded request is missing its window: {id}/{request}")
                    .as_str()
                    .into(),
            );
        }
        let spend_null =
            source::member(v, "spend_microcredits").is_some_and(|value| value.as_str() == "null");
        if source::equals(v, "billing_state", &serde_json::json!("settled")) && spend_null {
            a.errors.push(
                format!("paid fallback V3 settled request is missing spend: {id}/{request}")
                    .as_str()
                    .into(),
            );
        }
        if outstanding && !spend_null {
            a.errors.push(
                format!("paid fallback V3 outstanding request has spend: {id}/{request}")
                    .as_str()
                    .into(),
            );
        }
    }
    for r in &pending {
        if !requests.contains_key(r) {
            a.errors.push(
                format!("paid fallback V3 pending marker is orphaned: {r}")
                    .as_str()
                    .into(),
            );
        }
    }
    for (r, w) in &windows {
        if integer(w, "window_reset_at_ms")
            .and_then(|reset| reset.checked_add((365 - 32) * super::super::retention::DAY))
            .is_some_and(|cutoff| cutoff <= now)
        {
            continue;
        }
        let related: Vec<_> = requests
            .values()
            .filter(|v| {
                source::equals(v, "key_id", &w["key_id"])
                    && source::equals(v, "window_reset_at_ms", &w["window_reset_at_ms"])
            })
            .collect();
        let outstanding: Vec<_> = related
            .iter()
            .filter(|v| {
                source::equals(v, "billing_state", &serde_json::json!("pending"))
                    || source::equals(v, "billing_state", &serde_json::json!("unresolved"))
            })
            .collect();
        let reserved = outstanding
            .iter()
            .map(|v| source::number(v, "reserved_microcredits").unwrap_or(0.0))
            .sum::<f64>();
        let settled = related
            .iter()
            .filter(|v| source::equals(v, "billing_state", &serde_json::json!("settled")))
            .map(|v| source::number(v, "spend_microcredits").unwrap_or(0.0))
            .sum::<f64>();
        if reserved > 9_007_199_254_740_991.0
            || settled > 9_007_199_254_740_991.0
            || number(w, "pending_count") != Some(outstanding.len() as f64)
            || number(w, "reserved_microcredits") != Some(reserved)
            || number(w, "settled_microcredits") != Some(settled)
        {
            a.errors.push(
                format!("paid fallback V3 window aggregate is inconsistent: {r}")
                    .as_str()
                    .into(),
            );
        }
    }
    Ok(a)
}
