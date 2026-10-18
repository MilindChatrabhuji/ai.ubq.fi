//! Source Claude principal policy. Parsing data never mints a routing/cohort capability.
use crate::store;
use gateway_auth::{AuthHost,conflict,invalid,store::{check,commit,put}};
use gateway_core::{GatewayError,state::{AuthorityStore,RecordKey,RevisionCheck}};
use serde::Serialize;
use serde_json::{Value,json};
use std::{cmp::Ordering,collections::BTreeSet};

#[derive(Clone,Copy,Debug,Eq,PartialEq,Serialize)]
#[serde(rename_all="snake_case")]
pub enum PolicySource{Env,Kv}
#[derive(Clone,Debug,Eq,PartialEq,Serialize)]
pub struct ClaudeAccessPolicy{
    pub v:u32,
    pub source:PolicySource,
    pub allowed_key_ids:Vec<String>,
    pub updated_at_ms:i64,
}
#[derive(Clone,Debug)]
pub struct AccessRead{pub policy:ClaudeAccessPolicy,pub check:RevisionCheck}
pub fn policy_key()->RecordKey{store::key(json!(["uos_ai","claude_code_access","v1"]))}
fn unique_ids(value:&Value)->Result<Vec<String>,GatewayError>{
    let values=value.as_array().filter(|v|v.len()<=1000).ok_or_else(||invalid("allowed_key_ids must be an explicit array of principal IDs"))?;
    let mut seen=BTreeSet::new();let mut ids=Vec::new();
    for value in values{
        let id=value.as_str().filter(|s| !s.trim_matches(gateway_schema::util::js_whitespace).is_empty() && s.encode_utf16().count()<=256 && !s.chars().any(|c|gateway_schema::util::js_whitespace(c)||c==','||(c as u32)<32||c=='\x7f')).ok_or_else(||invalid("allowed_key_ids must be an explicit array of principal IDs"))?;
        // Source Set retains insertion order before stable localeCompare sorting.
        if seen.insert(id.to_owned()){ids.push(id.to_owned());}
    }
    Ok(ids)
}
fn sort_ids(mut ids:Vec<String>,compare:&impl Fn(&str,&str)->Result<Ordering,GatewayError>)->Result<Vec<String>,GatewayError>{
    let mut error=None;ids.sort_by(|a,b|match compare(a,b){Ok(value)=>value,Err(failure)=>{error=Some(failure);Ordering::Equal}});if let Some(error)=error{return Err(error);}Ok(ids)
}
pub fn parse_ids(value:&Value,compare:&impl Fn(&str,&str)->Result<Ordering,GatewayError>)->Result<Vec<String>,GatewayError>{sort_ids(unique_ids(value)?,compare)}
pub fn parse_policy(value:&Value,compare:&impl Fn(&str,&str)->Result<Ordering,GatewayError>)->Result<ClaudeAccessPolicy,GatewayError>{
    let malformed=||store::corrupt("Claude principal policy is invalid; refusing environment fallback");
    if value.get("v")!=Some(&json!(1)){return Err(malformed());}
    let source=match value.get("source").and_then(Value::as_str){Some("env")=>PolicySource::Env,Some("kv")=>PolicySource::Kv,_=>return Err(malformed())};
    let updated_at_ms=value.get("updated_at_ms").and_then(Value::as_i64).filter(|n|*n>0&&*n<=gateway_core::identity::MAX_SAFE_INTEGER).ok_or_else(malformed)?;
    let ids=unique_ids(value.get("allowed_key_ids").unwrap_or(&Value::Null)).map_err(|_|malformed())?;
    Ok(ClaudeAccessPolicy{v:1,source,allowed_key_ids:sort_ids(ids,compare)?,updated_at_ms})
}
/// `seed_ids` is the already trusted explicit source environment list, never request input.
/// The returned exact revision must join the caller's current-admission transaction.
pub async fn load_policy<S:AuthorityStore,H:AuthHost>(store:&S,host:&H,seed_ids:&[String],compare:&impl Fn(&str,&str)->Result<Ordering,GatewayError>)->Result<AccessRead,GatewayError>{
    let key=policy_key();
    for _ in 0..8{
        let row=store.read(&key).await?;
        if let Some(value)=store::value(row.as_ref(),host.now_ms())?{
            let policy=parse_policy(&value,compare)?;return Ok(AccessRead{policy,check:check(&key,row.as_ref())});
        }
        let now=host.now_ms();if !(1..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&now){return Err(invalid("Claude policy clock is invalid"));}
        let policy=ClaudeAccessPolicy{v:1,source:PolicySource::Env,allowed_key_ids:parse_ids(&json!(seed_ids),compare)?,updated_at_ms:now};
        let revision=store::revision(host)?;
        if commit(store,vec![check(&key,row.as_ref())],vec![put(key.clone(),&policy,None,&revision)?]).await?{
            return Ok(AccessRead{policy,check:RevisionCheck{key:key.clone(),expected_revision:Some(revision)}});
        }
    }
    Err(conflict("Claude principal policy changed repeatedly"))
}
