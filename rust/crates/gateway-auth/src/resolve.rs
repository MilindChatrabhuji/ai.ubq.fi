use std::{cell::RefCell, collections::BTreeMap};

use gateway_core::state::AuthorityStore;
use serde_json::{Value, json};
use url::Url;

use crate::{
    AuthConfig, AuthHost, AuthMethod, AuthPrincipal, AuthRequest, AuthResponse, GatewayError,
    PasskeyService,
};
use crate::{
    api_keys,
    crypto::{Secret, sha256_base64url, sha256_hex},
    origin::local_bypass,
    passkeys::SessionView,
    unauthorized,
    upstream::*,
};

pub struct AuthService<'a, S, H> {
    pub store: &'a S,
    pub host: &'a H,
    pub config: &'a AuthConfig,
    github_cache: RefCell<BTreeMap<String, i64>>,
    deno_cache: RefCell<BTreeMap<String, i64>>,
}

impl<'a, S: AuthorityStore, H: AuthHost> AuthService<'a, S, H> {
    pub fn new(store: &'a S, host: &'a H, config: &'a AuthConfig) -> Self {
        Self {
            store,
            host,
            config,
            github_cache: RefCell::new(BTreeMap::new()),
            deno_cache: RefCell::new(BTreeMap::new()),
        }
    }
    pub fn passkeys(&self) -> PasskeyService<'_, S, H> {
        PasskeyService {
            store: self.store,
            host: self.host,
            config: self.config,
        }
    }
    fn allowlisted(tokens: &[Secret], token: &str) -> bool {
        tokens.iter().any(|value| value.expose() == token)
    }
    fn principal(
        token: Option<&str>,
        method: AuthMethod,
        is_admin: bool,
        is_super_admin: bool,
    ) -> AuthPrincipal {
        AuthPrincipal {
            token: token.map(|v| Secret::new(v.to_owned())),
            method,
            is_admin,
            is_super_admin,
        }
    }
    fn passkey_principal(view: SessionView) -> AuthPrincipal {
        let is_admin = view.user.is_admin;
        Self::principal(
            Some(&view.session.token),
            AuthMethod::PasskeySession {
                user_id: view.user.id,
                handle: view.user.handle,
                is_admin,
                credential_count: view.user.credential_ids.len(),
            },
            is_admin,
            false,
        )
    }
    fn legacy_local(&self, request: &AuthRequest) -> bool {
        !self.config.production
            && !self.config.hosted
            && !self.config.git_sha_known
            && Url::parse(&request.url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .is_some_and(|h| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]"))
    }
    async fn github(
        &self,
        request: &AuthRequest,
        token: &str,
    ) -> Result<AuthPrincipal, GatewayError> {
        if Self::allowlisted(&self.config.admin_tokens, token) {
            return Err(unauthorized());
        }
        let has_repo = request
            .header("x-github-owner")
            .is_some_and(|s| !s.trim().is_empty())
            && request
                .header("x-github-repo")
                .is_some_and(|s| !s.trim().is_empty());
        if !has_repo
            && request
                .header("x-ubiquity-kernel-token")
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(unauthorized());
        }
        let mut verification_config = self.config.clone();
        let key_row = self.store.read(&kernel_public_keys_key()).await?;
        let stored_keys: Option<Vec<Value>> = crate::store::decode(key_row.as_ref(), self.host.now_ms())?;
        if let Some(stored_keys) = stored_keys {
            for record in stored_keys {
                if let Some(pem) = record.get("pem").and_then(Value::as_str)
                    && !verification_config.kernel_public_keys_pem.iter().any(|key| key == pem) {
                    verification_config.kernel_public_keys_pem.push(pem.to_owned());
                }
            }
        }
        let claims = verify_kernel(request, token, &verification_config, self.host.now_ms())?;
        let cache_key =
            sha256_base64url(format!("{token}:{}/{}", claims.owner, claims.repo).as_bytes());
        let cached = self
            .github_cache
            .borrow()
            .get(&cache_key)
            .is_some_and(|expiry| *expiry > self.host.now_ms());
        if !cached {
            let reply = self
                .host
                .fetch_auth(AuthUpstreamRequest::GitHubRepository {
                    token: Secret::new(token.to_owned()),
                    owner: claims.owner.clone(),
                    repo: claims.repo.clone(),
                })
                .await
                .map_err(|_| upstream_unavailable())?;
            if !reply.success() {
                return Err(if matches!(reply.status, 401 | 404) {
                    github_rejected()
                } else {
                    upstream_unavailable()
                });
            }
            self.github_cache
                .borrow_mut()
                .insert(cache_key, self.host.now_ms() + 300_000);
        }
        let path = Url::parse(&request.url)
            .ok()
            .map(|u| u.path().to_owned())
            .unwrap_or_else(|| "unknown".into());
        let limit_scope = self
            .host
            .kernel_principal(&claims.owner, &claims.repo, &claims.state_id, &path)
            .await?;
        if !matches!(limit_scope.as_str(), "repo" | "org") {
            return Err(GatewayError::unavailable(
                "Kernel policy scope is invalid",
                "kernel_policy_invalid",
            ));
        }
        Ok(Self::principal(
            Some(token),
            AuthMethod::GithubToken {
                owner: claims.owner,
                repo: claims.repo,
                state_id: claims.state_id,
                limit_scope,
            },
            false,
            false,
        ))
    }
    async fn admin_token(&self, token: &str) -> Result<AuthPrincipal, GatewayError> {
        if Self::allowlisted(&self.config.admin_tokens, token) {
            return Ok(Self::principal(
                Some(token),
                AuthMethod::AdminAllowlist,
                true,
                true,
            ));
        }
        if github_token_shape(token) || !deno_token_shape(token) {
            return Err(unauthorized());
        }
        let cache_key = sha256_base64url(token.as_bytes());
        if self
            .deno_cache
            .borrow()
            .get(&cache_key)
            .is_some_and(|expiry| *expiry > self.host.now_ms())
        {
            return Ok(Self::principal(
                Some(token),
                AuthMethod::DenoDeployToken,
                true,
                true,
            ));
        }
        let secret = Secret::new(token.to_owned());
        let mut verified = false;
        if let Some(app) = self.config.deno_app_slug.as_ref().filter(|s| !s.is_empty()) {
            let reply = self
                .host
                .fetch_auth(AuthUpstreamRequest::DenoApplication {
                    token: secret.clone(),
                    app: app.clone(),
                })
                .await
                .map_err(|_| {
                    GatewayError::new(502, "Failed to verify admin token", Some("bad_gateway"))
                })?;
            verified = reply.success();
            if !verified
                && let Some(org) = self.config.deno_org_slug.as_ref().filter(|s| !s.is_empty()) {
                    let reply = self
                        .host
                        .fetch_auth(AuthUpstreamRequest::DenoConsole {
                            token: secret.clone(),
                            organization: org.clone(),
                            app: app.clone(),
                        })
                        .await
                        .map_err(|_| {
                            GatewayError::new(
                                502,
                                "Failed to verify admin token",
                                Some("bad_gateway"),
                            )
                        })?;
                    verified = reply.success() && console_title_matches(&reply.body, app);
            }
        }
        if !verified
            && let Some(deployment) = self
                .config
                .deno_deployment_id
                .as_ref()
                .filter(|s| !s.is_empty())
            {
                verified = self
                    .host
                    .fetch_auth(AuthUpstreamRequest::DenoDeployment {
                        token: secret,
                        deployment: deployment.clone(),
                    })
                    .await
                    .map_err(|_| {
                        GatewayError::new(502, "Failed to verify admin token", Some("bad_gateway"))
                    })?
                    .success();
        }
        if !verified {
            return Err(unauthorized());
        }
        self.deno_cache
            .borrow_mut()
            .insert(cache_key, self.host.now_ms() + 600_000);
        Ok(Self::principal(
            Some(token),
            AuthMethod::DenoDeployToken,
            true,
            true,
        ))
    }
    pub async fn authenticate_client(
        &self,
        request: &AuthRequest,
    ) -> Result<AuthPrincipal, GatewayError> {
        let token = request.bearer();
        if local_bypass(request, self.config) {
            // Only the checked native listener can resolve the existing local-development principal.
            let row = self
                .store
                .read(&api_keys::id_key("local-development"))
                .await?;
            if let Some(row) = row {
                row.validate_version()?;
                if row.json_value()?.get("revoked_at_ms") == Some(&Value::Null)
                    && let (Some(hash), Some(id)) = (
                        row.json_value()?.get("hash").and_then(Value::as_str),
                        row.json_value()?.get("id").and_then(Value::as_str),
                    ) {
                        let hash_row = self.store.read(&api_keys::hash_key(hash)).await?;
                        if let Some(hash_row) = hash_row {
                            hash_row.validate_version()?;
                            let record = serde_json::from_value(hash_row.json_value()?.clone()).map_err(|_| {
                                GatewayError::unavailable(
                                    "Local API key quota migration is incomplete",
                                    "server_error",
                                )
                            })?;
                            let policy = api_keys::policy_from_record(
                                hash.to_owned(),
                                record,
                                self.host.now_ms(),
                            )?;
                            if id == "local-development" {
                                return Ok(Self::principal(
                                    token,
                                    AuthMethod::KvApiKey {
                                        key_id: id.to_owned(),
                                        policy,
                                    },
                                    false,
                                    false,
                                ));
                            }
                        }
                }
            }
            return Ok(Self::principal(token, AuthMethod::Disabled, false, false));
        }
        if self.legacy_local(request) {
            return Ok(Self::principal(token, AuthMethod::Disabled, false, false));
        }
        let Some(token) = token else {
            return self
                .passkeys()
                .session(request, None)
                .await?
                .map(Self::passkey_principal)
                .ok_or_else(unauthorized);
        };
        if Self::allowlisted(&self.config.auth_tokens, token) {
            return Ok(Self::principal(
                Some(token),
                AuthMethod::AuthTokensAllowlist,
                false,
                false,
            ));
        }
        if token.starts_with("uos_ai_session_") {
            return self
                .passkeys()
                .session(request, None)
                .await?
                .map(Self::passkey_principal)
                .ok_or_else(unauthorized);
        }
        if github_token_shape(token) && !Self::allowlisted(&self.config.admin_tokens, token) {
            match self.github(request, token).await {
                Ok(principal) => return Ok(principal),
                Err(error) if error.status == 401 && request.header("cookie").is_some() => {
                    if let Some(session) = self
                        .passkeys()
                        .session(&request.without_bearer(), None)
                        .await?
                    {
                        return Ok(Self::passkey_principal(session));
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        if api_keys::api_key_shape(token) {
            let policy = api_keys::authenticate(self.store, token, self.host.now_ms()).await?;
            return Ok(Self::principal(
                Some(token),
                AuthMethod::KvApiKey {
                    key_id: policy.key_id.clone(),
                    policy,
                },
                false,
                false,
            ));
        }
        self.admin_token(token).await
    }
    pub async fn authenticate_admin(
        &self,
        request: &AuthRequest,
    ) -> Result<AuthPrincipal, GatewayError> {
        if local_bypass(request, self.config) {
            return Ok(Self::principal(
                request.bearer().or(Some("local-dev-admin")),
                AuthMethod::Disabled,
                true,
                true,
            ));
        }
        let mut session = self.passkeys().session(request, None).await?;
        if session.is_none()
            && let Some(token) = request.bearer().filter(|token| {
                github_token_shape(token)
                    && !Self::allowlisted(&self.config.admin_tokens, token)
                    && !Self::allowlisted(&self.config.auth_tokens, token)
                    && request.header("cookie").is_some()
            }) {
                match self.github(request, token).await {
                    Ok(_) => return Err(unauthorized()),
                    Err(error) if error.status == 401 => {
                        session = self
                            .passkeys()
                            .session(&request.without_bearer(), None)
                            .await?;
                    }
                    Err(error) => return Err(error),
                }
        }
        if let Some(view) = session {
            if !view.user.is_admin {
                return Err(GatewayError::new(403, "Forbidden", Some("forbidden")));
            }
            return Ok(Self::passkey_principal(view));
        }
        self.admin_token(request.bearer().ok_or_else(unauthorized)?)
            .await
    }
    pub async fn handle_auth_route(
        &self,
        request: &AuthRequest,
    ) -> Result<Option<AuthResponse>, GatewayError> {
        let url = Url::parse(&request.url).map_err(|_| crate::invalid("Invalid request URL"))?;
        let result = match (request.method.as_str(), url.path()) {
            ("POST", "/api/auth/register/start") => {
                let admin = self.authenticate_admin(request).await?;
                let token = if matches!(admin.method, AuthMethod::PasskeySession { .. }) {
                    admin.token.as_ref().map(Secret::expose)
                } else {
                    None
                };
                self.passkeys().register_start(request, token).await?
            }
            ("POST", "/api/auth/register/finish") => {
                self.passkeys().register_finish(request).await?
            }
            ("POST", "/api/auth/login/start") => self.passkeys().login_start(request).await?,
            ("POST", "/api/auth/login/finish") => self.passkeys().login_finish(request).await?,
            ("GET", "/api/auth/session") | ("POST", "/api/auth/logout") => {
                let auth = if request.header("authorization").is_some()
                    && request.header("cookie").is_some()
                {
                    self.authenticate_client(request).await.ok()
                } else {
                    None
                };
                let token = auth
                    .as_ref()
                    .filter(|auth| matches!(auth.method, AuthMethod::PasskeySession { .. }))
                    .and_then(|auth| auth.token.as_ref())
                    .map(Secret::expose);
                if request.method == "GET" {
                    self.passkeys().session_response(request, token).await?
                } else {
                    self.passkeys().logout(request, token).await?
                }
            }
            ("GET", "/uos/auth") => {
                let mut auth = self.authenticate_client(request).await?;
                if (local_bypass(request, self.config) || self.legacy_local(request))
                    && let Ok(admin) = self.authenticate_admin(request).await {
                        auth = admin;
                }
                let method = self.method_wire(&auth.method).await?;
                let token = auth.token.as_ref().map(Secret::expose);
                let shape = token.map(token_shape);
                AuthResponse::json(
                    200,
                    json!({"ok":true,"service":"ai.ubq.fi","auth":{"mode":if local_bypass(request,self.config)||self.legacy_local(request){"disabled"}else{"required"},"is_admin":auth.is_admin,"is_super_admin":auth.is_super_admin,"method":method,"token":{"present":token.is_some(),"length":token.map(str::len),"shape":shape,"sha256_12":token.map(|token|sha256_hex(token.as_bytes())[..12].to_owned())}}}),
                )
            }
            _ => return Ok(None),
        };
        Ok(Some(result))
    }
    async fn method_wire(&self, method: &AuthMethod) -> Result<Value, GatewayError> {
        Ok(match method {
            AuthMethod::PasskeySession {
                user_id,
                handle,
                is_admin,
                credential_count,
            } => {
                json!({"kind":"passkey_session","user":{"id":user_id,"handle":handle,"is_admin":is_admin,"credential_count":credential_count}})
            }
            AuthMethod::GithubToken {
                owner,
                repo,
                state_id,
                limit_scope,
            } => {
                json!({"kind":"github_token","repo":{"owner":owner,"repo":repo},"state_id":state_id,"limit_scope":limit_scope})
            }
            AuthMethod::KvApiKey { key_id, policy } => {
                let mut key = json!({"id":key_id});
                if let Some(row) = self.store.read(&api_keys::id_key(key_id)).await? {
                    row.validate_version()?;
                    let record = row.json_value()?.clone();
                    let wk = crate::store::key(json!([
                        "uos_ai",
                        "api_key_usage",
                        "v3",
                        "window",
                        key_id,
                        policy.policy_version,
                        policy.window_start_ms
                    ]));
                    let usage = match self.store.read(&wk).await? {
                        None => 0,
                        Some(row) => {
                            row.validate_version()?;
                            row.json_value()?
                                .get("committed_requests")
                                .and_then(Value::as_i64)
                                .filter(|n| *n >= 0)
                                .ok_or_else(|| {
                                    GatewayError::unavailable(
                                        "API key quota ledger is unavailable",
                                        "server_error",
                                    )
                                })?
                        }
                    };
                    key = json!({"id":key_id,"name":record.get("name"),"prefix":record.get("prefix"),"created_at_ms":record.get("created_at_ms"),"expires_at_ms":policy.expires_at_ms,"revoked_at_ms":record.get("revoked_at_ms"),"usage_limit_requests":policy.usage_limit_requests,"usage_requests":usage,"usage_reset_at_ms":policy.usage_reset_at_ms,"window_ms":policy.window_ms});
                }
                json!({"kind":"kv_api_key","key":key})
            }
            _ => serde_json::to_value(method).map_err(|_| {
                GatewayError::unavailable(
                    "Authentication method cannot be encoded",
                    "auth_state_corrupt",
                )
            })?,
        })
    }
}

pub fn token_shape(token: &str) -> &'static str {
    if token.is_empty() {
        "unset"
    } else if token.starts_with("ddw_") {
        "deno_deploy_like(ddw_)"
    } else if github_token_shape(token) {
        "github_prefix"
    } else if token.starts_with("uos_ai_session_") {
        "uos_ai_session_prefix"
    } else if api_keys::api_key_shape(token) {
        "uos_api_key"
    } else if token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) {
        "hex64"
    } else if token.contains('_') {
        "has_underscore"
    } else {
        "other"
    }
}
