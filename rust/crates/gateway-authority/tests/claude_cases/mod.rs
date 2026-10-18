use super::*;

fn claude_roster() -> serde_json::Value {
    let fingerprints = [
        "9cc246b6cca9922b599dc79dd47742b480f503ff93a750dafb3f63e9893b0425",
        "56c1de9eedd97e337a68013110eaeed44cb4da2422d9c9b99b791f14fe910396",
    ];
    let accounts: Vec<_> = fingerprints.iter().enumerate().map(|(slot, fingerprint)| {
        let id = slot + 1;
        serde_json::json!({
            "account_id":format!("aaaaaaaa-aaaa-aaaa-aaaa-{id:012}"),
            "account_cohort_id":format!("bbbbbbbb-bbbb-bbbb-bbbb-{id:012}"),
            "evidence_generation":format!("cccccccc-cccc-cccc-cccc-{id:012}"),
            "credential_fingerprint":fingerprint,
            "credential":{"kind":"api_key","secret":format!("fixture-only-claude-key-{id}"),"hint":"fixture","label":null,"source":"kv","updated_at_ms":NOW},
            "workspace":{"id":format!("wrkspc_fixture{id}"),"name":null,"source":"kv","discovered_at_ms":null,"verified_at_ms":NOW,"last_error":null}
        })
    }).collect();
    serde_json::json!({"v":1,"accounts":accounts,"active_account_id":accounts[0]["account_id"],"active_reason":"first_configured","updated_at_ms":NOW})
}

fn claude_quota(roster: &serde_json::Value, slot: usize, kind: &str) -> serde_json::Value {
    serde_json::json!({
        "updated_at_ms":NOW,"windows":{},"standard":{},"representative_claim":null,
        "blocked_until_ms":NOW+300_000,"block_window":"5h","cooldown_until_ms":null,"last_error":null,
        "pool_proofs":{"source-key":{"kind":kind,"model_id":if kind=="auth_invalid" { serde_json::Value::Null } else { serde_json::json!("paid-model") },
        "observed_at_ms":NOW,"expires_at_ms":NOW+300_000,"evidence_generation":roster["accounts"][slot]["evidence_generation"]}}
    })
}

fn claude_key(roster: &serde_json::Value, slot: usize) -> gateway_core::state::RecordKey {
    keys::claude_quota(roster["accounts"][slot]["account_id"].as_str().unwrap(),roster["accounts"][slot]["account_cohort_id"].as_str().unwrap())
}

fn claude_setup(store: &MemoryStore) -> serde_json::Value {
    paid_setup(store);
    let roster = claude_roster();
    store.seed(keys::claude_accounts(), &roster);
    for slot in 0..2 { store.seed(claude_key(&roster, slot), &claude_quota(&roster, slot, if slot==0 {"auth_invalid"} else {"quota_exhausted"})); }
    roster
}

#[test]
fn claude_current_mixed_cohort_authorizes_once_without_exposing_secrets() {
    let store=MemoryStore::default();claude_setup(&store);let authority=authority(&store);
    let proof=run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().unwrap();
    assert_eq!(proof.model(),"paid-model");assert_eq!(proof.selected_count(),2);
    assert!(!format!("{proof:?}").contains("fixture-only-claude-key"));
    let input=paid_request("claude-paid",PaidProvider::Surplus);
    let authorization=PaidAuthorization::ClaudeSubscriptionUnavailable(proof);
    assert!(matches!(run(authority.reserve_paid(&input,&authorization,NOW)).unwrap(),PaidAdmission::Reserved(_)));
    assert!(matches!(run(authority.reserve_paid(&input,&authorization,NOW)).unwrap(),PaidAdmission::Existing(_)));
    let window:PaidWindow=serde_json::from_value(store.row(&keys::paid_window("key-a",policy().usage_reset_at_ms)).unwrap().value).unwrap();
    assert_eq!(window.pending_count,1);assert_eq!(window.reserved_microcredits,1_000);
}

#[test]
fn claude_absent_empty_and_no_active_pools_never_fabricate_exhaustion() {
    let store=MemoryStore::default();let authority=authority(&store);
    assert!(run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().is_none());
    let mut roster=claude_setup(&store);roster["active_account_id"]=serde_json::Value::Null;store.seed(keys::claude_accounts(),&roster);
    assert!(run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().is_none());
    roster["accounts"]=serde_json::json!([]);store.seed(keys::claude_accounts(),&roster);
    assert!(run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().is_none());
}

#[test]
fn claude_only_current_applicable_fresh_source_pool_proofs_count() {
    for fault in ["missing","transient","configuration","wrong-model","generation","future","expired","unsafe","malformed"] {
        let store=MemoryStore::default();let roster=claude_setup(&store);let authority=authority(&store);
        let mut quota=claude_quota(&roster,1,"quota_exhausted");
        let proof=&mut quota["pool_proofs"]["source-key"];
        match fault {
            "missing"=>quota["pool_proofs"]=serde_json::json!({}),
            "transient"|"configuration"=>proof["kind"]=serde_json::json!(fault),
            "wrong-model"=>proof["model_id"]=serde_json::json!("another-model"),
            "generation"=>proof["evidence_generation"]=serde_json::json!("old-generation"),
            "future"=>proof["observed_at_ms"]=serde_json::json!(NOW+1),
            "expired"=>proof["expires_at_ms"]=serde_json::json!(NOW),
            "unsafe"=>proof["expires_at_ms"]=serde_json::json!(9_007_199_254_740_992_i64),
            "malformed"=>quota["updated_at_ms"]=serde_json::Value::Null,
            _=>unreachable!(),
        }
        store.seed(claude_key(&roster,1),&quota);
        assert!(run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().is_none(),"{fault}");
    }
}

#[test]
fn claude_roster_fingerprint_validation_fails_closed() {
    for field in ["credential_fingerprint","account_id","account_cohort_id","evidence_generation","secret","workspace"] {
        let store=MemoryStore::default();let mut roster=claude_setup(&store);let authority=authority(&store);
        match field {
            "secret"=>roster["accounts"][0]["credential"]["secret"]=serde_json::json!("replacement-fixture"),
            "workspace"=>roster["accounts"][0]["workspace"]["id"]=serde_json::json!("wrkspc_changed"),
            _=>roster["accounts"][0][field]=serde_json::json!("corrupt"),
        }
        store.seed(keys::claude_accounts(),&roster);
        assert!(run(authority.prove_claude_unavailable("paid-model",NOW)).is_err(),"{field}");
    }
}

#[test]
fn claude_proof_fences_every_roster_and_quota_revision() {
    for fault in ["reorder","active","add","generation","cohort","credential","workspace","quota"] {
        let store=MemoryStore::default();let mut roster=claude_setup(&store);let authority=authority(&store);
        let proof=run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().unwrap();
        match fault {
            "reorder"=>roster["accounts"].as_array_mut().unwrap().reverse(),
            "active"=>roster["active_account_id"]=roster["accounts"][1]["account_id"].clone(),
            "add"=>{let mut third=roster["accounts"][0].clone();third["account_id"]=serde_json::json!("aaaaaaaa-aaaa-aaaa-aaaa-000000000003");roster["accounts"].as_array_mut().unwrap().push(third);},
            "generation"=>roster["accounts"][0]["evidence_generation"]=serde_json::json!("dddddddd-dddd-dddd-dddd-000000000001"),
            "cohort"=>roster["accounts"][0]["account_cohort_id"]=serde_json::json!("dddddddd-dddd-dddd-dddd-000000000001"),
            "credential"=>roster["accounts"][0]["credential"]["secret"]=serde_json::json!("changed-fixture"),
            "workspace"=>roster["accounts"][0]["workspace"]["id"]=serde_json::json!("wrkspc_changed"),
            "quota"=>store.seed(claude_key(&roster,0),&serde_json::json!({"updated_at_ms":NOW,"pool_proofs":{}})),
            _=>unreachable!(),
        }
        if fault!="quota" {store.seed(keys::claude_accounts(),&roster);}
        let input=paid_request("claude-stale",PaidProvider::Surplus);
        assert!(run(authority.reserve_paid(&input,&PaidAuthorization::ClaudeSubscriptionUnavailable(proof),NOW)).is_err(),"{fault}");
        assert!(store.row(&keys::paid_attempt("key-a","claude-stale")).is_none());
        assert!(store.row(&keys::paid_gate()).is_none());
    }
}

#[test]
fn claude_check_only_and_paid_cas_races_never_admit_stale_proof() {
    let store=MemoryStore::default();let roster=claude_setup(&store);let authority=authority(&store);
    let empty=serde_json::json!({"updated_at_ms":NOW,"pool_proofs":{}});
    store.race(claude_key(&roster,1),&empty);
    assert!(run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().is_none());
    store.seed(claude_key(&roster,1),&claude_quota(&roster,1,"quota_exhausted"));
    let proof=run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().unwrap();
    store.race(claude_key(&roster,0),&empty);
    assert!(run(authority.reserve_paid(&paid_request("claude-race",PaidProvider::Surplus),&PaidAuthorization::ClaudeSubscriptionUnavailable(proof),NOW)).is_err());
    assert!(store.row(&keys::paid_attempt("key-a","claude-race")).is_none());
    assert!(store.row(&keys::paid_gate()).is_none());
}

#[test]
fn claude_expiry_crossing_async_reads_never_reserves_paid_exposure() {
    let store=MemoryStore::default();let roster=claude_setup(&store);let authority=authority(&store);
    store.jump_on_read(claude_key(&roster,1),NOW+300_000);
    assert!(run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().is_none());
    store.clock(NOW);
    let proof=run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().unwrap();
    store.jump_on_read(keys::paid_deletion("key-a"),NOW+300_000);
    assert!(run(authority.reserve_paid(&paid_request("claude-expired",PaidProvider::Surplus),&PaidAuthorization::ClaudeSubscriptionUnavailable(proof),NOW)).is_err());
    assert!(store.row(&keys::paid_attempt("key-a","claude-expired")).is_none());
    assert!(store.row(&keys::paid_gate()).is_none());
}

#[test]
fn claude_model_scope_clock_and_current_paid_policy_remain_required() {
    let store=MemoryStore::default();claude_setup(&store);let authority=authority(&store);
    let proof=run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().unwrap();
    let mut input=paid_request("claude-wrong-model",PaidProvider::Surplus);input.model="gpt-test".to_owned();
    assert!(run(authority.reserve_paid(&input,&PaidAuthorization::ClaudeSubscriptionUnavailable(proof.clone()),NOW)).is_err());
    let mut changed=policy();changed.paid_fallback_enabled=false;store.race(keys::api_policy("key-a"),&changed);
    assert!(run(authority.reserve_paid(&paid_request("claude-disabled",PaidProvider::Surplus),&PaidAuthorization::ClaudeSubscriptionUnavailable(proof),NOW)).is_err());
    assert!(store.row(&keys::paid_gate()).is_none());
    let no_clock=gateway_authority::Authority::new(store.clone(),Tokens::default());
    assert_eq!(run(no_clock.prove_claude_unavailable("paid-model",NOW)).unwrap_err().envelope.error.code.as_deref(),Some("authority_clock_unavailable"));
}

#[test]
fn claude_json_integer_representations_and_codex_precedence_match_source() {
    let store=MemoryStore::default();let mut roster=claude_setup(&store);let authority=authority(&store);
    roster["v"]=serde_json::json!(1.0);roster["updated_at_ms"]=serde_json::json!(NOW as f64);store.seed(keys::claude_accounts(),&roster);
    for slot in 0..2 {
        let mut quota=claude_quota(&roster,slot,"auth_invalid");
        quota["pool_proofs"]["source-key"]["observed_at_ms"]=serde_json::json!(NOW as f64);
        quota["pool_proofs"]["source-key"]["expires_at_ms"]=serde_json::json!((NOW+300_000) as f64);
        store.seed(claude_key(&roster,slot),&quota);
    }
    let proof=run(authority.prove_claude_unavailable("gpt-test",NOW)).unwrap().unwrap();
    let mut input=paid_request("claude-codex",PaidProvider::Surplus);input.model="gpt-test".to_owned();
    let error=run(authority.reserve_paid(&input,&PaidAuthorization::ClaudeSubscriptionUnavailable(proof),NOW)).unwrap_err();
    assert_eq!(error.envelope.error.code.as_deref(),Some("codex_routing_unavailable"));
    assert!(store.row(&keys::paid_gate()).is_none());
}

#[test]
fn claude_existing_pending_attempt_cannot_reuse_expired_authorization() {
    let store=MemoryStore::default();claude_setup(&store);let authority=authority(&store);
    let proof=run(authority.prove_claude_unavailable("paid-model",NOW)).unwrap().unwrap();
    let authorization=PaidAuthorization::ClaudeSubscriptionUnavailable(proof);
    let input=paid_request("claude-existing",PaidProvider::Surplus);
    assert!(matches!(run(authority.reserve_paid(&input,&authorization,NOW)).unwrap(),PaidAdmission::Reserved(_)));
    store.jump_on_read(keys::paid_attempt("key-a","claude-existing"),NOW+300_000);
    assert!(run(authority.reserve_paid(&input,&authorization,NOW)).is_err());
    let window:PaidWindow=serde_json::from_value(store.row(&keys::paid_window("key-a",policy().usage_reset_at_ms)).unwrap().value).unwrap();
    assert_eq!(window.pending_count,1);assert_eq!(window.reserved_microcredits,1_000);
}

