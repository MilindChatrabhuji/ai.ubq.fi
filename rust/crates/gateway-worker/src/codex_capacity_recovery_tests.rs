use super::*;
#[path = "../../gateway-observability/tests/support/mod.rs"]
mod support;
use gateway_auth::{
    crypto::{Secret, base64url},
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, CodexSourcePool, codex_source_pool_key,
    },
};
use gateway_authority::{
    AuthorityClock, capacity::*, keys, paid_control::PaidControlOwner, routing::*,
};
use gateway_core::{identity::PoolVersionstamp, provider::CodexQuotaClass, state::StoredRecord};
use gateway_observability::host_types::*;
use serde_json::{Value, json};
use std::cell::Cell;
use support::{Host, Memory, run};
const NOW: i64 = 1_800_000_000_000;
#[derive(Clone)]
struct Clock(i64);
impl AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(self.0)
    }
}
#[derive(Clone)]
struct Tokens(Host);
impl TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        gateway_auth::crypto::uuid_from_random(&self.0.random_bytes(16)?)
    }
}
#[derive(Clone, Copy)]
enum Scenario {
    Positive,
    Exhausted,
    Network,
    Invalid,
    Revoked,
    Rotated,
    Epoch,
    OwnerAppears,
}
struct Probe {
    base: Host,
    memory: Memory,
    calls: Cell<usize>,
    accepted: Cell<usize>,
    revoked: Cell<bool>,
    scenario: Scenario,
}
impl Probe {
    fn authority(&self) -> Authority<Memory, Tokens> {
        Authority::with_clock(
            self.memory.clone(),
            Tokens(self.base.clone()),
            Clock(self.base.now_ms()),
        )
    }
    async fn check(&self) -> Result<(), GatewayError> {
        if self.revoked.get() {
            Err(GatewayError::new(
                401,
                "Revoked original",
                Some("unauthorized"),
            ))
        } else {
            Ok(())
        }
    }
}
impl ObservabilityHost for Probe {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        self.base.source_string_collator()
    }
    fn now_ms(&self) -> i64 {
        self.base.now_ms()
    }
    fn random_bytes(&self, n: usize) -> Result<Vec<u8>, GatewayError> {
        self.base.random_bytes(n)
    }
    async fn wait_ms(&self, n: u32) -> Result<(), GatewayError> {
        self.base.wait_ms(n).await
    }
    async fn begin_codex_capacity_observation(
        &self,
        accounts: &[CapacityAccountRef],
    ) -> Result<CodexCapacityObservationFence, GatewayError> {
        let refs = accounts
            .iter()
            .map(|a| CodexCapacityAccountRef {
                source_slot: a.slot,
                account_id: a.account_id.clone(),
            })
            .collect::<Vec<_>>();
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
        self.calls.set(self.calls.get() + 1);
        assert_eq!(account.slot, 1);
        assert_eq!(account.account_id, "fixture-account");
        let binding = fence.fetch_bindings().next().unwrap();
        assert_eq!(binding.account_id(), account.account_id);
        let owner = binding.native_owner().unwrap();
        assert_eq!(owner.external_user_id.as_deref(), Some("fixture-user"));
        assert_eq!(owner.generation_hash, binding.native_generation_hash());
        assert_eq!(deadline, fence.observed_at_ms() + 8000);
        self.base.at.set(self.now_ms() + 17);
        match self.scenario {
            Scenario::Network => return Ok(CapacityProbe::Unreachable),
            Scenario::Invalid => {
                return Ok(CapacityProbe::Http {
                    status: 200,
                    json: Some(json!({"rate_limit": "not-windows"})),
                });
            }
            Scenario::Revoked => self.revoked.set(true),
            Scenario::Rotated => {
                let row = self.memory.rows.borrow()[&codex_source_pool_key().0].clone();
                self.memory.rows.borrow_mut().insert(
                    codex_source_pool_key().0,
                    StoredRecord::json("rotated", row.json_value()?.clone(), None),
                );
            }
            Scenario::Epoch => {
                let row = self.memory.rows.borrow()[&keys::paid_control_owner().0].clone();
                self.memory.rows.borrow_mut().insert(
                    keys::paid_control_owner().0,
                    StoredRecord::json("successor-epoch", row.json_value()?.clone(), None),
                );
            }
            Scenario::OwnerAppears => seed_owner(&self.memory),
            Scenario::Positive | Scenario::Exhausted => {}
        }
        Ok(CapacityProbe::Http {
            status: 200,
            json: Some(
                json!({"rate_limit": {"primary_window": {"limit_window_seconds": 18000, "used_percent": if matches!(self.scenario, Scenario::Exhausted) { 100 } else { 93 }, "reset_at": (NOW + 3_600_000) / 1000}, "secondary_window": null}}),
            ),
        })
    }
    async fn accept_capacity_observations(
        &self,
        fence: &CodexCapacityObservationFence,
        samples: &[CodexCapacitySample],
    ) -> Result<AcceptedCodexCapacityObservations, GatewayError> {
        self.accepted.set(self.accepted.get() + 1);
        self.authority()
            .record_codex_capacity_observations(fence, samples)
            .await
    }
    // These pre-existing ports must never participate in inference recovery.
    async fn metered_quota_snapshot(&self, _: bool, _: i64) -> Result<Option<Value>, GatewayError> {
        panic!("paid/monitoring call")
    }
    async fn codex_reset_credits(
        &self,
        _: &CapacityAccountRef,
        _: i64,
    ) -> Result<Option<Vec<ResetCreditDiagnostic>>, GatewayError> {
        panic!("reset inventory call")
    }
    async fn codex_reset_available_count(
        &self,
        _: &CapacityAccountRef,
        _: i64,
    ) -> Result<Option<i64>, GatewayError> {
        panic!("reset count call")
    }
}
fn seed(memory: &Memory, key: gateway_core::state::RecordKey, revision: &str, value: Value) {
    memory
        .rows
        .borrow_mut()
        .insert(key.0, StoredRecord::json(revision, value, None));
}
fn seed_owner(memory: &Memory) {
    seed(
        memory,
        keys::paid_control_owner(),
        "owner-r1",
        serde_json::to_value(PaidControlOwner {
            v: 1,
            owner_id: "owner".into(),
            owner_epoch: "epoch".into(),
            key_fingerprint: "fingerprint".into(),
        })
        .unwrap(),
    );
}
fn setup(scenario: Scenario) -> (Probe, CohortProof, ModelId, Value) {
    let memory = Memory::default();
    // The real local route carries access-only external native ownership. None
    // of these cases has refresh material or a native renewal capability.
    let access = format!(
        "e30.{}.synthetic",
        base64url(
            json!({"exp":(NOW + 3_600_000) / 1000,"https://api.openai.com/auth":{"chatgpt_user_id":"fixture-user","chatgpt_account_id":"fixture-account"}})
                .to_string()
                .as_bytes()
        )
    );
    let mut source = CodexSourceAccount {
        account_id: "fixture-account".into(),
        access_token: Secret::new(access),
        refresh_token: Secret::new(String::new()),
        updated_at_ms: NOW as f64,
        native_owner: None,
    };
    let id = source.identity();
    source.native_owner = Some(CodexNativeOwner {
        codex_home: "/tmp/synthetic-capacity-owner".into(),
        generation_hash: id.native_generation_hash.clone(),
        native_refreshed_at: None,
        external_user_id: Some("fixture-user".into()),
        managed_source: None,
    });
    let pool = CodexSourcePool {
        accounts: vec![source],
        updated_at_ms: NOW as f64,
    };
    seed(
        &memory,
        codex_source_pool_key(),
        "source-pool",
        pool.private_source_value(),
    );
    seed(
        &memory,
        keys::pool(),
        "normalized-pool",
        serde_json::to_value(SubscriptionPool {
            v: 1,
            pool_versionstamp: PoolVersionstamp("source-pool".into()),
            accounts: vec![PoolAccount {
                account_id_hash: id.routing_account_hash.clone(),
                admin_account_hash: id.administrative_account_hash,
                credential_version: id.credential_version,
                enabled: true,
            }],
        })
        .unwrap(),
    );
    if matches!(scenario, Scenario::Epoch) {
        seed_owner(&memory);
    }
    let base = Host::default();
    base.at.set(NOW);
    let probe = Probe {
        base,
        memory,
        calls: Cell::new(0),
        accepted: Cell::new(0),
        revoked: Cell::new(false),
        scenario,
    };
    let authority = probe.authority();
    let model = ModelId::from("gpt-6.1-sol");
    let RouteSelection::Eligible(admission) =
        run(authority.select_account(&model, CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("bootstrap")
    };
    assert!(
        run(authority.record_quota_block(
            &admission,
            QuotaBlock {
                blocked_until_ms: NOW + 3_600_000,
                source: QuotaBlockSource::BodyResetsAt,
                legacy_fallback: false,
                observed_at_ms: Some(NOW - 3_000_000),
                reset_at_ms: Some(NOW + 3_600_000),
                reset_is_stable: true,
                reset_ambiguous: false,
                recovery_pending: false
            },
            NOW
        ))
        .unwrap()
    );
    // Positive but expired. Its timestamp and original standard block stay truthful.
    let old = json!({"v":1,"updated_at_ms":NOW-1_800_001,"observations":[{"slot":0,"account_id_hash":id.routing_account_hash,"state":"available","source_observed_at_ms":NOW-1_800_001,"snapshot_at_ms":NOW-1_800_001,"windows":{"primary":{"limit_window_seconds":18000,"used_percent":93,"reset_at_ms":NOW+3_600_000},"secondary":null},"additional_rate_limits":[]}]});
    seed(&probe.memory, keys::capacity(), "old-capacity", old.clone());
    let RouteSelection::QuotaBlocked { proof, .. } =
        run(authority.select_account(&model, CodexQuotaClass::Standard, NOW)).unwrap()
    else {
        panic!("old observation must not bypass block")
    };
    assert!(proof.full_cohort_exhausted());
    (probe, proof, model, old)
}
fn invoke(
    probe: &Probe,
    proof: &CohortProof,
    model: &ModelId,
) -> Result<Option<RouteSelection>, GatewayError> {
    run(observe(
        &probe.memory,
        &probe.authority(),
        probe,
        proof,
        model,
        || probe.check(),
    ))
}
#[test]
fn access_only_stale_positive_requires_genuine_new_sample_then_ordinary_reselection() {
    let (probe, proof, model, _) = setup(Scenario::Positive);
    assert!(
        !probe
            .memory
            .rows
            .borrow()
            .contains_key(&keys::paid_control_owner().0)
    );
    let mut expected_active = probe.memory.rows.borrow()[&keys::active().0]
        .json_value()
        .unwrap()
        .clone();
    let Some(RouteSelection::Eligible(account)) = invoke(&probe, &proof, &model).unwrap() else {
        panic!("new capacity permits normal selection")
    };
    assert_eq!(
        account.binding.account_id_hash,
        proof.account_bindings()[0].account_id_hash
    );
    assert_eq!(probe.calls.get(), 1);
    assert_eq!(probe.accepted.get(), 1);
    let value = probe.memory.rows.borrow()[&keys::capacity().0]
        .json_value()
        .unwrap()
        .clone();
    let c = parse_capacity_store(&value).unwrap();
    assert_eq!(c.observations[0].source_observed_at_ms, Some(NOW));
    assert_eq!(c.observations[0].snapshot_at_ms, NOW);
    // Ordinary selection retains the active account and election generation,
    // while syncing its binding to the routing state advanced by the quota block.
    expected_active["routing_generation"] =
        json!(expected_active["routing_generation"].as_u64().unwrap() + 1);
    expected_active["updated_at_ms"] = json!(NOW + 17);
    assert_eq!(
        probe.memory.rows.borrow()[&keys::active().0]
            .json_value()
            .unwrap(),
        &expected_active
    );
    assert!(
        !probe
            .memory
            .rows
            .borrow()
            .contains_key(&keys::paid_control_owner().0)
    );
}
#[test]
fn network_or_invalid_sample_cannot_restamp_capacity_or_manufacture_exhaustion() {
    for scenario in [Scenario::Network, Scenario::Invalid] {
        let (probe, proof, model, old) = setup(scenario);
        assert!(invoke(&probe, &proof, &model).unwrap().is_none());
        assert_eq!(probe.calls.get(), 1);
        assert_eq!(probe.accepted.get(), 0);
        assert_eq!(
            probe.memory.rows.borrow()[&keys::capacity().0]
                .json_value()
                .unwrap(),
            &old
        );
    }
}
#[test]
fn genuine_exhaustion_returns_new_full_cohort_proof_without_reset_or_paid_effect() {
    let (probe, proof, model, _) = setup(Scenario::Exhausted);
    let Some(RouteSelection::QuotaBlocked { proof: fresh, .. }) =
        invoke(&probe, &proof, &model).unwrap()
    else {
        panic!("real exhausted sample must remain blocked")
    };
    assert!(fresh.full_cohort_exhausted());
    assert!(fresh.full_cohort_unavailable());
    assert_eq!(probe.calls.get(), 1);
    assert_eq!(probe.accepted.get(), 1);
    assert!(
        !probe
            .memory
            .rows
            .borrow()
            .keys()
            .any(|key| key.contains("banked_reset") || key.contains("paid_attempt"))
    );
}
#[test]
fn genuine_exhaustion_reconciles_a_retained_ambiguous_block_before_reselection() {
    let (probe, proof, model, _) = setup(Scenario::Exhausted);
    let mut state = parse_routing_state(
        probe.memory.rows.borrow()[&keys::routing().0]
            .json_value()
            .unwrap(),
    )
    .unwrap();
    let stale = state.slots[0]
        .quota_blocks
        .get_mut("standard")
        .expect("setup block");
    stale.blocked_until_ms = NOW + 30_000;
    stale.observed_at_ms = Some(NOW - 3_000_000);
    stale.reset_at_ms = Some(NOW + 30_000);
    stale.reset_is_stable = true;
    stale.reset_ambiguous = true;
    state.slots[0].quota_blocked_until_ms = Some(NOW + 30_000);
    state.slots[0].retained_reset_at_ms = Some(NOW + 30_000);
    state.slots[0].reset_identity_stable = true;
    state.slots[0].reset_identity_ambiguous = true;
    seed(
        &probe.memory,
        keys::routing(),
        "stale-routing",
        serde_json::to_value(state).unwrap(),
    );

    let Some(RouteSelection::QuotaBlocked { proof: fresh, .. }) =
        invoke(&probe, &proof, &model).unwrap()
    else {
        panic!("real exhausted sample must remain blocked")
    };
    assert!(fresh.full_cohort_exhausted());
    let state = parse_routing_state(
        probe.memory.rows.borrow()[&keys::routing().0]
            .json_value()
            .unwrap(),
    )
    .unwrap();
    let block = state.slots[0]
        .quota_block_for(CodexQuotaClass::Standard)
        .expect("materialized block");
    assert!(!block.reset_ambiguous);
    assert!(block.reset_is_stable);
    assert_eq!(block.blocked_until_ms, NOW + 3_600_000);
    assert_eq!(block.reset_at_ms, Some(NOW + 3_600_000));
    assert_eq!(block.observed_at_ms, Some(NOW));
}

#[test]
fn revocation_during_get_prevents_publication_and_reselection() {
    let (probe, proof, model, old) = setup(Scenario::Revoked);
    assert_eq!(invoke(&probe, &proof, &model).unwrap_err().status, 401);
    assert_eq!(probe.accepted.get(), 0);
    assert_eq!(
        probe.memory.rows.borrow()[&keys::capacity().0]
            .json_value()
            .unwrap(),
        &old
    );
}
#[test]
fn source_revision_or_owner_epoch_race_cannot_publish_successor_capacity() {
    for scenario in [Scenario::Rotated, Scenario::Epoch, Scenario::OwnerAppears] {
        let (probe, proof, model, old) = setup(scenario);
        assert_eq!(
            invoke(&probe, &proof, &model)
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("codex_capacity_source_changed")
        );
        assert_eq!(
            probe.memory.rows.borrow()[&keys::capacity().0]
                .json_value()
                .unwrap(),
            &old
        );
    }
}
