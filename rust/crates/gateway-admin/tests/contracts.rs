use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

use gateway_admin::{audit, keys::*, *};
use gateway_auth::{crypto::Secret, upstream::*, *};
use gateway_core::{source_json::SourceJson, state::*};

fn source(value: &Value) -> SourceJson {
    SourceJson::from_serializable(value).unwrap()
}
use serde_json::{Value, json};

fn wire_json(body: &AuthResponseBody) -> Value {
    serde_json::from_slice(&body.to_bytes().unwrap()).unwrap()
}

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
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        if self.conflict.replace(false) {
            return Ok(CommitOutcome::Conflict);
        }
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
impl gateway_core::query::QueryStore for Store {
    async fn query(
        &self,
        _: gateway_core::query::QueryRequest,
    ) -> Result<gateway_core::query::QueryPage, GatewayError> {
        Err(GatewayError::unavailable(
            "This transport fixture does not permit queries",
            "fixture_query_denied",
        ))
    }
}
impl AuthorityStore for &Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        Store::read(self, key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        Store::commit(self, transition).await
    }
}
#[derive(Default)]
struct Host {
    serial: Cell<u64>,
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        1_000_000
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let n = self.serial.get() + 1;
        self.serial.set(n);
        Ok((0..len).map(|i| (n + i as u64) as u8).collect())
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
impl gateway_authority::TokenSource for &Host {
    fn next_token(&self) -> Result<String, GatewayError> {
        gateway_auth::crypto::uuid_from_random(&self.random_bytes(16)?)
    }
}
struct Capabilities {
    pending: bool,
}
impl AdminHost for Capabilities {
    async fn execute(
        &self,
        operation: AdminOperation,
        _: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        Err(missing_capability(operation))
    }
    async fn prepare_key_deletion(&self, _: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        if self.pending {
            Err(GatewayError::new(
                409,
                "Cannot delete API key while metered billing is pending or unresolved",
                Some("paid_fallback_billing_outstanding"),
            ))
        } else {
            Ok(Vec::new())
        }
    }
    async fn paid_key_policy(&self, _: &SourceJson) -> Result<PaidKeyFields, GatewayError> {
        Err(GatewayError::unavailable(
            "No pricing fixture",
            "paid_fallback_pricing_unavailable",
        ))
    }
}
fn actor() -> AuthPrincipal {
    AuthPrincipal {
        token: Some(Secret::new("private-credential".into())),
        method: AuthMethod::AdminAllowlist,
        is_admin: true,
        is_super_admin: true,
    }
}

fn kernel_source_policy(scope: &str, repo: Option<&str>) -> Value {
    let mut value = json!({"v":2,"scope":scope,"owner":"owner","usage_limit_requests":"25.9","window_ms":"60000.9","expires_at_ms":0,"created_at_ms":1,"updated_at_ms":2});
    if let Some(repo) = repo {
        value["repo"] = json!(repo);
    }
    value
}

#[test]
fn kernel_auth_validates_both_source_policies_before_repo_precedence() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let service = kernel_auth::KernelAuthService {
            store: &store,
            host: &host,
        };
        let repo = gateway_authority::keys::kernel_policy("owner", Some("repo"));
        let org = gateway_authority::keys::kernel_policy("owner", None);
        store.rows.borrow_mut().insert(
            repo.0,
            StoredRecord::json("repo", kernel_source_policy("repo", Some("repo")), None),
        );
        let mut corrupt_org = kernel_source_policy("org", None);
        corrupt_org["created_at_ms"] = json!(0.5);
        store.rows.borrow_mut().insert(
            org.0.clone(),
            StoredRecord::json("org-invalid", corrupt_org, None),
        );
        assert_eq!(
            service
                .resolve("owner", "repo", "/v1/responses")
                .await
                .unwrap_err()
                .status,
            503
        );
        store.rows.borrow_mut().insert(
            org.0,
            StoredRecord::json("org-valid", kernel_source_policy("org", None), None),
        );
        let result = service
            .resolve("owner", "repo", "/v1/responses")
            .await
            .unwrap();
        assert_eq!(result.limit_scope, "repo");
        assert!(result.has_policy); // The policy's expires_at_ms=0 does not erase its scope.
        assert_eq!(result.queue_recorded, None);
        assert!(
            store
                .read(&gateway_auth::store::key(json!([
                    "uos_ai",
                    "kernel_policy_queue"
                ])))
                .await
                .unwrap()
                .is_none()
        );
        store.rows.borrow_mut().insert(
            gateway_authority::keys::kernel_policy("owner", Some("repo")).0,
            StoredRecord::json("stored-null", Value::Null, None),
        );
        assert_eq!(
            service
                .resolve("owner", "repo", "/v1/responses")
                .await
                .unwrap()
                .limit_scope,
            "org"
        );
    });
}

#[test]
fn kernel_missing_policy_queue_retries_cas_without_double_counting_and_keeps_200() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let service = kernel_auth::KernelAuthService {
            store: &store,
            host: &host,
        };
        let key = gateway_auth::store::key(json!(["uos_ai", "kernel_policy_queue"]));
        let mut rows: Vec<Value> = (0..201).map(|index| json!({"owner":"other","repo":format!("repo-{index}"),"request_count":1,"first_seen_at_ms":index,"last_seen_at_ms":index,"last_route":"/old"})).collect();
        rows.push(json!({"owner":" owner ","repo":" repo ","request_count":5.9,"first_seen_at_ms":10,"last_seen_at_ms":20,"last_route":"/original"}));
        rows.push(json!({"owner":"","repo":"invalid"}));
        store.rows.borrow_mut().insert(
            key.0.clone(),
            StoredRecord::json("queue-before", json!(rows), None),
        );
        store.conflict.set(true);
        let result = service.resolve("owner", "repo", "  ").await.unwrap();
        assert_eq!(result.limit_scope, "org");
        assert!(!result.has_policy);
        assert_eq!(result.queue_recorded, Some(true));
        let row = store.read(&key).await.unwrap().unwrap();
        let value = row.json_value().unwrap().as_array().unwrap();
        assert_eq!(value.len(), 200);
        assert_eq!(
            value[0],
            json!({"owner":"owner","repo":"repo","request_count":6.0,"first_seen_at_ms":10.0,"last_seen_at_ms":1_000_000.0,"last_route":"/original"})
        );
    });
}

struct AlwaysConflict<'a> {
    store: &'a Store,
    attempts: Cell<usize>,
}
impl AuthorityStore for AlwaysConflict<'_> {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.store.read(key).await
    }
    async fn commit(&self, _: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.attempts.set(self.attempts.get() + 1);
        Ok(CommitOutcome::Conflict)
    }
}

#[test]
fn kernel_queue_failure_is_bounded_and_does_not_invent_a_policy() {
    run(async {
        let store = Store::default();
        let conflicted = AlwaysConflict {
            store: &store,
            attempts: Cell::new(0),
        };
        let host = Host::default();
        let service = kernel_auth::KernelAuthService {
            store: &conflicted,
            host: &host,
        };
        let result = service
            .resolve("owner", "repo", "/v1/responses")
            .await
            .unwrap();
        assert_eq!(result.limit_scope, "org");
        assert!(!result.has_policy);
        assert_eq!(result.queue_recorded, Some(false));
        assert_eq!(conflicted.attempts.get(), 3);
        assert!(store.rows.borrow().is_empty());
    });
}

struct CaptureBody {
    seen: RefCell<Vec<(AdminOperation, Value)>>,
}
impl AdminHost for CaptureBody {
    async fn execute(
        &self,
        operation: AdminOperation,
        input: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        assert!(input.actor.is_admin);
        self.seen
            .borrow_mut()
            .push((operation, input.body.deserialize()?));
        Ok(AuthResponse::json(200, json!({"received":true})))
    }
    async fn prepare_key_deletion(&self, _: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        Err(missing_capability(AdminOperation::ApiKeysDelete))
    }
    async fn paid_key_policy(&self, _: &SourceJson) -> Result<PaidKeyFields, GatewayError> {
        Err(missing_capability(AdminOperation::ApiKeysUpdate))
    }
}

#[test]
fn actual_admin_dispatch_preserves_ndjson_empty_experiment_and_source_text_decoding() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = CaptureBody {
            seen: RefCell::new(Vec::new()),
        };
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
        let request = |path: &str, body: Vec<u8>| AuthRequest {
            method: "POST".into(),
            url: format!("https://ai.ubq.fi{path}"),
            headers: BTreeMap::from([("authorization".into(), "Bearer fixture-admin".into())]),
            body,
            native_peer: None,
        };
        let ndjson = "{\"key\":[\"one\"],\"value\":1}\n{\"key\":[\"two\"],\"value\":2}\n";
        let mut raw = vec![0xef, 0xbb, 0xbf];
        raw.extend_from_slice(ndjson.as_bytes());
        assert_eq!(
            service
                .handle_route(
                    &request("/admin/kv-migration/import?profile=prod", raw),
                    "import"
                )
                .await
                .unwrap()
                .unwrap()
                .status,
            200
        );
        assert_eq!(
            caps.seen.borrow()[0],
            (
                AdminOperation::KvMigrationImport,
                Value::String(ndjson.into())
            )
        );
        for body in [
            Vec::new(),
            b" \n\t".to_vec(),
            "\u{feff}\u{2003}\n".as_bytes().to_vec(),
        ] {
            assert_eq!(
                service
                    .handle_route(
                        &request("/admin/providers/codex/cache-scope-experiment", body),
                        "experiment"
                    )
                    .await
                    .unwrap()
                    .unwrap()
                    .status,
                200
            );
        }
        let calls = caps.seen.borrow().len();
        for body in ["{}", "null", "{\"model\":\"caller-chosen\"}", "\u{0085}"] {
            assert_eq!(
                service
                    .handle_route(
                        &request(
                            "/admin/providers/codex/cache-scope-experiment",
                            body.as_bytes().to_vec()
                        ),
                        "experiment"
                    )
                    .await
                    .unwrap_err()
                    .status,
                400
            );
        }
        let mut announced = request("/admin/kv-migration/import", Vec::new());
        announced
            .headers
            .insert("content-length".into(), (5 * 1024 * 1024 + 1).to_string());
        assert_eq!(
            service
                .handle_route(&announced, "large")
                .await
                .unwrap_err()
                .status,
            413
        );
        assert_eq!(
            service
                .handle_route(
                    &request(
                        "/admin/kv-migration/import",
                        vec![b' '; 5 * 1024 * 1024 + 1]
                    ),
                    "large"
                )
                .await
                .unwrap_err()
                .status,
            413
        );
        let mut anonymous = announced;
        anonymous.headers.remove("authorization");
        assert_eq!(
            service
                .handle_route(&anonymous, "anonymous")
                .await
                .unwrap_err()
                .status,
            401
        );
        assert_eq!(caps.seen.borrow().len(), calls);
    });
}

struct Pricing {
    inputs: RefCell<Vec<Value>>,
}
impl AdminHost for Pricing {
    async fn execute(
        &self,
        operation: AdminOperation,
        _: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        Err(missing_capability(operation))
    }
    async fn prepare_key_deletion(&self, _: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        Err(missing_capability(AdminOperation::ApiKeysDelete))
    }
    async fn paid_key_policy(&self, raw: &SourceJson) -> Result<PaidKeyFields, GatewayError> {
        let raw: Value = raw.deserialize()?;
        self.inputs.borrow_mut().push(raw.clone());
        assert_eq!(raw["paid_fallback_enabled"], true);
        let limit = raw["paid_fallback_limit_credits"].as_f64().unwrap();
        Ok(PaidKeyFields {
            enabled: true,
            limit_microcredits: if limit == -1.0 {
                -1
            } else {
                (limit * 1_000_000.0).round() as i64
            },
            model_ids: vec!["paid-model".into()],
            quota_per_credit: 1_000_000,
            max_exposure_microcredits: BTreeMap::from([("paid-model".into(), 1000)]),
            pricing_checked_at_ms: Some(1_000_000),
        })
    }
}

#[test]
fn paid_limit_updates_and_disabling_preserve_source_pricing_without_provider_reinitialization() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Pricing {
            inputs: RefCell::new(Vec::new()),
        };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        let created = service
            .create(
                &source(&json!({"name":"Pricing","paid_fallback_limit_credits":1})),
                &actor(),
                "create",
            )
            .await
            .unwrap();
        let created_body = wire_json(&created.body);
        let id = created_body["id"].as_str().unwrap();
        assert!(caps.inputs.borrow().is_empty());
        service
            .mutate(
                AdminOperation::ApiKeysUpdate,
                &source(&json!({"id":id,"paid_fallback_enabled":true})),
                &actor(),
                "enable",
            )
            .await
            .unwrap();
        assert_eq!(caps.inputs.borrow().len(), 1);
        assert_eq!(caps.inputs.borrow()[0]["paid_fallback_limit_credits"], 1.0);
        for patch in [
            json!({"id":id,"paid_fallback_limit_credits":2}),
            json!({"id":id,"paid_fallback_enabled":true}),
            json!({"id":id,"paid_fallback_enabled":false}),
            json!({"id":id,"paid_fallback_limit_credits":3}),
        ] {
            service
                .mutate(
                    AdminOperation::ApiKeysUpdate,
                    &source(&patch),
                    &actor(),
                    "patch",
                )
                .await
                .unwrap();
            assert_eq!(caps.inputs.borrow().len(), 1);
            let row = store
                .read(&gateway_auth::api_keys::id_key(id))
                .await
                .unwrap()
                .unwrap();
            let record: ApiKeyRecord = decode_record(&row).unwrap();
            assert_eq!(
                record.paid_fallback_model_ids,
                [gateway_core::model::ModelId::from_scalar("paid-model")]
            );
            assert_eq!(record.paid_fallback_quota_per_credit, 1_000_000);
            assert_eq!(record.paid_fallback_pricing_checked_at_ms, Some(1_000_000));
            assert_eq!(
                record.paid_fallback_max_exposure_microcredits
                    [&gateway_core::model::ModelId::from_scalar("paid-model")],
                1000
            );
        }
        service
            .mutate(
                AdminOperation::ApiKeysUpdate,
                &source(&json!({"id":id,"paid_fallback_enabled":true})),
                &actor(),
                "reenable",
            )
            .await
            .unwrap();
        assert_eq!(caps.inputs.borrow().len(), 2);
        assert_eq!(caps.inputs.borrow()[1]["paid_fallback_limit_credits"], 3.0);
    });
}

struct ClaimedDeletion<'a> {
    store: &'a Store,
    host: &'a Host,
}
impl AdminHost for ClaimedDeletion<'_> {
    async fn execute(
        &self,
        operation: AdminOperation,
        _: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        Err(missing_capability(operation))
    }
    async fn paid_key_policy(&self, _: &SourceJson) -> Result<PaidKeyFields, GatewayError> {
        Err(missing_capability(AdminOperation::ApiKeysUpdate))
    }
    async fn prepare_key_deletion(&self, id: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        let key = deletion_key(id);
        let before = self.store.read(&key).await?;
        let revision = gateway_auth::crypto::uuid_from_random(&self.host.random_bytes(16)?)?;
        let guard = StoredRecord::json(&revision, json!({"created_at_ms":1_000_000}), None);
        let transition = AtomicTransition {
            checks: vec![gateway_auth::store::check(&key, before.as_ref())],
            mutations: vec![RecordMutation::Put {
                key: key.clone(),
                record: guard,
            }],
        };
        assert_eq!(
            self.store.commit(transition).await?,
            CommitOutcome::Committed
        );
        // This finite fixture's only possible paid ledger is the racing attempt.
        assert!(
            self.store
                .read(&gateway_authority::keys::paid_attempt(id, "racing-attempt"))
                .await?
                .is_none()
        );
        Ok(vec![RevisionCheck {
            key,
            expected_revision: Some(revision),
        }])
    }
    async fn finish_key_deletion(
        &self,
        id: &str,
        prepared: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        let key = gateway_auth::api_keys::id_key(id);
        let row = self.store.read(&key).await?;
        assert!(
            row.is_none(),
            "Finish must run only after the committed ID deletion"
        );
        let mut checks = prepared.to_vec();
        checks.push(gateway_auth::store::check(&key, row.as_ref()));
        let history = gateway_auth::store::key(json!([
            "uos_ai",
            "paid_fallback",
            "ledger",
            id,
            1,
            "fixture-history"
        ]));
        let result = self
            .store
            .commit(AtomicTransition {
                checks,
                mutations: vec![RecordMutation::Delete { key: history }],
            })
            .await?;
        if result != CommitOutcome::Committed {
            return Err(gateway_auth::conflict("Fixture cleanup ownership changed"));
        }
        Ok(())
    }
    async fn abort_key_deletion(
        &self,
        id: &str,
        prepared: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        let row = self
            .store
            .read(&gateway_auth::api_keys::id_key(id))
            .await?
            .unwrap();
        let record: ApiKeyRecord = decode_record(&row)?;
        assert!(record.policy.revoked_at_ms.is_some());
        assert!(prepared.iter().any(|check| check.key == deletion_key(id)));
        // Source ordinary guards persist; this fixture never claims the special local key.
        Ok(())
    }
}

struct DeletionHooks<'a> {
    inner: ClaimedDeletion<'a>,
    fail_finish: Cell<bool>,
    conflict: bool,
    finishes: Cell<usize>,
    aborts: Cell<usize>,
}
impl AdminHost for DeletionHooks<'_> {
    async fn execute(
        &self,
        operation: AdminOperation,
        _: AdminInput,
    ) -> Result<AuthResponse, GatewayError> {
        Err(missing_capability(operation))
    }
    async fn paid_key_policy(&self, _: &SourceJson) -> Result<PaidKeyFields, GatewayError> {
        Err(missing_capability(AdminOperation::ApiKeysUpdate))
    }
    async fn prepare_key_deletion(&self, id: &str) -> Result<Vec<RevisionCheck>, GatewayError> {
        let checks = self.inner.prepare_key_deletion(id).await?;
        if self.conflict {
            let key = gateway_auth::api_keys::id_key(id);
            let mut row = self.inner.store.read(&key).await?.unwrap();
            row.revision = "concurrent-key-writer".into();
            self.inner.store.rows.borrow_mut().insert(key.0, row);
        }
        Ok(checks)
    }
    async fn finish_key_deletion(
        &self,
        id: &str,
        checks: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        self.finishes.set(self.finishes.get() + 1);
        if self.fail_finish.replace(false) {
            return Err(GatewayError::new(
                500,
                "Fixture post-cleanup failed",
                Some("fixture_cleanup_failed"),
            ));
        }
        self.inner.finish_key_deletion(id, checks).await
    }
    async fn abort_key_deletion(
        &self,
        id: &str,
        checks: &[RevisionCheck],
    ) -> Result<(), GatewayError> {
        self.aborts.set(self.aborts.get() + 1);
        self.inner.abort_key_deletion(id, checks).await
    }
}

#[test]
fn deletion_cleanup_is_guarded_idempotent_and_preserves_source_error_ordering() {
    run(async {
        for (fail_finish, conflict) in [(false, false), (true, false), (false, true)] {
            let store = Store::default();
            let host = Host::default();
            let caps = DeletionHooks {
                inner: ClaimedDeletion {
                    store: &store,
                    host: &host,
                },
                fail_finish: Cell::new(fail_finish),
                conflict,
                finishes: Cell::new(0),
                aborts: Cell::new(0),
            };
            let service = KeyService {
                store: &store,
                host: &host,
                capabilities: &caps,
                release: "fixture",
            };
            let created = service
                .create(&source(&json!({"name":"Cleanup"})), &actor(), "create")
                .await
                .unwrap();
            let created_body = wire_json(&created.body);
            let id = created_body["id"].as_str().unwrap();
            service
                .mutate(
                    AdminOperation::ApiKeysRevoke,
                    &source(&json!({"id":id})),
                    &actor(),
                    "revoke",
                )
                .await
                .unwrap();
            let legacy = gateway_auth::store::key(json!(["ubq_ai", "api_keys", "usage", id]));
            let daily = gateway_auth::store::key(json!(["ubq_ai", "api_keys", "usage_daily", id]));
            let history = gateway_auth::store::key(json!([
                "uos_ai",
                "paid_fallback",
                "ledger",
                id,
                1,
                "fixture-history"
            ]));
            for key in [&legacy, &daily, &history] {
                store.rows.borrow_mut().insert(
                    key.0.clone(),
                    StoredRecord::json("history", json!({"billing_status":"settled"}), None),
                );
            }
            let result = service
                .mutate(
                    AdminOperation::ApiKeysDelete,
                    &source(&json!({"id":id})),
                    &actor(),
                    "delete",
                )
                .await;
            let guard = store.read(&deletion_key(id)).await.unwrap().unwrap();
            assert_eq!(guard.expires_at_ms, None);
            if conflict {
                assert_eq!(result.unwrap_err().status, 409);
                assert_eq!(caps.aborts.get(), 1);
                assert_eq!(caps.finishes.get(), 0);
                assert!(
                    store
                        .read(&gateway_auth::api_keys::id_key(id))
                        .await
                        .unwrap()
                        .is_some()
                );
                assert!(store.read(&legacy).await.unwrap().is_some());
                assert!(store.read(&history).await.unwrap().is_some());
                continue;
            }
            assert!(
                store
                    .read(&gateway_auth::api_keys::id_key(id))
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(
                store.read(&legacy).await.unwrap().is_none()
                    && store.read(&daily).await.unwrap().is_none()
            );
            assert_eq!(caps.aborts.get(), 0);
            assert_eq!(caps.finishes.get(), 1);
            if fail_finish {
                assert_eq!(result.unwrap_err().status, 500);
                assert!(store.read(&history).await.unwrap().is_some());
                assert_eq!(
                    service
                        .mutate(
                            AdminOperation::ApiKeysDelete,
                            &source(&json!({"id":id})),
                            &actor(),
                            "retry"
                        )
                        .await
                        .unwrap_err()
                        .status,
                    404
                );
            } else {
                assert_eq!(wire_json(&result.unwrap().body), json!({"id":id}));
            }
            let checks = vec![RevisionCheck {
                key: deletion_key(id),
                expected_revision: Some(guard.revision.clone()),
            }];
            caps.finish_key_deletion(id, &checks).await.unwrap();
            caps.finish_key_deletion(id, &checks).await.unwrap();
            assert!(store.read(&history).await.unwrap().is_none());
            assert_eq!(store.read(&deletion_key(id)).await.unwrap().unwrap(), guard);
        }
    });
}

struct PaidRaceStore<'a> {
    store: &'a Store,
    host: &'a Host,
    key_id: String,
    armed: Cell<bool>,
}

struct PaidFixtureClock;
impl gateway_authority::AuthorityClock for PaidFixtureClock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(1_000_000)
    }
}

async fn paid_fixture_owner_proof(
    store: &Store,
    host: &Host,
    identity: &gateway_auth::native_auth::NativeTransportIdentity,
    body: &[u8],
) -> gateway_auth::native_auth::AuthenticatedNativeOwner {
    use gateway_auth::{
        crypto::base64url, native::NATIVE_PUBLICATION_PATH, native_auth::*,
        native_replay::StoreNonceAuthority,
    };
    let nonce = base64url(&host.random_bytes(32).unwrap());
    let time = host.now_ms().to_string();
    let mac = identity
        .sign(NATIVE_PUBLICATION_PATH, host.now_ms(), &nonce, body)
        .unwrap();
    let nonces = StoreNonceAuthority::new(store);
    NativeAuthenticator::new(identity, &nonces)
        .authenticate(
            NATIVE_PUBLICATION_PATH,
            NativeAuthHeaders {
                version: "1",
                key_id: identity.key_id(),
                time_ms: &time,
                nonce: &nonce,
                mac: &mac,
            },
            body,
            host.now_ms(),
        )
        .await
        .unwrap()
}

async fn prepare_paid_fixture_custody(store: &Store, host: &Host) {
    use gateway_auth::native_auth::{NativeCapability, NativeTransportIdentity};
    use gateway_authority::{keys, paid::PaidRoutingPolicy, paid_control::*};
    use gateway_core::provider::PaidProvider;
    use gateway_publication::control_publication::{
        ConfiguredPaidInputs, PreparedConfigurationPublication, bootstrap_fixture_owner,
        fixture_owner_statement,
    };
    // An explicit isolated owner signs the actual configuration publication;
    // authorization below obtains the non-deserializable receipt from Authority.
    let identity = NativeTransportIdentity::new(
        "fixture-admin-race".into(),
        "fixture-admin-race".into(),
        "fixture-epoch".into(),
        [17; 32],
        std::collections::BTreeSet::from([NativeCapability::ConfigurationPublish]),
    )
    .unwrap();
    let owner_body = fixture_owner_statement(&identity).unwrap();
    let owner_proof = paid_fixture_owner_proof(store, host, &identity, &owner_body).await;
    bootstrap_fixture_owner(store, &identity, &owner_proof, host.now_ms(), "race-owner")
        .await
        .unwrap();
    let inputs = ConfiguredPaidInputs::new(
        Some(Secret::new("fixture-surplus-key".into())),
        None,
        None,
        json!({}),
    )
    .unwrap();
    let prepared = PreparedConfigurationPublication::capture(
        store,
        &identity,
        &inputs,
        "race-generation",
        host.now_ms(),
    )
    .await
    .unwrap();
    let config_proof = paid_fixture_owner_proof(store, host, &identity, prepared.statement()).await;
    let config = prepared
        .publish(store, &config_proof, host.now_ms(), "race-config")
        .await
        .unwrap();
    let observation = PaidProviderObservation {
        v: 1,
        provider: PaidProvider::Surplus,
        owner_id: config.owner_id,
        owner_epoch: config.owner_epoch,
        configuration_generation: config.generation,
        configuration_fingerprint: config.configuration_fingerprint,
        credential_binding: inputs.binding(PaidProvider::Surplus).unwrap(),
        observed_at_ms: host.now_ms(),
        source_valid_until_ms: None,
        stale: false,
        models: vec![source(
            &json!({"id":"paid-model","supported_endpoint_types":["openai-response"],"supports_tools":true,"input_price_per_token":0.001,"output_price_per_token":0.002}),
        )],
        source_checks: Vec::new(),
    };
    store.rows.borrow_mut().insert(
        keys::paid_control_observation(PaidProvider::Surplus).0,
        StoredRecord::json(
            "race-observation",
            serde_json::to_value(observation).unwrap(),
            None,
        ),
    );
    let mut source_checks = Vec::new();
    for key in paid_projection_source_keys() {
        source_checks.push(PaidSourceCheck {
            expected_revision: store.read(&key).await.unwrap().map(|row| row.revision),
            key: key.0,
        });
    }
    let projection = PaidRoutingProjection {
        policy: PaidRoutingPolicy {
            v: 2,
            codex_enabled: true,
            codex_models: vec!["codex-only".into()],
            models: BTreeMap::from([("paid-model".into(), vec![PaidProvider::Surplus])]),
        },
        provenance: PaidProjectionProvenance {
            v: 1,
            owner_revision: "race-owner".into(),
            config_revision: "race-config".into(),
            surplus_observation_revision: Some("race-observation".into()),
            openlux_observation_revision: None,
            observed_at_ms: host.now_ms(),
            source_valid_until_ms: None,
            source_checks,
        },
    };
    store.rows.borrow_mut().insert(
        keys::paid_routing().0,
        StoredRecord::json(
            "race-routing",
            serde_json::to_value(projection).unwrap(),
            None,
        ),
    );
}
impl AuthorityStore for PaidRaceStore<'_> {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.store.read(key).await
    }
    async fn commit(&self, transition: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let attempt = gateway_authority::keys::paid_attempt(&self.key_id, "racing-attempt");
        if transition
            .mutations
            .iter()
            .any(|mutation| matches!(mutation,RecordMutation::Put{key,..}if *key==attempt))
            && self.armed.replace(false)
        {
            let caps = ClaimedDeletion {
                store: self.store,
                host: self.host,
            };
            let service = KeyService {
                store: self.store,
                host: self.host,
                capabilities: &caps,
                release: "fixture",
            };
            service
                .mutate(
                    AdminOperation::ApiKeysRevoke,
                    &source(&json!({"id":self.key_id})),
                    &actor(),
                    "race-revoke",
                )
                .await?;
            assert_eq!(
                service
                    .mutate(
                        AdminOperation::ApiKeysDelete,
                        &source(&json!({"id":self.key_id})),
                        &actor(),
                        "race-delete"
                    )
                    .await?
                    .status,
                200
            );
        }
        self.store.commit(transition).await
    }
}

#[test]
fn claimed_deletion_uses_new_guard_revision_and_fences_actual_inflight_paid_admission() {
    run(async {
        use gateway_authority::{
            paid::{PaidAuthorization, PaidRequest},
            paid_control::PaidRequestContext,
        };
        use gateway_core::{
            identity::{ApiKeyId, PaidAttemptId, RequestId},
            provider::PaidProvider,
        };
        let store = Store::default();
        let host = Host::default();
        let pricing = Pricing {
            inputs: RefCell::new(Vec::new()),
        };
        let key = KeyService {
            store: &store,
            host: &host,
            capabilities: &pricing,
            release: "fixture",
        }
        .create(
            &source(&json!({"name":"Race","paid_fallback_enabled":true,"paid_fallback_limit_credits":1})),
            &actor(),
            "create",
        )
        .await
        .unwrap();
        let id = wire_json(&key.body)["id"].as_str().unwrap().to_owned();
        prepare_paid_fixture_custody(&store, &host).await;
        let raced = PaidRaceStore {
            store: &store,
            host: &host,
            key_id: id.clone(),
            armed: Cell::new(true),
        };
        let authority = gateway_authority::Authority::with_clock(raced, &host, PaidFixtureClock);
        let request = PaidRequest {
            key_id: ApiKeyId(id.clone()),
            request_id: RequestId("racing-request".into()),
            attempt_id: PaidAttemptId("racing-attempt".into()),
            provider: PaidProvider::Surplus,
            model: "paid-model".into(),
            route: "responses".into(),
            path: "/v1/responses".into(),
            stream: false,
            reasoning: None,
            created_at_ms: 1_000_000,
        };
        let receipt = authority
            .authorize_paid_route(
                &request,
                &PaidRequestContext {
                    original_model: request.model.clone(),
                    body: source(&json!({"model":request.model,"stream":false})),
                    surface: gateway_providers::ClientSurface::Responses,
                    synthetic_hop: None,
                },
                1_000_000,
            )
            .await
            .unwrap();
        // Controlled authority regression: use the canonical finite original
        // fixture chain, not a route-only receipt or a Worker-runtime claim.
        let original = gateway_core::identity::RequestContext {
            request_id: request.request_id.clone(),
            principal: gateway_core::identity::PrincipalId("fixture-original-principal".into()),
            key_id: Some(request.key_id.clone()),
            route: request.route.clone(),
            started_at_ms: request.created_at_ms,
        };
        let api = authority
            .reserve_api_key(
                &request.key_id,
                &request.request_id,
                &request.route,
                1_000_000,
            )
            .await
            .unwrap();
        let journal_key = gateway_auth::store::key(json!([
            "uos_ai",
            "routing_runtime",
            "v1",
            "session",
            request.request_id.0
        ]));
        store.rows.borrow_mut().insert(
            journal_key.0,
            StoredRecord::json(
                "fixture-original-journal",
                json!({
                    "v":1,"context":original,"input_digest":gateway_auth::crypto::sha256_hex(b"fixture-original-input"),
                    "api":api,"kernel":null,"cursor":0,"attempts":[],"active":null,
                    "model_sibling_retries":0,"refreshed_versions":[],"recovery_attempted":false,"claude_unavailable":false,
                    "semantic_committed":false,"terminal_intent":null,"finished":false,"recovering":false,
                    "lease_expires_at_ms":1_000_000+gateway_authority::REQUEST_LEASE_MS,"updated_at_ms":1_000_000,"extras_family":null,
                    "extras_child_count":null,"extras_dispatch":null,"children":[],"kernel_override":null
                }),
                None,
            ),
        );
        let receipt = authority
            .bind_paid_original_request(&receipt, &original, 1_000_000)
            .await
            .unwrap();
        assert!(
            store
                .read(&gateway_auth::api_keys::id_key(&id))
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            authority
                .reserve_paid(
                    &request,
                    &PaidAuthorization::DirectPaidModel,
                    &receipt,
                    1_000_000
                )
                .await
                .is_err()
        );
        assert!(
            store
                .read(&gateway_auth::api_keys::id_key(&id))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            store
                .read(&gateway_authority::keys::paid_attempt(
                    &id,
                    "racing-attempt"
                ))
                .await
                .unwrap()
                .is_none()
        );
        assert!(store.read(&deletion_key(&id)).await.unwrap().is_some());
    });
}

#[test]
fn every_source_admin_endpoint_is_accounted_for() {
    let source = include_str!("../../../../src/handler/index.ts");
    let table = source
        .split("const ADMIN_ROUTES:")
        .nth(1)
        .unwrap()
        .split("\n];")
        .next()
        .unwrap();
    let mut seen = 0;
    for tail in table.split("path: \"").skip(1) {
        let path = tail.split('"').next().unwrap();
        assert!(
            ["GET", "POST", "PATCH", "DELETE"]
                .iter()
                .any(|method| match_route(method, path).is_some()),
            "missing {path}"
        );
        seen += 1;
    }
    assert!(seen >= 45);
    assert_eq!(
        match_route("GET", "/admin/api-keys/key/paid-fallbacks")
            .unwrap()
            .operation,
        AdminOperation::ApiKeyPaidFallbacks
    );
    assert_eq!(
        match_route("POST", "/admin/providers/codex/2/recheck")
            .unwrap()
            .parameter
            .as_deref(),
        Some("2")
    );
    assert!(match_route("POST", "/admin/providers/codex/../../recheck").is_none());
}

#[test]
fn audit_never_persists_credential_material() {
    let raw = json!({"name":"key","usage_limit_requests":50,"token":"private-token","hash":"private-hash","authorization":"Bearer private","prompt":"private"});
    let sanitized = audit::safe_changed(&raw)
        .unwrap()
        .deserialize::<Value>()
        .unwrap();
    assert_eq!(sanitized, json!({"name":"key","usage_limit_requests":50}));
    let shared = audit::actor(&actor());
    assert_eq!(shared.kind, "shared_admin_credential");
    assert_eq!(shared.principal_id, None);
}

#[test]
fn key_creation_commits_identity_policy_window_and_audit_together() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Capabilities { pending: false };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture-release",
        };
        let result = service
            .create(
                &source(&json!({"name":"Fixture key","usage_limit_requests":0})),
                &actor(),
                "request",
            )
            .await
            .unwrap();
        assert_eq!(result.status, 200);
        let result_body = wire_json(&result.body);
        let id = result_body["id"].as_str().unwrap();
        let token = result_body["token"].as_str().unwrap();
        assert!(gateway_auth::api_keys::api_key_shape(token));
        assert!(
            store
                .read(&gateway_auth::api_keys::id_key(id))
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .read(&authority_policy_key(id))
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            store
                .read(&gateway_authority::keys::api_window(
                    id,
                    &format!("v3:{}", gateway_auth::api_keys::WEEK_MS),
                    1_000_000
                ))
                .await
                .unwrap()
                .is_some()
        );
        let audit = store
            .rows
            .borrow()
            .values()
            .find_map(|row| audit::decode_event(row).ok())
            .unwrap();
        assert_eq!(audit.action, "create");
        assert!(!serde_json::to_string(&audit).unwrap().contains(token));
        assert!(result_body.get("hash").is_none());
    });
}

#[test]
fn conflicting_creation_writes_nothing() {
    run(async {
        let store = Store::default();
        store.conflict.set(true);
        let host = Host::default();
        let caps = Capabilities { pending: false };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        assert_eq!(
            service
                .create(&source(&json!({"name":"Fixture"})), &actor(), "request")
                .await
                .unwrap_err()
                .status,
            409
        );
        assert!(store.rows.borrow().is_empty());
    });
}

#[test]
fn malformed_or_unpriced_paid_key_never_writes_state() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Capabilities { pending: false };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        for body in [
            json!({"name":"bad\nkey"}),
            json!({"name":"key","paid_fallback_enabled":true}),
            json!({"name":"key","token":"wrong"}),
            json!({"name":"key","window_ms":0}),
        ] {
            assert_eq!(
                service
                    .create(&source(&body), &actor(), "request")
                    .await
                    .unwrap_err()
                    .status,
                400
            );
            assert!(store.rows.borrow().is_empty());
        }
        assert_eq!(service.create(&source(&json!({"name":"key","paid_fallback_enabled":true,"paid_fallback_limit_credits":1})),&actor(),"request").await.unwrap_err().status,503);
        assert!(store.rows.borrow().is_empty());
    });
}

#[test]
fn revoked_deletion_never_discards_pending_billing() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let caps = Capabilities { pending: true };
        let service = KeyService {
            store: &store,
            host: &host,
            capabilities: &caps,
            release: "fixture",
        };
        let created = service
            .create(&source(&json!({"name":"Fixture"})), &actor(), "create")
            .await
            .unwrap();
        let created_body = wire_json(&created.body);
        let id = created_body["id"].as_str().unwrap();
        assert_eq!(
            service
                .mutate(
                    AdminOperation::ApiKeysDelete,
                    &source(&json!({"id":id})),
                    &actor(),
                    "delete"
                )
                .await
                .unwrap_err()
                .status,
            400
        );
        service
            .mutate(
                AdminOperation::ApiKeysRevoke,
                &source(&json!({"id":id})),
                &actor(),
                "revoke",
            )
            .await
            .unwrap();
        let before = store.rows.borrow().clone();
        assert_eq!(
            service
                .mutate(
                    AdminOperation::ApiKeysDelete,
                    &source(&json!({"id":id})),
                    &actor(),
                    "delete"
                )
                .await
                .unwrap_err()
                .status,
            409
        );
        assert_eq!(*store.rows.borrow(), before);
        let policy = store
            .read(&authority_policy_key(id))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            policy.json_value().unwrap()["expires_at_ms"],
            json!(1_000_000)
        );
    });
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
