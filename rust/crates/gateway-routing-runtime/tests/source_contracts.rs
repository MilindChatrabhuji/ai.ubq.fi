mod support;
use gateway_core::{
    lifecycle::{
        BodyOutcome, DeliveryOutcome, ReaderTermination, SemanticTerminal, TransportObservation,
    },
    provider::UpstreamProvider,
};
use gateway_providers::policy::HopFailure;
use gateway_routing_runtime::{
    AttemptFailure, AttemptUsage, RefusalDecision, RoutingSession, TransportState, classify,
    policy, recover_pending,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::atomic::Ordering};
use support::*;

fn refusal(status: u16, transport: TransportState) -> AttemptFailure {
    AttemptFailure {
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
    assert_eq!(policy::endpoint(gateway_providers::ClientSurface::Responses), "openai-response");
    assert_eq!(policy::endpoint(gateway_providers::ClientSurface::Chat), "openai");
    let raw = json!({"model":"gpt-5.6-sol","input":"source fixture","reasoning":{"effort":"none"}});
    let options = gateway_providers::PrepareOptions { auth: gateway_providers::AuthMaterial {secret:"fixture".into(),..Default::default()},..Default::default() };
    let prepared = gateway_providers::prepare_request(UpstreamProvider::Metered, gateway_providers::ClientSurface::Responses, &raw, &options).unwrap();
    assert_eq!(raw["model"], "gpt-5.6-sol");
    assert_eq!(prepared.body["model"], "gpt-5.6-sol-low");
    assert!(prepared.body.get("reasoning").is_none());
}
#[test]
fn frozen_source_classifier_quota_classes_and_fallback_matrix() {
    let golden: Value = serde_json::from_str(include_str!("fixtures/source-golden.json")).unwrap();
    assert_eq!(golden["classes"].as_array().unwrap().len(), 9);
    assert_eq!(golden["quota"].as_array().unwrap().len(), 16);
    for case in golden["classes"].as_array().unwrap() {
        assert_eq!(
            gateway_authority::routing::class_name(policy::class(
                case["model"].as_str().unwrap_or("")
            )),
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
        assert_eq!(attempt.request.provider, UpstreamProvider::Deepseek);
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
        request.raw["reasoning"] = json!({"effort":"high"});
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
        assert_eq!(first.request.provider, UpstreamProvider::Lithos);
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
        assert_eq!(second.request.provider, UpstreamProvider::Deepseek);
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
        request.raw["reasoning"] = json!({"effort":"ultra"});
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
        assert_eq!(first.request.body["reasoning"]["effort"], "max");
        let conversation = first.request.headers["conversation_id"].clone();
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
        assert_eq!(second.request.headers["conversation_id"], conversation);
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
        assert_eq!(active["account_id_hash"], "route-a");
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
