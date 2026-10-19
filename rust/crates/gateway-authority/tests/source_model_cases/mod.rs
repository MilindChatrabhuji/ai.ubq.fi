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
    assert!(run(authority.learn_model_unavailable(&admitted, &detail.into(), NOW)).unwrap());
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
        AccountModelsStore::parse(
            &gateway_core::source_json::SourceJson::from_serializable(&result).unwrap()
        )
        .unwrap()
        .unsupported["a"][&gateway_core::model::ModelId::from_scalar("gpt-test")],
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
    assert!(
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).is_err()
    );
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
            run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW))
                .is_err(),
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
            &"The 'gpt-test' model is not supported when using Codex with a ChatGPT account."
                .into(),
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
    let store = MemoryStore::default();
    let mut stale = pool();
    stale.accounts[1].enabled = false;
    seed_pool(&store, &stale);
    store.seed(keys::provider_selection(),&json!({"provider_ids":[format!("codex:{}",admin_hash("a").0),"surplus".to_owned(),"openlux".to_owned()],"updated_at_ms":NOW}));
    paid_setup(&store);
    let authority = authority(&store);
    let first = admitted(&authority);
    run(authority.mark_credential_invalid(&first, NOW)).unwrap();
    let RouteSelection::CredentialsInvalid { proof } =
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("missing single-source-selected proof")
    };
    assert_eq!(proof.selected_count(), 1);
    store.seed(
        keys::provider_selection(),
        &json!({"provider_ids":["codex","surplus","openlux"],"updated_at_ms":NOW}),
    );
    super::paid_control_cases::republish(&store);
    let mut input = paid_request("selection-expanded", PaidProvider::Surplus);
    input.model = "gpt-test".into();
    let receipt = run(super::paid_original::authorize(
        &authority,
        &input,
        &super::paid_control_cases::context(&input),
        NOW,
    ))
    .unwrap();
    assert!(
        run(authority.reserve_paid(
            &input,
            &PaidAuthorization::SubscriptionUnavailable(proof),
            &receipt,
            NOW
        ))
        .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", "selection-expanded"))
            .is_none()
    );
    let current = admitted(&authority);
    assert_eq!(current.binding.account_id_hash, routing_hash("b"));
}

#[test]
fn source_selection_shrink_and_empty_defaults_keep_sticky_active_identity() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let first = admitted(&authority);
    store.seed(
        keys::provider_selection(),
        &json!({"provider_ids":[format!("codex:{}",admin_hash("a").0)],"updated_at_ms":NOW}),
    );
    let retained = admitted(&authority);
    assert_eq!(
        retained.binding.account_id_hash,
        first.binding.account_id_hash
    );
    assert_eq!(retained.active_generation, first.active_generation);
    run(authority.mark_credential_invalid(&retained, NOW)).unwrap();
    let RouteSelection::CredentialsInvalid { proof } =
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("missing selected single-account proof")
    };
    assert_eq!(proof.selected_count(), 1);
    store.seed(
        keys::provider_selection(),
        &json!({"provider_ids":[],"updated_at_ms":NOW}),
    );
    assert_eq!(
        admitted(&authority).binding.account_id_hash,
        routing_hash("b")
    );
}

#[test]
fn opaque_model_admission_learning_uses_same_raw_source_key_and_exact_detail() {
    use gateway_core::{
        js_string::JsString16, model::ModelId, source_control, source_json::SourceJson,
        source_serialization as source, value::ValueEncoding,
    };
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let raw = SourceJson::parse(&r#"{"accounts":{},"unsupported":{"other":{"\udc00":NOW}},"source_metadata":{"retain":"\ud800"}}"#.replace("NOW", &NOW.to_string())).unwrap();
    store.seed_record(
        keys::models(),
        source_control::encode_source_control_record("source-before-learn", &raw, None).unwrap(),
    );
    let authority = authority(&store);
    let high = ModelId::from_source(JsString16::from_units(vec![0xd800]));
    let RouteSelection::Eligible(admission) =
        run(authority.select_account(&high, CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("absent catalog must not blanket-reject an opaque model")
    };
    assert_eq!(admission.requested_model, high);
    run(authority.ensure_admission_current(&admission, NOW)).unwrap();
    let encoded_admission = SourceJson::from_serializable(&admission).unwrap();
    let restored: gateway_authority::routing::AdmittedAccount =
        encoded_admission.deserialize().unwrap();
    assert_eq!(restored, admission);
    let detail = |unit| {
        let mut units = "The '".encode_utf16().collect::<Vec<_>>();
        units.push(unit);
        units.extend(
            "' model is not supported when using Codex with a ChatGPT account.".encode_utf16(),
        );
        JsString16::from_units(units)
    };
    let before = store.row(&keys::models()).unwrap();
    assert!(!run(authority.learn_model_unavailable(&admission, &detail(0xdc00), NOW)).unwrap());
    assert_eq!(store.row(&keys::models()).unwrap(), before);
    assert!(run(authority.learn_model_unavailable(&admission, &detail(0xd800), NOW)).unwrap());
    let stored = store.row(&keys::models()).unwrap();
    assert_eq!(stored.value_encoding, ValueEncoding::ProfileV2);
    let learned = source_control::decode_source_control_record(&stored).unwrap();
    for field in ["accounts", "source_metadata"] {
        assert_eq!(source::member(&learned, field), source::member(&raw, field));
    }
    let unsupported = source::member(&learned, "unsupported").unwrap();
    assert_eq!(
        source::member(&unsupported, "other"),
        source::member(&source::member(&raw, "unsupported").unwrap(), "other")
    );
    let parsed = AccountModelsStore::parse(&learned).unwrap();
    assert_eq!(parsed.unsupported["a"][&high], NOW);
    assert!(
        !parsed.unsupported["a"]
            .contains_key(&ModelId::from_source(JsString16::from_units(vec![0xdc00])))
    );
    assert!(source::member(&unsupported, &routing_hash("a").0).is_none());
}

#[test]
fn opaque_model_full_pool_proof_retains_exact_model_and_current_credential_fence() {
    use gateway_core::{js_string::JsString16, model::ModelId};
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let model = ModelId::from_source(JsString16::from_units(vec![0xdc00, 0xd83d, 0xde80]));
    let RouteSelection::Eligible(first) =
        run(authority.select_account(&model, CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("first admission missing")
    };
    run(authority.record_quota_block(&first, block(), NOW)).unwrap();
    let RouteSelection::Eligible(second) =
        run(authority.select_account(&model, CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("second admission missing")
    };
    assert_ne!(
        first.binding.account_id_hash,
        second.binding.account_id_hash
    );
    run(authority.record_quota_block(&second, block(), NOW)).unwrap();
    let RouteSelection::QuotaBlocked { proof, .. } =
        run(authority.select_account(&model, CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("fresh full-pool proof missing")
    };
    assert!(proof.full_cohort_exhausted());
    assert_eq!(proof.selected_count(), 2);
    assert_eq!(proof.model(), &model);
    assert!(run(authority.ensure_admission_current(&first, NOW)).is_err());
}

#[test]
fn model_quota_class_uses_source_comparison_projection_without_changing_identity() {
    use gateway_authority::routing::model_quota_class;
    use gateway_core::{js_string::JsString16, model::ModelId};
    // Pinned Bun1.4.0 oracle af9107c1: Kelvin-sign lower-case is significant to the spark class.
    for (model, expected) in [
        (
            ModelId::from_scalar("gpt-5.3-codex-spark"),
            CodexQuotaClass::Spark,
        ),
        (
            ModelId::from_scalar("gpt-5.3-codex-sparK"),
            CodexQuotaClass::Spark,
        ),
        (
            ModelId::from_scalar(" \u{feff}gpt-reserve\u{a0}"),
            CodexQuotaClass::Reserve,
        ),
        (
            ModelId::from_source(JsString16::from_units(vec![0xd800])),
            CodexQuotaClass::Standard,
        ),
        (
            ModelId::from_scalar(&"x".repeat(4097)),
            CodexQuotaClass::Standard,
        ),
    ] {
        let original = model.clone();
        assert_eq!(model_quota_class(&model), expected);
        assert_eq!(model, original);
    }
}
