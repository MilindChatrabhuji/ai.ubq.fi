//! Exact source-derived authenticated principal identity shared by admission/routing.
use gateway_auth::{AuthMethod, AuthPrincipal};

pub fn principal_id(principal: &AuthPrincipal) -> String {
    match &principal.method {
        AuthMethod::KvApiKey { key_id, .. } => format!("api-key:{key_id}"),
        AuthMethod::GithubToken { owner, repo, .. } => format!(
            "github-repo:{}/{}",
            owner.to_lowercase(),
            repo.to_lowercase()
        ),
        AuthMethod::PasskeySession { user_id, .. } => format!("passkey-user:{user_id}"),
        AuthMethod::AuthTokensAllowlist => "auth-method:auth_tokens_allowlist".into(),
        AuthMethod::AdminAllowlist => "auth-method:admin_allowlist".into(),
        AuthMethod::DenoDeployToken => "auth-method:deno_deploy_token".into(),
        AuthMethod::Disabled => principal
            .token
            .as_ref()
            .map(|token| {
                format!(
                    "bearer-sha256:{}",
                    gateway_auth::crypto::sha256_hex(token.expose().as_bytes())
                )
            })
            .unwrap_or_else(|| "local-auth-disabled".into()),
    }
}
