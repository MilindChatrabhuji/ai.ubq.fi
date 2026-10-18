//! Post-acceptance source Claude history/rollups. Never a quota writer.
use crate::{ObservabilityHost,ObservabilityRuntime,capacity_shapes::{BUCKET_MS,HOUR_MS,RETENTION_MS,STALE_MS},host_types::ClaudeAcceptedObservation,store};
use gateway_auth::crypto::sha256_hex;
use gateway_core::{GatewayError,query::{QuerySelector,QueryStore},state::RecordKey};
use serde_json::{Map,Value,json};
const WINDOWS:[&str;2]=["five_hour","seven_day"];
const LIMIT:usize=20_000;
fn identity(v:&Value)->bool{v.as_str().is_some_and(|s|!s.is_empty()&&s.encode_utf16().count()<=200)}
fn time(v:&Value)->bool{store::safe_i64(v).is_some()}
fn nullable_time(v:&Value)->bool{v.is_null()||time(v)}
fn percent(v:&Value)->bool{v.is_null()||v.as_f64().is_some_and(|v|v.is_finite()&&(0.0..=100.0).contains(&v))}
pub fn used_percent(value:Option<f64>)->Option<f64>{value.filter(|v|v.is_finite()&&*v>=0.0).map(|v|(v*100.0).min(100.0))}
fn window_valid(v:&Value,sample:i64)->bool{
    v.is_object()&&(v["status"].is_null()||v["status"].is_string())&&percent(&v["used_percent"])&&nullable_time(&v["reset_at_ms"])&&nullable_time(&v["observed_at_ms"])&&v["observed_at_ms"].as_i64().is_none_or(|t|t<=sample)
}
pub fn valid_history_point(value:&Value)->bool{
    if value["v"]!=1||!["point_id","account_id","account_cohort_id"].iter().all(|f|identity(&value[f]))||!matches!(value["credential_kind"].as_str(),Some("oauth"|"api_key"))||!(value["workspace_id"].is_null()||identity(&value["workspace_id"]))||!matches!(value["state"].as_str(),Some("available"|"unavailable")){return false}
    let(Some(bucket),Some(sample))=(store::safe_i64(&value["bucket_start_at_ms"]),store::safe_i64(&value["sampled_at_ms"]))else{return false};
    if !nullable_time(&value["source_observed_at_ms"])||value["source_observed_at_ms"].as_i64().is_some_and(|t|t>sample){return false}
    if value["source_observed_at_ms"].as_i64().unwrap_or(sample)/BUCKET_MS*BUCKET_MS!=bucket{return false}
    if !value["windows"].is_object()||WINDOWS.iter().any(|name|!value["windows"][name].is_null()&&!window_valid(&value["windows"][name],sample)){return false}
    let Some(standard)=value["standard"].as_array().filter(|v|v.len()<=3)else{return false};
    if standard.iter().any(|v|!v.is_object()||!matches!(v["family"].as_str(),Some("requests"|"input-tokens"|"output-tokens"))||!["limit","remaining"].iter().all(|name|v[name].is_null()||v[name].as_f64().is_some_and(|n|n.is_finite()&&n>=0.0))||!nullable_time(&v["reset_at_ms"])||!nullable_time(&v["observed_at_ms"])||v["observed_at_ms"].as_i64().is_some_and(|t|t>sample)){return false}
    value["response_status"].is_null()||value["response_status"].as_u64().is_some_and(|s|(100..=599).contains(&s))
}
fn history_key(point:&Value)->RecordKey{store::key(json!(["uos_ai","provider_capacity","claude","v1","history",point["bucket_start_at_ms"],point["account_id"],point["account_cohort_id"]]))}
pub fn rollup_key(point:&Value,window:&str)->RecordKey{
    let at=point["windows"][window]["observed_at_ms"].as_i64().or_else(||point["source_observed_at_ms"].as_i64()).or_else(||point["sampled_at_ms"].as_i64()).expect("validated point clock");
    let reset=point["windows"][window]["reset_at_ms"].clone();store::key(json!(["uos_ai","provider_capacity","claude","v1","rollup",at/HOUR_MS*HOUR_MS,point["account_id"],point["account_cohort_id"],window,if reset.is_null(){json!("unknown")}else{reset}]))
}
fn source_observation(event:&ClaudeAcceptedObservation)->Value{
    let mut observation=serde_json::to_value(&event.observation).expect("source observation serializes");
    let mut standard=Map::new();for family in ["requests","input-tokens","output-tokens"]{if let Some(v)=observation["standard"].get(family){standard.insert(family.into(),v.clone());}}
    observation["standard"]=Value::Object(standard);observation
}
pub fn point_for_observation(event:&ClaudeAcceptedObservation)->Option<Value>{
    if event.observation.windows.is_empty()&&event.observation.standard.is_empty(){return None}
    let observation=source_observation(event);let digest=json!({"account":event.account_id,"cohort":event.account_cohort_id,"kind":event.credential_kind,"workspace":event.workspace_id,"state":event.state,"response_status":event.response_status,"observation":observation});
    let window=|name:&str|event.observation.windows.get(name).map(|w|json!({"status":w.status,"used_percent":used_percent(w.utilization),"reset_at_ms":w.reset_at_ms,"observed_at_ms":(0..=9_007_199_254_740_991).contains(&w.observed_at_ms).then_some(w.observed_at_ms)}));
    let standard:Vec<Value>=["requests","input-tokens","output-tokens"].into_iter().filter_map(|name|event.observation.standard.get(name).map(|w|json!({"family":name,"limit":w.limit,"remaining":w.remaining,"reset_at_ms":w.reset_at_ms,"observed_at_ms":w.observed_at_ms}))).collect();
    let source_time=event.source_observed_at_ms.filter(|n|(0..=9_007_199_254_740_991).contains(n));let point=json!({"v":1,"point_id":sha256_hex(gateway_schema::util::json_stringify(&digest).as_bytes()),"bucket_start_at_ms":source_time.unwrap_or(event.sampled_at_ms)/BUCKET_MS*BUCKET_MS,"sampled_at_ms":event.sampled_at_ms,"source_observed_at_ms":source_time,"account_id":event.account_id,"account_cohort_id":event.account_cohort_id,"credential_kind":event.credential_kind,"workspace_id":event.workspace_id,"state":event.state,"response_status":event.response_status,"windows":{"five_hour":window("5h"),"seven_day":window("7d")},"standard":standard});valid_history_point(&point).then_some(point)
}
pub fn valid_bucket(value:&Value)->bool{
    let Some(points)=value["points"].as_array().filter(|p|p.len()<=6)else{return false};
    if value["v"]!=1||!time(&value["bucket_start_at_ms"])||!identity(&value["account_id"])||!identity(&value["account_cohort_id"])||!value["flags"].is_object(){return false}
    if !value["flags"]["normal"].as_u64().is_some_and(|v|v<=2)||["unavailable","recovery","five_hour","seven_day"].iter().any(|f|!value["flags"][f].is_boolean()){return false}
    let mut ids=std::collections::BTreeSet::new();points.iter().all(|p|valid_history_point(p)&&p["bucket_start_at_ms"]==value["bucket_start_at_ms"]&&p["account_id"]==value["account_id"]&&p["account_cohort_id"]==value["account_cohort_id"]&&ids.insert(p["point_id"].as_str().unwrap_or("")))
}
pub fn retain_point(previous:Option<&Value>,point:&Value)->Option<Value>{
    let old=previous.and_then(|v|v["points"].as_array());if old.is_some_and(|p|p.len()>=6||p.iter().any(|p|p["point_id"]==point["point_id"])){return None}
    let mut flags=previous.map(|p|p["flags"].clone()).unwrap_or_else(||json!({"normal":0,"unavailable":false,"recovery":false,"five_hour":false,"seven_day":false}));
    let normal=flags["normal"].as_u64().unwrap_or(0);let mut retain=normal<2;if retain{flags["normal"]=json!(normal+1)}
    if let Some(latest)=old.and_then(|p|p.last()).filter(|p|p["state"]!=point["state"]){let _=latest;let flag=if point["state"]=="unavailable"{"unavailable"}else{"recovery"};if flags[flag]!=true{flags[flag]=json!(true);retain=true}}
    for name in WINDOWS{let before=old.and_then(|p|p.iter().rev().find(|p|!p["windows"][name].is_null())).map(|p|&p["windows"][name]);let after=&point["windows"][name];if !after.is_null()&&before.is_none_or(|b|b["reset_at_ms"]!=after["reset_at_ms"])&&flags[name]!=true&&!retain{flags[name]=json!(true);retain=true}}
    if !retain{return None}let mut points=old.cloned().unwrap_or_default();points.push(point.clone());points.sort_by_key(|p|(p["source_observed_at_ms"].as_i64().or_else(||p["sampled_at_ms"].as_i64()),p["sampled_at_ms"].as_i64()));
    Some(json!({"v":1,"bucket_start_at_ms":point["bucket_start_at_ms"],"account_id":point["account_id"],"account_cohort_id":point["account_cohort_id"],"points":points,"flags":flags}))
}
pub fn valid_rollup(value:&Value)->bool{
    if value["v"]!=1||store::safe_i64(&value["bucket_start_at_ms"]).is_none_or(|t|t%HOUR_MS!=0)||!identity(&value["account_id"])||!identity(&value["account_cohort_id"])||!matches!(value["credential_kind"].as_str(),Some("oauth"|"api_key"))||!(value["workspace_id"].is_null()||identity(&value["workspace_id"]))||!matches!(value["window"].as_str(),Some("five_hour"|"seven_day"))||!nullable_time(&value["reset_at_ms"]){return false}
    if ["samples","available_sample_count","unavailable_sample_count","first_sampled_at_ms","last_sampled_at_ms"].iter().any(|n|!time(&value[n]))||value["samples"].as_i64()==Some(0){return false}
    let n=|f:&str|value[f].as_i64().unwrap_or(0);if n("available_sample_count")+n("unavailable_sample_count")!=n("samples")||n("first_sampled_at_ms")>n("last_sampled_at_ms"){return false}
    if ["first_source_observed_at_ms","last_source_observed_at_ms"].iter().any(|f|!nullable_time(&value[f]))||["min_used_percent","max_used_percent","last_used_percent"].iter().any(|f|!percent(&value[f]))||!(value["last_status"].is_null()||value["last_status"].is_string()){return false}
    let(first,last)=(value["first_source_observed_at_ms"].as_i64(),value["last_source_observed_at_ms"].as_i64());if first.is_some()!=last.is_some(){return false}if first.zip(last).is_some_and(|(f,l)|f>l||l>n("last_sampled_at_ms")||f<n("bucket_start_at_ms")||l>=n("bucket_start_at_ms")+HOUR_MS){return false}
    let(min,max)=(value["min_used_percent"].as_f64(),value["max_used_percent"].as_f64());if min.is_some()!=max.is_some()||min.zip(max).is_some_and(|(a,b)|a>b){return false}
    value["last_used_percent"].as_f64().is_none_or(|v|min.zip(max).is_some_and(|(a,b)|v>=a&&v<=b))
}
pub fn merge_rollup(previous:Option<&Value>,point:&Value,window:&str)->Result<Value,GatewayError>{
    let p=store::parts(&rollup_key(point,window))?;let bucket=p[5].as_i64().expect("source hour");let observed=&point["windows"][window];let reset=observed["reset_at_ms"].clone();
    if previous.is_some_and(|v|v["bucket_start_at_ms"]!=bucket||v["account_id"]!=point["account_id"]||v["account_cohort_id"]!=point["account_cohort_id"]||v["credential_kind"]!=point["credential_kind"]||v["workspace_id"]!=point["workspace_id"]||v["window"]!=window||v["reset_at_ms"]!=reset){return Err(store::error("Claude rollup binding mismatch"))}
    let source_at=observed["observed_at_ms"].as_i64().or_else(||point["source_observed_at_ms"].as_i64());let sampled=point["sampled_at_ms"].as_i64().expect("validated sample");let newer=previous.is_none_or(|v|source_at.unwrap_or(sampled)>=v["last_source_observed_at_ms"].as_i64().or_else(||v["last_sampled_at_ms"].as_i64()).unwrap_or(0));
    let mut values=Vec::new();if let Some(v)=previous{values.extend([v["min_used_percent"].as_f64(),v["max_used_percent"].as_f64()].into_iter().flatten());}values.extend(observed["used_percent"].as_f64());let min=values.iter().copied().reduce(f64::min);let max=values.iter().copied().reduce(f64::max);
    let mut times=Vec::new();if let Some(v)=previous{times.extend([v["first_source_observed_at_ms"].as_i64(),v["last_source_observed_at_ms"].as_i64()].into_iter().flatten());}times.extend(source_at);
    let count=|f:&str|previous.and_then(|v|v[f].as_u64()).unwrap_or(0);
    Ok(json!({"v":1,"bucket_start_at_ms":bucket,"account_id":point["account_id"],"account_cohort_id":point["account_cohort_id"],"credential_kind":point["credential_kind"],"workspace_id":point["workspace_id"],"window":window,"reset_at_ms":reset,"samples":count("samples")+1,"available_sample_count":count("available_sample_count")+u64::from(point["state"]=="available"),"unavailable_sample_count":count("unavailable_sample_count")+u64::from(point["state"]=="unavailable"),"first_source_observed_at_ms":times.iter().min(),"last_source_observed_at_ms":times.iter().max(),"first_sampled_at_ms":previous.and_then(|v|v["first_sampled_at_ms"].as_i64()).map(|t|t.min(sampled)).unwrap_or(sampled),"last_sampled_at_ms":previous.and_then(|v|v["last_sampled_at_ms"].as_i64()).map(|t|t.max(sampled)).unwrap_or(sampled),"min_used_percent":min,"max_used_percent":max,"last_used_percent":if newer{observed["used_percent"].clone()}else{previous.expect("previous observation")["last_used_percent"].clone()},"last_status":if newer{observed["status"].clone()}else{previous.expect("previous observation")["last_status"].clone()}}))
}
impl<S:QueryStore,H:ObservabilityHost> ObservabilityRuntime<S,H>{
    pub async fn record_claude_capacity_observation(&self,event:&ClaudeAcceptedObservation)->Result<bool,GatewayError>{
        let Some(point)=point_for_observation(event)else{return Ok(false)};let key=history_key(&point);let at=store::now(self.host.as_ref())?;
        for _ in 0..4{
            let row=self.store.read(&key).await?;let previous=store::value(row.as_ref(),at)?;if previous.is_some_and(|v|!valid_bucket(v)||history_key(v)!=key){return Err(store::error("Claude history bucket is invalid"))}
            let Some(next)=retain_point(previous,&point)else{return Ok(false)};
            let mut checks=vec![store::check(&key,row.as_ref())];let expiry=(point["bucket_start_at_ms"].as_i64().expect("validated bucket")+BUCKET_MS+RETENTION_MS).max(at+1);let mut writes=vec![store::put(self.host.as_ref(),key.clone(),next,Some(expiry))?];
            for window in WINDOWS{if point["windows"][window].is_null(){continue}let key=rollup_key(&point,window);let entry=self.store.read(&key).await?;let v=store::value(entry.as_ref(),at)?;if v.is_some_and(|v|!valid_rollup(v)){return Err(store::error("Claude rollup is invalid"))}let merged=merge_rollup(v,&point,window)?;checks.push(store::check(&key,entry.as_ref()));writes.push(store::put(self.host.as_ref(),key,merged,None)?);}
            if store::commit(self.store.as_ref(),checks,writes).await?{return Ok(true)}
        }Err(store::error("Claude history contention exceeded four attempts"))
    }
    pub async fn claude_capacity_history(&self,at:i64)->Value{
        let base=json!({"v":1,"scan":"unavailable","truncated":false,"bucket_ms":BUCKET_MS,"retention_ms":RETENTION_MS,"stale_after_ms":STALE_MS,"points":[]});
        let read=async{let cutoff=(at-RETENTION_MS).max(0);let first=cutoff/BUCKET_MS*BUCKET_MS;let end=at/BUCKET_MS*BUCKET_MS+BUCKET_MS;
            let selector=QuerySelector::Range{start:store::key(json!(["uos_ai","provider_capacity","claude","v1","history",first])),end:store::key(json!(["uos_ai","provider_capacity","claude","v1","history",end]))};
            let rows=store::scan_selector(self.store.as_ref(),selector,true,at,LIMIT+1).await?;let mut points=Vec::new();let mut truncated=rows.len()>LIMIT;
            for entry in rows.into_iter().take(LIMIT){let value=entry.record.json_value()?;if !valid_bucket(value)||entry.key!=history_key(value){return Err(store::error("Claude history evidence is corrupt"))}
                for point in value["points"].as_array().expect("validated bucket").iter().rev().filter(|p|p["sampled_at_ms"].as_i64().is_some_and(|n|n<=at)&&p["source_observed_at_ms"].as_i64().or_else(||p["sampled_at_ms"].as_i64()).is_some_and(|n|n>=cutoff)){
                    if points.len()>=LIMIT{truncated=true;break}points.push(point.clone());
                }if points.len()>=LIMIT&&truncated{break}
            }
            points.sort_by_key(|p|p["source_observed_at_ms"].as_i64().or_else(||p["sampled_at_ms"].as_i64()));let mut out=base.clone();out["scan"]=json!("ok");out["truncated"]=json!(truncated);out["points"]=json!(points);Ok(out)
        }.await;read.unwrap_or_else(|_:GatewayError|base)
    }
    pub async fn claude_capacity_rollups(&self,since:i64,at:i64)->Value{
        let base=json!({"scan":"unavailable","truncated":false,"points":[]});let read=async{
            let first=since/HOUR_MS*HOUR_MS;let last=at/HOUR_MS*HOUR_MS;let selector=QuerySelector::Range{start:store::key(json!(["uos_ai","provider_capacity","claude","v1","rollup",first])),end:store::key(json!(["uos_ai","provider_capacity","claude","v1","rollup",last+HOUR_MS]))};
            let rows=store::scan_selector(self.store.as_ref(),selector,true,at,LIMIT+1).await?;let truncated=rows.len()>LIMIT;let mut points=Vec::new();for entry in rows.into_iter().take(LIMIT){let value=entry.record.json_value()?;if !valid_rollup(value)||value["last_sampled_at_ms"].as_i64().is_none_or(|n|n>at){return Err(store::error("Claude rollup evidence is corrupt"))}
                let expected=store::key(json!(["uos_ai","provider_capacity","claude","v1","rollup",value["bucket_start_at_ms"],value["account_id"],value["account_cohort_id"],value["window"],if value["reset_at_ms"].is_null(){json!("unknown")}else{value["reset_at_ms"].clone()}]));if entry.key!=expected{return Err(store::error("Claude rollup key is corrupt"))}points.push(value.clone());}
            points.sort_by_key(|p|p["bucket_start_at_ms"].as_i64());Ok(json!({"scan":"ok","truncated":truncated,"points":points}))
        }.await;read.unwrap_or_else(|_:GatewayError|base)
    }
}
