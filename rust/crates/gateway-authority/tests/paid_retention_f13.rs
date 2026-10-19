//! Bounded F13 experiment against current public Rust authority primitives only.
//! Source b6e25555179ad2b195b0bab93e946be834ecda6c native-authority.test.ts1097-1113
//! is a fixture-only generic service with permanent attempt_lifetime rows, not a live Rust RPC.
mod support;
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
    let receipt = run(authority.authorize_paid_route(&input, &context(&input), NOW)).unwrap();
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
