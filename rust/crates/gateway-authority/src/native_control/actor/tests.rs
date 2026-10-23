use super::*;
mod live_manual;
mod native_import;
mod renewal_v2;
use gateway_auth::{
    crypto::{Secret, sha256_base64url},
    upstream::{AuthUpstreamRequest, AuthUpstreamResponse},
};
use gateway_core::{
    identity::{ApiKeyId, PrincipalId, RequestId},
    state::{AtomicTransition, CommitOutcome, RecordMutation, StoredRecord},
};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
};

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
#[derive(Clone)]
struct Store {
    rows: Arc<Mutex<BTreeMap<String, StoredRecord>>>,
    now: Arc<AtomicI64>,
    race: Arc<Mutex<PendingRace>>,
    commit_time: Arc<AtomicI64>,
}
type PendingRace = Option<(RecordKey, Option<StoredRecord>)>;
impl Default for Store {
    fn default() -> Self {
        Self {
            rows: Arc::default(),
            now: Arc::new(AtomicI64::new(1_000_000)),
            race: Arc::default(),
            commit_time: Arc::new(AtomicI64::new(0)),
        }
    }
}
impl Store {
    fn seed(&self, key: RecordKey, revision: &str, value: impl Serialize) {
        self.rows.lock().unwrap().insert(
            key.0,
            StoredRecord::json(revision, serde_json::to_value(value).unwrap(), None),
        );
    }
    fn race(&self, key: RecordKey, value: Option<StoredRecord>) {
        *self.race.lock().unwrap() = Some((key, value));
    }
}
impl crate::AuthorityClock for Store {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(self.now.load(Ordering::SeqCst))
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        let value = self.rows.lock().unwrap().get(&key.0).cloned();
        let mut race = self.race.lock().unwrap();
        if race.as_ref().is_some_and(|(target, _)| target == key) {
            let (key, replacement) = race.take().unwrap();
            let mut rows = self.rows.lock().unwrap();
            match replacement {
                Some(row) => {
                    rows.insert(key.0, row);
                }
                None => {
                    rows.remove(&key.0);
                }
            }
        }
        Ok(value)
    }
    async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        let mut rows = self.rows.lock().unwrap();
        for check in tx.checks {
            if rows.get(&check.key.0).map(|row| &row.revision) != check.expected_revision.as_ref() {
                return Ok(CommitOutcome::Conflict);
            }
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
        let jump = self.commit_time.swap(0, Ordering::SeqCst);
        if jump != 0 {
            self.now.store(jump, Ordering::SeqCst);
        }
        Ok(CommitOutcome::Committed)
    }
}
struct Tokens;
impl TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok("actor-fixture-unused-token".into())
    }
}
struct Host {
    store: Store,
    fetches: AtomicUsize,
}
impl Host {
    fn new(store: &Store) -> Self {
        Self {
            store: store.clone(),
            fetches: AtomicUsize::new(0),
        }
    }
}
impl gateway_auth::webauthn::WebAuthnCrypto for Host {
    async fn validate_key(
        &self,
        _: &gateway_auth::webauthn::CosePublicKey,
    ) -> Result<(), GatewayError> {
        Err(fail())
    }
    async fn verify_signature(
        &self,
        _: gateway_auth::webauthn::SignatureInput,
    ) -> Result<bool, GatewayError> {
        Err(fail())
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        self.store.now.load(Ordering::SeqCst)
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        Ok(vec![1; length])
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        Ok(AuthUpstreamResponse {
            status: 200,
            body: b"{}".to_vec(),
        })
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Ok("org".into())
    }
}
fn config() -> AuthConfig {
    AuthConfig {
        production: true,
        hosted: true,
        git_sha_known: true,
        ..Default::default()
    }
}
fn request(token: &str) -> AuthRequest {
    AuthRequest {
        method: "POST".into(),
        url: "https://ai.ubq.fi/v1/responses".into(),
        headers: BTreeMap::from([("authorization".into(), format!("Bearer {token}"))]),
        ..Default::default()
    }
}
fn context(principal: &str, key: Option<&str>) -> RequestContext {
    RequestContext {
        request_id: RequestId("original-request".into()),
        principal: PrincipalId(principal.into()),
        key_id: key.map(|key| ApiKeyId(key.into())),
        route: "responses".into(),
        started_at_ms: 1_000_000,
    }
}
fn authority(store: &Store) -> Authority<Store, Tokens> {
    Authority::with_clock(store.clone(), Tokens, store.clone())
}
fn user(admin: bool) -> PasskeyUser {
    PasskeyUser {
        id: "user-fixture".into(),
        handle: "operator".into(),
        is_admin: admin,
        credential_ids: vec!["credential".into()],
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}
fn session_setup(store: &Store, admin: bool, indexed: bool) -> String {
    let token = "uos_ai_session_SYNTHETIC_ACTOR_TOKEN".to_owned();
    let session = PasskeySession {
        token: token.clone(),
        user_id: "user-fixture".into(),
        created_at_ms: 1,
        expires_at_ms: 1_100_000,
        audience_origin: None,
    };
    store.seed(
        passkeys::key("users", "user-fixture"),
        "user-1",
        user(admin),
    );
    store.seed(passkeys::key("sessions", &token), "session-1", &session);
    if indexed {
        store.rows.lock().unwrap().insert(
            session_index::index_key(&session_index::digest(&token))
                .unwrap()
                .0,
            session_index::record_for_session(&session, "session-1", None).unwrap(),
        );
    }
    token
}
fn api_setup(store: &Store, expiry: i64) -> String {
    let token = format!("u_{}", "a".repeat(64));
    let hash = sha256_base64url(token.as_bytes());
    store.seed(
        api_keys::hash_key(&hash),
        "hash-1",
        api_keys::ApiKeyHashRecord {
            id: "api-fixture".into(),
            expires_at_ms: expiry,
            revoked_at_ms: None,
            usage_limit_requests: 10,
            usage_requests: 0,
            usage_reset_at_ms: 2_000_000,
            window_ms: 1_000_000,
            usage_quota_version: 3,
            paid_fallback_enabled: false,
            paid_fallback_limit_microcredits: 0,
            paid_fallback_spent_microcredits: 0,
            paid_fallback_reserved_microcredits: 0,
            paid_fallback_reservation_request_id: None,
        },
    );
    store.seed(
        keys::api_policy("api-fixture"),
        "policy-1",
        crate::quota::ApiKeyPolicy {
            v: 3,
            key_id: ApiKeyId("api-fixture".into()),
            expires_at_ms: expiry,
            usage_limit_requests: 10,
            window_ms: 1_000_000,
            usage_reset_at_ms: 2_000_000,
            paid_fallback_enabled: false,
            paid_fallback_limit_microcredits: 0,
            paid_fallback_quota_per_credit: 0,
            paid_fallback_pricing_checked_at_ms: 0,
            paid_fallback_models: vec![],
            paid_fallback_max_exposure_microcredits: BTreeMap::new(),
        },
    );
    token
}
async fn current(
    authority: &Authority<Store, Tokens>,
    actor: &NativeRenewalActor,
    cfg: &AuthConfig,
) -> Result<CurrentNativeActor, GatewayError> {
    let mut tx = authority.transaction(authority.fresh_time(0)?)?;
    let result = read_current(&mut tx, actor.stored(), cfg).await?;
    validate_current_time(actor.stored(), authority.fresh_time(tx.now)?)?;
    if !tx.commit().await? {
        return Err(fail());
    }
    Ok(result)
}

#[test]
fn actual_client_and_admin_session_auth_mint_without_serializing_bearer_keys() {
    run(async {
        let store = Store::default();
        let token = session_setup(&store, true, true);
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let cfg = config();
        let req = request(&token);
        let ctx = context("passkey-user:user-fixture", None);
        let client = authenticate_client_actor(&authority, &host, &cfg, &req, &ctx)
            .await
            .unwrap();
        let admin = authenticate_admin_actor(&authority, &host, &cfg, &req, &ctx)
            .await
            .unwrap();
        assert_eq!(client.scope(), NativeActorScope::Client);
        assert_eq!(admin.scope(), NativeActorScope::Admin);
        assert_eq!(client.context(), &ctx);
        assert_eq!(client.principal(), "passkey-user:user-fixture");
        let serialized = serde_json::to_string(client.stored()).unwrap();
        assert!(!serialized.contains(&token));
        assert!(!serialized.contains(&passkeys::key("sessions", &token).0));
        let before = current(&authority, &client, &cfg).await.unwrap();
        assert_eq!(before.principal, client.principal());
        assert_eq!(before.policy_digest, client.policy_digest());
        let mut tx = authority.transaction(host.now_ms()).unwrap();
        client.bind_preparation(&mut tx).await.unwrap();
        assert!(
            tx.checks()
                .iter()
                .any(|check| check.key == passkeys::key("sessions", &token))
        );
        store.seed(
            passkeys::key("users", "user-fixture"),
            "demoted",
            user(false),
        );
        assert!(current(&authority, &admin, &cfg).await.is_err());
        assert!(
            authenticate_admin_actor(&authority, &host, &cfg, &req, &ctx)
                .await
                .is_err()
        );
        assert_eq!(host.fetches.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn session_revocation_replacement_expiry_and_missing_index_refuse() {
    run(async {
        for change in 0..5 {
            let store = Store::default();
            let token = session_setup(&store, true, true);
            let host = Host::new(&store);
            let authority = self::authority(&store);
            let cfg = config();
            let req = request(&token);
            let ctx = context("passkey-user:user-fixture", None);
            let actor = authenticate_client_actor(&authority, &host, &cfg, &req, &ctx)
                .await
                .unwrap();
            let key = session_index::index_key(&session_index::digest(&token)).unwrap();
            match change {
                0 => {
                    store.rows.lock().unwrap().remove(&key.0);
                }
                1 => {
                    store.seed(
                        passkeys::key("users", "user-fixture"),
                        "replacement",
                        user(true),
                    );
                }
                2 => {
                    store.now.store(1_100_000, Ordering::SeqCst);
                }
                3 => {
                    let mut row = store.rows.lock().unwrap().get(&key.0).unwrap().clone();
                    row.revision = "replacement".into();
                    store.rows.lock().unwrap().insert(key.0, row);
                }
                _ => {
                    store
                        .rows
                        .lock()
                        .unwrap()
                        .remove(&passkeys::key("users", "user-fixture").0);
                }
            }
            assert!(current(&authority, &actor, &cfg).await.is_err());
        }
        let store = Store::default();
        let token = session_setup(&store, true, false);
        let host = Host::new(&store);
        assert!(
            authenticate_client_actor(
                &self::authority(&store),
                &host,
                &config(),
                &request(&token),
                &context("passkey-user:user-fixture", None)
            )
            .await
            .is_err()
        );
    });
}

#[test]
fn demotion_or_revocation_during_auth_await_never_captures_a_new_revision_beside_old_grants() {
    run(async {
        let store = Store::default();
        let token = session_setup(&store, true, true);
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let cfg = config();
        store.race(
            passkeys::key("users", "user-fixture"),
            Some(StoredRecord::json(
                "demotion",
                serde_json::to_value(user(false)).unwrap(),
                None,
            )),
        );
        assert!(
            authenticate_admin_actor(
                &authority,
                &host,
                &cfg,
                &request(&token),
                &context("passkey-user:user-fixture", None)
            )
            .await
            .is_err()
        );
        let store = Store::default();
        let token = api_setup(&store, -1);
        let host = Host::new(&store);
        let key = api_keys::hash_key(&sha256_base64url(token.as_bytes()));
        let mut replacement = store.rows.lock().unwrap().get(&key.0).unwrap().clone();
        replacement.revision = "revoked".into();
        replacement.value["revoked_at_ms"] = json!(1);
        store.race(key, Some(replacement));
        assert!(
            authenticate_client_actor(
                &self::authority(&store),
                &host,
                &cfg,
                &request(&token),
                &context("api-key:api-fixture", Some("api-fixture"))
            )
            .await
            .is_err()
        );
    });
}

#[test]
fn actual_api_auth_binds_current_hash_policy_and_absolute_source_expiry() {
    run(async {
        let store = Store::default();
        let token = api_setup(&store, -1);
        let hashkey = api_keys::hash_key(&sha256_base64url(token.as_bytes()));
        let mut row = store.rows.lock().unwrap().get(&hashkey.0).unwrap().clone();
        row.expires_at_ms = Some(1_000_100);
        store.rows.lock().unwrap().insert(hashkey.0.clone(), row);
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let cfg = config();
        let ctx = context("api-key:api-fixture", Some("api-fixture"));
        let actor = authenticate_client_actor(&authority, &host, &cfg, &request(&token), &ctx)
            .await
            .unwrap();
        assert!(
            authenticate_admin_actor(&authority, &host, &cfg, &request(&token), &ctx)
                .await
                .is_err()
        );
        assert!(
            !serde_json::to_string(actor.stored())
                .unwrap()
                .contains(&token)
        );
        store.now.store(1_000_100, Ordering::SeqCst);
        assert!(validate_current_time(actor.stored(), authority.fresh_time(0).unwrap()).is_err());
        store.now.store(1_000_000, Ordering::SeqCst);
        store.commit_time.store(1_000_100, Ordering::SeqCst);
        assert!(
            authenticate_client_actor(&authority, &host, &cfg, &request(&token), &ctx)
                .await
                .is_err()
        );
        store.now.store(1_000_000, Ordering::SeqCst);
        let mut row = store.rows.lock().unwrap().get(&hashkey.0).unwrap().clone();
        row.revision = "changed-policy".into();
        row.value["usage_limit_requests"] = json!(2);
        store.rows.lock().unwrap().insert(hashkey.0, row);
        assert!(current(&authority, &actor, &cfg).await.is_err());
    });
}

#[test]
fn allowlists_local_and_deno_bind_actual_current_configuration() {
    run(async {
        for admin in [false, true] {
            let store = Store::default();
            let host = Host::new(&store);
            let authority = self::authority(&store);
            let mut cfg = config();
            let token = "SYNTHETIC_ALLOWLIST_SECRET";
            if admin {
                cfg.admin_tokens.push(Secret::new(token.into()));
            } else {
                cfg.auth_tokens.push(Secret::new(token.into()));
            }
            let name = if admin {
                "auth-method:admin_allowlist"
            } else {
                "auth-method:auth_tokens_allowlist"
            };
            let ctx = context(name, None);
            let req = request(token);
            let actor = if admin {
                authenticate_admin_actor(&authority, &host, &cfg, &req, &ctx)
                    .await
                    .unwrap()
            } else {
                authenticate_client_actor(&authority, &host, &cfg, &req, &ctx)
                    .await
                    .unwrap()
            };
            assert!(
                !serde_json::to_string(actor.stored())
                    .unwrap()
                    .contains(token)
            );
            assert!(current(&authority, &actor, &cfg).await.is_ok());
            cfg.auth_tokens.clear();
            cfg.admin_tokens.clear();
            assert!(current(&authority, &actor, &cfg).await.is_err());
        }
        let store = Store::default();
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let cfg = AuthConfig::default();
        let mut req = AuthRequest {
            method: "POST".into(),
            url: "http://localhost/v1/responses".into(),
            ..Default::default()
        };
        let ctx = context("local-auth-disabled", None);
        let actor = authenticate_client_actor(&authority, &host, &cfg, &req, &ctx)
            .await
            .unwrap();
        assert!(current(&authority, &actor, &config()).await.is_err());
        req.url = "https://ai.ubq.fi/v1/responses".into();
        assert!(
            authenticate_client_actor(&authority, &host, &cfg, &req, &ctx)
                .await
                .is_err()
        );
        let mut cfg = config();
        cfg.deno_app_slug = Some("fixture-app".into());
        let token = "ddw_SYNTHETIC_DENO_SECRET";
        let actor = authenticate_admin_actor(
            &authority,
            &host,
            &cfg,
            &request(token),
            &context("auth-method:deno_deploy_token", None),
        )
        .await
        .unwrap();
        assert!(host.fetches.load(Ordering::SeqCst) > 0);
        assert!(
            !serde_json::to_string(actor.stored())
                .unwrap()
                .contains(token)
        );
        store.now.store(1_300_000, Ordering::SeqCst);
        assert!(current(&authority, &actor, &cfg).await.is_err());
    });
}

#[test]
fn context_without_auth_wrong_principal_or_key_and_readonly_health_cannot_mint() {
    run(async {
        let store = Store::default();
        let token = api_setup(&store, -1);
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let cfg = config();
        let ctx = context("api-key:api-fixture", Some("api-fixture"));
        assert!(
            authenticate_client_actor(&authority, &host, &cfg, &AuthRequest::default(), &ctx)
                .await
                .is_err()
        );
        assert!(
            authenticate_client_actor(
                &authority,
                &host,
                &cfg,
                &request(&token),
                &context("other", Some("api-fixture"))
            )
            .await
            .is_err()
        );
        assert!(
            authenticate_client_actor(
                &authority,
                &host,
                &cfg,
                &request(&token),
                &context("api-key:api-fixture", None)
            )
            .await
            .is_err()
        );
        let mut req = request(&token);
        req.method = "GET".into();
        req.url = "https://ai.ubq.fi/health".into();
        assert!(
            authenticate_client_actor(&authority, &host, &cfg, &req, &ctx)
                .await
                .is_err()
        );
        let actor = authenticate_client_actor(&authority, &host, &cfg, &request(&token), &ctx)
            .await
            .unwrap();
        assert_eq!(actor.context().request_id.0, "original-request");
        assert!(
            store
                .rows
                .lock()
                .unwrap()
                .keys()
                .all(|key| !key.contains("routing_runtime"))
        );
        let mut stored = serde_json::to_value(actor.stored()).unwrap();
        stored["v"] = json!(99);
        let stored: StoredNativeActor = serde_json::from_value(stored).unwrap();
        let mut tx = authority.transaction(1_000_000).unwrap();
        assert!(read_current(&mut tx, &stored, &cfg).await.is_err());
    });
}

#[test]
fn verified_kernel_actor_needs_no_fake_inference_admission_and_rechecks_source_keys() {
    run(async {
        let fixture: Value =
            serde_json::from_str(include_str!("actor_kernel_fixture.json")).unwrap();
        let token = fixture["token"].as_str().unwrap();
        let store = Store::default();
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let mut cfg = config();
        cfg.kernel_public_keys_pem
            .push(fixture["public_key"].as_str().unwrap().into());
        let mut req = request(token);
        req.url = "https://ai.ubq.fi/v1/live/calls".into();
        req.headers.insert(
            "x-ubiquity-kernel-token".into(),
            fixture["jwt"].as_str().unwrap().into(),
        );
        req.headers
            .insert("x-github-owner".into(), "FixtureOrg".into());
        req.headers
            .insert("x-github-repo".into(), "fixture-repo".into());
        let ctx = context("github-repo:fixtureorg/fixture-repo", None);
        let actor = authenticate_client_actor(&authority, &host, &cfg, &req, &ctx)
            .await
            .unwrap();
        assert_eq!(actor.principal(), "github-repo:fixtureorg/fixture-repo");
        assert_eq!(host.fetches.load(Ordering::SeqCst), 1);
        assert!(store.rows.lock().unwrap().is_empty());
        assert!(current(&authority, &actor, &cfg).await.is_ok());
        let serialized = serde_json::to_string(actor.stored()).unwrap();
        assert!(!serialized.contains(token));
        assert!(!serialized.contains(fixture["jwt"].as_str().unwrap()));
        store.seed(
            upstream::kernel_public_keys_key(),
            "keys-changed",
            json!([]),
        );
        assert!(current(&authority, &actor, &cfg).await.is_err());
    });
}

#[test]
fn transient_source_session_cas_is_not_a_serialized_policy_digest_input() {
    run(async {
        let store = Store::default();
        let token = session_setup(&store, true, true);
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let cfg = config();
        let actor = authenticate_client_actor(
            &authority,
            &host,
            &cfg,
            &request(&token),
            &context("passkey-user:user-fixture", None),
        )
        .await
        .unwrap();
        let baseline = actor.policy_digest().to_owned();
        let mut tx = authority.transaction(1_000_000).unwrap();
        let facts = read_current(&mut tx, actor.stored(), &cfg).await.unwrap();
        assert_eq!(facts.policy_digest, baseline);
        assert_eq!(facts.scope, NativeActorScope::Client);
        actor.bind_preparation(&mut tx).await.unwrap();
        let source_key = passkeys::key("sessions", &token);
        let mut row = store
            .rows
            .lock()
            .unwrap()
            .get(&source_key.0)
            .unwrap()
            .clone();
        row.revision = "session-raced".into();
        store.rows.lock().unwrap().insert(source_key.0.clone(), row);
        assert!(!tx.commit().await.unwrap());
        assert!(
            !serde_json::to_string(actor.stored())
                .unwrap()
                .contains(&source_key.0)
        );
    });
}

#[test]
fn live_api_actor_does_not_require_or_create_normalized_quota_projection() {
    run(async {
        let store = Store::default();
        let token = api_setup(&store, -1);
        store
            .rows
            .lock()
            .unwrap()
            .remove(&keys::api_policy("api-fixture").0);
        let host = Host::new(&store);
        let authority = self::authority(&store);
        let cfg = config();
        let mut req = request(&token);
        req.url = "https://ai.ubq.fi/v1/live/calls".into();
        let actor = authenticate_client_actor(
            &authority,
            &host,
            &cfg,
            &req,
            &context("api-key:api-fixture", Some("api-fixture")),
        )
        .await
        .unwrap();
        assert!(current(&authority, &actor, &cfg).await.is_ok());
        assert!(
            !store
                .rows
                .lock()
                .unwrap()
                .contains_key(&keys::api_policy("api-fixture").0)
        );
        assert!(
            store
                .rows
                .lock()
                .unwrap()
                .keys()
                .all(|key| !key.contains("routing_runtime"))
        );
    });
}

#[test]
fn user_row_absolute_expiry_crossing_readonly_commit_prevents_actor_mint() {
    run(async {
        let store = Store::default();
        let token = session_setup(&store, true, true);
        let key = passkeys::key("users", "user-fixture");
        let mut row = store.rows.lock().unwrap().get(&key.0).unwrap().clone();
        row.expires_at_ms = Some(1_000_100);
        store.rows.lock().unwrap().insert(key.0, row);
        store.commit_time.store(1_000_100, Ordering::SeqCst);
        let host = Host::new(&store);
        assert!(
            authenticate_admin_actor(
                &self::authority(&store),
                &host,
                &config(),
                &request(&token),
                &context("passkey-user:user-fixture", None)
            )
            .await
            .is_err()
        );
    });
}
