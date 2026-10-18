use crate::{
    AdminRuntime,
    capabilities::RuntimeCapabilities,
    kernel::{default_limit_key, default_window_key},
    parse, store,
};
use gateway_admin::{AdminInput, AdminOperation};
use gateway_auth::{
    AuthHost, AuthResponse, conflict, invalid,
    store::{check, commit, put},
};
use gateway_authority::{keys, quota::KernelDefaults};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::{RecordMutation, StoredRecord},
};
use gateway_schema::{
    catalog_store::{codex_snapshot_key, runtime_config_key},
    reasoning::ModelReasoning,
    runtime_config::{build_runtime_config, normalize_runtime_config},
    snapshot::ModelSnapshot,
};
use serde_json::{Value, json};

fn response(model: &str, effort: &str, defaults: &KernelDefaults) -> Value {
    json!({"defaults":{"model":model,"reasoning_effort":effort,"kernel_policy_limit_requests":defaults.usage_limit_requests,"kernel_policy_window_ms":defaults.window_ms}})
}
impl<S: QueryStore, H: AuthHost, C: RuntimeCapabilities> AdminRuntime<'_, S, H, C> {
    pub(crate) async fn defaults(
        &self,
        op: AdminOperation,
        input: &AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        if op == AdminOperation::DefaultsGet {
            let runtime = store::read(self.store, &runtime_config_key(), input.now_ms)
                .await?
                .and_then(|v| normalize_runtime_config(&v));
            let defaults = self.kernel_defaults(input.now_ms).await?;
            let mut body = response(
                runtime
                    .as_ref()
                    .and_then(|v| v["default_model"].as_str())
                    .unwrap_or(""),
                runtime
                    .as_ref()
                    .and_then(|v| v["default_reasoning_effort"].as_str())
                    .unwrap_or("medium"),
                &defaults,
            );
            body["metered_quota"] = self.capabilities.metered_diagnostics().await?;
            return Ok(AuthResponse::json(200, body));
        }
        let body = input
            .body
            .as_object()
            .ok_or_else(|| invalid("Invalid JSON body"))?;
        for name in body.keys() {
            if ![
                "model",
                "reasoning_effort",
                "kernel_policy_limit_requests",
                "kernel_policy_window_ms",
            ]
            .contains(&name.as_str())
            {
                return Err(invalid(&format!("Unknown defaults field: {name}")));
            }
        }
        let limit=body.get("kernel_policy_limit_requests").map(|v|parse::limit(v).ok_or_else(||invalid("kernel_policy_limit_requests must be a non-negative number or -1 for unlimited"))).transpose()?;
        let window = body
            .get("kernel_policy_window_ms")
            .map(|v| {
                parse::positive(v)
                    .ok_or_else(|| invalid("kernel_policy_window_ms must be a positive number"))
            })
            .transpose()?;
        for _ in 0..3 {
            let rk = runtime_config_key();
            let rr = self.store.read(&rk).await?;
            let lk = default_limit_key();
            let lr = self.store.read(&lk).await?;
            let wk = default_window_key();
            let wr = self.store.read(&wk).await?;
            let dk = keys::kernel_defaults();
            let dr = self.store.read(&dk).await?;
            let runtime =
                store::value(rr.as_ref(), input.now_ms)?.and_then(|v| normalize_runtime_config(&v));
            let old = self.kernel_defaults(input.now_ms).await?;
            let defaults = KernelDefaults {
                usage_limit_requests: limit.unwrap_or(old.usage_limit_requests),
                window_ms: window.unwrap_or(old.window_ms),
            };
            let mut model = runtime
                .as_ref()
                .and_then(|v| v["default_model"].as_str())
                .unwrap_or("")
                .to_owned();
            let mut effort = runtime
                .as_ref()
                .and_then(|v| v["default_reasoning_effort"].as_str())
                .unwrap_or("medium")
                .to_owned();
            let mut next_runtime = None;
            if body.contains_key("model") || body.contains_key("reasoning_effort") {
                if runtime.is_none() {
                    return Err(GatewayError::unavailable(
                        "Runtime configuration is unavailable",
                        "server_error",
                    ));
                }
                if let Some(raw) = body.get("model") {
                    model = parse::text(Some(raw))
                        .filter(|s| !s.chars().any(char::is_whitespace))
                        .ok_or_else(|| invalid("model must be a non-empty string"))?;
                }
                if model.is_empty() {
                    return Err(invalid("model must be a non-empty string"));
                }
                let snapshot: ModelSnapshot =
                    store::read(self.store, &codex_snapshot_key(), input.now_ms)
                        .await?
                        .map(|v| {
                            serde_json::from_value(v).map_err(|_| {
                                store::corrupt("Stored Codex model snapshot is corrupt")
                            })
                        })
                        .transpose()?
                        .filter(|s: &ModelSnapshot| !s.models.is_empty())
                        .ok_or_else(|| conflict("No Codex model snapshot stored"))?;
                let record = snapshot
                    .models
                    .iter()
                    .find(|r| r.get("slug").and_then(Value::as_str) == Some(&model))
                    .ok_or_else(|| invalid("model is not in the stored Codex model list"))?;
                let reasoning = ModelReasoning::from_record(Some(record));
                effort = if let Some(raw) = body.get("reasoning_effort") {
                    parse::text(Some(raw))
                        .ok_or_else(|| invalid("reasoning_effort must be a non-empty string"))?
                } else {
                    reasoning
                        .default_level
                        .or_else(|| reasoning.levels.first().cloned())
                        .unwrap_or("none".into())
                };
                next_runtime = Some(build_runtime_config(
                    &snapshot,
                    Some(&model),
                    Some(&effort),
                    input.now_ms,
                )?);
            }
            let response = response(&model, &effort, &defaults);
            if next_runtime.is_none() && limit.is_none() && window.is_none() {
                return Ok(AuthResponse::json(200, response));
            }
            let cutover_key = keys::kernel_cutover();
            let mut guard: Option<StoredRecord> = None;
            if window.is_some() && defaults.window_ms != old.window_ms {
                let current = self.store.read(&cutover_key).await?;
                if store::value(current.as_ref(), input.now_ms)?.is_some() {
                    continue;
                }
                let revision = store::revision(self.host)?;
                let marker = json!({"v":2,"id":revision,"created_at_ms":input.now_ms,"expires_at_ms":input.now_ms+300000});
                if !commit(
                    self.store,
                    vec![
                        check(&cutover_key, current.as_ref()),
                        check(&lk, lr.as_ref()),
                        check(&wk, wr.as_ref()),
                        check(&dk, dr.as_ref()),
                    ],
                    vec![put(
                        cutover_key.clone(),
                        &marker,
                        Some(input.now_ms + 300000),
                        &revision,
                    )?],
                )
                .await?
                {
                    continue;
                }
                let row = self.store.read(&cutover_key).await?.ok_or_else(|| {
                    store::corrupt("Kernel default-window cutover guard is unavailable")
                })?;
                if row.revision != revision {
                    return Err(store::corrupt(
                        "Kernel default-window cutover guard changed",
                    ));
                }
                guard = Some(row);
                match self.live_default_reservations(input.now_ms).await {
                    Ok(false) => {}
                    result => {
                        self.release_cutover(&cutover_key, guard.as_ref().expect("acquired guard"))
                            .await?;
                        return Err(match result {
                            Ok(true) => conflict(
                                "Active Kernel quota reservations must settle before changing the default window",
                            ),
                            Err(error) => error,
                            _ => unreachable!(),
                        });
                    }
                }
            }
            let revision = store::revision(self.host)?;
            let result = async {
                let mut checks = vec![
                    check(&rk, rr.as_ref()),
                    check(&lk, lr.as_ref()),
                    check(&wk, wr.as_ref()),
                    check(&dk, dr.as_ref()),
                ];
                let mut writes = Vec::new();
                if let Some(guard) = &guard {
                    checks.push(check(&cutover_key, Some(guard)));
                    writes.push(RecordMutation::Delete {
                        key: cutover_key.clone(),
                    });
                }
                if let Some(runtime) = next_runtime {
                    writes.push(put(rk, &runtime, None, &revision)?);
                }
                if let Some(limit) = limit {
                    writes.push(put(lk, &limit, None, &revision)?);
                }
                if let Some(window) = window {
                    writes.push(put(wk, &window, None, &revision)?);
                }
                if limit.is_some() || window.is_some() {
                    writes.push(put(dk, &defaults, None, &revision)?);
                }
                commit(self.store, checks, writes).await
            }
            .await;
            match result {
                Ok(true) => return Ok(AuthResponse::json(200, response)),
                other => {
                    if let Some(guard) = &guard {
                        self.release_cutover(&cutover_key, guard).await?;
                    }
                    if let Err(error) = other {
                        return Err(error);
                    }
                }
            }
        }
        Err(conflict("Defaults were modified concurrently; retry"))
    }
}
