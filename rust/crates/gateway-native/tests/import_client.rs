//! Actual in-process admin preparation + native signed construction, not HTTP,
//! effect/provider import or verified Cloudflare completion.
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
use gateway_native::import_client::{ClientError, NativeImportClient};
use serde::Serialize;
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
const NOW: i64 = 1_000_000;
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
        Ok(NOW)
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
        NOW
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
            updated_at_ms: NOW as f64,
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
                updated_at_ms: NOW as f64,
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
            expires_at_ms: 1_100_000,
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
                started_at_ms: NOW,
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
#[test]
fn real_admin_preparation_native_only_raw_mac_and_actual_body_admission_without_completion() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let actor = f.actor(&authority).await;
        let endpoint = "127.0.0.1:32101".parse().unwrap();
        let client = NativeImportClient::configured(
            endpoint,
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        )
        .unwrap();
        let prepared = client.prepare(&actor, f.target()).await.unwrap();
        assert_eq!(prepared.target(), &f.target());
        assert_eq!(prepared.deadline_ms(), NOW + 45_000);
        prepared.metadata().validate().unwrap();
        let before = f.store.captured();
        let body=br#" { "auth":{"tokens":{"access_token":"NATIVE_ONLY_ACCESS","refresh_token":"NATIVE_ONLY_REFRESH","account_id":"synthetic-account"}},"models":{"client_version":""} } "#;
        let nonce = base64url(&[1; 32]);
        let request = client.request(prepared, body, NOW, &nonce).unwrap();
        assert_eq!(request.endpoint(), endpoint);
        assert_eq!(request.method(), "POST");
        assert_eq!(request.path(), NativeImportKind::CodexAuth.path());
        assert!(request.body() == body, "original native body");
        assert_eq!(request.body().as_ptr(), body.as_ptr());
        assert_eq!(
            request.headers()[NATIVE_IMPORT_OPERATION_HEADER],
            request.metadata().operation_id
        );
        assert_eq!(
            request.headers()[NATIVE_IMPORT_ACTION_HEADER],
            request.metadata().action_ref
        );
        assert_eq!(
            request.headers()[NATIVE_IMPORT_BODY_HEADER],
            sha256_hex(body)
        );
        assert_eq!(
            f.store.captured(),
            before,
            "construction performs zero authority request"
        );
        let replay = Replay::default();
        let admission = NativeAuthenticator::new(&f.identity, &replay)
            .admit_import(
                NativeImportKind::CodexAuth,
                auth_headers(request.headers()),
                request.metadata(),
                NOW,
            )
            .await
            .unwrap();
        let control = NativeRenewalAuthority::configured(
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        );
        let admitted = control.admit_import(admission).await.unwrap();
        let proof = control
            .finish_import(admitted, request.body())
            .await
            .unwrap();
        proof.require_body(body, NOW).unwrap();
        control.recheck_import(&proof).await.unwrap();
        assert_eq!(proof.metadata(), request.metadata());
        assert_eq!(proof.target(), &f.target());
        let capture = f.store.captured();
        for forbidden in [
            "NATIVE_ONLY_ACCESS",
            "NATIVE_ONLY_REFRESH",
            &sha256_hex(body),
        ] {
            assert!(
                !capture.contains(forbidden),
                "native document/digest absent from actual authority request capture"
            );
        }
        for row in f.store.rows.lock().unwrap().values() {
            let stored = serde_json::to_string(row).unwrap();
            for forbidden in [
                "NATIVE_ONLY_ACCESS",
                "NATIVE_ONLY_REFRESH",
                &sha256_hex(body),
            ] {
                assert!(
                    !stored.contains(forbidden),
                    "native document/digest absent from authority state"
                );
            }
        }
        println!(
            "REAL_ADMIN_PREPARATION_AND_NATIVE_BODY_PROOF_PASSED;HTTP_EFFECT_COMPLETION_UNPROVED"
        );
    });
}
#[test]
fn only_explicit_loopback_config_and_same_client_prepared_handles_are_accepted() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let actor = f.actor(&authority).await;
        for endpoint in ["192.0.2.1:32101", "127.0.0.1:0"] {
            assert!(matches!(
                NativeImportClient::configured(
                    endpoint.parse().unwrap(),
                    &authority,
                    &f.identity,
                    &f.owner,
                    &f.config,
                    &f.cancel
                ),
                Err(ClientError::InvalidEndpoint)
            ));
        }
        let a = NativeImportClient::configured(
            "127.0.0.1:32101".parse().unwrap(),
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        )
        .unwrap();
        let b = NativeImportClient::configured(
            "[::1]:32102".parse().unwrap(),
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        )
        .unwrap();
        let prepared = a.prepare(&actor, f.target()).await.unwrap();
        assert!(matches!(
            b.request(prepared, b"LOCAL_DOCUMENT", NOW, &base64url(&[2; 32])),
            Err(ClientError::ForeignPrepared)
        ));
    });
}
#[test]
fn cancelled_expired_unsupported_targets_and_wrong_identity_fail_without_native_dispatch() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let actor = f.actor(&authority).await;
        let client = NativeImportClient::configured(
            "127.0.0.1:32101".parse().unwrap(),
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        )
        .unwrap();
        for target in [
            NativeImportTarget::PreparedAccountSlot {
                slot_ref: "not-granted".into(),
            },
            NativeImportTarget::PreparedProfile {
                profile_ref: "not-granted".into(),
            },
            NativeImportTarget::ExistingAccount {
                account_id_hash: "a".repeat(64),
            },
        ] {
            match client.prepare(&actor, target).await {
                Err(ClientError::Native(error)) => assert_eq!(
                    error.envelope.error.code.as_deref(),
                    Some("native_import_authority_unavailable")
                ),
                _ => panic!("unsupported target was not refused by actual authority"),
            }
        }
        f.cancel.0.store(true, Ordering::SeqCst);
        assert!(matches!(
            client.prepare(&actor, f.target()).await,
            Err(ClientError::Cancelled)
        ));
        f.cancel.0.store(false, Ordering::SeqCst);
        let prepared = client.prepare(&actor, f.target()).await.unwrap();
        let deadline = prepared.deadline_ms();
        assert!(matches!(
            client.request(prepared, b"LOCAL_DOCUMENT", deadline, &base64url(&[3; 32])),
            Err(ClientError::Expired)
        ));
        let prepared = client.prepare(&actor, f.target()).await.unwrap();
        f.cancel.0.store(true, Ordering::SeqCst);
        assert!(matches!(
            client.request(prepared, b"LOCAL_DOCUMENT", NOW, &base64url(&[4; 32])),
            Err(ClientError::Cancelled)
        ));
        f.cancel.0.store(false, Ordering::SeqCst);
        let wrong = NativeTransportIdentity::new(
            "other".into(),
            "wrong-owner".into(),
            "wrong-epoch".into(),
            [8; 32],
            BTreeSet::from([NativeCapability::CodexAuthImport]),
        )
        .unwrap();
        let wrong_client = NativeImportClient::configured(
            "127.0.0.1:32101".parse().unwrap(),
            &authority,
            &wrong,
            &f.owner,
            &f.config,
            &f.cancel,
        )
        .unwrap();
        assert!(matches!(
            wrong_client.prepare(&actor, f.target()).await,
            Err(ClientError::Native(_))
        ));
    });
}
#[test]
fn bare_wrapped_bytes_and_tampered_metadata_mac_or_body_are_native_only() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let actor = f.actor(&authority).await;
        let client = NativeImportClient::configured(
            "127.0.0.1:32101".parse().unwrap(),
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        )
        .unwrap();
        for (index,body) in [br#"{"tokens":{"refresh_token":"LOCAL_REFRESH"}} "#.as_slice(),br#"{"auth":{"tokens":{"refresh_token":"LOCAL_REFRESH"}},"models":{"clientVersion":"0.126.0"}}"#.as_slice()].iter().enumerate(){
   let prepared=client.prepare(&actor,f.target()).await.unwrap();let request=client.request(prepared,body,NOW,&base64url(&[10+index as u8;32])).unwrap();assert!(request.body()==*body,"no parse/rewrap/scalar conversion");
   let replay=Replay::default();let auth=NativeAuthenticator::new(&f.identity,&replay);
   assert!(auth.admit_import(NativeImportKind::NativeProfile,auth_headers(request.headers()),request.metadata(),NOW).await.is_err());
   let mut tampered=request.headers().clone();tampered.insert(NATIVE_IMPORT_BODY_HEADER.into(),sha256_hex(b"OTHER"));
   assert!(auth.admit_import(NativeImportKind::CodexAuth,auth_headers(&tampered),request.metadata(),NOW).await.is_err());
   let mut changed_metadata=request.metadata().clone();changed_metadata.action_ref="b".repeat(64);
   assert!(auth.admit_import(NativeImportKind::CodexAuth,auth_headers(request.headers()),&changed_metadata,NOW).await.is_err());
   let mut changed_mac=request.headers().clone();changed_mac.insert(NATIVE_MAC_HEADER.into(),base64url(&[0;32]));
   assert!(auth.admit_import(NativeImportKind::CodexAuth,auth_headers(&changed_mac),request.metadata(),NOW).await.is_err());
   let admission=auth.admit_import(NativeImportKind::CodexAuth,auth_headers(request.headers()),request.metadata(),NOW).await.unwrap();
   assert!(admission.verify_body(b"DIFFERENT",NOW).is_err());
   assert!(!f.store.captured().contains(&sha256_hex(body)));
  }
    });
}

#[test]
fn revoked_actual_admin_actor_cannot_prepare_a_native_request() {
    run(async {
        let f = Fixture::new();
        let authority = f.authority();
        let actor = f.actor(&authority).await;
        f.store.seed(
            passkeys::key("users", "user-fixture"),
            "user-revoked",
            PasskeyUser {
                id: "user-fixture".into(),
                handle: "operator".into(),
                is_admin: false,
                credential_ids: vec!["credential".into()],
                created_at_ms: 1,
                updated_at_ms: NOW,
            },
        );
        let client = NativeImportClient::configured(
            "127.0.0.1:32101".parse().unwrap(),
            &authority,
            &f.identity,
            &f.owner,
            &f.config,
            &f.cancel,
        )
        .unwrap();
        assert!(matches!(
            client.prepare(&actor, f.target()).await,
            Err(ClientError::Native(_))
        ));
    });
}
