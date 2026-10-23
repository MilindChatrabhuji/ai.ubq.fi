//! Source metered-quota.ts monitoring only; this never authorizes a paid request.
use crate::{store, types::ObservabilityHost};
use gateway_core::{
    GatewayError,
    state::{AuthorityStore, RecordKey, RecordMutation},
};
use serde_json::{Value, json};
const HOUR: i64 = 3_600_000;
const FRESH: i64 = 300_000;
const RETENTION: i64 = 86_400_000;
const LEASE: i64 = 15_000;
pub fn key(kind: &str) -> RecordKey {
    store::key(json!(["uos_ai", "metered_quota", "v1", kind]))
}
fn safe(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}
fn counter(v: &Value) -> bool {
    safe(v) && v.as_f64().is_some_and(|n| n >= 0.0)
}
pub fn valid_state(v: &Value) -> bool {
    store::is_record(v)
        && ["current_balance_quota", "post_refill_baseline_quota"]
            .iter()
            .all(|f| safe(&v[f]))
        && [
            "last_observed_used_quota",
            "observed_at_ms",
            "cycle_started_at_ms",
            "last_known_debits_quota",
            "last_inferred_credit_quota",
        ]
        .iter()
        .all(|f| counter(&v[f]))
        && counter(&v["quota_per_credit"])
        && v["quota_per_credit"].as_f64().is_some_and(|n| n > 0.0)
        && matches!(
            v["confidence"].as_str(),
            Some("provisional" | "refill_observed" | "inferred_adjustment")
        )
        && ["last_credit_at_ms", "latest_refill_completed_at_ms"]
            .iter()
            .all(|f| v.get(f).is_some_and(|v| v.is_null() || counter(v)))
        && v.get("latest_refill_id")
            .is_some_and(|v| v.is_null() || v.is_string())
        && v.get("latest_refill_amount_credits")
            .is_some_and(|v| v.is_null() || v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        && v.get("unlimited_quota").is_none_or(Value::is_boolean)
        && ["total_available", "total_granted", "total_used"]
            .iter()
            .all(|f| v.get(f).is_none_or(|v| v.is_null() || safe(v)))
}
pub fn token_usage_state(envelope: &Value, at: i64) -> Result<Value, GatewayError> {
    let data = &envelope["data"];
    if envelope["success"] != true
        || !store::is_record(data)
        || !data["unlimited_quota"].is_boolean()
        || !["total_available", "total_granted", "total_used"]
            .iter()
            .all(|f| safe(&data[f]))
        || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&at)
    {
        return Err(store::error(
            "Metered account API returned invalid token usage data",
        ));
    }
    Ok(
        json!({"current_balance_quota":0,"post_refill_baseline_quota":0,"last_observed_used_quota":0,"quota_per_credit":1,"observed_at_ms":at,"cycle_started_at_ms":at,"confidence":"provisional","last_known_debits_quota":0,"last_inferred_credit_quota":0,"last_credit_at_ms":null,"latest_refill_id":null,"latest_refill_amount_credits":null,"latest_refill_completed_at_ms":null,"unlimited_quota":data["unlimited_quota"],"total_available":data["total_available"],"total_granted":data["total_granted"],"total_used":data["total_used"]}),
    )
}
pub fn snapshot_view(state: &Value, cache: &str) -> Value {
    let token = [
        "unlimited_quota",
        "total_available",
        "total_granted",
        "total_used",
    ]
    .iter()
    .any(|f| state.get(f).is_some());
    let credit = state["quota_per_credit"].as_f64().unwrap_or(1.0);
    let current = state["current_balance_quota"].as_f64().unwrap_or(0.0);
    let baseline = state["post_refill_baseline_quota"].as_f64().unwrap_or(0.0);
    let remaining =
        (!token && baseline > 0.0).then(|| (current / baseline * 100.0).clamp(0.0, 100.0));
    let mut value = json!({"state":state,"cache_state":cache,"balance_credits":(!token).then_some(current/credit),"baseline_credits":(!token).then_some(baseline/credit),"last_inferred_credit_credits":(!token).then(||state["last_inferred_credit_quota"].as_f64().unwrap_or(0.0)/credit),"remaining_percent":remaining,"used_percent":remaining.map(|v|100.0-v),"unlimited_quota":token&&state["unlimited_quota"]==true});
    for name in ["total_available", "total_granted", "total_used"] {
        value[name] = if token && state[name].is_number() {
            state[name].clone()
        } else {
            Value::Null
        }
    }
    value
}
/// Source getMeteredQuotaDiagnostics, separate from the internal snapshot envelope.
pub fn diagnostics(configured: bool, snapshot: Option<&Value>) -> Value {
    let mut result = json!({"configured":configured,"available":false});
    for name in [
        "cache_state",
        "confidence",
        "balance_credits",
        "baseline_credits",
        "remaining_percent",
        "used_percent",
        "observed_at_ms",
        "cycle_started_at_ms",
        "last_known_debits_credits",
        "last_inferred_credit_credits",
        "last_credit_at_ms",
        "latest_refill_id",
        "latest_refill_amount_credits",
        "latest_refill_completed_at_ms",
        "unlimited_quota",
        "total_available",
        "total_granted",
        "total_used",
    ] {
        result[name] = Value::Null;
    }
    let Some(snapshot) = snapshot.filter(|_| configured) else {
        return result;
    };
    let state = &snapshot["state"];
    let token_usage = snapshot["unlimited_quota"] == true
        || !snapshot["total_available"].is_null()
        || !snapshot["total_used"].is_null();
    result["available"] = json!(true);
    for name in [
        "cache_state",
        "balance_credits",
        "baseline_credits",
        "remaining_percent",
        "used_percent",
        "last_inferred_credit_credits",
        "unlimited_quota",
        "total_available",
        "total_granted",
        "total_used",
    ] {
        result[name] = snapshot[name].clone();
    }
    for name in [
        "observed_at_ms",
        "latest_refill_id",
        "latest_refill_amount_credits",
        "latest_refill_completed_at_ms",
    ] {
        result[name] = state[name].clone();
    }
    if !token_usage {
        for name in ["confidence", "cycle_started_at_ms", "last_credit_at_ms"] {
            result[name] = state[name].clone();
        }
        result["last_known_debits_credits"] = match (
            state["last_known_debits_quota"].as_f64(),
            state["quota_per_credit"].as_f64(),
        ) {
            (Some(debits), Some(credit)) => json!(debits / credit),
            _ => Value::Null,
        };
    }
    result
}
async fn retained<S: AuthorityStore>(store: &S, at: i64) -> Result<Option<Value>, GatewayError> {
    let row = store.read(&key("state")).await?;
    Ok(store::value(row.as_ref(), at)?
        .filter(|v| {
            valid_state(v)
                && v["observed_at_ms"]
                    .as_f64()
                    .is_some_and(|t| at as f64 - t < RETENTION as f64)
        })
        .cloned())
}
fn invalidated(state: &Value, invalidation: Option<&Value>) -> bool {
    invalidation.is_some_and(|v| {
        counter(&v["invalidated_at_ms"])
            && v["invalidated_at_ms"].as_f64() >= state["observed_at_ms"].as_f64()
    })
}
pub async fn cached_snapshot<S: AuthorityStore>(
    store: &S,
    at: i64,
) -> Result<Option<Value>, GatewayError> {
    let (state, invalidation) =
        futures_util::future::join(retained(store, at), store.read(&key("invalidation"))).await;
    let Some(state) = state? else { return Ok(None) };
    let invalidation = invalidation?;
    let fresh = !invalidated(&state, store::value(invalidation.as_ref(), at)?)
        && state["observed_at_ms"]
            .as_f64()
            .is_some_and(|t| at as f64 - t < FRESH as f64);
    Ok(Some(snapshot_view(
        &state,
        if fresh { "fresh" } else { "stale" },
    )))
}
async fn release<S: AuthorityStore, H: ObservabilityHost>(
    store: &S,
    host: &H,
    owner: &str,
) -> Result<(), GatewayError> {
    let key = key("refresh_lease");
    let row = store.read(&key).await?;
    if store::value(row.as_ref(), store::now(host)?)?.is_some_and(|v| v["owner"] == owner) {
        let _ = store::commit(
            store,
            vec![store::check(&key, row.as_ref())],
            vec![RecordMutation::Delete { key }],
        )
        .await?;
    }
    Ok(())
}
pub async fn quota_snapshot<S: AuthorityStore, H: ObservabilityHost>(
    store: &S,
    host: &H,
    force: bool,
    deadline: i64,
) -> Result<Option<Value>, GatewayError> {
    let at = store::now(host)?;
    let cached = retained(store, at).await.unwrap_or(None);
    let ik = key("invalidation");
    let invalidation = store.read(&ik).await.ok().flatten();
    if !force
        && cached.as_ref().is_some_and(|v| {
            !invalidated(v, store::value(invalidation.as_ref(), at).ok().flatten())
                && v["observed_at_ms"]
                    .as_f64()
                    .is_some_and(|t| at as f64 - t < FRESH as f64)
        })
    {
        return Ok(cached.as_ref().map(|s| snapshot_view(s, "fresh")));
    }
    let owner = store::uuid(host)?;
    let lk = key("refresh_lease");
    let lease = store.read(&lk).await.ok().flatten();
    let occupied = store::value(lease.as_ref(), at)
        .ok()
        .flatten()
        .is_some_and(|v| v["lease_until_ms"].as_f64().is_some_and(|t| t > at as f64));
    let acquired = if occupied {
        false
    } else {
        store::commit(
            store,
            vec![store::check(&lk, lease.as_ref())],
            vec![store::put(
                host,
                lk.clone(),
                json!({"owner":owner,"lease_until_ms":at+LEASE}),
                Some(at + LEASE * 2),
            )?],
        )
        .await
        .unwrap_or(false)
    };
    if !acquired {
        if let Some(cached) = cached.as_ref() {
            return Ok(Some(snapshot_view(cached, "stale")));
        }
        let until = (at + 2000).min(deadline);
        while store::now(host)? < until {
            host.wait_ms(50).await?;
            if let Some(state) = retained(store, store::now(host)?).await.unwrap_or(None) {
                return Ok(Some(snapshot_view(&state, "wait")));
            }
        }
        return Ok(None);
    }
    let result = async {
        let sk = key("state");
        let (state_row, invalidation_row) =
            futures_util::future::join(store.read(&sk), store.read(&ik)).await;
        let state_row = state_row?;
        let invalidation_row = invalidation_row?;
        let envelope = host.fetch_metered_quota(deadline).await?;
        let observed = store::now(host)?;
        let state = token_usage_state(&envelope, observed)?;
        let lease = store.read(&lk).await?;
        let valid = store::value(lease.as_ref(), observed)?.is_some_and(|v| {
            v["owner"] == owner
                && v["lease_until_ms"]
                    .as_f64()
                    .is_some_and(|t| t > observed as f64)
        });
        if !valid {
            return Ok(None);
        }
        let committed = store::commit(
            store,
            vec![
                store::check(&sk, state_row.as_ref()),
                store::check(&ik, invalidation_row.as_ref()),
                store::check(&lk, lease.as_ref()),
            ],
            vec![
                store::put(host, sk, state.clone(), Some(observed + RETENTION))?,
                RecordMutation::Delete { key: ik.clone() },
                RecordMutation::Delete { key: lk.clone() },
            ],
        )
        .await?;
        if !committed {
            return Ok(None);
        }
        if let Ok(Some(fingerprint)) = host.metered_balance_fingerprint().await {
            let _ = balance_sample(store, host, &state, observed, &fingerprint).await;
        }
        Ok::<_, GatewayError>(Some(snapshot_view(&state, "refreshed")))
    }
    .await;
    let _ = release(store, host, &owner).await;
    match result {
        Ok(Some(value)) => Ok(Some(value)),
        Err(error)
            if error.envelope.error.code.as_deref() == Some("observability_request_cancelled") =>
        {
            Err(error)
        }
        _ => Ok(retained(store, store::now(host)?)
            .await
            .unwrap_or(None)
            .or(cached)
            .as_ref()
            .map(|s| snapshot_view(s, "stale"))),
    }
}
pub async fn balance_sample<S: AuthorityStore, H: ObservabilityHost>(
    store: &S,
    host: &H,
    state: &Value,
    at: i64,
    fingerprint: &str,
) -> Result<(), GatewayError> {
    if !valid_state(state) || at < 0 {
        return Ok(());
    }
    let bucket = at / HOUR * HOUR;
    let key = store::key(json!([
        "uos_ai",
        "metered_quota",
        "v1",
        "balance_history",
        fingerprint,
        bucket
    ]));
    let snapshot = snapshot_view(state, "fresh");
    let mut point = json!({"v":1,"bucket_start_at_ms":bucket,"observed_at_ms":at,"balance_quota":state["current_balance_quota"],"baseline_quota":state["post_refill_baseline_quota"],"quota_per_credit":state["quota_per_credit"],"remaining_percent":snapshot["remaining_percent"]});
    if [
        "unlimited_quota",
        "total_available",
        "total_granted",
        "total_used",
    ]
    .iter()
    .any(|f| state.get(f).is_some())
    {
        for name in [
            "unlimited_quota",
            "total_available",
            "total_granted",
            "total_used",
        ] {
            point[name] = snapshot[name].clone()
        }
    }
    for _ in 0..3 {
        let row = store.read(&key).await?;
        if store::value(row.as_ref(), at)?
            .filter(|v| crate::api::valid_balance_sample(v))
            .is_some_and(|v| v["observed_at_ms"].as_f64().is_some_and(|n| n >= at as f64))
        {
            return Ok(());
        }
        if store::commit(
            store,
            vec![store::check(&key, row.as_ref())],
            vec![store::put(host, key.clone(), point.clone(), None)?],
        )
        .await?
        {
            return Ok(());
        }
    }
    Err(store::error(
        "Metered quota balance history changed repeatedly",
    ))
}
