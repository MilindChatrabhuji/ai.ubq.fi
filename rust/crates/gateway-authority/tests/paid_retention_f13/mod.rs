//! Bounded F13 experiment against current public Rust authority primitives only.
//! Source b6e25555179ad2b195b0bab93e946be834ecda6c native-authority.test.ts1097-1113
//! is a fixture-only generic service with permanent attempt_lifetime rows, not a live Rust RPC.
use super::support;
use gateway_authority::paid::{PaidAdmission, PaidAuthorization, PaidRequest, PaidRoutingPolicy};
use gateway_authority::paid_control::*;
use gateway_authority::{PAID_RETENTION_MS, keys};
use gateway_core::identity::{ApiKeyId, PaidAttemptId, RequestId};
use gateway_core::provider::{PaidProvider, UpstreamProvider};
use gateway_core::state::{AuthorityStore, RecordKey};
use gateway_providers::ClientSurface;
use serde_json::{Value, json};
use support::*;
pub fn context(input: &PaidRequest) -> PaidRequestContext {
    let mut fields = vec![
        ("model", input.model.to_source_json().unwrap()),
        (
            "stream",
            gateway_core::source_json::SourceJson::from_serializable(&input.stream).unwrap(),
        ),
    ];
    if let Some(effort) = &input.reasoning {
        fields.push((
            "reasoning",
            gateway_core::source_serialization::object(vec![(
                "effort",
                effort.to_source_json().unwrap(),
            )])
            .unwrap(),
        ));
    }
    let body = gateway_core::source_serialization::object(fields).unwrap();
    PaidRequestContext {
        original_model: input.model.clone(),
        body,
        surface: if input.path == "/v1/chat/completions" {
            ClientSurface::Chat
        } else {
            ClientSurface::Responses
        },
        synthetic_hop: None,
    }
}

fn revision(store: &MemoryStore, key: &RecordKey) -> Option<String> {
    store.row(key).map(|row| row.revision)
}

pub fn republish(store: &MemoryStore) {
    let row = store.row(&keys::paid_routing()).unwrap();
    let mut projection: PaidRoutingProjection =
        gateway_core::source_control::decode_source_control_record(&row)
            .unwrap()
            .deserialize()
            .unwrap();
    projection.provenance.owner_revision = revision(store, &keys::paid_control_owner()).unwrap();
    projection.provenance.config_revision = revision(store, &keys::paid_control_config()).unwrap();
    projection.provenance.surplus_observation_revision = revision(
        store,
        &keys::paid_control_observation(PaidProvider::Surplus),
    );
    projection.provenance.openlux_observation_revision = revision(
        store,
        &keys::paid_control_observation(PaidProvider::Metered),
    );
    projection.provenance.source_checks = paid_projection_source_keys()
        .into_iter()
        .map(|key| PaidSourceCheck {
            expected_revision: revision(store, &key),
            key: key.0,
        })
        .collect();
    super::paid_control_cases::seed_source(store, keys::paid_routing(), &projection);
}

pub fn seed_controls(store: &MemoryStore) {
    // Dedicated deterministic unit fixture, not a live owner/config installation.
    store.seed(
        keys::paid_control_owner(),
        &PaidControlOwner {
            v: 1,
            owner_id: "fixture-owner".into(),
            owner_epoch: "fixture-epoch".into(),
            key_fingerprint: "fixture-authenticated-key".into(),
        },
    );
    store.seed(
        keys::paid_control_config(),
        &PaidControlConfig {
            v: PAID_CONTROL_CONFIG_VERSION,
            owner_id: "fixture-owner".into(),
            owner_epoch: "fixture-epoch".into(),
            generation: "fixture-config-generation".into(),
            configuration_fingerprint: "fixture-config-fingerprint".into(),
            surplus_binding: Some("fixture-surplus-binding".into()),
            openlux_discovery_binding: Some("fixture-openlux-discovery-binding".into()),
            openlux_binding: Some("fixture-openlux-binding".into()),
            source_checks: vec![],
        },
    );
    let models:Vec<_>=["paid-model","gpt-test","gpt-5.6-sol","deepseek-v4.1-flash"].into_iter().map(|id|gateway_core::source_json::SourceJson::from_serializable(&json!({"id":id,"supported_endpoint_types":["openai-response","openai"],"supports_tools":true,"input_price_per_token":0.001,"output_price_per_token":0.002})).unwrap()).collect();
    for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
        store.seed(
            keys::paid_control_observation(provider),
            &PaidProviderObservation {
                v: 1,
                provider,
                owner_id: "fixture-owner".into(),
                owner_epoch: "fixture-epoch".into(),
                configuration_generation: "fixture-config-generation".into(),
                configuration_fingerprint: "fixture-config-fingerprint".into(),
                credential_binding: if provider == PaidProvider::Surplus {
                    "fixture-surplus-binding"
                } else {
                    "fixture-openlux-discovery-binding"
                }
                .into(),
                observed_at_ms: NOW,
                source_valid_until_ms: None,
                stale: false,
                models: models.clone(),
                source_checks: vec![],
            },
        );
    }
    let projection = PaidRoutingProjection {
        policy: PaidRoutingPolicy {
            v: 2,
            codex_enabled: true,
            codex_models: vec!["gpt-test".into(), "gpt-5.6-sol".into()],
            models: [
                "paid-model",
                "gpt-test",
                "gpt-5.6-sol",
                "deepseek-v4.1-flash",
            ]
            .into_iter()
            .map(|id| {
                (
                    id.into(),
                    vec![PaidProvider::Surplus, PaidProvider::Metered],
                )
            })
            .collect(),
        },
        provenance: PaidProjectionProvenance {
            v: 1,
            owner_revision: String::new(),
            config_revision: String::new(),
            surplus_observation_revision: None,
            openlux_observation_revision: None,
            observed_at_ms: NOW,
            source_valid_until_ms: None,
            source_checks: vec![],
        },
    };
    super::paid_control_cases::seed_source(store, keys::paid_routing(), &projection);
    republish(store);
}

fn original() -> PaidRequest {
    PaidRequest {
        key_id: ApiKeyId("key-a".into()),
        request_id: RequestId("f13-original".into()),
        attempt_id: PaidAttemptId("f13-openlux-attempt".into()),
        provider: PaidProvider::Metered,
        model: "paid-model".into(),
        route: "responses".into(),
        path: "/v1/responses".into(),
        stream: true,
        reasoning: None,
        created_at_ms: NOW,
    }
}
fn setup() -> (MemoryStore, TestAuthority, PaidRequest, PaidRoutingReceipt) {
    let store = MemoryStore::default();
    store.seed(keys::api_policy("key-a"), &policy());
    seed_controls(&store);
    let authority = authority(&store);
    let input = original();
    let receipt = run(super::paid_original::authorize(
        &authority,
        &input,
        &context(&input),
        NOW,
    ))
    .unwrap();
    (store, authority, input, receipt)
}
fn window_value(store: &MemoryStore, reset: i64) -> Value {
    store.row(&keys::paid_window("key-a", reset)).unwrap().value
}
#[test]
fn f13_control_same_live_history_preserves_one_reservation() {
    let (store, authority, input, receipt) = setup();
    let first =
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &receipt, NOW))
            .unwrap();
    let PaidAdmission::Reserved(first) = first else {
        panic!("expected first reservation")
    };
    let before = window_value(&store, first.window_reset_at_ms);
    store.clock(NOW + 1);
    let replay = run(authority.reserve_paid(
        &input,
        &PaidAuthorization::DirectPaidModel,
        &receipt,
        NOW + 1,
    ))
    .unwrap();
    assert!(matches!(replay, PaidAdmission::Existing(ref same) if same == &first));
    assert_eq!(window_value(&store, first.window_reset_at_ms), before);
}
#[test]
fn f13_expired_history_must_not_recreate_a_retained_logical_paid_attempt() {
    let (store, authority, input, receipt) = setup();
    // Retain the original public API reservation and opaque paid routing receipt;
    // never mint a replacement request, admission or provider outcome for replay.
    let api = run(authority.reserve_api_key(&input.key_id, &input.request_id, &input.route, NOW))
        .unwrap();
    let first =
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &receipt, NOW))
            .unwrap();
    let PaidAdmission::Reserved(first) = first else {
        panic!("expected first reservation")
    };
    let before = window_value(&store, first.window_reset_at_ms);
    let future = NOW + PAID_RETENTION_MS + 1;
    store.clock(future);
    assert!(
        run(store.read(&keys::paid_attempt("key-a", &input.attempt_id.0)))
            .unwrap()
            .is_none()
    );
    assert!(
        run(store.read(&keys::paid_window("key-a", first.window_reset_at_ms)))
            .unwrap()
            .is_some()
    );
    assert!(
        run(store.read(&keys::paid_pending("key-a", &input.attempt_id.0)))
            .unwrap()
            .is_some()
    );
    let api_replay = run(authority.dispatch_api_key(&api, UpstreamProvider::Surplus, future));
    assert!(
        api_replay.is_err(),
        "Original API dispatch fence must not authorize an expired admission"
    );
    let replay = run(authority.reserve_paid(
        &input,
        &PaidAuthorization::DirectPaidModel,
        &receipt,
        future,
    ));
    let after = window_value(&store, first.window_reset_at_ms);
    println!("F13_ORIGINAL_API_FENCE={api_replay:?}");
    println!("F13_RETAINED_PAID_REPLAY={replay:?} BEFORE={before} AFTER={after}");
    assert!(
        replay.is_err(),
        "F13 source refuses retention-expired logical attempts; current public paid primitive returned {replay:?}; before={before}; after={after}"
    );
    assert_eq!(
        after, before,
        "A refused replay cannot add exposure or mutate its old window"
    );
}

fn original_context(
    store: &MemoryStore,
    input: &PaidRequest,
) -> gateway_core::identity::RequestContext {
    serde_json::from_value(
        store
            .row(&super::paid_original::journal_key(&input.request_id.0))
            .unwrap()
            .value["context"]
            .clone(),
    )
    .unwrap()
}
fn fresh_route(authority: &TestAuthority, input: &PaidRequest) -> PaidRoutingReceipt {
    run(authority.authorize_paid_route(input, &context(input), NOW)).unwrap()
}
#[test]
fn f13_route_only_receipt_cannot_create_exposure() {
    let (store, authority, input, _) = setup();
    let unbound = fresh_route(&authority, &input);
    assert!(
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &unbound, NOW))
            .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", &input.attempt_id.0))
            .is_none()
    );
}
#[test]
fn f13_original_dispatched_api_still_allows_same_request_waterfall() {
    let (store, authority, input, _) = setup();
    let journal = super::paid_original::journal_key(&input.request_id.0);
    let mut row = store.row(&journal).unwrap().value;
    let api: gateway_authority::quota::ApiReservation =
        serde_json::from_value(row["api"].clone()).unwrap();
    assert!(run(authority.dispatch_api_key(&api, UpstreamProvider::Metered, NOW)).unwrap());
    let future = NOW + gateway_authority::REQUEST_LEASE_MS + 1;
    // Existing legitimate owner renewal changes this same journal, not admission.
    row["lease_expires_at_ms"] = json!(future + gateway_authority::REQUEST_LEASE_MS);
    store.seed(journal, &row);
    store.clock(future);
    let route = run(authority.authorize_paid_route(&input, &context(&input), future)).unwrap();
    let bound = run(authority.bind_paid_original_request(
        &route,
        &original_context(&store, &input),
        future,
    ))
    .unwrap();
    assert!(matches!(
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &bound, future))
            .unwrap(),
        PaidAdmission::Reserved(_)
    ));
}
#[test]
fn f13_missing_finalized_expired_or_wrong_original_journal_is_refused() {
    for field in [
        "finished",
        "recovering",
        "semantic_committed",
        "terminal_intent",
        "active",
        "lease_expires_at_ms",
        "principal",
    ] {
        let (store, authority, input, _) = setup();
        let original = original_context(&store, &input);
        let key = super::paid_original::journal_key(&input.request_id.0);
        let mut row = store.row(&key).unwrap();
        match field {
            "terminal_intent" => row.value[field] = json!({}),
            "active" => row.value[field] = json!("prior-attempt"),
            "lease_expires_at_ms" => row.value[field] = json!(NOW),
            "principal" => row.value["context"][field] = json!("another-principal"),
            _ => row.value[field] = json!(true),
        }
        store.seed_record(key, row);
        assert!(
            run(authority.bind_paid_original_request(
                &fresh_route(&authority, &input),
                &original,
                NOW
            ))
            .is_err(),
            "{field}"
        );
        assert!(
            store
                .row(&keys::paid_attempt("key-a", &input.attempt_id.0))
                .is_none()
        );
    }
}
#[test]
fn f13_released_api_and_missing_non_deferred_admission_are_refused() {
    for missing in [false, true] {
        let (store, authority, input, _) = setup();
        let original = original_context(&store, &input);
        let journal = store
            .row(&super::paid_original::journal_key(&input.request_id.0))
            .unwrap()
            .value;
        let api: gateway_authority::quota::ApiReservation =
            serde_json::from_value(journal["api"].clone()).unwrap();
        let key = keys::api_request(
            &api.key_id.0,
            &api.policy_version,
            api.window_start_ms,
            &api.request_id.0,
        );
        let mut row = store.row(&key).unwrap();
        if missing {
            row.expires_at_ms = Some(NOW);
        } else {
            row.value["state"] = json!("released");
            row.value["released_at_ms"] = json!(NOW);
            row.value["release_reason"] = json!("source release");
        }
        store.seed_record(key, row);
        assert!(
            run(authority.bind_paid_original_request(
                &fresh_route(&authority, &input),
                &original,
                NOW
            ))
            .is_err()
        );
    }
}
#[test]
fn f13_changed_journal_revision_aborts_reservation_cas_without_exposure() {
    let (store, authority, input, bound) = setup();
    let key = super::paid_original::journal_key(&input.request_id.0);
    let mut changed = store.row(&key).unwrap().value;
    changed["finished"] = json!(true);
    store.race(key, &changed);
    assert!(
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &bound, NOW))
            .is_err()
    );
    assert!(
        store
            .row(&keys::paid_attempt("key-a", &input.attempt_id.0))
            .is_none()
    );
    assert!(
        store
            .row(&keys::paid_window("key-a", NOW + gateway_authority::DAY_MS))
            .is_none()
    );
}
#[test]
fn f13_deferred_original_intent_and_non_api_owner_do_not_require_new_admission() {
    for non_api in [false, true] {
        let (store, authority, input, _) = setup();
        let key = super::paid_original::journal_key(&input.request_id.0);
        let mut journal = store.row(&key).unwrap().value;
        let api: gateway_authority::quota::ApiReservation =
            serde_json::from_value(journal["api"].clone()).unwrap();
        let api_key = keys::api_request(
            &api.key_id.0,
            &api.policy_version,
            api.window_start_ms,
            &api.request_id.0,
        );
        let mut row = store.row(&api_key).unwrap();
        row.expires_at_ms = Some(NOW);
        store.seed_record(api_key, row);
        if non_api {
            journal["context"]["key_id"] = Value::Null;
            journal["api"] = Value::Null;
        } else {
            journal["api"]["deferred"] = json!(true);
        }
        store.seed(key, &journal);
        let original = original_context(&store, &input);
        assert!(
            run(authority.bind_paid_original_request(
                &fresh_route(&authority, &input),
                &original,
                NOW
            ))
            .is_ok()
        );
    }
}

#[test]
fn f13_non_api_original_kernel_is_rechecked_without_renewing_it() {
    let (store, authority, input, _) = setup();
    let journal_key = super::paid_original::journal_key(&input.request_id.0);
    let mut journal = store.row(&journal_key).unwrap().value;
    let kernel = gateway_authority::quota::KernelReservation {
        v: 2,
        owner: "fixture-owner".into(),
        repo: None,
        request_id: input.request_id.clone(),
        route: input.route.clone(),
        window_created_at_ms: NOW,
        window_reset_at_ms: NOW + gateway_authority::DAY_MS,
        reserved_at_ms: NOW,
        lease_expires_at_ms: NOW + gateway_authority::REQUEST_LEASE_MS,
        terminal_intent: None,
        state: None,
        terminal_at_ms: None,
        release_reason: None,
    };
    let key = keys::kernel_request(
        &kernel.owner,
        None,
        kernel.window_created_at_ms,
        &kernel.request_id.0,
    );
    store.seed(key.clone(), &kernel);
    journal["context"]["key_id"] = Value::Null;
    journal["api"] = Value::Null;
    journal["kernel"] = serde_json::to_value(&kernel).unwrap();
    store.seed(journal_key, &journal);
    let original = original_context(&store, &input);
    assert!(
        run(authority.bind_paid_original_request(&fresh_route(&authority, &input), &original, NOW))
            .is_ok()
    );
    let mut expired = kernel.clone();
    expired.lease_expires_at_ms = NOW;
    store.seed(key, &expired);
    assert!(
        run(authority.bind_paid_original_request(&fresh_route(&authority, &input), &original, NOW))
            .is_err()
    );
}

fn publish_active_paid(
    store: &MemoryStore,
    input: &PaidRequest,
    paid: &gateway_authority::paid::PaidReservation,
) {
    let key = super::paid_original::journal_key(&input.request_id.0);
    let mut journal = store.row(&key).unwrap().value;
    journal["active"] = json!("f13-prepared-active");
    journal["attempts"] = json!([{
        "id":"f13-prepared-active","provider":UpstreamProvider::Metered,"model":input.model,"cursor":0,
        "fence":{"Paid":{"provider":UpstreamProvider::Metered,"owner_id":"fixture-owner","owner_epoch":"fixture-epoch","configuration_generation":"fixture-config-generation","credential_binding":"fixture-openlux-binding"}},
        "paid":paid,"phase":"Prepared","transport_started":false,"response_nonce":null,"response_count":0,
        "workspace_nonce":null,"workspace_continuations":0,"known_not_started":false,"observation":null,
        "provider_request_id":null,"billing":null
    }]);
    store.seed(key, &journal);
}
#[test]
fn f13_exact_active_dispatch_rechecks_existing_only_before_and_after_api_dispatch() {
    for committed in [false, true] {
        let (store, authority, input, pre) = setup();
        let PaidAdmission::Reserved(reservation) =
            run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &pre, NOW))
                .unwrap()
        else {
            panic!("expected fresh")
        };
        let before = window_value(&store, reservation.window_reset_at_ms);
        let mut now = NOW;
        if committed {
            let key = super::paid_original::journal_key(&input.request_id.0);
            let mut journal = store.row(&key).unwrap().value;
            let api: gateway_authority::quota::ApiReservation =
                serde_json::from_value(journal["api"].clone()).unwrap();
            assert!(run(authority.dispatch_api_key(&api, UpstreamProvider::Metered, NOW)).unwrap());
            now = NOW + gateway_authority::REQUEST_LEASE_MS + 1;
            journal["lease_expires_at_ms"] = json!(now + gateway_authority::REQUEST_LEASE_MS);
            store.seed(key, &journal);
            store.clock(now);
        }
        publish_active_paid(&store, &input, &reservation);
        let route = run(authority.authorize_paid_route(&input, &context(&input), now)).unwrap();
        let original = original_context(&store, &input);
        assert!(run(authority.bind_paid_original_request(&route, &original, now)).is_err());
        let dispatch =
            run(authority.bind_paid_original_dispatch(&route, &original, &reservation, now))
                .unwrap();
        assert!(
            matches!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&dispatch,now)).unwrap(),PaidAdmission::Existing(same) if same==reservation)
        );
        assert_eq!(window_value(&store, reservation.window_reset_at_ms), before);
    }
}
#[test]
fn f13_existing_only_dispatch_never_recreates_missing_history_or_fresh_exposure() {
    let (store, authority, input, pre) = setup();
    let PaidAdmission::Reserved(reservation) =
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &pre, NOW))
            .unwrap()
    else {
        panic!("expected fresh")
    };
    publish_active_paid(&store, &input, &reservation);
    let original = original_context(&store, &input);
    let route = fresh_route(&authority, &input);
    let dispatch =
        run(authority.bind_paid_original_dispatch(&route, &original, &reservation, NOW)).unwrap();
    let before = window_value(&store, reservation.window_reset_at_ms);
    let key = keys::paid_attempt(&input.key_id.0, &input.attempt_id.0);
    let mut history = store.row(&key).unwrap();
    history.expires_at_ms = Some(NOW);
    store.seed_record(key.clone(), history);
    assert!(
        run(authority.bind_paid_original_dispatch(&route, &original, &reservation, NOW)).is_err()
    );
    assert!(
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &dispatch, NOW))
            .is_err()
    );
    assert!(run(store.read(&key)).unwrap().is_none());
    assert_eq!(window_value(&store, reservation.window_reset_at_ms), before);
}
#[test]
fn f13_wrong_active_attempt_and_expired_dispatch_lease_are_refused() {
    let (store, authority, input, pre) = setup();
    let PaidAdmission::Reserved(reservation) =
        run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &pre, NOW))
            .unwrap()
    else {
        panic!("expected fresh")
    };
    let mut wrong = reservation.clone();
    wrong.attempt_id.0 = "another-paid-attempt".into();
    publish_active_paid(&store, &input, &wrong);
    let original = original_context(&store, &input);
    let route = fresh_route(&authority, &input);
    assert!(
        run(authority.bind_paid_original_dispatch(&route, &original, &reservation, NOW)).is_err()
    );
    publish_active_paid(&store, &input, &reservation);
    let dispatch = run(authority.bind_paid_original_dispatch(
        &fresh_route(&authority, &input),
        &original,
        &reservation,
        NOW,
    ))
    .unwrap();
    store.clock(NOW + gateway_authority::REQUEST_LEASE_MS + 1);
    assert!(
        run(authority.reserve_paid(
            &input,
            &PaidAuthorization::DirectPaidModel,
            &dispatch,
            NOW + gateway_authority::REQUEST_LEASE_MS + 1
        ))
        .is_err()
    );
}

fn local_phase_record(
    phase: gateway_core::local_work::LocalWorkPhase,
) -> gateway_core::local_work::LocalWorkRecord {
    use gateway_core::local_work::{
        LocalSemanticOutcome, LocalTerminalObservation, LocalWorkKind, LocalWorkPhase,
        LocalWorkRecord, SOURCE_REQUEST_BINDING_VERSION,
    };
    LocalWorkRecord {
        kind: LocalWorkKind::CodexResponsesCompaction,
        owner_nonce: "f13-local-data-only".into(),
        binding_version: SOURCE_REQUEST_BINDING_VERSION,
        phase,
        terminal: matches!(
            phase,
            LocalWorkPhase::TerminalPending | LocalWorkPhase::Terminal
        )
        .then_some(LocalTerminalObservation {
            semantic: LocalSemanticOutcome::Incomplete,
            reader_termination: None,
            body: None,
            delivery: gateway_core::lifecycle::DeliveryOutcome::Unobserved,
        }),
    }
}
fn set_local_phase(
    store: &MemoryStore,
    input: &PaidRequest,
    phase: gateway_core::local_work::LocalWorkPhase,
) {
    let key = super::paid_original::journal_key(&input.request_id.0);
    let mut journal = store.row(&key).unwrap().value;
    journal["v"] = json!(2);
    journal["local_work"] = serde_json::to_value(local_phase_record(phase)).unwrap();
    if phase == gateway_core::local_work::LocalWorkPhase::Terminal {
        journal["finished"] = json!(true);
    }
    store.seed(key, &journal);
}
#[test]
fn f13_local_phase_legacy_and_planned_preserve_both_binding_stages_and_dispatched_api() {
    use gateway_core::local_work::LocalWorkPhase;
    for local in [false, true] {
        for dispatched in [false, true] {
            let (store, authority, input, _) = setup();
            if dispatched {
                let journal = store
                    .row(&super::paid_original::journal_key(&input.request_id.0))
                    .unwrap()
                    .value;
                let api: gateway_authority::quota::ApiReservation =
                    serde_json::from_value(journal["api"].clone()).unwrap();
                assert!(
                    run(authority.dispatch_api_key(&api, UpstreamProvider::Metered, NOW)).unwrap()
                );
            }
            if local {
                set_local_phase(&store, &input, LocalWorkPhase::ProviderPlanned);
            }
            let original = original_context(&store, &input);
            let pre = run(authority.bind_paid_original_request(
                &fresh_route(&authority, &input),
                &original,
                NOW,
            ))
            .unwrap();
            let PaidAdmission::Reserved(paid) =
                run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &pre, NOW))
                    .unwrap()
            else {
                panic!("expected new exposure once")
            };
            let before = window_value(&store, paid.window_reset_at_ms);
            publish_active_paid(&store, &input, &paid);
            let route = fresh_route(&authority, &input);
            assert!(run(authority.bind_paid_original_request(&route, &original, NOW)).is_err());
            let existing =
                run(authority.bind_paid_original_dispatch(&route, &original, &paid, NOW)).unwrap();
            assert!(
                matches!(run(authority.reserve_paid(&input,&PaidAuthorization::DirectPaidModel,&existing,NOW)).unwrap(),PaidAdmission::Existing(same) if same==paid)
            );
            assert_eq!(window_value(&store, paid.window_reset_at_ms), before);
        }
    }
}
#[test]
fn f13_local_phase_other_valid_local_phases_never_authorize_provider_exposure() {
    use gateway_core::local_work::{LocalWorkPhase, journal_local_work};
    for phase in [
        LocalWorkPhase::Admitting,
        LocalWorkPhase::Running,
        LocalWorkPhase::Planning,
        LocalWorkPhase::ResponsePending,
        LocalWorkPhase::TerminalPending,
        LocalWorkPhase::Terminal,
    ] {
        let (store, authority, input, _) = setup();
        set_local_phase(&store, &input, phase);
        let row = store
            .row(&super::paid_original::journal_key(&input.request_id.0))
            .unwrap()
            .value;
        assert_eq!(
            journal_local_work(
                &gateway_core::source_json::SourceJson::from_serializable(&row).unwrap()
            )
            .unwrap()
            .unwrap()
            .phase,
            phase
        );
        assert!(
            run(authority.bind_paid_original_request(
                &fresh_route(&authority, &input),
                &original_context(&store, &input),
                NOW
            ))
            .is_err()
        );
        assert!(
            store
                .row(&keys::paid_attempt("key-a", &input.attempt_id.0))
                .is_none()
        );
        assert!(
            store
                .row(&keys::paid_window("key-a", NOW + gateway_authority::DAY_MS))
                .is_none()
        );
    }
}
#[test]
fn f13_local_phase_malformed_missing_and_phase_only_permission_are_refused() {
    use gateway_core::local_work::LocalWorkPhase;
    for defect in [
        "missing_extension",
        "missing_owner",
        "legacy_extension",
        "unknown_phase",
        "foreign_field",
        "expired_owner",
    ] {
        let (store, authority, input, _) = setup();
        set_local_phase(&store, &input, LocalWorkPhase::ProviderPlanned);
        let key = super::paid_original::journal_key(&input.request_id.0);
        let mut journal = store.row(&key).unwrap().value;
        match defect {
            "missing_extension" => {
                journal.as_object_mut().unwrap().remove("local_work");
            }
            "missing_owner" => {
                journal["local_work"]
                    .as_object_mut()
                    .unwrap()
                    .remove("owner_nonce");
            }
            "legacy_extension" => journal["v"] = json!(1),
            "unknown_phase" => journal["local_work"]["phase"] = json!("foreign_phase"),
            "foreign_field" => journal["local_work"]["grants_permission"] = json!(true),
            "expired_owner" => journal["lease_expires_at_ms"] = json!(NOW),
            _ => unreachable!(),
        }
        store.seed(key, &journal);
        assert!(
            run(authority.bind_paid_original_request(
                &fresh_route(&authority, &input),
                &original_context(&store, &input),
                NOW
            ))
            .is_err(),
            "{defect}"
        );
        assert!(
            store
                .row(&keys::paid_attempt("key-a", &input.attempt_id.0))
                .is_none()
        );
    }
}
#[test]
fn f13_local_phase_nonplanned_or_malformed_active_dispatch_cannot_add_exposure() {
    use gateway_core::local_work::LocalWorkPhase;
    for malformed in [false, true] {
        let (store, authority, input, pre) = setup();
        let PaidAdmission::Reserved(paid) =
            run(authority.reserve_paid(&input, &PaidAuthorization::DirectPaidModel, &pre, NOW))
                .unwrap()
        else {
            panic!("expected original paid exposure")
        };
        let before = window_value(&store, paid.window_reset_at_ms);
        publish_active_paid(&store, &input, &paid);
        set_local_phase(&store, &input, LocalWorkPhase::Planning);
        if malformed {
            let key = super::paid_original::journal_key(&input.request_id.0);
            let mut row = store.row(&key).unwrap().value;
            row.as_object_mut().unwrap().remove("local_work");
            store.seed(key, &row);
        }
        assert!(
            run(authority.bind_paid_original_dispatch(
                &fresh_route(&authority, &input),
                &original_context(&store, &input),
                &paid,
                NOW
            ))
            .is_err()
        );
        assert_eq!(window_value(&store, paid.window_reset_at_ms), before);
    }
}
