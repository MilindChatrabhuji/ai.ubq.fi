use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    capacity_events::{event_key, valid_event},
    capacity_math, capacity_shapes as shape, store,
};
use gateway_core::{
    GatewayError,
    query::{QuerySelector, QueryStore},
    state::{RecordKey, RecordMutation, StoredRecord},
};
use serde_json::{Value, json};
pub(crate) fn key(name: &str) -> RecordKey {
    store::key(json!(["uos_ai", "provider_capacity", "v1", name]))
}
fn history_key(point: &Value) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "provider_capacity",
        "v1",
        "history",
        point["bucket_start_at_ms"]
    ]))
}
fn available_key(slot: u8) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "provider_capacity",
        "v1",
        "last_available",
        slot
    ]))
}
fn observation(value: &Value) -> Option<Value> {
    let at = store::safe_i64(&value["sampled_at_ms"])?;
    let source = shape::read_codex(&value["source"], at)?;
    (source["state"] == "available")
        .then(|| json!({"sampled_at_ms":value["sampled_at_ms"],"source":source}))
}
pub(crate) fn valid_rollup(v: &Value) -> bool {
    if v["v"] != 1
        || store::safe_i64(&v["bucket_start_at_ms"]).is_none_or(|t| t % shape::HOUR_MS != 0)
        || ["sample_count", "first_sampled_at_ms", "last_sampled_at_ms"]
            .iter()
            .any(|f| store::safe_i64(&v[f]).is_none())
        || store::safe_i64(&v["first_sampled_at_ms"]) > store::safe_i64(&v["last_sampled_at_ms"])
    {
        return false;
    }
    let Some(slots) = v["slots"].as_array().filter(|a| a.len() == 2) else {
        return false;
    };
    for (index, slot) in slots.iter().enumerate() {
        if store::safe_i64(&slot["slot"]) != Some(index as i64 + 1)
            || !matches!(
                slot["last_state"].as_str(),
                Some("available" | "stale" | "unavailable")
            )
            || store::safe_i64(&slot["available_sample_count"]).is_none()
            || store::safe_i64(&slot["available_sample_count"])
                > store::safe_i64(&v["sample_count"])
        {
            return false;
        }
        for name in ["primary", "secondary"] {
            let w = &slot[name];
            if store::safe_i64(&w["samples"]).is_none() {
                return false;
            }
            for name in ["limit_window_seconds", "last_reset_at_ms"] {
                if !w
                    .get(name)
                    .is_some_and(|v| v.is_null() || store::safe_i64(v).is_some())
                {
                    return false;
                }
            }
            for name in ["min_used_percent", "max_used_percent", "last_used_percent"] {
                if !w.get(name).is_some_and(|v| {
                    v.is_null() || v.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n))
                }) {
                    return false;
                }
            }
        }
    }
    true
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub(crate) async fn read_capacity_snapshot(
        &self,
        at: i64,
    ) -> Result<Option<Value>, GatewayError> {
        let row = self.store.read(&key("snapshot")).await?;
        Ok(store::value(row.as_ref(), at)?.and_then(shape::read_snapshot))
    }
    pub async fn capacity_history(&self, at: i64) -> Result<Vec<Value>, GatewayError> {
        let cutoff = (at - shape::RETENTION_MS).max(0);
        let newest = at / shape::BUCKET_MS * shape::BUCKET_MS;
        let mut out = Vec::new();
        for entry in store::scan(self.store.as_ref(), key("history"), false, at, usize::MAX).await?
        {
            let p = store::parts(&entry.key)?;
            let Some(bucket) = p.get(4).and_then(store::safe_i64) else {
                continue;
            };
            if bucket < cutoff || bucket > newest {
                continue;
            }
            if let Some(point) = shape::read_history(entry.record.json_value()?)
                && store::safe_i64(&point["bucket_start_at_ms"]) == Some(bucket)
            {
                out.push(point)
            }
        }
        out.sort_by_key(|p| {
            (
                store::safe_i64(&p["bucket_start_at_ms"]),
                store::safe_i64(&p["sampled_at_ms"]),
            )
        });
        Ok(out)
    }
    pub(crate) async fn acquire_capacity_lease(
        &self,
        owner: &str,
        at: i64,
    ) -> Result<Option<StoredRecord>, GatewayError> {
        let key = key("lease");
        let row = self.store.read(&key).await?;
        if store::value(row.as_ref(), at)?
            .is_some_and(|v| v["lease_until_ms"].as_f64().is_some_and(|t| t > at as f64))
        {
            return Ok(None);
        }
        let lease = json!({"owner":owner,"lease_until_ms":at+10000});
        if !store::commit(
            self.store.as_ref(),
            vec![store::check(&key, row.as_ref())],
            vec![store::put(
                self.host.as_ref(),
                key.clone(),
                lease,
                Some(at + 20000),
            )?],
        )
        .await?
        {
            return Ok(None);
        }
        let acquired = self.store.read(&key).await?;
        Ok(acquired.filter(|r| r.json_value().ok().is_some_and(|v| v["owner"] == owner)))
    }
    pub(crate) async fn release_capacity_lease(&self, owner: &str) {
        let release = async {
            let key = key("lease");
            let row = self.store.read(&key).await?;
            if row
                .as_ref()
                .and_then(|r| r.json_value().ok())
                .is_none_or(|v| v["owner"] != owner)
            {
                return Ok(());
            }
            store::commit(
                self.store.as_ref(),
                vec![store::check(&key, row.as_ref())],
                vec![RecordMutation::Delete { key }],
            )
            .await?;
            Ok(())
        }
        .await;
        let _: Result<(), GatewayError> = release;
    }
    pub(crate) async fn wait_capacity_snapshot(
        &self,
        previous: Option<i64>,
    ) -> Result<Option<Value>, GatewayError> {
        let deadline = store::now(self.host.as_ref())? + 2000;
        while store::now(self.host.as_ref())? < deadline {
            self.host.wait_ms(50).await?;
            // Deliberately ordered: a released lease must precede the corresponding snapshot read.
            let lease = self.store.read(&key("lease")).await.ok().flatten();
            let snapshot = self
                .read_capacity_snapshot(store::now(self.host.as_ref())?)
                .await
                .ok()
                .flatten();
            if snapshot.as_ref().is_some_and(|s| {
                previous.is_none() || store::safe_i64(&s["snapshot_at_ms"]) != previous
            }) {
                return Ok(snapshot);
            }
            if lease.is_none() {
                return Ok(snapshot);
            }
        }
        Ok(None)
    }
    pub(crate) async fn persist_capacity_snapshot(
        &self,
        lease: &StoredRecord,
        snapshot: &Value,
    ) -> Result<bool, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let point = shape::history_point(snapshot);
        let history = history_key(&point);
        let snapshot_key = key("snapshot");
        let old_snapshot = self.store.read(&snapshot_key).await?;
        let old_point = self.store.read(&history).await?;
        let mut last = Vec::new();
        for slot in [1, 2] {
            let row = self.store.read(&available_key(slot)).await?;
            if let Some(v) = store::value(row.as_ref(), at)?.and_then(observation) {
                last.push(v)
            }
        }
        let previous = store::value(old_snapshot.as_ref(), at)?.and_then(shape::read_snapshot);
        let previous_history = store::value(old_point.as_ref(), at)?.and_then(shape::read_history);
        let recover: Vec<u8> = [1, 2]
            .into_iter()
            .filter(|slot| {
                let now = shape::source(snapshot, *slot);
                let before = previous.as_ref().and_then(|p| shape::source(p, *slot));
                now.zip(before).is_some_and(|(n, b)| {
                    n["state"] != "unavailable"
                        && b["state"] == "unavailable"
                        && capacity_math::same_cohort(b, n)
                        && !last.iter().any(|v| {
                            v["source"]["slot"] == *slot
                                && capacity_math::same_cohort(&v["source"], n)
                        })
                })
            })
            .collect();
        if !recover.is_empty() {
            let retained = self.capacity_history(at).await.unwrap_or_default();
            for slot in recover {
                let Some(current) = shape::source(snapshot, slot) else {
                    continue;
                };
                let candidate = retained
                    .iter()
                    .filter(|p| {
                        store::safe_i64(&p["sampled_at_ms"])
                            < store::safe_i64(&snapshot["snapshot_at_ms"])
                    })
                    .filter_map(|p| {
                        shape::source(p, slot)
                            .filter(|s| {
                                s["state"] != "unavailable"
                                    && capacity_math::same_cohort(s, current)
                            })
                            .map(|s| json!({"sampled_at_ms":p["sampled_at_ms"],"source":s}))
                    })
                    .max_by_key(|v| store::safe_i64(&v["sampled_at_ms"]));
                if let Some(v) = candidate {
                    last.push(v)
                }
            }
        }
        let events = capacity_math::rate_limit_events(previous.as_ref(), snapshot, &last);
        let preserve = !events.is_empty()
            || previous_history
                .as_ref()
                .is_some_and(|p| capacity_math::preserve_transition(p, &point));
        let bucket = store::safe_i64(&point["bucket_start_at_ms"])
            .expect("validated source bucket")
            / shape::HOUR_MS
            * shape::HOUR_MS;
        let rollup_key = store::key(json!([
            "uos_ai",
            "provider_capacity",
            "v1",
            "rollup",
            bucket
        ]));
        let rollup = self.store.read(&rollup_key).await.ok();
        let mut checks = vec![store::check(&key("lease"), Some(lease))];
        let expiry = Some(at + shape::RETENTION_MS);
        let mut writes = vec![store::put(
            self.host.as_ref(),
            snapshot_key,
            snapshot.clone(),
            expiry,
        )?];
        for event in events {
            writes.push(store::put(
                self.host.as_ref(),
                event_key(
                    "rate_limit_reset_event",
                    event["event_id"].as_str().expect("source event ID"),
                ),
                event,
                expiry,
            )?)
        }
        for slot in [1, 2] {
            if let Some(source) =
                shape::source(snapshot, slot).filter(|s| s["state"] == "available")
            {
                writes.push(store::put(
                    self.host.as_ref(),
                    available_key(slot),
                    json!({"sampled_at_ms":snapshot["snapshot_at_ms"],"source":source}),
                    expiry,
                )?);
            }
        }
        if let Some(rollup) = rollup {
            let v = store::value(rollup.as_ref(), at)
                .ok()
                .flatten()
                .filter(|v| valid_rollup(v));
            checks.push(store::check(&rollup_key, rollup.as_ref()));
            writes.push(store::put(
                self.host.as_ref(),
                rollup_key,
                capacity_math::merge_rollup(v, &point),
                None,
            )?);
        }
        if preserve && let Some(old) = previous_history {
            writes.push(store::put(
                self.host.as_ref(),
                store::key(json!([
                    "uos_ai",
                    "provider_capacity",
                    "v1",
                    "history",
                    point["bucket_start_at_ms"],
                    "transition",
                    old["sampled_at_ms"]
                ])),
                old,
                expiry,
            )?);
        }
        writes.push(store::put(self.host.as_ref(), history, point, expiry)?);
        writes.push(RecordMutation::Delete { key: key("lease") });
        store::commit(self.store.as_ref(), checks, writes).await
    }
    pub(crate) async fn historical_rate_limit_events(
        &self,
        history: &[Value],
        events: Vec<Value>,
        at: i64,
    ) -> Result<Vec<Value>, GatewayError> {
        let mut merged: std::collections::BTreeMap<String, Value> = events
            .into_iter()
            .filter_map(|v| Some((v["event_id"].as_str()?.to_owned(), v.clone())))
            .collect();
        let mut ordered = history.to_vec();
        ordered.sort_by_key(|p| store::safe_i64(&p["sampled_at_ms"]));
        for slot in [1, 2] {
            let mut previous: Option<Value> = None;
            let mut outage = false;
            for point in &ordered {
                let source = shape::source(point, slot);
                if source.is_none_or(|s| s["state"] == "unavailable") {
                    if previous
                        .as_ref()
                        .zip(source)
                        .is_some_and(|(p, s)| capacity_math::same_cohort(&p["source"], s))
                    {
                        outage = true
                    } else {
                        previous = None;
                        outage = false
                    }
                    continue;
                }
                let source = source.expect("present source");
                if let Some(ref p) = previous
                    && outage
                    && capacity_math::same_cohort(&p["source"], source)
                {
                    let current =
                        json!({"snapshot_at_ms":point["sampled_at_ms"],"sources":[source]});
                    for event in
                        capacity_math::rate_limit_events(None, &current, std::slice::from_ref(p))
                    {
                        let id = event["event_id"].as_str().unwrap_or("").to_owned();
                        if let std::collections::btree_map::Entry::Vacant(entry) =
                            merged.entry(id.clone())
                        {
                            let _ = store::commit(
                                self.store.as_ref(),
                                Vec::new(),
                                vec![store::put(
                                    self.host.as_ref(),
                                    event_key("rate_limit_reset_event", &id),
                                    event.clone(),
                                    Some(at + shape::RETENTION_MS),
                                )?],
                            )
                            .await;
                            entry.insert(event);
                        }
                    }
                }
                if source["state"] == "available" {
                    previous =
                        Some(json!({"sampled_at_ms":point["sampled_at_ms"],"source":source}));
                }
                outage = false;
            }
        }
        let mut out: Vec<Value> = merged
            .into_values()
            .filter(|v| valid_event("rate_limit_reset_event", v))
            .collect();
        let mut error = None;
        out.sort_by(|a, b| {
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
        Ok(out)
    }
    pub async fn capacity_rollup_points(
        &self,
        since: i64,
        at: i64,
    ) -> Result<Vec<Value>, GatewayError> {
        let first = since.max(0) / shape::HOUR_MS * shape::HOUR_MS;
        let last = at.max(since) / shape::HOUR_MS * shape::HOUR_MS;
        let selector = QuerySelector::Range {
            start: store::key(json!([
                "uos_ai",
                "provider_capacity",
                "v1",
                "rollup",
                first
            ])),
            end: store::key(json!([
                "uos_ai",
                "provider_capacity",
                "v1",
                "rollup",
                last + shape::HOUR_MS
            ])),
        };
        let mut rows = Vec::new();
        for entry in store::scan_selector(self.store.as_ref(), selector, false, at, 20000).await? {
            let v = entry.record.json_value()?;
            if valid_rollup(v)
                && store::safe_i64(&v["bucket_start_at_ms"])
                    .is_some_and(|t| t >= first && t <= last)
            {
                rows.push(v.clone())
            }
        }
        rows.sort_by_key(|v| store::safe_i64(&v["bucket_start_at_ms"]));
        Ok(rows)
    }
}
