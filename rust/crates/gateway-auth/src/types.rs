use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{GatewayError, crypto::Secret};

pub const CANONICAL_ORIGIN: &str = "https://ai.ubq.fi";
pub const CANDIDATE_ORIGIN: &str = "https://rust-candidate.ai.ubq.fi";
pub const RELAY_COOKIE: &str = "__Host-uos_ai_relay_session";

#[derive(Clone, Default)]
pub struct AuthRequest {
    pub method: String,
    pub url: String,
    /// Lowercase HTTP header names; the adapter rejects ambiguous duplicate credentials.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub native_peer: Option<NativePeer>,
}

impl std::fmt::Debug for AuthRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthRequest")
            .field("method", &self.method)
            .field(
                "path",
                &url::Url::parse(&self.url)
                    .ok()
                    .map(|url| url.path().to_owned()),
            )
            .field("header_names", &self.headers.keys().collect::<Vec<_>>())
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

impl AuthRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
    pub fn bearer(&self) -> Option<&str> {
        let value = self.header("authorization")?;
        let (scheme, token) = value.split_once(char::is_whitespace)?;
        if !scheme.eq_ignore_ascii_case("bearer") {
            return None;
        }
        let token = token.trim();
        (!token.is_empty() && !token.contains(['\r', '\n', '\u{2028}', '\u{2029}']))
            .then_some(token)
    }
    pub fn without_bearer(&self) -> Self {
        let mut next = self.clone();
        next.headers.remove("authorization");
        next
    }
}

#[derive(Clone, Debug)]
pub struct NativePeer {
    pub listener_bypass_enabled: bool,
    pub tcp: bool,
    pub hostname: String,
}

#[derive(Clone, Debug)]
pub enum AuthResponseBody {
    Json(Value),
    SourceJson(gateway_core::source_json::SourceJson),
}
impl AuthResponseBody {
    pub fn as_json(&self) -> Option<&Value> {
        if let Self::Json(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn to_bytes(&self) -> Result<Vec<u8>, GatewayError> {
        match self {
            Self::Json(value) => serde_json::to_vec(value).map_err(|_| {
                GatewayError::unavailable(
                    "JSON response serialization failed",
                    "response_json_invalid",
                )
            }),
            Self::SourceJson(value) => Ok(value.as_bytes().to_vec()),
        }
    }
}
impl serde::Serialize for AuthResponseBody {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Json(value) => value.serialize(serializer),
            Self::SourceJson(value) => value.serialize(serializer),
        }
    }
}
/// Legacy JSON inspections remain valid; lossless bodies require the explicit byte API.
impl std::ops::Deref for AuthResponseBody {
    type Target = Value;
    fn deref(&self) -> &Value {
        self.as_json().expect(
            "A source JSON body cannot be inspected through serde_json::Value; use to_bytes",
        )
    }
}
impl PartialEq<Value> for AuthResponseBody {
    fn eq(&self, other: &Value) -> bool {
        self.as_json() == Some(other)
    }
}
impl PartialEq<AuthResponseBody> for Value {
    fn eq(&self, other: &AuthResponseBody) -> bool {
        other == self
    }
}

#[derive(Clone, Debug)]
pub struct AuthResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: AuthResponseBody,
    pub stream: Option<crate::native::AuthStream>,
}

impl AuthResponse {
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: BTreeMap::from([
                ("cache-control".into(), "no-store".into()),
                ("content-type".into(), "application/json".into()),
            ]),
            body: AuthResponseBody::Json(body),
            stream: None,
        }
    }
    pub fn source_json(status: u16, body: gateway_core::source_json::SourceJson) -> Self {
        Self {
            status,
            headers: BTreeMap::from([
                ("cache-control".into(), "no-store".into()),
                ("content-type".into(), "application/json".into()),
            ]),
            body: AuthResponseBody::SourceJson(body),
            stream: None,
        }
    }
    pub fn with_stream(mut self, stream: crate::native::AuthStream) -> Self {
        self.stream = Some(stream);
        self
    }
    pub fn error(error: GatewayError) -> Self {
        Self::json(
            error.status,
            serde_json::to_value(error.envelope).expect("error envelope serializes"),
        )
    }
}

#[derive(Clone, Debug, Default)]
pub struct AuthConfig {
    pub auth_tokens: Vec<Secret>,
    pub admin_tokens: Vec<Secret>,
    pub production: bool,
    pub hosted: bool,
    pub git_sha_known: bool,
    /// Prepared candidate mapping must be deliberately activated by runtime configuration.
    pub candidate_passkeys: bool,
    pub extra_relay_origins: BTreeSet<String>,
    pub kernel_public_keys_pem: Vec<String>,
    pub deno_app_slug: Option<String>,
    pub deno_org_slug: Option<String>,
    pub deno_deployment_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthMethod {
    Disabled,
    AuthTokensAllowlist,
    AdminAllowlist,
    DenoDeployToken,
    KvApiKey {
        key_id: String,
        policy: crate::api_keys::ApiKeyPolicy,
    },
    GithubToken {
        owner: String,
        repo: String,
        state_id: String,
        limit_scope: String,
    },
    PasskeySession {
        user_id: String,
        handle: String,
        is_admin: bool,
        credential_count: usize,
    },
}

#[derive(Clone, Debug)]
pub struct AuthPrincipal {
    pub token: Option<Secret>,
    pub method: AuthMethod,
    pub is_admin: bool,
    pub is_super_admin: bool,
}

pub trait AuthHost: crate::webauthn::WebAuthnCrypto {
    fn now_ms(&self) -> i64;
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError>;
    /// Fixed, typed remote reads; implementations must disable automatic redirects.
    fn fetch_auth(
        &self,
        request: crate::upstream::AuthUpstreamRequest,
    ) -> impl Future<Output = Result<crate::upstream::AuthUpstreamResponse, GatewayError>>;
    /// Called only after upstream and attestation verification; preserves the kernel authority.
    fn kernel_principal(
        &self,
        owner: &str,
        repo: &str,
        state_id: &str,
        path: &str,
    ) -> impl Future<Output = Result<String, GatewayError>>;
}

pub fn unauthorized() -> GatewayError {
    GatewayError::new(401, "Unauthorized", Some("invalid_api_key"))
}
pub fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error"))
}
pub fn conflict(message: &str) -> GatewayError {
    GatewayError::new(409, message, Some("invalid_request_error"))
}
