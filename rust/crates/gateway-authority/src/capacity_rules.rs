//! Source capacity row codecs and named-window applicability; no producer trust is inferred here.
use crate::routing_codec::{safe_integer, safe_ms};
use crate::{
    invalid,
    routing::{
        CapacityAdditionalRateLimit, CapacityObservation, CapacityState, CapacityStore,
        CapacityWindow, CapacityWindows,
    },
};
use gateway_core::model::ModelId;
use gateway_core::{GatewayError, identity::RoutingAccountHash};
use serde_json::Value;
pub const CAPACITY_MAX_AGE_MS: i64 = 30 * crate::MINUTE_MS;
fn optional_time(value: &Value, name: &str) -> Option<i64> {
    value.get(name).and_then(safe_ms)
}
pub fn normalize_capacity_window(raw: &Value) -> Option<CapacityWindow> {
    raw.as_object()?;
    Some(CapacityWindow {
        limit_window_seconds: optional_time(raw, "limit_window_seconds"),
        used_percent: raw
            .get("used_percent")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && (0.0..=100.0).contains(n)),
        reset_at_ms: optional_time(raw, "reset_at_ms"),
    })
}
fn windows(raw: &Value) -> CapacityWindows {
    CapacityWindows {
        primary: raw.get("primary").and_then(normalize_capacity_window),
        secondary: raw.get("secondary").and_then(normalize_capacity_window),
    }
}
fn additional(raw: &Value) -> Vec<CapacityAdditionalRateLimit> {
    raw.as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let name = row.get("limit_name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let raw_windows = row.get("windows")?.as_object()?;
            let feature = match row.get("metered_feature") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => {
                    Some(s.trim()).filter(|s| !s.is_empty()).map(str::to_owned)
                }
                _ => return None,
            };
            Some(CapacityAdditionalRateLimit {
                limit_name: name.into(),
                metered_feature: feature,
                windows: windows(&Value::Object(raw_windows.clone())),
            })
        })
        .collect()
}
pub fn parse_capacity_observation(raw: &Value) -> Result<CapacityObservation, GatewayError> {
    let slot = raw
        .get("slot")
        .and_then(safe_ms)
        .filter(|n| *n <= 1)
        .ok_or_else(|| invalid("Malformed capacity slot."))? as u8;
    let hash = raw
        .get("account_id_hash")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("Missing capacity account hash."))?;
    let state = match raw.get("state").and_then(Value::as_str) {
        Some("available") => CapacityState::Available,
        Some("stale") => CapacityState::Stale,
        Some("unavailable") => CapacityState::Unavailable,
        _ => return Err(invalid("Malformed capacity observation state.")),
    };
    let snapshot_at_ms = raw
        .get("snapshot_at_ms")
        .and_then(safe_ms)
        .ok_or_else(|| invalid("Malformed capacity snapshot time."))?;
    let raw_windows = raw
        .get("windows")
        .filter(|v| v.is_object())
        .ok_or_else(|| invalid("Missing named capacity windows."))?;
    Ok(CapacityObservation {
        slot,
        account_id_hash: RoutingAccountHash(hash.into()),
        state,
        source_observed_at_ms: optional_time(raw, "source_observed_at_ms"),
        snapshot_at_ms,
        windows: windows(raw_windows),
        additional_rate_limits: additional(
            raw.get("additional_rate_limits").unwrap_or(&Value::Null),
        ),
    })
}
pub fn parse_capacity_store(raw: &Value) -> Result<CapacityStore, GatewayError> {
    if raw.get("v").and_then(safe_integer) != Some(1) {
        return Err(invalid("Unsupported capacity observation schema."));
    }
    let updated_at_ms = raw
        .get("updated_at_ms")
        .and_then(safe_ms)
        .ok_or_else(|| invalid("Malformed capacity store time."))?;
    let observations = raw
        .get("observations")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("Malformed capacity observation rows."))?
        .iter()
        .map(parse_capacity_observation)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CapacityStore {
        v: 1,
        updated_at_ms,
        observations,
    })
}
pub fn capacity_observation_is_fresh(row: &CapacityObservation, now: i64) -> bool {
    row.state == CapacityState::Available
        && row.snapshot_at_ms >= 0
        && row.snapshot_at_ms <= now
        && now - row.snapshot_at_ms <= CAPACITY_MAX_AGE_MS
}
fn headroom(windows: &CapacityWindows) -> Option<f64> {
    [windows.primary.as_ref(), windows.secondary.as_ref()]
        .into_iter()
        .flatten()
        .filter_map(|w| w.used_percent)
        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))
        .map(|n| 100.0 - n)
        .reduce(f64::min)
}
fn label(text: &str) -> String {
    text.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}
pub fn capacity_headroom_for_observation(
    row: &CapacityObservation,
    model: Option<&ModelId>,
) -> Option<f64> {
    let model = model
        .map(crate::routing::model_quota_label)
        .unwrap_or_default();
    if model.is_empty() {
        return headroom(&row.windows);
    }
    let limits: Vec<_> = row
        .additional_rate_limits
        .iter()
        .filter(|limit| label(&limit.limit_name) == model)
        .collect();
    if limits.is_empty() {
        headroom(&row.windows)
    } else {
        limits
            .into_iter()
            .filter_map(|limit| headroom(&limit.windows))
            .reduce(f64::max)
    }
}
pub(crate) fn capacity_for<'a>(
    store: &'a CapacityStore,
    account: &RoutingAccountHash,
    model: &ModelId,
    now: i64,
) -> Option<(&'a CapacityObservation, f64)> {
    let row = store
        .observations
        .iter()
        .filter(|row| &row.account_id_hash == account)
        .max_by_key(|row| row.snapshot_at_ms)?;
    capacity_observation_is_fresh(row, now).then_some(())?;
    Some((row, capacity_headroom_for_observation(row, Some(model))?))
}
pub(crate) fn merge_capacity(
    store: &CapacityStore,
    inputs: &[CapacityObservation],
    now: i64,
) -> CapacityStore {
    let mut merged: Vec<&CapacityObservation> = Vec::new();
    for row in store.observations.iter().chain(inputs) {
        if let Some(prior) = merged
            .iter_mut()
            .find(|prior| prior.account_id_hash == row.account_id_hash)
        {
            if row.snapshot_at_ms >= prior.snapshot_at_ms {
                *prior = row;
            }
        } else {
            merged.push(row);
        }
    }
    // The source merges first, then drops stale/future winners. Filtering inputs
    // first could resurrect an older observation shadowed by a newer row.
    let mut observations: Vec<_> = merged
        .into_iter()
        .filter(|row| {
            row.snapshot_at_ms >= now.saturating_sub(CAPACITY_MAX_AGE_MS).max(0)
                && row.snapshot_at_ms <= now
        })
        .cloned()
        .collect();
    observations.sort_by_key(|row| row.slot);
    CapacityStore {
        v: 1,
        updated_at_ms: now,
        observations,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CapacityObservationStorePlan {
    pub capacity_revision: Option<String>,
    pub capacity: CapacityStore,
}
/// Pure source write plan, not an authority capability or caller-selected write set.
pub fn plan_capacity_observation_store(
    revision: Option<String>,
    store: &CapacityStore,
    inputs: &[CapacityObservation],
    now: i64,
) -> CapacityObservationStorePlan {
    CapacityObservationStorePlan {
        capacity_revision: revision,
        capacity: merge_capacity(store, inputs, now),
    }
}
