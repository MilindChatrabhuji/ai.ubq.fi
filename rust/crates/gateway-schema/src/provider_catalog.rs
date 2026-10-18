//! Provider-declared catalog projections; credentials/configuration are injected observations.
use serde_json::{Value,json};
use crate::{aliases::*,catalog::*,metadata::*,util::*};
pub const CEREBRAS_IDS:&[&str]=&["gpt-oss-120b","qwen-3.8-27b"];
pub fn provider_hint(provider:&str,id:&str)->MetadataHint{match provider{
    "deepseek"=>MetadataHint::provider(1_000_000,&["none","low","high","max"],"high"),
    "cerebras" if id=="qwen-3.8-27b"=>MetadataHint::provider(131_072,&["none","low","medium","high"],"high"),
    "cerebras"=>MetadataHint::provider(131_072,&["low","medium","high"],"medium"),
    "lithos"=>MetadataHint{effective_context_window_percent:Some(100),..MetadataHint::provider(1_048_576,&["none","minimal","low","medium","high","xhigh","max"],"medium")},
    "ubiquity"=>MetadataHint{auto_compact_token_limit_tokens:Some(891_289),effective_context_window_percent:Some(95),..MetadataHint::provider(1_048_576,&["low","high","max"],"high")},
    _=>MetadataHint::default()
}}
pub fn display_name(provider:&str,id:&str)->String{match(provider,id){
    ("deepseek","deepseek-flash")=>"DeepSeek Flash".into(),("deepseek","deepseek-v4-flash")=>"DeepSeek Flash (legacy id)".into(),("deepseek","deepseek-v4-pro")=>"DeepSeek Pro".into(),
    ("cerebras","gpt-oss-120b")=>"GPT-OSS 120B".into(),("cerebras","qwen-3.8-27b")=>"Qwen 3.8 27B".into(),("ubiquity",_)=>"Ubiquity DeepSeek Flash".into(),
    ("lithos",_)=>{let base=if id.contains("DeepSeek"){"LithosAI DeepSeek V4.1 Flash"}else{"LithosAI Kimi K3"};let suffix=if id.ends_with("-ultra-chat"){" (ultra, chat)"}else if id.ends_with("-ultra"){" (ultra)"}else if id.ends_with("-fast"){" (fast)"}else{""};format!("{base}{suffix}")},_=>id.into()}}
pub fn provider_ids(provider:&str)->&'static[&'static str]{match provider{"deepseek"=>DEEPSEEK_IDS,"lithos"=>LITHOS_IDS,"cerebras"=>CEREBRAS_IDS,"ubiquity"=>&[SYNTHETIC_MODEL],_=>&[]}}
pub fn configured_model_rows(input:&CatalogInput,provider:&str)->Vec<Value>{
    if !input.enabled(provider)||(provider=="ubiquity"&&!input.synthetic_configured())||(provider!="ubiquity"&&!input.configured(provider)){return Vec::new();}
    provider_ids(provider).iter().map(|id|json!({"id":id,"object":"model","created":if provider=="ubiquity"{1_791_244_800i64}else{0},"owned_by":provider})).collect()
}
pub fn apply_resolved_fields(row:&mut Value,resolved:&ResolvedMetadata,native:bool,include_nulls:bool){
    for(key,value)in[(if native{"context_window"}else{"context_window_tokens"},resolved.context_window_tokens),(if native{"max_context_window"}else{"max_context_window_tokens"},resolved.max_context_window_tokens),(if native{"auto_compact_token_limit"}else{"auto_compact_token_limit_tokens"},resolved.auto_compact_token_limit_tokens),("effective_context_window_percent",resolved.effective_context_window_percent)]{if let Some(v)=value{row[key]=json!(v);}else if include_nulls&&key!="effective_context_window_percent"{row[key]=Value::Null;}}
}
pub fn configured_capabilities(input:&CatalogInput,provider:&str)->Vec<Value>{
    configured_model_rows(input,provider).iter().filter_map(|model|{
        let id=model["id"].as_str()?;let hint=provider_hint(provider,id);let mut resolved=input.metadata(id,None,Some(hint.clone()),false);
        if provider=="ubiquity"{resolved=resolve_metadata(&MetadataSources{provider:Some(hint.clone()),..MetadataSources::default()});}
        let endpoints=if provider=="cerebras"{vec!["/v1/chat/completions"]}else if provider=="ubiquity"{vec!["/v1/responses"]}else{vec!["/v1/chat/completions","/v1/responses"]};
        let mut row=json!({"id":id,"object":"uos.model_capabilities","owned_by":provider,"display_name":display_name(provider,id),"upstream_provider":provider,"supported_endpoints":endpoints,"supported_reasoning_levels":hint.supported_reasoning_levels.as_ref().unwrap_or(&Vec::new()),"default_reasoning_effort":hint.default_reasoning_effort,"reasoning_effort_wire_map":{}});
        apply_resolved_fields(&mut row,&resolved,false,true);row["context_source"]=json!(resolved.context_source);if provider=="deepseek"{row["reasoning_effort_wire_map"]=json!({"ultra":"max"});}
if provider=="ubiquity"{row["context_source"]=json!("openrouter");row["reasoning_source"]=json!("provider_discovery");}Some(row)
    }).collect()
}
pub fn openrouter_models(input:&CatalogInput)->Vec<Value>{
    if !input.enabled("openrouter")||!input.configured("openrouter"){return Vec::new();}
    let mut rows:Vec<_>=input.rows("openrouter").iter().filter_map(|r|r.get("id").and_then(Value::as_str)).map(|id|json!({"id":id,"object":"model","created":0,"owned_by":id.split('/').next().filter(|s|!s.is_empty()).unwrap_or("openrouter")})).collect();
    append_unique(&mut rows,[json!({"id":"typesafe/jev-latest","object":"model","created":0,"owned_by":"typesafe"})],"id");rows
}
pub fn openrouter_capabilities(input:&CatalogInput)->Vec<Value>{
    openrouter_models(input).iter().map(|model|{let id=model["id"].as_str().unwrap_or("");let jev=id=="typesafe/jev-latest";let resolved=input.metadata(id,None,None,false);let mut row=json!({"id":id,"object":"uos.model_capabilities","owned_by":model["owned_by"],"display_name":if jev{"Jev (Typesafe System One decisions)"}else{id},"upstream_provider":"openrouter","supported_endpoints":if jev&&!input.rows("openrouter").iter().any(|r|r.get("id").and_then(Value::as_str)==Some(id)){vec!["/v1/systemone"]}else{vec!["/v1/responses","/v1/chat/completions"]},"supported_reasoning_levels":if jev{vec!["none".to_owned()]}else{resolved.supported_reasoning_levels.clone().unwrap_or_else(||vec!["none".into()])},"reasoning_effort_wire_map":{}});
        if jev{row["default_reasoning_effort"]=json!("none");for key in ["context_window_tokens","max_context_window_tokens","auto_compact_token_limit_tokens"]{row[key]=Value::Null;}row["context_source"]=json!("unknown");row["reasoning_source"]=json!("unknown");}
        else{if let Some(default)=&resolved.default_reasoning_effort{row["default_reasoning_effort"]=json!(default);}else if resolved.supported_reasoning_levels.is_none(){row["default_reasoning_effort"]=json!("none");}apply_resolved_fields(&mut row,&resolved,false,true);row["context_source"]=json!(resolved.context_source);row["reasoning_source"]=json!(resolved.reasoning_source);}row
    }).collect()
}
pub fn normalized_codex_capability(input:&CatalogInput,record:&Value)->Option<Value>{
    let id=identifier(record)?.trim_matches(crate::util::js_whitespace);if id.is_empty(){return None;}let reasoning=crate::reasoning::ModelReasoning::from_record(Some(record));let resolved=input.metadata(id,Some(record),None,true);
    let mut row=json!({"id":id,"object":"uos.model_capabilities","owned_by":record.get("owned_by").and_then(Value::as_str).unwrap_or("openai"),"display_name":record.get("display_name").cloned().unwrap_or(Value::Null),"upstream_provider":"codex_chatgpt","supported_endpoints":["/v1/chat/completions","/v1/responses"],"supported_reasoning_levels":reasoning.levels,"default_reasoning_effort":reasoning.default_level,"reasoning_effort_wire_map":reasoning.wire_efforts});
    apply_resolved_fields(&mut row,&resolved,false,true);row["context_source"]=json!(resolved.context_source);row["reasoning_source"]=json!(resolved.reasoning_source);if let Some(cache)=crate::prompt_cache::normalize_capabilities(record.get("prompt_cache")){row["prompt_cache"]=cache;}Some(row)
}
