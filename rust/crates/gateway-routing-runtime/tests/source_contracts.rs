use gateway_core::{
    js_string::JsString16,
    lifecycle::{
        BodyOutcome, DeliveryOutcome, ReaderTermination, SemanticTerminal, TransportObservation,
    },
    model::ModelId,
    provider::UpstreamProvider,
    source_json::SourceJson,
    source_serialization as source,
};
use gateway_providers::policy::HopFailure;
use gateway_routing_runtime::{
    classify, policy,
    session::RoutingSession,
    settlement::recover_pending,
    types::{
        AttemptFailure, AttemptUsage, PreparedWireRequest, RefusalDecision, RoutingHost,
        RoutingInput, RoutingResult, SourceRefusalBody, TransportState,
    },
};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::atomic::Ordering};

fn fixture(value: &Value) -> SourceJson {
    SourceJson::from_serializable(value).unwrap()
}
fn set_source(raw: &mut SourceJson, key: &str, value: Value) {
    let mut fields = source::entries(raw).unwrap();
    let key = JsString16::from_utf8(key);
    if let Some((_, old)) = fields.iter_mut().find(|(name, _)| name == &key) {
        *old = fixture(&value);
    } else {
        fields.push((key, fixture(&value)));
    }
    *raw = source::object_keys(fields).unwrap();
}
fn source_plan(input: &RoutingInput) -> RoutingResult<policy::RoutePlan> {
    let collator = Host::new(&Store::new()).source_string_collator();
    policy::plan(input, NOW, collator.as_ref())
}
#[test]
fn fixture_collator_refuses_unproven_operands_even_when_equal() {
    let collator = Host::new(&Store::new()).source_string_collator();
    assert_eq!(
        collator
            .compare(&"unproven-model".into(), &"unproven-model".into())
            .unwrap_err()
            .envelope
            .error
            .code
            .as_deref(),
        Some("source_catalog_oracle_unknown_pair")
    );
}

fn paid_input(
    store: &Store,
    id: &str,
    model: &str,
) -> gateway_routing_runtime::types::RoutingInput {
    use gateway_authority::{keys, paid_control::*};
    use gateway_core::provider::PaidProvider;
    use gateway_core::state::AuthorityStore;
    let mut request = input(id, model, &["surplus", "openlux"]);
    let models = ["paid-model", "deepseek-v4.1-flash"]
        .map(|id| {
            fixture(&json!({
                "id":id,"supported_endpoint_types":["openai-response","openai"],
                "supports_tools":true,"input_price_per_token":0.001,"output_price_per_token":0.002,
            }))
        })
        .to_vec();
    for provider in ["surplus", "openlux"] {
        request.catalog.providers.get_mut(provider).unwrap().models = models.clone();
    }
    store.seed(
        keys::paid_control_owner(),
        PaidControlOwner {
            v: 1,
            owner_id: "fixture-owner".into(),
            owner_epoch: "fixture-epoch".into(),
            key_fingerprint: "fixture-key".into(),
        },
    );
    store.seed(
        keys::paid_control_config(),
        PaidControlConfig {
            v: PAID_CONTROL_CONFIG_VERSION,
            owner_id: "fixture-owner".into(),
            owner_epoch: "fixture-epoch".into(),
            generation: "fixture-generation".into(),
            configuration_fingerprint: "fixture-config".into(),
            surplus_binding: Some("fixture-surplus".into()),
            openlux_discovery_binding: Some("fixture-openlux".into()),
            openlux_binding: Some("fixture-openlux".into()),
            source_checks: vec![],
        },
    );
    for provider in [PaidProvider::Surplus, PaidProvider::Metered] {
        store.seed(
            keys::paid_control_observation(provider),
            PaidProviderObservation {
                v: 1,
                provider,
                owner_id: "fixture-owner".into(),
                owner_epoch: "fixture-epoch".into(),
                configuration_generation: "fixture-generation".into(),
                configuration_fingerprint: "fixture-config".into(),
                credential_binding: if provider == PaidProvider::Surplus {
                    "fixture-surplus"
                } else {
                    "fixture-openlux"
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
    let revision = |key| run(store.read(&key)).unwrap().map(|row| row.revision);
    store.seed(
        keys::paid_routing(),
        PaidRoutingProjection {
            policy: gateway_authority::paid::PaidRoutingPolicy {
                v: 2,
                codex_enabled: true,
                codex_models: vec!["gpt-test".into()],
                models: ["paid-model", "deepseek-v4.1-flash"]
                    .map(|model| {
                        (
                            model.into(),
                            vec![PaidProvider::Surplus, PaidProvider::Metered],
                        )
                    })
                    .into_iter()
                    .collect(),
            },
            provenance: PaidProjectionProvenance {
                v: 1,
                owner_revision: revision(keys::paid_control_owner()).unwrap(),
                config_revision: revision(keys::paid_control_config()).unwrap(),
                surplus_observation_revision: revision(keys::paid_control_observation(
                    PaidProvider::Surplus,
                )),
                openlux_observation_revision: revision(keys::paid_control_observation(
                    PaidProvider::Metered,
                )),
                observed_at_ms: NOW,
                source_valid_until_ms: None,
                source_checks: paid_projection_source_keys()
                    .into_iter()
                    .map(|key| PaidSourceCheck {
                        expected_revision: revision(key.clone()),
                        key: key.0,
                    })
                    .collect(),
            },
        },
    );
    request
}

#[test]
fn paid_receipt_matches_current_host_custody_and_rechecks_before_dispatch() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let request = paid_input(&store, "paid-current", "paid-model");
        let session = RoutingSession::begin(
            request,
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        assert!(attempt.paid.is_some());
        assert!(matches!(
            attempt.credential,
            gateway_routing_runtime::types::CredentialFence::Paid { .. }
        ));
        session.before_dispatch(&attempt).await.unwrap();
        session.transport_started(&attempt).await.unwrap();
        assert_eq!(
            session
                .refusal(&attempt, refusal(503, TransportState::Started))
                .await
                .unwrap(),
            RefusalDecision::Return
        );
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);

        let request = paid_input(&store, "paid-rotated", "paid-model");
        let session = RoutingSession::begin(
            request,
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        let mut config = store.value(gateway_authority::keys::paid_control_config());
        config["generation"] = json!("next-generation");
        store.seed(gateway_authority::keys::paid_control_config(), config);
        assert!(session.before_dispatch(&attempt).await.is_err());
        let mut failure = refusal(499, TransportState::NotStarted);
        failure.cancelled = true;
        session.refusal(&attempt, failure).await.unwrap();
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn paid_original_api_release_prevents_new_paid_exposure() {
    use gateway_authority::{Authority, keys, quota::ApiReservation};
    use gateway_core::tuple_key::{ScalarKeyPart, TupleKey};

    run(async {
        let store = Store::new();
        seed_key(&store);
        let id = "paid-original-released";
        let session = RoutingSession::begin(
            paid_input(&store, id, "paid-model"),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let journal_key = TupleKey::from_scalar_parts(&[
            ScalarKeyPart::String("uos_ai"),
            ScalarKeyPart::String("routing_runtime"),
            ScalarKeyPart::String("v1"),
            ScalarKeyPart::String("session"),
            ScalarKeyPart::String(id),
        ])
        .to_record_key();
        let original_api: ApiReservation =
            serde_json::from_value(store.value(journal_key)["api"].clone()).unwrap();
        Authority::with_clock(store.clone(), store.clone(), store.clone())
            .release_api_key(&original_api, true, "fixture_original_released", NOW)
            .await
            .unwrap();
        assert!(session.next_attempt().await.is_err());
        assert_eq!(
            store.value(keys::paid_window("key-a", NOW + gateway_authority::DAY_MS)),
            Value::Null,
            "A stale original API owner must fail before any paid exposure is created"
        );
    });
}

#[test]
fn paid_dispatch_missing_active_history_cannot_recreate_exposure() {
    use gateway_authority::keys;
    use gateway_core::state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck,
    };

    run(async {
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin(
            paid_input(&store, "paid-active-history-missing", "paid-model"),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        let paid = attempt.paid.as_ref().unwrap();
        let key = keys::paid_attempt(&paid.key_id.0, &paid.attempt_id.0);
        let record = store.read(&key).await.unwrap().unwrap();
        let window_key = keys::paid_window("key-a", NOW + gateway_authority::DAY_MS);
        let exposure = store.value(window_key.clone());
        assert_ne!(exposure, Value::Null);
        assert_eq!(
            store
                .commit(AtomicTransition {
                    checks: vec![RevisionCheck {
                        key: key.clone(),
                        expected_revision: Some(record.revision),
                    }],
                    mutations: vec![RecordMutation::Delete { key: key.clone() }],
                })
                .await
                .unwrap(),
            CommitOutcome::Committed
        );
        assert!(session.before_dispatch(&attempt).await.is_err());
        assert!(store.read(&key).await.unwrap().is_none());
        assert_eq!(
            store.value(window_key),
            exposure,
            "Existing-only dispatch must not reserve fresh exposure when history vanished"
        );
        assert_eq!(window(&store)["committed_requests"], 0);
    });
}

#[test]
fn paid_synthetic_hop_uses_server_pinned_context_and_distinct_billing_identity() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut request = paid_input(&store, "synthetic-paid", "ubiquity/deepseek-flash");
        set_source(&mut request.raw, "reasoning", json!({"effort":"high"}));
        let session = RoutingSession::begin(
            request,
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let first = session.next_attempt().await.unwrap().unwrap();
        let reservation = first.paid.as_ref().unwrap();
        assert_eq!(
            reservation.attempt_id.0,
            gateway_providers::policy::paid_hop_identity(
                "synthetic-paid",
                gateway_core::provider::PaidProvider::Surplus
            )
        );
        session.before_dispatch(&first).await.unwrap();
        session.transport_started(&first).await.unwrap();
        assert_eq!(
            session
                .refusal(&first, refusal(429, TransportState::Started))
                .await
                .unwrap(),
            RefusalDecision::Continue
        );
        let second = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(second.request.provider(), UpstreamProvider::Metered);
        assert_ne!(
            first.paid.unwrap().attempt_id,
            second.paid.as_ref().unwrap().attempt_id
        );
        assert_eq!(first.original_request_id, second.original_request_id);
        let mut failure = refusal(499, TransportState::NotStarted);
        failure.cancelled = true;
        session.refusal(&second, failure).await.unwrap();
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn extras_children_cannot_refund_started_siblings_or_finish_the_outer_kernel() {
    run(async {
        use gateway_authority::quota::KernelTerminal;
        use gateway_routing_runtime::extras::ExtrasFamily;
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin_extras(
            input("image-parent", "gpt-test", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::ImageGenerations,
        )
        .await
        .unwrap();
        let handle = session.admission_handle();
        let children = handle.children(2).await.unwrap();
        assert_eq!(children[0].request_id(), "image-parent");
        assert_eq!(children[1].request_id(), "image-parent:image:generations:2");
        assert!(session.next_attempt().await.is_err());
        assert!(session.finish(complete()).await.is_err());
        let ticket = handle.before_dispatch(&children[0]).await.unwrap();
        handle
            .transport_started(&children[0], &ticket)
            .await
            .unwrap();
        handle
            .child_finished(&children[1], TransportState::NotStarted)
            .await
            .unwrap();
        assert!(
            handle
                .finish(complete(), KernelTerminal::Committed, "outer complete")
                .await
                .is_err()
        );
        assert!(
            handle
                .child_finished(&children[0], TransportState::NotStarted)
                .await
                .is_err()
        );
        handle
            .child_finished(&children[0], TransportState::Started)
            .await
            .unwrap();
        handle
            .finish(complete(), KernelTerminal::Committed, "outer complete")
            .await
            .unwrap();
        handle
            .finish(complete(), KernelTerminal::Committed, "outer complete")
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn extras_known_no_transport_refunds_but_unknown_intent_recovery_does_not() {
    run(async {
        use gateway_authority::quota::KernelTerminal;
        use gateway_routing_runtime::extras::ExtrasFamily;
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin_extras(
            input("image-none", "gpt-test", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::ImageEdits,
        )
        .await
        .unwrap();
        let handle = session.admission_handle();
        let children = handle.children(2).await.unwrap();
        handle.before_dispatch(&children[0]).await.unwrap();
        for child in children {
            handle
                .child_finished(&child, TransportState::NotStarted)
                .await
                .unwrap();
        }
        handle
            .finish(
                TransportObservation::default(),
                KernelTerminal::Released,
                "source cancelled",
            )
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 0);
        let session = RoutingSession::begin_extras(
            input("image-unknown", "gpt-test", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::ImageGenerations,
        )
        .await
        .unwrap();
        let handle = session.admission_handle();
        let children = handle.children(1).await.unwrap();
        handle.before_dispatch(&children[0]).await.unwrap();
        store.advance(gateway_authority::REQUEST_LEASE_MS + 1);
        let recovered = recover_pending(
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            100,
        )
        .await
        .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            recovered[0].observation.delivery,
            DeliveryOutcome::Unobserved
        );
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn sequential_extras_reuse_original_scope_and_cannot_borrow_another_ticket() {
    run(async {
        use gateway_authority::quota::KernelTerminal;
        use gateway_routing_runtime::extras::ExtrasFamily;
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin_extras(
            input("voyage", "voyage-3", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::Embeddings,
        )
        .await
        .unwrap();
        let handle = session.admission_handle();
        let child = handle.children(1).await.unwrap().remove(0);
        let other = RoutingSession::begin_extras(
            input("other", "voyage-3", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::Embeddings,
        )
        .await
        .unwrap()
        .admission_handle();
        let other_child = other.children(1).await.unwrap().remove(0);
        let other_ticket = other.before_dispatch(&other_child).await.unwrap();
        assert!(
            handle
                .transport_started(&child, &other_ticket)
                .await
                .is_err()
        );
        for _ in 0..2 {
            let ticket = handle.before_dispatch(&child).await.unwrap();
            handle.transport_started(&child, &ticket).await.unwrap();
        }
        handle
            .child_finished(&child, TransportState::Started)
            .await
            .unwrap();
        handle
            .finish(complete(), KernelTerminal::Committed, "voyage complete")
            .await
            .unwrap();
        other
            .child_finished(&other_child, TransportState::NotStarted)
            .await
            .unwrap();
        other
            .finish(
                TransportObservation::default(),
                KernelTerminal::Released,
                "no chunk started",
            )
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn image_child_uses_codex_only_and_aggregate_dispatch_without_second_admission() {
    run(async {
        use gateway_authority::quota::KernelTerminal;
        use gateway_routing_runtime::extras::ExtrasFamily;
        let store = Store::new();
        seed_key(&store);
        seed_pool(&store);
        let session = RoutingSession::begin_extras(
            input("image-codex", "gpt-test", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::ImageGenerations,
        )
        .await
        .unwrap();
        let handle = session.admission_handle();
        let child = handle.children(1).await.unwrap().remove(0);
        let attempt=handle.prepare_image_child(&child,fixture(&json!({"model":"gpt-test","input":"image fixture","tools":[{"type":"image_generation"}]}))).await.unwrap();
        assert_eq!(attempt.request.provider, UpstreamProvider::ChatgptCodex);
        let ticket = handle.before_image_dispatch(&attempt).await.unwrap();
        handle.transport_started(&child, &ticket).await.unwrap();
        assert_eq!(
            handle
                .image_refusal(&attempt, refusal(503, TransportState::Started))
                .await
                .unwrap(),
            RefusalDecision::Return
        );
        handle
            .child_finished(&child, TransportState::Started)
            .await
            .unwrap();
        handle
            .finish(complete(), KernelTerminal::Committed, "image complete")
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn embedding_job_read_without_retry_releases_and_never_commits_kernel_admission() {
    run(async {
        use gateway_authority::quota::KernelTerminal;
        use gateway_routing_runtime::extras::ExtrasFamily;
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin_extras(
            input("job-poll", "voyage-3", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::EmbeddingJobPoll,
        )
        .await
        .unwrap();
        let handle = session.admission_handle();
        let child = handle.children(1).await.unwrap().remove(0);
        handle
            .child_finished(&child, TransportState::NotStarted)
            .await
            .unwrap();
        assert!(
            handle
                .finish(complete(), KernelTerminal::Committed, "job cached")
                .await
                .is_err()
        );
        handle
            .finish(complete(), KernelTerminal::Released, "job read")
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 0);
    });
}

fn refusal(status: u16, transport: TransportState) -> AttemptFailure {
    AttemptFailure {
        origin: if status == 499 {
            gateway_routing_runtime::types::FailureOrigin::Transport
        } else {
            gateway_routing_runtime::types::FailureOrigin::Provider
        },
        status: Some(status),
        headers: BTreeMap::new(),
        body: vec![],
        body_complete: true,
        failure: HopFailure::Status(status),
        transport,
        semantic_committed: false,
        cancelled: false,
    }
}
fn complete() -> TransportObservation {
    TransportObservation {
        semantic_terminal: Some(SemanticTerminal::Completed),
        reader_termination: Some(ReaderTermination::Eof),
        body: Some(BodyOutcome::Drained),
        delivery: DeliveryOutcome::Unobserved,
    }
}

#[test]
fn paid_capability_endpoint_and_logical_model_stay_separate_from_wire_alias() {
    assert_eq!(
        policy::endpoint(gateway_providers::ClientSurface::Responses),
        "openai-response"
    );
    assert_eq!(
        policy::endpoint(gateway_providers::ClientSurface::Chat),
        "openai"
    );
    let raw = json!({"model":"gpt-5.6-sol","input":"source fixture","reasoning":{"effort":"none"}});
    let options = gateway_providers::PrepareOptions {
        auth: gateway_providers::AuthMaterial {
            secret: "fixture".into(),
            ..Default::default()
        },
        ..Default::default()
    };
    let prepared = gateway_providers::prepare_request(
        UpstreamProvider::Metered,
        gateway_providers::ClientSurface::Responses,
        &raw,
        &options,
    )
    .unwrap();
    assert_eq!(raw["model"], "gpt-5.6-sol");
    assert_eq!(
        source::member(&prepared.body, "model").and_then(|value| source::string(&value)),
        Some("gpt-5.6-sol-low".into())
    );
    assert!(source::member(&prepared.body, "reasoning").is_none());
}

#[test]
fn source_availability_gate_preserves_full_compact_paid_and_reserve_cases() {
    let mut request = input("model-gate", "unknown-model", &[]);
    assert_eq!(source_plan(&request).unwrap_err().error.status, 404);
    request.catalog.snapshot = request.catalog.full_snapshot.take();
    assert_eq!(source_plan(&request).unwrap_err().error.status, 404);
    request.catalog.snapshot.as_mut().unwrap().models.clear();
    assert!(source_plan(&request).is_ok());
    request.catalog.snapshot = None;
    assert!(source_plan(&request).is_ok());
    let mut reserve = input("reserve-model", "gpt-reserve", &["surplus"]);
    reserve.catalog.providers.get_mut("surplus").unwrap().models = vec![fixture(
        &json!({"id":"gpt-reserve","supported_endpoint_types":["openai-response"],"input_price_per_token":0.001,"output_price_per_token":0.002}),
    )];
    let plan = source_plan(&reserve).unwrap();
    assert!(!plan.paid.metered_only);
    assert!(matches!(plan.hops.get(1), Some(policy::RouteHop::Codex)));
    let mut paid = input("paid-endpoint", "paid-model", &["surplus"]);
    paid.catalog.providers.get_mut("surplus").unwrap().models = vec![fixture(
        &json!({"id":"paid-model","supported_endpoint_types":["openai"],"input_price_per_token":0.001,"output_price_per_token":0.002}),
    )];
    assert_eq!(source_plan(&paid).unwrap_err().error.status, 404);
    paid.surface = gateway_providers::ClientSurface::Chat;
    // Keep the model/content/control intent in the actual Chat envelope.
    paid.raw = fixture(&json!({
        "model":"paid-model",
        "messages":[{"role":"user","content":"source fixture"}],
        "reasoning_effort":"none"
    }));
    assert!(source_plan(&paid).is_ok());
}
#[test]
fn frozen_source_classifier_quota_classes_and_fallback_matrix() {
    let golden: Value = serde_json::from_str(include_str!("fixtures/source-golden.json")).unwrap();
    assert_eq!(golden["classes"].as_array().unwrap().len(), 9);
    assert_eq!(golden["quota"].as_array().unwrap().len(), 16);
    for case in golden["classes"].as_array().unwrap() {
        assert_eq!(
            gateway_authority::routing::class_name(policy::class(&ModelId::from(
                case["model"].as_str().unwrap_or("")
            ))),
            case["expected"].as_str().unwrap()
        );
    }
    for case in golden["statuses"].as_array().unwrap() {
        let status = case["status"].as_u64().unwrap() as u16;
        let actual =
            gateway_providers::policy::deepseek_decision(HopFailure::Status(status), false)
                == gateway_providers::policy::HopDecision::Advance;
        assert_eq!(actual, case["expected"] == true);
    }
    for case in golden["quota"].as_array().unwrap() {
        let headers = case["retry"]
            .as_str()
            .map(|r| BTreeMap::from([("retry-after".into(), r.into())]))
            .unwrap_or_default();
        let bytes: Vec<u8> = case["bytes"]
            .as_array()
            .map(|v| v.iter().map(|b| b.as_u64().unwrap() as u8).collect())
            .unwrap_or_else(|| case["body"].as_str().unwrap().as_bytes().to_vec());
        let actual = classify::codex_quota(
            Some(case["status"].as_u64().unwrap() as u16),
            &headers,
            &bytes,
            case["complete"] != false,
            case["now"].as_i64().unwrap(),
        );
        if case["expected"].is_null() {
            assert!(actual.is_none(), "{}", case["name"]);
        } else {
            let actual = actual.unwrap();
            assert_eq!(
                actual.blocked_until_ms,
                case["expected"]["retryAtMs"].as_i64().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                actual.reset_is_stable,
                case["expected"]["resetDeadlineIsStable"] == true
            );
            assert_eq!(
                actual.reset_ambiguous,
                case["expected"]["resetDeadlineConflict"] == true
            );
        }
    }
}
#[test]
fn direct_dispatch_and_finish_count_api_once() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin(
            input("once", "deepseek-flash", &["deepseek"]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(attempt.request.provider(), UpstreamProvider::Deepseek);
        session.before_dispatch(&attempt).await.unwrap();
        assert!(session.before_dispatch(&attempt).await.is_err());
        session.transport_started(&attempt).await.unwrap();
        session
            .observe_terminal(
                &attempt,
                complete(),
                AttemptUsage {
                    status: Some(200),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        session.finish(complete()).await.unwrap();
        session.finish(complete()).await.unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
        assert_eq!(window(&store)["reserved_requests"], 0);
    })
}
#[test]
fn explicit_not_started_abort_compensates_but_ambiguous_intent_does_not() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin(
            input("cancel-safe", "deepseek-flash", &["deepseek"]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&attempt).await.unwrap();
        let mut failure = refusal(499, TransportState::NotStarted);
        failure.cancelled = true;
        assert_eq!(
            session.refusal(&attempt, failure).await.unwrap(),
            RefusalDecision::Abort
        );
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 0);
        let other = RoutingSession::begin(
            input("cancel-unknown", "deepseek-flash", &["deepseek"]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = other.next_attempt().await.unwrap().unwrap();
        other.before_dispatch(&attempt).await.unwrap();
        other.finish(TransportObservation::default()).await.unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    })
}
#[test]
fn started_transport_cannot_be_refunded_by_client_cancellation() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin(
            input("started", "deepseek-flash", &["deepseek"]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&attempt).await.unwrap();
        session.transport_started(&attempt).await.unwrap();
        let mut failure = refusal(499, TransportState::Started);
        failure.cancelled = true;
        assert_eq!(
            session.refusal(&attempt, failure).await.unwrap(),
            RefusalDecision::Abort
        );
        session
            .finish(TransportObservation {
                delivery: DeliveryOutcome::Interrupted,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    })
}
#[test]
fn synthetic_hops_share_original_admission_and_stop_after_semantic_commit() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut request = input(
            "synthetic",
            "ubiquity/deepseek-flash",
            &["lithos", "deepseek"],
        );
        set_source(&mut request.raw, "reasoning", json!({"effort":"high"}));
        let session = RoutingSession::begin(
            request,
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let first = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(first.request.provider(), UpstreamProvider::Lithos);
        session.before_dispatch(&first).await.unwrap();
        session.transport_started(&first).await.unwrap();
        assert_eq!(
            session
                .refusal(&first, refusal(503, TransportState::Started))
                .await
                .unwrap(),
            RefusalDecision::Continue
        );
        let second = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(second.request.provider(), UpstreamProvider::Deepseek);
        assert_eq!(first.original_request_id, second.original_request_id);
        session.before_dispatch(&second).await.unwrap();
        session.transport_started(&second).await.unwrap();
        session
            .observe_terminal(&second, complete(), AttemptUsage::default())
            .await
            .unwrap();
        assert_eq!(
            session
                .refusal(&second, refusal(503, TransportState::Started))
                .await
                .unwrap(),
            RefusalDecision::Return
        );
        session.finish(complete()).await.unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    })
}
#[test]
fn codex_none_and_ultra_keep_source_wire_translation_and_one_conversation() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        seed_pool(&store);
        let mut request = input("codex", "gpt-test", &[]);
        set_source(&mut request.raw, "reasoning", json!({"effort":"ultra"}));
        let session = RoutingSession::begin(
            request,
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let first = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(
            source::member(first.request.body(), "reasoning")
                .and_then(|reasoning| source::member(&reasoning, "effort"))
                .and_then(|value| source::string(&value)),
            Some("max".into())
        );
        let PreparedWireRequest::Ready(first_ready) = &first.request else {
            panic!("expected scalar Ready")
        };
        let conversation = first_ready.headers["conversation_id"].clone();
        session.before_dispatch(&first).await.unwrap();
        session.transport_started(&first).await.unwrap();
        assert_eq!(
            session
                .refusal(&first, refusal(401, TransportState::Started))
                .await
                .unwrap(),
            RefusalDecision::Continue
        );
        let second = session.next_attempt().await.unwrap().unwrap();
        let PreparedWireRequest::Ready(second_ready) = &second.request else {
            panic!("expected scalar Ready")
        };
        assert_eq!(second_ready.headers["conversation_id"], conversation);
        assert_ne!(first.credential, second.credential);
        session.before_dispatch(&second).await.unwrap();
        session.transport_started(&second).await.unwrap();
        session
            .observe_terminal(&second, complete(), AttemptUsage::default())
            .await
            .unwrap();
        session.finish(complete()).await.unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    })
}
#[test]
fn codex_generic429_is_not_paid_or_account_exhaustion() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        seed_pool(&store);
        let session = RoutingSession::begin(
            input("generic429", "gpt-test", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&attempt).await.unwrap();
        session.transport_started(&attempt).await.unwrap();
        let mut failure = refusal(429, TransportState::Started);
        failure.body = br#"{"error":{"type":"rate_limit_error"}}"#.to_vec();
        failure.headers.insert("retry-after".into(), "60".into());
        assert_eq!(
            session.refusal(&attempt, failure).await.unwrap(),
            RefusalDecision::Return
        );
        let active = store.value(gateway_authority::keys::active());
        assert_eq!(
            active["account_id_hash"],
            source_account("a").identity().routing_account_hash.0
        );
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
    })
}
#[test]
fn credential_generation_change_prevents_dispatch_and_allows_only_proven_compensation() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        seed_pool(&store);
        let session = RoutingSession::begin(
            input("changed", "gpt-test", &[]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        store.seed(
            source_key(),
            json!({"fixture_owner":"native","generation":2}),
        );
        assert!(session.before_dispatch(&attempt).await.is_err());
        let mut failure = refusal(499, TransportState::NotStarted);
        failure.cancelled = true;
        session.refusal(&attempt, failure).await.unwrap();
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 0);
    })
}
#[test]
fn expired_journal_recovery_never_replays_or_refunds_started_work() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let host = Host::new(&store);
        let session = RoutingSession::begin(
            input("restart", "deepseek-flash", &["deepseek"]),
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&attempt).await.unwrap();
        session.transport_started(&attempt).await.unwrap();
        store.advance(gateway_authority::REQUEST_LEASE_MS + 1);
        let recovered = recover_pending(
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
            100,
        )
        .await
        .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].observation.semantic_terminal, None);
        assert_eq!(
            recovered[0].observation.delivery,
            DeliveryOutcome::Unobserved
        );
        assert!(
            recover_pending(store.clone(), host, store.clone(), store.clone(), 100)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(window(&store)["committed_requests"], 1);
    })
}
#[test]
fn simultaneous_original_request_identity_has_one_winner() {
    let store = Store::new();
    seed_key(&store);
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            std::thread::spawn(move || {
                run(RoutingSession::begin(
                    input("race", "deepseek-flash", &["deepseek"]),
                    store.clone(),
                    Host::new(&store),
                    store.clone(),
                    store,
                ))
                .is_ok()
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|won| *won)
            .count(),
        1
    );
}
#[test]
fn cancellation_before_admission_preserves_original_reason() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let host = Host::new(&store);
        host.cancelled.store(true, Ordering::SeqCst);
        let error = RoutingSession::begin(
            input("already-cancelled", "deepseek-flash", &["deepseek"]),
            store.clone(),
            host,
            store.clone(),
            store,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.error.status, 499);
        assert_eq!(error.error.envelope.error.message, "fixture cancelled");
    })
}

#[test]
fn source_deepseek_extension_uses_one_captured_route_selection() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut request = input("captured-selection", "deepseek-flash", &["deepseek"]);
        request.surface = gateway_providers::ClientSurface::Chat;
        request.raw = fixture(
            &json!({"model":"deepseek-flash","messages":[{"role":"user","content":"fixture"}],"thinking":{"type":"disabled"}}),
        );
        request.catalog.selection = gateway_schema::selection::ProviderSelection::normalize(
            &json!({"provider_ids":["cerebras"],"updated_at_ms":NOW}),
        );
        let error = source_plan(&request).unwrap_err();
        assert_eq!(error.error.status, 400);
        let SourceRefusalBody::Json(body) = error.source_body.unwrap() else {
            panic!("expected the original source request error body")
        };
        let source_error = source::member(&body, "error").unwrap();
        assert_eq!(
            source::member(&source_error, "param").map(|param| source::string(&param)),
            Some(Some("thinking".into()))
        );
        request.catalog.selection = None;
        let session = RoutingSession::begin(
            request.clone(),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        request.catalog.selection = gateway_schema::selection::ProviderSelection::normalize(
            &json!({"provider_ids":["cerebras"],"updated_at_ms":NOW+1}),
        );
        assert!(!request.catalog.enabled("deepseek"));
        let attempt = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(attempt.request.provider(), UpstreamProvider::Deepseek);
        assert_eq!(
            source::member(attempt.request.body(), "reasoning_effort")
                .and_then(|value| source::string(&value)),
            Some("none".into())
        );
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
    });
}

#[test]
fn measured_cancelled_wait_is_recorded_before_original_cancellation_error() {
    run(async {
        let golden: Value =
            serde_json::from_str(include_str!("fixtures/source-currency-wait.json")).unwrap();
        let elapsed = golden["cancelled"]["elapsed_ms"].as_i64().unwrap();
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        host.cancel_wait_after_ms = Some(elapsed);
        let session = RoutingSession::begin(
            input(
                "wait-cancel",
                "deepseek-ai/DeepSeek-V4.1-Flash",
                &["lithos"],
            ),
            store.clone(),
            host,
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&attempt).await.unwrap();
        session.transport_started(&attempt).await.unwrap();
        let mut failure = refusal(429, TransportState::Started);
        failure.headers.insert("retry-after".into(), "60".into());
        let error = session.refusal(&attempt, failure).await.unwrap_err();
        assert_eq!(error.error.status, 499);
        assert_eq!(session.elapsed_wait_ms(), elapsed);
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn lithos_refusal_headers_use_vendor_windows_and_response_prohibition() {
    run(async {
        for (id, headers, expected_prohibited) in [
            ("lithos-no-window", BTreeMap::new(), false),
            (
                "lithos-short-window",
                BTreeMap::from([("retry-after-ms".into(), "5".into())]),
                false,
            ),
            (
                "lithos-retry-after-ms",
                BTreeMap::from([("retry-after-ms".into(), "90000".into())]),
                false,
            ),
            (
                "lithos-reset-duration",
                BTreeMap::from([("x-ratelimit-reset-requests".into(), "90s".into())]),
                false,
            ),
            (
                "lithos-response-prohibited",
                BTreeMap::from([
                    ("retry-after-ms".into(), "5".into()),
                    ("x-should-retry".into(), "false".into()),
                ]),
                true,
            ),
        ] {
            let store = Store::new();
            seed_key(&store);
            let session = RoutingSession::begin(
                input(id, "deepseek-ai/DeepSeek-V4.1-Flash-ultra", &["lithos"]),
                store.clone(),
                Host::new(&store),
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            let attempt = session.next_attempt().await.unwrap().unwrap();
            session.before_dispatch(&attempt).await.unwrap();
            session.transport_started(&attempt).await.unwrap();
            let mut failure = refusal(429, TransportState::Started);
            failure.headers = headers;
            assert_eq!(
                session.refusal(&attempt, failure).await.unwrap(),
                RefusalDecision::Continue,
                "{id}"
            );
            assert_eq!(session.elapsed_wait_ms(), 0, "{id}");
            let next = session.next_attempt().await.unwrap().unwrap();
            assert!(
                next.request
                    .decode()
                    .model
                    .matches_scalar("deepseek-ai/DeepSeek-V4.1-Flash-fast"),
                "{id}: {:?}",
                next.request.decode().model
            );
            if expected_prohibited {
                assert_eq!(session.elapsed_wait_ms(), 0, "{id}");
            }
            session
                .finish(TransportObservation::default())
                .await
                .unwrap();
        }
    });
}

#[test]
fn lithos_response_prohibition_is_request_local_and_does_not_retry_the_rung() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let first = RoutingSession::begin(
            input(
                "lithos-local-prohibited",
                "deepseek-ai/DeepSeek-V4.1-Flash-ultra",
                &["lithos"],
            ),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = first.next_attempt().await.unwrap().unwrap();
        first.before_dispatch(&attempt).await.unwrap();
        first.transport_started(&attempt).await.unwrap();
        let mut refusal = refusal(429, TransportState::Started);
        refusal
            .headers
            .insert("x-should-retry".into(), "false".into());
        assert_eq!(
            first.refusal(&attempt, refusal).await.unwrap(),
            RefusalDecision::Continue
        );
        let next = first.next_attempt().await.unwrap().unwrap();
        assert!(
            next.request
                .decode()
                .model
                .matches_scalar("deepseek-ai/DeepSeek-V4.1-Flash-fast"),
            "the prohibited rung must not be retried: {:?}",
            next.request.decode().model
        );
        first.finish(TransportObservation::default()).await.unwrap();

        let second = RoutingSession::begin(
            input(
                "lithos-local-prohibited-next-request",
                "deepseek-ai/DeepSeek-V4.1-Flash-ultra",
                &["lithos"],
            ),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = second.next_attempt().await.unwrap().unwrap();
        assert!(
            attempt
                .request
                .decode()
                .model
                .matches_scalar("deepseek-ai/DeepSeek-V4.1-Flash-ultra"),
            "another request must still try the prohibited model: {:?}",
            attempt.request.decode().model
        );
        second
            .finish(TransportObservation::default())
            .await
            .unwrap();
    });
}

#[test]
fn explicit_provider_504_survives_late_abort_and_local_deadline_never_advances() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let host = Host::new(&store);
        let mut request = input(
            "provider-504",
            "ubiquity/deepseek-flash",
            &["lithos", "deepseek"],
        );
        set_source(&mut request.raw, "reasoning", json!({"effort":"high"}));
        let session = RoutingSession::begin(
            request,
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&attempt).await.unwrap();
        session.transport_started(&attempt).await.unwrap();
        host.cancelled.store(true, Ordering::SeqCst);
        assert_eq!(
            session
                .refusal(&attempt, refusal(504, TransportState::Started))
                .await
                .unwrap(),
            RefusalDecision::Return
        );
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        let mut request = input(
            "local-504",
            "ubiquity/deepseek-flash",
            &["lithos", "deepseek"],
        );
        set_source(&mut request.raw, "reasoning", json!({"effort":"high"}));
        let session = RoutingSession::begin(
            request,
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&attempt).await.unwrap();
        session.transport_started(&attempt).await.unwrap();
        let mut deadline = refusal(504, TransportState::Started);
        deadline.origin = gateway_routing_runtime::types::FailureOrigin::GatewayDeadline;
        assert_eq!(
            session.refusal(&attempt, deadline).await.unwrap(),
            RefusalDecision::Abort
        );
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
    });
}
