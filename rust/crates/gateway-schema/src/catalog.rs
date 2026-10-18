//! Catalog assembly consumes observations; network, authentication and refresh are adapter-owned.
use std::collections::BTreeMap;
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use gateway_core::GatewayError;
use crate::{aliases::*,metadata::*,reasoning::ModelReasoning,selection::*,snapshot::ModelSnapshot,util::*};
pub use crate::catalog_views::{ordinary_models,capabilities,public_catalog,build_catalog_snapshot};
pub use crate::native_catalog::{native_catalog,native_catalog_fallback};
#[derive(Clone,Debug,Default,PartialEq,Serialize,Deserialize)]
pub struct ProviderCatalog{pub models:Vec<Value>,pub updated_at_ms:Option<i64>,pub configured:bool,pub available:bool,pub stale:bool}
#[derive(Clone,Debug,Default)]
pub struct CatalogInput{
    pub snapshot:Option<ModelSnapshot>,pub full_snapshot:Option<ModelSnapshot>,pub providers:BTreeMap<String,ProviderCatalog>,pub enrichment:BTreeMap<String,MetadataHint>,pub selection:Option<ProviderSelection>,pub whitelist:Option<ModelWhitelist>,
}
impl CatalogInput{
    pub fn enabled(&self,provider:&str)->bool{ProviderSelection::enabled(self.selection.as_ref(),provider)}
    pub fn configured(&self,provider:&str)->bool{self.providers.get(provider).is_some_and(|p|p.configured)}
    pub fn rows(&self,provider:&str)->&[Value]{self.providers.get(provider).map(|p|p.models.as_slice()).unwrap_or(&[])}
    pub fn available_rows(&self,provider:&str)->&[Value]{if self.enabled(provider){self.rows(provider)}else{&[]}}
    pub fn codex(&self)->Option<&ModelSnapshot>{self.full_snapshot.as_ref().or(self.snapshot.as_ref())}
    pub fn metadata(&self,id:&str,codex:Option<&Value>,provider:Option<MetadataHint>,subscription:bool)->ResolvedMetadata{resolve_metadata(&MetadataSources{codex:codex.map(MetadataHint::codex),subscription:subscription.then(MetadataHint::subscription),provider,openrouter:self.enrichment.get(id).cloned()})}
    pub fn synthetic_configured(&self)->bool{FLASH_ORDER.iter().any(|p|self.configured(p))}
    pub fn synthetic_enabled(&self)->bool{self.enabled("ubiquity")&&self.synthetic_configured()}
}
pub fn endpoint_paths(model:&Value)->Vec<String>{let types=model.get("supported_endpoint_types").and_then(Value::as_array);let has=|key|types.is_some_and(|t|t.iter().any(|v|v.as_str()==Some(key)));let mut paths=Vec::new();if has("openai-response"){paths.push("/v1/responses".into());}if has("openai"){paths.push("/v1/chat/completions".into());}paths}
pub fn endpoint_supports(model:&Value,endpoint:&str)->bool{model.get("supported_endpoint_types").and_then(Value::as_array).is_some_and(|types|types.iter().any(|v|v.as_str()==Some(endpoint)))}
pub fn model_list_row(record:&Value,fallback_created:i64)->Option<Value>{
    let id=["id","slug","model","name"].iter().find_map(|key|record.get(key).and_then(Value::as_str))?;if id.is_empty(){return None;}
    Some(json!({"id":id,"object":"model","created":nonnegative_truncated(record.get("created")).unwrap_or(fallback_created),"owned_by":record.get("owned_by").and_then(Value::as_str).unwrap_or("openai")}))
}
pub fn normalize_model_list(payload:&Value)->Option<Value>{
    if !is_record(payload){return None;}let fallback=payload.get("updated_at_ms").and_then(Value::as_f64).filter(|n|n.is_finite()).map(|n|(n/1000.0).trunc().max(0.0) as i64).unwrap_or(0);
    let rows=payload.get("data").and_then(Value::as_array).or_else(||payload.get("models").and_then(Value::as_array))?;Some(json!({"object":"list","data":rows.iter().filter_map(|r|model_list_row(r,fallback)).collect::<Vec<_>>()}))
}
pub fn append_unique(rows:&mut Vec<Value>,new_rows:impl IntoIterator<Item=Value>,key:&str){for row in new_rows{let id=row.get(key);if !rows.iter().any(|r|r.get(key)==id){rows.push(row);}}}
pub fn filter_whitelist(rows:Vec<Value>,whitelist:Option<&ModelWhitelist>,native:bool)->Vec<Value>{rows.into_iter().filter(|r|{let id=if native{identifier(r)}else{r.get("id").and_then(Value::as_str)};id.is_some_and(|id|ModelWhitelist::permits(whitelist,if native{id.trim_matches(crate::util::js_whitespace)}else{id}))}).collect()}
pub fn claude_levels(model:&Value)->Vec<String>{let mut levels=Vec::new();if model.get("supports_disabled_thinking")==Some(&Value::Bool(true)){levels.push("none".into());}if let Some(raw)=model.get("supported_reasoning_levels").and_then(Value::as_array){levels.extend(raw.iter().filter_map(|v|v.as_str().map(str::to_owned)));}levels}
#[derive(Clone,Debug,PartialEq)]
pub struct RequestModelMetadata{pub snapshot:Option<ModelSnapshot>,pub record:Option<Value>,pub reasoning:ModelReasoning,pub supported_endpoints:Option<Vec<String>>}
pub fn request_model_metadata(input:&CatalogInput,model:&str,responses:bool,now_ms:i64)->RequestModelMetadata{
    if model=="glm-5.2"{let record=json!({"slug":"glm-5.2"});return RequestModelMetadata{snapshot:None,reasoning:ModelReasoning::from_record(Some(&record)),record:Some(record),supported_endpoints:Some(vec!["openai".into(),"openai-response".into()])};}
    let snapshot=input.snapshot.clone();if let Some(record)=snapshot.as_ref().and_then(|s|s.find(model)).cloned(){return RequestModelMetadata{snapshot,reasoning:ModelReasoning::from_record(Some(&record)),record:Some(record),supported_endpoints:None};}
    if input.enabled("claude_code"){if let Some(model)=input.rows("claude_code").iter().find(|r|r.get("id").and_then(Value::as_str)==Some(model)){let mut record=json!({"slug":model["id"],"supported_reasoning_levels":claude_levels(model)});if model.get("supports_disabled_thinking")==Some(&Value::Bool(true)){record["default_reasoning_level"]=json!("none");}return RequestModelMetadata{snapshot,reasoning:ModelReasoning::from_record(Some(&record)),record:Some(record),supported_endpoints:Some(vec!["openai".into(),"openai-response".into()])};}}
    let endpoint=if responses{"openai-response"}else{"openai"};let candidates:Vec<_>=["openlux","surplus"].iter().filter_map(|provider|input.rows(provider).iter().find(|r|r.get("id").and_then(Value::as_str)==Some(model)).map(|r|(*provider,r))).collect();
    if let Some((provider,paid))=candidates.iter().find(|(_,m)|endpoint_supports(m,endpoint)).or_else(||candidates.first()){
        let record=json!({"slug":model,"supported_reasoning_levels":["none"],"default_reasoning_level":"none"});let snapshot=snapshot.or_else(||Some(ModelSnapshot{models:Vec::new(),source:if *provider=="openlux"{"metered"}else{"surplus"}.into(),updated_at_ms:input.providers.get(*provider).and_then(|p|p.updated_at_ms).unwrap_or(now_ms),client_version:None}));
        return RequestModelMetadata{snapshot,reasoning:ModelReasoning::from_record(Some(&record)),record:Some(record),supported_endpoints:paid.get("supported_endpoint_types").and_then(Value::as_array).map(|a|a.iter().filter_map(|v|v.as_str().map(str::to_owned)).collect())};
    }
    RequestModelMetadata{snapshot,record:None,reasoning:ModelReasoning::default(),supported_endpoints:None}
}
pub fn validate_model_available(model:&str,responses:bool,metadata:&RequestModelMetadata)->Result<(),GatewayError>{
    let route=if responses{"responses"}else{"chat.completions"};let endpoint=if responses{"openai-response"}else{"openai"};
    let message=if metadata.supported_endpoints.as_ref().is_some_and(|e|!e.iter().any(|e|e==endpoint)){Some(format!("The model '{model}' does not support {route}. Use /v1/models for supported models."))}
    else if metadata.snapshot.as_ref().is_some_and(|s|!s.models.is_empty())&&metadata.record.is_none()&&model.trim_matches(crate::util::js_whitespace)!="gpt-reserve"{Some(format!("The model '{model}' does not exist or is not available through this gateway. Use /v1/models for supported models."))}else{None};
    match message{Some(message)=>Err(GatewayError::new(404,message,Some("model_not_found")).with_param(Some("model"))),None=>Ok(())}
}
