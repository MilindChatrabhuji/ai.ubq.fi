use crate::{Context,HealthProvider,HealthTarget,ObservabilityHost,ObservabilityRuntime,health::{aggregate_states,binding_current,unknown_health},host_types::*,store};
use futures_util::{FutureExt,future::{LocalBoxFuture,Shared}};
use gateway_auth::AuthResponse;
use gateway_core::{GatewayError,query::QueryStore};
use serde_json::{Value,json};
use std::{cell::RefCell,rc::Rc};
type ActiveFuture=Shared<LocalBoxFuture<'static,Result<AuthResponse,GatewayError>>>;
#[derive(Clone,Default)]
pub(crate) struct ActiveHealth(Rc<RefCell<Option<ActiveFuture>>>);
fn auth_view(meta:&CodexAuthMetadata,now:i64)->Value{
    let expired=|time:Option<i64>|time.map(|t|t<=now);let refresh=|time:Option<i64>|time.map(|t|t-now<120000);
    let accounts:Vec<Value>=meta.accounts.iter().map(|a|json!({"slot":a.slot,"updated_at_ms":a.updated_at_ms,"access_token_exp_ms":a.access_token_exp_ms,"refresh_sha256":a.refresh_sha256,"native_owner_codex_home":a.native_owner_codex_home,"access_token_expired":expired(a.access_token_exp_ms),"refresh_recommended":refresh(a.access_token_exp_ms)})).collect();
    json!({"source":meta.source,"updated_at_ms":meta.updated_at_ms,"access_token_exp_ms":meta.access_token_exp_ms,"account_count":accounts.len(),"access_token_expired":expired(meta.access_token_exp_ms),"refresh_recommended":refresh(meta.access_token_exp_ms),"accounts":accounts})
}
fn quota_view(snapshot:Option<&Value>)->Value{
    let mut out=json!({"available":snapshot.is_some()});let fields=["cache_state","balance_credits","baseline_credits","remaining_percent","used_percent","unlimited_quota","total_available","total_granted","total_used"];
    for field in fields{out[field]=snapshot.map(|s|s[field].clone()).unwrap_or(Value::Null)}
    let token=snapshot.is_some_and(|s|s["unlimited_quota"]==true||!s["total_available"].is_null()||!s["total_used"].is_null());
    for field in ["observed_at_ms","confidence","cycle_started_at_ms","last_credit_at_ms"]{out[field]=if field!="observed_at_ms"&&token{Value::Null}else{snapshot.map(|s|s["state"][field].clone()).unwrap_or(Value::Null)}}out
}
fn credential_view(credential:&CredentialMetadata)->Value{
    let mut v=serde_json::to_value(credential).expect("metadata serializes");v["expires_at_ms"]=Value::Null;v["refresh_material_present"]=json!(false);v
}
fn safe_quota(quota:&Value)->Value{
    let mut out=json!({});for field in ["windows","standard","representative_claim","blocked_until_ms","block_window","cooldown_until_ms","last_error","updated_at_ms"]{out[field]=quota[field].clone()}out
}
fn identity_headers(response:&mut AuthResponse,identity:BuildIdentity)->Result<(),GatewayError>{
    identity.validate()?;response.headers.insert("x-uos-git-sha".into(),identity.git_sha);response.headers.insert("x-uos-deployment-id".into(),identity.deployment_id);Ok(())
}
impl<S:QueryStore,H:ObservabilityHost> ObservabilityRuntime<S,H>{
    pub async fn passive_provider_response(&self,include_quota:bool,context:Context)->Result<AuthResponse,GatewayError>{
        let inventory=self.host.provider_inventory(&context).await?;let at=store::now(self.host.as_ref())?;
        let auth=auth_view(&inventory.codex,at);let mut codex_accounts=auth["accounts"].as_array().expect("source account array").clone();let mut states=Vec::new();
        for(index,account)in inventory.codex.accounts.iter().enumerate(){let health=self.provider_health(&HealthTarget::codex(&account.account_id),at).await.unwrap_or_else(|_|unknown_health());states.push(health["state"].as_str().unwrap_or("unknown").to_owned());codex_accounts[index]["health"]=health;}
        let states:Vec<&str>=states.iter().map(String::as_str).collect();
        let mut body=json!({"mode":"passive","generated_at_ms":at,"stale_after_ms":crate::health::STALE_AFTER_MS,"codex":{"configured":inventory.codex.source!=CredentialSource::None,"source":inventory.codex.source,"account_count":codex_accounts.len(),"state":aggregate_states(&states),"accounts":codex_accounts}});
        for provider in [HealthProvider::Cerebras,HealthProvider::Deepseek,HealthProvider::Lithos,HealthProvider::Metered,HealthProvider::Openrouter,HealthProvider::Surplus]{
            let health=self.provider_health(&HealthTarget::default_identity(provider),at).await.unwrap_or_else(|_|unknown_health());body[provider.id()]=json!({"configured":inventory.configured.contains(&provider),"health":health});
        }
        body["metered"]["quota_monitoring_configured"]=json!(inventory.quota_monitoring_configured);
        body["metered"]["quota"]=if include_quota{quota_view(inventory.metered_quota.as_ref())}else{json!({"available":inventory.metered_quota.is_some(),"cache_state":inventory.metered_quota.as_ref().map(|v|v["cache_state"].clone()),"observed_at_ms":inventory.metered_quota.as_ref().map(|v|v["state"]["observed_at_ms"].clone())})};
        body["surplus"]["quota_monitoring_configured"]=json!(false);body["surplus"]["quota"]=if include_quota{let mut q=quota_view(None);q["source"]=json!("not_reported");q}else{json!({"available":false,"observed_at_ms":null})};
        let mut gateway_health=unknown_health();gateway_health["state"]=json!(if inventory.ubiquity_configured{"healthy"}else{"unknown"});gateway_health["stale"]=json!(false);body["ubiquity"]=json!({"configured":inventory.ubiquity_configured,"health":gateway_health});
        let mut accounts=Vec::new();for account in &inventory.claude.accounts{
            if account.target.provider!=HealthProvider::ClaudeCode{return Err(store::error("Claude health target provider mismatch"))}
            let current=binding_current(self.store.as_ref(),&account.target).await.unwrap_or(false);
            let health=if current{self.provider_health(&account.target,at).await.unwrap_or_else(|_|unknown_health())}else{unknown_health()};
            accounts.push(json!({"account_id":account.account_id,"account_cohort_id":account.account_cohort_id,"label":account.label,"credential":credential_view(&account.credential),"workspace":account.workspace,"active":inventory.claude.active_account_id.as_ref()==Some(&account.account_id),"stale":!current,"quota":if current{account.quota.as_ref().map(safe_quota)}else{None},"health":health,"capabilities":{"identity_verified":false,"can_refresh":false,"can_reset_upstream_quota":false}}));
        }
        let active=accounts.iter().find(|a|a["account_id"].as_str()==inventory.claude.active_account_id.as_deref()&&a["stale"]!=true);
        body["claude_code"]=json!({"configured":active.is_some(),"credential":active.map(|a|a["credential"].clone()),"workspace":active.map(|a|a["workspace"].clone()),"account_id":active.map(|a|a["account_id"].clone()),"account_cohort_id":active.map(|a|a["account_cohort_id"].clone()),"accounts":accounts,"active_account_id":inventory.claude.active_account_id,"active_reason":inventory.claude.active_reason,"account_scan":"ok","access":inventory.claude.access,"principal_allowlist_configured":inventory.claude.access.as_ref().is_some_and(|a|!a.allowed_key_ids.is_empty()),"enabled":inventory.claude.enabled,"quota":active.map(|a|a["quota"].clone()),"health":active.map(|a|a["health"].clone()).unwrap_or_else(unknown_health)});
        let mut response=AuthResponse::json(200,body);identity_headers(&mut response,self.host.build_identity()?)?;Ok(response)
    }
}
impl<S:QueryStore+'static,H:ObservabilityHost+'static> ObservabilityRuntime<S,H>{
    pub async fn upstream_health_response(&self)->Result<AuthResponse,GatewayError>{
        let pending=self.active_health.0.borrow().clone();if let Some(pending)=pending{return pending.await}
        let runtime=self.clone();let future=async move{
            let response=async{
            let at=store::now(runtime.host.as_ref())?;let evidence=runtime.host.probe_upstream_health(at+3000).await?;
            if !matches!(evidence.codex.provider,ProbeProvider::ChatgptCodex)||evidence.metered_quota.as_ref().is_some_and(|p|!matches!(p.provider,ProbeProvider::MeteredQuota))||evidence.claude_subscription.as_ref().is_some_and(|p|!matches!(p.provider,ProbeProvider::ClaudeSubscription)){return Err(store::error("Active health probe identity mismatch"))}
            let failures:Vec<u16>=[Some(evidence.codex.status),evidence.metered_quota.as_ref().map(|p|p.status)].into_iter().flatten().filter(|s|*s>=400).collect();let status=if failures.is_empty(){200}else if failures.contains(&401){401}else{503};
            let body=json!({"status":status,"auth":evidence.auth.as_ref().map(|a|auth_view(a,runtime.host.now_ms())),"probes":{"codex":evidence.codex,"metered_quota":evidence.metered_quota,"claude_subscription":evidence.claude_subscription,"claude_workspace":evidence.claude_workspace}});
            let mut response=AuthResponse::json(status,body);identity_headers(&mut response,runtime.host.build_identity()?)?;Ok(response)
            }.await;
            runtime.active_health.0.borrow_mut().take();response
        }.boxed_local().shared();
        *self.active_health.0.borrow_mut()=Some(future.clone());future.await
    }
}
