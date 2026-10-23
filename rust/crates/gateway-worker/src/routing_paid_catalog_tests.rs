use super::prepare_credential_catalog;
#[path = "../../gateway-schema/tests/support/source_catalog.rs"]
mod source_catalog;
use gateway_auth::{
    crypto::{Secret, base64url},
    native::NATIVE_PUBLICATION_PATH,
    native_auth::{
        NativeAuthHeaders, NativeAuthenticator, NativeCapability, NativeTransportIdentity,
    },
    native_replay::StoreNonceAuthority,
};
use gateway_authority::{
    Authority, TokenSource, keys,
    paid::PaidRequest,
    paid_control::{PaidRequestContext, PaidRoutingProjection, paid_projection_source_keys},
};
use gateway_catalog_runtime::{
    CatalogFetch, CatalogFetchResponse, CatalogHost, CatalogProvider, CredentialPublication,
    ProviderBinding,
};
use gateway_core::{
    GatewayError,
    identity::{ApiKeyId, PaidAttemptId, RequestId},
    provider::{PaidProvider, UpstreamProvider},
    query::{QueryPage, QueryRequest, QueryStore},
    source_control::decode_source_control_record,
    source_json::SourceJson,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
};
use gateway_publication::{
    control_publication::{
        ConfiguredPaidInputs, PreparedConfigurationPublication, bootstrap_fixture_owner,
        fixture_owner_statement, runtime_config_key,
    },
    transport::{
        NativePublicationSender, PublicationCarrier, PublicationReceiver, PublicationRequest,
        PublicationResponse,
    },
};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    future::Future,
    rc::Rc,
    sync::Arc,
    task::{Context, Poll, Waker},
};
const NOW: i64 = 1_800_000_000_000;
fn now() -> i64 {
    NOW
}
fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("fixed synthetic publication must complete without real I/O"),
    }
}
#[derive(Clone, Default)]
struct Store {
    rows: Rc<RefCell<BTreeMap<String, StoredRecord>>>,
    projections: Rc<Cell<usize>>,
    conflict: Rc<Cell<bool>>,
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let projection = tx
            .mutations
            .iter()
            .any(|m| matches!(m, RecordMutation::Put{key,..} if *key==keys::paid_routing()));
        let mut rows = self.rows.borrow_mut();
        if (projection && self.conflict.get())
            || tx
                .checks
                .iter()
                .any(|c| rows.get(&c.key.0).map(|r| &r.revision) != c.expected_revision.as_ref())
        {
            return Ok(CommitOutcome::Conflict);
        }
        for mutation in tx.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        if projection {
            self.projections.set(self.projections.get() + 1);
        }
        Ok(CommitOutcome::Committed)
    }
}
impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        request.validate()?;
        panic!("fixed paid publisher must not scan unrelated state")
    }
}
struct Carrier<'a> {
    store: &'a Store,
    receiver: &'a PublicationReceiver,
}
impl PublicationCarrier for Carrier<'_> {
    async fn send(&self, request: PublicationRequest) -> Result<PublicationResponse, GatewayError> {
        Ok(self.receiver.handle(self.store, request).await)
    }
}
async fn install(store: &Store) -> ConfiguredPaidInputs {
    let identity = NativeTransportIdentity::new(
        "fixture-test-key".into(),
        "fixture-test-owner".into(),
        "fixture-test-epoch".into(),
        [31; 32],
        BTreeSet::from([NativeCapability::ConfigurationPublish]),
    )
    .unwrap();
    let inputs = ConfiguredPaidInputs::new(
        Some(Secret::new("synthetic-surplus-only".into())),
        None,
        None,
        json!({"test":"selected-paid-hop"}),
    )
    .unwrap();
    let receiver =
        PublicationReceiver::configured(identity.clone(), inputs.clone(), Vec::new(), now).unwrap();
    let body = fixture_owner_statement(&identity).unwrap();
    let nonce = base64url(&[1; 32]);
    let time = NOW.to_string();
    let mac = identity
        .sign(NATIVE_PUBLICATION_PATH, NOW, &nonce, &body)
        .unwrap();
    let replay = StoreNonceAuthority::new(store);
    let proof = NativeAuthenticator::new(&identity, &replay)
        .authenticate(
            NATIVE_PUBLICATION_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: identity.key_id(),
                time_ms: &time,
                nonce: &nonce,
                mac: &mac,
            },
            &body,
            NOW,
        )
        .await
        .unwrap();
    bootstrap_fixture_owner(store, &identity, &proof, NOW, "signed-owner")
        .await
        .unwrap();
    let prepared = PreparedConfigurationPublication::capture(
        store,
        &identity,
        &inputs,
        "signed-config-generation",
        NOW,
    )
    .await
    .unwrap();
    NativePublicationSender::configured(
        &identity,
        &Carrier {
            store,
            receiver: &receiver,
        },
    )
    .send(&prepared.command("signed-config").unwrap(), [2; 32], NOW)
    .await
    .unwrap();
    inputs
}
struct Host {
    publication: CredentialPublication,
    publications: Cell<usize>,
    requests: RefCell<Vec<CatalogFetch>>,
    sequence: Cell<usize>,
    status: u16,
}
impl Host {
    fn new(inputs: Option<&ConfiguredPaidInputs>) -> Self {
        Self {
            publication: CredentialPublication {
                providers: inputs
                    .map(|i| {
                        BTreeMap::from([(
                            CatalogProvider::Surplus,
                            ProviderBinding {
                                identity: i.binding(PaidProvider::Surplus).unwrap(),
                            },
                        )])
                    })
                    .unwrap_or_default(),
                ..Default::default()
            },
            publications: Cell::new(0),
            requests: RefCell::default(),
            sequence: Cell::new(0),
            status: 200,
        }
    }
}
impl CatalogHost for Host {
    fn source_string_collator(&self) -> Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        Arc::new(source_catalog::Collator::captured())
    }
    fn now_ms(&self) -> i64 {
        NOW
    }
    fn unique_id(&self) -> String {
        let n = self.sequence.get() + 1;
        self.sequence.set(n);
        format!("real-publisher-{n}")
    }
    async fn wait(&self, _: u32) -> Result<(), GatewayError> {
        panic!("unexpected catalog wait")
    }
    async fn publication(&self) -> Result<CredentialPublication, GatewayError> {
        self.publications.set(self.publications.get() + 1);
        Ok(self.publication.clone())
    }
    async fn fetch(&self, request: CatalogFetch) -> Result<CatalogFetchResponse, GatewayError> {
        assert!(matches!(
            &request,
            CatalogFetch::Provider {
                provider: CatalogProvider::Surplus,
                ..
            } | CatalogFetch::AnonymousSurplus
        ));
        self.requests.borrow_mut().push(request);
        Ok(CatalogFetchResponse::json(self.status,source_catalog::json(&json!({"data":[{"id":"gpt-known","supported_endpoint_types":["openai-response","openai"],"supported_parameters":["tools","tool_choice"],"supported_features":["tools"],"pricing":{"prompt":"0.001","completion":"0.002"}}]})).as_str().to_owned()))
    }
}
struct Clock;
impl gateway_authority::AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(NOW)
    }
}
struct Tokens;
impl TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok("synthetic-authority-token".into())
    }
}
fn request() -> (PaidRequest, PaidRequestContext) {
    (
        PaidRequest {
            key_id: ApiKeyId("key".into()),
            request_id: RequestId("request".into()),
            attempt_id: PaidAttemptId("attempt".into()),
            provider: PaidProvider::Surplus,
            model: "gpt-known".into(),
            route: "responses".into(),
            path: "/v1/responses".into(),
            stream: false,
            reasoning: None,
            created_at_ms: NOW,
        },
        PaidRequestContext {
            original_model: "gpt-known".into(),
            body: SourceJson::parse(r#"{"model":"gpt-known","input":"test"}"#).unwrap(),
            surface: gateway_providers::ClientSurface::Responses,
            synthetic_hop: None,
        },
    )
}
#[test]
fn selected_paid_credential_publishes_real_fenced_catalog_once_before_authority_receipt() {
    run(async {
        let store = Store::default();
        let inputs = install(&store).await;
        let host = Host::new(Some(&inputs));
        let authority = Authority::with_clock(store.clone(), Tokens, Clock)
            .with_source_string_collator(Arc::new(source_catalog::Collator::captured()));
        let (request, context) = request();
        let missing = authority
            .authorize_paid_route(&request, &context, NOW)
            .await
            .unwrap_err();
        assert_eq!(
            missing.envelope.error.message,
            "Paid routing projection is missing."
        );
        assert_eq!(store.projections.get(), 0);
        prepare_credential_catalog(UpstreamProvider::Surplus, &store, &host)
            .await
            .unwrap();
        assert_eq!(host.requests.borrow().len(), 1);
        assert_eq!(store.projections.get(), 1);
        let row = store.read(&keys::paid_routing()).await.unwrap().unwrap();
        let projection: PaidRoutingProjection = decode_source_control_record(&row)
            .unwrap()
            .deserialize()
            .unwrap();
        for key in paid_projection_source_keys() {
            assert!(
                projection
                    .provenance
                    .source_checks
                    .iter()
                    .any(|c| c.key == key.0)
            );
        }
        for _ in 0..3 {
            authority
                .authorize_paid_route(&request, &context, NOW)
                .await
                .unwrap();
        }
        assert_eq!(
            store
                .read(&keys::paid_routing())
                .await
                .unwrap()
                .unwrap()
                .revision,
            row.revision
        );
        assert_eq!(store.projections.get(), 1);
        assert_eq!(host.requests.borrow().len(), 1);
        // A later runtime mutation must fail currentness, not republish configuration.
        store.rows.borrow_mut().insert(
            runtime_config_key().0,
            StoredRecord::json("new-runtime", json!({"version":2}), None),
        );
        assert!(
            authority
                .authorize_paid_route(&request, &context, NOW)
                .await
                .is_err()
        );
        assert!(
            prepare_credential_catalog(UpstreamProvider::Surplus, &store, &host)
                .await
                .is_err()
        );
        assert_eq!(store.projections.get(), 1);
        assert_eq!(host.requests.borrow().len(), 1);
    });
}
#[test]
fn primary_credentials_do_not_publish_or_discover_paid_catalogs() {
    run(async {
        let store = Store::default();
        let host = Host::new(None);
        for provider in [
            UpstreamProvider::ChatgptCodex,
            UpstreamProvider::ClaudeCode,
            UpstreamProvider::Deepseek,
            UpstreamProvider::Cerebras,
            UpstreamProvider::Lithos,
            UpstreamProvider::Openrouter,
        ] {
            prepare_credential_catalog(provider, &store, &host)
                .await
                .unwrap();
        }
        assert_eq!(host.publications.get(), 0);
        assert!(host.requests.borrow().is_empty());
        assert!(store.rows.borrow().is_empty());
    });
}
#[test]
fn missing_owner_wrong_binding_and_projection_cas_conflict_refuse() {
    run(async {
        let empty = Store::default();
        let host = Host::new(None);
        assert!(
            prepare_credential_catalog(UpstreamProvider::Surplus, &empty, &host)
                .await
                .is_err()
        );
        assert!(host.requests.borrow().is_empty());
        let store = Store::default();
        let inputs = install(&store).await;
        let mut host = Host::new(Some(&inputs));
        host.publication
            .providers
            .get_mut(&CatalogProvider::Surplus)
            .unwrap()
            .identity = "wrong-owner-binding".into();
        assert!(
            prepare_credential_catalog(UpstreamProvider::Surplus, &store, &host)
                .await
                .is_err()
        );
        assert!(host.requests.borrow().is_empty());
        let host = Host::new(Some(&inputs));
        store.conflict.set(true);
        assert!(
            prepare_credential_catalog(UpstreamProvider::Surplus, &store, &host)
                .await
                .is_err()
        );
        assert_eq!(host.requests.borrow().len(), 1);
        assert_eq!(store.projections.get(), 0);
        assert!(store.read(&keys::paid_routing()).await.unwrap().is_none());
    });
}

#[test]
fn failed_discovery_does_not_invent_an_observation_or_paid_authority() {
    run(async {
        let store = Store::default();
        let inputs = install(&store).await;
        let mut host = Host::new(Some(&inputs));
        host.status = 500;
        let _ = prepare_credential_catalog(UpstreamProvider::Surplus, &store, &host).await;
        let authority = Authority::with_clock(store.clone(), Tokens, Clock)
            .with_source_string_collator(Arc::new(source_catalog::Collator::captured()));
        let (request, context) = request();
        assert!(
            authority
                .authorize_paid_route(&request, &context, NOW)
                .await
                .is_err()
        );
        assert_eq!(host.requests.borrow().len(), 1);
        assert!(
            store
                .read(&keys::paid_control_observation(PaidProvider::Surplus))
                .await
                .unwrap()
                .is_none()
        );
    });
}
