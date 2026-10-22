use rsa::{
    RsaPublicKey,
    pkcs1v15::{Signature, VerifyingKey},
    pkcs8::DecodePublicKey,
    signature::Verifier,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

use crate::{
    AuthConfig, AuthRequest, GatewayError,
    crypto::{Secret, decode_base64url, sha256_base64url},
    invalid, unauthorized,
};

#[derive(Clone, Debug)]
pub enum AuthUpstreamRequest {
    GitHubRepository {
        token: Secret,
        owner: String,
        repo: String,
    },
    DenoApplication {
        token: Secret,
        app: String,
    },
    DenoConsole {
        token: Secret,
        organization: String,
        app: String,
    },
    DenoDeployment {
        token: Secret,
        deployment: String,
    },
    PassportJwks,
    PassportExchange {
        code: Secret,
        client_id: String,
        audience: String,
        origin: String,
        redirect_uri: String,
    },
}

impl AuthUpstreamRequest {
    pub fn url(&self) -> String {
        let component = |value: &str| {
            url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
        };
        match self {
            Self::GitHubRepository { owner, repo, .. } => format!(
                "https://api.github.com/repos/{}/{}",
                component(owner),
                component(repo)
            ),
            Self::DenoApplication { app, .. } => {
                format!("https://api.deno.com/v2/apps/{}", component(app))
            }
            Self::DenoConsole {
                organization, app, ..
            } => format!(
                "https://console.deno.com/{}/{}",
                component(organization),
                component(app)
            ),
            Self::DenoDeployment { deployment, .. } => format!(
                "https://api.deno.com/v1/deployments/{}",
                component(deployment)
            ),
            Self::PassportJwks => crate::passport::PASSPORT_JWKS_URL.into(),
            Self::PassportExchange { .. } => crate::passport::PASSPORT_EXCHANGE_URL.into(),
        }
    }

    pub fn method(&self) -> &'static str {
        match self {
            Self::PassportExchange { .. } => "POST",
            _ => "GET",
        }
    }

    /// Fixed typed bodies only. A request-selected URL or body never exists.
    pub fn body(&self) -> Result<Vec<u8>, GatewayError> {
        match self {
            Self::PassportExchange {
                code,
                client_id,
                audience,
                origin,
                redirect_uri,
            } => serde_json::to_vec(&serde_json::json!({
                "code": code.expose(),
                "clientId": client_id,
                "audience": audience,
                "origin": origin,
                "redirectUri": redirect_uri,
            }))
            .map_err(|_| {
                GatewayError::unavailable(
                    "Passport exchange body could not be encoded.",
                    "passport_unavailable",
                )
            }),
            _ => Ok(Vec::new()),
        }
    }
    pub fn headers(&self) -> Vec<(String, String)> {
        match self {
            Self::GitHubRepository { token, .. } => vec![
                ("authorization".into(), format!("Bearer {}", token.expose())),
                ("accept".into(), "application/vnd.github+json".into()),
                ("x-github-api-version".into(), "2022-11-28".into()),
                ("user-agent".into(), "ai.ubq.fi".into()),
            ],
            Self::DenoConsole { token, .. } => vec![
                (
                    "cookie".into(),
                    format!("token={}; deno_auth_ghid=force", token.expose()),
                ),
                ("accept".into(), "text/html".into()),
            ],
            Self::DenoApplication { token, .. } | Self::DenoDeployment { token, .. } => vec![
                ("authorization".into(), format!("Bearer {}", token.expose())),
                ("accept".into(), "application/json".into()),
            ],
            Self::PassportJwks => vec![("accept".into(), "application/json".into())],
            Self::PassportExchange { .. } => vec![
                ("accept".into(), "application/json".into()),
                ("content-type".into(), "application/json".into()),
            ],
        }
    }
}

#[derive(Clone, Debug)]
pub struct AuthUpstreamResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl AuthUpstreamResponse {
    pub fn success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct KernelClaims {
    pub owner: String,
    pub repo: String,
    pub state_id: String,
    pub auth_token_sha256: String,
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
    #[serde(default)]
    pub installation_id: Option<i64>,
}

pub fn github_token_shape(token: &str) -> bool {
    token.starts_with("gh") || token.starts_with("github_pat_")
}

pub fn kernel_public_keys_key() -> gateway_core::state::RecordKey {
    crate::store::key(serde_json::json!(["uos_ai", "kernel_pubkeys"]))
}

pub fn deno_token_shape(token: &str) -> bool {
    (20..=500).contains(&token.len())
        && !token.chars().any(char::is_whitespace)
        && token.contains('_')
        && !crate::api_keys::api_key_shape(token)
        && !token.starts_with("uos_ai_session_")
}

pub fn verify_kernel(
    request: &AuthRequest,
    token: &str,
    config: &AuthConfig,
    now_ms: i64,
) -> Result<KernelClaims, GatewayError> {
    let jwt = request
        .header("x-ubiquity-kernel-token")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            GatewayError::new(
                401,
                "Unauthorized: missing 'X-Ubiquity-Kernel-Token' header for kernel attestation",
                Some("missing_kernel_token"),
            )
        })?;
    if config.kernel_public_keys_pem.is_empty() {
        return Err(GatewayError::new(
            500,
            "Server misconfigured: No kernel public keys loaded. Set 'UOS_AI_KERNEL_PUBLIC_KEY' or use admin endpoints to add pubkeys.",
            Some("server_error"),
        ));
    }
    let parts: Vec<_> = jwt.split('.').collect();
    if parts.len() != 3 {
        return Err(kernel_error(
            "kernel attestation JWT MUST have 3 parts (header, payload, signature)",
        ));
    }
    let header: Value = serde_json::from_slice(
        &decode_base64url(parts[0]).map_err(|_| kernel_error("invalid kernel token header"))?,
    )
    .map_err(|_| kernel_error("invalid kernel token header"))?;
    if header.get("alg").and_then(Value::as_str) != Some("RS256") {
        return Err(kernel_error("kernel attestation JWT 'alg' MUST be 'RS256'"));
    }
    let claims: KernelClaims = serde_json::from_slice(
        &decode_base64url(parts[1]).map_err(|_| kernel_error("invalid kernel token payload"))?,
    )
    .map_err(|_| {
        kernel_error(
            "kernel attestation JWT payload is invalid or fields are missing/type-mismatched",
        )
    })?;
    let now = now_ms.div_euclid(1000);
    if claims.exp < claims.iat
        || claims.exp.saturating_sub(claims.iat) > 3600
        || claims.iat > now.saturating_add(60)
        || claims.exp < now.saturating_sub(60)
    {
        return Err(kernel_error(
            "kernel attestation JWT has invalid timestamps",
        ));
    }
    if claims.owner.is_empty()
        || claims.repo.is_empty()
        || claims.state_id.is_empty()
        || claims.jti.is_empty()
    {
        return Err(kernel_error(
            "kernel attestation JWT payload is invalid or fields are missing/type-mismatched",
        ));
    }
    if let (Some(owner), Some(repo)) = (
        request.header("x-github-owner"),
        request.header("x-github-repo"),
    ) && !owner.trim().is_empty()
        && !repo.trim().is_empty()
        && (claims.owner != owner.trim() || claims.repo != repo.trim())
    {
        return Err(kernel_error("kernel attestation repo mismatch"));
    }
    if let Some(expected) = claims.installation_id {
        let actual = request.header("x-github-installation-id").and_then(|s| s.trim().parse::<i64>().ok()).ok_or_else(|| GatewayError::new(401,"Unauthorized: missing 'X-GitHub-Installation-Id' header, required for kernel attestation verification",Some("missing_installation_id")))?;
        if actual != expected {
            return Err(kernel_error("kernel attestation installation_id mismatch"));
        }
    }
    if claims.auth_token_sha256 != sha256_base64url(token.as_bytes()) {
        return Err(kernel_error(
            "kernel attestation 'auth_token_sha256' mismatch. Verify kernel is hashing the current 'authToken'.",
        ));
    }
    let signature = Signature::try_from(
        decode_base64url(parts[2])
            .map_err(|_| kernel_error("invalid kernel token signature"))?
            .as_slice(),
    )
    .map_err(|_| kernel_error("invalid kernel token signature"))?;
    let input = format!("{}.{}", parts[0], parts[1]);
    let verified = config
        .kernel_public_keys_pem
        .iter()
        .filter_map(|pem| RsaPublicKey::from_public_key_pem(pem).ok())
        .any(|key| {
            VerifyingKey::<Sha256>::new(key)
                .verify(input.as_bytes(), &signature)
                .is_ok()
        });
    if !verified {
        return Err(kernel_error(
            "kernel attestation signature verification failed",
        ));
    }
    // JTI is intentionally reusable during TTL; repeated Codex tool turns are valid.
    Ok(claims)
}

fn kernel_error(message: &str) -> GatewayError {
    GatewayError::new(
        401,
        format!("Unauthorized: {message}"),
        Some("invalid_kernel_token"),
    )
}

pub fn console_title_matches(body: &[u8], app: &str) -> bool {
    let text = String::from_utf8_lossy(body);
    let lower = text.to_ascii_lowercase();
    let Some(start) = lower
        .find("<title")
        .and_then(|index| lower[index..].find('>').map(|offset| index + offset + 1))
    else {
        return false;
    };
    let Some(end) = lower[start..].find("</title>").map(|index| start + index) else {
        return false;
    };
    text[start..end].contains(&format!("| {app} | Deploy"))
}

pub fn parse_json_body(request: &AuthRequest, allow_empty: bool) -> Result<Value, GatewayError> {
    if request.body.len() > 65_536
        || request
            .header("content-length")
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|n| n > 65_536)
    {
        return Err(GatewayError::new(
            413,
            "Passkey request body is too large",
            Some("invalid_request_error"),
        ));
    }
    if allow_empty && request.body.is_empty() {
        return Ok(serde_json::json!({}));
    }
    let value: Value =
        serde_json::from_slice(&request.body).map_err(|_| invalid("Invalid JSON body"))?;
    if !value.is_object() {
        return Err(invalid("Invalid JSON body"));
    }
    Ok(value)
}

pub fn upstream_unavailable() -> GatewayError {
    GatewayError::new(502, "Failed to verify GitHub token", Some("bad_gateway"))
}
pub fn github_rejected() -> GatewayError {
    GatewayError::new(
        401,
        "Invalid GitHub token for repo",
        Some("invalid_auth_for_repo"),
    )
}
pub fn invalid_admin() -> GatewayError {
    unauthorized()
}
