//! Source admin/kernel.ts and codex/{reset,overage}-settings.ts.
//! Display diagnostics never authorize a redemption or mutate provider credentials.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{host_types::CapacityAccountRef, store};
use gateway_admin_runtime::capabilities::{CodexRequest, Context};
use gateway_auth::{
    AuthResponse,
    crypto::sha256_hex,
    provider_credentials::{codex_source_pool_key, parse_codex_source_pool},
};
use gateway_core::{
    GatewayError, query::QueryStore, source_json::SourceJson, source_serialization as source,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn reset_key(hash: &str) -> gateway_core::state::RecordKey {
    gateway_authority::keys::reset_usage(hash)
}
fn marker_key() -> gateway_core::state::RecordKey {
    store::key(json!([
        "uos_ai",
        "migrations",
        "codex_reset_usage_legacy_global_v1"
    ]))
}
fn legacy_key() -> gateway_core::state::RecordKey {
    store::key(json!(["uos_ai", "codex_banked_reset_usage", "v1"]))
}
fn legacy_opt_out(value: Option<&Value>) -> bool {
    value.is_some_and(|v| *v == false || (!v.is_null() && !v.is_boolean()))
}
fn nonempty(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= max)
}
pub fn parse_shadow_decision(v: &Value) -> Option<Value> {
    if !store::is_record(v)
        || v["v"] != 1
        || !nonempty(&v["episode_hash"], 512)
        || !nonempty(&v["decision_reason"], 128)
        || store::safe_i64(&v["created_at_ms"])? > store::safe_i64(&v["expires_at_ms"])?
    {
        return None;
    }
    for name in ["selected_account_id_hash", "selected_credit_id_hash"] {
        if !v.get(name).is_some_and(|v| v.is_null() || nonempty(v, 512)) {
            return None;
        }
    }
    if !v
        .get("selected_credit_expires_at_ms")
        .is_some_and(|v| v.is_null() || store::safe_i64(v).is_some())
        || v["selected_account_id_hash"].is_null() != v["selected_credit_id_hash"].is_null()
    {
        return None;
    }
    let raw = v["fences"].as_array().filter(|f| !f.is_empty())?;
    let mut slots = BTreeSet::new();
    let mut fences = Vec::new();
    for f in raw {
        let slot = store::safe_i64(&f["slot"])?;
        if !slots.insert(slot)
            || !nonempty(&f["account_id_hash"], 512)
            || !nonempty(&f["quota_generation"], 512)
            || store::safe_i64(&f["routing_generation"]).is_none()
            || store::safe_i64(&f["quota_reset_at_ms"]).is_none()
        {
            return None;
        }
        fences.push(json!({"slot":slot,"account_id_hash":f["account_id_hash"],"quota_generation":f["quota_generation"],"routing_generation":f["routing_generation"],"quota_reset_at_ms":f["quota_reset_at_ms"]}));
    }
    let mut out = json!({"v":1,"fences":fences});
    for name in [
        "episode_hash",
        "created_at_ms",
        "expires_at_ms",
        "decision_reason",
        "selected_account_id_hash",
        "selected_credit_id_hash",
        "selected_credit_expires_at_ms",
    ] {
        out[name] = v[name].clone()
    }
    Some(out)
}

impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    /// Exact one-way source migration. An empty or malformed pool leaves the marker absent.
    pub async fn migrate_legacy_reset_opt_out(&self) -> Result<bool, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let marker_key = marker_key();
        let marker = self.store.read(&marker_key).await?;
        if store::value(marker.as_ref(), at)?.is_some_and(|v| !v.is_null()) {
            return Ok(true);
        }
        let legacy_key = legacy_key();
        let legacy = self.store.read(&legacy_key).await?;
        let pool_key = codex_source_pool_key();
        let pool_row = self.store.read(&pool_key).await?;
        let pool = store::value(pool_row.as_ref(), at)?
            .and_then(|v| parse_codex_source_pool(v).ok().flatten());
        let Some(pool) = pool else { return Ok(false) };
        if pool.accounts.is_empty() {
            return Ok(false);
        }
        let preserved = legacy_opt_out(store::value(legacy.as_ref(), at)?);
        let mut checks = vec![
            store::check(&marker_key, marker.as_ref()),
            store::check(&legacy_key, legacy.as_ref()),
            store::check(&pool_key, pool_row.as_ref()),
        ];
        let mut writes = Vec::new();
        if preserved {
            for account in &pool.accounts {
                let key = reset_key(&sha256_hex(account.account_id.as_bytes()));
                let row = self.store.read(&key).await?;
                if store::value(row.as_ref(), at)?.is_none_or(Value::is_null) {
                    checks.push(store::check(&key, row.as_ref()));
                    writes.push(store::put(
                        self.host.as_ref(),
                        key,
                        json!({"enabled":false}),
                        None,
                    )?);
                }
            }
        }
        writes.push(store::put(
            self.host.as_ref(),
            marker_key,
            json!({"completed_at_ms":at,"preserved_opt_out":preserved}),
            None,
        )?);
        store::commit(self.store.as_ref(), checks, writes).await
    }
    pub async fn reset_usage_allowed(&self, hash: &str) -> Result<bool, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        if !self.migrate_legacy_reset_opt_out().await? {
            let marker_key = marker_key();
            let legacy_key = legacy_key();
            let marker = self.store.read(&marker_key).await?;
            let legacy = self.store.read(&legacy_key).await?;
            if store::value(marker.as_ref(), at)?.is_none_or(Value::is_null)
                && legacy_opt_out(store::value(legacy.as_ref(), at)?)
            {
                let key = reset_key(hash);
                let row = self.store.read(&key).await?;
                if store::value(row.as_ref(), at)?.is_none_or(Value::is_null) {
                    let _ = store::commit(
                        self.store.as_ref(),
                        vec![
                            store::check(&marker_key, marker.as_ref()),
                            store::check(&key, row.as_ref()),
                        ],
                        vec![store::put(
                            self.host.as_ref(),
                            key,
                            json!({"enabled":false}),
                            None,
                        )?],
                    )
                    .await?;
                }
            }
        }
        let row = self.store.read(&reset_key(hash)).await?;
        let v = store::value(row.as_ref(), at)?;
        Ok(v.is_none_or(Value::is_null) || v.is_some_and(|v| v["enabled"] == true))
    }
    async fn settings_accounts(&self) -> Result<Vec<CapacityAccountRef>, GatewayError> {
        let accounts = self.host.codex_capacity_accounts().await?;
        let mut slots = BTreeSet::new();
        if accounts.len() > 2
            || accounts.iter().any(|a| {
                !(1..=2).contains(&a.slot)
                    || store::trim(&a.account_id).is_empty()
                    || !slots.insert(a.slot)
            })
        {
            return Err(store::error(
                "Settings owner published an invalid account roster",
            ));
        }
        Ok(accounts)
    }
    pub async fn reset_settings_response(
        &self,
        document: Option<&SourceJson>,
    ) -> Result<AuthResponse, GatewayError> {
        self.capacity_settings_response(document, false).await
    }
    pub async fn overage_settings_response(
        &self,
        document: Option<&SourceJson>,
    ) -> Result<AuthResponse, GatewayError> {
        self.capacity_settings_response(document, true).await
    }
    async fn capacity_settings_response(
        &self,
        document: Option<&SourceJson>,
        overage: bool,
    ) -> Result<AuthResponse, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let accounts = self.settings_accounts().await?;
        let field = if overage { "allow" } else { "enabled" };
        if let Some(raw) = document {
            let selector = source::member(raw, "account_id_hash")
                .as_ref()
                .and_then(source::string)
                .ok_or_else(|| {
                    store::invalid(format!("account_id_hash and boolean {field} are required"))
                })?;
            let flag = source::member(raw, field)
                .and_then(|value| value.deserialize::<bool>().ok())
                .ok_or_else(|| {
                    store::invalid(format!("account_id_hash and boolean {field} are required"))
                })?;
            // A source string that cannot equal an existing generated ASCII hash
            // is the same subscription mismatch, never a new scalar-type error.
            let hash = accounts
                .iter()
                .map(|account| sha256_hex(account.account_id.as_bytes()))
                .find(|hash| hash.encode_utf16().eq(selector.as_units().iter().copied()))
                .ok_or_else(|| {
                    GatewayError::new(
                        409,
                        "Subscription changed. Reload Providers.",
                        Some("invalid_request_error"),
                    )
                })?;
            let key = if overage {
                gateway_authority::keys::overage(&hash)
            } else {
                reset_key(&hash)
            };
            let mut value = json!({});
            value[field] = json!(flag);
            if !store::commit(
                self.store.as_ref(),
                Vec::new(),
                vec![store::put(self.host.as_ref(), key, value, None)?],
            )
            .await?
            {
                return Err(store::error("Settings write conflicted"));
            }
            let mut body = json!({"account_id_hash":hash});
            body[field] = json!(flag);
            return Ok(AuthResponse::json(200, body));
        }
        let mut data = Vec::new();
        for account in accounts {
            let hash = sha256_hex(account.account_id.as_bytes());
            let cohort = sha256_hex(
                format!("uos-prompt-cache-account-cohort-v1\0{}", account.account_id).as_bytes(),
            );
            let mut v =
                json!({"slot":account.slot,"account_id_hash":hash,"account_cohort_id":cohort});
            if overage {
                let row = self
                    .store
                    .read(&gateway_authority::keys::overage(&hash))
                    .await?;
                v["allow"] =
                    json!(store::value(row.as_ref(), at)?.is_some_and(|v| v["allow"] == true));
                v["overage"] = self
                    .host
                    .codex_overage_diagnostics(&account, at + 5000)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or(Value::Null);
            } else {
                v["enabled"] = json!(self.reset_usage_allowed(&hash).await?);
                let (count, credits) = futures_util::future::join(
                    self.host.codex_reset_available_count(&account, at + 5000),
                    self.host.codex_reset_credits(&account, at + 5000),
                )
                .await;
                v["available_count"] = json!(count.ok().flatten());
                v["credits"] = json!(credits.ok().flatten());
            }
            data.push(v);
        }
        Ok(AuthResponse::json(200, json!({"data":data})))
    }
    pub async fn shadow_decisions_response(&self) -> Result<AuthResponse, GatewayError> {
        let at = store::now(self.host.as_ref())?;
        let mut decisions: Vec<Value> = store::scan(
            self.store.as_ref(),
            store::key(json!(["uos_ai", "codex_reset_shadow_decision", "v1"])),
            false,
            at,
            100,
        )
        .await?
        .into_iter()
        .filter_map(|r| r.record.json_value().ok().and_then(parse_shadow_decision))
        .collect();
        let mut error = None;
        decisions.sort_by(|a, b| {
            store::safe_i64(&b["created_at_ms"])
                .cmp(&store::safe_i64(&a["created_at_ms"]))
                .then_with(|| {
                    match self.host.compare_labels(
                        a["episode_hash"].as_str().unwrap_or(""),
                        b["episode_hash"].as_str().unwrap_or(""),
                    ) {
                        Ok(order) => order,
                        Err(e) => {
                            error = Some(e);
                            std::cmp::Ordering::Equal
                        }
                    }
                })
        });
        if let Some(e) = error {
            return Err(e);
        }
        Ok(AuthResponse::json(200, json!({"decisions":decisions})))
    }
    pub async fn cache_experiment_baseline(&self) -> Result<Value, GatewayError> {
        let target = self.host.cache_experiment_target().await?;
        let identity = self.host.build_identity()?;
        identity.validate()?;
        Ok(self
            .prompt_telemetry_baseline(&target.provider, &target.model, &identity.git_sha)
            .await)
    }
    pub async fn cache_experiment_baseline_response(&self) -> Result<AuthResponse, GatewayError> {
        let baseline = self.cache_experiment_baseline().await?;
        let mut public = json!({});
        for name in [
            "status",
            "reason",
            "release",
            "provider",
            "aggregate",
            "routes",
        ] {
            public[name] = baseline[name].clone()
        }
        Ok(AuthResponse::json(200, public))
    }
    pub async fn cache_experiment_response(&self) -> Result<AuthResponse, GatewayError> {
        let baseline = self.cache_experiment_baseline().await?;
        if baseline["status"] != "eligible" {
            return Err(GatewayError::unavailable(
                "Prompt-cache Stage 0 telemetry baseline is not eligible.",
                "prompt_cache_scope_experiment_unavailable",
            ));
        }
        let result = self.host.run_fixed_cache_experiment(&baseline).await?;
        let status = if result["status"] == "in_progress" {
            202
        } else {
            200
        };
        Ok(AuthResponse::json(status, result))
    }
    pub async fn codex(
        &self,
        request: CodexRequest,
        _context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        match request {
            CodexRequest::ResetSettings => self.reset_settings_response(None).await,
            CodexRequest::SetResetSettings { document } => {
                self.reset_settings_response(Some(&document)).await
            }
            CodexRequest::OverageSettings => self.overage_settings_response(None).await,
            CodexRequest::SetOverageSettings { document } => {
                self.overage_settings_response(Some(&document)).await
            }
            CodexRequest::ShadowDecisions => self.shadow_decisions_response().await,
            CodexRequest::Recheck { slot } => {
                if !(1..=2).contains(&slot) {
                    return Err(GatewayError::new(
                        404,
                        "Codex account slot not found",
                        Some("not_found"),
                    ));
                }
                if !self.host.recheck_codex_slot(slot).await? {
                    return Err(GatewayError::new(
                        404,
                        "Codex account slot is not configured",
                        Some("not_found"),
                    ));
                }
                let mut r = AuthResponse::json(204, Value::Null);
                r.headers.clear();
                Ok(r)
            }
            CodexRequest::ImportCredentials { .. } => {
                Err(store::missing("native_credential_owner"))
            }
            CodexRequest::ConsumeReset { .. } => Err(store::missing("native_manual_reset_owner")),
            CodexRequest::CacheExperimentBaseline => {
                self.cache_experiment_baseline_response().await
            }
            CodexRequest::RunCacheExperiment => self.cache_experiment_response().await,
        }
    }
}
