//! Source lease-guarded event/admin sampler. No timer, alarm, or inference operation.
use crate::replay_values::SourceObject;
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{capacity_shapes as shape, health, host_types::*, store};
use gateway_admin_runtime::capabilities::Context;
use gateway_auth::{AuthResponse, crypto::sha256_hex};
use gateway_core::{
    GatewayError, query::QueryStore, source_json::SourceJson, source_serialization as source,
};
use serde_json::{Value, json};

fn view(
    snapshot: Option<Value>,
    state: &str,
    history: Vec<Value>,
    reset: Vec<Value>,
    rate: Vec<Value>,
    downtime: Vec<Value>,
    at: i64,
) -> Value {
    let exists = snapshot.is_some();
    let mut out = shape::stale_snapshot(
        &snapshot.unwrap_or_else(|| shape::unavailable_snapshot(at)),
        at,
    );
    let stale = out["sources"]
        .as_array()
        .is_some_and(|a| a.iter().any(|s| s["state"] == "stale"));
    out["cache_state"] = json!(if !exists {
        "unavailable"
    } else if stale {
        "stale"
    } else {
        state
    });
    out["history"] = json!(history);
    out["reset_events"] = json!(reset);
    out["rate_limit_reset_events"] = json!(rate);
    out["downtime_events"] = json!(downtime);
    out
}
pub fn unavailable_claude(at: i64) -> Value {
    json!({"source":"claude_code","label":"Claude subscription","state":"unavailable","source_observed_at_ms":null,"snapshot_at_ms":at,"failure_kind":"not_configured","failure_status":null,"credential_kind":null,"workspace_id":null,"windows":{"five_hour":null,"seven_day":null},"standard":[],"blocked_until_ms":null,"cooldown_until_ms":null,"last_error":null})
}
pub fn claude_source(
    account: &ClaudeAccountReadback,
    health: &Value,
    at: i64,
) -> Result<SourceJson, GatewayError> {
    let empty = SourceJson::parse("{}")?;
    let quota = SourceObject::parse(account.quota.as_ref().unwrap_or(&empty))?;
    let null = SourceJson::parse("null")?;
    let field = |name: &str| quota.get(name).cloned().unwrap_or_else(|| null.clone());
    let number = |value: &SourceJson| source::number(value).filter(|n| n.is_finite());
    let integer = |value: &SourceJson| {
        number(value).filter(|n| n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n))
    };
    let blocked = integer(&field("blocked_until_ms")).is_some_and(|t| t > at as f64);
    let cooling = integer(&field("cooldown_until_ms")).is_some_and(|t| t > at as f64);
    let error = field("last_error");
    let error_fields = if error.as_str().trim_start().starts_with('{') {
        Some(SourceObject::parse(&error)?)
    } else {
        None
    };
    let failing = blocked || cooling || error_fields.is_some();
    let windows = field("windows");
    let standard = field("standard");
    let mut observed = Vec::new();
    for document in [&windows, &standard] {
        if document.as_str().trim_start().starts_with('{') {
            for (_, value) in source::entries(document)
                .ok_or_else(|| store::error("Invalid Claude numeric observation metadata"))?
            {
                if value.as_str().trim_start().starts_with('{')
                    && let Some(at) = SourceObject::parse(&value)?
                        .get("observed_at_ms")
                        .and_then(number)
                {
                    observed.push(at);
                }
            }
        }
    }
    let observed = observed.into_iter().reduce(f64::max);
    let state = if failing {
        "unavailable"
    } else if observed.is_some_and(|t| at as f64 - t > shape::STALE_MS as f64) {
        "stale"
    } else {
        "available"
    };
    let failure_status = error_fields
        .as_ref()
        .and_then(|e| e.get("status"))
        .and_then(number)
        .filter(|n| *n >= 0.0 && n.fract() == 0.0)
        .or_else(|| {
            if blocked {
                Some(429.0)
            } else if cooling {
                health["last_status"].as_u64().map(|n| n as f64)
            } else {
                None
            }
        });
    let window = |name: &str| -> Result<Option<SourceJson>, GatewayError> {
        if !windows.as_str().trim_start().starts_with('{') {
            return Ok(None);
        }
        let input = SourceObject::parse(&windows)?;
        let Some(input) = input
            .get(name)
            .filter(|v| v.as_str().trim_start().starts_with('{'))
        else {
            return Ok(None);
        };
        let input = SourceObject::parse(input)?;
        let leaf = |name| input.get(name).cloned().unwrap_or_else(|| null.clone());
        Ok(Some(source::object(vec![
            ("status", leaf("status")),
            (
                "used_percent",
                SourceJson::from_serializable(&crate::claude_capacity::used_percent(number(
                    &leaf("utilization"),
                )))?,
            ),
            ("reset_at_ms", leaf("reset_at_ms")),
            ("observed_at_ms", leaf("observed_at_ms")),
        ])?))
    };
    let mut standard_rows = Vec::new();
    if standard.as_str().trim_start().starts_with('{') {
        for (family, value) in source::entries(&standard)
            .ok_or_else(|| store::error("Invalid Claude standard metadata"))?
        {
            let value = SourceObject::parse(&value)?;
            let leaf = |name| value.get(name).cloned().unwrap_or_else(|| null.clone());
            standard_rows.push(source::object(vec![
                ("family", family.to_source_json()?),
                ("limit", leaf("limit")),
                ("remaining", leaf("remaining")),
                ("reset_at_ms", leaf("reset_at_ms")),
            ])?);
        }
    }
    let mut document = SourceObject::parse(&SourceJson::from_serializable(
        &json!({"source":"claude_code","label":"Claude subscription","account_id":account.account_id,"account_cohort_id":account.account_cohort_id,"state":state,"source_observed_at_ms":observed,"snapshot_at_ms":at,"failure_kind":if failing{Some("upstream_error")}else{None},"failure_status":failure_status,"credential_kind":account.credential.kind}),
    )?)?;
    document.set("workspace_id", &account.workspace.as_ref().map(|w| &w.id))?;
    document.set(
        "windows",
        &source::object(vec![
            ("five_hour", SourceJson::from_serializable(&window("5h")?)?),
            ("seven_day", SourceJson::from_serializable(&window("7d")?)?),
        ])?,
    )?;
    document.set("standard", &standard_rows)?;
    document.set("blocked_until_ms", &field("blocked_until_ms"))?;
    document.set("cooldown_until_ms", &field("cooldown_until_ms"))?;
    document.set("last_error", &error)?;
    document.source_json()
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    async fn slot_capacity(
        &self,
        account: Option<&CapacityAccountRef>,
        slot: u8,
        fence: Option<&gateway_authority::capacity::CodexCapacityObservationFence>,
        at: i64,
    ) -> Result<Value, GatewayError> {
        let Some(account) = account else {
            return Ok(shape::unavailable_codex(
                slot,
                at,
                "not_configured",
                None,
                false,
                None,
                None,
            ));
        };
        let fence = fence.ok_or_else(|| store::missing("capacity_authority_source_fence"))?;
        if !fence.fetch_bindings().any(|binding| {
            binding.source_slot() == slot && binding.account_id() == account.account_id
        }) {
            return Err(store::error(
                "Capacity GET does not match the captured source",
            ));
        }
        let cohort = sha256_hex(
            format!("uos-prompt-cache-account-cohort-v1\0{}", account.account_id).as_bytes(),
        );
        let failed = |kind: &str, status: Option<u16>| {
            shape::unavailable_codex(
                slot,
                at,
                kind,
                status,
                true,
                account.label.as_deref(),
                Some(&cohort),
            )
        };
        let probe = self
            .host
            .probe_codex_capacity(account, fence, at + 8000)
            .await?;
        match probe {
            CapacityProbe::Unreachable => Ok(failed("unreachable", None)),
            CapacityProbe::Http { status, .. } if !(200..300).contains(&status) => Ok(failed(
                if status >= 500 {
                    "upstream_error"
                } else {
                    "http_error"
                },
                Some(status),
            )),
            CapacityProbe::Http { status, json } => {
                let Some(windows) = json.as_ref().and_then(shape::parse_codex_usage) else {
                    return Ok(failed("invalid_response", Some(status)));
                };
                Ok(
                    json!({"source":"codex","label":shape::codex_label(slot,account.label.as_deref()),"slot":slot,"account_cohort_id":cohort,"state":"available","source_observed_at_ms":at,"snapshot_at_ms":at,"failure_kind":null,"failure_status":null,"windows":{"primary":windows["primary"],"secondary":windows["secondary"]},"additional_rate_limits":windows["additional_rate_limits"]}),
                )
            }
        }
    }
    async fn capture_capacity_snapshot(
        &self,
        at: i64,
        force_metered: bool,
    ) -> Result<Value, GatewayError> {
        let accounts = self.host.codex_capacity_accounts().await?;
        let mut slots = std::collections::BTreeSet::new();
        if accounts.len() > 2
            || accounts.iter().any(|a| {
                !(1..=2).contains(&a.slot)
                    || store::trim(&a.account_id).is_empty()
                    || !slots.insert(a.slot)
            })
        {
            return Err(store::error(
                "Capacity owner published an invalid account roster",
            ));
        }
        let fence = if accounts.is_empty() {
            None
        } else {
            Some(
                self.host
                    .begin_codex_capacity_observation(&accounts)
                    .await?,
            )
        };
        let at = fence.as_ref().map_or(at, |f| f.observed_at_ms());
        let codex = futures_util::future::join(
            self.slot_capacity(accounts.iter().find(|a| a.slot == 1), 1, fence.as_ref(), at),
            self.slot_capacity(accounts.iter().find(|a| a.slot == 2), 2, fence.as_ref(), at),
        );
        let ((one, two), metered) = futures_util::future::join(
            codex,
            self.host.metered_quota_snapshot(force_metered, at + 8000),
        )
        .await;
        let one = one?;
        let two = two?;
        let metered = metered?;
        let mut observations = Vec::new();
        for account in accounts {
            let source = if account.slot == 1 { &one } else { &two };
            let invalid =
                || store::error("Capacity source observation does not match authority DTO");
            observations.push(gateway_authority::capacity::CodexCapacitySample {
                account: gateway_authority::capacity::CodexCapacityAccountRef {
                    source_slot: account.slot,
                    account_id: account.account_id,
                },
                state: serde_json::from_value(source["state"].clone()).map_err(|_| invalid())?,
                source_observed_at_ms: store::safe_i64(&source["source_observed_at_ms"]),
                snapshot_at_ms: at,
                windows: serde_json::from_value(source["windows"].clone())
                    .map_err(|_| invalid())?,
                additional_rate_limits: serde_json::from_value(json!(
                    shape::additional_for_routing(&source["additional_rate_limits"], at)
                ))
                .map_err(|_| invalid())?,
            });
        }
        if let Some(fence) = fence.as_ref() {
            self.host
                .accept_capacity_observations(fence, &observations)
                .await?;
        }
        Ok(
            json!({"snapshot_at_ms":at,"stale_after_ms":shape::STALE_MS,"sources":[one,two,shape::metered_source(metered.as_ref(),at)]}),
        )
    }
    pub async fn persisted_capacity_view(&self) -> Result<Value, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let snapshot = self.read_capacity_snapshot(at).await.unwrap_or(None);
        let history = self.capacity_history(at).await.unwrap_or_default();
        let reset = self
            .capacity_events("reset_event", at)
            .await
            .unwrap_or_default();
        let rate = self
            .capacity_events("rate_limit_reset_event", at)
            .await
            .unwrap_or_default();
        let downtime = self
            .capacity_events("downtime_event", at)
            .await
            .unwrap_or_default();
        let rate = self
            .historical_rate_limit_events(&history, rate, at)
            .await
            .unwrap_or_default();
        Ok(view(
            snapshot,
            "persisted",
            history,
            reset,
            rate,
            downtime,
            at,
        ))
    }
    pub async fn refresh_capacity_view(&self, force_metered: bool) -> Result<Value, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let before = self.persisted_capacity_view().await?;
        let cached = (before["cache_state"] != "unavailable").then(|| {
            let mut v = before.clone();
            if let Some(o) = v.as_object_mut() {
                for f in [
                    "cache_state",
                    "history",
                    "reset_events",
                    "rate_limit_reset_events",
                    "downtime_events",
                ] {
                    o.remove(f);
                }
            }
            v
        });
        let owner = store::uuid(self.host.as_ref())?;
        let lease = self
            .acquire_capacity_lease(&owner, at)
            .await
            .unwrap_or(None);
        let Some(lease) = lease else {
            let snapshot = self
                .wait_capacity_snapshot(
                    cached
                        .as_ref()
                        .and_then(|s| store::safe_i64(&s["snapshot_at_ms"])),
                )
                .await
                .unwrap_or(None)
                .or(cached);
            let refreshed = self
                .persisted_capacity_view()
                .await
                .unwrap_or_else(|_| before.clone());
            return Ok(view(
                snapshot,
                "persisted",
                refreshed["history"].as_array().cloned().unwrap_or_default(),
                refreshed["reset_events"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                refreshed["rate_limit_reset_events"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                refreshed["downtime_events"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                at,
            ));
        };
        let captured = async {
            let snapshot = self.capture_capacity_snapshot(at, force_metered).await?;
            let persisted = self
                .persist_capacity_snapshot(&lease, &snapshot)
                .await
                .unwrap_or(false);
            let refreshed = self
                .persisted_capacity_view()
                .await
                .unwrap_or_else(|_| before.clone());
            let mut history = refreshed["history"].as_array().cloned().unwrap_or_default();
            if !persisted {
                let point = shape::history_point(&snapshot);
                history.retain(|p| {
                    p["bucket_start_at_ms"] != point["bucket_start_at_ms"]
                        || p["sampled_at_ms"] != point["sampled_at_ms"]
                });
                history.push(point);
                history.sort_by_key(|p| {
                    (
                        store::safe_i64(&p["bucket_start_at_ms"]),
                        store::safe_i64(&p["sampled_at_ms"]),
                    )
                });
            }
            Ok(view(
                Some(snapshot),
                "live",
                history,
                refreshed["reset_events"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                refreshed["rate_limit_reset_events"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                refreshed["downtime_events"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                at,
            ))
        }
        .await;
        self.release_capacity_lease(&owner).await;
        captured
    }
    pub async fn sample_capacity_on_event(&self) -> Result<bool, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let owner = store::uuid(self.host.as_ref())?;
        let Some(lease) = self.acquire_capacity_lease(&owner, at).await? else {
            return Ok(false);
        };
        let sample = async {
            let snapshot = self.capture_capacity_snapshot(at, true).await?;
            self.persist_capacity_snapshot(&lease, &snapshot).await
        }
        .await;
        if !matches!(sample, Ok(true)) {
            self.release_capacity_lease(&owner).await;
        }
        sample
    }
    pub async fn trigger_capacity_sample(&self) -> Result<bool, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let bucket = at / shape::BUCKET_MS * shape::BUCKET_MS;
        if bucket <= self.sampled_bucket.get() {
            return Ok(false);
        }
        self.sampled_bucket.set(bucket);
        self.sample_capacity_on_event().await
    }
    pub async fn capacity_response(
        &self,
        live: bool,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let inventory = self.host.provider_inventory(&context).await?;
        let cached = self.persisted_capacity_view().await?;
        let fresh = cached["cache_state"] != "unavailable"
            && store::safe_i64(&cached["snapshot_at_ms"]).is_some_and(|t| at - t < 30000);
        let mut body = if !live && fresh {
            cached
        } else {
            match self.refresh_capacity_view(live).await {
                Ok(v) => v,
                Err(e)
                    if e.envelope.error.code.as_deref() == Some("admin_capability_unavailable") =>
                {
                    return Err(e);
                }
                Err(_) => cached,
            }
        };
        let mut source_accounts = Vec::new();
        for account in &inventory.claude.accounts {
            let health = self
                .provider_health(&account.target, at)
                .await
                .unwrap_or_else(|_| health::unknown_health());
            source_accounts.push(claude_source(account, &health, at)?);
        }
        let source_active = inventory
            .claude
            .accounts
            .iter()
            .position(|a| {
                Some(a.account_id.as_str()) == inventory.claude.active_account_id.as_deref()
            })
            .and_then(|i| source_accounts.get(i))
            .cloned()
            .unwrap_or(SourceJson::from_serializable(&unavailable_claude(at))?);
        let source_history = self.claude_capacity_history(at).await;
        body["prompt_cache"] = self.prompt_analytics(&[]).await?;
        body["ledger_growth"] = self.ledger_growth(at).await;
        let remote = self
            .remote_capacity_observations(at)
            .await
            .unwrap_or_default();
        if !remote.is_empty() {
            let local = body["history"].as_array().cloned().unwrap_or_default();
            body["history"] = json!(crate::capacity_math::merge_remote_history(
                &local,
                &remote,
                |a, b| self.host.compare_labels(a, b)
            )?);
        }
        let mut document = crate::replay_values::SourceObject::parse(
            &gateway_core::source_json::SourceJson::from_serializable(&body)?,
        )?;
        document.set("claude_accounts", &source_accounts)?;
        document.set("claude", &source_active)?;
        document.set("claude_history", &source_history)?;
        Ok(AuthResponse::source_json(200, document.source_json()?))
    }
    pub async fn capacity_rollups_response(
        &self,
        window_days: u32,
    ) -> Result<AuthResponse, GatewayError> {
        let days = if window_days == 0 {
            90
        } else {
            window_days.min(365)
        };
        let at = store::now(self.host.as_ref())?;
        let window = i64::from(days) * store::DAY;
        let points = self
            .capacity_rollup_points((at - window).max(0), at)
            .await
            .ok();
        let claude = self.claude_capacity_rollups((at - window).max(0), at).await;
        let claude = SourceObject::parse(&claude)?;
        let mut document = SourceObject::parse(&SourceJson::from_serializable(
            &json!({"snapshot_at_ms":at,"window_days":days,"retention":{"rollup_bucket_ms":shape::HOUR_MS,"rollup_window_ms":window},"rollup_scan":if points.is_some(){"ok"}else{"unavailable"},"rollups":points.unwrap_or_default()}),
        )?)?;
        for (output, input) in [
            ("claude_rollup_scan", "scan"),
            ("claude_rollup_truncated", "truncated"),
            ("claude_rollups", "points"),
        ] {
            document.set(output, &claude.get(input))?;
        }
        Ok(AuthResponse::source_json(200, document.source_json()?))
    }
}
