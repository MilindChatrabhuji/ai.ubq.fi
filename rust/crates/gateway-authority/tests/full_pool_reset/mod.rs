use crate::support::*;
use gateway_authority::{
    full_pool_reset::*,
    keys,
    reset::{ResetConfig, ResetMode, reset_invocation, utc_day},
    routing::RouteSelection,
};
use gateway_core::{
    GatewayError,
    identity::{PrincipalId, RequestContext, RequestId},
    js_string::JsString16,
    provider::CodexQuotaClass,
    source_json::SourceJson,
    state::{RecordKey, StoredRecord},
};
use serde_json::{Value, json};
use std::cmp::Ordering;

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
    setup_with_config(Some(mode))
}
fn setup_without_reset_config() -> (
    MemoryStore,
    TestAuthority,
    gateway_authority::routing::CohortProof,
) {
    setup_with_config(None)
}
fn setup_with_config(
    mode: Option<ResetMode>,
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
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("actual exhausted cohort required")
    };
    if let Some(mode) = mode {
        store.seed(keys::reset_config(), &config(mode));
    }
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
fn assert_history_unchanged(store: &MemoryStore, key: &RecordKey, saved: &StoredRecord) {
    let current = store.row(key).expect("historical shadow row must remain");
    assert_eq!(current.schema_version, saved.schema_version);
    assert_eq!(current.value_encoding, saved.value_encoding);
    assert_eq!(current.revision, saved.revision);
    assert_eq!(current.expires_at_ms, saved.expires_at_ms);
    assert_eq!(
        serde_json::to_vec(&current.value).unwrap(),
        serde_json::to_vec(&saved.value).unwrap()
    );
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
    *plan
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
fn absent_reset_config_uses_fail_closed_default_and_spends_nothing() {
    let default = ResetConfig::default();
    assert!(default.enabled);
    assert_eq!(default.mode, ResetMode::Live);
    assert_eq!(default.max_per_account_per_day, 0);
    assert_eq!(default.max_per_account_per_window, 1);

    let (store, authority, proof) = setup_without_reset_config();
    assert!(matches!(
        run(authority.prepare_full_pool_reset(&proof, &original())).unwrap(),
        FullPoolPreparation::Declined { reason } if reason == "per_account_day_limit_invalid"
    ));
    let day = utc_day(NOW).unwrap();
    let reset = block().reset_at_ms.unwrap();
    for account in pool().accounts {
        let invocation = reset_invocation(
            &account.admin_account_hash.0,
            &account.credential_version.0,
            reset,
        )
        .unwrap();
        assert!(
            store
                .row(&keys::reset_redemption(
                    &invocation.identity.account_id_hash,
                    &invocation.identity.quota_generation
                ))
                .is_none()
        );
        assert!(
            store
                .row(&keys::reset_day(&invocation.identity.account_id_hash, &day))
                .is_none()
        );
    }
}

#[test]
fn live_selection_preserves_selected_shadow_history_without_reading_it() {
    let (store, authority, proof) = setup(ResetMode::Shadow);
    let initial = plan(&authority, &proof);
    let rows = observations(&initial, Some(JsString16::from_utf8("shadow-credit")));
    let FullPoolEvaluation::Shadow { decision, .. } =
        run(authority.finish_full_pool_reset(initial, &rows, &Collation)).unwrap()
    else {
        panic!("selected shadow decision required")
    };
    assert_eq!(decision.decision_reason, "selected");
    let key = keys::reset_shadow(&decision.episode_hash);
    let saved = store.row(&key).unwrap();
    store.seed(keys::reset_config(), &config(ResetMode::Live));
    // A live read of this historical key would consume the jump and expire the fresh inventory.
    store.jump_on_read(key.clone(), NOW + 30_001);
    let next = plan(&authority, &proof);
    let rows = observations(&next, Some(JsString16::from_utf8("new-credit")));
    let FullPoolEvaluation::Ready(permit) =
        run(authority.finish_full_pool_reset(next, &rows, &Collation)).unwrap()
    else {
        panic!("live mode must use the fresh eligible credit")
    };
    assert_eq!(permit.credit_id(), &JsString16::from_utf8("new-credit"));
    assert_history_unchanged(&store, &key, &saved);
}

#[test]
fn first_live_call_mints_opaque_permit_without_arming() {
    let (store, authority, proof) = setup(ResetMode::Live);
    let first = plan(&authority, &proof);
    let rows = observations(
        &first,
        Some(JsString16::from_units(vec![b'c' as u16, 0xd800])),
    );
    let FullPoolEvaluation::Ready(permit) =
        run(authority.finish_full_pool_reset(first, &rows, &Collation)).unwrap()
    else {
        panic!("first live call must mint the permit")
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
    assert!(
        store
            .row(&keys::reset_shadow(permit.episode_hash()))
            .is_none()
    );
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

#[test]
fn unexpired_shadow_is_cached_without_requesting_new_inventory() {
    let (_, authority, proof) = setup(ResetMode::Shadow);
    let first = plan(&authority, &proof);
    let rows = observations(&first, None);
    let FullPoolEvaluation::Shadow {
        decision,
        duplicate: false,
    } = run(authority.finish_full_pool_reset(first, &rows, &Collation)).unwrap()
    else {
        panic!("expected one source audit")
    };
    let FullPoolPreparation::Cached { decision: cached } =
        run(authority.prepare_full_pool_reset(&proof, &original())).unwrap()
    else {
        panic!("cached shadow must not request inventory")
    };
    assert_eq!(cached, decision);
}

#[test]
fn cached_profile_audit_preserves_unrelated_utf16_source_leaves() {
    use gateway_core::value::PortableValue;
    let (store, authority, proof) = setup(ResetMode::Shadow);
    let first = plan(&authority, &proof);
    let rows = observations(&first, None);
    let FullPoolEvaluation::Shadow { decision, .. } =
        run(authority.finish_full_pool_reset(first, &rows, &Collation)).unwrap()
    else {
        panic!("source audit required")
    };
    let mut portable = PortableValue::from_json(&serde_json::to_value(&decision).unwrap());
    let PortableValue::Object(fields) = &mut portable else {
        panic!("source object required")
    };
    fields.push((
        "operator_text".into(),
        PortableValue::string_utf16(vec![0xd800]),
    ));
    store.seed_record(
        keys::reset_shadow(&decision.episode_hash),
        StoredRecord::profile_v2("source-profile-audit", portable, None).unwrap(),
    );
    let FullPoolPreparation::Cached { decision: cached } =
        run(authority.prepare_full_pool_reset(&proof, &original())).unwrap()
    else {
        panic!("typed source audit must remain readable without conversion")
    };
    assert_eq!(cached, decision);
}

#[test]
fn extended_or_expired_shadow_history_never_blocks_or_overwrites_live() {
    for (label, created_at_ms, expires_at_ms) in [
        ("expired", NOW - 2, NOW - 1),
        ("extended", NOW - 1, NOW + 120_000),
    ] {
        let (store, authority, proof) = setup(ResetMode::Shadow);
        let first = plan(&authority, &proof);
        let rows = observations(&first, None);
        let FullPoolEvaluation::Shadow { mut decision, .. } =
            run(authority.finish_full_pool_reset(first, &rows, &Collation)).unwrap()
        else {
            panic!("source audit required")
        };
        decision.created_at_ms = created_at_ms;
        decision.expires_at_ms = expires_at_ms;
        let key = keys::reset_shadow(&decision.episode_hash);
        store.seed_with_revision(
            key.clone(),
            &decision,
            &format!("historical-shadow-{label}"),
        );
        let saved = store.row(&key).unwrap();
        store.seed(keys::reset_config(), &config(ResetMode::Live));
        let next = plan(&authority, &proof);
        let rows = observations(&next, Some(JsString16::from_utf8("fresh-credit")));
        let FullPoolEvaluation::Ready(permit) =
            run(authority.finish_full_pool_reset(next, &rows, &Collation)).unwrap()
        else {
            panic!("{label} historical decision must not gate live")
        };
        assert_eq!(permit.credit_id(), &JsString16::from_utf8("fresh-credit"));
        assert_history_unchanged(&store, &key, &saved);
    }
}

#[test]
fn complete_inventory_and_every_disabled_member_setting_remain_fenced() {
    let (store, authority, proof) = setup(ResetMode::Shadow);
    let disabled = keys::reset_usage(&pool().accounts[1].admin_account_hash.0);
    store.seed(disabled.clone(), &json!({"enabled":false}));
    let first = plan(&authority, &proof);
    assert_eq!(first.bindings().count(), 1);
    assert!(
        matches!(run(authority.finish_full_pool_reset(first, &[], &Collation)).unwrap(), FullPoolEvaluation::Declined { reason } if reason == "inventory_unavailable")
    );
    let next = plan(&authority, &proof);
    let rows = observations(&next, None);
    // Even a semantically unchanged disabled setting has a different source
    // versionstamp and invalidates the complete episode while inventory is in flight.
    store.seed(disabled, &json!({"enabled":false}));
    assert!(
        matches!(run(authority.finish_full_pool_reset(next, &rows, &Collation)).unwrap(), FullPoolEvaluation::Declined { reason } if reason == "routing_fence_stale")
    );
    let next = plan(&authority, &proof);
    let rows = observations(&next, None);
    let FullPoolEvaluation::Shadow { decision, .. } =
        run(authority.finish_full_pool_reset(next, &rows, &Collation)).unwrap()
    else {
        panic!("complete source audit required")
    };
    assert_eq!(decision.fences.len(), 2);
    assert_eq!(decision.fences[1].slot, 1);
}

#[test]
fn selection_requires_source_collation_for_an_exact_same_slot_expiry_tie() {
    struct SourceOrder;
    impl SourceCreditCollation for SourceOrder {
        fn compare_credit_ids(
            &self,
            left: &JsString16,
            right: &JsString16,
        ) -> Result<Ordering, GatewayError> {
            // A deliberately non-byte-order host proves selection cannot silently
            // replace the required source capability with a Rust string ordering.
            Ok(right.as_units().cmp(left.as_units()))
        }
    }
    let (_, authority, proof) = setup(ResetMode::Live);
    let first = plan(&authority, &proof);
    let mut rows = observations(&first, Some(JsString16::from_utf8("a")));
    let mut later = rows[0].credits[0].clone();
    later.credit_id = JsString16::from_units(vec![0xd800]);
    rows[0].credits.push(later);
    rows[0].available_count = 2;
    let FullPoolEvaluation::Ready(permit) =
        run(authority.finish_full_pool_reset(first, &rows, &SourceOrder)).unwrap()
    else {
        panic!("same source-selected credit must mint the permit")
    };
    assert_eq!(permit.credit_id().as_units(), &[0xd800]);
}

#[test]
fn source_golden_collation_controls_selection_and_utf16_credit_hashes() {
    #[derive(serde::Deserialize)]
    struct Case {
        ids: Vec<Vec<u16>>,
        comparison: i32,
        selected: Vec<u16>,
    }
    struct GoldenCollation<'a>(&'a Case);
    impl SourceCreditCollation for GoldenCollation<'_> {
        fn compare_credit_ids(
            &self,
            left: &JsString16,
            right: &JsString16,
        ) -> Result<Ordering, GatewayError> {
            assert_eq!(left.as_units(), self.0.ids[1]);
            assert_eq!(right.as_units(), self.0.ids[0]);
            Ok(self.0.comparison.cmp(&0))
        }
    }
    let source = SourceJson::parse(include_str!("../fixtures/full-pool-source-v1.json")).unwrap();
    let rows = source
        .object_entries()
        .unwrap()
        .into_iter()
        .find(|(key, _)| key.try_utf8().ok().as_deref() == Some("collation_cases"))
        .unwrap()
        .1
        .array_items()
        .unwrap();
    assert_eq!(rows.len(), 5);
    for row in rows {
        let case: Case = row.deserialize().unwrap();
        let (_, authority, proof) = setup(ResetMode::Live);
        let first = plan(&authority, &proof);
        let mut rows = observations(&first, None);
        rows[0].credits = case
            .ids
            .iter()
            .map(|id| SourceResetCredit {
                credit_id: JsString16::from_units(id.clone()),
                status: JsString16::from_utf8("available"),
                reset_type: JsString16::from_utf8("codex_rate_limits"),
                expires_at_ms: None,
            })
            .collect();
        rows[0].available_count = rows[0].credits.len() as i64;
        let FullPoolEvaluation::Ready(permit) =
            run(authority.finish_full_pool_reset(first, &rows, &GoldenCollation(&case))).unwrap()
        else {
            panic!("exact source-selected credit required")
        };
        assert_eq!(permit.credit_id().as_units(), case.selected);
    }
}

#[test]
fn provider_accepted_overlong_id_invalidates_the_complete_pool_decision() {
    let (_, authority, proof) = setup(ResetMode::Shadow);
    let first = plan(&authority, &proof);
    let rows = observations(&first, Some(JsString16::from_units(vec![b'x' as u16; 513])));
    let FullPoolEvaluation::Shadow { decision, .. } =
        run(authority.finish_full_pool_reset(first, &rows, &Collation)).unwrap()
    else {
        panic!("invalid source evaluator inventory must retain its no-selection audit")
    };
    assert_eq!(
        decision.decision_reason,
        "inventory_response_invalid_or_expired"
    );
    assert!(decision.selected_account_id_hash.is_none());
    assert!(decision.selected_credit_id_hash.is_none());
}
