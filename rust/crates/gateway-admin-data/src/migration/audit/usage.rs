use std::collections::{BTreeMap,BTreeSet};
use gateway_core::GatewayError;
use serde_json::{Value,json};
use super::{Audit,api_id,under,safe,reference,valid_api_window,valid_api_request,valid_kernel_policy};
use crate::{integer,text};
use crate::migration::{ObservedRow,kernel};

pub fn inspect_api_usage(rows:&[ObservedRow],known:&BTreeSet<String>)->Result<Audit,GatewayError>{
    let mut a=Audit::default();let mut windows=BTreeMap::new();let mut reserved:BTreeMap<String,i64>=BTreeMap::new();let mut requests=BTreeSet::new();
    for row in rows.iter().filter(|r|under(&r.parts,&["uos_ai","api_key_usage","v3","window"])){
        a.count("api_key_usage_v3_windows");let p=&row.parts;let v=row.value()?;
        if p.len()!=7||!api_id(p.get(4))||!p[5].as_str().is_some_and(|s|!s.is_empty())||!safe(p.get(6))||!valid_api_window(v)||v["key_id"]!=p[4]||v["policy_version"]!=p[5]||v["window_start_ms"]!=p[6]{a.errors.push(format!("API key usage V3 window is malformed: {}",reference(p)));continue;}
        if !known.contains(p[4].as_str().unwrap_or("")){a.errors.push(format!("API key usage V3 window is orphaned: {}",p[4].as_str().unwrap_or("")));}windows.insert(reference(&p[4..]),v);
    }
    for row in rows.iter().filter(|r|under(&r.parts,&["uos_ai","api_key_usage","v3","request"])){
        a.count("api_key_usage_v3_requests");let p=&row.parts;let v=row.value()?;
        if p.len()!=8||!api_id(p.get(4))||!p[5].as_str().is_some_and(|s|!s.is_empty())||!safe(p.get(6))||!api_id(p.get(7))||!valid_api_request(v)||v["key_id"]!=p[4]||v["request_id"]!=p[7]{a.errors.push(format!("API key usage V3 request is malformed: {}",reference(p)));continue;}
        let id=p[4].as_str().unwrap_or("");let request=p[7].as_str().unwrap_or("");if !known.contains(id){a.errors.push(format!("API key usage V3 request is orphaned: {id}/{request}"));}
        let r=reference(&p[4..7]);requests.insert(r.clone());if v["state"]=="reserved"{*reserved.entry(r).or_default()+=1;}
    }
    for (r,w) in &windows{if integer(w,"reserved_requests")!=Some(*reserved.get(r).unwrap_or(&0)){a.errors.push(format!("API key usage V3 reserved aggregate is inconsistent: {r}"));}}
    for r in requests{if !windows.contains_key(&r){a.errors.push(format!("API key usage V3 request has no window: {r}"));}}Ok(a)
}

pub fn inspect_kernel(rows:&[ObservedRow])->Result<Audit,GatewayError>{
    let mut a=Audit::default();let mut windows:BTreeMap<String,(Value,bool)>=BTreeMap::new();let mut reserved:BTreeMap<String,i64>=BTreeMap::new();let mut resets=BTreeMap::new();
    for scope in ["repo","org"]{
        for kind in ["policy","window","reservation"]{
            let segment=format!("{scope}_{kind}");let count_name=format!("kernel_v2_{scope}_{kind}s");
            for row in rows.iter().filter(|r|under(&r.parts,&["uos_ai","kernel_quota","v2",&segment])){
                a.count(&count_name);let p=&row.parts;let value=row.value()?;
                let Some((_,owner,repo))=kernel::identity(p,kind)else{a.errors.push(format!("kernel quota V2 {kind} is malformed: {}",reference(p)));continue;};
                if kind=="policy"{if !valid_kernel_policy(value,scope,&owner,repo.as_deref()){a.errors.push(format!("kernel quota V2 policy is malformed: {}",reference(p)));}continue;}
                let mut reference_parts=vec![json!(scope),json!(owner)];if let Some(repo)=&repo{reference_parts.push(json!(repo));}
                if kind=="window"{
                    let Some(window)=kernel::normalize_window(value,scope,&owner,repo.as_deref())else{a.errors.push(format!("kernel quota V2 window is malformed: {}",reference(p)));continue;};reference_parts.push(window["created_at_ms"].clone());windows.insert(reference(&reference_parts),(window,value.get("reserved_requests").is_some()));continue;
                }
                let offset=if scope=="repo"{6}else{5};let valid_key=p.len()==offset+2&&safe(p.get(offset))&&p.get(offset+1).and_then(Value::as_str).is_some_and(|s|!s.is_empty());
                let reservation=kernel::normalize_reservation(value,scope,&owner,repo.as_deref());
                if !valid_key||reservation.as_ref().is_none_or(|v|v["window_created_at_ms"]!=p[offset]||v["request_id"]!=p[offset+1]){a.errors.push(format!("kernel quota V2 reservation is malformed: {}",reference(p)));continue;}
                let reservation=reservation.unwrap_or(Value::Null);reference_parts.push(reservation["window_created_at_ms"].clone());let r=reference(&reference_parts);let reset=reservation["window_reset_at_ms"].clone();
                if resets.get(&r).is_some_and(|known|*known!=reset){a.errors.push(format!("kernel quota V2 reservation window identity is inconsistent: {r}"));}else{resets.insert(r.clone(),reset);}
                if reservation["state"]=="reserved"{*reserved.entry(r).or_default()+=1;}
            }
        }
    }
    for (r,(window,has_aggregate)) in &windows{
        if resets.get(r).is_some_and(|reset|*reset!=window["usage_reset_at_ms"]){a.errors.push(format!("kernel quota V2 reservation window reset is inconsistent: {r}"));}
        if *has_aggregate&&integer(window,"reserved_requests")!=Some(*reserved.get(r).unwrap_or(&0)){a.errors.push(format!("kernel quota V2 reserved aggregate is inconsistent: {r}"));}
    }
    for r in reserved.keys(){if !windows.contains_key(r){a.errors.push(format!("kernel quota V2 active reservation has no window: {r}"));}}Ok(a)
}
