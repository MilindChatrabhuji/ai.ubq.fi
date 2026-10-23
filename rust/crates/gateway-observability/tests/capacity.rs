mod support;
use gateway_auth::{
    crypto::Secret,
    provider_credentials::{CodexSourceAccount, CodexSourcePool, codex_source_pool_key},
};
use gateway_authority::{
    Authority, AuthorityClock, TokenSource,
    capacity::*,
    keys,
    paid_control::PaidControlOwner,
    routing::{PoolAccount, SubscriptionPool, parse_capacity_store},
};
use gateway_core::{GatewayError, identity::PoolVersionstamp, state::StoredRecord};
use gateway_observability::{ObservabilityRuntime, host_types::*, types::ObservabilityHost};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
};
use support::{Host, Memory, run};
#[derive(Clone)]
struct Clock(Arc<AtomicI64>);
impl AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(self.0.load(Ordering::SeqCst))
    }
}
#[derive(Clone)]
struct Tokens(Host);
impl TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        gateway_auth::crypto::uuid_from_random(&self.0.random_bytes(16)?)
    }
}
struct CapacityHost {
    base: Host,
    memory: Memory,
    clock: Clock,
    stage: Rc<Cell<u8>>,
    change_owner: bool,
}
impl CapacityHost {
    fn authority(&self) -> Authority<Memory, Tokens> {
        Authority::with_clock(
            self.memory.clone(),
            Tokens(self.base.clone()),
            self.clock.clone(),
        )
    }
}
impl ObservabilityHost for CapacityHost {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        self.base.source_string_collator()
    }
    fn now_ms(&self) -> i64 {
        self.clock.0.load(Ordering::SeqCst)
    }
    fn random_bytes(&self, n: usize) -> Result<Vec<u8>, GatewayError> {
        self.base.random_bytes(n)
    }
    fn compare_labels(&self, a: &str, b: &str) -> Result<std::cmp::Ordering, GatewayError> {
        Ok(a.cmp(b))
    }
    async fn wait_ms(&self, n: u32) -> Result<(), GatewayError> {
        self.clock.0.fetch_add(i64::from(n), Ordering::SeqCst);
        Ok(())
    }
    async fn codex_capacity_accounts(&self) -> Result<Vec<CapacityAccountRef>, GatewayError> {
        Ok(vec![CapacityAccountRef {
            slot: 1,
            account_id: "fixture-account".into(),
            label: None,
        }])
    }
    async fn begin_codex_capacity_observation(
        &self,
        accounts: &[CapacityAccountRef],
    ) -> Result<CodexCapacityObservationFence, GatewayError> {
        assert_eq!(self.stage.replace(1), 0);
        let refs: Vec<_> = accounts
            .iter()
            .map(|a| CodexCapacityAccountRef {
                source_slot: a.slot,
                account_id: a.account_id.clone(),
            })
            .collect();
        self.authority()
            .begin_codex_capacity_observation(&refs)
            .await
    }
    async fn probe_codex_capacity(
        &self,
        account: &CapacityAccountRef,
        fence: &CodexCapacityObservationFence,
        deadline: i64,
    ) -> Result<CapacityProbe, GatewayError> {
        assert_eq!(self.stage.replace(2), 1);
        let binding = fence.fetch_bindings().next().unwrap();
        assert_eq!(binding.account_id(), account.account_id);
        assert_eq!(binding.source_slot(), 1);
        assert_eq!(deadline, fence.observed_at_ms() + 8000);
        if self.change_owner {
            let row = self.memory.rows.borrow()[&keys::paid_control_owner().0].clone();
            self.memory.rows.borrow_mut().insert(
                keys::paid_control_owner().0,
                StoredRecord::json("successor-owner", row.json_value()?.clone(), None),
            );
        }
        self.clock.0.fetch_add(123, Ordering::SeqCst);
        Ok(CapacityProbe::Http {
            status: 200,
            json: Some(
                json!({"rate_limit":{"primary_window":{"limit_window_seconds":300,"used_percent":25,"reset_at":60},"secondary_window":null}}),
            ),
        })
    }
    async fn metered_quota_snapshot(
        &self,
        _force: bool,
        _deadline: i64,
    ) -> Result<Option<Value>, GatewayError> {
        Ok(None)
    }
    async fn accept_capacity_observations(
        &self,
        fence: &CodexCapacityObservationFence,
        samples: &[CodexCapacitySample],
    ) -> Result<AcceptedCodexCapacityObservations, GatewayError> {
        assert_eq!(self.stage.replace(3), 2);
        assert_eq!(samples[0].snapshot_at_ms, fence.observed_at_ms());
        assert_eq!(
            samples[0].source_observed_at_ms,
            Some(fence.observed_at_ms())
        );
        self.authority()
            .record_codex_capacity_observations(fence, samples)
            .await
    }
}
fn setup(change_owner: bool) -> (Memory, ObservabilityRuntime<Memory, CapacityHost>) {
    let memory = Memory::default();
    let source = CodexSourceAccount {
        account_id: "fixture-account".into(),
        access_token: Secret::new("fixture-access".into()),
        refresh_token: Secret::new("fixture-refresh".into()),
        updated_at_ms: 1000.0,
        native_owner: None,
    };
    let id = source.identity();
    let pool = CodexSourcePool {
        accounts: vec![source],
        updated_at_ms: 1000.0,
    };
    memory.rows.borrow_mut().insert(
        codex_source_pool_key().0,
        StoredRecord::json("source-pool", pool.private_source_value(), None),
    );
    let normalized = SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp("source-pool".into()),
        accounts: vec![PoolAccount {
            account_id_hash: id.routing_account_hash,
            admin_account_hash: id.administrative_account_hash,
            credential_version: id.credential_version,
            enabled: true,
        }],
    };
    memory.rows.borrow_mut().insert(
        keys::pool().0,
        StoredRecord::json(
            "normalized-pool",
            serde_json::to_value(normalized).unwrap(),
            None,
        ),
    );
    memory.rows.borrow_mut().insert(
        keys::paid_control_owner().0,
        StoredRecord::json(
            "registered-owner",
            serde_json::to_value(PaidControlOwner {
                v: 1,
                owner_id: "fixture-owner".into(),
                owner_epoch: "fixture-epoch".into(),
                key_fingerprint: "fixture-owner-fingerprint".into(),
            })
            .unwrap(),
            None,
        ),
    );
    let host = CapacityHost {
        base: Host::default(),
        memory: memory.clone(),
        clock: Clock(Arc::new(AtomicI64::new(1000))),
        stage: Rc::new(Cell::new(0)),
        change_owner,
    };
    let runtime = ObservabilityRuntime::new(memory.clone(), host);
    (memory, runtime)
}
#[test]
fn actual_authority_fence_precedes_get_and_original_time_reaches_c_and_history() {
    let (memory, runtime) = setup(false);
    assert!(run(runtime.sample_capacity_on_event()).unwrap());
    assert_eq!(runtime.host().stage.get(), 3);
    let value = memory.rows.borrow()[&keys::capacity().0]
        .json_value()
        .unwrap()
        .clone();
    let c = parse_capacity_store(&value).unwrap();
    assert_eq!(c.observations[0].slot, 0);
    assert_eq!(c.observations[0].snapshot_at_ms, 1000);
    assert_eq!(c.observations[0].source_observed_at_ms, Some(1000));
    assert_eq!(
        c.observations[0]
            .windows
            .primary
            .as_ref()
            .unwrap()
            .used_percent,
        Some(25.0)
    );
    let history = run(runtime.capacity_history(1123)).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["sampled_at_ms"], 1000);
    assert!(!memory.rows.borrow().contains_key(&keys::routing().0));
}
#[test]
fn source_rotation_during_get_cannot_publish_a_successor_capacity_or_history() {
    let (memory, runtime) = setup(true);
    let error = run(runtime.sample_capacity_on_event()).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("codex_capacity_source_changed")
    );
    assert_eq!(runtime.host().stage.get(), 3);
    assert!(!memory.rows.borrow().contains_key(&keys::capacity().0));
    assert!(run(runtime.capacity_history(1123)).unwrap().is_empty());
    assert!(!memory.rows.borrow().contains_key(&keys::routing().0));
}
