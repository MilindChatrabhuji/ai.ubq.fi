use crate::{AdminRuntime,capabilities::{Context,RuntimeCapabilities},parse,store};
use gateway_admin::AdminInput;
use gateway_auth::{AuthHost,AuthResponse,invalid};
use gateway_core::{GatewayError,query::QueryStore};
use serde_json::{Value,json};
use std::collections::BTreeMap;

const LEGACY_INTERRUPTED:[&str;15]=[
    "4d2928f47f3ba3ad66b8c15e6323bcccd0a39390","0d795e28e42be63bbd7f0d4ce44d8ea0f6ab9d4a","149ef399a52373ba09d75cfd00d5e5139564dcdf","8532ec7ee1fc5a6a9bb44fe2a3703527b8d78952","35fb0782c01309a85ea08f5a6a48f8de62a1f29f","c18a4e091c09c7a9e04588a8fe745c696deaf6d2","214957fe322c8cff6ad20ddea55dcf9576273107","50c06cd8e93fe3b34a9699d31f1f8998f632fbe6","64f4ba5a21e476386f95c8474bd76b037e6afc4f","7fb508a076e9edf04c6e4087a19ad6e25452dc6b","c9bcf7d5937cf137bc34d8656187d3f20e9f8b4d","9d3b7d0eb8a1c57079d298b17d50d25f74dd39d9","542df9ef4560ca9c090925a5a1b24a141a584867","ce37210d58746a2ed3aec34c38b370f7060639e1","f9dec6c3b6270813be7b4a957221f7130c37a52b",
];
fn nullable_string(v:Option<&Value>)->bool{v.is_some_and(|v|v.is_null()||v.is_string())}
fn valid(v:&Value)->bool{
    v.get("version")==Some(&json!(1)) && ["request_id","route","provider","terminal_type","failure_kind"].into_iter().all(|name|v.get(name).is_some_and(Value::is_string))
        && ["status","created_at_ms","latency_ms"].into_iter().all(|name|v.get(name).is_some_and(Value::is_number))
        && ["model","reasoning","git_sha","deno_revision"].into_iter().all(|name|nullable_string(v.get(name)))
        && v.get("stream").is_some_and(|v|v.is_null()||v.is_boolean()) && [Some("delivered"),Some("interrupted"),Some("unobserved")].contains(&v.get("delivery_outcome").and_then(Value::as_str))
}
fn suppress(v:&Value)->bool{v["status"]==200 && v["stream"]==true && v["terminal_type"]=="error" && v["failure_kind"]=="missing_sse_terminal" && v["delivery_outcome"]=="interrupted" && v["git_sha"].as_str().is_some_and(|sha|LEGACY_INTERRUPTED.contains(&sha))}
impl<S:QueryStore,H:AuthHost,C:RuntimeCapabilities> AdminRuntime<'_,S,H,C>{
    pub(crate) async fn errors(&self,input:&AdminInput)->Result<AuthResponse,GatewayError>{
        let limit=match parse::first(&input.query,"limit"){
            None=>100,
            Some(s)=>s.trim().parse::<f64>().ok().filter(|n|n.is_finite()&&n.fract()==0.0&&(1.0..=500.0).contains(n)).map(|n|n as usize).ok_or_else(||invalid("limit must be an integer from 1 to 500"))?,
        };
        let mut data=Vec::new();let mut buckets=BTreeMap::<i64,u64>::new();
        for entry in store::scan(self.store,store::key(json!(["uos_ai","admin_error_log","v1"])),true,input.now_ms).await?{
            let row=entry.record.json_value()?;if !valid(row){continue}
            if row["status"].as_f64().is_some_and(|s|(500.0..=599.0).contains(&s)){
                let time=row["created_at_ms"].as_f64().expect("validated number");let bucket=(time/900000.0).floor() as i64*900000;
                *buckets.entry(bucket).or_default()+=1;
            }
            if data.len()<limit && !suppress(row){data.push(row.clone())}
        }
        let diagnostics=self.capabilities.error_diagnostics(Context{request_id:input.request_id.clone(),now_ms:input.now_ms}).await?;
        let buckets:Vec<Value>=buckets.into_iter().map(|(time,count)|json!({"bucket_start_at_ms":time,"count":count})).collect();
        Ok(AuthResponse::json(200,json!({"object":"list","data":data,"five_xx_buckets":buckets,"retention":diagnostics.retention,"log_files":diagnostics.log_files})))
    }
}
