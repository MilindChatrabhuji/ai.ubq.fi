use super::*;
use gateway_auth::provider_credentials::codex_source_pool_key;
use gateway_schema::selection::AccountModelsStore;
use serde_json::json;

#[test]
fn source_model_learning_preserves_raw_catalogs_and_unknown_metadata() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let raw = json!({"accounts":{"a":{"slugs":["gpt-test"],"client_version":"0.163.0","updated_at_ms":NOW,"source_extra":"keep"},"b":{"slugs":["gpt-test"],"client_version":"0.163.0","updated_at_ms":NOW}},"unsupported":{"unrelated":{"another-model":NOW}},"source_metadata":{"keep":true}});
    store.seed(keys::models(), &raw);
    let admitted = admitted(&authority);
    let detail = "The 'gpt-test' model is not supported when using Codex with a ChatGPT account.";
    assert!(run(authority.learn_model_unavailable(&admitted, detail, NOW)).unwrap());
    let result = store.row(&keys::models()).unwrap().value;
    assert_eq!(result["accounts"], raw["accounts"]);
    assert_eq!(result["source_metadata"], raw["source_metadata"]);
    assert_eq!(
        result["unsupported"]["unrelated"],
        raw["unsupported"]["unrelated"]
    );
    assert_eq!(result["unsupported"]["a"]["gpt-test"], NOW);
    assert!(result["unsupported"].get(&routing_hash("a").0).is_none());
    assert_eq!(
        AccountModelsStore::parse(&result).unwrap().unsupported["a"]["gpt-test"],
        NOW
    );
}

#[test]
fn raw_source_credential_change_cannot_leave_old_normalized_identity_current() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let admitted = admitted(&authority);
    let mut raw = store.row(&codex_source_pool_key()).unwrap().value;
    raw["accounts"][0]["access_token"] = json!("changed-source-fixture");
    store.seed(codex_source_pool_key(), &raw);
    assert!(run(authority.ensure_admission_current(&admitted, NOW)).is_err());
    assert!(run(authority.select_account("gpt-test", CodexQuotaClass::Standard, NOW)).is_err());
}

#[test]
fn incorrect_normalized_hash_or_credential_version_never_guesses_a_raw_id() {
    for field in [
        "account_id_hash",
        "credential_version",
        "admin_account_hash",
    ] {
        let store = MemoryStore::default();
        seed_pool(&store, &pool());
        let authority = authority(&store);
        let mut raw = store.row(&keys::pool()).unwrap().value;
        raw["accounts"][0][field] = json!("not-current-source-identity");
        store.seed(keys::pool(), &raw);
        assert!(
            run(authority.select_account("gpt-test", CodexQuotaClass::Standard, NOW)).is_err(),
            "{field}"
        );
    }
}

#[test]
fn source_catalog_race_retries_without_overwriting_newer_catalog_metadata() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let admitted = admitted(&authority);
    let replacement = json!({"accounts":{"a":{"slugs":["gpt-test","new-model"],"client_version":"0.164.0","updated_at_ms":NOW}},"unsupported":{},"future_source_metadata":"retained"});
    store.race(keys::models(), &replacement);
    assert!(
        run(authority.learn_model_unavailable(
            &admitted,
            "The 'gpt-test' model is not supported when using Codex with a ChatGPT account.",
            NOW
        ))
        .unwrap()
    );
    let result = store.row(&keys::models()).unwrap().value;
    assert_eq!(result["accounts"], replacement["accounts"]);
    assert_eq!(result["future_source_metadata"], "retained");
    assert_eq!(result["unsupported"]["a"]["gpt-test"], NOW);
}

#[test]
fn expanded_source_selection_cannot_use_a_partial_cohort_after_new_projection() {
    let store=MemoryStore::default();let mut stale=pool();stale.accounts[1].enabled=false;seed_pool(&store,&stale);
    store.seed(keys::provider_selection(),&json!({"provider_ids":[format!("codex:{}",admin_hash("a").0),"surplus".to_owned(),"openlux".to_owned()],"updated_at_ms":NOW}));
    paid_setup(&store);let authority=authority(&store);let first=admitted(&authority);
    run(authority.mark_credential_invalid(&first,NOW)).unwrap();
    let RouteSelection::CredentialsInvalid{proof}=run(authority.select_account("gpt-test",CodexQuotaClass::Standard,NOW)).unwrap() else {panic!("missing single-source-selected proof")};
    assert_eq!(proof.selected_count(),1);
    store.seed(keys::provider_selection(),&json!({"provider_ids":["codex","surplus","openlux"],"updated_at_ms":NOW}));
    super::paid_control_cases::republish(&store);
    let mut input=paid_request("selection-expanded",PaidProvider::Surplus);input.model="gpt-test".into();
    let receipt=run(authority.authorize_paid_route(&input,&super::paid_control_cases::context(&input),NOW)).unwrap();
    assert!(run(authority.reserve_paid(&input,&PaidAuthorization::SubscriptionUnavailable(proof),&receipt,NOW)).is_err());
    assert!(store.row(&keys::paid_attempt("key-a","selection-expanded")).is_none());
    let current=admitted(&authority);assert_eq!(current.binding.account_id_hash,routing_hash("b"));
}

#[test]
fn source_selection_shrink_and_empty_defaults_keep_sticky_active_identity() {
    let store=MemoryStore::default();seed_pool(&store,&pool());let authority=authority(&store);let first=admitted(&authority);
    store.seed(keys::provider_selection(),&json!({"provider_ids":[format!("codex:{}",admin_hash("a").0)],"updated_at_ms":NOW}));
    let retained=admitted(&authority);assert_eq!(retained.binding.account_id_hash,first.binding.account_id_hash);assert_eq!(retained.active_generation,first.active_generation);
    run(authority.mark_credential_invalid(&retained,NOW)).unwrap();
    let RouteSelection::CredentialsInvalid{proof}=run(authority.select_account("gpt-test",CodexQuotaClass::Standard,NOW)).unwrap() else {panic!("missing selected single-account proof")};assert_eq!(proof.selected_count(),1);
    store.seed(keys::provider_selection(),&json!({"provider_ids":[],"updated_at_ms":NOW}));
    assert_eq!(admitted(&authority).binding.account_id_hash,routing_hash("b"));
}
