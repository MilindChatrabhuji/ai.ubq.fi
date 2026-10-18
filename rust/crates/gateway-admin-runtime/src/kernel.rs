use crate::{AdminRuntime,capabilities::RuntimeCapabilities,parse,store};
use gateway_admin::{AdminInput,AdminOperation};
use gateway_auth::{AuthHost,AuthResponse,conflict,invalid,store::{check,commit,put}};
use gateway_authority::{keys,quota::{KernelDefaults,KernelPolicy,KernelReservation,KernelTerminal,KernelWindow}};
use gateway_core::{GatewayError,query::QueryStore,state::{RecordKey,RecordMutation,StoredRecord}};
use serde_json::{Value,json};
use std::collections::BTreeMap;

const WEEK:i64=604800000;
pub(crate) fn default_limit_key()->RecordKey{store::key(json!(["default","kernel_policy_limit_requests"]))}
pub(crate) fn default_window_key()->RecordKey{store::key(json!(["default","kernel_policy_window_ms"]))}
fn part(value:Option<&Value>)->Option<String>{parse::text(value).filter(|s|s.encode_utf16().count()<=100 && !s.chars().any(char::is_whitespace) && !s.contains('/'))}
fn scope(value:Option<&Value>)->bool{value.and_then(Value::as_str).is_some_and(|s|s.trim().eq_ignore_ascii_case("org"))}
fn target(value:&Value)->Result<(String,Option<String>),GatewayError>{
    let owner=part(value.get("owner")).ok_or_else(||invalid("owner is required"))?;
    let repo=part(value.get("repo"));
    let org=if value.get("scope").is_some(){scope(value.get("scope"))}else{repo.is_none()};
    if org && repo.is_some(){return Err(invalid("repo must be omitted for scope=org"))}
    if !org && repo.is_none(){return Err(invalid("repo is required for scope=repo"))}
    Ok((owner,repo))
}
fn decode_policy(value:Value,owner:&str,repo:Option<&str>)->Result<KernelPolicy,GatewayError>{
    let policy:KernelPolicy=serde_json::from_value(value).map_err(|_|store::corrupt("Kernel quota policy is malformed"))?;
    if policy.v!=2 || policy.owner!=owner || policy.repo.as_deref()!=repo || policy.usage_limit_requests< -1 || policy.window_ms<=0 || policy.expires_at_ms< -1 {return Err(store::corrupt("Kernel quota policy is malformed"))}
    Ok(policy)
}
fn validate_window(value:Value,owner:&str,repo:Option<&str>)->Result<KernelWindow,GatewayError>{
    let window:KernelWindow=serde_json::from_value(value).map_err(|_|store::corrupt("Kernel quota window is malformed"))?;
    if window.v!=2 || window.owner!=owner || window.repo.as_deref()!=repo || window.reserved_requests!=window.reservations.len() as i64 || window.usage_requests<0 || window.applied_window_ms<=0 || window.usage_reset_at_ms<=window.created_at_ms {return Err(store::corrupt("Kernel quota window is malformed"))}
    Ok(window)
}
fn new_window(owner:&str,repo:Option<&str>,window_ms:i64,now:i64)->KernelWindow{KernelWindow{v:2,owner:owner.into(),repo:repo.map(str::to_owned),usage_requests:0,reserved_requests:0,created_at_ms:now,usage_reset_at_ms:now+window_ms,applied_window_ms:window_ms,updated_at_ms:now,reservations:BTreeMap::new()}}
fn summary(policy:&KernelPolicy,window:&KernelWindow,now:i64)->Value{
    let mut row=json!({"owner":policy.owner,"usage_limit_requests":policy.usage_limit_requests,"usage_requests":window.usage_requests,"usage_reset_at_ms":window.usage_reset_at_ms,"window_ms":policy.window_ms,"expires_at_ms":policy.expires_at_ms,"created_at_ms":if window.created_at_ms==0{now}else{window.created_at_ms},"updated_at_ms":window.updated_at_ms.max(now)});
    if let Some(repo)=&policy.repo{row["repo"]=json!(repo)} row
}

impl<S:QueryStore,H:AuthHost,C:RuntimeCapabilities> AdminRuntime<'_,S,H,C>{
    pub(crate) async fn kernel_defaults(&self,now:i64)->Result<KernelDefaults,GatewayError>{
        let combined=store::read(self.store,&keys::kernel_defaults(),now).await?;
        let mut defaults:KernelDefaults=combined.map(|v|serde_json::from_value(v).map_err(|_|store::corrupt("Kernel defaults are malformed"))).transpose()?.unwrap_or_default();
        if let Some(value)=store::read(self.store,&default_limit_key(),now).await?{defaults.usage_limit_requests=parse::limit(&value).unwrap_or(-1)}
        if let Some(value)=store::read(self.store,&default_window_key(),now).await?{defaults.window_ms=parse::positive(&value).unwrap_or(WEEK)}
        if defaults.usage_limit_requests< -1 || defaults.window_ms<=0{return Err(store::corrupt("Kernel defaults are malformed"))} Ok(defaults)
    }
    /// Reconcile only this common authority window and its exact durable reservation rows.
    pub(crate) async fn kernel_window(&self,owner:&str,repo:Option<&str>,now:i64)->Result<Option<KernelWindow>,GatewayError>{
        let key=keys::kernel_window(owner,repo);
        for _ in 0..3{
            let row=self.store.read(&key).await?;
            let Some(value)=store::value(row.as_ref(),now)? else{return Ok(None)};
            let mut window=validate_window(value,owner,repo)?;
            let mut checks=vec![check(&key,row.as_ref())];
            let mut writes=Vec::new();
            let mut retained=BTreeMap::new();
            for (id,expiry) in &window.reservations{
                let rk=keys::kernel_request(owner,repo,window.created_at_ms,id);
                let rr=self.store.read(&rk).await?;
                let mut reservation:KernelReservation=store::value(rr.as_ref(),now)?.map(|v|serde_json::from_value(v).map_err(|_|store::corrupt("Kernel reservation is malformed"))).transpose()?.ok_or_else(||store::corrupt("Kernel reservation is missing"))?;
                reservation.validate()?;
                if reservation.owner!=owner || reservation.repo.as_deref()!=repo || reservation.request_id.0!=*id || reservation.window_created_at_ms!=window.created_at_ms || reservation.window_reset_at_ms!=window.usage_reset_at_ms || reservation.lease_expires_at_ms!=*expiry || reservation.state.is_some(){return Err(store::corrupt("Kernel reservation/window identity is inconsistent"))}
                if *expiry<=now{
                    let terminal=reservation.terminal_intent.unwrap_or(KernelTerminal::Released);
                    reservation.state=Some(terminal);reservation.terminal_intent=Some(terminal);reservation.terminal_at_ms=Some(now);
                    if terminal==KernelTerminal::Committed{window.usage_requests=window.usage_requests.checked_add(1).ok_or_else(||store::corrupt("Kernel usage overflow"))?;reservation.release_reason=None;}else{reservation.release_reason=Some("lease_expired".into());}
                    checks.push(check(&rk,rr.as_ref()));
                    writes.push(put(rk,&reservation,Some(window.usage_reset_at_ms+WEEK),&store::revision(self.host)?)?);
                }else{retained.insert(id.clone(),*expiry);}
            }
            if writes.is_empty(){return Ok(Some(window))}
            window.reservations=retained;window.reserved_requests=window.reservations.len() as i64;window.updated_at_ms=now;
            writes.push(put(key.clone(),&window,Some(window.usage_reset_at_ms+WEEK),&store::revision(self.host)?)?);
            if commit(self.store,checks,writes).await?{return Ok(Some(window))}
        }
        Err(conflict("Kernel reservations changed concurrently; retry"))
    }
    pub(crate) async fn live_default_reservations(&self,now:i64)->Result<bool,GatewayError>{
        for (name,repo_scope) in [("repo_window",true),("org_window",false)]{
            let prefix=store::key(json!(["uos_ai","kernel_quota","v2",name]));
            for entry in store::scan(self.store,prefix,false,now).await?{
                let value=entry.record.json_value()?;
                let owner=value.get("owner").and_then(Value::as_str).ok_or_else(||store::corrupt("Kernel window owner is missing"))?;
                let repo=if repo_scope{Some(value.get("repo").and_then(Value::as_str).ok_or_else(||store::corrupt("Kernel window repo is missing"))?)}else{None};
                if entry.key!=keys::kernel_window(owner,repo){return Err(store::corrupt("Kernel window key identity is malformed"))}
                if let Some(value)=store::read(self.store,&keys::kernel_policy(owner,repo),now).await?{decode_policy(value,owner,repo)?;continue}
                if self.kernel_window(owner,repo,now).await?.is_some_and(|w|w.reserved_requests>0){return Ok(true)}
            }
        }
        Ok(false)
    }
    async fn policy_summary(&self,owner:&str,repo:Option<&str>,now:i64)->Result<Value,GatewayError>{
        let defaults=self.kernel_defaults(now).await?;
        let explicit=store::read(self.store,&keys::kernel_policy(owner,repo),now).await?;
        let source=if explicit.is_some(){"kv"}else{"default"};
        let policy=explicit.map(|v|decode_policy(v,owner,repo)).transpose()?.unwrap_or(KernelPolicy{v:2,owner:owner.into(),repo:repo.map(str::to_owned),usage_limit_requests:defaults.usage_limit_requests,window_ms:defaults.window_ms,expires_at_ms:-1});
        let existing=self.kernel_window(owner,repo,now).await?;
        let window=existing.filter(|w|w.applied_window_ms==policy.window_ms && w.usage_reset_at_ms>now).unwrap_or_else(||new_window(owner,repo,policy.window_ms,now));
        let mut result=summary(&policy,&window,now);result["source"]=json!(source);Ok(result)
    }
    pub(crate) async fn kernel(&self,op:AdminOperation,input:&AdminInput)->Result<AuthResponse,GatewayError>{
        let now=input.now_ms;
        if op==AdminOperation::KernelQueue{
            let queue=store::read(self.store,&store::key(json!(["uos_ai","kernel_policy_queue"])),now).await?.unwrap_or_else(||json!([]));
            let mut pending=Vec::new();
            for row in queue.as_array().ok_or_else(||store::corrupt("Kernel policy queue is malformed"))?{
                let (Some(owner),Some(repo))=(part(row.get("owner")),part(row.get("repo"))) else{continue};
                if store::read(self.store,&keys::kernel_policy(&owner,None),now).await?.is_none() && store::read(self.store,&keys::kernel_policy(&owner,Some(&repo)),now).await?.is_none(){pending.push(row.clone())}
            }
            pending.sort_by_key(|row|std::cmp::Reverse(row.get("last_seen_at_ms").and_then(Value::as_i64).unwrap_or(now)));
            return Ok(AuthResponse::json(200,json!({"data":pending})))
        }
        if op==AdminOperation::KernelUsageGet{return self.kernel_get(input).await}
        let (owner,repo)=target(&input.body)?;
        let key=keys::kernel_policy(&owner,repo.as_deref());
        let window_key=keys::kernel_window(&owner,repo.as_deref());
        let limit=if op==AdminOperation::KernelUsageSet{Some(input.body.get("usage_limit_requests").and_then(parse::limit).ok_or_else(||invalid("usage_limit_requests must be a non-negative number, -1, or 'unlimited'"))?)}else{None};
        let window=input.body.get("window_ms").map(|v|parse::positive(v).ok_or_else(||invalid("window_ms must be a positive number"))).transpose()?;
        let expiry=input.body.get("expires_at_ms").map(|v|parse::integer(v).filter(|n|*n == -1 || *n>now).ok_or_else(||invalid("expires_at_ms must be a Unix epoch ms timestamp in the future, or -1"))).transpose()?;
        if input.body.get("reset_usage").is_some_and(|v|!v.is_boolean()){return Err(invalid("reset_usage must be a boolean"))}
        for _ in 0..3{
            self.kernel_window(&owner,repo.as_deref(),now).await?;
            let defaults=self.kernel_defaults(now).await?;
            let row=self.store.read(&key).await?;
            let window_row=self.store.read(&window_key).await?;
            let cutover_key=keys::kernel_cutover();let cutover=self.store.read(&cutover_key).await?;
            if store::value(cutover.as_ref(),now)?.is_some(){return Err(conflict("Kernel default-window cutover is in progress"))}
            let explicit=store::value(row.as_ref(),now)?;
            if explicit.is_none() && op==AdminOperation::KernelUsageDelete{return Err(GatewayError::new(404,"Kernel usage limit not found",Some("not_found")))}
            let old=explicit.map(|v|decode_policy(v,&owner,repo.as_deref())).transpose()?;
            let current_window=store::value(window_row.as_ref(),now)?.map(|v|validate_window(v,&owner,repo.as_deref())).transpose()?;
            let current_ms=old.as_ref().map(|p|p.window_ms).unwrap_or(defaults.window_ms);
            let next_ms=if limit.is_some(){window.unwrap_or(current_ms)}else{defaults.window_ms};
            let reset=input.body.get("reset_usage")==Some(&Value::Bool(true)) || current_ms!=next_ms;
            if current_window.as_ref().is_some_and(|w|w.reserved_requests>0) && (reset || limit.is_none()){return Err(conflict("Active Kernel quota reservations must settle before changing this policy"))}
            let org_key=keys::kernel_policy(&owner,None);let org_row=if repo.is_some() && row.is_none(){self.store.read(&org_key).await?}else{None};
            let org_window_key=keys::kernel_window(&owner,None);let org_window_row=if repo.is_some() && row.is_none(){self.store.read(&org_window_key).await?}else{None};
            if org_row.is_some() && self.kernel_window(&owner,None,now).await?.is_some_and(|w|w.reserved_requests>0){return Err(conflict("Active inherited Kernel reservations must settle before changing this policy"))}
            let dwk=default_window_key();let dw=self.store.read(&dwk).await?;let dlk=default_limit_key();let dl=self.store.read(&dlk).await?;let dkey=keys::kernel_defaults();let dr=self.store.read(&dkey).await?;
            let mut checks=vec![check(&key,row.as_ref()),check(&window_key,window_row.as_ref()),check(&cutover_key,cutover.as_ref()),check(&dwk,dw.as_ref()),check(&dlk,dl.as_ref()),check(&dkey,dr.as_ref())];
            if repo.is_some() && row.is_none(){checks.push(check(&org_key,org_row.as_ref()));checks.push(check(&org_window_key,org_window_row.as_ref()));}
            let mut next_window=if !reset{current_window.filter(|w|w.applied_window_ms==next_ms && w.usage_reset_at_ms>now).unwrap_or_else(||new_window(&owner,repo.as_deref(),next_ms,now))}else{new_window(&owner,repo.as_deref(),next_ms,now)};
            next_window.updated_at_ms=now;
            let revision=store::revision(self.host)?;
            let mut writes=vec![put(window_key.clone(),&next_window,Some(next_window.usage_reset_at_ms+WEEK),&revision)?];
            let mut response=json!({"scope":if repo.is_some(){"repo"}else{"org"}});
            response[if repo.is_some(){"repo"}else{"org"}]=if let Some(repo)=&repo{json!({"owner":owner,"repo":repo})}else{json!({"owner":owner})};
            if let Some(limit)=limit{
                let policy=KernelPolicy{v:2,owner:owner.clone(),repo:repo.clone(),usage_limit_requests:limit,window_ms:next_ms,expires_at_ms:expiry.unwrap_or(old.as_ref().map(|p|p.expires_at_ms).unwrap_or(-1))};
                let mut wire=serde_json::to_value(&policy).map_err(|_|store::corrupt("Kernel policy cannot be encoded"))?;
                wire["scope"]=json!(if repo.is_some(){"repo"}else{"org"});wire["created_at_ms"]=json!(row.as_ref().and_then(|r|r.json_value().ok()).and_then(|v|v.get("created_at_ms")).and_then(Value::as_i64).unwrap_or(now));wire["updated_at_ms"]=json!(now);
                writes.push(put(key.clone(),&wire,None,&revision)?);
                response["limit"]=summary(&policy,&next_window,now);response["limit"]["source"]=json!("kv");
            }else{writes.push(RecordMutation::Delete{key:key.clone()});response["deleted"]=json!(true);}
            if commit(self.store,checks,writes).await?{return Ok(AuthResponse::json(200,response))}
        }
        Err(conflict("Concurrent modification; retry"))
    }
    async fn kernel_get(&self,input:&AdminInput)->Result<AuthResponse,GatewayError>{
        let org=parse::first(&input.query,"scope").is_some_and(|s|s.trim().eq_ignore_ascii_case("org"));
        let include=parse::truth(parse::first(&input.query,"include_usage"));
        let inventory=parse::truth(parse::first(&input.query,"inventory"));
        let list=parse::truth(parse::first(&input.query,"list"));
        if inventory || list{
            let family=if inventory{if org{"org_usage"}else{"usage"}}else{if org{"org_policy"}else{"repo_policy"}};
            let prefix=if inventory{store::key(json!(["ubq_ai","kernel_auth",family]))}else{store::key(json!(["uos_ai","kernel_quota","v2",family]))};
            let mut records=Vec::new();
            for entry in store::scan(self.store,prefix,false,input.now_ms).await?{
                let raw=entry.record.json_value()?;
                let owner=raw.get("owner").and_then(Value::as_str).ok_or_else(||store::corrupt("Kernel inventory owner is malformed"))?;
                let repo=if org{None}else{Some(raw.get("repo").and_then(Value::as_str).ok_or_else(||store::corrupt("Kernel inventory repo is malformed"))?)};
                let mut row=if inventory{raw.clone()}else{self.policy_summary(owner,repo,input.now_ms).await?};
                if !inventory && include{row["usage"]=self.usage_record(owner,repo,input.now_ms).await?;}
                if let Some(obj)=row.as_object_mut(){obj.remove("source");}
                records.push(row);
            }
            let mut body=json!({"scope":if org{"org"}else{"repo"}});body[if inventory{"usage"}else{"limits"}]=json!(records);
            return Ok(AuthResponse::json(200,body))
        }
        let owner=part(parse::first(&input.query,"owner").map(|s|json!(s)).as_ref()).ok_or_else(||invalid("owner query parameter is required"))?;
        let repo=if org{None}else{Some(part(parse::first(&input.query,"repo").map(|s|json!(s)).as_ref()).ok_or_else(||invalid("repo query parameter is required"))?)};
        let limit=self.policy_summary(&owner,repo.as_deref(),input.now_ms).await?;
        let usage=self.usage_record(&owner,repo.as_deref(),input.now_ms).await?;
        let mut body=json!({"limit":limit,"usage":usage});
        body[if org{"org"}else{"repo"}]=if let Some(repo)=repo{json!({"owner":owner,"repo":repo})}else{json!({"owner":owner})};
        Ok(AuthResponse::json(200,body))
    }
    async fn usage_record(&self,owner:&str,repo:Option<&str>,now:i64)->Result<Value,GatewayError>{
        let key=if let Some(repo)=repo{store::key(json!(["ubq_ai","kernel_auth","usage",owner,repo]))}else{store::key(json!(["ubq_ai","kernel_auth","org_usage",owner]))};
        Ok(store::read(self.store,&key,now).await?.unwrap_or(Value::Null))
    }
    pub(crate) async fn release_cutover(&self,key:&RecordKey,row:&StoredRecord)->Result<(),GatewayError>{
        // Conditional release cannot remove another operation's claim.
        commit(self.store,vec![check(key,Some(row))],vec![RecordMutation::Delete{key:key.clone()}]).await?;Ok(())
    }
}
