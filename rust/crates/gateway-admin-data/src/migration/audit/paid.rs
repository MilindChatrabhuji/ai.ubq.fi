use std::collections::{BTreeMap,BTreeSet};
use gateway_core::GatewayError;
use serde_json::Value;
use crate::{integer,number,text};
use crate::migration::ObservedRow;
use super::{Audit,api_id,under,safe,positive,nullable_safe,nullable_text,reference};

pub fn valid_request(v:&Value)->bool{
    v["v"]==3&&api_id(v.get("key_id"))&&api_id(v.get("request_id"))&&["policy_version","route","path","model"].iter().all(|f|text(v,f).is_some_and(|s|!s.is_empty()))&&v.get("stream").is_some_and(Value::is_boolean)&&nullable_text(v.get("reasoning"),true)&&positive(v.get("window_reset_at_ms"))&&safe(v.get("reserved_microcredits"))&&positive(v.get("quota_per_credit"))&&v.get("provider").is_none_or(|p|p=="metered"||p=="surplus")&&nullable_text(v.get("provider_request_id"),true)&&v.get("provider_quota").is_some_and(|p|p.is_null()||p.as_f64().is_some_and(|n|n.is_finite()&&n>=0.0))&&["input_tokens","output_tokens","spend_microcredits"].iter().all(|f|nullable_safe(v.get(f),false))&&["reserved","dispatched","not_dispatched"].contains(&crate::profile::js_string(&v["dispatch_state"]).as_str())&&["pending","completed","failed","incomplete","cancelled","ambiguous"].contains(&crate::profile::js_string(&v["terminal_state"]).as_str())&&["pending","settled","not_billed","unresolved"].contains(&crate::profile::js_string(&v["billing_state"]).as_str())&&safe(v.get("reconciliation_attempts"))&&["last_reconciliation_at_ms","dispatched_at_ms","terminal_at_ms","settled_at_ms"].iter().all(|f|nullable_safe(v.get(f),true))&&positive(v.get("created_at_ms"))&&positive(v.get("updated_at_ms"))
}
fn valid_window(v:&Value)->bool{v["v"]==3&&api_id(v.get("key_id"))&&text(v,"policy_version").is_some_and(|s|!s.is_empty())&&positive(v.get("window_reset_at_ms"))&&(v["limit_microcredits"] == -1||positive(v.get("limit_microcredits")))&&["settled_microcredits","reserved_microcredits","pending_count"].iter().all(|f|safe(v.get(f)))&&positive(v.get("updated_at_ms"))}

pub fn inspect_paid(rows:&[ObservedRow],known:&BTreeSet<String>,unlimited:&BTreeSet<String>,now:i64)->Result<Audit,GatewayError>{
    let mut a=Audit::default();let mut windows:BTreeMap<String,&Value>=BTreeMap::new();let mut requests:BTreeMap<String,&Value>=BTreeMap::new();let mut pending=BTreeSet::new();
    for (segment,count_name) in [("window","paid_fallback_v3_windows"),("request","paid_fallback_v3_requests"),("pending","paid_fallback_v3_pending"),("reconciliation_lease","paid_fallback_v3_reconciliation_leases"),("deletion_guard","paid_fallback_v3_deletion_guards")]{
        for row in rows.iter().filter(|r|under(&r.parts,&["uos_ai","paid_fallback","v3",segment])){
            a.count(count_name);let p=&row.parts;let v=row.value()?;let id=p.get(4).and_then(Value::as_str).unwrap_or("");let diagnostic=match segment{"window"=>"window","request"=>"request","pending"=>"pending marker","reconciliation_lease"=>"reconciliation lease",_=>"deletion guard"};
            let valid=match segment{
                "window"=>p.len()==6&&api_id(p.get(4))&&positive(p.get(5))&&valid_window(v)&&v["key_id"]==p[4]&&v["window_reset_at_ms"]==p[5],
                "request"=>p.len()==6&&api_id(p.get(4))&&api_id(p.get(5))&&valid_request(v)&&v["key_id"]==p[4]&&v["request_id"]==p[5],
                "pending"=>p.len()==6&&api_id(p.get(4))&&api_id(p.get(5))&&v.is_object()&&positive(v.get("created_at_ms"))&&positive(v.get("next_reconciliation_at_ms"))&&number(v,"next_reconciliation_at_ms")>=number(v,"created_at_ms")&&v.get("key_id").is_none_or(|v|*v==p[4])&&v.get("request_id").is_none_or(|v|*v==p[5]),
                "reconciliation_lease"=>p.len()==5&&api_id(p.get(4))&&v.is_object()&&text(v,"token").is_some_and(|s|!s.is_empty())&&positive(v.get("expires_at_ms")),
                _=>p.len()==5&&api_id(p.get(4))&&v.is_object()&&positive(v.get("created_at_ms")),
            };
            if !valid{a.errors.push(format!("paid fallback V3 {diagnostic} is malformed: {}",reference(p)));continue;}
            if ["window","request","reconciliation_lease"].contains(&segment)&&!known.contains(id){a.errors.push(format!("paid fallback V3 {diagnostic} is orphaned: {}",if segment=="request"{format!("{id}/{}",p[5].as_str().unwrap_or(""))}else{id.to_owned()}));}
            match segment{"window"=>{windows.insert(reference(&p[4..]),v);},"request"=>{requests.insert(reference(&p[4..]),v);},"pending"=>{pending.insert(reference(&p[4..]));},_=>{}}
        }
    }
    for (r,v) in &requests{
        let outstanding=v["billing_state"]=="pending"||v["billing_state"]=="unresolved";let id=text(v,"key_id").unwrap_or("");let request=text(v,"request_id").unwrap_or("");
        if outstanding&&!pending.contains(r){a.errors.push(format!("paid fallback V3 request is missing its pending marker: {id}/{request}"));}
        if !outstanding&&pending.contains(r){a.errors.push(format!("paid fallback V3 terminal request retains a pending marker: {id}/{request}"));}
        let wr=reference(&[v["key_id"].clone(),v["window_reset_at_ms"].clone()]);if !unlimited.contains(id)&&(number(v,"reserved_microcredits").unwrap_or(0.0)>0.0||(v["billing_state"]=="settled"&&number(v,"spend_microcredits").unwrap_or(0.0)>0.0))&&!windows.contains_key(&wr){a.errors.push(format!("paid fallback V3 bounded request is missing its window: {id}/{request}"));}
        if v["billing_state"]=="settled"&&v["spend_microcredits"].is_null(){a.errors.push(format!("paid fallback V3 settled request is missing spend: {id}/{request}"));}
        if outstanding&&!v["spend_microcredits"].is_null(){a.errors.push(format!("paid fallback V3 outstanding request has spend: {id}/{request}"));}
    }
    for r in &pending{if !requests.contains_key(r){a.errors.push(format!("paid fallback V3 pending marker is orphaned: {r}"));}}
    for (r,w) in &windows{
        if integer(w,"window_reset_at_ms").and_then(|reset|reset.checked_add((365-32)*super::super::retention::DAY)).is_some_and(|cutoff|cutoff<=now){continue;}
        let related:Vec<_>=requests.values().filter(|v|v["key_id"]==w["key_id"]&&v["window_reset_at_ms"]==w["window_reset_at_ms"]).collect();
        let outstanding:Vec<_>=related.iter().filter(|v|v["billing_state"]=="pending"||v["billing_state"]=="unresolved").collect();
        let reserved=outstanding.iter().map(|v|number(v,"reserved_microcredits").unwrap_or(0.0)).sum::<f64>();let settled=related.iter().filter(|v|v["billing_state"]=="settled").map(|v|number(v,"spend_microcredits").unwrap_or(0.0)).sum::<f64>();
        if reserved>9_007_199_254_740_991.0||settled>9_007_199_254_740_991.0||number(w,"pending_count")!=Some(outstanding.len()as f64)||number(w,"reserved_microcredits")!=Some(reserved)||number(w,"settled_microcredits")!=Some(settled){a.errors.push(format!("paid fallback V3 window aggregate is inconsistent: {r}"));}
    }Ok(a)
}
