//! Only actual platform clock, RNG, WebCrypto and fixed authentication reads.
use std::{collections::BTreeMap, rc::Rc};

use futures_util::StreamExt;
use gateway_auth::upstream::{AuthUpstreamRequest, AuthUpstreamResponse};
use gateway_auth::webauthn::{CosePublicKey, SignatureInput, WebAuthnCrypto};
use gateway_auth::{AuthConfig, AuthHost, GatewayError};
use gateway_authority::{AuthorityClock, TokenSource};
use worker::{Env, Fetch, Method, Request, RequestInit, RequestRedirect, Response, Url};

use crate::transport::{
    crypto,
    outbound::{Cancellation, PinnedDestination, send_http},
    random,
};

pub const AUTH_SETTINGS: &[&str] = &[
    "UOS_AI_TOKEN",
    "DENO_DEPLOY_TOKEN",
    "DENO_TIMELINE",
    "DENO_DEPLOY",
    "DENO_DEPLOYMENT_ID",
    "DENO_REGION",
    "UOS_AI_KERNEL_PUBLIC_KEY",
    "DENO_DEPLOY_APP_SLUG",
    "DENO_DEPLOY_ORG_SLUG",
    "UOS_AI_PASSPORT_CLIENT_ID",
    "UOS_AI_PASSPORT_AUDIENCE",
    "UOS_AI_PASSPORT_ORIGIN",
    "UOS_AI_PASSPORT_REDIRECT_URI",
];

pub fn setting(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .or_else(|_| env.var(name).map(|value| value.to_string()))
        .ok()
}

/// Source provider keys use nonEmptyString before choosing a fallback key.
pub fn provider_secret(env: &Env, name: &str) -> Option<String> {
    setting(env, name)
        .map(|value| gateway_schema::util::js_trim(&value).to_owned())
        .filter(|value| !value.is_empty())
}

pub fn auth_config(env: &Env) -> AuthConfig {
    let values = AUTH_SETTINGS
        .iter()
        .filter_map(|name| setting(env, name).map(|value| ((*name).to_owned(), value)))
        .collect();
    // The entrypoint independently validates the compile-time full Git identity.
    let mut config = AuthConfig::from_source_values(&values, true);
    // This Rust Worker deployment targets the isolated candidate. Trust comes
    // from its fixed composition, never a request header or discovered origin.
    config.candidate_passkeys = true;
    config
        .extra_relay_origins
        .insert("https://rust-candidate.ai.ubq.fi".into());
    config
}

#[derive(Clone)]
pub struct PlatformHost {
    pub cancellation: Rc<Cancellation>,
    pub store: crate::authority::RemoteAuthorityStore,
    pub env: Env,
    pub native: crate::native_host::NativeBindings,
    pub original: gateway_auth::AuthRequest,
    pub request_id: gateway_core::identity::RequestId,
}

#[derive(Clone, Copy)]
pub struct PlatformTokens;

impl gateway_authority::native_control::NativeRenewalCancellation for PlatformHost {
    fn cancelled(&self) -> bool {
        self.cancellation.signal().aborted()
    }
}
impl TokenSource for PlatformTokens {
    fn next_token(&self) -> Result<String, GatewayError> {
        random::opaque_token()
    }
}
#[derive(Clone, Copy)]
pub struct PlatformClock;
impl AuthorityClock for PlatformClock {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        crate::storage::now_ms()
    }
}

impl WebAuthnCrypto for PlatformHost {
    async fn fetch_certificate_revocation_list(&self, url: &str) -> Result<Vec<u8>, GatewayError> {
        let unavailable = || {
            GatewayError::unavailable(
                "Certificate revocation transport is unavailable",
                "passkey_crl_unavailable",
            )
        };
        let target = Url::parse(url).map_err(|_| unavailable())?;
        if !matches!(target.scheme(), "http" | "https") || target.host_str().is_none() {
            return Err(unavailable());
        }
        // The source fetch supplies no credentials or privileged headers and
        // follows ordinary redirects. Rust alone interprets untrusted CRL DER.
        let mut init = RequestInit::new();
        init.with_redirect(RequestRedirect::Follow);
        let request = Request::new_with_init(target.as_str(), &init).map_err(|_| unavailable())?;
        Fetch::Request(request)
            .send_with_signal(&self.cancellation.signal())
            .await
            .map_err(|_| unavailable())?
            .bytes()
            .await
            .map_err(|_| unavailable())
    }
    async fn validate_key(&self, key: &CosePublicKey) -> Result<(), GatewayError> {
        crypto::validate_verification_key(&key.jwk, &key.import_algorithm()).await
    }
    async fn verify_signature(&self, input: SignatureInput) -> Result<bool, GatewayError> {
        crypto::verify_signature(
            &input.key.jwk,
            &input.key.import_algorithm(),
            &input.key.verify_algorithm(),
            &input.signature,
            &input.data,
        )
        .await
    }
}

impl AuthHost for PlatformHost {
    fn now_ms(&self) -> i64 {
        // The request checks this fallible clock first. If the platform clock
        // subsequently fails, the sentinel expires credentials rather than reusing old time.
        crate::storage::now_ms().unwrap_or(i64::MAX)
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        random::random_bytes(length)
    }
    async fn fetch_auth(
        &self,
        request: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        let headers = request.headers().into_iter().collect::<BTreeMap<_, _>>();
        let destination = PinnedDestination::new(&request.url())?;
        let method = match request.method() {
            "POST" => Method::Post,
            _ => Method::Get,
        };
        let body = request.body()?;
        let mut response = send_http(
            &destination,
            method,
            &headers,
            &body,
            &self.cancellation,
            || async { Ok(()) },
        )
        .await
        .map_err(|failure| failure.error)?;
        let status = response.status_code();
        let body = response_bytes(&mut response, 4 * 1024 * 1024).await?;
        Ok(AuthUpstreamResponse { status, body })
    }
    async fn kernel_principal(
        &self,
        owner: &str,
        repo: &str,
        _state_id: &str,
        path: &str,
    ) -> Result<String, GatewayError> {
        Ok(gateway_admin::kernel_auth::KernelAuthService {
            store: &self.store,
            host: self,
        }
        .resolve(owner, repo, path)
        .await?
        .limit_scope)
    }
}

pub async fn response_bytes(
    response: &mut Response,
    limit: usize,
) -> Result<Vec<u8>, GatewayError> {
    let mut stream = response.stream().map_err(|_| upstream_read_error())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| upstream_read_error())?;
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|size| size > limit)
        {
            return Err(GatewayError::new(
                502,
                "The upstream response exceeds the accepted byte limit.",
                Some("upstream_response_too_large"),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn upstream_read_error() -> GatewayError {
    GatewayError::new(
        502,
        "The upstream response could not be read.",
        Some("upstream_read_error"),
    )
}
