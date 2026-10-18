use super::*;
use serde_json::json;
use gateway_auth::provider_credentials::codex_source_pool_key;
use gateway_schema::selection::AccountModelsStore;

#[test]
fn source_model_learning_preserves_raw_catalogs_and_unknown_metadata() {
    let store=MemoryStore::default();seed_pool(&store,&pool());let authority=authority(&store);
    let raw=json!({"accounts":{"a":{"slugs":["gpt-test"],"client_version":"0.163.0","updated_at_ms":NOW,"source_extra":"keep"},"b":{"slugs":["gpt-test"],"client_version":"0.163.0","updated_at_ms":NOW}},"unsupported":{"unrelated":{"another-model":NOW}},"source_metadata":{"keep":true}});
    store.seed(keys::models(),&raw);let admitted=admitted(&authority);
    let detail="The 'gpt-test' model is not supported when using Codex with a ChatGPT account.";
    assert!(run(authority.learn_model_unavailable(&admitted,detail,NOW)).unwrap());
    let result=store.row(&keys::models()).unwrap().value;
    assert_eq!(result["accounts"],raw["accounts"]);assert_eq!(result["source_metadata"],raw["source_metadata"]);
    assert_eq!(result["unsupported"]["unrelated"],raw["unsupported"]["unrelated"]);
    assert_eq!(result["unsupported"]["a"]["gpt-test"],NOW);
    assert!(result["unsupported"].get(&routing_hash("a").0).is_none());
    assert_eq!(AccountModelsStore::parse(&result).unwrap().unsupported["a"]["gpt-test"],NOW);
}

#[test]
fn raw_source_credential_change_cannot_leave_old_normalized_identity_current() {
    let store=MemoryStore::default();seed_pool(&store,&pool());let authority=authority(&store);let admitted=admitted(&authority);
    let mut raw=store.row(&codex_source_pool_key()).unwrap().value;raw["accounts"][0]["access_token"]=json!("changed-source-fixture");store.seed(codex_source_pool_key(),&raw);
    assert!(run(authority.ensure_admission_current(&admitted,NOW)).is_err());
    assert!(run(authority.select_account("gpt-test",CodexQuotaClass::Standard,NOW)).is_err());
}

#[test]
fn incorrect_normalized_hash_or_credential_version_never_guesses_a_raw_id() {
    for field in ["account_id_hash","credential_version","admin_account_hash"] {
        let store=MemoryStore::default();seed_pool(&store,&pool());let authority=authority(&store);
        let mut raw=store.row(&keys::pool()).unwrap().value;raw["accounts"][0][field]=json!("not-current-source-identity");store.seed(keys::pool(),&raw);
        assert!(run(authority.select_account("gpt-test",CodexQuotaClass::Standard,NOW)).is_err(),"{field}");
    }
}

#[test]
fn source_catalog_race_retries_without_overwriting_newer_catalog_metadata() {
    let store=MemoryStore::default();seed_pool(&store,&pool());let authority=authority(&store);let admitted=admitted(&authority);
    let replacement=json!({"accounts":{"a":{"slugs":["gpt-test","new-model"],"client_version":"0.164.0","updated_at_ms":NOW}},"unsupported":{},"future_source_metadata":"retained"});
    store.race(keys::models(),&replacement);
    assert!(run(authority.learn_model_unavailable(&admitted,"The 'gpt-test' model is not supported when using Codex with a ChatGPT account.",NOW)).unwrap());
    let result=store.row(&keys::models()).unwrap().value;
    assert_eq!(result["accounts"],replacement["accounts"]);assert_eq!(result["future_source_metadata"],"retained");assert_eq!(result["unsupported"]["a"]["gpt-test"],NOW);
}
