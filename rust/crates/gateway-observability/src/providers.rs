use crate::{
    ObservabilityRuntime,
    replay_values::SourceObject,
    types::{HealthProvider, HealthTarget, ObservabilityHost},
};
use crate::{
    completion::Completion,
    health::{aggregate_states, binding_current, unknown_health},
    host_types::*,
    store,
};
use gateway_admin_runtime::capabilities::Context;
use gateway_auth::AuthResponse;
use gateway_core::{GatewayError, query::QueryStore, source_json::SourceJson};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};
#[derive(Clone)]
struct ActiveResponseData {
    status: u16,
    body: gateway_core::source_json::SourceJson,
    identity: BuildIdentity,
}
type ActiveResult = Result<ActiveResponseData, GatewayError>;
type ActiveReceipt = Completion<ActiveResult>;
#[derive(Clone, Default)]
pub(crate) struct ActiveHealth(Rc<RefCell<Option<ActiveReceipt>>>);
struct ActiveCompletion {
    state: ActiveHealth,
    receipt: ActiveReceipt,
    finished: bool,
}
impl ActiveCompletion {
    fn complete(&self, result: ActiveResult) {
        {
            let mut current = self.state.0.borrow_mut();
            if current.as_ref().is_some_and(|c| c.same(&self.receipt)) {
                current.take();
            }
        }
        self.receipt.finish(result);
    }
    fn finish(mut self, result: ActiveResult) -> ActiveResult {
        self.complete(result.clone());
        self.finished = true;
        result
    }
}
impl Drop for ActiveCompletion {
    fn drop(&mut self) {
        if !self.finished {
            self.complete(Err(GatewayError::unavailable(
                "Active upstream health probe was interrupted.",
                "active_upstream_health_interrupted",
            )))
        }
    }
}
fn auth_view(meta: &CodexAuthMetadata, now: i64) -> Value {
    let expired = |time: Option<i64>| time.map(|t| t <= now);
    let refresh = |time: Option<i64>| time.map(|t| t - now < 120000);
    let accounts:Vec<Value>=meta.accounts.iter().map(|a|json!({"slot":a.slot,"updated_at_ms":a.updated_at_ms,"access_token_exp_ms":a.access_token_exp_ms,"refresh_sha256":a.refresh_sha256,"native_owner_codex_home":a.native_owner_codex_home,"access_token_expired":expired(a.access_token_exp_ms),"refresh_recommended":refresh(a.access_token_exp_ms)})).collect();
    json!({"source":meta.source,"updated_at_ms":meta.updated_at_ms,"access_token_exp_ms":meta.access_token_exp_ms,"account_count":accounts.len(),"access_token_expired":expired(meta.access_token_exp_ms),"refresh_recommended":refresh(meta.access_token_exp_ms),"accounts":accounts})
}
fn active_response(data: ActiveResponseData) -> Result<AuthResponse, GatewayError> {
    let mut response = AuthResponse::source_json(data.status, data.body);
    identity_headers(&mut response, data.identity)?;
    Ok(response)
}
fn quota_view(snapshot: Option<&Value>) -> Value {
    let mut out = json!({"available":snapshot.is_some()});
    let fields = [
        "cache_state",
        "balance_credits",
        "baseline_credits",
        "remaining_percent",
        "used_percent",
        "unlimited_quota",
        "total_available",
        "total_granted",
        "total_used",
    ];
    for field in fields {
        out[field] = snapshot.map(|s| s[field].clone()).unwrap_or(Value::Null)
    }
    let token = snapshot.is_some_and(|s| {
        s["unlimited_quota"] == true
            || !s["total_available"].is_null()
            || !s["total_used"].is_null()
    });
    for field in [
        "observed_at_ms",
        "confidence",
        "cycle_started_at_ms",
        "last_credit_at_ms",
    ] {
        out[field] = if field != "observed_at_ms" && token {
            Value::Null
        } else {
            snapshot
                .map(|s| s["state"][field].clone())
                .unwrap_or(Value::Null)
        }
    }
    out
}
fn credential_view(credential: &CredentialMetadata) -> Result<SourceJson, GatewayError> {
    let mut document = SourceObject::parse(&SourceJson::from_serializable(credential)?)?;
    document.set("expires_at_ms", &Option::<i64>::None)?;
    document.set("refresh_material_present", &false)?;
    document.source_json()
}
fn safe_quota(
    quota: &gateway_core::source_json::SourceJson,
) -> Result<gateway_core::source_json::SourceJson, GatewayError> {
    crate::replay_values::SourceObject::parse(quota)?.select(&[
        "windows",
        "standard",
        "representative_claim",
        "blocked_until_ms",
        "block_window",
        "cooldown_until_ms",
        "last_error",
        "updated_at_ms",
    ])
}
fn identity_headers(
    response: &mut AuthResponse,
    identity: BuildIdentity,
) -> Result<(), GatewayError> {
    identity.validate()?;
    response
        .headers
        .insert("x-uos-git-sha".into(), identity.git_sha);
    response
        .headers
        .insert("x-uos-deployment-id".into(), identity.deployment_id);
    Ok(())
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn passive_provider_response(
        &self,
        include_quota: bool,
        context: Context,
    ) -> Result<AuthResponse, GatewayError> {
        let inventory = self.host.provider_inventory(&context).await?;
        let at = store::now(self.host.as_ref())?;
        let auth = auth_view(&inventory.codex, at);
        let mut codex_accounts = auth["accounts"]
            .as_array()
            .expect("source account array")
            .clone();
        let mut states = Vec::new();
        for (index, account) in inventory.codex.accounts.iter().enumerate() {
            let health = self
                .provider_health(&HealthTarget::codex(&account.account_id), at)
                .await
                .unwrap_or_else(|_| unknown_health());
            states.push(health["state"].as_str().unwrap_or("unknown").to_owned());
            codex_accounts[index]["health"] = health;
        }
        let states: Vec<&str> = states.iter().map(String::as_str).collect();
        let mut body = json!({"mode":"passive","generated_at_ms":at,"stale_after_ms":crate::health::STALE_AFTER_MS,"codex":{"configured":inventory.codex.source!=CredentialSource::None,"source":inventory.codex.source,"account_count":codex_accounts.len(),"state":aggregate_states(&states),"accounts":codex_accounts}});
        for provider in [
            HealthProvider::Cerebras,
            HealthProvider::Deepseek,
            HealthProvider::Lithos,
            HealthProvider::Metered,
            HealthProvider::Openrouter,
            HealthProvider::Surplus,
        ] {
            let health = self
                .provider_health(&HealthTarget::default_identity(provider), at)
                .await
                .unwrap_or_else(|_| unknown_health());
            body[provider.id()] =
                json!({"configured":inventory.configured.contains(&provider),"health":health});
        }
        body["metered"]["quota_monitoring_configured"] =
            json!(inventory.quota_monitoring_configured);
        body["metered"]["quota"] = if include_quota {
            quota_view(inventory.metered_quota.as_ref())
        } else {
            json!({"available":inventory.metered_quota.is_some(),"cache_state":inventory.metered_quota.as_ref().map(|v|v["cache_state"].clone()),"observed_at_ms":inventory.metered_quota.as_ref().map(|v|v["state"]["observed_at_ms"].clone())})
        };
        body["surplus"]["quota_monitoring_configured"] = json!(false);
        body["surplus"]["quota"] = if include_quota {
            let mut q = quota_view(None);
            q["source"] = json!("not_reported");
            q
        } else {
            json!({"available":false,"observed_at_ms":null})
        };
        let mut gateway_health = unknown_health();
        gateway_health["state"] = json!(if inventory.ubiquity_configured {
            "healthy"
        } else {
            "unknown"
        });
        gateway_health["stale"] = json!(false);
        body["ubiquity"] =
            json!({"configured":inventory.ubiquity_configured,"health":gateway_health});
        let mut accounts = Vec::new();
        let mut active = None;
        for account in &inventory.claude.accounts {
            if account.target.provider != HealthProvider::ClaudeCode {
                return Err(store::error("Claude health target provider mismatch"));
            }
            let current = binding_current(self.store.as_ref(), &account.target)
                .await
                .unwrap_or(false);
            let health = if current {
                self.provider_health(&account.target, at)
                    .await
                    .unwrap_or_else(|_| unknown_health())
            } else {
                unknown_health()
            };
            let mut document = SourceObject::parse(&SourceJson::from_serializable(
                &json!({"account_id":account.account_id,"account_cohort_id":account.account_cohort_id,"active":inventory.claude.active_account_id.as_ref()==Some(&account.account_id),"stale":!current,"health":health,"capabilities":{"identity_verified":false,"can_refresh":false,"can_reset_upstream_quota":false}}),
            )?)?;
            document.set("label", &account.label)?;
            document.set("credential", &credential_view(&account.credential)?)?;
            document.set("workspace", &account.workspace)?;
            let quota = if current {
                account.quota.as_ref().map(safe_quota).transpose()?
            } else {
                None
            };
            document.set("quota", &quota)?;
            if current && inventory.claude.active_account_id.as_ref() == Some(&account.account_id) {
                active = Some(document.clone());
            }
            accounts.push(document.source_json()?);
        }
        let mut claude = SourceObject::parse(&SourceJson::from_serializable(
            &json!({"configured":active.is_some(),"active_account_id":inventory.claude.active_account_id,"account_scan":"ok","principal_allowlist_configured":inventory.claude.access.as_ref().is_some_and(|a|!a.allowed_key_ids.is_empty()),"enabled":inventory.claude.enabled}),
        )?)?;
        for field in [
            "credential",
            "workspace",
            "account_id",
            "account_cohort_id",
            "quota",
        ] {
            claude.set(field, &active.as_ref().and_then(|a| a.get(field)))?;
        }
        claude.set(
            "health",
            &active
                .as_ref()
                .and_then(|a| a.get("health"))
                .cloned()
                .unwrap_or(SourceJson::from_serializable(&unknown_health())?),
        )?;
        claude.set("accounts", &accounts)?;
        claude.set("active_reason", &inventory.claude.active_reason)?;
        claude.set("access", &inventory.claude.access)?;
        let mut source = SourceObject::parse(&SourceJson::from_serializable(&body)?)?;
        source.set("claude_code", &claude.source_json()?)?;
        let mut response = AuthResponse::source_json(200, source.source_json()?);
        identity_headers(&mut response, self.host.build_identity()?)?;
        Ok(response)
    }
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn upstream_health_response(&self) -> Result<AuthResponse, GatewayError> {
        let pending = self.active_health.0.borrow().clone();
        if let Some(pending) = pending {
            return pending.await.and_then(active_response);
        }
        let receipt = Completion::new();
        *self.active_health.0.borrow_mut() = Some(receipt.clone());
        let completion = ActiveCompletion {
            state: self.active_health.clone(),
            receipt,
            finished: false,
        };
        let response = async {
            let at = store::now(self.host.as_ref())?;
            let evidence = self.host.probe_upstream_health(at + 3000).await?;
            if !matches!(evidence.codex.provider, ProbeProvider::ChatgptCodex)
                || evidence
                    .metered_quota
                    .as_ref()
                    .is_some_and(|p| !matches!(p.provider, ProbeProvider::MeteredQuota))
                || evidence
                    .claude_subscription
                    .as_ref()
                    .is_some_and(|p| !matches!(p.provider, ProbeProvider::ClaudeSubscription))
            {
                return Err(store::error("Active health probe identity mismatch"));
            }
            let failures: Vec<u16> = [
                Some(evidence.codex.status),
                evidence.metered_quota.as_ref().map(|p| p.status),
            ]
            .into_iter()
            .flatten()
            .filter(|s| *s >= 400)
            .collect();
            let status = if failures.is_empty() {
                200
            } else if failures.contains(&401) {
                401
            } else {
                503
            };
            #[derive(serde::Serialize)]
            struct Probes<'a> {
                codex: &'a ActiveProbe,
                metered_quota: &'a Option<ActiveProbe>,
                claude_subscription: &'a Option<ActiveProbe>,
                claude_workspace: &'a Option<SourceJson>,
            }
            #[derive(serde::Serialize)]
            struct Body<'a> {
                status: u16,
                auth: Option<Value>,
                probes: Probes<'a>,
            }
            let body = gateway_core::source_json::SourceJson::from_serializable(&Body {
                status,
                auth: evidence
                    .auth
                    .as_ref()
                    .map(|a| auth_view(a, self.host.now_ms())),
                probes: Probes {
                    codex: &evidence.codex,
                    metered_quota: &evidence.metered_quota,
                    claude_subscription: &evidence.claude_subscription,
                    claude_workspace: &evidence.claude_workspace,
                },
            })?;
            Ok(ActiveResponseData {
                status,
                body,
                identity: self.host.build_identity()?,
            })
        }
        .await;
        completion.finish(response).and_then(active_response)
    }
}
