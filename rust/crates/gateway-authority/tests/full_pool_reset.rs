mod support;
use gateway_authority::{
    full_pool_reset::*,
    keys,
    reset::{ResetConfig, ResetMode},
    routing::RouteSelection,
};
use gateway_core::{
    GatewayError,
    identity::{PrincipalId, RequestContext, RequestId},
    js_string::JsString16,
    provider::CodexQuotaClass,
    source_json::SourceJson,
    state::StoredRecord,
};
use serde_json::{Value, json};
use std::cmp::Ordering;
use support::*;

struct Collation;
impl SourceCreditCollation for Collation {
    fn compare_credit_ids(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<Ordering, GatewayError> {
        Ok(left.as_units().cmp(right.as_units()))
    }
}
fn config(mode: ResetMode) -> ResetConfig {
    ResetConfig {
        enabled: true,
        mode,
        max_per_account_per_day: 1,
        max_per_account_per_window: 1,
        provider_approved: true,
        supports_idempotent_lookup: false,
        redeem_outcome_is_final: true,
    }
}
fn original() -> RequestContext {
    RequestContext {
        request_id: RequestId("source-original".into()),
        principal: PrincipalId("fixture-principal".into()),
        key_id: None,
        route: "/v1/responses".into(),
        started_at_ms: NOW,
    }
}
fn setup(
    mode: ResetMode,
) -> (
    MemoryStore,
    TestAuthority,
    gateway_authority::routing::CohortProof,
) {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let first = admitted(&authority);
    run(authority.record_quota_block(&first, block(), NOW)).unwrap();
    let second = admitted(&authority);
    run(authority.record_quota_block(&second, block(), NOW)).unwrap();
    let RouteSelection::QuotaBlocked { proof, .. } =
        run(authority.select_account("gpt-test", CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("actual exhausted cohort required")
    };
    store.seed(keys::reset_config(), &config(mode));
    store.seed(
        gateway_auth::store::key(json!([
            "uos_ai",
            "migrations",
            "codex_reset_usage_legacy_global_v1"
        ])),
        &json!({"completed_at_ms":NOW,"preserved_opt_out":false}),
    );
    (store, authority, proof)
}
fn plan(
    authority: &TestAuthority,
    proof: &gateway_authority::routing::CohortProof,
) -> FullPoolResetPlan {
    let FullPoolPreparation::Observe(plan) =
        run(authority.prepare_full_pool_reset(proof, &original())).unwrap()
    else {
        panic!("expected source observation")
    };
    plan
}
fn observations(plan: &FullPoolResetPlan, credit: Option<JsString16>) -> Vec<SourceResetInventory> {
    plan.bindings()
        .enumerate()
        .map(|(index, binding)| {
            let credits = if index == 0 {
                credit
                    .clone()
                    .map(|credit_id| SourceResetCredit {
                        credit_id,
                        status: JsString16::from_utf8("available"),
                        reset_type: JsString16::from_utf8("codex_rate_limits"),
                        expires_at_ms: None,
                    })
                    .into_iter()
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            SourceResetInventory {
                binding: binding.clone(),
                observed_at_ms: NOW,
                available_count: credits.len() as i64,
                credits,
            }
        })
        .collect()
}

#[test]
fn full_no_selection_audit_is_persisted_and_refuses_live_credit_drift() {
    let (store, authority, proof) = setup(ResetMode::Shadow);
    let initial = plan(&authority, &proof);
    let rows = observations(&initial, None);
    let FullPoolEvaluation::Shadow { decision, .. } =
        run(authority.finish_full_pool_reset(initial, &rows, &Collation)).unwrap()
    else {
        panic!("no-selection decision required")
    };
    assert_eq!(decision.decision_reason, "no_eligible_credit");
    assert!(decision.selected_account_id_hash.is_none());
    assert_eq!(decision.fences.len(), 2);
    let saved = store
        .row(&keys::reset_shadow(&decision.episode_hash))
        .unwrap();
    assert!(saved.expires_at_ms.is_none());
    store.seed(keys::reset_config(), &config(ResetMode::Live));
    let next = plan(&authority, &proof);
    let rows = observations(&next, Some(JsString16::from_utf8("new-credit")));
    assert!(
        matches!(run(authority.finish_full_pool_reset(next,&rows,&Collation)).unwrap(),FullPoolEvaluation::Declined {reason} if reason=="shadow_decision_drift")
    );
    assert_eq!(
        store
            .row(&keys::reset_shadow(&decision.episode_hash))
            .unwrap()
            .revision,
        saved.revision
    );
}

#[test]
fn first_live_call_only_arms_then_same_exact_credit_mints_opaque_permit() {
    let (store, authority, proof) = setup(ResetMode::Live);
    let first = plan(&authority, &proof);
    let rows = observations(
        &first,
        Some(JsString16::from_units(vec![b'c' as u16, 0xd800])),
    );
    let FullPoolEvaluation::Shadow { decision, .. } =
        run(authority.finish_full_pool_reset(first, &rows, &Collation)).unwrap()
    else {
        panic!("first live call must only arm")
    };
    assert!(
        store
            .row(&keys::reset_redemption(
                &decision.fences[0].account_id_hash,
                &decision.fences[0].quota_generation
            ))
            .is_none()
    );
    let next = plan(&authority, &proof);
    let rows = observations(
        &next,
        Some(JsString16::from_units(vec![b'c' as u16, 0xd800])),
    );
    let FullPoolEvaluation::Ready(permit) =
        run(authority.finish_full_pool_reset(next, &rows, &Collation)).unwrap()
    else {
        panic!("exact prior audit required")
    };
    let body = permit.consume_body().unwrap();
    assert!(body.as_str().contains("\\ud800"));
    assert!(!body.as_str().contains("[99,55296]"));
    let raw = body
        .object_entries()
        .unwrap()
        .into_iter()
        .find(|(key, _)| key.try_utf8().ok().as_deref() == Some("credit_id"))
        .unwrap()
        .1;
    assert_eq!(
        raw.deserialize::<JsString16>().unwrap().as_units(),
        &[99, 0xd800]
    );
    assert_eq!(permit.original().request_id, original().request_id);
}

fn audit_value() -> Value {
    json!({"v":1,"episode_hash":"episode","created_at_ms":1000.0,"expires_at_ms":2000,"decision_reason":"no_eligible_credit","selected_account_id_hash":null,"selected_credit_id_hash":null,"selected_credit_expires_at_ms":null,"fences":[{"slot":0,"account_id_hash":"account","quota_generation":"generation","routing_generation":1,"quota_reset_at_ms":2000}]})
}
#[test]
fn strict_data_parser_keeps_required_nulls_key_and_storage_custody() {
    let value = audit_value();
    let decision = FullPoolShadowDecision::parse_value(&value).unwrap();
    assert!(decision.selected_credit_id_hash.is_none());
    let key = keys::reset_shadow("episode");
    let mut row = StoredRecord::json("fixture", value.clone(), None);
    assert!(FullPoolShadowDecision::validate_record(&key, &row).is_ok());
    assert!(FullPoolShadowDecision::validate_record(&keys::reset_shadow("other"), &row).is_err());
    row.expires_at_ms = Some(2000);
    assert!(FullPoolShadowDecision::validate_record(&key, &row).is_err());
    let mut missing = value;
    missing
        .as_object_mut()
        .unwrap()
        .remove("selected_credit_id_hash");
    assert!(FullPoolShadowDecision::parse_value(&missing).is_err());
    let raw = SourceJson::parse(&format!(
        "{},\"unrelated\":\"\\ud800\"}}",
        serde_json::to_string(&audit_value())
            .unwrap()
            .trim_end_matches('}')
    ))
    .unwrap();
    assert!(FullPoolShadowDecision::parse_source_json(&raw).is_ok());
}
