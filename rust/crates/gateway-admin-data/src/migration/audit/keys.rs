use std::collections::BTreeMap;
use gateway_core::GatewayError;
use serde_json::Value;
use crate::text;
use crate::migration::ObservedRow;
use super::{Audit,api_id,positive,safe,nullable_text,nullable_safe,reference,under};

fn hash(v:Option<&Value>)->bool{v.and_then(Value::as_str).is_some_and(|s|s.len()==43&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'))}
fn paid_policy(v:&Value,key:bool)->bool{
    if !v.get("paid_fallback_enabled").is_some_and(Value::is_boolean)||!(v["paid_fallback_limit_microcredits"] == -1||safe(v.get("paid_fallback_limit_microcredits")))||!["paid_fallback_spent_microcredits","paid_fallback_reserved_microcredits"].iter().all(|f|safe(v.get(f)))||!nullable_text(v.get("paid_fallback_reservation_request_id"),false){return false;}
    let enabled=v["paid_fallback_enabled"]==true;if enabled&&v["paid_fallback_limit_microcredits"] != -1&&!positive(v.get("paid_fallback_limit_microcredits")){return false;}
    if !key{return true;}let models=v["paid_fallback_model_ids"].as_array();if models.is_none_or(|models|models.iter().any(|m|m.as_str().is_none_or(|s|s.trim().is_empty())))||!safe(v.get("paid_fallback_quota_per_credit"))||!nullable_safe(v.get("paid_fallback_pricing_checked_at_ms"),true){return false;}
    !enabled||(models.is_some_and(|m|!m.is_empty())&&positive(v.get("paid_fallback_quota_per_credit"))&&positive(v.get("paid_fallback_pricing_checked_at_ms")))
}
pub fn valid_key_policy(v:&Value,key:bool)->bool{
    if !paid_policy(v,key)||!api_id(v.get("id"))||!(v["expires_at_ms"] == -1||safe(v.get("expires_at_ms")))||!nullable_safe(v.get("revoked_at_ms"),false)||!(v["usage_limit_requests"] == -1||safe(v.get("usage_limit_requests")))||!safe(v.get("usage_requests"))||!positive(v.get("usage_reset_at_ms"))||!positive(v.get("window_ms")){return false;}
    !key||(hash(v.get("hash"))&&text(v,"prefix").is_some_and(|p|p.len()==12&&p.starts_with("u_")&&p[2..].bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))))
}
pub fn inspect_key_pairs(rows:&[ObservedRow])->Result<(Vec<(Value,Value)>,Audit),GatewayError>{
    let mut audit=Audit::default();let mut hashes=BTreeMap::new();let mut refs:BTreeMap<String,usize>=BTreeMap::new();let mut pairs=vec![];
    for row in rows.iter().filter(|r|under(&r.parts,&["ubq_ai","api_keys","hash"])){
        audit.count("api_key_hashes");let p=&row.parts;let value=row.value()?;if p.len()!=4||!hash(p.get(3)){audit.errors.push(format!("api key hash entry has an invalid key: {}",reference(p)));continue;}
        let hash=p[3].as_str().unwrap_or("");if !valid_key_policy(value,false){audit.errors.push(format!("api key hash policy has invalid core fields: {hash}"));continue;}hashes.insert(hash.to_owned(),value.clone());
    }
    for row in rows.iter().filter(|r|under(&r.parts,&["ubq_ai","api_keys","id"])){
        audit.count("api_key_ids");let p=&row.parts;let v=row.value()?;if p.len()!=4||!api_id(p.get(3)){audit.errors.push(format!("api key id entry has an invalid key: {}",reference(p)));continue;}
        let id=p[3].as_str().unwrap_or("");if !valid_key_policy(v,true){audit.errors.push(format!("api key has invalid v2 policy: {id}"));continue;}
        if text(v,"id")!=Some(id){audit.errors.push(format!("api key id key suffix does not match record id: key={id} record={}",text(v,"id").unwrap_or("")));continue;}
        let hash=text(v,"hash").unwrap_or("");let paired=hashes.get(hash);let fields=["id","expires_at_ms","revoked_at_ms","usage_limit_requests","usage_requests","usage_reset_at_ms","window_ms","usage_quota_version","paid_fallback_enabled","paid_fallback_limit_microcredits","paid_fallback_spent_microcredits","paid_fallback_reserved_microcredits","paid_fallback_reservation_request_id"];
        if paired.is_none_or(|h|fields.iter().any(|f|v.get(f)!=h.get(f))){audit.errors.push(format!("api key hash policy is missing or inconsistent: {id}"));continue;}*refs.entry(hash.to_owned()).or_default()+=1;pairs.push((v.clone(),paired.cloned().unwrap_or(Value::Null)));
    }
    for hash in hashes.keys(){match refs.get(hash).copied().unwrap_or(0){0=>audit.errors.push(format!("api key hash policy is orphaned: {hash}")),n if n>1=>audit.errors.push(format!("api key hash policy has multiple id records: {hash}")),_=>{}}}
    let ids=audit.counts.get("api_key_ids").copied().unwrap_or(0);let hash_count=audit.counts.get("api_key_hashes").copied().unwrap_or(0);if ids!=hash_count{audit.errors.insert(0,format!("api key id/hash count mismatch: ids={ids} hashes={hash_count}"));}
    for row in rows.iter().filter(|r|under(&r.parts,&["uos_ai","migrations","kv_read_incident_v2","api_key_usage_baseline"])) {audit.count("api_key_bounded_counter_baselines_v2");let value=row.value()?;if super::super::counter::valid_baseline(value)&&!value["reconciled_at_ms"].is_null(){audit.count("api_key_bounded_counter_reconciled_baselines_v2");}}
    audit.counts.insert("api_key_bounded_counters_v2".into(),rows.iter().filter(|r|under(&r.parts,&["uos_ai","api_key_usage","v2"])).count());
    Ok((pairs,audit))
}
