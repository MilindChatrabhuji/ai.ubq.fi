use crate::{AdminRuntime,capabilities::RuntimeCapabilities,store};
use gateway_admin::PaidKeyFields;
use gateway_auth::{AuthHost,conflict,invalid,store::{check,commit,put}};
use gateway_authority::{keys,paid::{PaidAttempt,PaidWindow,ReconciliationGate}};
use gateway_core::{GatewayError,identity::MAX_SAFE_INTEGER,lifecycle::BillingState,query::QueryStore,state::{RecordMutation,RevisionCheck}};
use gateway_schema::{catalog_store::codex_snapshot_key,snapshot::ModelSnapshot};
use serde_json::{Value,json};
use std::collections::{BTreeMap,BTreeSet};

fn pricing_error(message:&str)->GatewayError{GatewayError::unavailable(message,"metered_pricing_invalid")}
fn outstanding()->GatewayError{GatewayError::new(409,"Cannot delete API key while metered billing is pending or unresolved",Some("paid_fallback_billing_outstanding"))}

impl<S:QueryStore,H:AuthHost,C:RuntimeCapabilities> AdminRuntime<'_,S,H,C>{
    pub(crate) async fn paid_policy(&self,body:&Value)->Result<PaidKeyFields,GatewayError>{
        if body.get("paid_fallback_enabled").is_some_and(|v|!v.is_boolean()){return Err(invalid("paid_fallback_enabled must be a boolean"))}
        let enabled=body.get("paid_fallback_enabled")==Some(&Value::Bool(true));
        let limit=match body.get("paid_fallback_limit_credits"){
            None=>0,
            Some(v)=>{let credits=v.as_f64().filter(|n|n.is_finite() && (*n>=0.0 || *n == -1.0)).ok_or_else(||invalid("paid_fallback_limit_credits must be a non-negative number or -1"))?;
                if credits == -1.0{-1}else{let micro=(credits*1000000.0).round();if micro>MAX_SAFE_INTEGER as f64{return Err(invalid("paid_fallback_limit_credits must be a non-negative number or -1"))}micro as i64}}
        };
        if enabled && limit==0{return Err(invalid("paid_fallback_limit_credits must be positive or -1 when paid fallback is enabled"))}
        if !enabled{let mut result=PaidKeyFields::disabled();result.limit_microcredits=limit;result.quota_per_credit=0;return Ok(result)}
        let snapshot:ModelSnapshot=store::read(self.store,&codex_snapshot_key(),self.host.now_ms()).await?.map(|v|serde_json::from_value(v).map_err(|_|pricing_error("Stored full Codex model catalog is invalid"))).transpose()?.ok_or_else(||pricing_error("Metered paid fallback cannot be enabled before the Codex model catalog is initialized."))?;
        let mut models=Vec::new();let mut seen=BTreeSet::new();let mut contexts=BTreeMap::new();
        for model in snapshot.models{
            let id=["slug","id","model","name"].into_iter().find_map(|field|model.get(field).and_then(Value::as_str)).map(str::trim).filter(|s|!s.is_empty());
            let Some(id)=id else{continue};if !seen.insert(id.to_owned()){continue}models.push(id.to_owned());
            let context=["context_window","max_context_window","auto_compact_token_limit"].into_iter().filter_map(|field|model.get(field).and_then(Value::as_i64).filter(|n|*n>0 && *n<=MAX_SAFE_INTEGER)).max();
            if let Some(context)=context{contexts.insert(id.to_owned(),context);}
        }
        if models.is_empty(){return Err(pricing_error("Metered paid fallback cannot be enabled before the Codex model catalog is initialized."))}
        let pricing=self.capabilities.pricing(&models).await?;
        if pricing.eligible_model_ids.is_empty() || pricing.quota_per_credit<=0 || pricing.quota_per_credit>MAX_SAFE_INTEGER || pricing.checked_at_ms<=0 || pricing.checked_at_ms>self.host.now_ms(){return Err(pricing_error("Metered paid fallback found no valid current pricing."))}
        let mut exposure=BTreeMap::new();let mut eligible=BTreeSet::new();
        for model in &pricing.eligible_model_ids{
            if !seen.contains(model) || !eligible.insert(model.clone()){return Err(pricing_error("Paid pricing contains an unadvertised or duplicate model."))}
            let context=contexts.get(model).copied().ok_or_else(||pricing_error("Metered paid fallback cannot be enabled because a priced Codex model has no finite context bound."))?;
            let coefficient=pricing.model_quota_coefficients.get(model).copied().filter(|n|n.is_finite() && *n>0.0).ok_or_else(||pricing_error("Paid model pricing coefficient is invalid."))?;
            let maximum=(context as f64*coefficient*1000000.0/pricing.quota_per_credit as f64).ceil();
            if !maximum.is_finite() || maximum<=0.0 || maximum>MAX_SAFE_INTEGER as f64{return Err(pricing_error("Paid model exposure is not a finite positive credit bound."))}
            exposure.insert(model.clone(),maximum as i64);
        }
        Ok(PaidKeyFields{enabled:true,limit_microcredits:limit,model_ids:pricing.eligible_model_ids,quota_per_credit:pricing.quota_per_credit,max_exposure_microcredits:exposure,pricing_checked_at_ms:Some(pricing.checked_at_ms)})
    }
    pub(crate) async fn prepare_deletion(&self,id:&str)->Result<Vec<RevisionCheck>,GatewayError>{
        let now=self.host.now_ms();let id_key=gateway_auth::api_keys::id_key(id);let id_row=self.store.read(&id_key).await?;
        let value=store::value(id_row.as_ref(),now)?.ok_or_else(||GatewayError::new(404,"Not found",Some("not_found")))?;
        if value.get("revoked_at_ms").is_none_or(Value::is_null){return Err(invalid("Only revoked keys can be deleted"))}
        let dk=keys::paid_deletion(id);let prior=self.store.read(&dk).await?;
        let key_revision=id_row.as_ref().map(|r|r.revision.as_str()).expect("existing key row");
        let mut newly_claimed=false;
        let guard=if let Some(row)=prior{
            if row.json_value()?.get("key_revision").and_then(Value::as_str)!=Some(key_revision){return Err(GatewayError::new(409,"API key deletion already has an owner",Some("paid_fallback_deletion_in_progress")))}row
        }else{
            let revision=store::revision(self.host)?;
            let guard=json!({"created_at_ms":now,"key_revision":key_revision,"owner":revision});
            if !commit(self.store,vec![check(&dk,None),check(&id_key,id_row.as_ref())],vec![put(dk.clone(),&guard,None,&revision)?]).await?{return Err(conflict("API key deletion was claimed concurrently"))}
            let row=self.store.read(&dk).await?.filter(|r|r.revision==revision).ok_or_else(||store::corrupt("Paid deletion guard changed after claim"))?;
            newly_claimed=true;row
        };
        let result=async{
            let gate_key=keys::paid_gate();let gate_row=self.store.read(&gate_key).await?;
            let gate:ReconciliationGate=store::value(gate_row.as_ref(),now)?.map(|v|serde_json::from_value(v).map_err(|_|outstanding())).transpose()?.unwrap_or_default();
            if gate.pending.values().any(|p|p.key_id.0==id){return Err(outstanding())}
            let pending=store::scan(self.store,store::key(json!(["uos_ai","paid_fallback","v3","pending",id])),false,now).await?;
            if !pending.is_empty(){return Err(outstanding())}
            let attempts=store::scan(self.store,store::key(json!(["uos_ai","paid_fallback","v3","request",id])),false,now).await?;
            let windows=store::scan(self.store,store::key(json!(["uos_ai","paid_fallback","v3","window",id])),false,now).await?;
            let mut fences=vec![check(&dk,Some(&guard)),check(&gate_key,gate_row.as_ref())];
            for entry in &attempts{
                let row:PaidAttempt=serde_json::from_value(entry.record.json_value()?.clone()).map_err(|_|outstanding())?;
                if row.v!=3 || row.reservation.key_id.0!=id || entry.key!=keys::paid_attempt(id,&row.reservation.attempt_id.0) || matches!(row.billing_state,BillingState::Pending|BillingState::Unresolved){return Err(outstanding())}
                fences.push(check(&entry.key,Some(&entry.record)));
            }
            for entry in &windows{
                let row:PaidWindow=serde_json::from_value(entry.record.json_value()?.clone()).map_err(|_|outstanding())?;
                if row.v!=3 || row.key_id.0!=id || entry.key!=keys::paid_window(id,row.window_reset_at_ms) || row.pending_count!=0 || row.reserved_microcredits!=0 || row.settled_microcredits<0{return Err(outstanding())}
                fences.push(check(&entry.key,Some(&entry.record)));
            }
            // The shared guard prevents new paid reservations during this scan. Keep all ledger
            // revisions in the key-deletion CAS; cleanup is the same authority owner's next event.
            Ok(fences)
        }.await;
        if result.is_err() && newly_claimed{
            commit(self.store,vec![check(&dk,Some(&guard))],vec![RecordMutation::Delete{key:dk}]).await?;
        }
        result
    }
}
