use crate::*;
use gateway_authority::routing::{CapacityStore,RoutingState};
use serde_json::json;

pub(crate) fn forward_routing(v:&Value)->Result<Value,GatewayError> {
    if v["v"]!=2 {return Err(invalid("Source routing version is unsupported"));}
    let slots=v["slots"].as_array().ok_or_else(||invalid("Source routing slots missing"))?;
    let mut projected=Vec::new();
    for slot in slots {
        if slot["account_id_hash"].as_str().is_none_or(str::is_empty) {return Err(unavailable("Legacy ambiguous routing identity cannot be adopted as current proof"));}
        if slot.get("upstream_timeout_blocked_until_ms").is_some_and(|v|!v.is_null()) {return Err(unavailable("Source timeout circuit needs its owning runtime mapping"));}
        let mut blocks=serde_json::Map::new();
        if let Some(source)=slot.get("quota_blocks_by_class").and_then(Value::as_object) {
            for (class,b) in source {
                if b["legacy_fallback"]==true {return Err(unavailable("Legacy quota fallback cannot become strong proof"));}
                blocks.insert(class.clone(),json!({"blocked_until_ms":b["blocked_until_ms"],"source":b["source"],"observed_at_ms":b.get("quota_signal_observed_at_ms").and_then(Value::as_i64).unwrap_or(0),"reset_at_ms":b["observed_reset_at_ms"],"reset_is_stable":b["observed_reset_at_is_stable"],"reset_ambiguous":b["banked_reset_generation_ambiguous"],"recovery_pending":b["banked_reset_recovery_probe_pending"]}));
            }
        } else if slot.get("quota_blocked_until_ms").is_some_and(|v|!v.is_null()) {return Err(unavailable("Unclassified legacy quota block cannot become class proof"));}
        let probe=if let Some(p)=slot.get("probe_lease").filter(|p|!p.is_null()) {
            if p.get("circuit").and_then(Value::as_str).is_some_and(|s|s!="quota") {return Err(unavailable("Non-quota probe needs explicit source mapping"));}
            json!({"token":p["token"],"generation":p["generation"],"expires_at_ms":p["expires_at_ms"],"quota_class":p.get("quota_class").filter(|v|!v.is_null()).cloned().unwrap_or(json!("unknown"))})
        }else{Value::Null};
        projected.push(json!({"account_id_hash":slot["account_id_hash"],"credential_version":slot["credential_version"],"generation":slot["generation"],"invalid_credential_version":slot["invalid_credential_version"],"quota_blocks":blocks,"probe_lease":probe,"retained_reset_at_ms":slot["observed_reset_at_ms"],"reset_identity_ambiguous":slot["banked_reset_generation_ambiguous"]}));
    }
    let result=json!({"v":2,"updated_at_ms":v["updated_at_ms"],"legacy_identity_unresolved":v["banked_reset_legacy_identity_unresolved"],"slots":projected});
    let _:RoutingState=decode(&result)?;Ok(result)
}
pub(crate) fn forward_capacity(v:&Value)->Result<Value,GatewayError> {
    if v["v"]!=1 {return Err(invalid("Capacity source version invalid"));}
    let mut observations=Vec::new();
    for row in v["observations"].as_array().ok_or_else(||invalid("Capacity observations missing"))? {
        if row.get("additional_rate_limits").and_then(Value::as_array).is_some_and(|v|!v.is_empty()) {return Err(unavailable("Additional capacity class needs the source model applicability mapping"));}
        let windows=["primary","secondary"].iter().filter_map(|k|row["windows"].get(*k).filter(|v|!v.is_null()).cloned()).collect::<Vec<_>>();
        observations.push(json!({"account_id_hash":row["account_id_hash"],"available":row["state"]=="available","snapshot_at_ms":row["snapshot_at_ms"],"windows":windows,"additional":[]}));
    }
    let result=json!({"observations":observations});let _:CapacityStore=decode(&result)?;Ok(result)
}
pub(crate) fn inverse_routing(current:&Value, original:&Value)->Result<Value,GatewayError> {
    let state:RoutingState=decode(current)?;let mut out=original.clone();out["v"]=json!(2);out["updated_at_ms"]=json!(state.updated_at_ms);out["banked_reset_legacy_identity_unresolved"]=json!(state.legacy_identity_unresolved);
    let mut slots=Vec::new();
    for slot in current["slots"].as_array().ok_or_else(||invalid("Runtime routing slots missing"))? {
        let mut old=original["slots"].as_array().and_then(|a|a.iter().find(|o|o["account_id_hash"]==slot["account_id_hash"])).cloned().unwrap_or(json!({"quota_blocked_until_ms":null,"quota_block_source":null,"primary_used_percent":null,"secondary_used_percent":null,"quota_signal_observed_at_ms":null,"capacity_observed_at_ms":null,"observed_reset_at_is_stable":false,"banked_reset_recovery_probe_pending":false}));
        for f in ["account_id_hash","credential_version","generation","invalid_credential_version"] {old[f]=slot[f].clone();}
        old["observed_reset_at_ms"]=slot["retained_reset_at_ms"].clone();old["banked_reset_generation_ambiguous"]=slot["reset_identity_ambiguous"].clone();
        let mut blocks=serde_json::Map::new();for (class,b) in slot["quota_blocks"].as_object().ok_or_else(||invalid("Runtime quota blocks missing"))? {blocks.insert(class.clone(),json!({"blocked_until_ms":b["blocked_until_ms"],"source":b["source"],"legacy_fallback":false,"quota_signal_observed_at_ms":b["observed_at_ms"],"observed_reset_at_ms":b["reset_at_ms"],"observed_reset_at_is_stable":b["reset_is_stable"],"banked_reset_generation_ambiguous":b["reset_ambiguous"],"banked_reset_recovery_probe_pending":b["recovery_pending"]}));}
        old["quota_blocks_by_class"]=Value::Object(blocks);old["probe_lease"]=slot["probe_lease"].clone();if old["probe_lease"].is_object(){old["probe_lease"]["circuit"]=json!("quota");}slots.push(old);
    }
    out["slots"]=json!(slots);Ok(out)
}
pub(crate) fn inverse_capacity(current:&Value, original:&Value)->Result<Value,GatewayError> {
    let _:CapacityStore=decode(current)?;let mut out=original.clone();let mut observations=Vec::new();
    for row in current["observations"].as_array().ok_or_else(||invalid("Runtime capacity observations missing"))? {
        let mut source=original["observations"].as_array().and_then(|a|a.iter().find(|o|o["account_id_hash"]==row["account_id_hash"])).cloned().ok_or_else(||unavailable("New capacity observation requires source slot provenance"))?;
        source["state"]=json!(if row["available"]==true {"available"}else{"unavailable"});source["snapshot_at_ms"]=row["snapshot_at_ms"].clone();let windows=row["windows"].as_array().ok_or_else(||invalid("Runtime capacity windows invalid"))?;
        if windows.len()>2 || row["additional"].as_array().is_none_or(|v|!v.is_empty()) {return Err(unavailable("Runtime capacity cannot be represented by the source window mapping"));}
        source["windows"]=json!({"primary":windows.first(),"secondary":windows.get(1)});observations.push(source);
    }
    out["observations"]=json!(observations);Ok(out)
}
