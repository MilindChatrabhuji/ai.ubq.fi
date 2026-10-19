use gateway_admin::{kernel_keys, keys, source_input as input, *};
use gateway_auth::{crypto::Secret, upstream::*, *};
use gateway_core::{
    js_string::JsString16, model::ModelId, query::*, source_control::decode_source_control_record,
    source_json::SourceJson, state::*, value::ValueEncoding,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

const NOW: i64 = 1_000_000;
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
    conflict: Cell<bool>,
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Ok(self.rows.borrow().get(&key.0).cloned())
    }
    async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if self.conflict.replace(false) {
            return Ok(CommitOutcome::Conflict);
        }
        let mut rows = self.rows.borrow_mut();
        if tx
            .checks
            .iter()
            .any(|c| rows.get(&c.key.0).map(|r| &r.revision) != c.expected_revision.as_ref())
        {
            return Ok(CommitOutcome::Conflict);
        }
        for m in tx.mutations {
            match m {
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
    async fn query(&self, _: QueryRequest) -> Result<QueryPage, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture forbids queries",
            "fixture_query_denied",
        ))
    }
}
#[derive(Default)]
struct Host(Cell<u8>);
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        NOW
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.0.get().wrapping_add(1);
        self.0.set(n);
        Ok((0..len).map(|i| n.wrapping_add(i as u8)).collect())
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(GatewayError::unavailable(
            "Fixture forbids network",
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
            "Fixture forbids kernel policy creation",
            "fixture_policy_denied",
        ))
    }
}
#[derive(Default)]
struct Caps {
    seen: RefCell<Vec<SourceJson>>,
}
impl AdminHost for Caps {
    async fn execute(
        &self,
        _: AdminOperation,
        input: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        assert!(input.actor.is_admin);
        self.seen.borrow_mut().push(input.body.clone());
        Ok(AuthResponse::source_json(200, input.body))
    }
    async fn prepare_key_deletion(&self, _: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        Err(missing_capability(AdminOperation::ApiKeysDelete))
    }
    async fn paid_key_policy(&self, body: &SourceJson) -> Result<PaidKeyFields, GatewayError> {
        assert_eq!(
            input::member(body, "paid_fallback_enabled")
                .as_ref()
                .and_then(input::boolean),
            Some(true)
        );
        let model = ModelId::from_source(JsString16::from_units(vec![109, 0xd800]));
        Ok(PaidKeyFields {
            enabled: true,
            limit_microcredits: 1_000_000,
            model_ids: vec![model.clone()],
            quota_per_credit: 1_000_000,
            max_exposure_microcredits: BTreeMap::from([(model, 1000)]),
            pricing_checked_at_ms: Some(NOW),
        })
    }
}
fn actor() -> AuthPrincipal {
    AuthPrincipal {
        token: None,
        method: AuthMethod::AdminAllowlist,
        is_admin: true,
        is_super_admin: true,
    }
}
fn config() -> AuthConfig {
    AuthConfig {
        admin_tokens: vec![Secret::new("fixture-admin".into())],
        production: true,
        ..Default::default()
    }
}
fn request(method: &str, path: &str, body: Vec<u8>) -> AuthRequest {
    AuthRequest {
        method: method.into(),
        url: format!("https://ai.ubq.fi{path}"),
        headers: BTreeMap::from([("authorization".into(), "Bearer fixture-admin".into())]),
        body,
        native_peer: None,
    }
}
fn response_source(response: &AuthResponse) -> SourceJson {
    SourceJson::parse_bytes(&response.body.to_bytes().unwrap()).unwrap()
}
fn field_text(body: &SourceJson, name: &str) -> JsString16 {
    input::member(body, name)
        .as_ref()
        .and_then(input::text)
        .unwrap()
}

#[test]
fn observed_bun_parser_matrix_reaches_the_same_create_phase() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/admin-source-parser-golden.json")).unwrap();
    assert_eq!(golden["bun"], "1.4.0");
    let mut count = 0;
    for case in golden["rows"].as_array().unwrap() {
        run(async {
            let store = Store::default();
            let host = Host::default();
            let caps = Caps::default();
            let cfg = config();
            let service = AdminService {
                store: &store,
                host: &host,
                capabilities: &caps,
                config: &cfg,
                release: "fixture",
            };
            let bytes = case["input_bytes"]
                .as_array()
                .map(|values| values.iter().map(|v| v.as_u64().unwrap() as u8).collect())
                .unwrap_or_else(|| vec![0; case["input_length"].as_u64().unwrap() as usize]);
            let mut req = request("POST", "/admin/api-keys", bytes);
            for (name, value) in case["headers"].as_object().unwrap() {
                req.headers
                    .insert(name.clone(), value.as_str().unwrap().into());
            }
            let result = service.handle_route(&req, "source-golden").await;
            match case["create_next_phase"].as_str().unwrap() {
                "invalid_json" => {
                    let error = result.unwrap_err();
                    assert_eq!(error.status, 400, "{}", case["name"]);
                    assert_eq!(
                        error.envelope.error.message, "Invalid JSON body",
                        "{}",
                        case["name"]
                    );
                }
                "name_validation" => {
                    let error = result.unwrap_err();
                    assert_eq!(error.status, 400, "{}", case["name"]);
                    assert_eq!(
                        error.envelope.error.message,
                        "name must be a non-empty string (<=80 chars)",
                        "{}",
                        case["name"]
                    );
                }
                "next_create_fields" => {
                    let response = result.unwrap().unwrap();
                    assert_eq!(response.status, 200, "{}", case["name"]);
                    let units = case["normalized_name"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|v| v.as_u64().unwrap() as u16)
                        .collect::<Vec<_>>();
                    assert_eq!(
                        field_text(&response_source(&response), "name").as_units(),
                        units
                    );
                }
                other => panic!("unknown observed phase {other}"),
            }
        });
        count += 1;
    }
    assert_eq!(count, 20);
}

#[test]
fn single_source_body_retains_duplicates_opaque_unknown_fields_and_auth_order() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Caps::default();
        let cfg = config();
        let service = AdminService {
            store: &store,
            host: &host,
            capabilities: &caps,
            config: &cfg,
            release: "fixture",
        };
        let raw =
            r#"{"models":["\ud800"],"tag":"first","tag":"last\udc00","ignored":{"\ud800":1e999}}"#;
        let response = service
            .handle_route(
                &request("POST", "/admin/codex/models", raw.as_bytes().to_vec()),
                "source",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(caps.seen.borrow()[0].as_str(), raw);
        assert_eq!(
            field_text(&caps.seen.borrow()[0], "tag").as_units(),
            [108, 97, 115, 116, 0xdc00]
        );
        let before = caps.seen.borrow().len();
        let mut denied = request("POST", "/admin/codex/models", b"malformed".to_vec());
        denied.headers.clear();
        assert_eq!(
            service
                .handle_route(&denied, "denied")
                .await
                .unwrap_err()
                .status,
            401
        );
        assert_eq!(caps.seen.borrow().len(), before);
        assert!(
            service
                .handle_route(
                    &request("PUT", "/admin/codex/models", vec![]),
                    "wrong-method"
                )
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            service
                .handle_route(
                    &request("POST", "/admin/api-keys/id/paid-fallbacks", vec![]),
                    "wrong-ledger-method"
                )
                .await
                .unwrap_err()
                .status,
            405
        );
    });
}

#[test]
fn source_valid_selector_reaches_original_lookup_not_new_input_refusal() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Caps::default();
        let cfg = config();
        let service = AdminService {
            store: &store,
            host: &host,
            capabilities: &caps,
            config: &cfg,
            release: "fixture",
        };
        for raw in [r#"{"id":"\ud800"}"#, r#"{"id":" "}"#] {
            let error = service
                .handle_route(
                    &request("PATCH", "/admin/api-keys", raw.as_bytes().to_vec()),
                    "lookup",
                )
                .await
                .unwrap_err();
            assert_eq!(error.status, 404);
            assert_eq!(error.envelope.error.message, "Not found");
        }
        let error = service
            .handle_route(
                &request(
                    "PATCH",
                    "/admin/passkey-users",
                    br#"{"id":"\ud800","is_admin":false}"#.to_vec(),
                ),
                "passkey",
            )
            .await
            .unwrap_err();
        assert_eq!(error.status, 404);
        assert_eq!(error.envelope.error.message, "Passkey user not found");
        assert!(store.rows.borrow().is_empty());
    });
}

#[test]
fn paid_model_name_and_ordinary_json_map_keys_roundtrip_named_profile_record() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Caps::default();
        let service = keys::KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        let body=SourceJson::parse(r#"{"name":" \ud800\t","paid_fallback_enabled":true,"paid_fallback_limit_credits":1,"ignored":{"\udc00":"\ud800"}}"#).unwrap();
        let created = service.create(&body, &actor(), "create").await.unwrap();
        let id = field_text(&response_source(&created), "id")
            .try_utf8()
            .unwrap();
        let key = gateway_auth::api_keys::id_key(&id);
        let row = store.read(&key).await.unwrap().unwrap();
        assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
        let record = keys::decode_id_record(&key, &row).unwrap();
        assert_eq!(record.name.as_units(), [0xd800]);
        let model = ModelId::from_source(JsString16::from_units(vec![109, 0xd800]));
        assert_eq!(record.paid_fallback_model_ids, [model.clone()]);
        assert_eq!(record.paid_fallback_max_exposure_microcredits[&model], 1000);
        let public = keys::public_record(&record);
        assert_eq!(field_text(&public, "name").as_units(), [0xd800]);
        let policy_row = store
            .read(&keys::authority_policy_key(&id))
            .await
            .unwrap()
            .unwrap();
        let policy: gateway_authority::quota::ApiKeyPolicy =
            decode_source_control_record(&policy_row)
                .unwrap()
                .deserialize()
                .unwrap();
        assert_eq!(policy, keys::authority_policy(&record, NOW));
        assert_eq!(policy_row.value_encoding, ValueEncoding::ProfileV2);
        let mutation =
            keys::record_mutation(key.clone(), &record, Some(NOW + 5), "exact-revision").unwrap();
        let RecordMutation::Put {
            record: roundtrip, ..
        } = mutation
        else {
            panic!("expected existing ID family write")
        };
        assert_eq!(roundtrip.revision, "exact-revision");
        assert_eq!(roundtrip.expires_at_ms, Some(NOW + 5));
        assert_eq!(
            keys::current_record(&key, Some(&roundtrip), NOW).unwrap(),
            Some(record.clone())
        );
        assert!(
            keys::current_record(&key, Some(&roundtrip), NOW + 5)
                .unwrap()
                .is_none()
        );
        assert!(keys::decode_id_record(&gateway_auth::api_keys::id_key("another"), &row).is_err());
        assert!(
            keys::decode_record(&StoredRecord::json("partial", json!({"id":id}), None)).is_err()
        );
        assert!(
            keys::record_mutation(
                gateway_auth::api_keys::id_key("another"),
                &record,
                None,
                "r"
            )
            .is_err()
        );
        assert_eq!(
            gateway_auth::store::decode::<gateway_auth::api_keys::ApiKeyHashRecord>(
                store
                    .read(&gateway_auth::api_keys::hash_key(&record.hash))
                    .await
                    .unwrap()
                    .as_ref(),
                NOW
            )
            .unwrap(),
            Some(record.policy)
        );
    });
}

#[test]
fn scalar_key_record_retains_json_and_revision_fenced_updates() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Caps::default();
        let service = keys::KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        let created = service
            .create(
                &SourceJson::parse(r#"{"name":"scalar"}"#).unwrap(),
                &actor(),
                "create",
            )
            .await
            .unwrap();
        let id = field_text(&response_source(&created), "id")
            .try_utf8()
            .unwrap();
        let key = gateway_auth::api_keys::id_key(&id);
        let before = store.read(&key).await.unwrap().unwrap();
        assert_eq!(before.value_encoding, ValueEncoding::Json);
        store.conflict.set(true);
        let patch = input::object(vec![
            ("id", input::json(&id)),
            ("name", input::json(&JsString16::from_units(vec![0xdc00]))),
        ]);
        assert_eq!(
            service
                .mutate(AdminOperation::ApiKeysUpdate, &patch, &actor(), "conflict")
                .await
                .unwrap_err()
                .status,
            409
        );
        assert_eq!(store.read(&key).await.unwrap(), Some(before));
        let changed = service
            .mutate(AdminOperation::ApiKeysUpdate, &patch, &actor(), "update")
            .await
            .unwrap();
        assert_eq!(
            field_text(&response_source(&changed), "name").as_units(),
            [0xdc00]
        );
        let row = store.read(&key).await.unwrap().unwrap();
        assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
        assert_eq!(
            keys::decode_id_record(&key, &row).unwrap().name.as_units(),
            [0xdc00]
        );
    });
}

#[test]
fn kernel_public_source_row_stays_listable_before_crypto_projection() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let raw=SourceJson::parse(r#"{"app_id":123,"pem":" \t-----BEGIN PUBLIC KEY-----\ud800-----END PUBLIC KEY-----\n","owner":" \udc00 "}"#).unwrap();
        let response = kernel_keys::create(&store, &host, &raw).await.unwrap();
        assert_eq!(response.status, 200);
        let row = store.read(&kernel_keys::key()).await.unwrap().unwrap();
        assert_eq!(row.value_encoding, ValueEncoding::ProfileV2);
        let records = kernel_keys::decode_records(&row).unwrap();
        assert_eq!(records[0].owner.as_units(), [32, 0xdc00, 32]);
        assert!(records[0].pem.as_units().contains(&0xd800));
        let listed = kernel_keys::list(&store, NOW).await.unwrap();
        let data = input::member(&response_source(&listed), "data").unwrap();
        assert_eq!(
            data.deserialize::<Vec<kernel_keys::KernelPublicKey>>()
                .unwrap(),
            records
        );
        assert!(
            kernel_keys::public_pems(&store, NOW)
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(kernel_keys::decode_records(&row).unwrap(), records);
        assert_eq!(
            kernel_keys::create(&store, &host, &raw)
                .await
                .unwrap_err()
                .status,
            409
        );
        let RecordMutation::Put { record: copy, .. } =
            kernel_keys::records_mutation(&records, Some(NOW + 9), "r-kernel").unwrap()
        else {
            panic!("expected named kernel write")
        };
        assert_eq!(copy.revision, "r-kernel");
        assert_eq!(copy.expires_at_ms, Some(NOW + 9));
        assert_eq!(kernel_keys::decode_records(&copy).unwrap(), records);
        store.rows.borrow_mut().insert(kernel_keys::key().0, copy);
        assert!(
            kernel_keys::public_pems(&store, NOW + 9)
                .await
                .unwrap()
                .is_empty()
        );
    });
}
