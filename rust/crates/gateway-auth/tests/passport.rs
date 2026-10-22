use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    task::{Context, Poll, Waker},
};

use gateway_auth::{
    AuthConfig, AuthHost, AuthMethod, AuthRequest, AuthService,
    crypto::base64url,
    origin::same_origin_mutation,
    passport::{
        PASSPORT_COOKIE, PASSPORT_STATE_COOKIE, PassportClaims, PassportConfig, PassportService,
        reset_jwks_cache, verify_jwt,
    },
    upstream::{AuthUpstreamRequest, AuthUpstreamResponse},
    webauthn::{CosePublicKey, SignatureInput, WebAuthnCrypto},
};
use gateway_core::{
    GatewayError,
    state::{AtomicTransition, AuthorityStore, CommitOutcome, RecordKey, StoredRecord},
};
use rsa::{
    RsaPrivateKey,
    pkcs1v15::SigningKey,
    pkcs8::DecodePrivateKey,
    signature::{SignatureEncoding, Signer},
    traits::PublicKeyParts,
};
use serde_json::{Value, json};
use sha2::Sha256;

const PRIVATE_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC2KZoerxCpwvKR
/jhLxhtSgAwXFc024RC923ofAAkWD2O1OFDdktMX1i7/gHqE1kyquoSCTPM8AJvG
Y8HKsFWnWrH+sMrgq2gMjrt1cM0s9vL2MnQvLELUz7MDoxzrFCXQnsdhzlUWL9Pv
h3ZH2wlv2IVjHmd8iS4Y9rIu52jP/uyGQa8GmruSRRHxE4Qo5pvmM/QHT75zkb0K
Z1JBH/8r5vDbQIU+PP5Gt4EgN2UV1hBvHaXmJ8r7QTEHunwnDTBZqA/ny5zH03q5
gcBDwA0RroWhyutjbWm2z+8s22XpY4GgTr4AKeMO1ynfy35BqaLRNqG+lHfVzV1k
FU5UYwJ3AgMBAAECggEABDxrbRM9G/WAloyG2pw8vmpj3ZWQNBp/vSqBaH8jtvOc
qfYpSz3C0ucUKLTgJH6nQcEcm7sWXOrWtIJVW1VGaKHfScDqttbFkKUxDsYUv1ru
w3Lg6MfqtfAuhYMhhQXu6y8GC+w0ZlOuZf+MbJdXXNZ4I5ntZiP6gnIaKqUO9uc4
isQI0viUHym/o9331WfV3Pg6F6V2/KEBqA9OWoBLcwY2K+UeKiIeu1iUAcBGIG83
FcXA34iqdVLe0+CymttjVmjVGOD9szJzO09U/Q1R2mwo+YNIW2fXC9YULLpQxPAU
Feyk2fV2rS3bSPsJRhWgC7eMCHIRnvErGeRZauybgQKBgQD5jb3QVFpnx+wMfL5+
6CsyAzepklIcS9r18CzdQYjvQb+IHqQlMCnn3lrmrJcVaP4g/o7VoBAlC3aVUrjk
LWoUVJmyltS5Hm/QYuaH4ieDk6tTnAu2WDJY7L0tGXB+GT3HSJ6HclKQc1msGqdR
2RA41cOMNw5X6S4SQ2m4ijfkEQKBgQC63jarIDW6ow/7xrUnoDMjM0Or5/Z40Qm2
IB0oxLBEcEIVvLrv+IaDAwSw59INtVpeI9GPjbqW0gECDG9e7+VCsF27xNroVV/l
19sAjDXzBr7C4BON9QY+iLVcJSQaVQtZ7A8orbRGvasahZddRSw0rOdeGPoE4Lsr
tJWHIS1mBwKBgBQtfMKCf4jSpmhgEbsLJKr3jaGdXhxBmeO21rnRGbRWuZjU+Wq0
WT8RQIJURCcMBTg/vObS+Vs1cRIjzSVN8rzQFllVTr/lER9lT8R+6bj+0KSDAoNs
4C1GfwlNfEYF3nPlkEPdX4WkfgSnZw38Ig6mYhhNP1CmXv5FCyBLtLcxAoGASfMM
MVZSzOQgvCNbpy3HbuOnoQzvxcn7jN5Si8KiesLt9Ao29CYmnQwBvDxRLOmatGx6
TtPohizfBz+Ch1BqKqT+wwLZGl5Gz/9HBIV4CA+gSCBCvMe9S9vv4WI1UlJbZp97
ND7he6ktYBaD2v43yzStbth1gJ6qk1YoYkxn2dsCgYEAiDbzXmxw0yFb9sEsW+EG
ueB+H/hZWR6V/shBzlZXbRbGFypgbgK/7hyiw5agg6tGItw+g6E41GoAHt2WxRVe
zX/WE6ttFH3l9iyyV4B0Ye+CONXFoBqXR1FjTqKl2uehhKJJ1EL6S5UqB8dnwZEF
p1H85+tp157Y4v9cbfX8dHM=
-----END PRIVATE KEY-----";

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

fn private() -> RsaPrivateKey {
    RsaPrivateKey::from_pkcs8_pem(PRIVATE_PEM).unwrap()
}

fn public_jwk(kid: &str) -> Value {
    let public = private().to_public_key();
    json!({
        "kty":"RSA",
        "kid":kid,
        "alg":"RS256",
        "use":"sig",
        "n":base64url(&public.n().to_bytes_be()),
        "e":base64url(&public.e().to_bytes_be()),
    })
}

fn jwt(header: Value, claims: &Value) -> String {
    let header = base64url(serde_json::to_string(&header).unwrap().as_bytes());
    let payload = base64url(serde_json::to_string(claims).unwrap().as_bytes());
    let signing = SigningKey::<Sha256>::new(private());
    let signature = signing.sign(format!("{header}.{payload}").as_bytes());
    format!("{header}.{payload}.{}", base64url(&signature.to_vec()))
}

fn claims() -> Value {
    json!({
        "iss":"https://passport.ubq.fi",
        "sub":"user-123",
        "handle":"alice",
        "isAdmin":true,
        "scopes":["ai"],
        "aud":"ai",
        "clientId":"ai",
        "auth":"sso",
        "iat":1_000,
        "exp":2_000,
        "jti":"jti-1"
    })
}

fn token(claims: &Value) -> String {
    jwt(json!({"alg":"RS256","typ":"JWT","kid":"key-a"}), claims)
}

struct Host {
    now: Cell<i64>,
    jwks: RefCell<Vec<u8>>,
    exchange: RefCell<Vec<u8>>,
    jwks_status: Cell<u16>,
    exchange_status: Cell<u16>,
    jwks_fetches: Cell<usize>,
    exchange_requests: RefCell<Vec<AuthUpstreamRequest>>,
}

impl Host {
    fn new(jwks: Vec<Value>, access_token: String) -> Self {
        Self {
            now: Cell::new(1_500_000),
            jwks: RefCell::new(serde_json::to_vec(&json!({"keys":jwks})).unwrap()),
            exchange: RefCell::new(
                serde_json::to_vec(&json!({"accessToken":access_token,"tokenType":"Bearer"}))
                    .unwrap(),
            ),
            jwks_status: Cell::new(200),
            exchange_status: Cell::new(200),
            jwks_fetches: Cell::new(0),
            exchange_requests: RefCell::new(Vec::new()),
        }
    }
}

impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        self.now.get()
    }
    fn random_bytes(&self, len: usize) -> Result<Vec<u8>, GatewayError> {
        Ok((0..len).map(|index| (index + 1) as u8).collect())
    }
    async fn fetch_auth(
        &self,
        request: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        match &request {
            AuthUpstreamRequest::PassportJwks => {
                assert_eq!(request.url(), "https://passport.ubq.fi/api/auth/jwks");
                assert_eq!(request.method(), "GET");
                self.jwks_fetches.set(self.jwks_fetches.get() + 1);
                Ok(AuthUpstreamResponse {
                    status: self.jwks_status.get(),
                    body: self.jwks.borrow().clone(),
                })
            }
            AuthUpstreamRequest::PassportExchange { .. } => {
                assert_eq!(
                    request.url(),
                    "https://passport.ubq.fi/api/auth/sso/exchange"
                );
                assert_eq!(request.method(), "POST");
                self.exchange_requests.borrow_mut().push(request);
                Ok(AuthUpstreamResponse {
                    status: self.exchange_status.get(),
                    body: self.exchange.borrow().clone(),
                })
            }
            _ => Err(GatewayError::unavailable(
                "Synthetic fixture denies unrelated network",
                "fixture_network_denied",
            )),
        }
    }
    async fn kernel_principal(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, GatewayError> {
        Err(GatewayError::unavailable(
            "Synthetic fixture denies policy creation",
            "fixture_policy_denied",
        ))
    }
}

impl WebAuthnCrypto for Host {
    async fn fetch_certificate_revocation_list(&self, _: &str) -> Result<Vec<u8>, GatewayError> {
        Err(GatewayError::unavailable(
            "Synthetic fixture does not fetch CRLs",
            "fixture_denied",
        ))
    }
    async fn validate_key(&self, _: &CosePublicKey) -> Result<(), GatewayError> {
        Err(GatewayError::unavailable(
            "Synthetic fixture does not execute ceremonies",
            "fixture_denied",
        ))
    }
    async fn verify_signature(&self, _: SignatureInput) -> Result<bool, GatewayError> {
        Err(GatewayError::unavailable(
            "Synthetic fixture does not execute ceremonies",
            "fixture_denied",
        ))
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
        for check in &transition.checks {
            if rows.get(&check.key.0).map(|record| &record.revision)
                != check.expected_revision.as_ref()
            {
                return Ok(CommitOutcome::Conflict);
            }
        }
        for mutation in transition.mutations {
            match mutation {
                gateway_core::state::RecordMutation::Put { key, record } => {
                    rows.insert(key.0, record);
                }
                gateway_core::state::RecordMutation::Delete { key } => {
                    rows.remove(&key.0);
                }
            }
        }
        Ok(CommitOutcome::Committed)
    }
}

fn config() -> AuthConfig {
    AuthConfig {
        passport: Some(PassportConfig::production()),
        ..Default::default()
    }
}

fn request(method: &str, url: &str) -> AuthRequest {
    AuthRequest {
        method: method.into(),
        url: url.into(),
        ..Default::default()
    }
}

fn with_cookie(mut request: AuthRequest, name: &str, value: &str) -> AuthRequest {
    request
        .headers
        .insert("cookie".into(), format!("{name}={value}"));
    request
}

#[test]
fn login_redirect_contains_the_exact_fixed_authorize_contract() {
    reset_jwks_cache();
    let host = Host::new(vec![public_jwk("key-a")], token(&claims()));
    let passport = PassportService {
        host: &host,
        config: &PassportConfig::production(),
    };
    let response = run(passport.login(&request("GET", "https://ai.ubq.fi/auth/login"))).unwrap();
    assert_eq!(response.status, 302);
    let location = url::Url::parse(&response.headers["location"]).unwrap();
    assert_eq!(
        location.origin().ascii_serialization(),
        "https://passport.ubq.fi"
    );
    assert_eq!(location.path(), "/authorize");
    let query = location.query_pairs().collect::<BTreeMap<_, _>>();
    assert_eq!(query["client_id"], "ai");
    assert_eq!(query["audience"], "ai");
    assert_eq!(query["origin"], "https://ai.ubq.fi");
    assert_eq!(query["redirect_uri"], "https://ai.ubq.fi/auth/callback");
    assert_eq!(response.set_cookies.len(), 1);
    let state = query["state"].to_string();
    assert!(response.set_cookies[0].starts_with(&format!(
        "{PASSPORT_STATE_COOKIE}={state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax"
    )));
}

#[test]
fn callback_verifies_state_exchange_and_sets_two_cookie_headers() {
    reset_jwks_cache();
    let token = token(&claims());
    let host = Host::new(vec![public_jwk("key-a")], token.clone());
    let passport = PassportService {
        host: &host,
        config: &PassportConfig::production(),
    };
    let request = with_cookie(
        request(
            "GET",
            "https://ai.ubq.fi/auth/callback?state=state-1&code=code-1",
        ),
        PASSPORT_STATE_COOKIE,
        "state-1",
    );
    let response = run(passport.callback(&request)).unwrap();
    assert_eq!(response.status, 302);
    assert_eq!(response.headers["location"], "/chat");
    assert_eq!(response.set_cookies.len(), 2);
    assert!(response.set_cookies[0].starts_with(&format!(
        "{PASSPORT_COOKIE}={token}; Path=/; Max-Age=500; HttpOnly; Secure; SameSite=Lax"
    )));
    assert!(
        response.set_cookies[1]
            .starts_with(&format!("{PASSPORT_STATE_COOKIE}=; Path=/; Max-Age=0"))
    );
    let exchange = host.exchange_requests.borrow();
    assert_eq!(exchange.len(), 1);
    let AuthUpstreamRequest::PassportExchange {
        code,
        client_id,
        audience,
        origin,
        redirect_uri,
    } = &exchange[0]
    else {
        panic!("expected Passport exchange");
    };
    assert_eq!(code.expose(), "code-1");
    assert_eq!(client_id, "ai");
    assert_eq!(audience, "ai");
    assert_eq!(origin, "https://ai.ubq.fi");
    assert_eq!(redirect_uri, "https://ai.ubq.fi/auth/callback");
}

#[test]
fn callback_rejects_missing_mismatched_and_replayed_state_without_exchange() {
    reset_jwks_cache();
    let host = Host::new(vec![public_jwk("key-a")], token(&claims()));
    let passport = PassportService {
        host: &host,
        config: &PassportConfig::production(),
    };
    for request in [
        request("GET", "https://ai.ubq.fi/auth/callback?state=a&code=b"),
        with_cookie(
            request("GET", "https://ai.ubq.fi/auth/callback?state=a&code=b"),
            PASSPORT_STATE_COOKIE,
            "other",
        ),
        with_cookie(
            request(
                "GET",
                "https://ai.ubq.fi/auth/callback?state=a&state=b&code=c",
            ),
            PASSPORT_STATE_COOKIE,
            "a",
        ),
        with_cookie(
            request("GET", "https://ai.ubq.fi/auth/callback?state=a"),
            PASSPORT_STATE_COOKIE,
            "a",
        ),
    ] {
        let response = run(passport.callback(&request)).unwrap();
        assert_eq!(response.status, 401);
        assert!(
            response
                .set_cookies
                .iter()
                .any(|cookie| cookie.starts_with(&format!("{PASSPORT_STATE_COOKIE}=;")))
        );
    }
    assert_eq!(host.exchange_requests.borrow().len(), 0);
    assert_eq!(host.jwks_fetches.get(), 0);
}

#[test]
fn callback_rejects_exchange_status_and_malformed_token() {
    reset_jwks_cache();
    let host = Host::new(vec![public_jwk("key-a")], "not-a-jwt".into());
    let passport = PassportService {
        host: &host,
        config: &PassportConfig::production(),
    };
    let request = with_cookie(
        request("GET", "https://ai.ubq.fi/auth/callback?state=s&code=c"),
        PASSPORT_STATE_COOKIE,
        "s",
    );
    assert_eq!(run(passport.callback(&request)).unwrap().status, 401);
    host.exchange_status.set(400);
    assert_eq!(run(passport.callback(&request)).unwrap().status, 401);
}

#[test]
fn claim_signature_and_algorithm_failures_fail_closed() {
    reset_jwks_cache();
    let config = PassportConfig::production();
    let public = private().to_public_key();
    let keys = BTreeMap::from([("key-a".to_owned(), public)]);
    let valid = token(&claims());
    assert!(verify_jwt(&valid, &config, 1_500, &keys).is_ok());

    let mut cases = Vec::new();
    let mutate = |name: &str, value: Value| {
        let mut claims = claims();
        claims[name] = value;
        claims
    };
    cases.push(("issuer", mutate("iss", json!("https://evil.example"))));
    cases.push(("audience", mutate("aud", json!("other"))));
    cases.push(("client", mutate("clientId", json!("other"))));
    cases.push(("expired", mutate("exp", json!(1_499))));
    cases.push(("future-iat", mutate("iat", json!(1_561))));
    cases.push(("empty-jti", mutate("jti", json!(""))));
    cases.push(("exp-before-iat", mutate("exp", json!(999))));
    let mut missing = claims();
    missing.as_object_mut().unwrap().remove("jti");
    cases.push(("missing-jti", missing));
    for (name, claims) in cases {
        let token = token(&claims);
        assert!(
            verify_jwt(&token, &config, 1_500, &keys).is_err(),
            "{name} must fail"
        );
    }
    for header in [
        json!({"alg":"none","typ":"JWT","kid":"key-a"}),
        json!({"alg":"HS256","typ":"JWT","kid":"key-a"}),
        json!({"alg":"ES256","typ":"JWT","kid":"key-a"}),
        json!({"alg":"RS256","typ":"JWT","kid":"other"}),
        json!({"alg":"RS256","typ":"JWT","kid":"key-a","jku":"https://evil.example"}),
        json!({"alg":"RS256","typ":"JWT","kid":"key-a","x5u":"https://evil.example"}),
        json!({"alg":"RS256","typ":"JWT","kid":"key-a","jwk":{"kty":"RSA"}}),
        json!({"alg":"RS256","typ":"JWT"}),
        json!({"alg":"RS256","kid":"key-a"}),
    ] {
        assert!(verify_jwt(&jwt(header, &claims()), &config, 1_500, &keys).is_err());
    }
    let tampered = valid
        .rsplit_once('.')
        .map(|(prefix, _)| format!("{prefix}.AAAA"))
        .unwrap();
    assert!(verify_jwt(&tampered, &config, 1_500, &keys).is_err());
}

#[test]
fn jwks_cache_refreshes_exactly_once_for_an_unknown_kid() {
    reset_jwks_cache();
    let token_a = token(&claims());
    let mut token_b_claims = claims();
    token_b_claims["jti"] = json!("jti-2");
    token_b_claims["sub"] = json!("user-456");
    let token_b = jwt(
        json!({"alg":"RS256","typ":"JWT","kid":"key-b"}),
        &token_b_claims,
    );
    let host = Host::new(vec![public_jwk("key-a")], token_a.clone());
    let passport = PassportService {
        host: &host,
        config: &PassportConfig::production(),
    };
    assert_eq!(run(passport.bearer(&token_a)).unwrap().sub, "user-123");
    assert_eq!(host.jwks_fetches.get(), 1);
    assert!(run(passport.bearer(&token_a)).is_ok());
    assert_eq!(host.jwks_fetches.get(), 1);
    // Rotation publishes the new key; one refresh serves key-b.
    *host.jwks.borrow_mut() =
        serde_json::to_vec(&json!({"keys":[public_jwk("key-a"),public_jwk("key-b")]})).unwrap();
    assert!(run(passport.bearer(&token_b)).is_ok());
    assert_eq!(host.jwks_fetches.get(), 2);
    let unknown = jwt(json!({"alg":"RS256","typ":"JWT","kid":"key-c"}), &claims());
    assert!(run(passport.bearer(&unknown)).is_err());
    assert_eq!(host.jwks_fetches.get(), 3);
}

#[test]
fn jwks_transport_failure_and_non_success_status_are_unavailable() {
    reset_jwks_cache();
    let host = Host::new(vec![public_jwk("key-a")], token(&claims()));
    *host.jwks.borrow_mut() = b"not json".to_vec();
    assert!(
        run(PassportService {
            host: &host,
            config: &PassportConfig::production()
        }
        .bearer(&token(&claims())))
        .is_err()
    );
    reset_jwks_cache();
    host.jwks_status.set(302);
    *host.jwks.borrow_mut() = serde_json::to_vec(&json!({"keys":[public_jwk("key-a")]})).unwrap();
    assert!(
        run(PassportService {
            host: &host,
            config: &PassportConfig::production()
        }
        .bearer(&token(&claims())))
        .is_err()
    );
}

fn assert_unauthorized(result: Result<gateway_auth::AuthPrincipal, GatewayError>) {
    let error = match result {
        Ok(_) => panic!("expected unauthorized"),
        Err(error) => error,
    };
    assert_eq!(error.status, 401);
}

#[test]
fn cookie_and_bearer_principals_map_to_the_passport_subject() {
    reset_jwks_cache();
    let token = token(&claims());
    let host = Host::new(vec![public_jwk("key-a")], token.clone());
    let store = Store::default();
    let config = config();
    let auth = AuthService::new(&store, &host, &config);
    let cookie = with_cookie(
        request("GET", "https://ai.ubq.fi/uos/auth"),
        PASSPORT_COOKIE,
        &token,
    );
    let principal = run(auth.authenticate_client(&cookie)).unwrap();
    assert!(matches!(
        principal.method,
        AuthMethod::PassportSession { .. }
    ));
    assert_eq!(
        principal.method.principal_id(None),
        "passport-user:user-123"
    );
    let mut bearer = request("GET", "https://ai.ubq.fi/uos/auth");
    bearer
        .headers
        .insert("authorization".into(), format!("Bearer {token}"));
    let principal = run(auth.authenticate_client(&bearer)).unwrap();
    assert!(matches!(
        principal.method,
        AuthMethod::PassportBearer { .. }
    ));
    assert_eq!(
        principal.method.principal_id(None),
        "passport-user:user-123"
    );
    let response = run(auth.handle_auth_route(&cookie)).unwrap().unwrap();
    let body: Value = serde_json::from_slice(&response.body.to_bytes().unwrap()).unwrap();
    assert_eq!(body["auth"]["principal"], "passport-user:user-123");
    assert_eq!(body["auth"]["method"]["kind"], "passport_session");
    assert_eq!(body["auth"]["token"]["present"], false);
}

#[test]
fn invalid_jwt_shaped_bearer_never_falls_through_to_admin() {
    reset_jwks_cache();
    let host = Host::new(vec![public_jwk("key-a")], token(&claims()));
    let store = Store::default();
    let config = AuthConfig {
        admin_tokens: vec![gateway_auth::crypto::Secret::new("fixture-admin".into())],
        passport: Some(PassportConfig::production()),
        ..Default::default()
    };
    let auth = AuthService::new(&store, &host, &config);
    let bad = jwt(json!({"alg":"HS256","typ":"JWT","kid":"key-a"}), &claims());
    let mut request = request("GET", "https://ai.ubq.fi/uos/auth");
    request
        .headers
        .insert("authorization".into(), format!("Bearer {bad}"));
    assert_unauthorized(run(auth.authenticate_client(&request)));
    assert_unauthorized(run(auth.authenticate_admin(&request)));
    let mut valid_bearer = request.clone();
    valid_bearer.headers.insert(
        "authorization".into(),
        format!("Bearer {}", token(&claims())),
    );
    assert!(run(auth.authenticate_client(&valid_bearer)).is_ok());
    assert_unauthorized(run(auth.authenticate_admin(&valid_bearer)));
}

#[test]
fn admin_cookie_requires_isadmin_and_same_origin_mutations() {
    reset_jwks_cache();
    let admin_token = token(&claims());
    let host = Host::new(vec![public_jwk("key-a")], admin_token.clone());
    let store = Store::default();
    let config = config();
    let auth = AuthService::new(&store, &host, &config);
    let get = with_cookie(
        request("GET", "https://ai.ubq.fi/admin"),
        PASSPORT_COOKIE,
        &admin_token,
    );
    assert!(run(auth.authenticate_admin(&get)).is_ok());
    let foreign = with_cookie(
        request("POST", "https://ai.ubq.fi/admin/api"),
        PASSPORT_COOKIE,
        &admin_token,
    );
    let mut foreign = foreign;
    foreign
        .headers
        .insert("origin".into(), "https://evil.example".into());
    assert_eq!(
        run(auth.authenticate_admin(&foreign)).unwrap_err().status,
        403
    );
    let mut same = with_cookie(
        request("POST", "https://ai.ubq.fi/admin/api"),
        PASSPORT_COOKIE,
        &admin_token,
    );
    same.headers
        .insert("origin".into(), "https://ai.ubq.fi".into());
    assert!(run(auth.authenticate_admin(&same)).is_ok());

    let mut non_admin = claims();
    non_admin["isAdmin"] = json!(false);
    let non_admin = token(&non_admin);
    host.exchange.borrow_mut();
    *host.jwks.borrow_mut() = serde_json::to_vec(&json!({"keys":[public_jwk("key-a")]})).unwrap();
    let request = with_cookie(
        request("GET", "https://ai.ubq.fi/admin"),
        PASSPORT_COOKIE,
        &non_admin,
    );
    assert_eq!(
        run(auth.authenticate_admin(&request)).unwrap_err().status,
        403
    );
}

#[test]
fn same_origin_mutation_rejects_foreign_browser_markers() {
    let mut request = request("POST", "https://ai.ubq.fi/admin/api");
    assert!(same_origin_mutation(&request));
    request
        .headers
        .insert("sec-fetch-site".into(), "cross-site".into());
    assert!(!same_origin_mutation(&request));
    request.headers.remove("sec-fetch-site");
    request
        .headers
        .insert("origin".into(), "https://evil.example".into());
    assert!(!same_origin_mutation(&request));
    request.headers.remove("origin");
    request
        .headers
        .insert("referer".into(), "https://evil.example/page".into());
    assert!(same_origin_mutation(&request));
}

#[test]
fn preview_client_config_is_explicit_and_fail_closed() {
    let config = AuthConfig::default();
    let candidate = request("GET", "https://rust-candidate.ai.ubq.fi/auth/login");
    assert!(gateway_auth::passport::config_for_request(&config, &candidate).is_none());
    let mut explicit = AuthConfig {
        passport: Some(PassportConfig {
            client_id: "candidate".into(),
            audience: "ai".into(),
            origin: "https://rust-candidate.ai.ubq.fi".into(),
            redirect_uri: "https://rust-candidate.ai.ubq.fi/auth/callback".into(),
        }),
        ..Default::default()
    };
    assert!(gateway_auth::passport::config_for_request(&explicit, &candidate).is_some());
    explicit.passport = None;
    let production = request("GET", "https://ai.ubq.fi/auth/login");
    assert_eq!(
        gateway_auth::passport::config_for_request(&config, &production),
        Some(PassportConfig::production())
    );
}

#[test]
fn claims_serde_keeps_the_required_wire_metadata() {
    let parsed: PassportClaims = serde_json::from_value(claims()).unwrap();
    assert_eq!(parsed.sub, "user-123");
    assert!(parsed.is_admin);
    assert_eq!(parsed.client_id, "ai");
    assert_eq!(parsed.agent_token_id, None);
    let shaped = gateway_auth::passport::method_json(&parsed, false);
    assert_eq!(shaped["principal"], "passport-user:user-123");
}
