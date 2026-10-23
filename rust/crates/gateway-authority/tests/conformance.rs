mod capacity_cases;
mod claude_cases;
mod full_pool_reset;
mod paid_control_cases;
mod paid_original;
mod paid_retention_f13;
mod reset_spend;
mod routing_source_cases;
mod source_model_cases;
mod support;
use std::sync::atomic::Ordering;

use gateway_authority::paid::{
    PaidAdmission, PaidAuthorization, PaidCorrelation, PaidRequest, PaidRoutingPolicy, PaidUsage,
    PaidWindow,
};
use gateway_authority::quota::{ApiUsageWindow, KernelPolicy, KernelTerminal, KernelWindow};
use gateway_authority::reset::{
    AccountDayBudget, ResetCandidate, ResetClaim, ResetConfig, ResetCredit, ResetMode, ResetState,
    reset_invocation, utc_day,
};
use gateway_authority::routing::RouteSelection;
use gateway_authority::{DAY_MS, PAID_RETENTION_MS, QUOTA_RETENTION_MS, keys};
use gateway_core::identity::{ApiKeyId, PaidAttemptId, PoolVersionstamp, RequestId};
use gateway_core::lifecycle::{BillingState, PaidTerminalState};
use gateway_core::provider::{CodexQuotaClass, PaidProvider, UpstreamProvider};
use gateway_core::state::AuthorityStore;
use support::*;

fn id(value: &str) -> RequestId {
    RequestId(value.to_owned())
}
fn seed_policy(store: &MemoryStore) {
    store.seed(keys::api_policy("key-a"), &policy());
}
fn paid_setup(store: &MemoryStore) {
    seed_policy(store);
    paid_control_cases::seed_controls(store);
}
fn paid_request(attempt: &str, provider: PaidProvider) -> PaidRequest {
    PaidRequest {
        key_id: ApiKeyId("key-a".to_owned()),
        request_id: id("client-one"),
        attempt_id: PaidAttemptId(attempt.to_owned()),
        provider,
        model: "paid-model".into(),
        route: "responses".to_owned(),
        path: "/v1/responses".to_owned(),
        stream: true,
        reasoning: None,
        created_at_ms: NOW,
    }
}
async fn reserve_paid(
    authority: &TestAuthority,
    input: &PaidRequest,
    authorization: &PaidAuthorization,
    now: i64,
) -> Result<PaidAdmission, gateway_core::GatewayError> {
    authority.store().clock(now);
    let context = paid_control_cases::context(input);
    let receipt = paid_original::authorize(authority, input, &context, now).await?;
    authority
        .reserve_paid(input, authorization, &receipt, now)
        .await
}

fn paid_reservation(
    authority: &TestAuthority,
    input: &PaidRequest,
) -> gateway_authority::paid::PaidReservation {
    match run(reserve_paid(
        authority,
        input,
        &PaidAuthorization::DirectPaidModel,
        NOW,
    ))
    .unwrap()
    {
        PaidAdmission::Reserved(reservation) => reservation,
        _ => panic!("expected fresh reservation"),
    }
}

#[test]
fn serial_identity_survives_headroom_reorder_and_same_account_refresh() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let first = admitted(&authority);
    let mut reordered = pool();
    reordered.accounts.reverse();
    reordered.pool_versionstamp = PoolVersionstamp("pool-reordered".to_owned());
    seed_pool(&store, &reordered);
    let second = admitted(&authority);
    assert_eq!(
        first.binding.account_id_hash,
        second.binding.account_id_hash
    );
    assert_eq!(first.active_generation, second.active_generation);
    assert_eq!(second.binding.slot, 1);
    reordered.accounts[1].credential_version =
        source_account("a", true).identity().credential_version;
    reordered.pool_versionstamp = PoolVersionstamp("pool-refreshed".to_owned());
    seed_pool(&store, &reordered);
    let refreshed = admitted(&authority);
    assert_eq!(refreshed.active_generation, first.active_generation);
    assert!(refreshed.binding.routing_generation > first.binding.routing_generation);
    assert!(run(authority.ensure_admission_current(&first, NOW)).is_err());
}

#[test]
fn mixed_pool_proof_is_not_quota_only_and_expires_with_the_quota_deadline() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    paid_setup(&store);
    let authority = authority(&store);
    let first = admitted(&authority);
    run(authority.record_quota_block(&first, block(), NOW)).unwrap();
    let second = admitted(&authority);
    run(authority.mark_credential_invalid(&second, NOW)).unwrap();
    let RouteSelection::QuotaBlocked { proof, .. } =
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("missing mixed proof")
    };
    assert!(proof.full_cohort_unavailable());
    assert!(!proof.full_cohort_exhausted());
    let mut input = paid_request("mixed-paid", PaidProvider::Surplus);
    input.model = "gpt-test".into();
    assert!(
        run(reserve_paid(
            &authority,
            &input,
            &PaidAuthorization::SubscriptionUnavailable(proof.clone()),
            NOW
        ))
        .is_ok()
    );
    store.clock(NOW + 60_001);
    input.attempt_id = PaidAttemptId("expired-proof".to_owned());
    assert!(
        run(reserve_paid(
            &authority,
            &input,
            &PaidAuthorization::SubscriptionUnavailable(proof),
            NOW + 60_001
        ))
        .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", "expired-proof"))
            .is_none()
    );
}

#[test]
fn invalid_active_and_unknown_capacity_never_authorize_failover() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let first = admitted(&authority);
    assert!(!first.probe_required);
    store.seed(
        keys::active(),
        &serde_json::json!({"v":1,"generation":"corrupt"}),
    );
    assert!(
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).is_err()
    );
    assert_eq!(
        store.row(&keys::active()).unwrap().value["generation"],
        "corrupt"
    );
}

#[test]
fn exact_model_entitlement_rotates_but_generic_model_errors_do_not() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let first = admitted(&authority);
    assert!(
        !run(authority.learn_model_unavailable(&first, &"model unavailable".into(), NOW)).unwrap()
    );
    assert_eq!(
        admitted(&authority).binding.account_id_hash,
        first.binding.account_id_hash
    );
    store.seed(keys::models(),&serde_json::json!({"accounts":{
        "a":{"slugs":["other"],"client_version":"0.163.0","updated_at_ms":NOW},
        "b":{"slugs":["gpt-test"],"client_version":"0.163.0","updated_at_ms":NOW}},"unsupported":{}}));
    let replacement = admitted(&authority);
    assert_eq!(replacement.binding.account_id_hash.0, routing_hash("b").0);
    assert_eq!(replacement.active_generation, first.active_generation + 1);
}

#[test]
fn api_dispatch_counts_once_and_client_cancellation_does_not_refund() {
    let store = MemoryStore::default();
    seed_policy(&store);
    let authority = authority(&store);
    let reservation =
        run(authority.reserve_api_key(&policy().key_id, &id("one"), "responses", NOW)).unwrap();
    assert!(
        run(authority.dispatch_api_key(&reservation, UpstreamProvider::ChatgptCodex, NOW)).unwrap()
    );
    assert!(
        !run(authority.dispatch_api_key(&reservation, UpstreamProvider::Metered, NOW)).unwrap()
    );
    run(authority.mark_api_transport_started(&reservation, NOW)).unwrap();
    assert!(!run(authority.release_api_key(&reservation, true, "client_cancelled", NOW)).unwrap());
    let window: ApiUsageWindow = serde_json::from_value(
        store
            .row(&keys::api_window(
                "key-a",
                &reservation.policy_version,
                reservation.window_start_ms,
            ))
            .unwrap()
            .value,
    )
    .unwrap();
    assert_eq!(
        (window.committed_requests, window.reserved_requests),
        (1, 0)
    );
    assert!(
        run(authority.reserve_api_key(&policy().key_id, &id("one"), "responses", NOW)).is_err()
    );
}

#[test]
fn known_pretransport_cancellation_and_reserved_release_are_idempotent() {
    let store = MemoryStore::default();
    seed_policy(&store);
    let authority = authority(&store);
    let reservation =
        run(authority.reserve_api_key(&policy().key_id, &id("one"), "responses", NOW)).unwrap();
    run(authority.dispatch_api_key(&reservation, UpstreamProvider::Surplus, NOW)).unwrap();
    assert!(
        run(authority.release_api_key(&reservation, true, "transport_cancelled_before_fetch", NOW))
            .unwrap()
    );
    assert!(!run(authority.release_api_key(&reservation, true, "again", NOW)).unwrap());
    let other =
        run(authority.reserve_api_key(&policy().key_id, &id("two"), "responses", NOW)).unwrap();
    assert!(run(authority.release_api_key(&other, false, "validation", NOW)).unwrap());
}

#[test]
fn full_quota_allows_deferred_local_work_but_still_blocks_provider_dispatch() {
    let store = MemoryStore::default();
    let mut limited = policy();
    limited.usage_limit_requests = 0;
    store.seed(keys::api_policy("key-a"), &limited);
    let authority = authority(&store);
    let deferred =
        run(authority.reserve_api_key_deferred(&limited.key_id, &id("local"), "responses", NOW))
            .unwrap();
    assert!(deferred.deferred);
    assert!(!run(authority.release_api_key(&deferred, false, "local_compaction", NOW)).unwrap());
    assert!(run(authority.resolve_deferred_api(&deferred, NOW)).is_err());
}

#[test]
fn concurrent_api_admissions_never_exceed_limit_and_cas_conflicts_retry() {
    let store = MemoryStore::default();
    seed_policy(&store);
    store.conflicts.store(1, Ordering::SeqCst);
    let tokens = Tokens::default();
    let handles: Vec<_> = (0..8)
        .map(|index| {
            let store = store.clone();
            let tokens = tokens.clone();
            std::thread::spawn(move || {
                let authority = gateway_authority::Authority::new(store, tokens);
                run(authority.reserve_api_key(
                    &policy().key_id,
                    &id(&format!("request-{index}")),
                    "responses",
                    NOW,
                ))
                .is_ok()
            })
        })
        .collect();
    let admitted = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .filter(|admitted| *admitted)
        .count();
    assert_eq!(admitted, 2);
}

#[test]
fn kernel_terminal_intent_survives_restart_and_never_changes_new_window_counts() {
    let store = MemoryStore::default();
    store.seed(
        keys::kernel_policy("owner", Some("repo")),
        &KernelPolicy {
            v: 2,
            owner: "owner".to_owned(),
            repo: Some("repo".to_owned()),
            usage_limit_requests: 1,
            window_ms: 1000,
            expires_at_ms: -1,
        },
    );
    let authority = authority(&store);
    let old = run(authority.reserve_kernel("owner", "repo", &id("old"), "responses", NOW)).unwrap();
    run(authority.record_kernel_terminal_intent(&old, KernelTerminal::Committed, NOW)).unwrap();
    store.clock(NOW + 1001);
    let new = run(authority.reserve_kernel("owner", "repo", &id("new"), "responses", NOW + 1001))
        .unwrap();
    assert!(
        run(authority.settle_kernel(&old, KernelTerminal::Committed, "completed", NOW + 1001))
            .unwrap()
    );
    let window: KernelWindow = serde_json::from_value(
        store
            .row(&keys::kernel_window("owner", Some("repo")))
            .unwrap()
            .value,
    )
    .unwrap();
    assert_eq!((window.usage_requests, window.reserved_requests), (0, 1));
    assert_eq!(window.created_at_ms, new.window_created_at_ms);
    assert!(
        run(authority.settle_kernel(&old, KernelTerminal::Released, "cancelled", NOW + 1001))
            .is_err()
    );
    assert!(
        !run(authority.settle_kernel(&old, KernelTerminal::Committed, "duplicate", NOW + 1001))
            .unwrap()
    );
}

#[test]
fn paid_usage_records_actual_overshoot_once_without_fabricating_a_terminal() {
    let store = MemoryStore::default();
    paid_setup(&store);
    let authority = authority(&store);
    let input = paid_request("paid-one", PaidProvider::Metered);
    let reservation = paid_reservation(&authority, &input);
    run(authority.mark_paid_transport_started(&reservation, NOW)).unwrap();
    run(authority.record_paid_lifecycle(&reservation, Some("provider-one"), None, NOW)).unwrap();
    let usage = PaidUsage {
        provider_quota: 2500.0,
        input_tokens: 10,
        cached_input_tokens: None,
        output_tokens: 20,
        correlation: PaidCorrelation::ProviderRequestId("provider-one".to_owned()),
    };
    assert!(run(authority.settle_paid(&reservation, &usage, NOW)).unwrap());
    assert!(!run(authority.settle_paid(&reservation, &usage, NOW)).unwrap());
    let row: gateway_authority::paid::PaidAttempt =
        gateway_core::source_control::decode_source_control_record(
            &store.row(&keys::paid_attempt("key-a", "paid-one")).unwrap(),
        )
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(row.spend_microcredits, Some(2500));
    assert_eq!(row.terminal_state, PaidTerminalState::Pending);
    assert_eq!(row.billing_state, BillingState::Settled);
    let window: PaidWindow = serde_json::from_value(
        store
            .row(&keys::paid_window("key-a", reservation.window_reset_at_ms))
            .unwrap()
            .value,
    )
    .unwrap();
    assert_eq!(
        (
            window.settled_microcredits,
            window.reserved_microcredits,
            window.pending_count
        ),
        (2500, 0, 0)
    );
    assert_eq!(
        store
            .row(&keys::paid_attempt("key-a", "paid-one"))
            .unwrap()
            .expires_at_ms,
        Some(NOW + PAID_RETENTION_MS)
    );
    assert!(run(authority.due_paid(NOW, 10)).unwrap().is_empty());
}

#[test]
fn surplus_exact_cost_preserves_odd_microcredits_and_unlimited_has_no_window() {
    let store = MemoryStore::default();
    paid_setup(&store);
    let mut unlimited = policy();
    unlimited.paid_fallback_limit_microcredits = -1;
    store.seed(keys::api_policy("key-a"), &unlimited);
    let authority = authority(&store);
    let input = paid_request("surplus-one", PaidProvider::Surplus);
    let reservation = paid_reservation(&authority, &input);
    assert_eq!(reservation.reserved_microcredits, 0);
    assert!(
        store
            .row(&keys::paid_window("key-a", reservation.window_reset_at_ms))
            .is_none()
    );
    let usage = PaidUsage {
        provider_quota: 100.0,
        input_tokens: 1,
        cached_input_tokens: Some(0),
        output_tokens: 2,
        correlation: PaidCorrelation::SurplusReservation {
            attempt_id: input.attempt_id,
            buyer_cost_micro: Some(101),
        },
    };
    assert!(run(authority.settle_paid(&reservation, &usage, NOW)).unwrap());
    assert_eq!(
        store
            .row(&keys::paid_attempt("key-a", "surplus-one"))
            .unwrap()
            .value["spend_microcredits"],
        101
    );
}

#[test]
fn paid_disable_racing_admission_prevents_exposure_and_transient_failures_retain_it() {
    let store = MemoryStore::default();
    paid_setup(&store);
    let authority = authority(&store);
    let mut disabled = policy();
    disabled.paid_fallback_enabled = false;
    store.race(keys::api_policy("key-a"), &disabled);
    assert!(
        run(reserve_paid(
            &authority,
            &paid_request("disabled", PaidProvider::Surplus),
            &PaidAuthorization::DirectPaidModel,
            NOW
        ))
        .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", "disabled"))
            .is_none()
    );
    seed_policy(&store);
    let reservation = paid_reservation(
        &authority,
        &paid_request("ambiguous", PaidProvider::Surplus),
    );
    run(authority.mark_paid_transport_started(&reservation, NOW)).unwrap();
    assert!(!run(authority.release_paid_before_transport(&reservation, NOW)).unwrap());
    store.clock(NOW + DAY_MS + 1);
    run(authority.defer_paid(&reservation, NOW + DAY_MS + 1)).unwrap();
    let row = store
        .row(&keys::paid_attempt("key-a", "ambiguous"))
        .unwrap();
    assert_eq!(row.value["billing_state"], "unresolved");
    assert_eq!(row.value["terminal_state"], "pending");
    assert_eq!(row.expires_at_ms, Some(NOW + PAID_RETENTION_MS));
    assert!(
        store
            .row(&keys::paid_pending("key-a", "ambiguous"))
            .is_some()
    );
}

fn reset_candidate(store: &MemoryStore, authority: &TestAuthority) -> ResetCandidate {
    let first = admitted(authority);
    run(authority.record_quota_block(&first, block(), NOW)).unwrap();
    let second = admitted(authority);
    run(authority.record_quota_block(&second, block(), NOW)).unwrap();
    let RouteSelection::QuotaBlocked { proof, .. } =
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("quota-only proof missing")
    };
    assert!(proof.full_cohort_exhausted());
    store.seed(
        keys::reset_config(),
        &ResetConfig {
            enabled: true,
            mode: ResetMode::Live,
            max_per_account_per_day: 1,
            max_per_account_per_window: 1,
            provider_approved: true,
            supports_idempotent_lookup: true,
            redeem_outcome_is_final: false,
        },
    );
    ResetCandidate {
        binding: proof.account_bindings()[0].clone(),
        quota_reset_at_ms: NOW + 60_000,
        request_started_at_ms: NOW + 10,
        proof,
    }
}
fn armed_reset(
    store: &MemoryStore,
    authority: &TestAuthority,
) -> (ResetCandidate, gateway_authority::reset::ResetRecord) {
    let candidate = reset_candidate(store, authority);
    let credit = ResetCredit {
        credit_id: "synthetic-credit".to_owned(),
        expires_at_ms: Some(NOW + DAY_MS),
        observed_at_ms: NOW,
        eligible: true,
    };
    store.clock(NOW + 1);
    run(authority.record_reset_shadow(&candidate, &credit, NOW + 1)).unwrap();
    store.clock(NOW + 2);
    assert!(run(authority.arm_reset_live(&candidate, NOW + 2)).unwrap());
    store.clock(NOW + 11);
    let ResetClaim::Submit { record, .. } =
        run(authority.claim_reset(&candidate, NOW + 11)).unwrap()
    else {
        panic!("claim missing")
    };
    (candidate, record)
}

#[test]
fn reset_unknown_is_lookup_only_after_owner_takeover_even_when_disabled() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let (candidate, claimed) = armed_reset(&store, &authority);
    store.clock(NOW + 12);
    let submitted =
        run(authority.prepare_reset_submission(&candidate, &claimed, NOW + 12)).unwrap();
    let unknown = run(authority.record_reset_outcome(
        &submitted,
        ResetState::Unknown,
        None,
        Some("provider_timeout"),
        NOW + 13,
    ))
    .unwrap();
    store.seed(
        keys::reset_config(),
        &ResetConfig {
            enabled: false,
            ..ResetConfig::default()
        },
    );
    store.clock(NOW + 40_000);
    let ResetClaim::Reconcile { record, .. } =
        run(authority.claim_reset(&candidate, NOW + 40_000)).unwrap()
    else {
        panic!("lookup-only recovery missing")
    };
    assert!(record.fence > unknown.fence);
    assert!(
        run(authority.record_reset_outcome(
            &unknown,
            ResetState::Verified,
            None,
            None,
            NOW + 40_000
        ))
        .is_err()
    );
    let budget: AccountDayBudget = serde_json::from_value(
        store
            .row(&keys::reset_day(
                &record.identity.account_id_hash,
                &utc_day(NOW).unwrap(),
            ))
            .unwrap()
            .value,
    )
    .unwrap();
    assert_eq!(budget.submission_count, 1);
}

#[test]
fn account_day_budget_and_stale_cohort_stop_submission_without_changing_claim() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let (candidate, claimed) = armed_reset(&store, &authority);
    let day = utc_day(NOW).unwrap();
    store.seed(
        keys::reset_day(&claimed.identity.account_id_hash, &day),
        &AccountDayBudget {
            v: 1,
            day,
            submission_count: 1,
            updated_at_ms: NOW,
        },
    );
    let error =
        run(authority.prepare_reset_submission(&candidate, &claimed, NOW + 12)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("account_day_limit_reached")
    );
    let mut changed = pool();
    changed.pool_versionstamp = PoolVersionstamp("changed".to_owned());
    seed_pool(&store, &changed);
    assert!(run(authority.prepare_reset_submission(&candidate, &claimed, NOW + 12)).is_err());
    assert_eq!(
        store
            .row(&keys::reset_redemption(
                &claimed.identity.account_id_hash,
                &claimed.identity.quota_generation
            ))
            .unwrap()
            .value["state"],
        "claimed"
    );
}

#[test]
fn overage_off_is_a_hard_gate_and_enabled_probe_blocks_other_requests() {
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
        panic!("quota proof missing")
    };
    assert!(
        run(authority.claim_overage_probe(&proof, None, "inventory_unavailable", NOW))
            .unwrap()
            .is_none()
    );
    store.seed(
        keys::overage(&admin_hash("a").0),
        &serde_json::json!({"allow":true}),
    );
    let RouteSelection::QuotaBlocked { proof, .. } =
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("quota proof missing")
    };
    let active_before = store.row(&keys::active()).unwrap().value;
    let claimed = run(authority.claim_overage_probe(
        &proof,
        Some(&first.binding.account_id_hash),
        "inventory_unavailable",
        NOW,
    ))
    .unwrap()
    .unwrap();
    assert_eq!(store.row(&keys::active()).unwrap().value, active_before);
    run(authority.ensure_overage_probe_current(&claimed, NOW)).unwrap();
    assert!(run(authority.finish_overage_probe(&claimed, true, NOW)).unwrap());
}

#[test]
fn reset_identity_deduplicates_refresh_and_utc_days_and_expiry_remain_absolute() {
    let old = reset_invocation("account-hash", "old-credential", NOW + 60_000).unwrap();
    let fresh = reset_invocation("account-hash", "new-credential", NOW + 60_000).unwrap();
    assert_eq!(
        old.identity.quota_generation,
        fresh.identity.quota_generation
    );
    assert_eq!(
        old.identity.idempotency_key_hash,
        fresh.identity.idempotency_key_hash
    );
    assert_ne!(
        old.identity.credential_version,
        fresh.identity.credential_version
    );
    assert_eq!(utc_day(0).unwrap(), "1970-01-01");
    assert_eq!(utc_day(1_709_164_800_000).unwrap(), "2024-02-29");
    let store = MemoryStore::default();
    seed_policy(&store);
    let authority = authority(&store);
    let reservation =
        run(authority.reserve_api_key(&policy().key_id, &id("expiry"), "responses", NOW)).unwrap();
    let key = keys::api_request(
        "key-a",
        &reservation.policy_version,
        reservation.window_start_ms,
        "expiry",
    );
    assert_eq!(
        store.row(&key).unwrap().expires_at_ms,
        Some(reservation.window_reset_at_ms + QUOTA_RETENTION_MS)
    );
}

#[test]
fn bad_stored_versions_are_not_replaced_with_empty_state() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let mut bad = store.row(&keys::pool()).unwrap();
    bad.schema_version = 99;
    run(store.commit(gateway_core::state::AtomicTransition {
        checks: vec![gateway_core::state::RevisionCheck {
            key: keys::pool(),
            expected_revision: Some(bad.revision.clone()),
        }],
        mutations: vec![gateway_core::state::RecordMutation::Put {
            key: keys::pool(),
            record: bad,
        }],
    }))
    .unwrap_err();
    assert!(!store.is_empty());
}

#[test]
fn reset_deadline_crossing_during_async_fence_reads_consumes_no_daily_budget() {
    let store = MemoryStore::default();
    seed_pool(&store, &pool());
    let authority = authority(&store);
    let (candidate, claimed) = armed_reset(&store, &authority);
    let day = utc_day(NOW).unwrap();
    store.jump_on_read(
        keys::reset_day(&claimed.identity.account_id_hash, &day),
        candidate.quota_reset_at_ms,
    );
    let error =
        run(authority.prepare_reset_submission(&candidate, &claimed, NOW + 12)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("quota_window_expired")
    );
    assert!(
        store
            .row(&keys::reset_day(&claimed.identity.account_id_hash, &day))
            .is_none()
    );
    assert_eq!(
        store
            .row(&keys::reset_redemption(
                &claimed.identity.account_id_hash,
                &claimed.identity.quota_generation
            ))
            .unwrap()
            .value["state"],
        "claimed"
    );
}

#[test]
fn kernel_source_drift_rejects_temporal_contradictions_and_cross_window_reservations() {
    let store = MemoryStore::default();
    let authority = authority(&store);
    let valid =
        run(authority.reserve_kernel("owner", "repo", &id("strict"), "responses", NOW)).unwrap();
    let mut bad = valid.clone();
    bad.lease_expires_at_ms = bad.reserved_at_ms;
    assert!(bad.validate().is_err());
    bad = valid.clone();
    bad.window_reset_at_ms = bad.window_created_at_ms;
    assert!(bad.validate().is_err());
    bad = valid.clone();
    bad.state = Some(KernelTerminal::Released);
    bad.terminal_at_ms = Some(NOW);
    bad.terminal_intent = Some(KernelTerminal::Released);
    bad.release_reason = Some("   ".to_owned());
    assert!(bad.validate().is_err());
    let mut mismatched = valid.clone();
    mismatched.window_reset_at_ms += 1;
    store.seed(
        keys::kernel_request(
            &valid.owner,
            valid.repo.as_deref(),
            valid.window_created_at_ms,
            &valid.request_id.0,
        ),
        &mismatched,
    );
    let window = store
        .row(&keys::kernel_window(&valid.owner, valid.repo.as_deref()))
        .unwrap();
    assert!(
        run(authority.reserve_kernel("owner", "repo", &id("must-not-admit"), "responses", NOW))
            .is_err()
    );
    assert_eq!(
        store
            .row(&keys::kernel_window(&valid.owner, valid.repo.as_deref()))
            .unwrap(),
        window
    );
}

#[test]
fn expired_paid_detail_clears_its_marker_without_refunding_retained_exposure() {
    let store = MemoryStore::default();
    paid_setup(&store);
    let authority = authority(&store);
    let reservation = paid_reservation(
        &authority,
        &paid_request("aged-evidence", PaidProvider::Metered),
    );
    run(authority.mark_paid_transport_started(&reservation, NOW)).unwrap();
    let window_key = keys::paid_window("key-a", reservation.window_reset_at_ms);
    let before = store.row(&window_key).unwrap();
    let later = NOW + PAID_RETENTION_MS + 1;
    store.clock(later);
    assert!(
        run(authority.reconcile_paid_marker(&reservation.key_id, &reservation.attempt_id, later))
            .unwrap()
    );
    assert!(
        store
            .row(&keys::paid_pending("key-a", "aged-evidence"))
            .is_none()
    );
    assert!(run(authority.due_paid(later, 10)).unwrap().is_empty());
    assert_eq!(store.row(&window_key).unwrap(), before);
}

#[test]
fn domain_rows_require_declared_json_and_never_guess_from_value_shapes() {
    use gateway_core::state::{AtomicTransition, RecordMutation, RevisionCheck, StoredRecord};
    use gateway_core::value::PortableValue;

    let store = MemoryStore::default();
    let typed = StoredRecord::profile(
        "typed-import",
        PortableValue::from_json(&serde_json::to_value(pool()).unwrap()),
        None,
    )
    .unwrap();
    run(store.commit(AtomicTransition {
        checks: vec![RevisionCheck {
            key: keys::pool(),
            expected_revision: None,
        }],
        mutations: vec![RecordMutation::Put {
            key: keys::pool(),
            record: typed.clone(),
        }],
    }))
    .unwrap();
    let error =
        run(authority(&store).select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW))
            .unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("incompatible_value_encoding")
    );
    assert_eq!(store.row(&keys::pool()), Some(typed));
    assert!(store.row(&keys::active()).is_none());

    let json_store = MemoryStore::default();
    let mut lookalike = serde_json::to_value(pool()).unwrap();
    lookalike["type"] = serde_json::json!("binary");
    lookalike["value"] = serde_json::json!([1, 2, 3]);
    seed_pool(&json_store, &pool());
    json_store.seed(keys::pool(), &lookalike);
    assert_eq!(
        admitted(&authority(&json_store)).binding.account_id_hash.0,
        routing_hash("a").0
    );
}
