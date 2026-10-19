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
    let mut body = json!({"model":input.model,"stream":input.stream});
    if let Some(effort) = &input.reasoning {
        body["reasoning"] = json!({"effort":effort});
    }
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
    let mut projection: PaidRoutingProjection = serde_json::from_value(row.value).unwrap();
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
    store.seed(keys::paid_routing(), &projection);
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
    let models:Vec<_>=["paid-model","gpt-test","gpt-5.6-sol","deepseek-v4.1-flash"].into_iter().map(|id|json!({"id":id,"supported_endpoint_types":["openai-response","openai"],"supports_tools":true,"input_price_per_token":0.001,"output_price_per_token":0.002})).collect();
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
    store.seed(keys::paid_routing(), &projection);
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
