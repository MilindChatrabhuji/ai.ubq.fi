use std::{
    cell::RefCell,
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

use gateway_admin::{keys::*, reads, *};
use gateway_auth::{crypto::Secret, upstream::*, *};
use gateway_core::{
    query::{QueryEntry, QueryPage, QueryRequest, QuerySelector, QueryStore},
    source_json::SourceJson,
    state::*,
};
use serde_json::{Value, json};

fn run<F: Future>(future: F) -> F::Output {
    let mut context = Context::from_waker(Waker::noop());
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}

#[derive(Default)]
struct Store {
    rows: RefCell<BTreeMap<String, StoredRecord>>,
}

impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut rows = self.rows.borrow_mut();
        for check in transition.checks {
            if rows.get(&check.key.0).map(|row| &row.revision) != check.expected_revision.as_ref() {
                return Ok(CommitOutcome::Conflict);
            }
        }
        for mutation in transition.mutations {
            match mutation {
                RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        Ok(CommitOutcome::Committed)
    }
}

impl QueryStore for Store {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let QuerySelector::Prefix { prefix, .. } = &request.selector else {
            return Err(GatewayError::unavailable(
                "Fixture only serves prefix queries",
                "fixture_query_denied",
            ));
        };
        let mut entries = self
            .rows
            .borrow()
            .iter()
            .filter(|(key, _)| key.as_str().starts_with(prefix.0.as_str()))
            .map(|(key, record)| QueryEntry {
                key: RecordKey(key.clone()),
                record: record.clone(),
            })
            .filter(|entry| {
                entry
                    .record
                    .expires_at_ms
                    .is_none_or(|expiry| expiry > request.now_ms)
            })
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.key.0.clone());
        if request.reverse {
            entries.reverse();
        }
        entries.truncate(request.limit as usize);
        Ok(QueryPage {
            entries,
            next_cursor: None,
        })
    }
}

fn api_key() -> ApiKeyRecord {
    serde_json::from_value(json!({
        "id":"key-1",
        "expires_at_ms":-1,
        "revoked_at_ms":null,
        "usage_limit_requests":5,
        "usage_requests":0,
        "usage_reset_at_ms":2000,
        "window_ms":1000,
        "usage_quota_version":3,
        "paid_fallback_enabled":false,
        "paid_fallback_limit_microcredits":0,
        "paid_fallback_spent_microcredits":0,
        "paid_fallback_reserved_microcredits":0,
        "paid_fallback_reservation_request_id":null,
        "name":"fixture key",
        "prefix":"u_0123456789",
        "hash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "created_at_ms":500,
        "paid_fallback_model_ids":[],
        "paid_fallback_quota_per_credit":0,
        "paid_fallback_max_exposure_microcredits":{},
        "paid_fallback_pricing_checked_at_ms":null
    }))
    .unwrap()
}

struct Host;

impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        1500
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        Ok(vec![0; len])
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture network denied",
            "fixture_network_denied",
        ))
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture kernel absent",
            "fixture_kernel_absent",
        ))
    }
}

impl gateway_auth::webauthn::WebAuthnCrypto for Host {
    async fn validate_key(
        &self,
        _: &gateway_auth::webauthn::CosePublicKey,
    ) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture verifier absent",
            "fixture_verifier_absent",
        ))
    }
    async fn verify_signature(
        &self,
        _: gateway_auth::webauthn::SignatureInput,
    ) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture verifier absent",
            "fixture_verifier_absent",
        ))
    }
}

struct Caps;

impl AdminHost for Caps {
    async fn execute(
        &self,
        operation: AdminOperation,
        _: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        Err(missing_capability(operation))
    }
    async fn prepare_key_deletion(&self, _: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        Ok(Vec::new())
    }
    async fn paid_key_policy(&self, _: &SourceJson) -> Result<PaidKeyFields, GatewayError> {
        Err(GatewayError::unavailable(
            "No pricing fixture",
            "paid_fallback_pricing_unavailable",
        ))
    }
}

fn seeded_store() -> Store {
    let store = Store::default();
    let record = api_key();
    let key = gateway_auth::api_keys::id_key(&record.policy.id);
    let RecordMutation::Put { key, record } =
        record_mutation(key, &record, None, "record-revision").unwrap()
    else {
        panic!("API key record is a put");
    };
    store.rows.borrow_mut().insert(key.0, record);
    let window = gateway_authority::keys::api_window("key-1", "v3:1000", 1000);
    store.rows.borrow_mut().insert(
        window.0,
        StoredRecord::json(
            "usage-revision",
            json!({
                "v":3,
                "key_id":"key-1",
                "policy_version":"v3:1000",
                "window_start_ms":1000,
                "window_reset_at_ms":2000,
                "committed_requests":3,
                "reserved_requests":0,
                "updated_at_ms":1100,
                "reservations":{}
            }),
            None,
        ),
    );
    store
}

fn body(response: &AuthResponse) -> Value {
    serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap()
}

fn list_request(query: &str) -> AuthRequest {
    AuthRequest {
        method: "GET".into(),
        url: format!("https://ai.ubq.fi/admin/api-keys{query}"),
        headers: BTreeMap::from([("authorization".into(), "Bearer fixture-admin".into())]),
        body: Vec::new(),
        native_peer: None,
    }
}

#[test]
fn include_usage_matches_source_truth_semantics() {
    for value in ["1", "true", "TRUE", " yes ", "\u{feff}true\u{2003}"] {
        assert!(reads::include_usage(Some(value)), "{value:?}");
    }
    for value in ["", "0", "false", "on", "no", "2", "tru", "\u{10020}true"] {
        assert!(!reads::include_usage(Some(value)), "{value:?}");
    }
    assert!(!reads::include_usage(None));
}

#[test]
fn api_key_list_usage_is_opt_in_and_marks_the_source_upstream() {
    run(async {
        let store = seeded_store();
        let response = reads::api_keys(&store, 1500).await.unwrap();
        assert_eq!(
            response.headers.get("x-uos-upstream").map(String::as_str),
            Some("chatgpt_codex")
        );
        let default = body(&response);
        assert!(default["data"][0].get("usage_requests").is_none());
        assert!(default["data"][0].get("usage").is_none());
        assert_eq!(default["data"][0]["usage_reset_at_ms"], 2000);

        let response = reads::api_keys_with_usage(&store, 1500, true)
            .await
            .unwrap();
        assert_eq!(
            response.headers.get("x-uos-upstream").map(String::as_str),
            Some("chatgpt_codex")
        );
        let included = body(&response);
        assert_eq!(included["data"][0]["usage_requests"], 3);
        assert_eq!(
            included["data"][0]["usage"],
            json!({"request_count":3,"limit":5,"reset_at_ms":2000})
        );
        assert_eq!(included["data"][0]["usage_reset_at_ms"], 2000);
    });
}

#[test]
fn admin_list_route_wires_source_include_usage_truth() {
    run(async {
        let store = seeded_store();
        let host = Host;
        let caps = Caps;
        let config = AuthConfig {
            admin_tokens: vec![Secret::new("fixture-admin".into())],
            ..Default::default()
        };
        let service = AdminService {
            store: &store,
            host: &host,
            capabilities: &caps,
            config: &config,
            release: "fixture",
        };
        let response = service
            .handle_route(&list_request("?include_usage=1"), "listed")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(body(&response)["data"][0]["usage"]["request_count"], 3);

        let response = service
            .handle_route(&list_request("?include_usage=on"), "listed")
            .await
            .unwrap()
            .unwrap();
        let body = body(&response);
        assert!(body["data"][0].get("usage_requests").is_none());
        assert!(body["data"][0].get("usage").is_none());
    });
}
