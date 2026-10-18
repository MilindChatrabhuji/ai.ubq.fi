use super::*;
use gateway_authority::paid_control::*;
use gateway_core::state::{AtomicTransition,RecordMutation,RevisionCheck,RecordKey};
use gateway_providers::ClientSurface;
use serde_json::{Value,json};

pub fn context(input:&PaidRequest)->PaidRequestContext {
    let mut body=json!({"model":input.model,"stream":input.stream});
    if let Some(effort)=&input.reasoning {body["reasoning"]=json!({"effort":effort});}
    PaidRequestContext{original_model:input.model.clone(),body,surface:if input.path=="/v1/chat/completions"{ClientSurface::Chat}else{ClientSurface::Responses},synthetic_hop:None}
}

fn revision(store:&MemoryStore,key:&RecordKey)->Option<String>{store.row(key).map(|row|row.revision)}

pub fn republish(store:&MemoryStore) {
    let row=store.row(&keys::paid_routing()).unwrap();
    let mut projection:PaidRoutingProjection=serde_json::from_value(row.value).unwrap();
    projection.provenance.owner_revision=revision(store,&keys::paid_control_owner()).unwrap();
    projection.provenance.config_revision=revision(store,&keys::paid_control_config()).unwrap();
    projection.provenance.surplus_observation_revision=revision(store,&keys::paid_control_observation(PaidProvider::Surplus));
    projection.provenance.openlux_observation_revision=revision(store,&keys::paid_control_observation(PaidProvider::Metered));
    projection.provenance.source_checks=paid_projection_source_keys().into_iter().map(|key|PaidSourceCheck{expected_revision:revision(store,&key),key:key.0}).collect();
    store.seed(keys::paid_routing(),&projection);
}

pub fn seed_controls(store:&MemoryStore) {
    // Dedicated deterministic unit fixture, not a live owner/config installation.
    store.seed(keys::paid_control_owner(),&PaidControlOwner{v:1,owner_id:"fixture-owner".into(),owner_epoch:"fixture-epoch".into(),key_fingerprint:"fixture-authenticated-key".into()});
    store.seed(keys::paid_control_config(),&PaidControlConfig{v:1,owner_id:"fixture-owner".into(),owner_epoch:"fixture-epoch".into(),generation:"fixture-config-generation".into(),configuration_fingerprint:"fixture-config-fingerprint".into(),surplus_binding:Some("fixture-surplus-binding".into()),openlux_binding:Some("fixture-openlux-binding".into()),source_checks:vec![]});
    let models:Vec<_>=["paid-model","gpt-test","gpt-5.6-sol","deepseek-v4.1-flash"].into_iter().map(|id|json!({"id":id,"supported_endpoint_types":["openai-response","openai"],"supports_tools":true,"input_price_per_token":0.001,"output_price_per_token":0.002})).collect();
    for provider in [PaidProvider::Surplus,PaidProvider::Metered] {
        store.seed(keys::paid_control_observation(provider),&PaidProviderObservation{v:1,provider,owner_id:"fixture-owner".into(),owner_epoch:"fixture-epoch".into(),configuration_generation:"fixture-config-generation".into(),configuration_fingerprint:"fixture-config-fingerprint".into(),credential_binding:if provider==PaidProvider::Surplus{"fixture-surplus-binding"}else{"fixture-openlux-binding"}.into(),observed_at_ms:NOW,source_valid_until_ms:None,stale:false,models:models.clone(),source_checks:vec![]});
    }
    let projection=PaidRoutingProjection{policy:PaidRoutingPolicy{v:2,codex_enabled:true,codex_models:vec!["gpt-test".into(),"gpt-5.6-sol".into()],models:["paid-model","gpt-test","gpt-5.6-sol","deepseek-v4.1-flash"].into_iter().map(|id|(id.into(),vec![PaidProvider::Surplus,PaidProvider::Metered])).collect()},provenance:PaidProjectionProvenance{v:1,owner_revision:String::new(),config_revision:String::new(),surplus_observation_revision:None,openlux_observation_revision:None,observed_at_ms:NOW,source_valid_until_ms:None,source_checks:vec![]}};
    store.seed(keys::paid_routing(),&projection);republish(store);
}

fn remove(store:&MemoryStore,key:RecordKey) {
    run(store.commit(AtomicTransition{checks:vec![RevisionCheck{expected_revision:revision(store,&key),key:key.clone()}],mutations:vec![RecordMutation::Delete{key}]})).unwrap();
}

fn no_attempt(store:&MemoryStore,input:&PaidRequest) {
    assert!(store.row(&keys::paid_attempt(&input.key_id.0,&input.attempt_id.0)).is_none());
    assert!(store.row(&keys::paid_gate()).is_none());
}

#[test]
fn paid_control_missing_custody_and_legacy_unfenced_policy_refuse() {
    let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);let input=paid_request("missing-custody",PaidProvider::Surplus);
    remove(&store,keys::paid_control_owner());
    assert!(run(authority.authorize_paid_route(&input,&context(&input),NOW)).is_err());
    seed_controls(&store);
    let mut raw=store.row(&keys::paid_routing()).unwrap().value;raw["v"]=json!(1);raw.as_object_mut().unwrap().remove("provenance");store.seed(keys::paid_routing(),&raw);
    assert!(run(authority.authorize_paid_route(&input,&context(&input),NOW)).is_err());no_attempt(&store,&input);
}

#[test]
fn every_source_and_control_change_invalidates_existing_and_new_paid_receipts() {
    let mut cases=paid_projection_source_keys();cases.extend([keys::paid_control_owner(),keys::paid_control_config(),keys::paid_control_observation(PaidProvider::Surplus),keys::paid_control_observation(PaidProvider::Metered)]);
    for key in cases {
        for existing in [false,true] {
            let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);let input=paid_request("stale-control",PaidProvider::Surplus);
            let receipt=run(authority.authorize_paid_route(&input,&context(&input),NOW)).unwrap();
            if existing {run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).unwrap();}
            let mut raw=store.row(&key).map(|row|row.value).unwrap_or_else(||json!({}));raw["source_changed"]=json!(true);store.seed(key.clone(),&raw);
            assert!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).is_err(),"{}",key.0);
            if !existing {no_attempt(&store,&input);} else {
                let window=store.row(&keys::paid_window("key-a",policy().usage_reset_at_ms)).unwrap();assert_eq!(window.value["pending_count"],1);
            }
        }
    }
}

#[test]
fn source_change_inside_the_actual_paid_cas_never_writes_exposure() {
    for existing in [false,true] {
        let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);let input=paid_request("control-race",PaidProvider::Surplus);
        let receipt=run(authority.authorize_paid_route(&input,&context(&input),NOW)).unwrap();
        if existing {run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).unwrap();}
        let key=keys::paid_control_config();let mut raw=store.row(&key).unwrap().value;raw["generation"]=json!("superseded-generation");store.race(key,&raw);
        assert!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).is_err());
        if !existing {no_attempt(&store,&input);} else {assert_eq!(store.row(&keys::paid_window("key-a",policy().usage_reset_at_ms)).unwrap().value["pending_count"],1);}
    }
}

#[test]
fn source_stale_routes_remain_usable_without_invented_refresh_ttl() {
    let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);let input=paid_request("retained-stale",PaidProvider::Surplus);
    let key=keys::paid_control_observation(PaidProvider::Surplus);let mut raw=store.row(&key).unwrap().value;raw["observed_at_ms"]=json!(NOW-DAY_MS);raw["stale"]=json!(true);store.seed(key,&raw);republish(&store);
    let receipt=run(authority.authorize_paid_route(&input,&context(&input),NOW)).unwrap();
    assert!(matches!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).unwrap(),PaidAdmission::Reserved(_)));
}

#[test]
fn missing_openlux_catalog_keeps_configured_known_codex_fallback() {
    let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);
    remove(&store,keys::paid_control_observation(PaidProvider::Metered));
    let selection=paid_projection_source_keys()[2].clone();store.seed(selection,&json!({"provider_ids":["openlux"],"updated_at_ms":NOW}));
    let mut projection=store.row(&keys::paid_routing()).unwrap().value;projection["codex_enabled"]=json!(false);store.seed(keys::paid_routing(),&projection);republish(&store);
    let mut input=paid_request("missing-catalog",PaidProvider::Metered);input.model="gpt-test".into();
    let receipt=run(authority.authorize_paid_route(&input,&context(&input),NOW)).unwrap();
    assert!(matches!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).unwrap(),PaidAdmission::Reserved(_)));
}

#[test]
fn broad_model_union_does_not_grant_endpoint_tool_or_price_capability() {
    let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);
    let key=keys::paid_control_observation(PaidProvider::Surplus);let mut observation=store.row(&key).unwrap().value;
    observation["models"][0]["supported_endpoint_types"]=json!(["openai"]);observation["models"][0]["supports_tools"]=json!(false);store.seed(key.clone(),&observation);republish(&store);
    let mut input=paid_request("endpoint",PaidProvider::Surplus);
    assert!(run(authority.authorize_paid_route(&input,&context(&input),NOW)).is_err());
    input.path="/v1/chat/completions".into();input.route="chat.completions".into();
    let mut ctx=context(&input);assert!(run(authority.authorize_paid_route(&input,&ctx,NOW)).is_ok());
    ctx.body["tools"]=json!([{"type":"function","name":"fixture"}]);assert!(run(authority.authorize_paid_route(&input,&ctx,NOW)).is_err());
    observation["models"][0]["input_price_per_token"]=Value::Null;store.seed(key,&observation);republish(&store);
    assert!(run(authority.authorize_paid_route(&input,&context(&input),NOW)).is_err());
}

#[test]
fn synthetic_scope_is_server_owned_and_matches_current_source_alias() {
    let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);
    let selection=paid_projection_source_keys()[2].clone();store.seed(selection.clone(),&json!({"provider_ids":["ubiquity"],"updated_at_ms":NOW}));
    let mut projection=store.row(&keys::paid_routing()).unwrap().value;projection["codex_enabled"]=json!(false);store.seed(keys::paid_routing(),&projection);republish(&store);
    let mut input=paid_request("synthetic",PaidProvider::Metered);input.model="deepseek-v4.1-flash".into();
    let mut ctx=context(&input);ctx.original_model=gateway_schema::aliases::SYNTHETIC_MODEL.into();ctx.body["model"]=json!(ctx.original_model);ctx.body["synthetic_hop"]=json!("openlux");
    assert!(run(authority.authorize_paid_route(&input,&ctx,NOW)).is_err());
    ctx.synthetic_hop=Some(PaidSyntheticHop::Openlux);assert!(run(authority.authorize_paid_route(&input,&ctx,NOW)).is_ok());
    input.model="paid-model".into();assert!(run(authority.authorize_paid_route(&input,&ctx,NOW)).is_err());
    input.model="deepseek-v4.1-flash".into();store.seed(selection,&json!({"provider_ids":["openlux"],"updated_at_ms":NOW}));republish(&store);
    assert!(run(authority.authorize_paid_route(&input,&ctx,NOW)).is_err());
}

#[test]
fn receipt_binds_logical_model_not_physical_effort_alias_and_exact_attempt() {
    let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);
    let mut key_policy=policy();key_policy.paid_fallback_models.extend(["gpt-5.6-sol".into(),"gpt-5.6-sol-low".into()]);key_policy.paid_fallback_max_exposure_microcredits.extend([("gpt-5.6-sol".into(),1000),("gpt-5.6-sol-low".into(),1000)]);store.seed(keys::api_policy("key-a"),&key_policy);
    let mut input=paid_request("logical-alias",PaidProvider::Metered);input.model="gpt-5.6-sol".into();input.reasoning=Some("none".into());
    let receipt=run(authority.authorize_paid_route(&input,&context(&input),NOW)).unwrap();
    input.model="gpt-5.6-sol-low".into();assert!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).is_err());
    input.model="gpt-5.6-sol".into();input.attempt_id=PaidAttemptId("different-attempt".into());assert!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).is_err());
    assert!(!format!("{receipt:?}").contains("fixture-authenticated-key"));
}

#[test]
fn source_defined_expiry_crossing_awaited_paid_reads_never_commits() {
    let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);let input=paid_request("control-expiry",PaidProvider::Surplus);
    let key=keys::paid_control_observation(PaidProvider::Surplus);let mut raw=store.row(&key).unwrap().value;raw["source_valid_until_ms"]=json!(NOW+100);store.seed(key,&raw);republish(&store);
    let receipt=run(authority.authorize_paid_route(&input,&context(&input),NOW)).unwrap();store.jump_on_read(keys::paid_deletion("key-a"),NOW+100);
    assert!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&receipt,NOW)).is_err());no_attempt(&store,&input);
}

#[test]
fn malformed_missing_and_derived_source_fences_never_authorize() {
    for mode in ["missing","duplicate","malformed","derived"] {
        let store=MemoryStore::default();paid_setup(&store);let authority=authority(&store);let input=paid_request("bad-fence",PaidProvider::Surplus);
        let mut raw=store.row(&keys::paid_routing()).unwrap().value;let checks=raw["provenance"]["source_checks"].as_array_mut().unwrap();
        match mode {
            "missing"=>{checks.pop();},
            "duplicate"=>checks.push(checks[0].clone()),
            "malformed"=>checks[0]["key"]=json!("not-a-canonical-key"),
            "derived"=>checks.push(json!({"key":keys::paid_control_config().0,"expected_revision":revision(&store,&keys::paid_control_config())})),
            _=>unreachable!(),
        }
        store.seed(keys::paid_routing(),&raw);assert!(run(authority.authorize_paid_route(&input,&context(&input),NOW)).is_err());
    }
}
