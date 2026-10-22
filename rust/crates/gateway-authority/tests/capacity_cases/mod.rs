use super::support::*;
use gateway_auth::provider_credentials::{CodexSourcePool, codex_source_pool_key};
use gateway_authority::{
    Authority, AuthorityClock, capacity::*, keys, paid_control::PaidControlOwner, routing::*,
};
use gateway_core::{
    GatewayError,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Default)]
struct CapturedStore {
    inner: MemoryStore,
    writes: Arc<Mutex<Vec<Vec<RecordKey>>>>,
    tokens: Tokens,
    refuse_routing: Arc<AtomicBool>,
    after_capacity: Arc<Mutex<Option<(RecordKey, Value)>>>,
}
impl AuthorityClock for CapturedStore {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        self.inner.now_ms()
    }
}
impl AuthorityStore for CapturedStore {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.inner.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mutations: Vec<_> = transition
            .mutations
            .iter()
            .map(|m| match m {
                RecordMutation::Put { key, .. } | RecordMutation::Delete { key } => key.clone(),
            })
            .collect();
        if mutations.contains(&keys::routing()) && self.refuse_routing.swap(false, Ordering::SeqCst)
        {
            return Err(GatewayError::unavailable(
                "Injected stopped R writer",
                "fixture_r_stopped",
            ));
        }
        let result = self.inner.commit(transition).await?;
        if result == CommitOutcome::Committed {
            self.writes.lock().unwrap().push(mutations.clone());
            if mutations.contains(&keys::capacity())
                && let Some((key, value)) = self.after_capacity.lock().unwrap().take()
            {
                self.inner.seed(key, &value);
            }
        }
        Ok(result)
    }
}
fn owner() -> PaidControlOwner {
    PaidControlOwner {
        v: 1,
        owner_id: "owner-a".into(),
        owner_epoch: "epoch-a".into(),
        key_fingerprint: "opaque-owner-key".into(),
    }
}
fn setup() -> (CapturedStore, Authority<CapturedStore, Tokens>) {
    let store = CapturedStore::default();
    seed_pool(&store.inner, &pool());
    store.inner.seed(keys::paid_control_owner(), &owner());
    let authority = Authority::with_clock(store.clone(), store.tokens.clone(), store.clone());
    (store, authority)
}
fn reference() -> CodexCapacityAccountRef {
    CodexCapacityAccountRef {
        source_slot: 1,
        account_id: "a".into(),
    }
}
fn sample(time: i64, used: f64) -> CodexCapacitySample {
    CodexCapacitySample {
        account: reference(),
        state: CapacityState::Available,
        source_observed_at_ms: Some(time),
        snapshot_at_ms: time,
        windows: CapacityWindows {
            primary: Some(CapacityWindow {
                limit_window_seconds: Some(300),
                used_percent: Some(used),
                reset_at_ms: Some(time + 60000),
            }),
            secondary: None,
        },
        additional_rate_limits: vec![],
    }
}
fn source_pool() -> CodexSourcePool {
    CodexSourcePool {
        accounts: vec![source_account("a", false), source_account("b", false)],
        updated_at_ms: NOW as f64,
    }
}

fn external_source(id: &str) -> gateway_auth::provider_credentials::CodexSourceAccount {
    use gateway_auth::{
        crypto::{Secret, base64url},
        provider_credentials::CodexNativeOwner,
    };
    let access = format!(
        "e30.{}.synthetic",
        base64url(json!({"exp":(NOW + 3_600_000) / 1000,"https://api.openai.com/auth":{"chatgpt_user_id":"fixture-user","chatgpt_account_id":id}}).to_string().as_bytes())
    );
    let mut source = gateway_auth::provider_credentials::CodexSourceAccount {
        account_id: id.into(),
        access_token: Secret::new(access),
        refresh_token: Secret::new(String::new()),
        updated_at_ms: NOW as f64,
        native_owner: None,
    };
    source.native_owner = Some(CodexNativeOwner {
        codex_home: format!("/tmp/synthetic-capacity-{id}"),
        generation_hash: source.identity().native_generation_hash,
        native_refreshed_at: None,
        external_user_id: Some("fixture-user".into()),
        managed_source: None,
    });
    source
}

fn setup_access_pool(
    accounts: Vec<gateway_auth::provider_credentials::CodexSourceAccount>,
) -> (CapturedStore, Authority<CapturedStore, Tokens>) {
    let store = CapturedStore::default();
    let source = CodexSourcePool {
        accounts,
        updated_at_ms: NOW as f64,
    };
    store
        .inner
        .seed(codex_source_pool_key(), &source.private_source_value());
    let revision = store.inner.row(&codex_source_pool_key()).unwrap().revision;
    let pool = SubscriptionPool {
        v: 1,
        pool_versionstamp: gateway_core::identity::PoolVersionstamp(revision),
        accounts: source
            .accounts
            .iter()
            .map(|account| {
                let id = account.identity();
                PoolAccount {
                    account_id_hash: id.routing_account_hash,
                    admin_account_hash: id.administrative_account_hash,
                    credential_version: id.credential_version,
                    enabled: true,
                }
            })
            .collect(),
    };
    store.inner.seed(keys::pool(), &pool);
    let authority = Authority::with_clock(store.clone(), store.tokens.clone(), store.clone());
    (store, authority)
}

#[test]
fn external_access_only_capacity_observation_needs_no_control_registration() {
    let (store, authority) = setup_access_pool(vec![external_source("a"), external_source("b")]);
    assert!(store.inner.row(&keys::paid_control_owner()).is_none());
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    let binding = fence.fetch_bindings().next().unwrap();
    assert_eq!(
        binding.native_owner().unwrap().generation_hash,
        binding.native_generation_hash()
    );
    run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 7.0)])).unwrap();
    assert!(store.inner.row(&keys::capacity()).is_some());
    assert!(store.inner.row(&keys::paid_control_owner()).is_none());
    assert!(store.inner.row(&keys::paid_routing()).is_none());
}

#[test]
fn external_access_only_owner_appearance_conflicts_at_capacity_commit() {
    let (store, authority) = setup_access_pool(vec![external_source("a")]);
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    store.inner.race(keys::paid_control_owner(), &owner());
    assert!(
        run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 7.0)])).is_err()
    );
    assert!(store.inner.row(&keys::capacity()).is_none());
    assert!(store.inner.row(&keys::routing()).is_none());
    assert!(store.inner.row(&keys::paid_control_owner()).is_some());
}

#[test]
fn external_access_only_absence_does_not_authorize_managed_unowned_or_mixed_pools() {
    use gateway_auth::provider_credentials::ManagedNativeSource;
    let mut managed = external_source("a");
    let native_generation = managed.identity().native_generation_hash;
    let native = managed.native_owner.as_mut().unwrap();
    native.external_user_id = None;
    native.managed_source = Some(ManagedNativeSource {
        v: 2,
        generation_hash: native_generation,
    });
    let mut refresh_owned = source_account("a", false);
    let mut owner = external_source("a").native_owner.unwrap();
    owner.external_user_id = None;
    owner.generation_hash = refresh_owned.identity().native_generation_hash;
    refresh_owned.native_owner = Some(owner);
    let mut unowned = external_source("a");
    unowned.native_owner = None;
    let mut wrong_generation = external_source("a");
    wrong_generation
        .native_owner
        .as_mut()
        .unwrap()
        .generation_hash = "0".repeat(64);
    for accounts in [
        vec![managed],
        vec![refresh_owned],
        vec![unowned],
        vec![wrong_generation],
        vec![source_account("a", false)],
        vec![external_source("a"), source_account("b", false)],
    ] {
        let (store, authority) = setup_access_pool(accounts);
        assert!(run(authority.begin_codex_capacity_observation(&[reference()])).is_err());
        assert!(store.inner.row(&keys::capacity()).is_none());
        assert!(store.inner.row(&keys::paid_control_owner()).is_none());
        assert!(store.inner.row(&keys::paid_routing()).is_none());
    }
}

#[test]
fn capture_rejects_unbound_account_duplicate_slot_and_missing_owner() {
    let (store, authority) = setup();
    for refs in [
        vec![reference(), reference()],
        vec![CodexCapacityAccountRef {
            source_slot: 0,
            ..reference()
        }],
        vec![CodexCapacityAccountRef {
            account_id: "b".into(),
            ..reference()
        }],
    ] {
        assert!(run(authority.begin_codex_capacity_observation(&refs)).is_err());
    }
    store
        .inner
        .seed(keys::paid_control_owner(), &json!({"v":0}));
    assert!(run(authority.begin_codex_capacity_observation(&[reference()])).is_err());
    assert!(store.inner.row(&keys::capacity()).is_none());
}
#[test]
fn each_original_source_revision_and_owner_fence_survives_sampling() {
    for changed_key in [
        codex_source_pool_key(),
        keys::pool(),
        keys::paid_control_owner(),
    ] {
        let (store, authority) = setup();
        let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
        let row = store.inner.row(&changed_key).unwrap();
        store.inner.seed(changed_key, &row.value);
        assert!(
            run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 100.0)]))
                .is_err()
        );
        assert!(store.inner.row(&keys::capacity()).is_none());
        assert!(store.inner.row(&keys::routing()).is_none());
    }
}
#[test]
fn credential_rotation_and_pool_reorder_cannot_rebind_in_flight_sample() {
    for reorder in [false, true] {
        let (store, authority) = setup();
        let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
        let mut next = pool();
        if reorder {
            next.accounts.reverse();
        } else {
            let id = source_account("a", true).identity();
            next.accounts[0].credential_version = id.credential_version;
        }
        next.pool_versionstamp.0 = "successor-pool".into();
        seed_pool(&store.inner, &next);
        assert!(
            run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 100.0)]))
                .is_err()
        );
        assert!(store.inner.row(&keys::capacity()).is_none());
    }
}
#[test]
fn original_capture_time_slot_and_account_are_checked_without_re_stamping() {
    let (store, authority) = setup();
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    for input in [
        sample(NOW + 1, 100.0),
        CodexCapacitySample {
            account: CodexCapacityAccountRef {
                source_slot: 2,
                account_id: "b".into(),
            },
            ..sample(NOW, 100.0)
        },
    ] {
        assert!(run(authority.record_codex_capacity_observations(&fence, &[input])).is_err());
    }
    store.inner.clock(NOW + 500);
    let receipt =
        run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 25.0)])).unwrap();
    assert_eq!(receipt.observed_at_ms(), NOW);
    let row = parse_capacity_store(&store.inner.row(&keys::capacity()).unwrap().value).unwrap();
    assert_eq!(row.updated_at_ms, NOW);
    assert_eq!(row.observations[0].snapshot_at_ms, NOW);
    assert_eq!(row.observations[0].source_observed_at_ms, Some(NOW));
}
#[test]
fn c_conflict_merges_fresh_destination_but_retains_original_source_fences() {
    let (store, authority) = setup();
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    let sibling = CapacityObservation {
        slot: 1,
        account_id_hash: routing_hash("b"),
        state: CapacityState::Available,
        source_observed_at_ms: Some(NOW),
        snapshot_at_ms: NOW,
        windows: CapacityWindows::default(),
        additional_rate_limits: vec![],
    };
    store.inner.race(
        keys::capacity(),
        &CapacityStore {
            v: 1,
            updated_at_ms: NOW,
            observations: vec![sibling.clone()],
        },
    );
    let receipt =
        run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 25.0)])).unwrap();
    assert_eq!(
        receipt.reconciliation(),
        &CapacityReconciliation::NoRoutingState
    );
    let c = parse_capacity_store(&store.inner.row(&keys::capacity()).unwrap().value).unwrap();
    assert_eq!(c.observations.len(), 2);
    assert_eq!(c.observations[1], sibling);
    assert!(
        store
            .writes
            .lock()
            .unwrap()
            .iter()
            .filter(|keys| !keys.is_empty())
            .all(|mutations| mutations == &[keys::capacity()])
    );
}
#[test]
fn c_survives_stopped_r_step_and_existing_event_retries_after_store_restart() {
    let (store, authority) = setup();
    run(authority.select_account(
        &"gpt-test".into(),
        gateway_core::provider::CodexQuotaClass::Standard,
        NOW,
    ))
    .unwrap();
    let original_r = store.inner.row(&keys::routing()).unwrap();
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    store.refuse_routing.store(true, Ordering::SeqCst);
    store.writes.lock().unwrap().clear();
    let receipt =
        run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 25.0)])).unwrap();
    assert!(matches!(
        receipt.reconciliation(),
        CapacityReconciliation::Pending { .. }
    ));
    assert_eq!(
        store.inner.row(&keys::routing()).unwrap().revision,
        original_r.revision
    );
    assert_eq!(
        store.inner.row(&keys::capacity()).unwrap().revision,
        receipt.capacity_revision()
    );
    let restarted = Authority::with_clock(store.clone(), store.tokens.clone(), store.clone());
    assert!(matches!(
        run(restarted.reconcile_codex_capacity_from_store(&fence)).unwrap(),
        CapacityReconciliation::Applied { changed_slots: 1 }
    ));
    let writes = store.writes.lock().unwrap();
    let mutations: Vec<_> = writes.iter().filter(|keys| !keys.is_empty()).collect();
    assert_eq!(
        mutations,
        vec![&vec![keys::capacity()], &vec![keys::routing()]]
    );
}
#[test]
fn accepted_c_is_not_rolled_back_or_applied_to_successor_r() {
    let (store, authority) = setup();
    run(authority.select_account(
        &"gpt-test".into(),
        gateway_core::provider::CodexQuotaClass::Standard,
        NOW,
    ))
    .unwrap();
    let r = store.inner.row(&keys::routing()).unwrap();
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    let mut successor = owner();
    successor.owner_epoch = "next-epoch".into();
    *store.after_capacity.lock().unwrap() = Some((
        keys::paid_control_owner(),
        serde_json::to_value(successor).unwrap(),
    ));
    let receipt =
        run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 25.0)])).unwrap();
    assert!(matches!(
        receipt.reconciliation(),
        CapacityReconciliation::Pending { .. }
    ));
    assert!(store.inner.row(&keys::capacity()).is_some());
    assert_eq!(
        store.inner.row(&keys::routing()).unwrap().revision,
        r.revision
    );
    assert!(run(authority.reconcile_codex_capacity_from_store(&fence)).is_err());
}
#[test]
fn unavailable_and_stale_samples_cannot_mint_quota_invalidity_reset_or_paid_authority() {
    for state in [CapacityState::Unavailable, CapacityState::Stale] {
        let (store, authority) = setup();
        let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
        run(authority.record_codex_capacity_observations(
            &fence,
            &[CodexCapacitySample {
                state,
                ..sample(NOW, 100.0)
            }],
        ))
        .unwrap();
        assert!(
            !run(authority.materialize_capacity_quota_blocks(
                &"gpt-test".into(),
                gateway_core::provider::CodexQuotaClass::Standard,
                NOW
            ))
            .unwrap()
        );
        let RouteSelection::Eligible(a) = run(authority.select_account(
            &"gpt-test".into(),
            gateway_core::provider::CodexQuotaClass::Standard,
            NOW,
        ))
        .unwrap() else {
            panic!("health sample became routing proof")
        };
        assert_eq!(a.binding.account_id_hash, routing_hash("a"));
        let r = parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
        assert!(r.slots[0].invalid_credential_version.is_none());
        assert!(r.slots[0].quota_blocks.is_empty());
        assert!(!r.slots[0].reset_identity_stable);
        assert!(store.inner.row(&keys::paid_routing()).is_none());
    }
}
#[test]
fn corrupt_destination_is_retained_and_never_reseeded() {
    let (store, authority) = setup();
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    store
        .inner
        .seed(keys::capacity(), &json!({"v":7,"observations":[]}));
    let before = store.inner.row(&keys::capacity()).unwrap();
    assert!(
        run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 25.0)])).is_err()
    );
    assert_eq!(store.inner.row(&keys::capacity()).unwrap(), before);
}
#[test]
fn raw_source_pool_corruption_is_not_repaired_by_producer_capture() {
    let (store, authority) = setup();
    let source = source_pool().private_source_value();
    store
        .inner
        .seed(codex_source_pool_key(), &json!({"accounts":"invalid"}));
    let before = store.inner.row(&codex_source_pool_key()).unwrap();
    assert!(run(authority.begin_codex_capacity_observation(&[reference()])).is_err());
    assert_eq!(store.inner.row(&codex_source_pool_key()).unwrap(), before);
    assert_ne!(before.value, source);
}

#[test]
fn fetch_binding_exposes_only_original_fixed_roster_identity() {
    let (_, authority) = setup();
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    let binding = fence.fetch_bindings().next().unwrap();
    let identity = source_account("a", false).identity();
    assert_eq!(binding.source_slot(), 1);
    assert_eq!(binding.account_id(), "a");
    assert_eq!(binding.credential_version(), &identity.credential_version);
    assert_eq!(
        binding.native_generation_hash(),
        identity.native_generation_hash
    );
    assert!(binding.native_owner().is_none());
}

#[test]
fn capacity_materialization_reconciles_a_newer_sample_over_stale_ambiguous_reset() {
    let (store, authority) = setup();
    run(authority.select_account(
        &"gpt-test".into(),
        gateway_core::provider::CodexQuotaClass::Standard,
        NOW,
    ))
    .unwrap();
    let mut state = parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
    state.slots[0].retained_reset_at_ms = Some(NOW + 30_000);
    state.slots[0].reset_identity_stable = true;
    state.slots[0].reset_identity_ambiguous = true;
    state.slots[0].generation = 3;
    store.inner.seed(keys::routing(), &state);
    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 100.0)])).unwrap();
    store.inner.clock(NOW + 1000);
    assert!(
        run(authority.materialize_capacity_quota_blocks(
            &"gpt-test".into(),
            gateway_core::provider::CodexQuotaClass::Standard,
            NOW + 1000
        ))
        .unwrap()
    );
    let state = parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
    let block = state.slots[0]
        .quota_block_for(gateway_core::provider::CodexQuotaClass::Standard)
        .unwrap();
    assert!(!block.reset_ambiguous);
    assert!(block.reset_is_stable);
    assert_eq!(block.reset_at_ms, Some(NOW + 60_000));
    assert_eq!(block.blocked_until_ms, NOW + 60_000);
    assert_eq!(block.observed_at_ms, Some(NOW));
    assert!(!state.slots[0].reset_identity_ambiguous);
    assert_eq!(
        parse_capacity_store(&store.inner.row(&keys::capacity()).unwrap().value)
            .unwrap()
            .updated_at_ms,
        NOW
    );
}

#[test]
fn capacity_materialization_cannot_replace_a_newer_live_quota_signal() {
    use gateway_core::provider::CodexQuotaClass;
    let (store, authority) = setup();
    run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap();
    let mut state = parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
    let prior = QuotaBlock {
        blocked_until_ms: NOW + 30_000,
        source: QuotaBlockSource::BodyResetsAt,
        legacy_fallback: false,
        observed_at_ms: Some(NOW + 10),
        reset_at_ms: Some(NOW + 30_000),
        reset_is_stable: true,
        reset_ambiguous: false,
        recovery_pending: false,
    };
    state.slots[0]
        .quota_blocks
        .insert("standard".into(), prior.clone());
    state.slots[0].quota_blocked_until_ms = Some(prior.blocked_until_ms);
    state.slots[0].quota_block_source = Some(prior.source);
    state.slots[0].quota_blocked_classes = vec!["standard".into()];
    state.slots[0].retained_reset_at_ms = prior.reset_at_ms;
    state.slots[0].reset_identity_stable = true;
    store.inner.seed(keys::routing(), &state);

    let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
    run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 100.0)])).unwrap();
    assert!(
        !run(authority.materialize_capacity_quota_blocks(
            &"gpt-test".into(),
            CodexQuotaClass::Standard,
            NOW + 1000
        ))
        .unwrap()
    );
    let state = parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
    assert_eq!(
        state.slots[0].quota_block_for(CodexQuotaClass::Standard),
        Some(prior)
    );
}

#[test]
fn capacity_materialization_refuses_owned_probe_and_preserves_foreign_class_lease() {
    use gateway_core::provider::CodexQuotaClass;
    for class in [CodexQuotaClass::Standard, CodexQuotaClass::Spark] {
        let (store, authority) = setup();
        run(authority.select_account(&"gpt-test".into(), CodexQuotaClass::Standard, NOW)).unwrap();
        let mut state =
            parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
        let lease = ProbeLease {
            token: "original-probe".into(),
            generation: 2,
            circuit: ProbeCircuit::Quota,
            quota_class: Some(class),
            expires_at_ms: NOW + 20_000,
        };
        state.slots[0].generation = 2;
        state.slots[0].probe_lease = Some(lease.clone());
        store.inner.seed(keys::routing(), &state);
        let fence = run(authority.begin_codex_capacity_observation(&[reference()])).unwrap();
        run(authority.record_codex_capacity_observations(&fence, &[sample(NOW, 100.0)])).unwrap();
        assert_eq!(
            run(authority.materialize_capacity_quota_blocks(
                &"gpt-test".into(),
                CodexQuotaClass::Standard,
                NOW
            ))
            .unwrap(),
            class == CodexQuotaClass::Spark
        );
        let state = parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
        assert_eq!(state.slots[0].generation, 2);
        assert_eq!(state.slots[0].probe_lease, Some(lease));
    }
}
