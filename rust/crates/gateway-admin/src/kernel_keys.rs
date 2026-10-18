//! Source kernel public-key administration; these are verification keys, never private credentials.
use gateway_auth::{AuthHost,AuthResponse,crypto::uuid_from_random,conflict,invalid,store};
use gateway_core::{GatewayError,state::{AuthorityStore,RecordKey}};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};

#[derive(Clone,Debug,Deserialize,PartialEq,Serialize)]
pub struct KernelPublicKey{pub app_id:f64,pub pem:String,pub owner:String,pub added_at_ms:i64}

pub fn key()->RecordKey{store::key(json!(["uos_ai","kernel_pubkeys"]))}

pub async fn list<S:AuthorityStore>(store:&S,now:i64)->Result<AuthResponse,GatewayError>{
    let rows:Option<Vec<KernelPublicKey>>=store::decode(store.read(&key()).await?.as_ref(),now)?;
    Ok(AuthResponse::json(200,json!({"data":rows.unwrap_or_default()})))
}

pub async fn create<S:AuthorityStore,H:AuthHost>(store:&S,host:&H,body:&Value)->Result<AuthResponse,GatewayError>{
    let app_id=body.get("app_id").and_then(Value::as_f64).filter(|id|id.is_finite()).ok_or_else(||invalid("app_id is required and must be a number"))?;
    let pem=body.get("pem").and_then(Value::as_str).map(str::trim).filter(|pem|pem.starts_with("-----BEGIN PUBLIC KEY-----")&&pem.ends_with("-----END PUBLIC KEY-----")).ok_or_else(||invalid("pem must be a valid RS256 public PEM"))?;
    let owner=body.get("owner").and_then(Value::as_str).unwrap_or("unknown");let k=key();let row=store.read(&k).await?;
    let mut rows:Vec<KernelPublicKey>=store::decode(row.as_ref(),host.now_ms())?.unwrap_or_default();
    if rows.iter().any(|row|row.app_id==app_id){return Err(conflict(&format!("Public key for App ID {app_id} already exists")));}
    let record=KernelPublicKey{app_id,pem:pem.into(),owner:owner.into(),added_at_ms:host.now_ms()};rows.push(record.clone());
    let revision=uuid_from_random(&host.random_bytes(16)?)?;
    if !store::commit(store,vec![store::check(&k,row.as_ref())],vec![store::put(k,&rows,None,&revision)?]).await?{return Err(conflict("Concurrent modification; retry"));}
    Ok(AuthResponse::json(200,json!({"ok":true,"data":record})))
}

fn parse_source_integer(value:&str)->Option<f64>{
    let text=value.trim_start();let mut end=0;for(index,ch)in text.char_indices(){if (index==0&&matches!(ch,'+'|'-'))||ch.is_ascii_digit(){end=index+ch.len_utf8();}else{break;}}
    if end==0{return None;}text[..end].parse::<f64>().ok().filter(|value|value.is_finite())
}

pub async fn delete<S:AuthorityStore,H:AuthHost>(store:&S,host:&H,query:&std::collections::BTreeMap<String,Vec<String>>)->Result<AuthResponse,GatewayError>{
    let app_id=query.get("app_id").and_then(|values|values.first()).and_then(|value|parse_source_integer(value)).ok_or_else(||invalid("app_id query parameter is required and must be a number"))?;
    let k=key();let row=store.read(&k).await?;let mut rows:Vec<KernelPublicKey>=store::decode(row.as_ref(),host.now_ms())?.unwrap_or_default();let old_count=rows.len();rows.retain(|record|record.app_id!=app_id);
    if rows.len()==old_count{return Err(GatewayError::new(404,"Not found",Some("not_found")));}
    let revision=uuid_from_random(&host.random_bytes(16)?)?;
    if !store::commit(store,vec![store::check(&k,row.as_ref())],vec![store::put(k,&rows,None,&revision)?]).await?{return Err(conflict("Concurrent modification; retry"));}
    Ok(AuthResponse::json(200,json!({"ok":true,"deleted_app_id":app_id})))
}

/// Preserve configured environment keys and add current durable keys. Called only for kernel verification.
pub async fn public_pems<S:AuthorityStore>(store:&S,now:i64)->Result<Vec<String>,GatewayError>{
    let rows:Option<Vec<KernelPublicKey>>=store::decode(store.read(&key()).await?.as_ref(),now)?;
    Ok(rows.unwrap_or_default().into_iter().map(|row|row.pem).collect())
}
