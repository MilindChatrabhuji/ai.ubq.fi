use gateway_core::{
    claude::ClaudeErrorEvidence, lifecycle::TransportObservation, provider::UpstreamProvider,
};
use gateway_providers::{ClaudeBodyOptions, ClaudeCredentialKind, policy::HopFailure};
use gateway_routing_runtime::{extras::*, session::*, types::*};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use serde_json::json;
use std::{collections::BTreeMap, sync::atomic::Ordering};

fn publication(workspace: Option<&str>) -> PublishedCredential {
    PublishedCredential::Claude {
        fence: CredentialFence::Claude {
            account_id: "fixture-account".into(),
            cohort_id: workspace.unwrap_or("initial").into(),
            credential_fingerprint: "fixture-credential".into(),
            evidence_generation: "fixture-evidence".into(),
            workspace_id: workspace.map(Into::into),
            checks: vec![],
        },
        body_options: {
            let mut options = ClaudeBodyOptions::new(ClaudeCredentialKind::ApiKey);
            options.supports_disabled_thinking = true;
            options.native_reasoning_efforts = Some(vec!["medium".into()]);
            options
        },
    }
}
fn request(id: &str, disabled: bool) -> RoutingInput {
    let mut request = input(id, "claude-sonnet-4-6", &["claude_code"]);
    request
        .catalog
        .providers
        .get_mut("claude_code")
        .unwrap()
        .models = vec![
        gateway_core::source_json::SourceJson::from_serializable(
            &json!({"id":"claude-sonnet-4-6","supported_endpoint_types":["openai-response","anthropic"],"supports_tools":true}),
        ).unwrap(),
    ];
    if !disabled {
        let fields = gateway_core::source_serialization::entries(&request.raw).unwrap();
        request.raw = gateway_core::source_serialization::object_keys(
            fields
                .into_iter()
                .filter(|(key, _)| key != &"reasoning".into())
                .collect(),
        )
        .unwrap();
    }
    request
}
fn head(status: u16) -> ResponseHead {
    ResponseHead {
        status,
        headers: BTreeMap::new(),
        provider_request_id: Some("actual-provider-id".into()),
        observed_at_ms: NOW,
    }
}
fn failure(status: u16) -> AttemptFailure {
    AttemptFailure {
        origin: FailureOrigin::Provider,
        status: Some(status),
        headers: BTreeMap::new(),
        body: vec![],
        body_complete: false,
        failure: HopFailure::Status(status),
        transport: TransportState::Started,
        semantic_committed: false,
        cancelled: false,
    }
}
fn unknown() -> ClaudeErrorEvidence {
    ClaudeErrorEvidence::from_prefix(None, false).unwrap()
}

#[test]
fn headers_require_actual_started_phase_and_are_consumed_once() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        host.claude = Some(publication(None));
        let session = RoutingSession::begin(
            request("header-phase", false),
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let attempt = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(attempt.request.provider(), UpstreamProvider::ClaudeCode);
        assert!(session.observe_response(&attempt, head(200)).await.is_err());
        session.before_dispatch(&attempt).await.unwrap();
        assert!(session.observe_response(&attempt, head(200)).await.is_err());
        assert_eq!(host.claude_heads.load(Ordering::SeqCst), 0);
        session.transport_started(&attempt).await.unwrap();
        let observed = session.observe_response(&attempt, head(200)).await.unwrap();
        assert!(session.observe_response(&attempt, head(200)).await.is_err());
        assert!(matches!(
            session
                .resolve_response(&attempt, observed, unknown(), None)
                .await
                .unwrap(),
            ResponseDecision::Return
        ));
        assert!(session.observe_response(&attempt, head(200)).await.is_err());
        assert_eq!(host.claude_heads.load(Ordering::SeqCst), 1);
        assert_eq!(host.consumed_heads.lock().unwrap().len(), 1);
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}

#[test]
fn codex_header_receipt_cannot_cross_original_requests_with_colliding_fixture_tokens() {
    run(async {
        // Independent authorities intentionally mint the same deterministic
        // fixture tokens; the original request identity must still fence heads.
        let mut sessions = Vec::new();
        for id in ["codex-head-owner", "codex-head-other"] {
            let store = Store::new();
            seed_key(&store);
            seed_pool(&store);
            let host = Host::new(&store);
            let session = RoutingSession::begin(
                input(id, "gpt-test", &["codex"]),
                store.clone(),
                host,
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            let attempt = session.next_attempt().await.unwrap().unwrap();
            assert_eq!(attempt.request.provider(), UpstreamProvider::ChatgptCodex);
            session.before_dispatch(&attempt).await.unwrap();
            session.transport_started(&attempt).await.unwrap();
            let observed = session.observe_response(&attempt, head(200)).await.unwrap();
            sessions.push((session, attempt, observed, store));
        }
        let (other, other_attempt, other_head, other_store) = sessions.pop().unwrap();
        let (owner, _owner_attempt, owner_head, owner_store) = sessions.pop().unwrap();
        assert!(
            other
                .resolve_response(&other_attempt, owner_head, unknown(), None)
                .await
                .is_err()
        );
        assert!(matches!(
            other
                .resolve_response(&other_attempt, other_head, unknown(), None)
                .await
                .unwrap(),
            ResponseDecision::Return
        ));
        owner.finish(TransportObservation::default()).await.unwrap();
        other.finish(TransportObservation::default()).await.unwrap();
        assert_eq!(window(&owner_store)["committed_requests"], 1);
        assert_eq!(window(&other_store)["committed_requests"], 1);
    });
}

#[test]
fn workspace_continuation_keeps_encoded_body_attempt_and_single_claim() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        host.claude = Some(publication(None));
        host.claude_outcomes
            .lock()
            .unwrap()
            .push_back(ClaudeOutcome::WorkspaceContinuation(Box::new(publication(
                Some("actual-workspace"),
            ))));
        let session = RoutingSession::begin(
            request("workspace-one-claim", false),
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let first = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&first).await.unwrap();
        session.transport_started(&first).await.unwrap();
        let observed = session.observe_response(&first, head(400)).await.unwrap();
        let evidence =
            ClaudeErrorEvidence::from_prefix(Some(vec![b'X' as u16, 0xd800]), true).unwrap();
        let ResponseDecision::WorkspaceContinuation(continuation) = session
            .resolve_response(&first, observed, evidence, Some(failure(400)))
            .await
            .unwrap()
        else {
            panic!("expected typed workspace continuation")
        };
        let second = continuation.attempt().clone();
        assert_eq!(second.id, first.id);
        assert_eq!(second.original_request_id, first.original_request_id);
        assert_eq!(second.request.body(), first.request.body());
        assert_eq!(
            second.request.decode().response_id,
            first.request.decode().response_id
        );
        assert_eq!(
            match &second.credential {
                CredentialFence::Claude { workspace_id, .. } => workspace_id.as_ref(),
                _ => None,
            },
            Some(&gateway_core::js_string::JsString16::from_utf8(
                "actual-workspace"
            ))
        );
        assert!(session.before_dispatch(&second).await.is_err());
        session
            .before_workspace_dispatch(*continuation)
            .await
            .unwrap();
        let observed = session.observe_response(&second, head(200)).await.unwrap();
        assert!(matches!(
            session
                .resolve_response(&second, observed, unknown(), None)
                .await
                .unwrap(),
            ResponseDecision::Return
        ));
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
        assert_eq!(
            host.claude_evidence.lock().unwrap()[0],
            Some(vec![b'X' as u16, 0xd800])
        );
    });
}

#[test]
fn disabled_thinking_keeps_first_refusal_and_does_not_adopt_workspace() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        host.claude = Some(publication(None));
        host.claude_outcomes
            .lock()
            .unwrap()
            .push_back(ClaudeOutcome::WorkspaceContinuation(Box::new(publication(
                Some("must-not-use"),
            ))));
        let session = RoutingSession::begin(
            request("disabled-preserve", true),
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let first = session.next_attempt().await.unwrap().unwrap();
        let thinking =
            gateway_core::source_serialization::member(first.request.body(), "thinking").unwrap();
        assert_eq!(
            gateway_core::source_serialization::member(&thinking, "type")
                .unwrap()
                .as_str(),
            "\"disabled\""
        );
        session.before_dispatch(&first).await.unwrap();
        session.transport_started(&first).await.unwrap();
        let observed = session.observe_response(&first, head(400)).await.unwrap();
        assert!(matches!(
            session
                .resolve_response(&first, observed, unknown(), Some(failure(400)))
                .await
                .unwrap(),
            ResponseDecision::Return
        ));
        assert!(session.next_attempt().await.is_err());
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
        assert_eq!(host.consumed_heads.lock().unwrap().len(), 1);
    });
}

#[test]
fn systemone_and_retrying_job_poll_use_actual_provider_and_original_quota() {
    run(async {
        for (id, family, provider) in [
            (
                "systemone-attribution",
                ExtrasFamily::SystemOne,
                "openrouter",
            ),
            ("poll-retry", ExtrasFamily::EmbeddingJobPoll, "voyage"),
        ] {
            let store = Store::new();
            seed_key(&store);
            let session = RoutingSession::begin_extras(
                input(id, "fixture", &[]),
                store.clone(),
                Host::new(&store),
                store.clone(),
                store.clone(),
                family,
            )
            .await
            .unwrap();
            let handle = session.admission_handle();
            let children = handle.children(1).await.unwrap();
            let child = &children[0];
            let ticket = handle.before_dispatch(child).await.unwrap();
            handle.transport_started(child, &ticket).await.unwrap();
            let ticket = handle.before_dispatch(child).await.unwrap();
            handle.transport_started(child, &ticket).await.unwrap();
            handle
                .child_finished(child, TransportState::Started)
                .await
                .unwrap();
            handle
                .finish(
                    TransportObservation::default(),
                    gateway_authority::quota::KernelTerminal::Released,
                    "source-read-or-failure",
                )
                .await
                .unwrap();
            assert_eq!(window(&store)["committed_requests"], 1);
            assert_eq!(
                store.value(gateway_authority::keys::api_request(
                    "key-a",
                    &format!("v3:{}", gateway_authority::DAY_MS),
                    NOW,
                    id
                ))["provider"],
                provider
            );
        }
    });
}

#[test]
fn source_cooldown_refusal_retains_lone_surrogate_json_and_never_dispatches() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        let wire = r#"{"error":{"message":"held \ud800","type":"rate_limit_error","code":"claude_code_cooldown"}}"#;
        host.claude_refused = Some((
            429,
            BTreeMap::from([("Retry-After".into(), "9".into())]),
            gateway_core::source_json::SourceJson::parse(wire).unwrap(),
        ));
        let session = RoutingSession::begin(
            request("raw-cooldown", false),
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let error = session.next_attempt().await.err().unwrap();
        assert_eq!(error.error.status, 429);
        assert_eq!(error.headers["Retry-After"], "9");
        assert_eq!(error.source_body.unwrap().as_bytes(), wire.as_bytes());
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 0);
        assert_eq!(host.claude_heads.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn malformed_stored_claude_status_keeps_exact_plain_internal_error_without_dispatch() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        host.claude_internal_error = true;
        let session = RoutingSession::begin(
            request("plain-constructor-error", false),
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let error = session.next_attempt().await.err().unwrap();
        assert_eq!(error.error.status, 500);
        assert_eq!(error.headers["Content-Type"], "text/plain; charset=utf-8");
        assert_eq!(
            error.source_body.unwrap().as_bytes(),
            b"Internal Server Error"
        );
        session
            .finish(TransportObservation::default())
            .await
            .unwrap();
        assert_eq!(window(&store)["committed_requests"], 0);
        assert_eq!(host.claude_heads.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn invalid_image_request_releases_an_empty_source_plan_without_provider_dispatch() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let session = RoutingSession::begin_extras(
            input("image-empty-plan", "unused", &["codex"]),
            store.clone(),
            Host::new(&store),
            store.clone(),
            store.clone(),
            ExtrasFamily::ImageEdits,
        )
        .await
        .unwrap();
        let handle = session.admission_handle();
        assert!(handle.children(0).await.unwrap().is_empty());
        assert!(
            handle
                .finish(
                    TransportObservation::default(),
                    gateway_authority::quota::KernelTerminal::Committed,
                    "invalid-image"
                )
                .await
                .is_err()
        );
        let finished = handle
            .finish(
                TransportObservation::default(),
                gateway_authority::quota::KernelTerminal::Released,
                "invalid-image",
            )
            .await
            .unwrap();
        assert!(finished.settled);
        assert_eq!(window(&store)["committed_requests"], 0);
    });
}

#[test]
fn captured_default_survives_account_retry_operator_change_and_original_single_claim() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        host.claude = Some(publication(None));
        host.claude_outcomes
            .lock()
            .unwrap()
            .push_back(ClaudeOutcome::Retry);
        let input = request("captured-default-retry", false);
        let original = input.raw.clone();
        let session = RoutingSession::begin(
            input,
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let first = session.next_attempt().await.unwrap().unwrap();
        session.before_dispatch(&first).await.unwrap();
        session.transport_started(&first).await.unwrap();
        let observed = session.observe_response(&first, head(429)).await.unwrap();
        assert!(matches!(
            session
                .resolve_response(&first, observed, unknown(), Some(failure(429)))
                .await
                .unwrap(),
            ResponseDecision::Continue
        ));
        store.seed(
            gateway_schema::catalog_store::runtime_config_key(),
            json!({"default_model":"claude-sonnet-4-6","default_reasoning_effort":"none"}),
        );
        let next = session.next_attempt().await.unwrap().unwrap();
        assert_eq!(next.original_request_id, first.original_request_id);
        assert_eq!(next.request.body(), first.request.body());
        assert_eq!(session.original_source(), &original);
        assert_eq!(
            host.claude_effective.lock().unwrap().as_slice(),
            &[Some("medium".into()), Some("medium".into())]
        );
        session.before_dispatch(&next).await.unwrap();
        session.finish(Default::default()).await.unwrap();
        assert_eq!(window(&store)["committed_requests"], 1);
    });
}
