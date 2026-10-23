use gateway_auth::AuthMethod;
use gateway_authority::{
    Authority, AuthorityClock, REQUEST_LEASE_MS, TokenSource, keys,
    quota::{ApiReservation, KernelPolicy},
};
use gateway_core::{
    GatewayError,
    query::{QueryPage, QueryRequest, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_routing_runtime::{local_work::*, session::RoutingSession};
use gateway_routing_runtime_test_support::{exec::*, host::*, input::*, seed::*, store::*};
use gateway_schema::source_request::SourceRequestDocument;
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

fn key(id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}
fn local_input(store: &Store, id: &str, kernel: bool) -> LocalAdmissionInput {
    seed_key(store);
    seed_pool(store);
    let mut original = input(id, "gpt-test", &[]);
    if kernel {
        store.seed(
            keys::kernel_policy("owner", Some("repo")),
            KernelPolicy::<String, i64> {
                v: 2,
                owner: "owner".into(),
                repo: Some("repo".into()),
                usage_limit_requests: 10,
                window_ms: gateway_authority::DAY_MS,
                expires_at_ms: -1,
            },
        );
        original.context.key_id = None;
        original.principal.method = AuthMethod::GithubToken {
            owner: "owner".into(),
            repo: "repo".into(),
            state_id: "fixture".into(),
            limit_scope: "repo".into(),
        };
    }
    LocalAdmissionInput {
        metadata: LocalRequestMetadata {
            context: original.context,
            principal: original.principal,
            catalog: original.catalog,
            runtime: original.runtime,
            client_version: original.client_version,
            native_session_id: original.native_session_id,
            retry_prohibited: original.retry_prohibited,
        },
        original: SourceRequestDocument::new(original.raw).unwrap(),
    }
}
fn begin<S: QueryStore + Clone, I: TokenSource + Clone>(
    store: &Store,
    backend: S,
    tokens: I,
    host: Host,
    id: &str,
    kernel: bool,
) -> LocalWorkHandle<S, I, Store, Host> {
    run(RoutingSession::begin_local_compaction(
        local_input(store, id, kernel),
        backend,
        host,
        store.clone(),
        tokens,
    ))
    .unwrap()
}
fn api_row(store: &Store, id: &str) -> serde_json::Value {
    let api: ApiReservation = serde_json::from_value(store.value(key(id))["api"].clone()).unwrap();
    store.value(keys::api_request(
        &api.key_id.0,
        &api.policy_version,
        api.window_start_ms,
        &api.request_id.0,
    ))
}

#[test]
fn no_kernel_refresh_is_actual_coordination_only_with_unchanged_api_lease_and_one_admission() {
    let store = Store::new();
    let host = Host::new(&store);
    let local = begin(
        &store,
        store.clone(),
        store.clone(),
        host.clone(),
        "no-kernel",
        false,
    );
    let previous = run(local.checkpoint()).unwrap();
    let api = api_row(&store, "no-kernel");
    store.advance(60_000);
    let confirmed = run(local.renew_kernel()).unwrap();
    assert_eq!(confirmed.kernel_expires_at_ms(), None);
    assert_eq!(confirmed.observed_at_ms(), NOW + 60_000);
    assert_eq!(
        confirmed.request_expires_at_ms(),
        NOW + 60_000 + REQUEST_LEASE_MS
    );
    assert!(confirmed.request_expires_at_ms() > previous.request_expires_at_ms());
    let row = store.value(key("no-kernel"));
    assert_eq!(
        row["lease_expires_at_ms"],
        confirmed.request_expires_at_ms()
    );
    assert!(row["kernel"].is_null());
    assert_eq!(row["local_work"]["phase"], "running");
    assert_eq!(api_row(&store, "no-kernel"), api);
    assert_eq!(window(&store)["reserved_requests"], 1);
    assert_eq!(window(&store)["committed_requests"], 0);
    assert!(!host.cancelled.load(Ordering::SeqCst));
}

#[derive(Clone)]
struct RefreshFault {
    inner: Store,
    armed: Arc<AtomicBool>,
    apply_before_error: bool,
}
impl AuthorityStore for RefreshFault {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.inner.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let refresh=transition.mutations.iter().any(|mutation|matches!(mutation,RecordMutation::Put{key:row_key,record}
            if *row_key==key("refresh-error") && record.json_value().ok().is_some_and(|row|row["lease_expires_at_ms"].as_i64().is_some_and(|expiry|expiry>NOW+REQUEST_LEASE_MS))));
        if refresh && self.armed.swap(false, Ordering::SeqCst) {
            if self.apply_before_error {
                self.inner.commit(transition).await?;
            }
            return Err(GatewayError::unavailable(
                "fixture refresh acknowledgement failed",
                "fixture_refresh_error",
            ));
        }
        self.inner.commit(transition).await
    }
}
impl QueryStore for RefreshFault {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        self.inner.query(request).await
    }
}
#[test]
fn failed_refresh_never_returns_a_guessed_extension_even_if_acknowledgement_is_unknown() {
    for apply_before_error in [false, true] {
        let store = Store::new();
        let host = Host::new(&store);
        let fault = RefreshFault {
            inner: store.clone(),
            armed: Arc::new(AtomicBool::new(false)),
            apply_before_error,
        };
        let local = begin(
            &store,
            fault.clone(),
            store.clone(),
            host.clone(),
            "refresh-error",
            false,
        );
        let prior = run(local.checkpoint()).unwrap();
        let api = api_row(&store, "refresh-error");
        store.advance(60_000);
        fault.armed.store(true, Ordering::SeqCst);
        assert!(run(local.renew_kernel()).is_err());
        assert_eq!(prior.request_expires_at_ms(), NOW + REQUEST_LEASE_MS);
        assert_eq!(prior.kernel_expires_at_ms(), None);
        assert_eq!(
            store.value(key("refresh-error"))["lease_expires_at_ms"],
            if apply_before_error {
                NOW + 60_000 + REQUEST_LEASE_MS
            } else {
                NOW + REQUEST_LEASE_MS
            }
        );
        assert_eq!(api_row(&store, "refresh-error"), api);
        assert!(!host.cancelled.load(Ordering::SeqCst));
    }
}

#[derive(Clone, Copy)]
enum Race {
    Nonce,
    Reclaimed,
    ApiReleased,
}
#[derive(Clone)]
struct RacingTokens {
    store: Store,
    armed: Arc<Mutex<Option<Race>>>,
}
impl TokenSource for RacingTokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        if let Some(race) = self.armed.lock().unwrap().take() {
            let mut row = self.store.value(key("coordination-race"));
            match race {
                Race::Nonce => {
                    row["local_work"]["owner_nonce"] = json!("foreign-owner");
                    self.store.seed(key("coordination-race"), row);
                }
                Race::Reclaimed => {
                    row["recovering"] = json!(true);
                    self.store.seed(key("coordination-race"), row);
                }
                Race::ApiReleased => {
                    let api: ApiReservation = serde_json::from_value(row["api"].clone()).unwrap();
                    run(Authority::with_clock(
                        self.store.clone(),
                        self.store.clone(),
                        self.store.clone(),
                    )
                    .release_api_key(
                        &api,
                        true,
                        "fixture concurrent cleanup",
                        self.store.now_ms()?,
                    ))?;
                }
            }
        }
        self.store.next_token()
    }
}
#[test]
fn refresh_cas_preserves_actual_nonce_reclaimed_owner_and_api_revision_fences() {
    for race in [Race::Nonce, Race::Reclaimed, Race::ApiReleased] {
        let store = Store::new();
        let host = Host::new(&store);
        let tokens = RacingTokens {
            store: store.clone(),
            armed: Arc::new(Mutex::new(None)),
        };
        let local = begin(
            &store,
            store.clone(),
            tokens.clone(),
            host.clone(),
            "coordination-race",
            false,
        );
        store.advance(60_000);
        *tokens.armed.lock().unwrap() = Some(race);
        assert!(run(local.renew_kernel()).is_err());
        let row = store.value(key("coordination-race"));
        assert_eq!(row["lease_expires_at_ms"], NOW + REQUEST_LEASE_MS);
        match race {
            Race::Nonce => assert_eq!(row["local_work"]["owner_nonce"], "foreign-owner"),
            Race::Reclaimed => assert_eq!(row["recovering"], true),
            Race::ApiReleased => {
                assert_eq!(api_row(&store, "coordination-race")["state"], "released")
            }
        }
        assert!(row["kernel"].is_null());
        assert!(!host.cancelled.load(Ordering::SeqCst));
    }
}
#[test]
fn expired_or_cancelled_original_cannot_be_revived_and_coordination_never_aborts_the_caller() {
    for expired in [false, true] {
        let store = Store::new();
        let host = Host::new(&store);
        let local = begin(
            &store,
            store.clone(),
            store.clone(),
            host.clone(),
            "expired-owner",
            false,
        );
        let before = store.value(key("expired-owner"));
        if expired {
            store.advance(REQUEST_LEASE_MS);
        } else {
            host.cancelled.store(true, Ordering::SeqCst);
        }
        assert!(run(local.renew_kernel()).is_err());
        assert_eq!(store.value(key("expired-owner")), before);
        assert_eq!(host.cancelled.load(Ordering::SeqCst), !expired);
    }
}
#[test]
fn only_an_actual_kernel_reservation_supplies_a_kernel_expiry_observation() {
    let store = Store::new();
    let host = Host::new(&store);
    let local = begin(
        &store,
        store.clone(),
        store.clone(),
        host.clone(),
        "real-kernel",
        true,
    );
    store.advance(60_000);
    let lease = run(local.renew_kernel()).unwrap();
    assert_eq!(
        lease.kernel_expires_at_ms(),
        Some(NOW + 60_000 + REQUEST_LEASE_MS)
    );
    assert_eq!(
        lease.request_expires_at_ms(),
        lease.kernel_expires_at_ms().unwrap()
    );
    store.advance(REQUEST_LEASE_MS);
    assert!(run(local.renew_kernel()).is_err());
    assert!(!host.cancelled.load(Ordering::SeqCst));
}
