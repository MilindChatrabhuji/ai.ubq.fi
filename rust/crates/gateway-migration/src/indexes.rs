use crate::*;
use gateway_authority::{keys, paid::*, quota::*};
use gateway_auth::passkeys::{PasskeyCredential,PasskeyUser};
use gateway_core::{lifecycle::BillingState};
use serde_json::json;
use std::collections::BTreeMap;

pub(crate) fn bind(rows:&mut [Row],now:i64,revision:&str)->Result<Vec<(RecordKey,StoredRecord)>,GatewayError> {
    let live=|row:&Row|row.record.expires_at_ms.is_none_or(|n|n>now);
    let snapshot:BTreeMap<String,StoredRecord>=rows.iter().filter(|r|live(r)).map(|r|(r.key.0.clone(),r.record.clone())).collect();
    let mut derived=Vec::new();
    for row in rows.iter().filter(|r|live(r)) {
        if starts(&row.parts,&["ubq_ai","api_keys","id"]) {
            let id:gateway_admin::keys::ApiKeyRecord=decode(row.record.json_value()?)?;
            let hash_key=gateway_auth::api_keys::hash_key(&id.hash);
            let hash=snapshot.get(&hash_key.0).ok_or_else(||invalid("API key hash index is missing"))?;
            let hash:gateway_auth::api_keys::ApiKeyHashRecord=decode(hash.json_value()?)?;
            if hash!=id.policy {return Err(invalid("API ID/hash policy pair conflicts"));}
            let policy=gateway_admin::keys::authority_policy(&id,now);
            derived.push((keys::api_policy(&id.policy.id),StoredRecord::json(revision,json(&policy)?,None)));
        } else if starts(&row.parts,&["ubq_ai","api_keys","hash"]) {
            let hash:gateway_auth::api_keys::ApiKeyHashRecord=decode(row.record.json_value()?)?;
            let id=snapshot.get(&gateway_auth::api_keys::id_key(&hash.id).0).ok_or_else(||invalid("Orphan API hash index"))?;
            if id.json_value()?["hash"]!=row.parts[3] {return Err(invalid("API hash names another ID"));}
        } else if starts(&row.parts,&["uos_ai","auth","users"]) {
            let user:PasskeyUser=decode(row.record.json_value()?)?;
            if snapshot.get(&gateway_auth::passkeys::key("handles",&user.handle).0).map(|r|r.json_value()).transpose()?.and_then(Value::as_str)!=Some(user.id.as_str()) {return Err(invalid("Passkey handle index conflicts"));}
            for id in &user.credential_ids {
                let credential=snapshot.get(&gateway_auth::passkeys::key("credentials",id).0).ok_or_else(||invalid("Passkey credential index missing"))?;
                let credential:PasskeyCredential=decode(credential.json_value()?)?;
                if credential.user_id!=user.id {return Err(invalid("Passkey credential belongs to another user"));}
            }
        } else if starts(&row.parts,&["uos_ai","auth","credentials"]) {
            let credential:PasskeyCredential=decode(row.record.json_value()?)?;
            let user=snapshot.get(&gateway_auth::passkeys::key("users",&credential.user_id).0).ok_or_else(||invalid("Passkey credential owner missing"))?;
            let user:PasskeyUser=decode(user.json_value()?)?;
            if !user.credential_ids.contains(&credential.credential_id) {return Err(invalid("Passkey user omits credential index"));}
        }
    }
    let mut api:BTreeMap<String,BTreeMap<String,i64>>=BTreeMap::new();
    let mut kernel:BTreeMap<String,BTreeMap<String,i64>>=BTreeMap::new();
    let mut paid:BTreeMap<String,(i64,i64)>=BTreeMap::new();
    let mut pending=BTreeMap::new();
    for row in rows.iter().filter(|r|live(r)) {
        match row.mapping.transform {
            Transform::ApiRequest=>{
                let request:ApiUsageRequest=decode(row.record.json_value()?)?;
                if request.state==ApiUsageState::Reserved {
                    let start=row.parts[6].as_f64().ok_or_else(||invalid("API window tuple start missing"))? as i64;
                    let window=keys::api_window(&request.key_id.0,row.parts[5].as_str().ok_or_else(||invalid("API policy version missing"))?,start);
                    if !snapshot.contains_key(&window.0) {return Err(invalid("API request window missing"));}
                    api.entry(window.0).or_default().insert(request.request_id.0,request.lease_expires_at_ms);
                }
            }
            Transform::KernelRequest=>{
                let request:KernelReservation=decode(row.record.json_value()?)?;
                let expected=keys::kernel_request(&request.owner,request.repo.as_deref(),request.window_created_at_ms,&request.request_id.0);
                if expected!=row.key {return Err(invalid("Kernel request tuple/identity conflict"));}
                if request.state.is_none() {
                    let window=keys::kernel_window(&request.owner,request.repo.as_deref());
                    let source=snapshot.get(&window.0).ok_or_else(||invalid("Kernel request window missing"))?;
                    let source:KernelWindow=decode(source.json_value()?)?;
                    if source.created_at_ms!=request.window_created_at_ms || source.usage_reset_at_ms!=request.window_reset_at_ms {return Err(invalid("Kernel reservation belongs to another window"));}
                    kernel.entry(window.0).or_default().insert(request.request_id.0,request.lease_expires_at_ms);
                }
            }
            Transform::PaidRequest=>{
                let attempt:PaidAttempt=decode(row.record.json_value()?)?;
                if crate::projection::outstanding(&attempt) {
                    let window=keys::paid_window(&attempt.reservation.key_id.0,attempt.reservation.window_reset_at_ms);
                    let count=paid.entry(window.0).or_default();
                    count.0=count.0.checked_add(1).ok_or_else(||invalid("Paid pending count overflows"))?;
                    count.1=count.1.checked_add(attempt.reservation.reserved_microcredits).ok_or_else(||invalid("Paid exposure overflows"))?;
                    if !snapshot.contains_key(&keys::paid_pending(&attempt.reservation.key_id.0,&attempt.reservation.attempt_id.0).0) {return Err(invalid("Outstanding paid request lacks its persistent pending marker"));}
                }
            }
            Transform::PaidPending=>{
                let marker:PendingPaid=decode(row.record.json_value()?)?;
                let attempt=snapshot.get(&keys::paid_attempt(&marker.key_id.0,&marker.attempt_id.0).0).ok_or_else(||invalid("Pending paid marker has missing or expired request"))?;
                let attempt:PaidAttempt=decode(attempt.json_value()?)?;
                if !matches!(attempt.billing_state,BillingState::Pending|BillingState::Unresolved) {return Err(invalid("Settled paid request retains conflicting pending marker"));}
                pending.insert(json!([marker.key_id.0,marker.attempt_id.0]).to_string(),marker);
            }
            _=>{}
        }
    }
    let mut has_gate=false;
    for row in rows.iter_mut().filter(|r|live(r)) {
        match row.mapping.transform {
            Transform::ApiWindow=>{
                let mut window:ApiUsageWindow=decode(row.record.json_value()?)?;
                window.reservations=api.remove(&row.key.0).unwrap_or_default();
                if window.reserved_requests!=window.reservations.len() as i64 {return Err(invalid("API reserved aggregate lacks exact source rows"));}
                row.record.value=json(&window)?;
            }
            Transform::KernelWindow=>{
                let mut window:KernelWindow=decode(row.record.json_value()?)?;
                if keys::kernel_window(&window.owner,window.repo.as_deref())!=row.key {return Err(invalid("Kernel window tuple identity conflict"));}
                window.reservations=kernel.remove(&row.key.0).unwrap_or_default();
                if window.reserved_requests!=window.reservations.len() as i64 {return Err(invalid("Kernel reserved aggregate lacks exact source rows"));}
                // Preserve source-only fields for m12/source admin readers and the inverse.
                row.record.value["reservations"]=json(&window.reservations)?;
            }
            Transform::PaidGate=>{
                has_gate=true;let old:ReconciliationGate=decode(row.record.json_value()?)?;
                let minimum=pending.values().map(|p|p.next_reconciliation_at_ms).min();
                let next=match (old.next_due_at_ms,minimum) {(Some(a),Some(b))=>Some(a.min(b)),(a,b)=>a.or(b)};
                row.record.value=json(&ReconciliationGate{next_due_at_ms:next,pending:pending.clone()})?;
            }
            _=>{
                if starts(&row.parts,&["uos_ai","paid_fallback","v3","window"]) {
                    let window:PaidWindow=decode(row.record.json_value()?)?;
                    let (count,exposure)=paid.remove(&row.key.0).unwrap_or_default();
                    if count!=window.pending_count || exposure!=window.reserved_microcredits {return Err(invalid("Paid window outstanding count/exposure conflicts with imported requests"));}
                }
            }
        }
    }
    if !api.is_empty()||!kernel.is_empty()||!paid.is_empty() {return Err(invalid("Reservation index has an orphan window"));}
    if !has_gate && !pending.is_empty() {
        let gate=ReconciliationGate{next_due_at_ms:pending.values().map(|p|p.next_reconciliation_at_ms).min(),pending};
        derived.push((keys::paid_gate(),StoredRecord::json(revision,json(&gate)?,None)));
    }
    Ok(derived)
}

