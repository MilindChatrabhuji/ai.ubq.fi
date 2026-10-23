//! Redacted source capacity markers and verified reset backfill; no reset execution.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    capacity_shapes::{BUCKET_MS, RETENTION_MS},
    store,
};
use gateway_core::{GatewayError, query::QueryStore};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
fn text(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= max)
}
fn time(v: &Value) -> bool {
    store::safe_i64(v).is_some()
}
fn nullable(value: &Value, name: &str, valid: impl Fn(&Value) -> bool) -> bool {
    value.get(name).is_some_and(|v| v.is_null() || valid(v))
}
fn percent(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
}
pub fn valid_event(kind: &str, v: &Value) -> bool {
    if v["v"] != 1 || !text(&v["event_id"], 512) || !time(&v["observed_at_ms"]) {
        return false;
    }
    if kind == "downtime_event" {
        return v["provider"] == "openai"
            && matches!(
                v["failure_kind"].as_str(),
                Some("upstream_error" | "unreachable")
            )
            && nullable(v, "status", |n| {
                store::safe_i64(n).is_some_and(|s| (500..=599).contains(&s))
            });
    }
    if !matches!(store::safe_i64(&v["slot"]), Some(1 | 2)) {
        return false;
    }
    if kind == "reset_event" {
        return true;
    }
    if kind != "rate_limit_reset_event"
        || v["provider"] != "openai"
        || !matches!(v["window"].as_str(), Some("primary" | "secondary"))
        || [
            "previous_sampled_at_ms",
            "previous_reset_at_ms",
            "reset_at_ms",
        ]
        .iter()
        .any(|f| !time(&v[f]))
        || [
            "previous_used_percent",
            "current_used_percent",
            "capacity_gain_percentage_points",
        ]
        .iter()
        .any(|f| !percent(&v[f]))
    {
        return false;
    }
    store::safe_i64(&v["previous_sampled_at_ms"]) < store::safe_i64(&v["observed_at_ms"])
        && store::safe_i64(&v["previous_reset_at_ms"]) < store::safe_i64(&v["reset_at_ms"])
        && (v["previous_used_percent"].as_f64().unwrap_or(0.0)
            - v["current_used_percent"].as_f64().unwrap_or(0.0)
            - v["capacity_gain_percentage_points"].as_f64().unwrap_or(0.0))
        .abs()
            <= 0.001
}
pub fn event_key(kind: &str, id: &str) -> gateway_core::state::RecordKey {
    store::key(json!(["uos_ai", "provider_capacity", "v1", kind, id]))
}
pub fn parse_shadow(value: &Value) -> Option<Value> {
    if value["v"] != 1
        || !text(&value["episode_hash"], 512)
        || !time(&value["created_at_ms"])
        || !time(&value["expires_at_ms"])
        || store::safe_i64(&value["expires_at_ms"]) < store::safe_i64(&value["created_at_ms"])
        || !text(&value["decision_reason"], 128)
        || !nullable(value, "selected_account_id_hash", |v| text(v, 512))
        || !nullable(value, "selected_credit_id_hash", |v| text(v, 512))
        || !nullable(value, "selected_credit_expires_at_ms", time)
        || value["selected_account_id_hash"].is_null() != value["selected_credit_id_hash"].is_null()
    {
        return None;
    }
    let fences = value["fences"].as_array().filter(|a| !a.is_empty())?;
    let mut slots = BTreeSet::new();
    let mut parsed = Vec::new();
    for fence in fences {
        if !time(&fence["slot"])
            || !text(&fence["account_id_hash"], 512)
            || !text(&fence["quota_generation"], 512)
            || !time(&fence["routing_generation"])
            || !time(&fence["quota_reset_at_ms"])
            || !slots.insert(store::safe_i64(&fence["slot"])?)
        {
            return None;
        }
        parsed.push(json!({"slot":fence["slot"],"account_id_hash":fence["account_id_hash"],"quota_generation":fence["quota_generation"],"routing_generation":fence["routing_generation"],"quota_reset_at_ms":fence["quota_reset_at_ms"]}));
    }
    Some(
        json!({"v":1,"episode_hash":value["episode_hash"],"created_at_ms":value["created_at_ms"],"expires_at_ms":value["expires_at_ms"],"decision_reason":value["decision_reason"],"selected_account_id_hash":value["selected_account_id_hash"],"selected_credit_id_hash":value["selected_credit_id_hash"],"selected_credit_expires_at_ms":value["selected_credit_expires_at_ms"],"fences":parsed}),
    )
}
pub fn valid_redemption(v: &Value) -> bool {
    if v["v"] != 1
        || [
            "account_id_hash",
            "credential_version",
            "quota_generation",
            "idempotency_key_hash",
            "owner_token",
        ]
        .iter()
        .any(|f| !text(&v[f], 512))
        || [
            "routing_generation",
            "fence",
            "lease_expires_at_ms",
            "created_at_ms",
            "updated_at_ms",
        ]
        .iter()
        .any(|f| !time(&v[f]))
        || !nullable(v, "provider_receipt_id", |v| text(v, 512))
        || !nullable(v, "submitted_at_ms", time)
        || !nullable(v, "verified_at_ms", time)
        || !nullable(v, "last_error_code", |v| text(v, 128))
    {
        return false;
    }
    let created = store::safe_i64(&v["created_at_ms"]).unwrap_or(0);
    let updated = store::safe_i64(&v["updated_at_ms"]).unwrap_or(0);
    let submitted = store::safe_i64(&v["submitted_at_ms"]);
    let verified = store::safe_i64(&v["verified_at_ms"]);
    let error = !v["last_error_code"].is_null();
    if updated < created
        || submitted.is_some_and(|t| t < created || updated < t)
        || verified.is_some_and(|t| submitted.is_none_or(|s| t < s) || updated < t)
    {
        return false;
    }
    match v["state"].as_str() {
        Some("claimed") => {
            v["provider_receipt_id"].is_null()
                && submitted.is_none()
                && verified.is_none()
                && !error
        }
        Some("submitted") => submitted.is_some() && verified.is_none() && !error,
        Some("unknown") => submitted.is_some() && verified.is_none() && error,
        Some("verified") => submitted.is_some() && verified.is_some() && !error,
        Some("rejected") => verified.is_none() && error,
        _ => false,
    }
}
fn public_event(kind: &str, v: &Value) -> Value {
    let mut out = json!({"v":1,"event_id":v["event_id"],"observed_at_ms":v["observed_at_ms"]});
    let fields: &[&str] = match kind {
        "reset_event" => &["slot"],
        "downtime_event" => &["provider", "failure_kind", "status"],
        _ => &[
            "provider",
            "slot",
            "window",
            "previous_sampled_at_ms",
            "previous_reset_at_ms",
            "reset_at_ms",
            "previous_used_percent",
            "current_used_percent",
            "capacity_gain_percentage_points",
        ],
    };
    for field in fields {
        out[*field] = v[*field].clone()
    }
    out
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn record_capacity_reset_event(&self, event: &Value) -> bool {
        if !valid_event("reset_event", event) {
            return false;
        }
        self.write_capacity_event("reset_event", event, false)
            .await
            .unwrap_or(false)
    }
    pub async fn record_capacity_downtime(
        &self,
        failure_kind: &str,
        status: Option<u16>,
        observed_at_ms: i64,
    ) -> bool {
        let event = json!({"v":1,"event_id":format!("openai-{}",observed_at_ms/BUCKET_MS*BUCKET_MS),"provider":"openai","failure_kind":failure_kind,"status":status,"observed_at_ms":observed_at_ms});
        if !valid_event("downtime_event", &event) {
            return false;
        }
        self.write_capacity_event("downtime_event", &event, true)
            .await
            .unwrap_or(false)
    }
    async fn write_capacity_event(
        &self,
        kind: &str,
        event: &Value,
        any_existing: bool,
    ) -> Result<bool, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let key = event_key(
            kind,
            event["event_id"].as_str().expect("validated event ID"),
        );
        for _ in 0..4 {
            let row = self.store.read(&key).await?;
            if let Some(v) = store::value(row.as_ref(), at)? {
                if any_existing {
                    return Ok(valid_event(kind, v));
                }
                if valid_event(kind, v) {
                    return Ok(v["slot"] == event["slot"]
                        && v["observed_at_ms"] == event["observed_at_ms"]);
                }
            }
            if store::commit(
                self.store.as_ref(),
                vec![store::check(&key, row.as_ref())],
                vec![store::put(
                    self.host.as_ref(),
                    key.clone(),
                    event.clone(),
                    Some(at + RETENTION_MS),
                )?],
            )
            .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
    pub async fn capacity_events(&self, kind: &str, at: i64) -> Result<Vec<Value>, GatewayError> {
        if !["reset_event", "rate_limit_reset_event", "downtime_event"].contains(&kind) {
            return Err(store::invalid("Invalid capacity event family"));
        }
        let cutoff = (at - RETENTION_MS).max(0);
        let mut events = BTreeMap::new();
        for entry in store::scan(
            self.store.as_ref(),
            store::key(json!(["uos_ai", "provider_capacity", "v1", kind])),
            false,
            at,
            usize::MAX,
        )
        .await?
        {
            let v = entry.record.json_value()?;
            if valid_event(kind, v)
                && store::safe_i64(&v["observed_at_ms"]).is_some_and(|t| t >= cutoff && t <= at)
            {
                events.insert(
                    v["event_id"].as_str().unwrap_or("").to_owned(),
                    public_event(kind, v),
                );
            }
        }
        if kind == "reset_event" {
            let derivation:Result<Vec<Value>,GatewayError>=async {
                let mut fences=Vec::new();
                for row in store::scan(self.store.as_ref(),store::key(json!(["uos_ai","codex_reset_shadow_decision","v1"])),false,at,usize::MAX).await? {
                    if let Some(value)=parse_shadow(row.record.json_value()?){fences.extend(value["fences"].as_array().expect("source fences").iter().cloned());}
                }
                let mut derived=Vec::new();
                for row in store::scan(self.store.as_ref(),store::key(json!(["uos_ai","codex_reset_redemption","v1"])),false,at,usize::MAX).await? {
                    let value=row.record.json_value()?;
                    if !valid_redemption(value)||value["state"]!="verified"||!store::safe_i64(&value["verified_at_ms"]).is_some_and(|t|t>=cutoff&&t<=at){continue;}
                    if let Some(fence)=fences.iter().find(|f|f["account_id_hash"]==value["account_id_hash"]&&f["quota_generation"]==value["quota_generation"])
                        && matches!(store::safe_i64(&fence["slot"]),Some(1|2)) {
                        derived.push(json!({"v":1,"event_id":value["idempotency_key_hash"],"slot":fence["slot"],"observed_at_ms":value["verified_at_ms"]}));
                    }
                }
                Ok(derived)
            }.await;
            for event in derivation.unwrap_or_else(|_: GatewayError| Vec::new()) {
                let id = event["event_id"].as_str().unwrap_or("").to_owned();
                if let std::collections::btree_map::Entry::Vacant(entry) = events.entry(id) {
                    let _ = self.record_capacity_reset_event(&event).await;
                    entry.insert(event);
                }
            }
        }
        let mut events: Vec<Value> = events.into_values().collect();
        let mut error = None;
        events.sort_by(|a, b| {
            store::safe_i64(&a["observed_at_ms"])
                .cmp(&store::safe_i64(&b["observed_at_ms"]))
                .then_with(|| {
                    match self.host.compare_labels(
                        a["event_id"].as_str().unwrap_or(""),
                        b["event_id"].as_str().unwrap_or(""),
                    ) {
                        Ok(order) => order,
                        Err(e) => {
                            error = Some(e);
                            std::cmp::Ordering::Equal
                        }
                    }
                })
        });
        if let Some(error) = error {
            return Err(error);
        }
        Ok(events)
    }
}
