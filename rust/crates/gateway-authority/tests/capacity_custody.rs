mod support;
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
use support::*;

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
        "gpt-test",
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
        "gpt-test",
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
                "gpt-test",
                gateway_core::provider::CodexQuotaClass::Standard,
                NOW
            ))
            .unwrap()
        );
        let RouteSelection::Eligible(a) = run(authority.select_account(
            "gpt-test",
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
fn capacity_materialization_keeps_stable_ambiguous_reset_lookup_only() {
    let (store, authority) = setup();
    run(authority.select_account(
        "gpt-test",
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
            "gpt-test",
            gateway_core::provider::CodexQuotaClass::Standard,
            NOW + 1000
        ))
        .unwrap()
    );
    let state = parse_routing_state(&store.inner.row(&keys::routing()).unwrap().value).unwrap();
    let block = state.slots[0]
        .quota_block_for(gateway_core::provider::CodexQuotaClass::Standard)
        .unwrap();
    assert!(block.reset_ambiguous);
    assert_eq!(block.reset_at_ms, Some(NOW + 30_000));
    assert_eq!(block.blocked_until_ms, NOW + 60_000);
    assert_eq!(block.observed_at_ms, Some(NOW + 1000));
    assert!(state.slots[0].reset_identity_ambiguous);
    assert_eq!(
        parse_capacity_store(&store.inner.row(&keys::capacity()).unwrap().value)
            .unwrap()
            .updated_at_ms,
        NOW
    );
}

#[test]
fn capacity_materialization_refuses_owned_probe_and_preserves_foreign_class_lease() {
    use gateway_core::provider::CodexQuotaClass;
    for class in [CodexQuotaClass::Standard, CodexQuotaClass::Spark] {
        let (store, authority) = setup();
        run(authority.select_account("gpt-test", CodexQuotaClass::Standard, NOW)).unwrap();
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
                "gpt-test",
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
