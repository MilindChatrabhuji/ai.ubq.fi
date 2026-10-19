//! Controlled finite host callbacks validate durable orchestration, not live provider acceptance.
pub mod support;
use gateway_auth::{
    crypto::Secret,
    provider_credentials::{codex_source_pool_key, parse_codex_source_pool},
};
use gateway_authority::cache_experiment::{
    CacheDispatch, ExperimentIo, ReadSample, RefreshPermit, Sample, TargetBinding, Usage,
    model::STEPS,
};
use gateway_authority::routing::{PoolAccount, SubscriptionPool};
use gateway_core::{
    GatewayError,
    identity::PoolVersionstamp,
    tuple_key::{ScalarKeyPart::String as Text, TupleKey},
};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use support::{MemoryStore, TestAuthority, authority, run};
fn key(parts: &[&str]) -> gateway_core::state::RecordKey {
    TupleKey::from_scalar_parts(&parts.iter().map(|s| Text(s)).collect::<Vec<_>>()).to_record_key()
}
fn experiment_key(kind: &str, target: &TargetBinding) -> gateway_core::state::RecordKey {
    key(&[
        "uos_ai",
        "prompt_cache_scope_experiment",
        "v5",
        kind,
        &target.provider,
        &target.telemetry_provider,
        &target.topology_kind,
        &target.probe_profile,
        &target.model,
    ])
}
fn source_fixture() -> Value {
    serde_json::from_str(include_str!(
        "fixtures/cache-experiment-inventory-source-v2.json"
    ))
    .unwrap()
}
fn seed_source(store: &MemoryStore, value: &Value, revision: &str) {
    let source = parse_codex_source_pool(value).unwrap().unwrap();
    let pool = SubscriptionPool {
        v: 1,
        pool_versionstamp: PoolVersionstamp(revision.into()),
        accounts: source
            .accounts
            .iter()
            .map(|a| {
                let identity = a.identity();
                PoolAccount {
                    account_id_hash: identity.routing_account_hash,
                    admin_account_hash: identity.administrative_account_hash,
                    credential_version: identity.credential_version,
                    enabled: true,
                }
            })
            .collect(),
    };
    store.seed_with_revision(codex_source_pool_key(), value, revision);
    store.seed(gateway_authority::keys::pool(), &pool);
}
fn setup() -> (MemoryStore, TestAuthority, i64) {
    let fixture = source_fixture();
    let now = fixture["now"].as_i64().unwrap();
    let store = MemoryStore::default();
    store.clock(now);
    store.seed_with_revision(
        key(&["ubq_ai", "codex_models"]),
        &fixture["input"]["snapshot"],
        "catalog-1",
    );
    store.seed_with_revision(
        key(&["uos_ai", "runtime_config", "v2"]),
        &fixture["runtime"],
        "runtime-1",
    );
    seed_source(&store, &fixture["input"]["codexAuthPool"], "pool-1");
    let authority = authority(&store);
    (store, authority, now)
}
struct Io {
    store: MemoryStore,
    calls: RefCell<Vec<(u8, String, String)>>,
    nonce: Cell<u64>,
    refreshes: Cell<u64>,
    unchanged: bool,
    rotate_on_first: bool,
    discards: Cell<u32>,
    steal_cycle_on_first: Option<(gateway_core::state::RecordKey, i64)>,
    quota_on_first: bool,
    fail_recovery_probe: bool,
    refresh_error_after_rotation: Option<bool>,
    shrink_on_refresh: bool,
    rotate_after_publication: bool,
}
impl Io {
    fn new(store: &MemoryStore) -> Self {
        Self {
            store: store.clone(),
            calls: RefCell::new(vec![]),
            nonce: Cell::new(0),
            refreshes: Cell::new(0),
            unchanged: false,
            rotate_on_first: false,
            discards: Cell::new(0),
            steal_cycle_on_first: None,
            quota_on_first: false,
            fail_recovery_probe: false,
            refresh_error_after_rotation: None,
            shrink_on_refresh: false,
            rotate_after_publication: false,
        }
    }
}
impl ExperimentIo for Io {
    type Response = Sample;
    fn release_git_sha(&self) -> &str {
        "1111111111111111111111111111111111111111"
    }
    fn uuid(&self) -> Result<String, GatewayError> {
        let n = self.nonce.get() + 1;
        self.nonce.set(n);
        Ok(format!("00000000-0000-4000-8000-{n:012}"))
    }
    fn begin_cycle(&self, _deadline: i64) -> Result<(), GatewayError> {
        Ok(())
    }
    async fn fetch(
        &self,
        dispatch: &CacheDispatch,
        body: &str,
        conversation: &str,
        _client: Option<&str>,
        _deadline: i64,
    ) -> Result<Sample, GatewayError> {
        let index = self.calls.borrow().len() % 10;
        self.calls
            .borrow_mut()
            .push((dispatch.slot(), body.into(), conversation.into()));
        if self.fail_recovery_probe {
            let routing: gateway_authority::routing::RoutingState = serde_json::from_value(
                self.store
                    .row(&gateway_authority::keys::routing())
                    .unwrap()
                    .value,
            )
            .unwrap();
            assert_eq!(dispatch.binding().routing_generation, 7);
            assert_eq!(routing.slots[0].generation, 7);
            assert_eq!(routing.slots[0].probe_lease.as_ref().unwrap().generation, 7);
            return Err(gateway_authority::cache_experiment::model::failed(
                "Controlled failed recovery probe.",
            ));
        }
        let write = index == 0 || index == 2;
        let usage = Usage {
            input_tokens: 2560,
            cached_tokens: if write { 0 } else { 2560 },
            cache_write_tokens: if write { 2560 } else { 0 },
            output_tokens: 12,
            total_tokens: 2572,
        };
        if self.rotate_on_first && self.calls.borrow().len() == 1 {
            let mut source = self.store.row(&codex_source_pool_key()).unwrap().value;
            source["accounts"][1]["access_token"] = json!("fixture-concurrent-rotation");
            seed_source(&self.store, &source, "pool-concurrent");
        }
        if self.calls.borrow().len() == 1
            && let Some((key, until)) = &self.steal_cycle_on_first
        {
            self.store.seed(
                key.clone(),
                &json!({"owner":"foreign-cycle","lease_until_ms":until}),
            );
        }
        Ok(Sample {
            step: STEPS[index].into(),
            slot: dispatch.slot(),
            raw_usage: usage.clone(),
            usage,
            elapsed_ms: 12,
        })
    }
    async fn observed_response(
        &self,
        dispatch: &CacheDispatch,
        _response: &mut Sample,
    ) -> Result<(), GatewayError> {
        if self.quota_on_first && self.calls.borrow().len() == 1 {
            let now = source_fixture()["now"].as_i64().unwrap();
            assert!(
                authority(&self.store)
                    .record_cache_quota_block(
                        dispatch,
                        gateway_authority::routing::QuotaBlock {
                            blocked_until_ms: now + 60_000,
                            source: gateway_authority::routing::QuotaBlockSource::BodyResetsAt,
                            legacy_fallback: false,
                            observed_at_ms: Some(now),
                            reset_at_ms: Some(now + 60_000),
                            reset_is_stable: true,
                            reset_ambiguous: false,
                            recovery_pending: false
                        },
                        now
                    )
                    .await?
            );
            return Err(gateway_authority::cache_experiment::model::failed(
                "Controlled authoritative 429.",
            ));
        }
        Ok(())
    }
    fn discard(&self, _response: Sample) {
        self.discards.set(self.discards.get() + 1);
    }
    async fn read(
        &self,
        response: Sample,
        _slot: u8,
        _model: &str,
        _index: usize,
        _deadline: i64,
    ) -> Result<ReadSample, GatewayError> {
        Ok(ReadSample {
            value: Ok(response),
            completed: true,
        })
    }
    async fn refresh(&self, permit: RefreshPermit) -> Result<PoolVersionstamp, GatewayError> {
        assert_eq!(permit.context().slot, 1);
        assert_eq!(permit.context().prefix.len(), 5);
        assert_eq!(permit.binding().slot, 0);
        let count = self.refreshes.get() + 1;
        self.refreshes.set(count);
        if self.unchanged {
            if self.refresh_error_after_rotation.is_some() {
                return Err(gateway_authority::cache_experiment::model::failed(
                    "Controlled refresh outcome is unknown with an unchanged pool.",
                ));
            }
            return Ok(PoolVersionstamp(
                self.store.row(&codex_source_pool_key()).unwrap().revision,
            ));
        }
        let mut source =
            parse_codex_source_pool(&self.store.row(&codex_source_pool_key()).unwrap().value)
                .unwrap()
                .unwrap();
        source.accounts[0].access_token = Secret::new(format!("fixture-refreshed-{count}"));
        if self.shrink_on_refresh || self.refresh_error_after_rotation == Some(true) {
            source.accounts.pop();
        }
        seed_source(
            &self.store,
            &source.private_source_value(),
            &format!("pool-refresh-{count}"),
        );
        if self.refresh_error_after_rotation.is_some() {
            return Err(gateway_authority::cache_experiment::model::failed(
                "Controlled refresh failed after the source pool changed.",
            ));
        }
        if self.rotate_after_publication {
            source.accounts[0].access_token =
                Secret::new("fixture-foreign-post-publication".into());
            seed_source(
                &self.store,
                &source.private_source_value(),
                "pool-foreign-after-publication",
            );
        }
        Ok(PoolVersionstamp(format!("pool-refresh-{count}")))
    }
}
#[test]
fn source_inventory_fingerprints_and_nondefault_target_match_actual_typescript() {
    let (_, authority, now) = setup();
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let fixture = source_fixture();
    let expected = &fixture["inventory"]["targets"][0];
    let binding = prepared.binding();
    assert_eq!(binding.id, expected["id"]);
    assert_eq!(
        binding.capability_fingerprint,
        expected["capability_fingerprint"]
    );
    assert_eq!(
        binding.inventory_fingerprint,
        fixture["inventory"]["inventory_fingerprint"]
    );
    assert_eq!(binding.model, "fixture-a");
}

#[test]
fn scalar_campaign_preserves_opaque_unrelated_catalog_metadata_through_promotion() {
    use gateway_core::{
        js_string::JsString16, source_control, source_json::SourceJson,
        source_serialization as source, value::ValueEncoding,
    };
    let (store, authority, now) = setup();
    let fixture = source_fixture();
    let raw = SourceJson::from_serializable(&fixture["input"]["snapshot"]).unwrap();
    let mut fields = source::entries(&raw).unwrap();
    let opaque = SourceJson::parse(r#""\ud800""#).unwrap();
    fields
        .iter_mut()
        .find(|(key, _)| key == &JsString16::from_utf8("source"))
        .unwrap()
        .1 = opaque.clone();
    fields.push((
        JsString16::from_utf8("opaque_unrelated_metadata"),
        opaque.clone(),
    ));
    let raw = source::object_keys(fields).unwrap();
    let catalog_key = key(&["ubq_ai", "codex_models"]);
    store.seed_record(
        catalog_key.clone(),
        source_control::encode_source_control_record("catalog-1", &raw, None).unwrap(),
    );
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    assert_eq!(
        prepared.binding().capability_fingerprint,
        fixture["inventory"]["targets"][0]["capability_fingerprint"]
    );
    assert_eq!(
        prepared.binding().inventory_fingerprint,
        fixture["inventory"]["inventory_fingerprint"]
    );
    let io = Io::new(&store);
    let mut prepared = Some(prepared);
    for index in 0..3 {
        let target = prepared.take().unwrap_or_else(|| {
            run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap()
        });
        let result = run(authority.run_cache_experiment(target, &io, now)).unwrap();
        assert_eq!(
            result["status"],
            if index == 2 {
                "completed"
            } else {
                "in_progress"
            }
        );
    }
    let row = store.row(&catalog_key).unwrap();
    assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
    let published = source_control::decode_source_control_record(&row).unwrap();
    assert_eq!(source::member(&published, "source"), Some(opaque.clone()));
    assert_eq!(
        source::member(&published, "opaque_unrelated_metadata"),
        Some(opaque.clone())
    );
    let runtime = source_control::decode_source_control_record(
        &store
            .row(&key(&["uos_ai", "runtime_config", "v2"]))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        source::member(&source::member(&runtime, "codex_models").unwrap(), "source"),
        Some(opaque)
    );
    assert_eq!(
        source::string(&source::member(&runtime, "default_model").unwrap()).unwrap(),
        JsString16::from_utf8("fixture-z")
    );
    assert!(store.row(&gateway_authority::keys::active()).is_none());
    assert_eq!(io.calls.borrow().len(), 30);
}

#[test]
fn lone_model_refuses_only_at_source_uri_target_phase_before_any_campaign_effect() {
    use gateway_core::{source_control, source_json::SourceJson};
    // Actual pinned Bun target-id function bef7ecfb throws URIError for both lone units.
    // src/admin/codex.ts:139-152 maps that unknown failure to this sanitized 503.
    for replacement in [r#""\ud800""#, r#""\udc00""#] {
        let (store, authority, now) = setup();
        let fixture = source_fixture();
        let raw = SourceJson::parse(
            &serde_json::to_string(&fixture["input"]["snapshot"])
                .unwrap()
                .replace("\"fixture-a\"", replacement),
        )
        .unwrap();
        let catalog_key = key(&["ubq_ai", "codex_models"]);
        store.seed_record(
            catalog_key.clone(),
            source_control::encode_source_control_record("catalog-lone", &raw, None).unwrap(),
        );
        let before = store.row(&catalog_key).unwrap();
        let error = match run(authority.prepare_cache_experiment(&"1".repeat(40), now)) {
            Ok(_) => panic!("source URI construction must fail"),
            Err(error) => error,
        };
        assert_eq!(error.status, 503);
        assert_eq!(
            error.envelope.error.code.as_deref(),
            Some("prompt_cache_scope_experiment_failed")
        );
        assert_eq!(
            error.envelope.error.message,
            "Prompt-cache scope experiment could not run."
        );
        assert_eq!(store.row(&catalog_key).unwrap(), before);
        assert!(store.row(&gateway_authority::keys::active()).is_none());
    }
}
#[test]
fn unrelated_malformed_active_selection_never_blocks_or_changes_a_pinned_experiment() {
    for quota in [false, true] {
        let (store, authority, now) = setup();
        let mut io = Io::new(&store);
        io.unchanged = true;
        io.quota_on_first = quota;
        let malformed = json!({"v": 99, "unrelated": "active-election"});
        store.seed(gateway_authority::keys::active(), &malformed);
        let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
        let result = run(authority.run_cache_experiment(prepared, &io, now));
        if quota {
            assert_eq!(
                result.unwrap_err().envelope.error.code.as_deref(),
                Some("prompt_cache_scope_experiment_failed")
            );
            assert_eq!(io.calls.borrow().len(), 1);
        } else {
            assert_eq!(result.unwrap()["inconclusive_reason"], "refresh_unchanged");
            assert_eq!(io.calls.borrow().len(), 5);
        }
        assert_eq!(
            store.row(&gateway_authority::keys::active()).unwrap().value,
            malformed
        );
    }
}
#[test]
fn unverified_catalog_controls_never_create_a_probeable_target() {
    let (store, authority, now) = setup();
    let fixture: Value = serde_json::from_str(include_str!(
        "fixtures/cache-experiment-inventory-source-v1.json"
    ))
    .unwrap();
    store.seed_with_revision(
        key(&["ubq_ai", "codex_models"]),
        &fixture["input"]["snapshot"],
        "catalog-unqualified",
    );
    let error = match run(authority.prepare_cache_experiment(&"1".repeat(40), now)) {
        Ok(_) => panic!("unqualified catalog selected a target"),
        Err(error) => error,
    };
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("prompt_cache_scope_experiment_unavailable")
    );
    assert!(store.row(&gateway_authority::keys::active()).is_none());
}
#[test]
fn exactly_three_leased_cycles_publish_one_scope_without_switching_runtime_default_or_global_account()
 {
    let (store, authority, now) = setup();
    let io = Io::new(&store);
    let mut results = Vec::new();
    for _ in 0..3 {
        let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
        results.push(run(authority.run_cache_experiment(prepared, &io, now)).unwrap());
    }
    assert_eq!(results[0]["status"], "in_progress");
    assert_eq!(results[1]["status"], "in_progress");
    assert_eq!(results[2]["status"], "completed");
    assert_eq!(results[2]["completed_cycles"], 3);
    assert_eq!(results[2]["scope"]["account_slots"], "account_scoped");
    assert_eq!(io.refreshes.get(), 3);
    assert_eq!(io.calls.borrow().len(), 30);
    for cycle in io.calls.borrow().chunks(10) {
        assert_eq!(
            cycle.iter().map(|r| r.0).collect::<Vec<_>>(),
            vec![1, 1, 2, 2, 1, 1, 1, 1, 1, 1]
        );
        assert!(cycle.iter().all(|r| r.1 == cycle[0].1));
        assert_eq!(cycle[7].2, cycle[8].2);
        assert_ne!(cycle[7].2, cycle[0].2);
        assert_eq!(cycle[9].2, cycle[0].2);
    }
    assert_eq!(
        store
            .row(&key(&["uos_ai", "runtime_config", "v2"]))
            .unwrap()
            .value["default_model"],
        "fixture-z"
    );
    assert!(store.row(&gateway_authority::keys::active()).is_none());
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    assert_eq!(prepared.model(), "fixture-z");
}
#[test]
fn unchanged_forced_refresh_stops_after_five_rows_and_never_dispatches_the_discriminator() {
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    io.unchanged = true;
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let result = run(authority.run_cache_experiment(prepared, &io, now)).unwrap();
    assert_eq!(result["status"], "inconclusive");
    assert_eq!(result["inconclusive_reason"], "refresh_unchanged");
    assert_eq!(io.calls.borrow().len(), 5);
    assert_eq!(io.refreshes.get(), 1);
}
#[test]
fn refresh_failure_after_a_valid_pool_revision_change_is_inconclusive_without_a_sixth_dispatch() {
    for shrink in [false, true] {
        let (store, authority, now) = setup();
        let mut io = Io::new(&store);
        io.refresh_error_after_rotation = Some(shrink);
        let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
        let result = run(authority.run_cache_experiment(prepared, &io, now)).unwrap();
        assert_eq!(result["status"], "inconclusive");
        assert_eq!(result["inconclusive_reason"], "auth_pool_drift");
        assert_eq!(io.calls.borrow().len(), 5);
        assert_eq!(io.refreshes.get(), 1);
    }
}
#[test]
fn a_valid_one_account_pool_after_refresh_is_drift_without_a_sixth_dispatch() {
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    io.shrink_on_refresh = true;
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let result = run(authority.run_cache_experiment(prepared, &io, now)).unwrap();
    assert_eq!(result["status"], "inconclusive");
    assert_eq!(result["inconclusive_reason"], "auth_pool_drift");
    assert_eq!(io.calls.borrow().len(), 5);
    assert_eq!(io.refreshes.get(), 1);
}
#[test]
fn unknown_refresh_with_unchanged_source_stays_failed_without_a_sixth_dispatch() {
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    io.unchanged = true;
    io.refresh_error_after_rotation = Some(false);
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let error = run(authority.run_cache_experiment(prepared, &io, now)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("prompt_cache_scope_experiment_failed")
    );
    assert_eq!(io.calls.borrow().len(), 5);
    assert_eq!(io.refreshes.get(), 1);
}
#[test]
fn same_account_rotation_after_verified_publication_is_drift_before_the_sixth_sample() {
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    io.rotate_after_publication = true;
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let result = run(authority.run_cache_experiment(prepared, &io, now)).unwrap();
    assert_eq!(result["status"], "inconclusive");
    assert_eq!(result["inconclusive_reason"], "auth_pool_drift");
    assert_eq!(io.calls.borrow().len(), 5);
    assert_eq!(io.refreshes.get(), 1);
}
#[test]
fn credential_rotation_after_actual_dispatch_discards_response_and_stops_before_another_row() {
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    io.rotate_on_first = true;
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let error = run(authority.run_cache_experiment(prepared, &io, now)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("prompt_cache_scope_experiment_failed")
    );
    assert_eq!(io.calls.borrow().len(), 1);
    assert_eq!(io.discards.get(), 1);
    assert_eq!(io.refreshes.get(), 0);
}
#[test]
fn malformed_durable_state_is_never_reset_into_another_campaign() {
    let (store, authority, now) = setup();
    let io = Io::new(&store);
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let state = experiment_key("state", prepared.binding());
    let malformed = json!({"v":3,"target":prepared.binding(),"next_cycle":1});
    store.seed(state.clone(), &malformed);
    let error = run(authority.run_cache_experiment(prepared, &io, now)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("prompt_cache_scope_experiment_unavailable")
    );
    assert_eq!(store.row(&state).unwrap().value, malformed);
    assert!(io.calls.borrow().is_empty());
}
#[test]
fn live_cycle_or_three_compare_and_set_conflicts_stop_before_any_dispatch() {
    use std::sync::atomic::Ordering;
    for conflict in [false, true] {
        let (store, authority, now) = setup();
        let io = Io::new(&store);
        let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
        if conflict {
            store.conflicts.store(3, Ordering::SeqCst);
        } else {
            store.seed(
                experiment_key("cycle_lease", prepared.binding()),
                &json!({"owner":"other-cycle","lease_until_ms":now+120_000}),
            );
        }
        let error = run(authority.run_cache_experiment(prepared, &io, now)).unwrap_err();
        assert_eq!(error.status, 409);
        assert!(io.calls.borrow().is_empty());
        assert_eq!(io.refreshes.get(), 0);
        assert!(store.row(&gateway_authority::keys::active()).is_none());
    }
}
#[test]
fn losing_the_cycle_lease_after_one_sample_never_sends_another_request() {
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let lease = experiment_key("cycle_lease", prepared.binding());
    io.steal_cycle_on_first = Some((lease.clone(), now + 120_000));
    let error = run(authority.run_cache_experiment(prepared, &io, now)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("prompt_cache_scope_experiment_failed")
    );
    assert_eq!(io.calls.borrow().len(), 1);
    assert_eq!(io.refreshes.get(), 0);
    assert_eq!(store.row(&lease).unwrap().value["owner"], "foreign-cycle");
}
#[test]
fn authoritative_quota_observation_stops_the_pinned_experiment_without_electing_a_sibling() {
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    io.quota_on_first = true;
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let error = run(authority.run_cache_experiment(prepared, &io, now)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("prompt_cache_scope_experiment_failed")
    );
    assert_eq!(io.calls.borrow().len(), 1);
    assert_eq!(io.discards.get(), 1);
    assert_eq!(io.refreshes.get(), 0);
    let routing: gateway_authority::routing::RoutingState = serde_json::from_value(
        store
            .row(&gateway_authority::keys::routing())
            .unwrap()
            .value,
    )
    .unwrap();
    assert!(routing.slots[0].quota_blocked_until_ms.is_some());
    assert!(routing.slots[1].quota_blocked_until_ms.is_none());
    assert!(store.row(&gateway_authority::keys::active()).is_none());
}
#[test]
fn failed_recovery_probe_keeps_source_generation_and_retains_ambiguous_reset_identity() {
    use gateway_authority::routing::{QuotaBlock, QuotaBlockSource, RoutingSlot, RoutingState};
    let (store, authority, now) = setup();
    let mut io = Io::new(&store);
    io.fail_recovery_probe = true;
    let pool: SubscriptionPool =
        serde_json::from_value(store.row(&gateway_authority::keys::pool()).unwrap().value).unwrap();
    let mut slots = pool
        .accounts
        .iter()
        .map(|account| {
            RoutingSlot::neutral(
                Some(account.account_id_hash.clone()),
                account.credential_version.clone(),
            )
        })
        .collect::<Vec<_>>();
    let block = QuotaBlock {
        blocked_until_ms: now - 1,
        source: QuotaBlockSource::BodyResetsAt,
        legacy_fallback: false,
        observed_at_ms: Some(now - 60_000),
        reset_at_ms: Some(now - 1),
        reset_is_stable: true,
        reset_ambiguous: false,
        recovery_pending: true,
    };
    slots[0].generation = 7;
    slots[0].quota_blocks.insert("standard".into(), block);
    slots[0].quota_blocked_classes = vec!["standard".into()];
    slots[0].quota_blocked_until_ms = Some(now - 1);
    slots[0].quota_block_source = Some(QuotaBlockSource::BodyResetsAt);
    slots[0].retained_reset_at_ms = Some(now - 1);
    slots[0].reset_identity_stable = true;
    slots[0].recovery_pending = true;
    store.seed(
        gateway_authority::keys::routing(),
        &RoutingState {
            v: 2,
            updated_at_ms: now,
            legacy_identity_unresolved: false,
            slots,
        },
    );
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let error = run(authority.run_cache_experiment(prepared, &io, now)).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("prompt_cache_scope_experiment_failed")
    );
    assert_eq!(io.calls.borrow().len(), 1);
    let routing: RoutingState = serde_json::from_value(
        store
            .row(&gateway_authority::keys::routing())
            .unwrap()
            .value,
    )
    .unwrap();
    let slot = &routing.slots[0];
    assert_eq!(slot.generation, 7);
    assert!(slot.probe_lease.is_none());
    assert!(slot.quota_blocks.is_empty());
    assert_eq!(slot.retained_reset_at_ms, Some(now - 1));
    assert!(slot.reset_identity_stable);
    assert!(slot.reset_identity_ambiguous);
    assert!(!slot.recovery_pending);
}
#[test]
fn intermediate_cycles_release_the_short_lease_without_extending_the_original_session() {
    let (store, authority, now) = setup();
    let io = Io::new(&store);
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now)).unwrap();
    let target = prepared.binding().clone();
    run(authority.run_cache_experiment(prepared, &io, now)).unwrap();
    let state = experiment_key("state", &target);
    let evidence = experiment_key("evidence", &target);
    let cycle = experiment_key("cycle_lease", &target);
    let first = store.row(&state).unwrap();
    assert_eq!(first.value["expires_at_ms"], now + 900_000);
    assert_eq!(first.expires_at_ms, Some(now + 900_000));
    assert!(store.row(&cycle).is_none());
    store.clock(now + 1_000);
    let prepared = run(authority.prepare_cache_experiment(&"1".repeat(40), now + 1_000)).unwrap();
    run(authority.run_cache_experiment(prepared, &io, now + 1_000)).unwrap();
    let second = store.row(&state).unwrap();
    assert_eq!(second.value["expires_at_ms"], first.value["expires_at_ms"]);
    assert_eq!(second.expires_at_ms, first.expires_at_ms);
    assert_eq!(
        store.row(&evidence).unwrap().expires_at_ms,
        first.expires_at_ms
    );
    assert!(store.row(&cycle).is_none());
    assert_eq!(io.calls.borrow().len(), 20);
}
