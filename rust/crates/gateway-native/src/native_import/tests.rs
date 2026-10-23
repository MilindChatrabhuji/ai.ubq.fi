//! Real proof/authority fixtures for native typed AUTH context only.
use super::*;
use gateway_auth::{
    AuthConfig, AuthHost, AuthRequest, GatewayError,
    crypto::{Secret, base64url, sha256_hex},
    native::*,
    native_auth::{
        NativeAuthHeaders, NativeAuthenticator, NativeCapability, NativeNonceAuthority,
        NativeTransportIdentity,
    },
    native_import::*,
    passkeys::{self, PasskeySession, PasskeyUser},
    provider_credentials::{
        CodexNativeOwner, CodexSourceAccount, CodexSourcePool, MANAGED_NATIVE_SOURCE_VERSION,
        ManagedNativeSource, codex_source_pool_key,
    },
    session_index,
    upstream::{AuthUpstreamRequest, AuthUpstreamResponse},
};
use gateway_authority::{
    Authority, AuthorityClock, TokenSource, keys,
    native_control::{
        NativeRenewalAuthority, NativeRenewalCancellation, RegisteredRenewalOwner, actor,
    },
    paid_control::{
        PAID_CONTROL_CONFIG_VERSION, PaidControlConfig, PaidControlOwner, PaidSourceCheck,
    },
    routing::{PoolAccount, SubscriptionPool},
};
use gateway_core::{
    identity::{PoolVersionstamp, PrincipalId, RequestContext, RequestId},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, RecordMutation, StoredRecord,
    },
};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}
#[derive(Clone, Default)]
struct Store {
    rows: Arc<Mutex<BTreeMap<String, StoredRecord>>>,
    captures: Arc<Mutex<Vec<String>>>,
}
impl Store {
    fn seed(&self, key: RecordKey, revision: &str, value: impl Serialize) {
        self.rows.lock().unwrap().insert(
            key.0,
            StoredRecord::json(revision, serde_json::to_value(value).unwrap(), None),
        );
    }
    fn captured(&self) -> String {
        self.captures.lock().unwrap().join("\n")
    }
}
impl AuthorityClock for Store {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        Ok(now_ms())
    }
}
impl AuthorityStore for Store {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.captures
            .lock()
            .unwrap()
            .push(format!("read:{}", key.0));
        Ok(self.rows.lock().unwrap().get(&key.0).cloned())
    }
    async fn commit(&self, tx: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        self.captures
            .lock()
            .unwrap()
             .push(json!({
                "checks": tx.checks.iter().map(|check| json!({"key":check.key.0,"expected_revision":check.expected_revision})).collect::<Vec<_>>(),
                "mutations": tx.mutations.iter().map(|mutation| match mutation {
                    RecordMutation::Put{key,record} => json!({"put":{"key":key.0,"record":record}}),
                    RecordMutation::Delete{key} => json!({"delete":{"key":key.0}}),
                }).collect::<Vec<_>>()
            }).to_string());
        let mut rows = self.rows.lock().unwrap();
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
#[derive(Clone, Default)]
struct Tokens(Arc<AtomicU64>);
impl TokenSource for Tokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        Ok(format!(
            "native-client-token-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
#[derive(Default)]
struct Cancel(AtomicBool);
impl NativeRenewalCancellation for Cancel {
    fn cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}
struct Host;
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
        now_ms()
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        Ok(vec![1; length])
    }
    async fn fetch_auth(
        &self,
        _: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        Err(fail())
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(fail())
    }
}
fn fail() -> GatewayError {
    GatewayError::unavailable("Synthetic native client refusal", "fixture_refusal")
}
fn run<F: std::future::Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    loop {
        if let std::task::Poll::Ready(v) = future.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::yield_now();
    }
}
struct Fixture {
    store: Store,
    identity: NativeTransportIdentity,
    owner: RegisteredRenewalOwner,
    config: AuthConfig,
    cancel: Cancel,
    account: String,
    token: String,
}
impl Fixture {
    fn new() -> Self {
        let store = Store::default();
        let identity = NativeTransportIdentity::new(
            "import-client".into(),
            "owner".into(),
            "epoch".into(),
            [7; 32],
            BTreeSet::from([NativeCapability::CodexAuthImport]),
        )
        .unwrap();
        store.seed(
            keys::paid_control_owner(),
            "owner-1",
            PaidControlOwner {
                v: 1,
                owner_id: "owner".into(),
                owner_epoch: "epoch".into(),
                key_fingerprint: identity.key_fingerprint().into(),
            },
        );
        store.seed(
            keys::paid_control_config(),
            "config-1",
            PaidControlConfig {
                v: PAID_CONTROL_CONFIG_VERSION,
                owner_id: "owner".into(),
                owner_epoch: "epoch".into(),
                generation: "cfg-generation".into(),
                configuration_fingerprint: "fixture-cfg".into(),
                surplus_binding: None,
                openlux_discovery_binding: None,
                openlux_binding: None,
                source_checks: vec![PaidSourceCheck {
                    key: gateway_auth::store::key(json!(["uos_ai", "runtime_config", "v2"])).0,
                    expected_revision: None,
                }],
            },
        );
        let mut account = CodexSourceAccount {
            account_id: "synthetic-account".into(),
            access_token: Secret::new("SYNTHETIC_ACCESS_PROJECTION".into()),
            refresh_token: Secret::new(String::new()),
            updated_at_ms: now_ms() as f64,
            native_owner: Some(CodexNativeOwner {
                codex_home: "/tmp/native-import-synthetic-owner".into(),
                generation_hash: sha256_hex(b"native-generation"),
                native_refreshed_at: None,
                external_user_id: None,
                managed_source: Some(ManagedNativeSource {
                    v: MANAGED_NATIVE_SOURCE_VERSION,
                    generation_hash: sha256_hex(b"physical-native-generation"),
                }),
            }),
        };
        let source = account.identity();
        account.native_owner.as_mut().unwrap().generation_hash =
            source.native_generation_hash.clone();
        let hash = source.routing_account_hash.0.clone();
        store.seed(
            codex_source_pool_key(),
            "source-1",
            CodexSourcePool {
                accounts: vec![account],
                updated_at_ms: now_ms() as f64,
            }
            .private_source_value(),
        );
        store.seed(
            keys::pool(),
            "pool-1",
            SubscriptionPool {
                v: 1,
                pool_versionstamp: PoolVersionstamp("source-1".into()),
                accounts: vec![PoolAccount {
                    account_id_hash: source.routing_account_hash,
                    admin_account_hash: source.administrative_account_hash,
                    credential_version: source.credential_version,
                    enabled: true,
                }],
            },
        );
        let token = "uos_ai_session_SYNTHETIC_CLIENT_ADMIN".to_owned();
        let session = PasskeySession {
            token: token.clone(),
            user_id: "user-fixture".into(),
            created_at_ms: 1,
            expires_at_ms: now_ms() + 100_000,
            audience_origin: None,
        };
        store.seed(
            passkeys::key("users", "user-fixture"),
            "user-1",
            PasskeyUser {
                id: "user-fixture".into(),
                handle: "operator".into(),
                is_admin: true,
                credential_ids: vec!["credential".into()],
                created_at_ms: 1,
                updated_at_ms: 1,
            },
        );
        store.seed(passkeys::key("sessions", &token), "session-1", &session);
        store.rows.lock().unwrap().insert(
            session_index::index_key(&session_index::digest(&token))
                .unwrap()
                .0,
            session_index::record_for_session(&session, "session-1", None).unwrap(),
        );
        Self {
            store,
            identity,
            owner: RegisteredRenewalOwner::configured(
                "native-owner".into(),
                "/tmp/native-import-synthetic-owner".into(),
            )
            .unwrap(),
            config: AuthConfig {
                production: true,
                hosted: true,
                git_sha_known: true,
                ..Default::default()
            },
            cancel: Cancel::default(),
            account: hash,
            token,
        }
    }
    fn authority(&self) -> Authority<Store, Tokens> {
        Authority::with_clock(self.store.clone(), Tokens::default(), self.store.clone())
    }
    async fn actor(&self, authority: &Authority<Store, Tokens>) -> actor::NativeRenewalActor {
        actor::authenticate_admin_actor(
            authority,
            &Host,
            &self.config,
            &AuthRequest {
                method: "POST".into(),
                url: "https://synthetic-admin.invalid/native-client-preparation".into(),
                headers: BTreeMap::from([(
                    "authorization".into(),
                    format!("Bearer {}", self.token),
                )]),
                ..Default::default()
            },
            &RequestContext {
                request_id: RequestId("native-client-original".into()),
                principal: PrincipalId("passkey-user:user-fixture".into()),
                key_id: None,
                route: "native-client-preparation".into(),
                started_at_ms: now_ms(),
            },
        )
        .await
        .unwrap()
    }
    fn target(&self) -> NativeImportTarget {
        NativeImportTarget::ExistingAccount {
            account_id_hash: self.account.clone(),
        }
    }
}
#[derive(Default)]
struct Replay(Mutex<BTreeSet<String>>);
impl NativeNonceAuthority for Replay {
    async fn consume_nonce(
        &self,
        _: &str,
        nonce: &str,
        _: i64,
        _: i64,
    ) -> Result<(), GatewayError> {
        if self.0.lock().unwrap().insert(nonce.into()) {
            Ok(())
        } else {
            Err(fail())
        }
    }
}
fn auth_headers(headers: &BTreeMap<String, String>) -> NativeImportAuthHeaders<'_> {
    NativeImportAuthHeaders {
        auth: NativeAuthHeaders {
            version: &headers[NATIVE_VERSION_HEADER],
            key_id: &headers[NATIVE_KEY_HEADER],
            time_ms: &headers[NATIVE_TIME_HEADER],
            nonce: &headers[NATIVE_NONCE_HEADER],
            mac: &headers[NATIVE_MAC_HEADER],
        },
        body_sha256: &headers[NATIVE_IMPORT_BODY_HEADER],
    }
}

async fn proof_for(
    f: &Fixture,
    authority: &Authority<Store, Tokens>,
    body: &[u8],
) -> (AuthenticatedNativeImport, BTreeMap<String, String>) {
    let actor = f.actor(authority).await;
    let control =
        NativeRenewalAuthority::configured(authority, &f.identity, &f.owner, &f.config, &f.cancel);
    let prepared = control.prepare_import(&actor, f.target()).await.unwrap();
    let metadata = prepared.metadata();
    let at = now_ms();
    let nonce = base64url(&[13; 32]);
    let digest = sha256_hex(body);
    let mac = f
        .identity
        .sign_import(NativeImportKind::CodexAuth, metadata, &digest, at, &nonce)
        .unwrap();
    let headers = BTreeMap::from([
        (NATIVE_VERSION_HEADER.into(), "1".into()),
        (NATIVE_KEY_HEADER.into(), f.identity.key_id().into()),
        (NATIVE_TIME_HEADER.into(), at.to_string()),
        (NATIVE_NONCE_HEADER.into(), nonce),
        (NATIVE_MAC_HEADER.into(), mac),
        (NATIVE_IMPORT_BODY_HEADER.into(), digest),
    ]);
    let replay = Replay::default();
    let admission = NativeAuthenticator::new(&f.identity, &replay)
        .admit_import(
            NativeImportKind::CodexAuth,
            auth_headers(&headers),
            metadata,
            now_ms(),
        )
        .await
        .unwrap();
    let admitted = control.admit_import(admission).await.unwrap();
    let proof = control.finish_import(admitted, body).await.unwrap();
    (proof, headers)
}
fn original<'a>(
    headers: &'a BTreeMap<String, String>,
    disconnected: &'a dyn Fn() -> bool,
) -> NativeControlContext<'a> {
    NativeControlContext::admitted(
        std::time::Instant::now() + std::time::Duration::from_secs(20),
        disconnected,
        auth_headers(headers).auth,
    )
}
struct Consumer {
    auth: SourceJson,
    version: Option<JsString16>,
    raw: Vec<u8>,
    other_proof: Option<AuthenticatedNativeImport>,
    calls: AtomicU64,
}
impl Consumer {
    fn expected(auth: &str, version: Option<JsString16>, raw: &[u8]) -> Self {
        Self {
            auth: SourceJson::parse(auth).unwrap(),
            version,
            raw: raw.to_vec(),
            other_proof: None,
            calls: AtomicU64::new(0),
        }
    }
}
impl NativeImportHandler for Consumer {
    fn import_document(
        &self,
        proof: &AuthenticatedNativeImport,
        metadata: &NativeImportMetadata,
        raw: &[u8],
        context: &NativeImportContext<'_>,
    ) -> Result<NativeImportResult, GatewayError> {
        context.check_document(proof, metadata, raw)?;
        assert!(raw == self.raw, "unchanged original document");
        assert!(
            context.auth_data().auth().as_str() == self.auth.as_str(),
            "actual retained source auth input"
        );
        assert!(
            context.auth_data().client_version() == self.version.as_ref(),
            "actual UTF16 client-version input"
        );
        if let Some(other) = &self.other_proof {
            assert!(
                context
                    .check_document(other, other.metadata(), raw)
                    .is_err(),
                "another actual proof cannot reuse the context"
            );
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(NativeImportResult {
            status: 200,
            headers: BTreeMap::new(),
            body: SourceJson::parse("{\"native_data_consumed\":true}").unwrap(),
            completion: NativeImportCompletion::Unavailable,
        })
    }
}
const AUTH: &str = r#"{"tokens":{"access_token":"SYNTHETIC_NATIVE_ACCESS","refresh_token":"SYNTHETIC_NATIVE_REFRESH","account_id":"synthetic-account"}}"#;
#[test]
fn actual_decoder_data_is_meaningful_handler_input_for_bare_wrapped_bom_and_utf16() {
    run(async {
        for (body, version) in [
            (AUTH.as_bytes().to_vec(), None),
            (format!(r#" {{"auth":{AUTH},"models":{{"client_version":"","clientVersion":"ignored"}}}} "#).into_bytes(), Some(JsString16::from_units(vec![]))),
            (format!(r#"{{"auth":{AUTH},"models":{{"clientVersion":"\ud800"}}}}"#).into_bytes(), Some(JsString16::from_units(vec![0xd800]))),
            ([&[0xef,0xbb,0xbf][..],AUTH.as_bytes()].concat(), None),
        ] {
            let f = Fixture::new(); let authority = f.authority();
            let (proof, headers) = proof_for(&f, &authority, &body).await;
            let control = NativeRenewalAuthority::configured(&authority, &f.identity, &f.owner, &f.config, &f.cancel);
            let connected = || false; let original = original(&headers, &connected);
            let consumer = Consumer::expected(AUTH, version, &body);
            let result = dispatch_import(&consumer, &control, &proof, proof.metadata(), &body, &original).await.unwrap();
            assert_eq!(result.status, 200); assert_eq!(consumer.calls.load(Ordering::SeqCst), 1);
            let capture = f.store.captured();
            for forbidden in ["SYNTHETIC_NATIVE_ACCESS", "SYNTHETIC_NATIVE_REFRESH", &sha256_hex(&body)] { assert!(!capture.contains(forbidden), "native source inputs/digest absent from actual authority transactions"); }
        }
    });
}
#[test]
fn a_different_actual_proof_cannot_observe_the_retained_auth_context() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let body = AUTH.as_bytes();
        let (proof, headers) = proof_for(&f, &authority, body).await;
        let (other, _) = proof_for(&f, &authority, body).await;
        let control = NativeRenewalAuthority::configured(
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        );
        let connected = || false;
        let original = original(&headers, &connected);
        let mut consumer = Consumer::expected(AUTH, None, body);
        consumer.other_proof = Some(other);
        dispatch_import(
            &consumer,
            &control,
            &proof,
            proof.metadata(),
            body,
            &original,
        )
        .await
        .unwrap();
        assert_eq!(consumer.calls.load(Ordering::SeqCst), 1);
    });
}
#[test]
fn actual_bound_but_invalid_auth_uses_original_error_without_calling_handler() {
    run(async {
        for body in [
            b"{}".to_vec(),
            b"{".to_vec(),
            [&[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf][..], AUTH.as_bytes()].concat(),
        ] {
            let f = Fixture::new();
            let authority = f.authority();
            let (proof, headers) = proof_for(&f, &authority, &body).await;
            let control = NativeRenewalAuthority::configured(
                &authority,
                &f.identity,
                &f.owner,
                &f.config,
                &f.cancel,
            );
            let connected = || false;
            let original = original(&headers, &connected);
            let consumer = Consumer::expected(AUTH, None, &body);
            match dispatch_import(
                &consumer,
                &control,
                &proof,
                proof.metadata(),
                &body,
                &original,
            )
            .await
            {
                Err(error) => {
                    assert_eq!(error.status, 400);
                    assert_eq!(
                        error.envelope.error.message,
                        "Body does not look like a Codex auth.json"
                    );
                    assert_eq!(
                        error.envelope.error.code.as_deref(),
                        Some("invalid_request_error")
                    );
                }
                Ok(_) => panic!("invalid AUTH reached the handler"),
            }
            assert_eq!(consumer.calls.load(Ordering::SeqCst), 0);
        }
    });
}
#[test]
fn original_cancellation_metadata_and_raw_binding_precede_any_decode_error() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let body = b"{";
        let (proof, headers) = proof_for(&f, &authority, body).await;
        let control = NativeRenewalAuthority::configured(
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        );
        let disconnected = || true;
        let cancelled = original(&headers, &disconnected);
        let consumer = Consumer::expected(AUTH, None, body);
        match dispatch_import(
            &consumer,
            &control,
            &proof,
            proof.metadata(),
            body,
            &cancelled,
        )
        .await
        {
            Err(error) => assert_eq!(
                error.envelope.error.code.as_deref(),
                Some("native_control_outcome_unknown")
            ),
            Ok(_) => panic!("cancelled dispatch"),
        }
        let connected = || false;
        let original = original(&headers, &connected);
        let mut wrong = proof.metadata().clone();
        wrong.action_ref = "a".repeat(64);
        match dispatch_import(&consumer, &control, &proof, &wrong, body, &original).await {
            Err(error) => assert_eq!(error.status, 403),
            Ok(_) => panic!("wrong metadata"),
        }
        assert!(
            dispatch_import(
                &consumer,
                &control,
                &proof,
                proof.metadata(),
                b"OTHER",
                &original
            )
            .await
            .is_err()
        );
        assert_eq!(consumer.calls.load(Ordering::SeqCst), 0);
    });
}
#[test]
fn current_actual_actor_revocation_is_checked_before_the_auth_decoder() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let body = b"{";
        let (proof, headers) = proof_for(&f, &authority, body).await;
        f.store.seed(
            passkeys::key("users", "user-fixture"),
            "user-revoked",
            PasskeyUser {
                id: "user-fixture".into(),
                handle: "operator".into(),
                is_admin: false,
                credential_ids: vec!["credential".into()],
                created_at_ms: 1,
                updated_at_ms: now_ms(),
            },
        );
        let control = NativeRenewalAuthority::configured(
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        );
        let connected = || false;
        let original = original(&headers, &connected);
        let consumer = Consumer::expected(AUTH, None, body);
        match dispatch_import(
            &consumer,
            &control,
            &proof,
            proof.metadata(),
            body,
            &original,
        )
        .await
        {
            Err(error) => assert_eq!(
                error.envelope.error.code.as_deref(),
                Some("native_actor_unavailable")
            ),
            Ok(_) => panic!("stale actor"),
        }
        assert_eq!(consumer.calls.load(Ordering::SeqCst), 0);
    });
}
#[test]
fn ingress_header_guard_and_error_mapping_are_the_original_source_rules() {
    use import_body::{AuthReadFailure, check_auth_content_length};
    for good in [None, Some("0"), Some("33554432")] {
        assert!(check_auth_content_length(good).is_ok());
    }
    for invalid in ["", "00", "1.0", "+1", " 1", "9007199254740992"] {
        assert_eq!(
            check_auth_content_length(Some(invalid)),
            Err(AuthReadFailure::Invalid)
        );
    }
    assert_eq!(
        check_auth_content_length(Some("33554433")),
        Err(AuthReadFailure::TooLarge)
    );
    let error = auth_body_error();
    assert_eq!(error.status, 400);
    assert_eq!(
        error.envelope.error.message,
        "Body does not look like a Codex auth.json"
    );
    assert_eq!(error.envelope.error.error_type, "invalid_request_error");
}

mod existing_account_import;
