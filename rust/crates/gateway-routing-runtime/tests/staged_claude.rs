use gateway_authority::TokenSource;
use gateway_core::{
    js_string::JsString16,
    model::ModelId,
    provider::UpstreamProvider,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, RevisionCheck,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
    value::ValueEncoding,
};
use gateway_providers::{
    ClaudeBodyOptions, ClaudeCredentialKind, ClientSurface, OrdinaryPreparationContext,
    PreparedClaudeBody, prepare_source_request,
};
use gateway_routing_runtime::{currentness::*, custody, policy, session::*, types::*};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use serde_json::json;

fn publication(workspace: Option<JsString16>, kind: ClaudeCredentialKind) -> PublishedCredential {
    let mut body_options = ClaudeBodyOptions::new(kind);
    body_options.supports_disabled_thinking = true;
    body_options.native_reasoning_efforts = Some(vec!["medium".into()]);
    PublishedCredential::Claude {
        fence: CredentialFence::Claude {
            account_id: "fixture-account".into(),
            cohort_id: "fixture-cohort".into(),
            credential_fingerprint: "fixture-fingerprint".into(),
            evidence_generation: "fixture-evidence".into(),
            workspace_id: workspace,
            checks: vec![],
        },
        body_options,
    }
}
fn request(id: &str) -> RoutingInput {
    let mut request = input(id, "claude-sonnet-4-6", &["claude_code"]);
    request
        .catalog
        .providers
        .get_mut("claude_code")
        .unwrap()
        .models = vec![
        SourceJson::from_serializable(
            &json!({"id":"claude-sonnet-4-6","supported_endpoint_types":["openai-response","anthropic"],"supports_tools":true}),
        ).unwrap(),
    ];
    let fields = source::entries(&request.raw).unwrap();
    request.raw = source::object_keys(
        fields
            .into_iter()
            .filter(|(key, _)| key != &"reasoning".into())
            .collect(),
    )
    .unwrap();
    request
}
fn row_key(id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
fn set_member(document: &SourceJson, key: &str, value: SourceJson) -> SourceJson {
    let mut fields = source::entries(document).unwrap();
    if let Some((_, old)) = fields
        .iter_mut()
        .find(|(name, _)| name == &JsString16::from_utf8(key))
    {
        *old = value;
    } else {
        fields.push((JsString16::from_utf8(key), value));
    }
    source::object_keys(fields).unwrap()
}
fn preparation(input: &RoutingInput, model: &ModelId) -> OrdinaryPreparationContext {
    let mut catalog = input.catalog.clone();
    catalog.snapshot = input.catalog.codex().cloned();
    let metadata = gateway_schema::catalog::request_model_metadata(
        &catalog,
        model,
        input.surface != ClientSurface::Chat,
        NOW,
    );
    OrdinaryPreparationContext::from_metadata(&metadata, &"medium".into())
}
#[test]
fn ready_scalar_routes_match_real_original_adapter_body_headers_and_decode() {
    run(async {
        for (id, model, name) in [
            ("scalar-deepseek", "deepseek-flash", "deepseek"),
            ("scalar-lithos", "deepseek-flash", "lithos"),
            ("scalar-codex", "gpt-test", "codex"),
            ("scalar-codex-ultra", "gpt-test", "codex"),
        ] {
            let store = Store::new();
            seed_key(&store);
            seed_pool(&store);
            let host = Host::new(&store);
            let mut input = input(id, model, &[name]);
            if id.ends_with("ultra") {
                input.raw = set_member(
                    &input.raw,
                    "reasoning",
                    SourceJson::parse(r#"{"effort":"ultra"}"#).unwrap(),
                );
            }
            let session = RoutingSession::begin(
                input.clone(),
                store.clone(),
                host.clone(),
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            let attempt = session.next_attempt().await.unwrap().unwrap();
            let PreparedWireRequest::Ready(ready) = &attempt.request else {
                panic!("scalar routes must remain actual Ready requests")
            };
            let codex = match &attempt.credential {
                CredentialFence::Codex { admission, .. } => Some(admission.clone()),
                _ => None,
            };
            let PublishedCredential::Scalar {
                material,
                mut options,
                ..
            } = host
                .credential(CredentialRequest {
                    provider: ready.provider,
                    model: ready.decode.model.clone(),
                    codex,
                })
                .await
                .unwrap()
            else {
                panic!("actual scalar publication")
            };
            options.auth = material;
            options.client_version = input.client_version.clone();
            options.native_session_id = input.native_session_id.clone();
            options.response_id = ready.decode.response_id.clone();
            options.created_at = NOW / 1000;
            options.allowed_models = policy::provider_ids(&input, ready.provider);
            options.conversation_id = ready.headers.get("conversation_id").cloned();
            options.ordinary_preparation = Some(preparation(&input, &ready.decode.model));
            let raw = set_member(
                &input.raw,
                "model",
                ready.decode.model.to_source_json().unwrap(),
            );
            let expected = prepare_source_request(
                ready.provider,
                input.surface,
                &raw,
                &ready.decode.model,
                &options,
            )
            .unwrap();
            assert_eq!(ready.body, expected.body);
            assert_eq!(ready.headers, expected.headers);
            assert_eq!(
                serde_json::to_string(&ready.decode).unwrap(),
                serde_json::to_string(&expected.decode).unwrap()
            );
            assert_eq!(attempt.request.url(), expected.url);
            assert_eq!(attempt.request.method(), expected.method);
            assert_eq!(attempt.request.warnings(), expected.warnings);
            session.finish(Default::default()).await.unwrap();
        }
    });
}
#[test]
fn claude_stage_uses_real_factory_and_retains_actual_model_body_decode_without_auth() {
    run(async {
        for kind in [ClaudeCredentialKind::ApiKey, ClaudeCredentialKind::Oauth] {
            for stream in [false, true] {
                let store = Store::new();
                seed_key(&store);
                let mut host = Host::new(&store);
                host.claude = Some(publication(
                    Some(JsString16::from_units(vec![119, 0xd800])),
                    kind,
                ));
                let mut input = request("staged-body");
                input.raw = set_member(
                    &input.raw,
                    "stream",
                    SourceJson::from_serializable(&stream).unwrap(),
                );
                let session = RoutingSession::begin(
                    input.clone(),
                    store.clone(),
                    host.clone(),
                    store.clone(),
                    store.clone(),
                )
                .await
                .unwrap();
                let attempt = session.next_attempt().await.unwrap().unwrap();
                let PreparedWireRequest::Claude(body) = &attempt.request else {
                    panic!("must never fabricate Ready")
                };
                let PublishedCredential::Claude {
                    mut body_options, ..
                } = host.claude.clone().unwrap()
                else {
                    panic!("actual body options")
                };
                body_options.response_id = format!("resp_{}", attempt.id.replace('-', ""));
                body_options.created_at = NOW / 1000;
                body_options.allowed_models =
                    policy::provider_ids(&input, UpstreamProvider::ClaudeCode);
                body_options.ordinary_preparation = Some(preparation(&input, &body.decode().model));
                let expected = PreparedClaudeBody::prepare(
                    input.surface,
                    &input.raw,
                    &body.decode().model,
                    &body_options,
                )
                .unwrap();
                assert_eq!(body.body(), expected.body());
                assert_eq!(body.kind(), kind);
                assert_eq!(attempt.request.stream(), stream);
                assert_eq!(
                    serde_json::to_string(body.decode()).unwrap(),
                    serde_json::to_string(expected.decode()).unwrap()
                );
                assert_eq!(attempt.request.provider(), UpstreamProvider::ClaudeCode);
                assert_eq!(body.url(), "https://api.anthropic.com/v1/messages");
                assert_eq!(body.decode().model, ModelId::from("claude-sonnet-4-6"));
                assert!(!format!("{:?}", attempt.request).contains("source fixture"));
                assert_eq!(window(&store)["committed_requests"], 0);
                session.finish(Default::default()).await.unwrap();
            }
        }
    });
}
#[test]
fn invalid_claude_body_wins_before_hypothetical_physical_headers_without_fallback() {
    run(async {
        let store = Store::new();
        seed_key(&store);
        let mut host = Host::new(&store);
        host.claude = Some(publication(
            Some(JsString16::from_units(vec![0xd800])),
            ClaudeCredentialKind::Oauth,
        ));
        let mut input = request("staged-invalid-body");
        input.raw = set_member(&input.raw, "input", SourceJson::parse("[]").unwrap());
        let session = RoutingSession::begin(
            input,
            store.clone(),
            host.clone(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let error = session.next_attempt().await.unwrap_err();
        assert_eq!(error.error.status, 400);
        assert!(matches!(
            error.source_body,
            Some(SourceRefusalBody::Json(_))
        ));
        assert_eq!(window(&store)["committed_requests"], 0);
        let row = decode_source_control_record(
            &store
                .read(&row_key("staged-invalid-body"))
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            source::array(&source::member(&row, "attempts").unwrap())
                .unwrap()
                .is_empty()
        );
        session.finish(Default::default()).await.unwrap();
    });
}
#[test]
fn named_journal_preserves_scalar_null_and_utf16_workspace_and_exact_owner_fences() {
    run(async {
        for workspace in [
            None,
            Some("actual-workspace".into()),
            Some(JsString16::from_units(vec![119, 0xd800, 0xdc00, 0xdfff])),
        ] {
            let store = Store::new();
            seed_key(&store);
            let mut host = Host::new(&store);
            let published = publication(workspace.clone(), ClaudeCredentialKind::ApiKey);
            host.claude = Some(published.clone());
            let session = RoutingSession::begin(
                request("source-workspace"),
                store.clone(),
                host,
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            let attempt = session.next_attempt().await.unwrap().unwrap();
            let key = row_key(&attempt.original_request_id);
            let record = store.read(&key).await.unwrap().unwrap();
            let encoding = if workspace.as_ref().is_some_and(|w| w.try_utf8().is_err()) {
                ValueEncoding::ProfileV2
            } else {
                ValueEncoding::Json
            };
            assert_eq!(record.value_encoding, encoding);
            assert_eq!(record.expires_at_ms, None);
            let document = decode_source_control_record(&record).unwrap();
            let attempts = source::array(&source::member(&document, "attempts").unwrap()).unwrap();
            let fence: CredentialFence = source::member(&attempts[0], "fence")
                .unwrap()
                .deserialize()
                .unwrap();
            assert_eq!(&fence, published.fence());
            let encoded =
                encode_source_control_record(&record.revision, &document, record.expires_at_ms)
                    .unwrap();
            assert_eq!(encoded, record);
            custody::validate_journal_row(&key, &record).unwrap();
            let unknown = set_member(
                &document,
                "unknown_field",
                SourceJson::parse("null").unwrap(),
            );
            let unknown =
                encode_source_control_record(&record.revision, &unknown, record.expires_at_ms)
                    .unwrap();
            assert!(custody::validate_journal_row(&key, &unknown).is_err());
            let pending = TupleKey::from_scalar_parts(&[
                ScalarKeyPart::String("uos_ai"),
                ScalarKeyPart::String("routing_runtime"),
                ScalarKeyPart::String("v1"),
                ScalarKeyPart::String("pending"),
                ScalarKeyPart::String(&attempt.original_request_id),
            ])
            .to_record_key();
            let marker = store.read(&pending).await.unwrap().unwrap();
            custody::validate_journal_rows([(&key, &record), (&pending, &marker)]).unwrap();
            assert_eq!(
                source::number(&source::member(&document, "v").unwrap()),
                Some(3.0)
            );
            assert!(source::member(&document, "local_work").is_none());
            session.currentness().checkpoint().await.unwrap();
            let mut wrong = attempt.clone();
            if let CredentialFence::Claude { workspace_id, .. } = &mut wrong.credential {
                *workspace_id = Some("foreign-workspace".into());
            }
            assert!(session.before_dispatch(&wrong).await.is_err());
            let mut wrong_owner = attempt.clone();
            wrong_owner.original_request_id = "foreign-request".into();
            assert!(session.before_dispatch(&wrong_owner).await.is_err());
            assert_eq!(store.read(&key).await.unwrap().unwrap(), record);
            session.finish(Default::default()).await.unwrap();
            let final_row = store.read(&key).await.unwrap().unwrap();
            custody::validate_journal_row(&key, &final_row).unwrap();
            assert_eq!(
                final_row.expires_at_ms,
                Some(NOW + gateway_authority::PAID_RETENTION_MS)
            );
        }
    });
}
#[test]
fn source_workspace_reclaimed_owner_and_stale_revision_cannot_dispatch() {
    run(async {
        for reclaim in [false, true] {
            let store = Store::new();
            seed_key(&store);
            let mut host = Host::new(&store);
            let check_key =
                TupleKey::from_scalar_parts(&[ScalarKeyPart::String("fixture-claude-generation")])
                    .to_record_key();
            store.seed(check_key.clone(), json!({"generation":1}));
            let revision = store.read(&check_key).await.unwrap().unwrap().revision;
            let mut published = publication(
                Some(JsString16::from_units(vec![119, 0xdfff])),
                ClaudeCredentialKind::Oauth,
            );
            let PublishedCredential::Claude {
                fence: CredentialFence::Claude { checks, .. },
                ..
            } = &mut published
            else {
                panic!("Claude fence")
            };
            checks.push(RevisionCheckWire {
                key: check_key.clone(),
                expected_revision: Some(revision),
            });
            host.claude = Some(published);
            let session = RoutingSession::begin(
                request("workspace-reclaim"),
                store.clone(),
                host,
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            let attempt = session.next_attempt().await.unwrap().unwrap();
            if reclaim {
                let key = row_key(&attempt.original_request_id);
                let record = store.read(&key).await.unwrap().unwrap();
                let document = set_member(
                    &decode_source_control_record(&record).unwrap(),
                    "recovering",
                    SourceJson::parse("true").unwrap(),
                );
                assert_eq!(
                    store
                        .commit(AtomicTransition {
                            checks: vec![RevisionCheck {
                                key: key.clone(),
                                expected_revision: Some(record.revision)
                            }],
                            mutations: vec![RecordMutation::Put {
                                key,
                                record: encode_source_control_record(
                                    store.next_token().unwrap(),
                                    &document,
                                    record.expires_at_ms
                                )
                                .unwrap()
                            }]
                        })
                        .await
                        .unwrap(),
                    CommitOutcome::Committed
                );
                assert_eq!(
                    session.currentness().checkpoint().await.unwrap().state(),
                    RoutingLeaseState::TerminalSettlement
                );
            } else {
                store.seed(check_key, json!({"generation":2}));
            }
            assert!(session.before_dispatch(&attempt).await.is_err());
            let row = decode_source_control_record(
                &store
                    .read(&row_key(&attempt.original_request_id))
                    .await
                    .unwrap()
                    .unwrap(),
            )
            .unwrap();
            let attempts = source::array(&source::member(&row, "attempts").unwrap()).unwrap();
            assert_eq!(
                source::member(&attempts[0], "transport_started")
                    .unwrap()
                    .as_str(),
                "false"
            );
        }
    });
}
#[test]
fn crossed_publication_variants_and_fences_fail_closed_without_a_ready_request() {
    run(async {
        let mut crossed = publication(None, ClaudeCredentialKind::ApiKey);
        let PublishedCredential::Claude { fence, .. } = &mut crossed else {
            unreachable!()
        };
        *fence = CredentialFence::Direct {
            provider: UpstreamProvider::ClaudeCode,
        };
        for published in [
            crossed,
            direct_credential(
                UpstreamProvider::ClaudeCode,
                &gateway_auth::crypto::Secret::new("fixture-real-scalar".into()),
            ),
        ] {
            let store = Store::new();
            seed_key(&store);
            let mut host = Host::new(&store);
            host.claude = Some(published);
            let session = RoutingSession::begin(
                request("crossed-publication"),
                store.clone(),
                host,
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            let error = session.next_attempt().await.unwrap_err();
            assert_eq!(
                error.error.envelope.error.code.as_deref(),
                Some("routing_session_unavailable")
            );
            assert_eq!(window(&store)["committed_requests"], 0);
            session.finish(Default::default()).await.unwrap();
        }
    });
}

#[test]
fn effective_phase_reaches_lookup_before_native_body_and_retains_original_controls() {
    run(async {
        for (id, surface, effort) in [
            ("omitted-response", ClientSurface::Responses, None),
            ("explicit-none", ClientSurface::Responses, Some("none")),
            ("explicit-high", ClientSurface::Responses, Some("high")),
            ("omitted-chat", ClientSurface::Chat, None),
        ] {
            let store = Store::new();
            seed_key(&store);
            let mut host = Host::new(&store);
            let mut credential = publication(None, ClaudeCredentialKind::ApiKey);
            let PublishedCredential::Claude { body_options, .. } = &mut credential else {
                unreachable!()
            };
            body_options
                .native_reasoning_efforts
                .as_mut()
                .unwrap()
                .push("high".into());
            host.claude = Some(credential);
            let mut input = request(id);
            input.surface = surface;
            input.raw = if surface == ClientSurface::Chat {
                SourceJson::parse(r#"{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hello"}]}"#).unwrap()
            } else {
                input.raw
            };
            if let Some(effort) = effort {
                input.raw = set_member(
                    &input.raw,
                    "reasoning",
                    SourceJson::from_serializable(&json!({"effort":effort})).unwrap(),
                );
            }
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
            let attempt = session.next_attempt().await.unwrap().unwrap();
            assert_eq!(
                host.claude_effective.lock().unwrap().as_slice(),
                &[Some(JsString16::from_utf8(effort.unwrap_or("medium")))]
            );
            assert_eq!(session.original_source(), &original);
            assert_eq!(attempt.request.decode().request, original);
            assert_eq!(
                attempt.request.decode().upstream_model,
                *session.selected_model()
            );
            session.finish(Default::default()).await.unwrap();
        }
    });
}
#[test]
fn invalid_ordinary_input_never_calls_capability_lookup_and_high_only_still_refuses() {
    run(async {
        for input_kind in ["number", "empty-native", "high-only"] {
            let store = Store::new();
            seed_key(&store);
            let mut host = Host::new(&store);
            let mut credential = publication(None, ClaudeCredentialKind::ApiKey);
            let PublishedCredential::Claude { body_options, .. } = &mut credential else {
                unreachable!()
            };
            body_options.native_reasoning_efforts = Some(vec!["high".into()]);
            host.claude = Some(credential);
            let mut input = request(input_kind);
            if input_kind != "high-only" {
                // [] is valid ordinary data but invalid for this native body; numeric input is truly malformed earlier.
                input.raw = set_member(
                    &input.raw,
                    "input",
                    SourceJson::parse(if input_kind == "number" { "7" } else { "[]" }).unwrap(),
                );
            }
            let session = RoutingSession::begin(
                input,
                store.clone(),
                host.clone(),
                store.clone(),
                store.clone(),
            )
            .await
            .unwrap();
            let error = session.next_attempt().await.unwrap_err();
            assert_eq!(error.error.status, 400);
            assert_eq!(
                host.claude_effective.lock().unwrap().len(),
                usize::from(input_kind != "number")
            );
            session.finish(Default::default()).await.unwrap();
        }
    });
}
