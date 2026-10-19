use super::{ObservedRow, check, key, put};
use crate::{error, integer, text};
use gateway_core::{
    GatewayError,
    state::{AtomicTransition, RevisionCheck},
    value::PortableValue,
};
use serde_json::{Value, json};

pub fn current_legacy_usage(record: &Value, now: i64) -> Option<i64> {
    Some(if now < integer(record, "usage_reset_at_ms")? {
        integer(record, "usage_requests")?
    } else {
        0
    })
}
pub fn migration_policy_now(record: &Value, now: i64) -> Option<i64> {
    Some(if record.get("revoked_at_ms")?.is_null() {
        now
    } else {
        (integer(record, "usage_reset_at_ms")? - 1).max(0)
    })
}
pub fn valid_baseline(value: &Value) -> bool {
    value["version"] == 1
        && super::audit::api_id(value.get("key_id"))
        && text(value, "policy_version").is_some_and(|s| !s.is_empty())
        && [
            "window_start_ms",
            "last_legacy_usage_requests",
            "reconciliation_runs",
        ]
        .iter()
        .all(|f| integer(value, f).is_some())
        && integer(value, "seeded_at_ms").is_some_and(|v| v > 0)
        && (value["reconciled_at_ms"].is_null()
            || integer(value, "reconciled_at_ms").is_some_and(|v| v > 0))
}
#[derive(Clone, Debug)]
pub struct CounterPlan {
    pub baseline_created: bool,
    pub baseline_reconciled: bool,
    pub legacy_usage_delta_applied: i64,
    pub transition: AtomicTransition,
}
pub struct CounterEntries<'a> {
    pub baseline: Option<&'a ObservedRow>,
    pub counter: Option<&'a ObservedRow>,
    pub window: Option<&'a ObservedRow>,
}
pub struct CounterContext<'a> {
    pub legacy_usage: i64,
    pub now: i64,
    pub initialized: bool,
    pub new_revision: &'a str,
}
pub fn plan_counter_handoff(
    policy: &Value,
    entries: CounterEntries<'_>,
    context: CounterContext<'_>,
) -> Result<CounterPlan, GatewayError> {
    let CounterEntries {
        baseline,
        counter,
        window,
    } = entries;
    let CounterContext {
        legacy_usage,
        now,
        initialized,
        new_revision,
    } = context;
    let key_id = text(policy, "key_id")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error("Missing policy key id."))?;
    let version = text(policy, "policy_version").ok_or_else(|| error("Missing policy version."))?;
    let start = integer(policy, "window_start_ms").ok_or_else(|| error("Invalid window start."))?;
    let reset =
        integer(policy, "usage_reset_at_ms").ok_or_else(|| error("Invalid window reset."))?;
    let observed = if let Some(counter) = counter {
        match counter.record.portable_value()? {
            PortableValue::Null => legacy_usage,
            PortableValue::KvU64(v) => v
                .parse::<i64>()
                .ok()
                .filter(|v| *v <= 9_007_199_254_740_991)
                .ok_or_else(|| error("Legacy V2 API-key counter is out of range."))?,
            _ => return Err(error("Legacy V2 API-key counter is invalid.")),
        }
    } else {
        legacy_usage
    };
    if !(0..=9_007_199_254_740_991).contains(&observed) {
        return Err(error("Legacy V2 API-key counter is out of range."));
    }
    let existing = window
        .map(ObservedRow::value)
        .transpose()?
        .filter(|v| super::audit::valid_api_window(v));
    if existing.is_some_and(|w| {
        text(w, "key_id") != Some(key_id)
            || text(w, "policy_version") != Some(version)
            || integer(w, "window_start_ms") != Some(start)
            || integer(w, "window_reset_at_ms") != Some(reset)
    }) {
        return Err(error("V3 API-key window identity is invalid."));
    }
    let baseline_value = baseline
        .map(ObservedRow::value)
        .transpose()?
        .filter(|v| !v.is_null());
    let created = baseline_value.is_none();
    let mut next_baseline = if let Some(old) = baseline_value {
        if !valid_baseline(old)
            || text(old, "key_id") != Some(key_id)
            || text(old, "policy_version") != Some(version)
            || integer(old, "window_start_ms") != Some(start)
        {
            return Err(error("Bounded counter handoff baseline is invalid."));
        }
        if existing.is_none() {
            return Err(error("V3 API-key window is missing."));
        }
        old.clone()
    } else {
        json!({"version":1,"key_id":key_id,"policy_version":version,"window_start_ms":start,"last_legacy_usage_requests":0,"seeded_at_ms":now,"reconciled_at_ms":null,"reconciliation_runs":0})
    };
    let previous = integer(&next_baseline, "last_legacy_usage_requests").unwrap_or(0);
    let next = previous.max(observed);
    let delta = if created { observed } else { next - previous };
    next_baseline["last_legacy_usage_requests"] = json!(next);
    next_baseline["reconciled_at_ms"] = if initialized { json!(now) } else { Value::Null };
    next_baseline["reconciliation_runs"] = json!(if initialized {
        integer(&next_baseline, "reconciliation_runs").unwrap_or(0) + 1
    } else {
        0
    });
    let mut next_window=existing.cloned().unwrap_or_else(||json!({"v":3,"key_id":key_id,"policy_version":version,"window_start_ms":start,"window_reset_at_ms":reset,"committed_requests":0,"reserved_requests":0,"updated_at_ms":now}));
    let committed = integer(&next_window, "committed_requests").unwrap_or(0);
    let next_committed = if created {
        committed.max(observed)
    } else {
        committed
            .checked_add(delta)
            .ok_or_else(|| error("Counter migration overflow."))?
    };
    next_window["committed_requests"] = json!(next_committed);
    next_window["updated_at_ms"] = json!(now);
    let baseline_key = key(&[
        json!("uos_ai"),
        json!("migrations"),
        json!("kv_read_incident_v2"),
        json!("api_key_usage_baseline"),
        json!(key_id),
        json!(version),
        json!(start),
    ])?;
    let counter_key = key(&[
        json!("uos_ai"),
        json!("api_key_usage"),
        json!("v2"),
        json!(key_id),
        json!(version.strip_prefix("v3:").unwrap_or(version)),
        json!(start),
    ])?;
    let window_key = key(&[
        json!("uos_ai"),
        json!("api_key_usage"),
        json!("v3"),
        json!("window"),
        json!(key_id),
        json!(version),
        json!(start),
    ])?;
    let expected = |row: Option<&ObservedRow>, key| -> Result<RevisionCheck, GatewayError> {
        if let Some(row) = row {
            if row.key != key {
                return Err(error("Counter migration snapshot key identity mismatch."));
            }
            Ok(check(row))
        } else {
            Ok(RevisionCheck {
                key,
                expected_revision: None,
            })
        }
    };
    let expiry = reset
        .checked_add(7 * super::retention::DAY)
        .and_then(|v| v.checked_add(now.saturating_sub(reset).max(0)))
        .ok_or_else(|| error("Counter migration retention overflow."))?;
    Ok(CounterPlan {
        baseline_created: created,
        baseline_reconciled: initialized,
        legacy_usage_delta_applied: delta,
        transition: AtomicTransition {
            checks: vec![
                expected(baseline, baseline_key.clone())?,
                expected(counter, counter_key)?,
                expected(window, window_key.clone())?,
            ],
            mutations: vec![
                put(baseline_key, next_baseline, None, new_revision),
                put(window_key, next_window, Some(expiry), new_revision),
            ],
        },
    })
}
