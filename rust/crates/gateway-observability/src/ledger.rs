//! Source analytics.ts and admin/error-log.ts. This is the existing request ledger.
use crate::{ObservabilityHost,ObservabilityRuntime,store};
use gateway_core::{GatewayError,lifecycle::DeliveryOutcome,query::QueryStore};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};

pub const REQUEST_RETENTION_MS:i64=365*store::DAY;
pub const ERROR_RETENTION_MS:i64=7*store::DAY;
fn text(value:Option<&Value>,max:usize,fallback:&str)->String{
    let value=value.and_then(Value::as_str).map(store::trim).filter(|s|!s.is_empty()).unwrap_or(fallback);
    let mut units=0;value.chars().take_while(|c|{units+=c.len_utf16();units<=max}).collect()
}
fn integer(value:Option<&Value>,fallback:i64)->i64{
    value.and_then(Value::as_f64).filter(|n|n.is_finite()).map(|n|n.trunc()as i64).unwrap_or(fallback)
}
fn nullable_integer(value:Option<&Value>)->Value{let n=integer(value,-1);if n<0{Value::Null}else{json!(n)}}
pub fn normalize_request_record(input:&Value,key_id:&str,request_id:&str,created_at_ms:i64)->Option<Value>{
    if !input.is_object(){return None}
    let get=|name|input.get(name);
    let provider=match input["provider"].as_str(){Some(p@("cerebras"|"deepseek"|"lithos"|"openrouter"|"voyage"|"surplus"|"metered"))=>p,_=>"chatgpt_codex"};
    let nullable_text=|name|{let s=text(get(name),120,"");if s.is_empty(){Value::Null}else{json!(s)}};
    let mut out=json!({"id":text(get("id"),120,request_id),"key_id":text(get("key_id"),200,key_id),"route":text(get("route"),120,"unknown"),"path":text(get("path"),1024,""),"method":text(get("method"),16,"UNKNOWN").to_uppercase(),"status_code":integer(get("status_code"),0).clamp(0,599),"stream":input["stream"]==true,"model":nullable_text("model"),"reasoning":nullable_text("reasoning"),"created_at_ms":integer(get("created_at_ms"),created_at_ms),"provider":provider,"fallback_reason":nullable_text("fallback_reason"),"provider_request_id":nullable_text("provider_request_id"),"billing_status":match input["billing_status"].as_str(){Some(v@("pending"|"reconciled"|"not_billed"|"unresolved"))=>v,_=>"not_applicable"}});
    for field in ["completed_at_ms","latency_ms","input_tokens","output_tokens","provider_quota","quota_per_credit","spend_microcredits","paid_fallback_window_reset_at_ms"]{out[field]=nullable_integer(get(field));}
    Some(out)
}
#[derive(Clone,Debug,Deserialize,Serialize)]
pub struct ErrorObservation {
    pub request_id:String,pub route:String,pub status:u16,pub provider:String,
    pub model:Option<String>,pub reasoning:Option<String>,pub stream:Option<bool>,
    pub terminal_type:Option<String>,pub failure_kind:Option<String>,pub delivery_outcome:DeliveryOutcome,
    pub created_at_ms:i64,pub latency_ms:i64,pub git_sha:Option<String>,pub deno_revision:Option<String>,
}
impl<S:QueryStore,H:ObservabilityHost> ObservabilityRuntime<S,H>{
    pub async fn record_request_log(&self,key_id:&str,input:&Value)->Result<(),GatewayError>{
        if store::trim(key_id).is_empty(){return Ok(())}
        let at=store::now(self.host.as_ref())?;
        let id=text(input.get("id"),120,&store::uuid(self.host.as_ref())?);
        let created=integer(input.get("created_at_ms"),at);
        self.mutate_request_log(key_id,created,&id,input,false).await
    }
    pub async fn update_request_log(&self,key_id:&str,created_at_ms:i64,request_id:&str,patch:&Value)->Result<(),GatewayError>{
        self.mutate_request_log(key_id,created_at_ms,request_id,patch,true).await
    }
    async fn mutate_request_log(&self,key_id:&str,created:i64,request_id:&str,patch:&Value,only_existing:bool)->Result<(),GatewayError>{
        if store::trim(key_id).is_empty(){return Ok(())}
        let at=store::now(self.host.as_ref())?;
        let key=store::key(json!(["uos_ai","paid_fallback","ledger",key_id,created,request_id]));
        for _ in 0..3{
            let row=self.store.read(&key).await?;
            let existing=store::value(row.as_ref(),at)?.and_then(|v|normalize_request_record(v,key_id,request_id,created));
            if only_existing&&existing.is_none(){return Ok(())}
            let mut next=existing.unwrap_or_else(||json!({}));
            let Some(patch)=patch.as_object()else{return Ok(())};
            for(field,value)in patch{next[field]=value.clone()}
            next["id"]=json!(request_id);next["key_id"]=json!(key_id);next["created_at_ms"]=json!(created);
            let record=normalize_request_record(&next,key_id,request_id,created).expect("object normalized");
            let expiry=created.checked_add(REQUEST_RETENTION_MS).ok_or_else(||store::error("Request retention overflow"))?.max(at+1);
            if store::commit(self.store.as_ref(),vec![store::check(&key,row.as_ref())],vec![store::put(self.host.as_ref(),key.clone(),record,Some(expiry))?]).await?{return Ok(())}
        }
        Err(store::error(format!("paid fallback ledger changed concurrently: {request_id}")))
    }
    pub async fn request_logs(&self,key_id:&str,limit:u32)->Result<Vec<Value>,GatewayError>{
        if store::trim(key_id).is_empty(){return Ok(Vec::new())}
        let at=store::now(self.host.as_ref())?;
        let entries=store::scan(self.store.as_ref(),store::key(json!(["uos_ai","paid_fallback","ledger",key_id])),true,at,limit.clamp(1,100)as usize).await?;
        let mut out=Vec::new();for entry in entries{
            let parts=store::parts(&entry.key)?;let id=text(parts.last(),120,"request");let created=integer(parts.get(parts.len().saturating_sub(2)),at);
            if let Some(record)=normalize_request_record(entry.record.json_value()?,key_id,&id,created){out.push(record)}
        }Ok(out)
    }
    /// Gateway auth401 returns before any KV read/write, preserving the source zero-KV path.
    pub async fn record_admin_error(&self,input:&ErrorObservation)->Result<bool,GatewayError>{
        if input.status==401&&input.provider=="gateway"{return Ok(false)}
        let terminal=input.terminal_type.as_deref();
        let failed=input.status>=400||matches!(terminal,Some("error"|"eof"|"deadline"|"response.failed"|"response.incomplete"))||input.failure_kind.is_some();
        if !failed{return Ok(false)}
        let bounded=|value:Option<&str>,fallback:&str|{let value=value.map(store::trim).filter(|v|!v.is_empty()).unwrap_or(fallback);let mut units=0;value.chars().take_while(|c|{units+=c.len_utf16();units<=160}).collect::<String>()};
        let terminal=bounded(terminal,if input.status>=400{"http.error"}else{"error"});
        let fallback=if input.status>=400{format!("http_{}",input.status)}else{terminal.clone()};
        let failure=bounded(input.failure_kind.as_deref(),&fallback);
        let mut value=serde_json::to_value(input).map_err(|_|store::error("Error observation is invalid"))?;
        value["version"]=json!(1);value["terminal_type"]=json!(terminal);value["failure_kind"]=json!(failure);
        let key=store::key(json!(["uos_ai","admin_error_log","v1",input.created_at_ms,input.request_id]));
        let expiry=store::now(self.host.as_ref())?.checked_add(ERROR_RETENTION_MS).ok_or_else(||store::error("Error retention overflow"))?;
        store::commit(self.store.as_ref(),Vec::new(),vec![store::put(self.host.as_ref(),key,value,Some(expiry))?]).await
    }
}
