use gateway_authority::{Authority, AuthorityClock, TokenSource, quota::ApiReservation};
use gateway_core::{
    GatewayError,
    source_json::SourceJson,
    source_serialization as source,
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_routing_runtime::{
    local_work::{LocalAdmissionInput, LocalProviderAdmission, LocalRequestMetadata},
    session::RoutingSession,
    types::{RoutingInput, SourceRefusalBody},
};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use gateway_schema::{request::RequestSurface, source_request::SourceRequestDocument};
use std::sync::{Arc, Mutex};
fn metadata(input: RoutingInput) -> LocalRequestMetadata {
    LocalRequestMetadata {
        context: input.context,
        principal: input.principal,
        catalog: input.catalog,
        runtime: input.runtime,
        client_version: input.client_version,
        native_session_id: input.native_session_id,
        retry_prohibited: input.retry_prohibited,
    }
}
fn admission(
    store: &Store,
    id: &str,
    raw: &str,
) -> LocalProviderAdmission<Store, Store, Store, Host> {
    admission_with_tokens(store, id, raw, store.clone())
}
fn admission_with_tokens<I: TokenSource + Clone>(
    store: &Store,
    id: &str,
    raw: &str,
    tokens: I,
) -> LocalProviderAdmission<Store, I, Store, Host> {
    seed_key(store);
    seed_pool(store);
    let original = SourceRequestDocument::new(SourceJson::parse(raw).unwrap()).unwrap();
    let local = run(RoutingSession::begin_local_compaction(
        LocalAdmissionInput {
            metadata: metadata(input(id, "gpt-test", &[])),
            original,
        },
        store.clone(),
        Host::new(store),
        store.clone(),
        tokens,
    ))
    .unwrap();
    run(local.resume_original()).unwrap()
}
fn session_key(id: &str) -> gateway_core::state::RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
#[test]
fn neutral_input_keeps_exact_original_and_lazy_controls() {
    let original=SourceJson::parse(r#"{"model":"openrouter/example","messages":[{"role":"vendor","content":{}}],"instructions":"\ud800","stream":"native"}"#).unwrap();
    let document = SourceRequestDocument::new(original.clone()).unwrap();
    let request = RoutingInput::from_source_request(
        metadata(input("neutral-source", "gpt-test", &[])),
        document.for_surface(RequestSurface::ChatCompletions),
    );
    assert_eq!(request.original_source(), &original);
    assert!(!request.streamed());
    assert_eq!(
        source::string(&request.source_member("instructions").unwrap())
            .unwrap()
            .as_units(),
        &[0xd800]
    );
}
#[test]
fn local_factory_reuses_original_identity_digest_and_one_reservation() {
    let store = Store::new();
    let source = r#"{"model":"gpt-test","input":"\ud800","instructions":"astral😀\udfff","reasoning":{"effort":"none"}}"#;
    let admission = admission(&store, "real-factory", source);
    let key = gateway_core::tuple_key::TupleKey::from_scalar_parts(&[
        gateway_core::tuple_key::ScalarKeyPart::String("uos_ai"),
        gateway_core::tuple_key::ScalarKeyPart::String("routing_runtime"),
        gateway_core::tuple_key::ScalarKeyPart::String("v1"),
        gateway_core::tuple_key::ScalarKeyPart::String("session"),
        gateway_core::tuple_key::ScalarKeyPart::String("real-factory"),
    ])
    .to_record_key();
    let before = store.value(key.clone());
    let pool = store.value(source_key());
    let context = admission.original_context().clone();
    let session = run(RoutingSession::from_local_admission(admission)).unwrap();
    assert_eq!(session.original_context(), &context);
    assert_eq!(
        session.original_source(),
        &SourceJson::parse(source).unwrap()
    );
    let after = store.value(key);
    assert_eq!(after["v"], 2);
    assert_eq!(after["local_work"]["phase"], "provider_planned");
    for field in ["context", "input_digest", "api", "kernel", "attempts"] {
        assert_eq!(before[field], after[field], "{field}")
    }
    assert_eq!(window(&store)["reserved_requests"], 1);
    assert_eq!(window(&store)["committed_requests"], 0);
    assert_eq!(store.value(source_key()), pool);
}
#[test]
fn local_factory_source_failure_cleans_original_without_provider_exposure() {
    let store = Store::new();
    let admission = admission(
        &store,
        "failed-source-factory",
        r#"{"model":"gpt-test","input":"valid","\ud800":1}"#,
    );
    let pool = store.value(source_key());
    let error = match run(RoutingSession::from_local_admission(admission)) {
        Ok(_) => panic!("unknown source field accepted"),
        Err(error) => error,
    };
    assert_eq!(error.error.status, 400);
    let Some(SourceRefusalBody::Json(body)) = error.source_body else {
        panic!("source error body discarded")
    };
    let error = source::member(&body, "error").unwrap();
    let message = source::string(&source::member(&error, "message").unwrap()).unwrap();
    assert_eq!(message.as_units().last(), Some(&0xd800));
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(window(&store)["committed_requests"], 0);
    assert_eq!(store.value(source_key()), pool);
}

#[test]
fn fresh_ordinary_v3_binds_canonical_original_without_persisting_payload() {
    let store = Store::new();
    seed_key(&store);
    seed_pool(&store);
    let mut request = input("ordinary-source-v3", "gpt-test", &[]);
    request.raw = SourceJson::parse(
        r#"{"model":"gpt-test","input":"\ud800","metadata":{"2":1,"2":2,"n":-0}}"#,
    )
    .unwrap();
    let expected =
        gateway_routing_runtime::local_work::original_source_digest(request.original_source())
            .unwrap();
    let original = request.raw.clone();
    let session = run(RoutingSession::begin(
        request,
        store.clone(),
        Host::new(&store),
        store.clone(),
        store.clone(),
    ))
    .unwrap();
    assert_eq!(session.original_source(), &original);
    let key = gateway_core::tuple_key::TupleKey::from_scalar_parts(&[
        gateway_core::tuple_key::ScalarKeyPart::String("uos_ai"),
        gateway_core::tuple_key::ScalarKeyPart::String("routing_runtime"),
        gateway_core::tuple_key::ScalarKeyPart::String("v1"),
        gateway_core::tuple_key::ScalarKeyPart::String("session"),
        gateway_core::tuple_key::ScalarKeyPart::String("ordinary-source-v3"),
    ])
    .to_record_key();
    let row = store.value(key);
    assert_eq!(row["v"], 3);
    assert_eq!(row["input_digest"], expected);
    assert!(row.get("local_work").is_none());
    assert!(row.get("raw").is_none());
    assert!(row.get("input").is_none());
    assert_eq!(window(&store)["reserved_requests"], 1);
}

#[test]
fn attest_retains_original_constructor_inputs_and_one_admission() {
    let store = Store::new();
    let raw = r#"{"model":"gpt-test","input":"source fixture","reasoning":{"effort":"none"}}"#;
    let expected = input("factory-owner", "gpt-test", &[]);
    let admission = admission(&store, "factory-owner", raw);
    assert_eq!(admission.original_context(), &expected.context);
    assert_eq!(
        admission.original_source(),
        &SourceJson::parse(raw).unwrap()
    );
    let key = session_key("factory-owner");
    let before = store.value(key.clone());
    let pool = store.value(source_key());
    let original = admission.original_source().clone();
    let context = admission.original_context().clone();
    let session = run(RoutingSession::from_local_admission(admission)).unwrap();
    assert_eq!(session.original_source(), &original);
    assert_eq!(session.original_context(), &context);
    assert!(session.selected_model().matches_scalar("gpt-test"));
    let after = store.value(key);
    assert_eq!(after["local_work"]["phase"], "provider_planned");
    for field in ["context", "input_digest", "api", "kernel", "attempts"] {
        assert_eq!(before[field], after[field], "{field}");
    }
    assert_eq!(window(&store)["reserved_requests"], 1);
    assert_eq!(store.value(source_key()), pool);
}

#[test]
fn failed_planning_cleans_expired_original_without_provider_terminal_or_new_admission() {
    let store = Store::new();
    // The unknown model makes the public constructor take its planning-failure cleanup path.
    let admission = admission(
        &store,
        "factory-owner",
        r#"{"model":"unavailable-model","input":"source fixture","reasoning":{"effort":"none"}}"#,
    );
    store.advance(gateway_authority::REQUEST_LEASE_MS + 1);
    assert!(run(RoutingSession::from_local_admission(admission)).is_err());
    let row = store.value(session_key("factory-owner"));
    assert_eq!(row["local_work"]["terminal"]["semantic"], "incomplete");
    assert_eq!(row["attempts"], serde_json::json!([]));
    assert_eq!(row["finished"], true);
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(window(&store)["committed_requests"], 0);
}

#[derive(Clone)]
struct RacingTokens {
    store: Store,
    release: Arc<Mutex<Option<ApiReservation>>>,
    tokens_before_release: Arc<Mutex<u8>>,
}
impl TokenSource for RacingTokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        let mut remaining = self.tokens_before_release.lock().unwrap();
        if *remaining > 0 {
            *remaining -= 1;
            return self.store.next_token();
        }
        drop(remaining);
        if let Some(api) = self.release.lock().unwrap().take() {
            run(
                Authority::with_clock(self.store.clone(), self.store.clone(), self.store.clone())
                    .release_api_key(&api, true, "fixture-final-phase-race", self.store.now_ms()?),
            )?;
        }
        self.store.next_token()
    }
}

#[test]
fn attest_phase_cas_cannot_ignore_a_reservation_released_after_observation() {
    let store = Store::new();
    let tokens = RacingTokens {
        store: store.clone(),
        release: Arc::new(Mutex::new(None)),
        tokens_before_release: Arc::new(Mutex::new(0)),
    };
    let admission = admission_with_tokens(
        &store,
        "factory-owner",
        r#"{"model":"gpt-test","input":"source fixture","reasoning":{"effort":"none"}}"#,
        tokens.clone(),
    );
    let api: ApiReservation =
        serde_json::from_value(store.value(session_key("factory-owner"))["api"].clone()).unwrap();
    *tokens.release.lock().unwrap() = Some(api);
    // The public constructor first spends one token on the conversation identity.
    *tokens.tokens_before_release.lock().unwrap() = 1;
    assert!(run(RoutingSession::from_local_admission(admission)).is_err());
    let row = store.value(session_key("factory-owner"));
    assert_eq!(row["local_work"]["phase"], "planning");
    assert_eq!(row["attempts"], serde_json::json!([]));
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(window(&store)["committed_requests"], 0);
}
