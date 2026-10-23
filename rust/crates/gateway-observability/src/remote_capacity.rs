//! Source analytics-only chart observations. These keys never enter routing/reset state.
use crate::capacity_math::bucketed;
use crate::capacity_shapes::{BUCKET_MS, RETENTION_MS, read_history};
use crate::store;
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use gateway_admin_runtime::capabilities::Context;
use gateway_auth::AuthResponse;
use gateway_core::{GatewayError, query::QueryStore};
use serde_json::{Value, json};
use std::collections::BTreeMap;
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
fn host_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b == b'-'))
}
pub fn parse_observations(value: &Value) -> Option<Vec<Value>> {
    let values = value
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 512)?;
    let mut points = Vec::with_capacity(values.len());
    for value in values {
        let point = read_history(value)?;
        if !bucketed(&point) || gateway_schema::util::json_stringify(&point).len() > 16 * 1024 {
            return None;
        }
        points.push(point)
    }
    Some(points)
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    /// Consume actual original request bytes; a caller-supplied count cannot prove the limit.
    pub async fn capacity_observation_response(
        &self,
        raw_body: &[u8],
        _context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        if raw_body.len() > MAX_BODY_BYTES {
            return Err(GatewayError::new(
                413,
                "Capacity observation payload too large",
                Some("invalid_request_error"),
            ));
        }
        let document: Value = serde_json::from_slice(raw_body)
            .map_err(|_| store::invalid("Invalid capacity observation envelope"))?;
        if !document.is_object() {
            return Err(store::invalid("Invalid capacity observation envelope"));
        }
        let host = document["host"]
            .as_str()
            .filter(|s| host_id(s))
            .ok_or_else(|| store::invalid("Invalid capacity observation host"))?;
        let points = parse_observations(&document["history"])
            .ok_or_else(|| store::invalid("Invalid capacity observations"))?;
        let at = store::now(self.host.as_ref())?;
        let mut indexes = BTreeMap::new();
        let mut accepted: Vec<Value> = Vec::new();
        for point in points {
            let bucket = store::safe_i64(&point["bucket_start_at_ms"]).expect("source bucket");
            if bucket < (at - RETENTION_MS).max(0) || bucket > at + BUCKET_MS {
                continue;
            }
            let sample = store::safe_i64(&point["sampled_at_ms"]).expect("source sample");
            if let Some(index) = indexes.get(&(bucket, sample)).copied() {
                accepted[index] = point
            } else {
                indexes.insert((bucket, sample), accepted.len());
                accepted.push(point)
            }
        }
        let points = accepted;
        for batch in points.chunks(64) {
            let mut writes = Vec::new();
            let expiry = store::now(self.host.as_ref())? + RETENTION_MS;
            for point in batch {
                let key = store::key(json!([
                    "uos_ai",
                    "provider_capacity",
                    "analytics",
                    "remote",
                    host,
                    point["bucket_start_at_ms"],
                    point["sampled_at_ms"]
                ]));
                writes.push(store::put(
                    self.host.as_ref(),
                    key,
                    point.clone(),
                    Some(expiry),
                )?);
            }
            match store::commit(self.store.as_ref(), Vec::new(), writes).await {
                Ok(true) => {}
                _ => {
                    return Err(GatewayError::unavailable(
                        "Capacity observation storage unavailable",
                        "server_error",
                    ));
                }
            }
        }
        Ok(AuthResponse::json(
            200,
            json!({"accepted":points.len(),"host":host}),
        ))
    }
    pub async fn remote_capacity_observations(
        &self,
        at: i64,
    ) -> Result<Vec<(String, Value)>, GatewayError> {
        let prefix = store::key(json!([
            "uos_ai",
            "provider_capacity",
            "analytics",
            "remote"
        ]));
        let mut out = Vec::new();
        for entry in store::scan(self.store.as_ref(), prefix, false, at, usize::MAX).await? {
            let p = store::parts(&entry.key)?;
            let Some(host) = p.get(4).and_then(Value::as_str).filter(|s| host_id(s)) else {
                continue;
            };
            let Some(point) = read_history(entry.record.json_value()?).filter(bucketed) else {
                continue;
            };
            let Some(bucket) = store::safe_i64(&point["bucket_start_at_ms"]) else {
                continue;
            };
            if bucket < (at - RETENTION_MS).max(0) || bucket > at + BUCKET_MS {
                continue;
            }
            out.push((host.to_owned(), point));
        }
        let mut error = None;
        out.sort_by(|(ah, a), (bh, b)| {
            store::safe_i64(&a["sampled_at_ms"])
                .cmp(&store::safe_i64(&b["sampled_at_ms"]))
                .then_with(|| {
                    store::safe_i64(&a["bucket_start_at_ms"])
                        .cmp(&store::safe_i64(&b["bucket_start_at_ms"]))
                })
                .then_with(|| match self.host.compare_labels(ah, bh) {
                    Ok(order) => order,
                    Err(e) => {
                        error = Some(e);
                        std::cmp::Ordering::Equal
                    }
                })
        });
        if let Some(error) = error {
            return Err(error);
        }
        Ok(out)
    }
}
