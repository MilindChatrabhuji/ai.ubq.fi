use super::{
    Audit, AuditInventory, SliceInventory, api_id, positive, reference, safe,
    source_fields as source, under,
};
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
    inspect_paid_inventory(&SliceInventory(rows), known, unlimited, now)
}
pub fn inspect_paid_inventory(
    rows: &dyn AuditInventory,
    known: &BTreeSet<String>,
    unlimited: &BTreeSet<String>,
    now: i64,
) -> Result<Audit, GatewayError> {
    let mut state = PaidAudit::new(now);
    rows.visit(&mut |row| {
        state.accept(row);
        Ok(())
    })?;
    state.finish(known, unlimited)
}
pub(super) struct PaidAudit {
    orphans: Vec<Vec<(usize, String, gateway_core::js_string::JsString16)>>,
    now: i64,
    groups: Vec<(Audit, Option<GatewayError>)>,
    windows: BTreeMap<String, Value>,
    requests: BTreeMap<String, SourceJson>,
    pending: BTreeSet<String>,
}
impl PaidAudit {
    pub(super) fn new(now: i64) -> Self {
        Self {
            orphans: (0..5).map(|_| Vec::new()).collect(),
            now,
            groups: (0..5).map(|_| (Audit::default(), None)).collect(),
            windows: BTreeMap::new(),
            requests: BTreeMap::new(),
            pending: BTreeSet::new(),
        }
    }
    pub(super) fn accept(&mut self, row: &ObservedRow) {
        for (index, (segment, count_name)) in [
            ("window", "paid_fallback_v3_windows"),
            ("request", "paid_fallback_v3_requests"),
            ("pending", "paid_fallback_v3_pending"),
            (
                "reconciliation_lease",
                "paid_fallback_v3_reconciliation_leases",
            ),
            ("deletion_guard", "paid_fallback_v3_deletion_guards"),
        ]
        .into_iter()
        .enumerate()
        {
            if !under(&row.parts, &["uos_ai", "paid_fallback", "v3", segment])
                || self.groups[index].1.is_some()
            {
                continue;
            }
            let a = &mut self.groups[index].0;
            let result = (|| -> Result<(), GatewayError> {
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
                        return Ok(());
                    }
                    self.orphans[index].push((
                        a.errors.len(),
                        id.to_owned(),
                        format!(
                            "paid fallback V3 request is orphaned: {id}/{}",
                            p[5].as_str().unwrap_or("")
                        )
                        .as_str()
                        .into(),
                    ));
                    // Full request validation above precedes this exact scalar projection.
                    self.requests.insert(
                        reference(&p[4..]),
                        gateway_core::source_serialization::object(
                            [
                                "key_id",
                                "request_id",
                                "window_reset_at_ms",
                                "reserved_microcredits",
                                "billing_state",
                                "spend_microcredits",
                            ]
                            .into_iter()
                            .map(|field| {
                                (
                                    field,
                                    source::member(&value, field).expect("validated request fact"),
                                )
                            })
                            .collect(),
                        )?,
                    );
                    return Ok(());
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
                    return Ok(());
                }
                if ["window", "request", "reconciliation_lease"].contains(&segment) {
                    self.orphans[index].push((
                        a.errors.len(),
                        id.to_owned(),
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
                    ));
                }
                match segment {
                    "window" => {
                        self.windows.insert(reference(&p[4..]), serde_json::json!({"key_id":v["key_id"],"window_reset_at_ms":v["window_reset_at_ms"],"pending_count":v["pending_count"],"reserved_microcredits":v["reserved_microcredits"],"settled_microcredits":v["settled_microcredits"]}));
                    }
                    "pending" => {
                        self.pending.insert(reference(&p[4..]));
                    }
                    _ => {}
                }
                Ok(())
            })();
            self.groups[index].1 = result.err();
        }
    }
    pub(super) fn finish(
        mut self,
        known: &BTreeSet<String>,
        unlimited: &BTreeSet<String>,
    ) -> Result<Audit, GatewayError> {
        for (index, candidates) in self.orphans.into_iter().enumerate() {
            let mut offset = 0;
            for (position, id, message) in candidates {
                if !known.contains(&id) {
                    self.groups[index]
                        .0
                        .errors
                        .insert(position + offset, message);
                    offset += 1;
                }
            }
        }
        let mut a = Audit::default();
        for (audit, error) in self.groups {
            if let Some(e) = error {
                return Err(e);
            }
            a.merge(audit);
        }
        for (r, v) in &self.requests {
            let outstanding = source::equals(v, "billing_state", &serde_json::json!("pending"))
                || source::equals(v, "billing_state", &serde_json::json!("unresolved"));
            let id = source::text(v, "key_id").unwrap_or_default();
            let request = source::text(v, "request_id").unwrap_or_default();
            if outstanding && !self.pending.contains(r) {
                a.errors.push(
                    format!(
                        "paid fallback V3 request is missing its pending marker: {id}/{request}"
                    )
                    .as_str()
                    .into(),
                );
            }
            if !outstanding && self.pending.contains(r) {
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
                && !self.windows.contains_key(&wr)
            {
                a.errors.push(
                    format!(
                        "paid fallback V3 bounded request is missing its window: {id}/{request}"
                    )
                    .as_str()
                    .into(),
                );
            }
            let spend_null = source::member(v, "spend_microcredits")
                .is_some_and(|value| value.as_str() == "null");
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
        for r in &self.pending {
            if !self.requests.contains_key(r) {
                a.errors.push(
                    format!("paid fallback V3 pending marker is orphaned: {r}")
                        .as_str()
                        .into(),
                );
            }
        }
        for (r, w) in &self.windows {
            if integer(w, "window_reset_at_ms")
                .and_then(|reset| reset.checked_add((365 - 32) * super::super::retention::DAY))
                .is_some_and(|cutoff| cutoff <= self.now)
            {
                continue;
            }
            let related: Vec<_> = self
                .requests
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
}
