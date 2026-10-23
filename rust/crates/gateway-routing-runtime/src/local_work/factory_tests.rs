mod support;

use super::*;
use std::sync::{Arc, Mutex};
use support::*;

fn admission<I: TokenSource + Clone>(
    store: &Store,
    tokens: I,
) -> (LocalProviderAdmission<Store, I, Store, Host>, RoutePlan) {
    seed_key(store);
    seed_pool(store);
    let fixture = input("factory-owner", "gpt-test", &[]);
    // This matching scalar source fixture exercises the real existing planner;
    // it is not a product Value adapter or acceptance of the pending M05 factory.
    let source = SourceJson::parse(&serde_json::to_string(&fixture.raw).unwrap()).unwrap();
    let collator = Host::new(store).source_string_collator();
    let plan = crate::policy::plan(&fixture, NOW, collator.as_ref()).unwrap();
    let local = run(RoutingSession::begin_local_compaction(
        LocalAdmissionInput {
            metadata: LocalRequestMetadata {
                context: fixture.context,
                principal: fixture.principal,
                catalog: fixture.catalog,
                runtime: fixture.runtime,
                client_version: fixture.client_version,
                native_session_id: fixture.native_session_id,
                retry_prohibited: fixture.retry_prohibited,
            },
            original: SourceRequestDocument::new(source).unwrap(),
        },
        store.clone(),
        Host::new(store),
        store.clone(),
        tokens,
    ))
    .unwrap();
    (run(local.resume_original()).unwrap(), plan)
}

#[test]
fn attest_retains_original_constructor_inputs_and_one_admission() {
    let store = Store::new();
    let (admission, plan) = admission(&store, store.clone());
    let before = store.value(journal::key("factory-owner"));
    let pool = store.value(source_key());
    let original = admission.original_source().clone();
    assert_eq!(
        admission.original_metadata().context,
        admission.original_context().clone()
    );
    let parts = run(admission.attest_plan(plan)).unwrap();
    assert_eq!(parts.input.original.original_source(), &original);
    assert!(parts.plan.model.matches_scalar("gpt-test"));
    let after = parts.store.value(journal::key("factory-owner"));
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
    let (admission, _) = admission(&store, store.clone());
    store.advance(gateway_authority::REQUEST_LEASE_MS + 1);
    let result = run(admission.fail_planning()).unwrap();
    assert!(result.settled);
    assert!(result.observation.semantic_terminal.is_none());
    let row = store.value(journal::key("factory-owner"));
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
}
impl TokenSource for RacingTokens {
    fn next_token(&self) -> Result<String, GatewayError> {
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
    };
    let (admission, plan) = admission(&store, tokens.clone());
    *tokens.release.lock().unwrap() = admission.original.api.clone();
    assert!(run(admission.attest_plan(plan)).is_err());
    let row = store.value(journal::key("factory-owner"));
    assert_eq!(row["local_work"]["phase"], "planning");
    assert_eq!(row["attempts"], serde_json::json!([]));
    assert_eq!(window(&store)["reserved_requests"], 0);
    assert_eq!(window(&store)["committed_requests"], 0);
}
