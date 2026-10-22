use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

use gateway_auth::{
    crypto::{Secret, base64url},
    origin::*,
    passkeys::*,
    upstream::*,
    *,
};
use gateway_core::state::*;
use serde_json::json;

#[test]
fn authentication_requires_declared_json_and_never_guesses_profile_tags() {
    let ambiguous = json!({"type":"binary","value":{"kind":"Uint8Array","bytes":[1,2],"byte_offset":0,"byte_length":2}});
    let plain = StoredRecord::json("plain", ambiguous.clone(), None);
    assert_eq!(
        gateway_auth::store::decode::<serde_json::Value>(Some(&plain), 1).unwrap(),
        Some(ambiguous.clone())
    );
    let typed = StoredRecord::profile(
        "typed",
        gateway_core::value::PortableValue::from_json(&ambiguous),
        None,
    )
    .unwrap();
    let error = gateway_auth::store::decode::<serde_json::Value>(Some(&typed), 1).unwrap_err();
    assert_eq!(
        error.envelope.error.code.as_deref(),
        Some("incompatible_value_encoding")
    );
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
        for check in &transition.checks {
            if rows.get(&check.key.0).map(|r| &r.revision) != check.expected_revision.as_ref() {
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
struct Host {
    now: Cell<i64>,
    serial: Cell<u64>,
}
impl Default for Host {
    fn default() -> Self {
        Self {
            now: Cell::new(1_000_000),
            serial: Cell::new(1),
        }
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        let serial = self.serial.get();
        self.serial.set(serial + 1);
        Ok((0..len)
            .map(|i| serial.wrapping_add(i as u64) as u8)
            .collect())
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
            "Fixture forbids policy creation",
            "fixture_policy_denied",
        ))
    }
}
fn request(url: &str) -> AuthRequest {
    AuthRequest {
        method: "GET".into(),
        url: url.into(),
        ..Default::default()
    }
}
fn insert<T: serde::Serialize>(store: &Store, key: RecordKey, value: &T) {
    store.rows.borrow_mut().insert(
        key.0,
        StoredRecord::json(
            "fixture-revision",
            serde_json::to_value(value).unwrap(),
            None,
        ),
    );
}

#[test]
fn source_pool_reads_keep_codec_expiry_and_authority_revision_explicit() {
    run(async {
        use gateway_auth::provider_credentials::{codex_source_pool_key, read_codex_source_pool};
        let store = Store::default();
        let key = codex_source_pool_key();
        let value = json!({"accounts":[{"account_id":"fixture","access_token":"fixture-access","refresh_token":"fixture-refresh","updated_at_ms":1}],"updated_at_ms":2});
        store.rows.borrow_mut().insert(
            key.0.clone(),
            StoredRecord::json("exact-current-generation", value.clone(), Some(100)),
        );
        let snapshot = read_codex_source_pool(&store, 99).await.unwrap().unwrap();
        assert_eq!(snapshot.revision, "exact-current-generation");
        assert_eq!(snapshot.pool.accounts[0].account_id, "fixture");
        assert!(read_codex_source_pool(&store, 100).await.unwrap().is_none());
        store.rows.borrow_mut().insert(
            key.0,
            StoredRecord::profile(
                "typed-profile",
                gateway_core::value::PortableValue::from_json(&value),
                None,
            )
            .unwrap(),
        );
        assert_eq!(
            read_codex_source_pool(&store, 99)
                .await
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("incompatible_value_encoding")
        );
    });
}

#[test]
fn exact_candidate_rp_and_relay_trust() {
    let mut config = AuthConfig::default();
    let req = request("https://uos-ai-rust-candidate.ubq.workers.dev/api/auth/login/start");
    assert_eq!(
        passkey_meta(
            &req,
            Some("https://uos-ai-rust-candidate.ubq.workers.dev"),
            &config
        ),
        (CANONICAL_ORIGIN.into(), "ai.ubq.fi".into())
    );
    assert_eq!(
        trusted_relay_origin("https://uos-ai-rust-candidate.ubq.workers.dev", &config),
        None
    );
    assert_eq!(
        passkey_meta(&request(CANDIDATE_ORIGIN), Some(CANDIDATE_ORIGIN), &config).0,
        CANONICAL_ORIGIN
    );
    config.candidate_passkeys = true;
    assert_eq!(
        passkey_meta(&request(CANDIDATE_ORIGIN), Some(CANDIDATE_ORIGIN), &config),
        (CANDIDATE_ORIGIN.into(), "ai.ubq.fi".into())
    );
    for bad in [
        "https://ai.ubq.fi.evil.example",
        "https://ai.ubq.fi:444",
        "http://ai.ubq.fi",
        "https://user@ai.ubq.fi",
        "https://ai.ubq.fi/path",
        "https://ai.ubq.fi?x=1",
    ] {
        assert!(trusted_relay_origin(bad, &config).is_none(), "{bad}");
    }
    assert!(trusted_relay_origin("https://ai-ubq-fi-abcdef123456.deno.dev", &config).is_some());
    assert!(trusted_relay_origin("https://ai-ubq-fi-ABCDEF123456.deno.dev", &config).is_none());
}

#[test]
fn loopback_bypass_requires_actual_peer_and_origin() {
    let config = AuthConfig::default();
    let mut req = request("http://127.0.0.1:8000/admin");
    assert!(!local_bypass(&req, &config));
    req.native_peer = Some(NativePeer {
        listener_bypass_enabled: true,
        tcp: true,
        hostname: "127.0.0.1".into(),
    });
    assert!(local_bypass(&req, &config));
    req.headers
        .insert("origin".into(), "https://evil.example".into());
    assert!(!local_bypass(&req, &config));
    req.headers.remove("origin");
    req.headers
        .insert("sec-fetch-site".into(), "cross-site".into());
    assert!(!local_bypass(&req, &config));
    req.headers.clear();
    let config = AuthConfig {
        production: true,
        ..config
    };
    assert!(!local_bypass(&req, &config));
}

#[test]
fn anonymous_budget_and_challenge_count_are_bounded() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig::default();
        let service = PasskeyService {
            store: &store,
            host: &host,
            config: &config,
        };
        let mut req = request("https://ai.ubq.fi/api/auth/login/start");
        req.method = "POST".into();
        for _ in 0..10 {
            assert_eq!(service.login_start(&req).await.unwrap().status, 200);
        }
        let denied = service.login_start(&req).await.unwrap();
        assert_eq!(denied.status, 429);
        assert!(denied.headers.contains_key("retry-after"));
        assert_eq!(
            store
                .rows
                .borrow()
                .values()
                .filter(
                    |row| row.json_value().unwrap().get("type") == Some(&json!("authentication"))
                )
                .count(),
            10
        );
        host.now.set(host.now.get() + 60_000);
        assert_eq!(service.login_start(&req).await.unwrap().status, 200);
    });
}

#[test]
fn session_reads_current_role_and_audience_and_expiry() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig::default();
        let user = PasskeyUser {
            id: "user".into(),
            handle: "operator".into(),
            is_admin: true,
            credential_ids: vec!["cred".into()],
            created_at_ms: 0,
            updated_at_ms: 0,
        };
        insert(&store, key("users", "user"), &user);
        let session = PasskeySession {
            token: "uos_ai_session_fixture".into(),
            user_id: "user".into(),
            created_at_ms: 0,
            expires_at_ms: 2_000_000,
            audience_origin: Some(CANONICAL_ORIGIN.into()),
        };
        insert(&store, key("sessions", &session.token), &session);
        let auth = AuthService::new(&store, &host, &config);
        let mut req = request("https://ai.ubq.fi/admin");
        req.headers.insert(
            "cookie".into(),
            format!("ignored; {RELAY_COOKIE}={}", session.token),
        );
        req.headers.insert("origin".into(), CANONICAL_ORIGIN.into());
        let principal = auth.authenticate_admin(&req).await.unwrap();
        assert!(principal.is_admin);
        assert!(!principal.is_super_admin);
        let mut user = user;
        user.is_admin = false;
        insert(&store, key("users", "user"), &user);
        assert_eq!(auth.authenticate_admin(&req).await.unwrap_err().status, 403);
        req.headers
            .insert("origin".into(), "https://ai-ubq-fi.deno.dev".into());
        assert_eq!(
            auth.authenticate_client(&req).await.unwrap_err().status,
            401
        );
        host.now.set(2_000_000);
        req.headers.insert("origin".into(), CANONICAL_ORIGIN.into());
        assert_eq!(
            auth.authenticate_client(&req).await.unwrap_err().status,
            401
        );
    });
}

#[test]
fn failed_assertion_consumes_challenge_without_creating_session() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig::default();
        let service = PasskeyService {
            store: &store,
            host: &host,
            config: &config,
        };
        let challenge = PasskeyChallenge {
            challenge: "issued".into(),
            kind: "authentication".into(),
            origin: CANONICAL_ORIGIN.into(),
            rp_id: "ai.ubq.fi".into(),
            audience_origin: None,
            user_id: None,
            handle: None,
            is_admin: None,
            created_at_ms: 0,
            expires_at_ms: 2_000_000,
        };
        insert(&store, key("challenges", "issued"), &challenge);
        let mut req = request("https://ai.ubq.fi/api/auth/login/finish");
        req.method = "POST".into();
        req.body=json!({"response":{"id":"unknown","response":{"clientDataJSON":base64url(br#"{"challenge":"issued","type":"webauthn.get","origin":"https://ai.ubq.fi"}"#)}}}).to_string().into_bytes();
        assert_eq!(service.login_finish(&req).await.unwrap_err().status, 400);
        assert!(
            !store
                .rows
                .borrow()
                .contains_key(&key("challenges", "issued").0)
        );
        assert_eq!(service.login_finish(&req).await.unwrap_err().status, 400);
    });
}

#[test]
fn api_key_authentication_is_quota_free_and_secret_debug_is_redacted() {
    run(async {
        let token = format!("u_{}", "ab".repeat(32));
        assert!(api_keys::api_key_shape(&token));
        assert!(!api_keys::api_key_shape(&token.to_ascii_uppercase()));
        let hash = gateway_auth::crypto::sha256_base64url(token.as_bytes());
        let store = Store::default();
        let record = api_keys::ApiKeyHashRecord {
            id: "key".into(),
            expires_at_ms: -1,
            revoked_at_ms: None,
            usage_limit_requests: 0,
            usage_requests: 0,
            usage_reset_at_ms: 2_000_000,
            window_ms: 1_000_000,
            usage_quota_version: 3,
            paid_fallback_enabled: false,
            paid_fallback_limit_microcredits: 0,
            paid_fallback_spent_microcredits: 0,
            paid_fallback_reserved_microcredits: 0,
            paid_fallback_reservation_request_id: None,
        };
        insert(&store, api_keys::hash_key(&hash), &record);
        assert!(
            api_keys::authenticate(&store, &token, 1_000_000)
                .await
                .is_ok()
        );
        assert_eq!(store.rows.borrow().len(), 1);
        assert!(!format!("{:?}", Secret::new(token.clone())).contains(&token));
        let mut record = record;
        record.expires_at_ms = 1_000_000;
        insert(&store, api_keys::hash_key(&hash), &record);
        assert_eq!(
            api_keys::authenticate(&store, &token, 1_000_000)
                .await
                .unwrap_err()
                .status,
            401
        );
    });
}

#[test]
fn admin_allowlist_and_github_tokens_never_mix() {
    run(async {
        let store = Store::default();
        let host = Host::default();
        let config = AuthConfig {
            admin_tokens: vec![Secret::new("ghp_explicitly_allowlisted".into())],
            ..Default::default()
        };
        let service = AuthService::new(&store, &host, &config);
        let mut req = request("https://ai.ubq.fi/admin");
        req.headers.insert(
            "authorization".into(),
            "Bearer ghp_explicitly_allowlisted".into(),
        );
        assert!(
            service
                .authenticate_admin(&req)
                .await
                .unwrap()
                .is_super_admin
        );
        req.headers
            .insert("authorization".into(), "Bearer ghp_not_allowlisted".into());
        assert_eq!(
            service.authenticate_admin(&req).await.unwrap_err().status,
            401
        );
        req.headers.insert(
            "authorization".into(),
            "Bearer u_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into(),
        );
        assert_eq!(
            service.authenticate_admin(&req).await.unwrap_err().status,
            401
        );
    });
}

#[test]
fn deno_console_requires_real_title_and_exact_candidate_is_prepared_only() {
    assert!(console_title_matches(
        b"<html><title>Org | p-ai-ubq-fi | Deploy</title></html>",
        "p-ai-ubq-fi"
    ));
    assert!(!console_title_matches(
        b"<body>/org/p-ai-ubq-fi | Deploy</body>",
        "p-ai-ubq-fi"
    ));
    assert!(deno_token_shape("ddw_012345678901234567890"));
    assert!(!deno_token_shape("uos_ai_session_012345678901234567890"));
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

#[test]
fn named_kernel_public_key_reader_preserves_source_rows_until_crypto_projection() {
    use gateway_core::{source_control::encode_source_control_record, source_json::SourceJson};
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/kernel-source-public.json")).unwrap();
    let pem = fixture["pem"].as_str().unwrap();
    let good = SourceJson::from_serializable(
        &json!({"app_id":1,"pem":pem,"owner":"fixture","added_at_ms":1}),
    )
    .unwrap();
    let invalid=SourceJson::parse(r#"{"app_id":2,"pem":"-----BEGIN PUBLIC KEY-----\ud800-----END PUBLIC KEY-----","owner":"\udc00","added_at_ms":1}"#).unwrap();
    let key = kernel_public_keys_key();
    run(async {
        for source in [
            format!("[{}]", good.as_str()),
            format!("[{},{}]", invalid.as_str(), good.as_str()),
        ] {
            let store = Store::default();
            let host = Host::default();
            let row = encode_source_control_record(
                "exact-revision",
                &SourceJson::parse(&source).unwrap(),
                Some(1_000_001),
            )
            .unwrap();
            store.rows.borrow_mut().insert(key.0.clone(), row.clone());
            let cfg = AuthConfig {
                production: true,
                ..Default::default()
            };
            let service = AuthService::new(&store, &host, &cfg);
            let mut req = request("https://ai.ubq.fi/v1/responses");
            req.headers
                .insert("authorization".into(), "Bearer ghp_fixture".into());
            req.headers.insert(
                "x-ubiquity-kernel-token".into(),
                fixture["jwt"].as_str().unwrap().into(),
            );
            // The genuine RSA signature passes, then the pre-existing injected
            // host refuses its GitHub lookup. No network or authority is minted.
            let error = service.authenticate_client(&req).await.unwrap_err();
            assert_eq!(error.status, 502);
            assert_eq!(error.envelope.error.code.as_deref(), Some("bad_gateway"));
            assert_eq!(store.read(&key).await.unwrap(), Some(row));
        }
        let store = Store::default();
        let host = Host::default();
        let cfg = AuthConfig {
            production: true,
            ..Default::default()
        };
        let service = AuthService::new(&store, &host, &cfg);
        let mut req = request("https://ai.ubq.fi/v1/responses");
        req.headers
            .insert("authorization".into(), "Bearer ghp_fixture".into());
        req.headers.insert(
            "x-ubiquity-kernel-token".into(),
            fixture["jwt"].as_str().unwrap().into(),
        );
        let bad = SourceJson::parse(&format!("[{}]", invalid.as_str())).unwrap();
        store.rows.borrow_mut().insert(
            key.0.clone(),
            encode_source_control_record("invalid-pem", &bad, None).unwrap(),
        );
        // Source skips an invalid imported PEM after persistence. The existing
        // no-public-key response remains, not a row/profile decoding failure.
        assert_eq!(
            service.authenticate_client(&req).await.unwrap_err().status,
            500
        );
        let good = SourceJson::parse(&format!("[{}]", good.as_str())).unwrap();
        store.rows.borrow_mut().insert(
            key.0.clone(),
            encode_source_control_record("expired", &good, Some(1_000_000)).unwrap(),
        );
        assert_eq!(
            service.authenticate_client(&req).await.unwrap_err().status,
            500
        );
        store.rows.borrow_mut().insert(
            key.0.clone(),
            StoredRecord::json("bad-shape", json!({"pem":pem}), None),
        );
        assert_eq!(
            service
                .authenticate_client(&req)
                .await
                .unwrap_err()
                .envelope
                .error
                .code
                .as_deref(),
            Some("auth_state_corrupt")
        );
    });
}
