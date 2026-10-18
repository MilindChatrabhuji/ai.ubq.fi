//! Observed prompt cache metadata is distinct from the official request control schema.
use gateway_core::GatewayError;
use serde_json::{Map,Value,json};
use crate::util::*;
pub const SCOPE_PROFILE:&str="responses_implicit_input_text_keyed_cycle_isolated_v5";
pub const CODEX_PROVIDER:&str="codex_chatgpt";
pub fn normalize_breakpoint(value:Option<&Value>,param:&str)->Result<Option<Value>,GatewayError>{
    let Some(value)=value else{return Ok(None)};
    if !value.is_object(){return Err(invalid(format!("{param} must be an object"),Some(param)));}
    if let Some(key)=unknown_key(value,&["mode"]){return Err(invalid(format!("Unknown cache breakpoint field: {key}"),Some(&format!("{param}.{key}"))));}
    if value.get("mode").and_then(Value::as_str)!=Some("explicit"){return Err(invalid(format!("{param}.mode must be explicit"),Some(&format!("{param}.mode"))));}
    Ok(Some(json!({"mode":"explicit"})))
}
pub fn validate_prompt_cache_controls(body:&Value)->Result<(),GatewayError>{
    if body.get("prompt_cache_key").is_some_and(|v|!v.is_string()){return Err(invalid("prompt_cache_key must be a string",Some("prompt_cache_key")));}
    if let Some(options)=body.get("prompt_cache_options"){
        if !options.is_object(){return Err(invalid("prompt_cache_options must be an object",Some("prompt_cache_options")));}
        if let Some(key)=unknown_key(options,&["mode","ttl"]){return Err(invalid(format!("Unknown prompt cache option: {key}"),Some(&format!("prompt_cache_options.{key}"))));}
        if options.get("mode").is_some_and(|v|!matches!(v.as_str(),Some("implicit"|"explicit"))){return Err(invalid("prompt_cache_options.mode must be implicit or explicit",Some("prompt_cache_options.mode")));}
        if options.get("ttl").is_some_and(|v|v.as_str()!=Some("30m")){return Err(invalid("prompt_cache_options.ttl must be 30m",Some("prompt_cache_options.ttl")));}
    }
    if body.get("prompt_cache_retention").is_some_and(|v|!matches!(v.as_str(),Some("in_memory"|"24h"))){return Err(invalid("prompt_cache_retention must be in_memory or 24h",Some("prompt_cache_retention")));}
    Ok(())
}
fn enum_list(value:&Value,allowed:Option<&[&str]>,filter:bool)->Option<Vec<Value>>{
    let values=value.as_array()?;let mut result=Vec::new();
    for value in values{
        let text=if filter{value.as_str()?.trim_matches(crate::util::js_whitespace)}else{value.as_str()?};if text.is_empty(){return None;}
        if let Some(allowed)=allowed && !allowed.contains(&text){if filter{continue;}return None;}
        let item=Value::String(text.to_owned());if !result.contains(&item){result.push(item);}
    }Some(result)
}
fn timestamp(value:Option<&Value>)->Option<i64>{value.and_then(safe_integer).filter(|n|*n>=0)}
fn normalize_block_types(value:&Value)->Option<Value>{
    if !value.is_object()||unknown_key(value,&["responses","chat_completions"]).is_some(){return None;}
    let mut result=Map::new();for(endpoint,allowed)in[("responses",&["input_text","input_image","input_file"][..]),("chat_completions",&["text","image_url","file"][..])]{
        if let Some(list)=value.get(endpoint){let entries=enum_list(list,Some(allowed),true)?;if !entries.is_empty(){result.insert(endpoint.into(),Value::Array(entries));}}
    }(!result.is_empty()).then_some(Value::Object(result))
}
fn normalize_controls(value:&Value)->Option<Value>{
    if !value.is_object()||unknown_key(value,&["key","implicit","explicit_breakpoints","modes","ttls","legacy_retentions","breakpoint_block_types","expected_usage_fields","source","verified_at_ms"]).is_some(){return None;}
    let source=value.get("source")?.as_str()?;if !["catalog","live_probe","inferred"].contains(&source){return None;}
    let time=timestamp(value.get("verified_at_ms"))?;let mut result=Map::new();
    for key in ["key","implicit","explicit_breakpoints"]{if let Some(v)=value.get(key){if !v.is_boolean(){return None;}result.insert(key.into(),v.clone());}}
    for(key,allowed,filter,omit_empty)in[("modes",&["implicit","explicit"][..],false,false),("ttls",&["30m"][..],true,true),("legacy_retentions",&["in_memory","24h"][..],true,true),("expected_usage_fields",&["cached_tokens","cache_write_tokens"][..],false,false)]{
        if let Some(v)=value.get(key){let list=enum_list(v,Some(allowed),filter)?;if !omit_empty||!list.is_empty(){result.insert(key.into(),Value::Array(list));}}
    }
    if let Some(v)=value.get("breakpoint_block_types"){result.insert("breakpoint_block_types".into(),normalize_block_types(v)?);}
    result.insert("source".into(),Value::String(source.into()));result.insert("verified_at_ms".into(),json!(time));Some(Value::Object(result))
}
pub fn normalize_scope(value:&Value)->Option<Value>{
    if !value.is_object()||unknown_key(value,&["probe_profile","account_slots","token_refresh","conversation_id","effective_model","reproducible_cycles","source","verified_at_ms"]).is_some(){return None;}
    if value.get("probe_profile").and_then(Value::as_str)!=Some(SCOPE_PROFILE)||value.get("source").and_then(Value::as_str)!=Some("live_probe"){return None;}
    for(key,allowed)in[("account_slots",&["shared","account_scoped","unknown"][..]),("token_refresh",&["preserved","changed","unknown"][..]),("conversation_id",&["independent","scoped","unknown"][..])]{if !value.get(key).and_then(Value::as_str).is_some_and(|s|allowed.contains(&s)){return None;}}
    let cycles=timestamp(value.get("reproducible_cycles"))?;if cycles<3{return None;}let time=timestamp(value.get("verified_at_ms"))?;
    let mut next=json!({"probe_profile":SCOPE_PROFILE,"account_slots":value["account_slots"],"token_refresh":value["token_refresh"],"conversation_id":value["conversation_id"]});
    if value.get("effective_model").is_some(){next["effective_model"]=Value::String(normalized_string(value.get("effective_model"))?);}
    next["reproducible_cycles"]=json!(cycles);next["source"]=json!("live_probe");next["verified_at_ms"]=json!(time);Some(next)
}
pub fn normalize_capabilities(value:Option<&Value>)->Option<Value>{
    let value=value?;if value==&Value::Bool(false){return Some(Value::Bool(false));}
    if !value.is_object()||unknown_key(value,&["version","providers"]).is_some()||value.get("version").and_then(safe_integer)!=Some(1){return None;}
    let providers=value.get("providers")?.as_array()?;if providers.is_empty(){return None;}let mut result=Vec::new();let mut seen=Vec::new();
    for provider in providers{
        if !provider.is_object()||unknown_key(provider,&["id","controls","scope"]).is_some(){return None;}
        let id=normalized_string(provider.get("id"))?;if seen.contains(&id){return None;}seen.push(id.clone());let mut item=json!({"id":id});
        if let Some(v)=provider.get("controls"){item["controls"]=normalize_controls(v)?;}
        if let Some(v)=provider.get("scope"){item["scope"]=normalize_scope(v)?;}
        result.push(item);
    }Some(json!({"version":1,"providers":result}))
}
pub fn compact_capabilities(value:Option<&Value>)->Option<Value>{
    let normalized=normalize_capabilities(value)?;if normalized==Value::Bool(false){return Some(normalized);}
    let providers:Vec<_>=normalized["providers"].as_array()?.iter().filter_map(|p|p.get("controls").map(|c|json!({"id":p["id"],"controls":c}))).collect();
    (!providers.is_empty()).then(||json!({"version":1,"providers":providers}))
}
pub fn merge_capabilities(previous:Option<&Value>,next:Option<&Value>)->Option<Value>{
    let previous=normalize_capabilities(previous);let next=normalize_capabilities(next);
    let Some(next)=next else{return previous};if next==Value::Bool(false){return Some(next);}
    let Some(previous)=previous.filter(|v|v!=&Value::Bool(false))else{return Some(next)};
    let old=previous["providers"].as_array()?;let mut providers=Vec::new();
    for provider in next["providers"].as_array()?{
        let prior=old.iter().find(|p|p["id"]==provider["id"]);let mut merged=json!({"id":provider["id"]});
        for key in ["controls","scope"]{if let Some(v)=provider.get(key).or_else(||prior.and_then(|p|p.get(key))){merged[key]=v.clone();}}
        providers.push(merged);
    }
    for provider in old{if !providers.iter().any(|p|p["id"]==provider["id"]){providers.push(provider.clone());}}
    Some(json!({"version":1,"providers":providers}))
}
pub fn concrete_scope(scope:&Value,reproducible_cycles:i64)->bool{
    scope.get("probe_profile").and_then(Value::as_str)==Some(SCOPE_PROFILE)&&scope.get("source").and_then(Value::as_str)==Some("live_probe")&&["account_slots","token_refresh","conversation_id"].iter().all(|k|scope.get(k).and_then(Value::as_str).is_some_and(|s|s!="unknown"))&&scope.get("reproducible_cycles").and_then(Value::as_i64)==Some(reproducible_cycles)&&normalized_string(scope.get("effective_model")).is_some()
}
fn breakpoints(raw:&Value,input_key:&str)->Vec<(String,Option<String>)>{
    let mut found=Vec::new();let Some(items)=raw.get(input_key).and_then(Value::as_array)else{return found};
    fn collect(value:&Value,param:String,found:&mut Vec<(String,Option<String>)>){if value.pointer("/prompt_cache_breakpoint/mode").and_then(Value::as_str)==Some("explicit"){found.push((param,value.get("type").and_then(Value::as_str).map(str::to_owned)));}}
    for(i,item)in items.iter().enumerate(){let param=format!("{input_key}[{i}]");if input_key=="input"{collect(item,format!("{param}.prompt_cache_breakpoint"),&mut found);}
        for key in ["content","output"]{if key=="output"&&(input_key!="input"||item.get("type").and_then(Value::as_str)!=Some("function_call_output")){continue;}
            if let Some(parts)=item.get(key).and_then(Value::as_array){for(j,part)in parts.iter().enumerate(){collect(part,format!("{param}.{key}[{j}].prompt_cache_breakpoint"),&mut found);}}
        }
    }found
}
fn contains_breakpoint(value:&Value)->bool{
    let content=value.get("content").and_then(Value::as_array);let output=if value.get("type").and_then(Value::as_str)==Some("function_call_output"){value.get("output").and_then(Value::as_array)}else{None};
    content.into_iter().chain(output).flatten().any(|v|v.pointer("/prompt_cache_breakpoint/mode").and_then(Value::as_str)==Some("explicit"))
}
pub fn validate_known_unsupported(model:&str,record:Option<&Value>,body:&Value,input:&[Value],input_key:&str)->Result<(),GatewayError>{
    let markers=if input.iter().any(contains_breakpoint){breakpoints(body,input_key)}else{Vec::new()};
    let unsupported=|param:&str|invalid(format!("Prompt cache control '{param}' is not supported for model '{model}'."),Some(param));
    if record.and_then(|r|r.get("prompt_cache"))==Some(&Value::Bool(false)){
        let param=["prompt_cache_key","prompt_cache_options","prompt_cache_retention"].iter().find(|k|body.get(**k).is_some()).map(|s|(*s).to_owned()).or_else(||markers.first().map(|(p,_)|p.clone()));
        if let Some(param)=param{return Err(invalid(format!("Prompt caching is not supported for model '{model}'."),Some(&param)));}return Ok(());
    }
    let capabilities=normalize_capabilities(record.and_then(|r|r.get("prompt_cache")));
    let Some(controls)=capabilities.as_ref().and_then(|v|v.get("providers")).and_then(Value::as_array).and_then(|ps|ps.iter().find(|p|p.get("id").and_then(Value::as_str)==Some(CODEX_PROVIDER))).and_then(|p|p.get("controls"))else{return Ok(())};
    let mode_unsupported=|mode:&str|controls.get("modes").and_then(Value::as_array).is_some_and(|m|!m.iter().any(|v|v.as_str()==Some(mode)));
    if body.get("prompt_cache_key").is_some()&&controls.get("key")==Some(&Value::Bool(false)){return Err(unsupported("prompt_cache_key"));}
    let options=body.get("prompt_cache_options").filter(|v|v.is_object());
    let requested=options.map(|o|if o.get("mode").and_then(Value::as_str)==Some("explicit"){("explicit","prompt_cache_options.mode")}else{("implicit",if o.get("mode").is_some(){"prompt_cache_options.mode"}else{"prompt_cache_options"})});
    if let Some(("implicit",param))=requested && (controls.get("implicit")==Some(&Value::Bool(false))||mode_unsupported("implicit")){return Err(unsupported(param));}
    for(raw,allowed,param)in[(options.and_then(|o|o.get("ttl")),controls.get("ttls"),"prompt_cache_options.ttl"),(body.get("prompt_cache_retention"),controls.get("legacy_retentions"),"prompt_cache_retention")]{if let (Some(value),Some(allowed))=(raw.and_then(Value::as_str),allowed.and_then(Value::as_array)) && !allowed.iter().any(|v|v.as_str()==Some(value)){return Err(unsupported(param));}}
    for(param,kind)in markers{if controls.get("explicit_breakpoints")==Some(&Value::Bool(false))||mode_unsupported("explicit"){return Err(unsupported(&param));}let endpoint=if input_key=="input"{"responses"}else{"chat_completions"};if let Some(allowed)=controls.get("breakpoint_block_types").and_then(|v|v.get(endpoint)).and_then(Value::as_array) && !kind.is_some_and(|k|allowed.iter().any(|v|v.as_str()==Some(k.as_str()))){return Err(unsupported(&param));}}
    if let Some(("explicit",param))=requested && (controls.get("explicit_breakpoints")==Some(&Value::Bool(false))||mode_unsupported("explicit")){return Err(unsupported(param));}
    Ok(())
}
