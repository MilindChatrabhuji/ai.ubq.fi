#![cfg(not(target_arch="wasm32"))]
mod support;
use support::*;
use gateway_migration::*;
use gateway_core::{GatewayError,identity::{ApiKeyId,RequestId},state::*};
use gateway_auth::{crypto::sha256_base64url,store::key};
use gateway_admin_data::profile::{to_profile,from_profile};
use gateway_core::value::PortableValue;
use serde_json::{Value,json};
use std::sync::atomic::{AtomicU64,Ordering};

const SOURCE:&str="6d4d4790a7c06514b92938ff677dbfd52764461d";
fn source(parts:Value,value:Value,revision:&str,expires:Option<i64>)->SourceEntry{SourceEntry{key:parts.as_array().unwrap().iter().map(|p|to_profile(&PortableValue::from_json(p)).unwrap()).collect(),value:to_profile(&PortableValue::from_json(&value)).unwrap(),versionstamp:revision.into(),expires_at_ms:expires}}
fn capture(entries:Vec<SourceEntry>)->PrivateCapture{PrivateCapture{v:1,source_git_sha:SOURCE.into(),captured_at_ms:2200,entries}}
fn fixture()->(PrivateCapture,String){
    let token=format!("u_{}","1".repeat(64));let hash=sha256_base64url(token.as_bytes());
    let hash_record=json!({"id":"fixture-key","expires_at_ms":-1,"revoked_at_ms":null,"usage_limit_requests":2,"usage_requests":1,"usage_reset_at_ms":3000,"window_ms":1000,"usage_quota_version":3,"paid_fallback_enabled":false,"paid_fallback_limit_microcredits":0,"paid_fallback_spent_microcredits":0,"paid_fallback_reserved_microcredits":0,"paid_fallback_reservation_request_id":null});
    let mut id=hash_record.clone();for (k,v) in json!({"name":"Synthetic fixture","prefix":&token[..12],"hash":hash,"created_at_ms":1000,"paid_fallback_model_ids":[],"paid_fallback_quota_per_credit":0,"paid_fallback_max_exposure_microcredits":{},"paid_fallback_pricing_checked_at_ms":null}).as_object().unwrap(){id[k]=v.clone();}
    let window=json!({"v":3,"key_id":"fixture-key","policy_version":"v3:1000","window_start_ms":2000,"window_reset_at_ms":3000,"committed_requests":1,"reserved_requests":1,"updated_at_ms":2100});
    let request=|id:&str,state:&str|json!({"v":3,"key_id":"fixture-key","request_id":id,"route":"responses","state":state,"reserved_at_ms":2000,"lease_expires_at_ms":2100,"provider":if state=="dispatched"{json!("deepseek")}else{Value::Null},"dispatched_at_ms":if state=="dispatched"{json!(2050)}else{Value::Null},"released_at_ms":null,"release_reason":null});
    (capture(vec![source(json!(["ubq_ai","api_keys","id","fixture-key"]),id,"id-original",None),source(json!(["ubq_ai","api_keys","hash",hash]),hash_record,"hash-original",None),source(json!(["uos_ai","api_key_usage","v3","window","fixture-key","v3:1000",2000]),window,"window-original",Some(6000)),source(json!(["uos_ai","api_key_usage","v3","request","fixture-key","v3:1000",2000,"old-reserved"]),request("old-reserved","reserved"),"reserved-original",Some(6000)),source(json!(["uos_ai","api_key_usage","v3","request","fixture-key","v3:1000",2000,"old-dispatched"]),request("old-dispatched","dispatched"),"dispatched-original",Some(6000)),source(json!(["uos_ai","debug_routing","v1"]),json!({"scenario":"codex_429","expires_at_ms":5000,"updated_at_ms":2000}),"debug-original",Some(5000))]),token)
}
struct Tokens(AtomicU64);impl gateway_authority::TokenSource for Tokens{fn next_token(&self)->Result<String,GatewayError>{Ok(format!("fixture-revision-{}",self.0.fetch_add(1,Ordering::SeqCst)))}}
struct Clock;impl gateway_authority::AuthorityClock for Clock{fn now_ms(&self)->Result<i64,GatewayError>{Ok(2300)}}

#[test]
fn actual_sqlite_adoption_restart_auth_admission_mutation_and_latest_inverse(){
    let directory=Directory::new();let path=directory.file("one-authority.sqlite3");let (original,token)=fixture();let prepared=prepare(&original,&CanonicalDates).unwrap();
    let store=SqliteStore::open(&path);let receipt=run(adopt_empty(&store,&prepared)).unwrap();assert_eq!(receipt.source_rows,6);drop(store);
    let store=SqliteStore::open(&path);
    let policy=run(gateway_auth::api_keys::authenticate(&store,&token,2300)).unwrap();assert_eq!(policy.key_id,"fixture-key");
    let authority=gateway_authority::Authority::with_clock(store.clone(),Tokens(AtomicU64::new(1)),Clock);
    assert!(run(authority.reserve_api_key(&ApiKeyId("fixture-key".into()),&RequestId("old-dispatched".into()),"responses",2300)).is_err());
    let consumed=gateway_authority::quota::ApiReservation{key_id:ApiKeyId("fixture-key".into()),request_id:RequestId("old-dispatched".into()),route:"responses".into(),policy_version:"v3:1000".into(),window_start_ms:2000,window_reset_at_ms:3000,deferred:false};
    assert!(!run(authority.release_api_key(&consumed,false,"unknown source transport",2300)).unwrap());
    assert_eq!(run(store.read(&gateway_authority::keys::api_request("fixture-key","v3:1000",2000,"old-dispatched"))).unwrap().unwrap().value["state"],"dispatched");
    let reservation=run(authority.reserve_api_key(&ApiKeyId("fixture-key".into()),&RequestId("new-request".into()),"responses",2300)).unwrap();
    let old=run(store.read(&gateway_authority::keys::api_request("fixture-key","v3:1000",2000,"old-reserved"))).unwrap().unwrap();assert_eq!(old.value["state"],"released");
    let current=run(store.read(&gateway_authority::keys::api_request("fixture-key","v3:1000",2000,"new-request"))).unwrap().unwrap();assert_eq!(current.value["state"],"reserved");
    assert_eq!(reservation.request_id.0,"new-request");drop(authority);
    // Real same-authority write after restart; deleting an adopted row must not resurrect it.
    let debug=key(json!(["uos_ai","debug_routing","v1"]));let old=run(store.read(&debug)).unwrap().unwrap();
    run(store.commit(AtomicTransition{checks:vec![RevisionCheck{key:debug.clone(),expected_revision:Some(old.revision)}],mutations:vec![RecordMutation::Delete{key:debug}]})).unwrap();
    let exported=run(export_latest(&store,2300)).unwrap();
    assert!(!exported.entries.iter().any(|e|e.versionstamp=="debug-original"));
    let request=exported.entries.iter().find(|e|e.key.last()==Some(&json!({"type":"string","value":"new-request"}))).unwrap();
    let value=from_profile(&request.value).unwrap().to_json_lossless().unwrap();assert_eq!(value["request_id"],"new-request");assert!(value.get("transport_started").is_none());assert_eq!(request.expires_at_ms,current.expires_at_ms);assert_ne!(request.versionstamp,"reserved-original");
    let rollback=SqliteStore::open(&directory.file("inverse-new-destination.sqlite3"));let replay=prepare(&exported,&CanonicalDates).unwrap();run(adopt_empty(&rollback,&replay)).unwrap();
    assert!(run(gateway_auth::api_keys::authenticate(&rollback,&token,2300)).is_ok());
    let again=run(export_latest(&rollback,2300)).unwrap();assert_eq!(serde_json::to_value(&exported).unwrap(),serde_json::to_value(&again).unwrap());
}

#[test]
fn adoption_conflict_never_partially_writes_and_keeps_foreign_state(){
    let directory=Directory::new();let store=SqliteStore::open(&directory.file("conflict.sqlite3"));let (capture,_)=fixture();let prepared=prepare(&capture,&CanonicalDates).unwrap();
    let foreign_key=key(json!(["ubq_ai","api_keys","id","fixture-key"]));*store.before_commit.borrow_mut()=Some((foreign_key.clone(),StoredRecord::json("foreign-owner",json!({"preserved":true}),None)));
    assert!(run(adopt_empty(&store,&prepared)).is_err());assert_eq!(run(store.read(&foreign_key)).unwrap().unwrap().revision,"foreign-owner");
    assert!(run(store.read(&key(json!(["uos_ai","migration","v1","manifest"])))).unwrap().is_none());
    assert!(run(store.read(&gateway_authority::keys::api_policy("fixture-key"))).unwrap().is_none());
}

#[test]
fn typed_values_revision_expiry_and_deleted_rows_survive_inverse(){
    let directory=Directory::new();let store=SqliteStore::open(&directory.file("typed.sqlite3"));
    let value=PortableValue::Map(vec![(PortableValue::BigInt("123456789012345678901234567890".into()),PortableValue::Set(vec![PortableValue::number(-0.0),PortableValue::Date{epoch_ms:Some(12345)}]))]);
    let mut row=source(json!(["default","typed-fixture"]),Value::Null,"typed-source-revision",Some(9900));row.value=to_profile(&value).unwrap();let input=capture(vec![row]);
    run(adopt_empty(&store,&prepare(&input,&CanonicalDates).unwrap())).unwrap();drop(store);let store=SqliteStore::open(&directory.file("typed.sqlite3"));
    let result=run(export_latest(&store,2300)).unwrap();assert_eq!(result.entries[0].versionstamp,"typed-source-revision");assert_eq!(result.entries[0].expires_at_ms,Some(9900));assert_eq!(from_profile(&result.entries[0].value).unwrap(),from_profile(&input.entries[0].value).unwrap());
}

#[test]
fn wrong_indexes_unknown_state_and_duplicates_refuse_before_writes(){
    let (mut input,_)=fixture();input.entries[2].value["value"]["reserved_requests"]=json!({"type":"number","value":2});assert!(prepare(&input,&CanonicalDates).is_err());
    let (mut input,_)=fixture();input.entries.push(input.entries[0].clone());assert!(prepare(&input,&CanonicalDates).is_err());
    let input=capture(vec![source(json!(["unknown","arbitrary"]),json!({}),"x",None)]);assert!(prepare(&input,&CanonicalDates).is_err());
}
