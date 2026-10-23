//! Finite admin adapters. Pure projections read the one source-compatible QueryStore.
use crate::{ObservabilityRuntime, store, types::ObservabilityHost};
use gateway_admin_runtime::capabilities::{AnalyticsRequest, Context, ProviderRequest};
use gateway_auth::AuthResponse;
use gateway_core::{
    GatewayError,
    query::{QuerySelector, QueryStore},
    source_json::SourceJson,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
const HOUR: i64 = 3_600_000;
fn signed_safe(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}
pub fn valid_usage_rollup(v: &Value) -> bool {
    gateway_core::source_json::SourceJson::from_serializable(v)
        .is_ok_and(|document| crate::records::valid_usage_rollup_source(&document))
}

pub fn valid_balance_sample(v: &Value) -> bool {
    v["v"] == 1
        && store::safe_i64(&v["bucket_start_at_ms"]).is_some()
        && store::safe_i64(&v["observed_at_ms"]).is_some()
        && signed_safe(&v["balance_quota"])
        && signed_safe(&v["baseline_quota"])
        && store::safe_i64(&v["quota_per_credit"]).is_some_and(|n| n > 0)
        && v.get("remaining_percent")
            .is_some_and(|v| v.is_null() || v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        && v.get("unlimited_quota").is_none_or(Value::is_boolean)
        && ["total_available", "total_granted", "total_used"]
            .iter()
            .all(|f| v.get(f).is_none_or(|v| v.is_null() || signed_safe(v)))
}
pub fn resample_balance(samples: &[Value], bucket: i64, limit: usize) -> Vec<Value> {
    if bucket <= 0 || limit == 0 {
        return Vec::new();
    }
    let mut buckets: BTreeMap<i64, Value> = BTreeMap::new();
    for sample in samples {
        let Some(at) = store::safe_i64(&sample["observed_at_ms"]) else {
            continue;
        };
        let start = at / bucket * bucket;
        let current = buckets.get(&start);
        if current.is_none_or(|p| {
            store::safe_i64(&sample["observed_at_ms"]) > store::safe_i64(&p["observed_at_ms"])
                || (sample["observed_at_ms"] == p["observed_at_ms"]
                    && store::safe_i64(&sample["bucket_start_at_ms"])
                        > store::safe_i64(&p["bucket_start_at_ms"]))
        }) {
            let mut point = sample.clone();
            point["bucket_start_at_ms"] = json!(start);
            buckets.insert(start, point);
        }
    }
    let skip = buckets.len().saturating_sub(limit);
    buckets.into_values().skip(skip).collect()
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    /// Source /admin/errors runs one request-owned retention pass; failure is diagnostic only.
    pub async fn error_retention_diagnostics(&self) -> Value {
        self.maintain_replays(crate::replay_retention_schema::RetentionLimits::default())
            .await
            .unwrap_or_else(|_| {
                json!({
                    "state":"unavailable", "scope":"capture_owned_kv_payload",
                    "budget_bytes":null, "stored_bytes":null, "reserved_bytes":null,
                    "records":null, "metadata_bytes":null, "status_records":null,
                    "evicted_records":null, "evicted_bytes":null, "expired_records":null,
                    "last_eviction_at_ms":null, "last_warning_at_ms":null,
                    "over_budget":false, "near_capacity":false, "accounting_complete":false,
                    "accounting_error":"unavailable", "skipped_reason":null,
                })
            })
    }
    pub async fn provider(
        &self,
        request: ProviderRequest,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        match request {
            ProviderRequest::Inventory => self.passive_provider_response(true, context).await,
            ProviderRequest::PassiveHealth => self.passive_provider_response(false, context).await,
            ProviderRequest::UpstreamHealth => self.upstream_health_response().await,
            ProviderRequest::Capacity { live } => self.capacity_response(live, context).await,
            ProviderRequest::Observations { document } => {
                let raw = self.host.capacity_observation_body(&context).await?;
                if raw.len() > crate::remote_capacity::MAX_BODY_BYTES {
                    return Err(GatewayError::new(
                        413,
                        "Capacity observation payload too large",
                        Some("invalid_request_error"),
                    ));
                }
                // Same Request.text()/TextDecoder boundary as the authoritative AdminInput:
                // replace malformed UTF8 and consume exactly one leading UTF8 BOM.
                let bytes = raw.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&raw);
                let decoded = String::from_utf8_lossy(bytes);
                if SourceJson::parse(&decoded).ok().as_ref() != Some(&document) {
                    return Err(store::invalid(
                        "Capacity observations do not match the request-bound body",
                    ));
                }
                self.capacity_observation_response(&raw, context).await
            }
            ProviderRequest::Rollups { query } => {
                let days = query
                    .get("window_days")
                    .and_then(|a| a.first())
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(90);
                self.capacity_rollups_response(days).await
            }
        }
    }
    pub async fn paid_usage_rollups(
        &self,
        since: i64,
        at: i64,
    ) -> Result<Vec<SourceJson>, GatewayError> {
        let prefix = json!(["uos_ai", "paid_fallback", "v3", "usage_rollup"]);
        let mut start = prefix.as_array().expect("source tuple").clone();
        start.push(json!(since.max(0) / HOUR * HOUR));
        let mut end = prefix.as_array().expect("source tuple").clone();
        end.push(json!(at + HOUR));
        let entries = store::scan_selector(
            self.store.as_ref(),
            QuerySelector::Range {
                start: store::key(json!(start)),
                end: store::key(json!(end)),
            },
            false,
            at,
            usize::MAX,
        )
        .await?;
        Ok(entries
            .into_iter()
            .filter_map(|e| crate::records::usage_rollup_record_source(&e.record).ok())
            .collect())
    }
    pub async fn balance_history(
        &self,
        since: i64,
        at: i64,
        fingerprint: Option<&str>,
    ) -> Result<Vec<Value>, GatewayError> {
        let Some(fingerprint) = fingerprint else {
            return Ok(Vec::new());
        };
        let since = since.max(0);
        let at = at.max(since);
        let base = json!([
            "uos_ai",
            "metered_quota",
            "v1",
            "balance_history",
            fingerprint
        ]);
        let mut start = base.as_array().expect("source tuple").clone();
        let mut end = start.clone();
        start.push(json!(since / HOUR * HOUR));
        end.push(json!(at / HOUR * HOUR + HOUR));
        let entries = store::scan_selector(
            self.store.as_ref(),
            QuerySelector::Range {
                start: store::key(json!(start)),
                end: store::key(json!(end)),
            },
            false,
            at,
            10000,
        )
        .await?;
        let mut points: Vec<Value> = entries
            .into_iter()
            .filter_map(|e| {
                e.record
                    .json_value()
                    .ok()
                    .filter(|v| {
                        valid_balance_sample(v)
                            && store::safe_i64(&v["observed_at_ms"])
                                .is_some_and(|t| t >= since && t <= at)
                    })
                    .cloned()
            })
            .collect();
        points.sort_by_key(|v| store::safe_i64(&v["bucket_start_at_ms"]));
        Ok(points)
    }
    pub async fn quota_projection_response(
        &self,
        window_days: u32,
        balance_window_days: u32,
    ) -> Result<AuthResponse, GatewayError> {
        let days = if [7, 30, 90].contains(&window_days) {
            window_days
        } else {
            30
        };
        let balance_days = if [7, 30, 90, 365].contains(&balance_window_days) {
            balance_window_days
        } else {
            7
        };
        let at = store::now(self.host.as_ref())?;
        let fingerprint = self
            .host
            .metered_balance_fingerprint()
            .await
            .unwrap_or(None);
        let (snapshot, (rollups, (history, growth))) = futures_util::future::join(
            self.host.metered_quota_snapshot(false, at + 10000),
            futures_util::future::join(
                self.paid_usage_rollups(at - i64::from(days) * store::DAY, at),
                futures_util::future::join(
                    self.balance_history(
                        at - i64::from(balance_days) * store::DAY,
                        at,
                        fingerprint.as_deref(),
                    ),
                    self.ledger_growth(at),
                ),
            ),
        )
        .await;
        let rollups = rollups.ok();
        let history = history.ok();
        let snapshot = snapshot.ok().flatten();
        let collator = self.host.source_string_collator();
        let body = gateway_admin_data::projection::project_quota_source(
            rollups.as_deref(),
            snapshot.as_ref(),
            history.as_deref(),
            at as f64,
            days,
            collator.as_ref(),
        )?;
        let bucket = HOUR * ((u64::from(balance_days) * 24).div_ceil(364).max(1) as i64);
        let rollup_count = rollups.as_ref().map_or(0, Vec::len);
        let sample_count = history.as_ref().map_or(0, Vec::len);
        let reads =
            4 + rollup_count + sample_count + growth["read_units"].as_u64().unwrap_or(0) as usize;
        let _ = self
            .record_projection_stats(days, reads as u64, rollup_count as u64)
            .await;
        let mut fields = gateway_core::source_serialization::entries(&body)
            .ok_or_else(|| store::error("Invalid source projection response"))?;
        fields.extend([
            ("balance_window_days".into(),SourceJson::from_serializable(&balance_days)?),
            ("retention".into(),SourceJson::from_serializable(&json!({"rollup_bucket_ms":HOUR,"rollup_window_ms":i64::from(days)*store::DAY,"balance_history_source_bucket_ms":HOUR,"balance_history_bucket_ms":bucket,"balance_history_window_ms":i64::from(balance_days)*store::DAY}))?),
            ("balance_history".into(),SourceJson::from_serializable(&history.as_ref().map(|s|resample_balance(s,bucket,365)).unwrap_or_default())?),
            ("ledger_growth".into(),SourceJson::from_serializable(&growth)?),
        ]);
        Ok(AuthResponse::source_json(
            200,
            gateway_core::source_serialization::object_keys(fields)?,
        ))
    }
    pub async fn analytics(
        &self,
        request: AnalyticsRequest,
        _context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        match request {
            AnalyticsRequest::PromptCache { group_by } => Ok(AuthResponse::json(
                200,
                self.prompt_analytics(&group_by).await?,
            )),
            AnalyticsRequest::PaidHistory { key_id, limit } => {
                #[derive(serde::Serialize)]
                struct History {
                    data: Vec<gateway_core::source_json::SourceJson>,
                }
                let data = self.request_logs(&key_id, limit).await?;
                Ok(AuthResponse::source_json(
                    200,
                    gateway_core::source_json::SourceJson::from_serializable(&History { data })?,
                ))
            }
            AnalyticsRequest::QuotaProjection {
                window_days,
                balance_window_days,
            } => {
                self.quota_projection_response(window_days, balance_window_days)
                    .await
            }
            AnalyticsRequest::QuotaProjectionBackfill { limit } => {
                let result = self
                    .host
                    .backfill_paid_usage(if limit == 0 { 5000 } else { limit.min(10000) })
                    .await?;
                Ok(AuthResponse::json(
                    200,
                    json!({"completed":!result.requests.truncated&&!result.windows.truncated,"requests":result.requests,"windows":result.windows}),
                ))
            }
        }
    }
}
