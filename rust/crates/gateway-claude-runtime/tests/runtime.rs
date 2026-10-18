#![cfg(not(target_arch = "wasm32"))]
mod support;
use support::*;
use gateway_admin_runtime::{claude::{self,AccountUpdate},claude_access};
use gateway_claude_runtime::*;
use gateway_providers::Headers;
use serde_json::{Value,json};

#[test]
fn authoritative_refusal_rotates_durable_active_and_all_current_accounts_prove_paid() {
    let store=Store::new();let a=account(1);let b=account(2);let config=seed(&store,vec![a.clone(),b.clone()]);let host=Host::new(&store);let session=ClaudePoolSession::new(config.clone());let raw=raw();
    let first=selected(&session,&store,&host,&raw);assert_eq!(first.binding().account_id,a.account_id);
    assert!(matches!(apply(&session,&store,&host,&first,429,exhausted(NOW),NOW),OutcomeDecision::Retry));
    assert_eq!(store.roster().active_account_id,Some(b.account_id.clone()));assert_eq!(store.roster().active_reason,"authoritative_unavailability");
    let next=selected(&session,&store,&host,&raw);assert_eq!(next.binding().account_id,b.account_id);
    assert!(matches!(apply(&session,&store,&host,&next,429,exhausted(NOW),NOW),OutcomeDecision::Paid));
    let restarted=ClaudePoolSession::new(config);assert!(matches!(run(restarted.select(&store,&host,SelectionInput{key_id:KEY,model:MODEL,raw:&raw,selection:None})).unwrap(),PoolSelection::Unavailable));
}
#[test]
fn transient_and_transport_failure_keep_active_and_do_not_invent_proof() {
    let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone(),account(2)]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=raw();let first=selected(&session,&store,&host,&raw);
    assert!(matches!(apply(&session,&store,&host,&first,503,Headers::new(),NOW),OutcomeDecision::Preserve));
    run(session.observe_transport_failure(&store,&host,&first)).unwrap();assert!(store.quota(&a).is_none());assert_eq!(store.roster().active_account_id,Some(a.account_id));assert!(host.accepted.borrow().is_empty());
}
#[test]
fn generic_429_cools_down_but_never_rotates_and_no_reset_limit_has_no_proof() {
    for headers in [Headers::new(),Headers::from([("anthropic-ratelimit-unified-5h-status".into(),"limited".into())])] {
        let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone(),account(2)]);let host=Host::new(&store);let session=ClaudePoolSession::new(config.clone());let raw=raw();let first=selected(&session,&store,&host,&raw);
        assert!(matches!(apply(&session,&store,&host,&first,429,headers,NOW),OutcomeDecision::Preserve));assert!(quota::applicable_proof(store.quota(&a).as_ref(),&a,MODEL,NOW).is_none());assert_eq!(store.roster().active_account_id,Some(a.account_id));
        if quota::cooling_down(store.quota(first.binding()).as_ref(),NOW){let next=ClaudePoolSession::new(config);let error=run(next.select(&store,&host,SelectionInput{key_id:KEY,model:MODEL,raw:&raw,selection:None})).unwrap_err();assert_eq!(error.status,429);}
    }
}
#[test]
fn a_success_is_recorded_at_head_receipt_before_any_clone_and_clears_older_proof_only() {
    let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone()]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=raw();let first=selected(&session,&store,&host,&raw);
    let denied=run(session.observe_response(&store,&host,&first,head(401,Headers::new(),NOW))).unwrap();assert!(matches!(run(session.after_outcome(&store,&host,denied,response::ErrorEvidence::default())).unwrap(),OutcomeDecision::Paid));
    let older=run(session.observe_response(&store,&host,&first,head(200,Headers::new(),NOW-1))).unwrap();assert!(quota::applicable_proof(store.quota(&a).as_ref(),&a,MODEL,NOW).is_some());drop(older);
    let newer=run(session.observe_response(&store,&host,&first,head(200,Headers::new(),NOW+1))).unwrap();assert!(quota::applicable_proof(store.quota(&a).as_ref(),&a,MODEL,NOW+1).is_none());drop(newer);
}
#[test]
fn principal_revocation_and_current_catalog_generation_change_refuse_before_dispatch() {
    let store=Store::new();let config=seed(&store,vec![account(1)]);let host=Host::new(&store);let session=ClaudePoolSession::new(config.clone());let raw=raw();let first=selected(&session,&store,&host,&raw);
    store.allow(json!([]));assert_eq!(run(session.ensure_current(&store,&host,&first,KEY,MODEL,&raw)).unwrap_err().status,403);
    store.allow(json!([KEY]));config.generation.record_success(gateway_admin_runtime::claude_generation::StateChange::CredentialStored);
    assert_eq!(run(session.ensure_current(&store,&host,&first,KEY,MODEL,&raw)).unwrap_err().status,400);
}
#[test]
fn a_persisted_empty_deny_and_roster_tombstone_cannot_bootstrap_an_account() {
    let store=Store::new();let config=seed(&store,vec![]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=raw();
    assert!(matches!(run(session.select(&store,&host,SelectionInput{key_id:KEY,model:MODEL,raw:&raw,selection:None})).unwrap(),PoolSelection::NotApplicable));
    store.allow(json!([]));let raw_before=store.get(&claude::account_store_key()).unwrap();assert!(matches!(run(session.select(&store,&host,SelectionInput{key_id:KEY,model:MODEL,raw:&raw,selection:None})).unwrap(),PoolSelection::NotApplicable));assert_eq!(store.get(&claude::account_store_key()).unwrap(),raw_before);
}
#[test]
fn guard_clear_rotates_evidence_and_rejects_late_headers_in_real_quota_cas() {
    let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone()]);let host=std::rc::Rc::new(Host::new(&store));let session=std::rc::Rc::new(ClaudePoolSession::new(config));let raw=raw();let first=selected(&session,&store,&host,&raw);
    let s=store.clone();let h=host.clone();let old=a.clone();*store.before_commit.borrow_mut()=Some(Box::new(move||{run(clear_guards(&s,&*h,&old)).unwrap().unwrap();}));
    let _=apply(&session,&store,&host,&first,401,Headers::new(),NOW);
    let current=store.roster().accounts[0].clone();assert_ne!(current.evidence_generation,a.evidence_generation);assert!(store.quota(&current).unwrap().pool_proofs.unwrap().is_empty());assert!(host.accepted.borrow().is_empty());assert!(host.health.borrow().is_empty());
}
#[test]
fn credential_replacement_rejects_old_quota_and_health_without_touching_other_account() {
    let store=Store::new();let a=account(1);let b=account(2);let config=seed(&store,vec![a.clone(),b.clone()]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=raw();let first=selected(&session,&store,&host,&raw);
    let mut credential=a.credential.clone();credential.secret=gateway_auth::crypto::Secret::new("fixture-new-secret".into());
    run(claude::update_account(&store,&host,&Default::default(),&AccountUpdate{account_id:Some(a.account_id.clone()),create_new:false,credential:Some(credential),workspace:None,activate:false,expected:Some(a.clone())})).unwrap();
    let _=apply(&session,&store,&host,&first,401,exhausted(NOW),NOW);assert!(store.quota(&a).is_none());assert!(host.accepted.borrow().is_empty());assert!(host.health.borrow().is_empty());assert_eq!(store.roster().accounts[1],b);
}
#[test]
fn optional_history_and_health_failure_do_not_undo_accepted_quota_or_proof() {
    let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone()]);let host=Host::new(&store);host.fail_telemetry.set(true);let session=ClaudePoolSession::new(config);let raw=raw();let first=selected(&session,&store,&host,&raw);
    assert!(matches!(apply(&session,&store,&host,&first,429,exhausted(NOW),NOW),OutcomeDecision::Paid));assert!(quota::applicable_proof(store.quota(&a).as_ref(),&a,MODEL,NOW).is_some());assert_eq!(host.accepted.borrow().len(),1);
}
#[test]
fn independent_header_families_merge_after_a_real_concurrent_sqlite_cas() {
    let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone()]);let host=std::rc::Rc::new(Host::new(&store));let primary=ClaudePoolSession::new(config.clone());let rival=std::rc::Rc::new(ClaudePoolSession::new(config));let raw=raw();let one=selected(&primary,&store,&host,&raw);let two=selected(&rival,&store,&host,&raw);
    let s=store.clone();let h=host.clone();let r=rival.clone();*store.after_read.borrow_mut()=Some((quota_key(&a),Box::new(move||{let _=run(r.observe_response(&s,&*h,&two,head(200,Headers::from([("anthropic-ratelimit-unified-7d-utilization".into(),"0.3".into())]),NOW)));})));
    let _=run(primary.observe_response(&store,&*host,&one,head(200,Headers::from([("anthropic-ratelimit-unified-5h-utilization".into(),"0.2".into())]),NOW))).unwrap();
    let quota=store.quota(&a).unwrap();assert_eq!(quota.windows.len(),2);assert_eq!(host.accepted.borrow().len(),2);
}
#[test]
fn workspace_retry_selects_default_rotates_cohort_and_does_not_refetch_effort_catalog() {
    let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone()]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=json!({"model":MODEL,"input":"fixture","reasoning":{"effort":"high"}});let first=selected(&session,&store,&host,&raw);assert_eq!(host.catalog_calls.get(),1);
    let observed=run(session.observe_response(&store,&host,&first,head(400,Headers::new(),NOW))).unwrap();
    let decision=run(session.after_outcome(&store,&host,observed,response::ErrorEvidence{prefix:Some("not scoped to a workspace".encode_utf16().collect()),complete:true})).unwrap();
    let OutcomeDecision::WorkspaceContinuation(next)=decision else{panic!("expected workspace continuation")};assert_eq!(next.binding().workspace.as_ref().unwrap().id,"wrkspc_default");assert_ne!(next.binding().account_cohort_id,a.account_cohort_id);assert_eq!(host.catalog_calls.get(),1);assert!(store.quota(&a).is_none());assert_ne!(first.replay_scope(),next.replay_scope());
}
#[test]
fn disabled_thinking_refusal_never_discovers_workspace_or_transfers_permission() {
    let store=Store::new();let config=seed(&store,vec![account(1)]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=json!({"model":MODEL,"input":"fixture","reasoning":{"effort":"none"}});let first=selected(&session,&store,&host,&raw);
    let observed=run(session.observe_response(&store,&host,&first,head(400,Headers::new(),NOW))).unwrap();assert!(matches!(run(session.after_outcome(&store,&host,observed,response::ErrorEvidence{prefix:Some("not scoped to a workspace".encode_utf16().collect()),complete:true})).unwrap(),OutcomeDecision::Preserve));assert_eq!(host.workspace_calls.get(),0);
}
#[test]
fn revocation_during_workspace_fetch_refuses_retry_before_owner_update() {
    let store=Store::new();let a=account(1);let config=seed(&store,vec![a.clone()]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=raw();let first=selected(&session,&store,&host,&raw);let s=store.clone();*host.workspace_action.borrow_mut()=Some(Box::new(move||s.allow(json!([]))));
    let observed=run(session.observe_response(&store,&host,&first,head(400,Headers::new(),NOW))).unwrap();let error=run(session.after_outcome(&store,&host,observed,response::ErrorEvidence{prefix:Some("not scoped to a workspace".encode_utf16().collect()),complete:true})).unwrap_err();assert_eq!(error.status,403);assert_eq!(store.roster().accounts[0],a);
}
#[test]
fn real_sqlite_close_reopen_retains_global_active_and_quota() {
    let path=std::env::temp_dir().join(format!("m21-restart-{}.sqlite",std::process::id()));let _=std::fs::remove_file(&path);
    let a=account(1);let b=account(2);
    {let store=Store::open(&path);let config=seed(&store,vec![a.clone(),b.clone()]);let host=Host::new(&store);let session=ClaudePoolSession::new(config);let raw=raw();let first=selected(&session,&store,&host,&raw);assert!(matches!(apply(&session,&store,&host,&first,429,exhausted(NOW),NOW),OutcomeDecision::Retry));}
    {let reopened=Store::open(&path);assert_eq!(reopened.roster().active_account_id,Some(b.account_id));assert!(quota::applicable_proof(reopened.quota(&a).as_ref(),&a,MODEL,NOW).is_some());}
    std::fs::remove_file(path).unwrap();
}
