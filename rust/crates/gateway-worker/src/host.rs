//! Only actual platform clock, RNG, WebCrypto and fixed authentication reads.
use std::{collections::BTreeMap, rc::Rc};

use futures_util::StreamExt;
use gateway_auth::upstream::{AuthUpstreamRequest, AuthUpstreamResponse};
use gateway_auth::webauthn::{CosePublicKey, SignatureInput, WebAuthnCrypto};
use gateway_auth::{AuthConfig, AuthHost, GatewayError};
use gateway_authority::{AuthorityClock, TokenSource};
use worker::{Env, Method, Response};

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
];

pub fn setting(env: &Env, name: &str) -> Option<String> {
    env.secret(name)
        .map(|value| value.to_string())
        .or_else(|_| env.var(name).map(|value| value.to_string()))
        .ok()
}

pub fn auth_config(env: &Env) -> AuthConfig {
    let values = AUTH_SETTINGS
        .iter()
        .filter_map(|name| setting(env, name).map(|value| ((*name).to_owned(), value)))
        .collect();
    // The entrypoint independently validates the compile-time full Git identity.
    AuthConfig::from_source_values(&values, true)
}

pub struct PlatformHost {
    pub cancellation: Rc<Cancellation>,
}

#[derive(Clone, Copy)]
pub struct PlatformTokens;
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
    async fn validate_key(&self, key: &CosePublicKey) -> Result<(), GatewayError> {
        crypto::validate_verification_key(&key.jwk, &key.algorithm.import_algorithm()).await
    }
    async fn verify_signature(&self, input: SignatureInput) -> Result<bool, GatewayError> {
        crypto::verify_signature(
            &input.key.jwk,
            &input.key.algorithm.import_algorithm(),
            &input.key.algorithm.verify_algorithm(),
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
        let mut response = send_http(
            &destination,
            Method::Get,
            &headers,
            &[],
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
        _owner: &str,
        _repo: &str,
        _state_id: &str,
        _path: &str,
    ) -> Result<String, GatewayError> {
        Err(GatewayError::unavailable(
            "The source kernel principal operation is not integrated.",
            "kernel_principal_unavailable",
        ))
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
