use gateway_auth::{AuthMethod,AuthPrincipal,crypto::uuid_from_random,AuthHost,store};
use gateway_core::{GatewayError,state::{RecordKey,RecordMutation}};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};

pub const RETENTION_MS:i64=7_776_000_000;
#[derive(Clone,Debug,Deserialize,PartialEq,Serialize)]
pub struct ChangeActor{pub kind:String,pub principal_id:Option<String>,pub principal_label:Option<String>,pub is_super_admin:bool}
#[derive(Clone,Debug,Deserialize,PartialEq,Serialize)]
pub struct KeyChange{pub id:String,pub at_ms:i64,pub action:String,pub actor:ChangeActor,pub target_key_id:String,pub target_key_name:Option<String>,pub changed:Value,pub request_id:String,pub release:String}

pub fn actor(principal:&AuthPrincipal)->ChangeActor{
    let(kind,id,label)=match &principal.method{AuthMethod::PasskeySession{user_id,handle,..}=>("passkey_user",Some(user_id.clone()),Some(handle.clone())),AuthMethod::Disabled=>("local_admin",None,None),_=>("shared_admin_credential",None,None)};
    ChangeActor{kind:kind.into(),principal_id:id,principal_label:label,is_super_admin:principal.is_super_admin}
}
pub fn safe_changed(value:&Value)->Value{
    let allowed=["name","expires_at_ms","usage_limit_requests","window_ms","paid_fallback_enabled","paid_fallback_limit_credits","reset_usage","revoked_at_ms"];let mut result=serde_json::Map::new();
    if let Some(object)=value.as_object(){for(key,value)in object{if !allowed.contains(&key.as_str()){continue;}let safe=match value{Value::Null|Value::Bool(_)|Value::Number(_)=>value.clone(),Value::String(s)=>json!(s.chars().take(200).collect::<String>()),_=>continue};result.insert(key.clone(),safe);}}Value::Object(result)
}
pub fn event_key(event:&KeyChange)->RecordKey{store::key(json!(["uos_ai","api_keys","change",gateway_core::identity::MAX_SAFE_INTEGER-event.at_ms,event.id]))}
pub fn mutation<H:AuthHost>(host:&H,principal:&AuthPrincipal,request_id:&str,release:&str,action:&str,id:&str,name:Option<&str>,changed:Value)->Result<RecordMutation,GatewayError>{
    let now=host.now_ms();let event=KeyChange{id:uuid_from_random(&host.random_bytes(16)?)?,at_ms:now,action:action.into(),actor:actor(principal),target_key_id:id.into(),target_key_name:name.map(str::to_owned),changed:safe_changed(&changed),request_id:request_id.into(),release:release.into()};
    store::put(event_key(&event),&event,Some(now+RETENTION_MS),&uuid_from_random(&host.random_bytes(16)?)?)
}
