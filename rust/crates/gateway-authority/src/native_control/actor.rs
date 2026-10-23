//! Original-request identity, rechecked from fixed source rows. Never a native operation grant.
use crate::{Authority, TokenSource, keys, store::Transaction};
use gateway_auth::{
    AuthConfig, AuthHost, AuthMethod, AuthPrincipal, AuthRequest, AuthService, api_keys,
    crypto::{decode_base64url, sha256_hex},
    passkeys::{self, PasskeySession, PasskeyUser},
    session_index, upstream,
};
use gateway_core::{
    GatewayError,
    identity::RequestContext,
    state::{AuthorityStore, RecordKey, RevisionCheck},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeActorScope {
    Client,
    Admin,
}

/// Minted only by real AuthService authentication of the original request.
/// ```compile_fail
/// use gateway_authority::native_control::actor::NativeRenewalActor;
/// let forged: NativeRenewalActor = serde_json::from_str("{}").unwrap();
/// ```
pub struct NativeRenewalActor {
    context: RequestContext,
    stored: StoredNativeActor,
    policy_digest: String,
    transient: Option<RevisionCheck>,
}
impl NativeRenewalActor {
    pub fn principal(&self) -> &str {
        self.stored.principal()
    }
    pub fn context(&self) -> &RequestContext {
        &self.context
    }
    pub fn scope(&self) -> NativeActorScope {
        self.stored.scope()
    }
    pub(crate) fn stored(&self) -> &StoredNativeActor {
        &self.stored
    }
    pub(crate) fn policy_digest(&self) -> &str {
        &self.policy_digest
    }
    /// Add the secret-bearing source session check only after the reproducible
    /// current-facts digest has been formed. Never persist this check/key.
    pub(crate) async fn bind_preparation<S: AuthorityStore, I: TokenSource>(
        &self,
        tx: &mut Transaction<'_, S, I>,
    ) -> Result<(), GatewayError> {
        if let Some(check) = &self.transient {
            let _: PasskeySession = tx.read(&check.key).await?.ok_or_else(fail)?;
            if !tx.expect(&check.key, &check.expected_revision) {
                return Err(fail());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoredNativeActor {
    v: u8,
    principal: String,
    scope: NativeActorScope,
    config_digest: String,
    owner_revision: Option<String>,
    config_revision: Option<String>,
    runtime_revision: Option<String>,
    #[serde(deserialize_with = "required_expiry")]
    source_valid_until_ms: Option<i64>,
    source: SourceActor,
}
impl StoredNativeActor {
    pub(crate) fn principal(&self) -> &str {
        &self.principal
    }
    pub(crate) fn scope(&self) -> NativeActorScope {
        self.scope
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SourceActor {
    ApiKey {
        key_id: String,
        token_hash: String,
        hash_revision: String,
        policy_revision: Option<String>,
        #[serde(deserialize_with = "required_expiry")]
        expires_at_ms: Option<i64>,
    },
    Session {
        digest: String,
        index_revision: String,
        session_revision: String,
        user_id: String,
        user_revision: String,
        expires_at_ms: i64,
    },
    Configuration {
        method: ConfigMethod,
        token_hash: Option<String>,
        valid_until_ms: Option<i64>,
    },
    Passport {
        sub: String,
        jti: String,
        expires_at_ms: i64,
    },
    Kernel {
        owner: String,
        repo: String,
        state_id: String,
        scope: String,
        expires_at_ms: i64,
        repo_revision: Option<String>,
        org_revision: Option<String>,
        defaults_revision: Option<String>,
        cutover_revision: Option<String>,
        keys_revision: Option<String>,
    },
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ConfigMethod {
    AuthAllowlist,
    AdminAllowlist,
    Deno,
    Disabled,
}

pub(crate) struct CurrentNativeActor {
    pub principal: String,
    pub scope: NativeActorScope,
    pub policy_digest: String,
}

pub async fn authenticate_client_actor<S: AuthorityStore, I: TokenSource, H: AuthHost>(
    authority: &Authority<S, I>,
    host: &H,
    config: &AuthConfig,
    original: &AuthRequest,
    context: &RequestContext,
) -> Result<NativeRenewalActor, GatewayError> {
    let before = kernel_before(authority, original).await?;
    let principal = AuthService::new(authority.store(), host, config)
        .authenticate_client(original)
        .await?;
    mint(
        authority,
        config,
        original,
        context,
        principal,
        NativeActorScope::Client,
        before,
    )
    .await
}
pub async fn authenticate_admin_actor<S: AuthorityStore, I: TokenSource, H: AuthHost>(
    authority: &Authority<S, I>,
    host: &H,
    config: &AuthConfig,
    original: &AuthRequest,
    context: &RequestContext,
) -> Result<NativeRenewalActor, GatewayError> {
    let before = kernel_before(authority, original).await?;
    let principal = AuthService::new(authority.store(), host, config)
        .authenticate_admin(original)
        .await?;
    mint(
        authority,
        config,
        original,
        context,
        principal,
        NativeActorScope::Admin,
        before,
    )
    .await
}

async fn mint<S: AuthorityStore, I: TokenSource>(
    authority: &Authority<S, I>,
    config: &AuthConfig,
    original: &AuthRequest,
    context: &RequestContext,
    principal: AuthPrincipal,
    scope: NativeActorScope,
    kernel: Option<KernelBefore>,
) -> Result<NativeRenewalActor, GatewayError> {
    let now = authority.fresh_time(0)?;
    crate::text(&context.request_id.0)?;
    crate::text(&context.route)?;
    if context.principal.0 != principal_id(&principal)
        || context.started_at_ms < 0
        || context.started_at_ms > now
    {
        return Err(fail());
    }
    if matches!(original.method.as_str(), "GET" | "HEAD")
        && original
            .url
            .split(['?', '#'])
            .next()
            .is_some_and(|url| url.ends_with("/health"))
    {
        return Err(fail());
    }
    let expected_key = match &principal.method {
        AuthMethod::KvApiKey { key_id, .. } => Some(key_id.as_str()),
        _ => None,
    };
    if context.key_id.as_ref().map(|key| key.0.as_str()) != expected_key {
        return Err(fail());
    }
    let mut tx = authority.transaction(now)?;
    let mut transient = None;
    let token = principal.token.as_ref().map(|token| token.expose());
    let source = match &principal.method {
        AuthMethod::KvApiKey { key_id, policy } => {
            let key = api_keys::hash_key(&policy.token_hash);
            let record: api_keys::ApiKeyHashRecord = tx.read(&key).await?.ok_or_else(fail)?;
            let current = api_keys::policy_from_record(policy.token_hash.clone(), record, now)?;
            if current != *policy {
                return Err(fail());
            }
            let source_record = authority.store().read(&key).await?.ok_or_else(fail)?;
            if tx.revision(&key).as_deref() != Some(source_record.revision.as_str()) {
                return Err(fail());
            }
            let mut expires_at_ms =
                (policy.expires_at_ms != api_keys::NO_LIMIT).then_some(policy.expires_at_ms);
            if let Some(source_expiry) = source_record.expires_at_ms {
                expires_at_ms =
                    Some(expires_at_ms.map_or(source_expiry, |expiry| expiry.min(source_expiry)));
            }
            let policy_key = keys::api_policy(key_id);
            let _: Option<crate::quota::ApiKeyPolicy> = tx.read(&policy_key).await?;
            SourceActor::ApiKey {
                key_id: key_id.clone(),
                token_hash: policy.token_hash.clone(),
                hash_revision: tx.revision(&key).ok_or_else(fail)?,
                policy_revision: tx.revision(&policy_key),
                expires_at_ms,
            }
        }
        AuthMethod::PasskeySession {
            user_id, is_admin, ..
        } => {
            let token = token.ok_or_else(fail)?;
            let digest = session_index::digest(token);
            let index = session_index::read_current(authority.store(), &digest, now)
                .await?
                .ok_or_else(fail)?;
            let source_key = passkeys::key("sessions", token);
            let session: PasskeySession = tx.read(&source_key).await?.ok_or_else(fail)?;
            let user_key = passkeys::key("users", user_id);
            let user: PasskeyUser = tx.read(&user_key).await?.ok_or_else(fail)?;
            if session.token != token
                || session.user_id != *user_id
                || user.id != *user_id
                || user.is_admin != *is_admin
                || session.expires_at_ms <= now
                || tx.revision(&source_key).as_deref()
                    != Some(index.fence.session_revision.as_str())
                || index.fence.user_id != *user_id
            {
                return Err(fail());
            }
            transient = Some(RevisionCheck {
                key: source_key,
                expected_revision: Some(index.fence.session_revision.clone()),
            });
            SourceActor::Session {
                digest,
                index_revision: index.revision,
                session_revision: index.fence.session_revision,
                user_id: user_id.clone(),
                user_revision: tx.revision(&user_key).ok_or_else(fail)?,
                expires_at_ms: index.fence.expires_at_ms,
            }
        }
        AuthMethod::GithubToken {
            owner,
            repo,
            state_id,
            limit_scope,
        } => {
            let before = kernel.ok_or_else(fail)?;
            if &before.owner != owner || &before.repo != repo {
                return Err(fail());
            }
            let mut configured = config.clone();
            let stored_keys: Option<Vec<Value>> =
                tx.read(&upstream::kernel_public_keys_key()).await?;
            for item in stored_keys.into_iter().flatten() {
                if let Some(pem) = item.get("pem").and_then(Value::as_str)
                    && !configured
                        .kernel_public_keys_pem
                        .iter()
                        .any(|key| key == pem)
                {
                    configured.kernel_public_keys_pem.push(pem.into());
                }
            }
            let claims =
                upstream::verify_kernel(original, token.ok_or_else(fail)?, &configured, now)?;
            if claims.owner != *owner || claims.repo != *repo || claims.state_id != *state_id {
                return Err(fail());
            }
            SourceActor::Kernel {
                owner: owner.clone(),
                repo: repo.clone(),
                state_id: state_id.clone(),
                scope: limit_scope.clone(),
                expires_at_ms: claims
                    .exp
                    .checked_add(61)
                    .and_then(|value| value.checked_mul(1000))
                    .ok_or_else(fail)?,
                repo_revision: before.repo_revision,
                org_revision: before.org_revision,
                defaults_revision: before.defaults_revision,
                cutover_revision: before.cutover_revision,
                keys_revision: before.keys_revision,
            }
        }
        AuthMethod::PassportSession { claims }
            if claims.is_admin && claims.agent_token_id.is_none() =>
        {
            SourceActor::Passport {
                sub: claims.sub.clone(),
                jti: claims.jti.clone(),
                expires_at_ms: claims.exp.checked_mul(1000).ok_or_else(fail)?,
            }
        }
        AuthMethod::PassportSession { .. } | AuthMethod::PassportBearer { .. } => {
            return Err(fail());
        }
        method => {
            let method = match method {
                AuthMethod::AuthTokensAllowlist => ConfigMethod::AuthAllowlist,
                AuthMethod::AdminAllowlist => ConfigMethod::AdminAllowlist,
                AuthMethod::DenoDeployToken => ConfigMethod::Deno,
                AuthMethod::Disabled => ConfigMethod::Disabled,
                _ => return Err(fail()),
            };
            SourceActor::Configuration {
                method,
                token_hash: token.map(|token| sha256_hex(token.as_bytes())),
                valid_until_ms: (method == ConfigMethod::Deno)
                    .then(|| now.checked_add(300_000).ok_or_else(fail))
                    .transpose()?,
            }
        }
    };
    let owner_revision = observed(&mut tx, &keys::paid_control_owner()).await?;
    let config_revision = observed(&mut tx, &keys::paid_control_config()).await?;
    let runtime_revision = observed(&mut tx, &runtime_key()).await?;
    let mut stored = StoredNativeActor {
        v: 1,
        principal: principal_id(&principal),
        scope,
        config_digest: config_digest(config)?,
        owner_revision,
        config_revision,
        runtime_revision,
        source_valid_until_ms: None,
        source,
    };
    tx.now = authority.fresh_time(now)?;
    read_current(&mut tx, &stored, config).await?;
    for key in source_keys(&stored)? {
        let record = authority.store().read(&key).await?;
        if tx.revision(&key).as_deref() != record.as_ref().map(|row| row.revision.as_str()) {
            return Err(fail());
        }
        if let Some(expiry) = record.and_then(|row| row.expires_at_ms) {
            stored.source_valid_until_ms = Some(
                stored
                    .source_valid_until_ms
                    .map_or(expiry, |prior| prior.min(expiry)),
            );
        }
    }
    let current = read_current(&mut tx, &stored, config).await?;
    tx.now = authority.fresh_time(tx.now)?;
    ensure_lifetime(&stored, tx.now)?;
    if !tx.commit().await? {
        return Err(fail());
    }
    validate_current_time(&stored, authority.fresh_time(now)?)?;
    Ok(NativeRenewalActor {
        context: context.clone(),
        stored,
        policy_digest: current.policy_digest,
        transient,
    })
}

/// Import-only own-publication adaptation. The private pair is issued only
/// after exact action/operation/generation/source/config/runtime verification.
/// No public revision override or ordinary/renewal currentness change.
pub(in crate::native_control) async fn read_current_after_import_publication<
    S: AuthorityStore,
    I: TokenSource,
>(
    tx: &mut Transaction<'_, S, I>,
    stored: &StoredNativeActor,
    config: &AuthConfig,
    verified: &super::import::VerifiedImportActorRevisions,
) -> Result<CurrentNativeActor, GatewayError> {
    if stored != verified.original_actor() {
        return Err(fail());
    }
    if !verified.changes_configuration()
        && (&stored.config_revision != verified.config_revision()
            || &stored.runtime_revision != verified.runtime_revision())
    {
        return Err(fail());
    }
    let mut current = stored.clone();
    current.config_revision = verified.config_revision().clone();
    current.runtime_revision = verified.runtime_revision().clone();
    let result = read_current(tx, &current, config).await?;
    let selected = source_keys(stored)?;
    let runtime = runtime_key();
    let config_key = keys::paid_control_config();
    let checks = tx
        .checks()
        .into_iter()
        .filter(|check| check.key != runtime && selected.contains(&check.key))
        .map(|mut check| {
            if check.key == config_key {
                check.expected_revision = stored.config_revision.clone();
            }
            check
        })
        .collect::<Vec<_>>();
    if super::facts::checks_digest(&checks)? != verified.control_digest() {
        return Err(fail());
    }
    Ok(result)
}

pub(crate) async fn read_current<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    stored: &StoredNativeActor,
    config: &AuthConfig,
) -> Result<CurrentNativeActor, GatewayError> {
    if stored.v != 1 || stored.config_digest != config_digest(config)? {
        return Err(fail());
    }
    ensure_lifetime(stored, tx.now)?;
    if observed(tx, &keys::paid_control_owner()).await? != stored.owner_revision
        || observed(tx, &keys::paid_control_config()).await? != stored.config_revision
        || observed(tx, &runtime_key()).await? != stored.runtime_revision
    {
        return Err(fail());
    }
    let principal = match &stored.source {
        SourceActor::Session {
            digest,
            index_revision,
            session_revision,
            user_id,
            user_revision,
            expires_at_ms,
        } => {
            let key = session_index::index_key(digest)?;
            let index: session_index::SessionRevisionFence =
                tx.read(&key).await?.ok_or_else(fail)?;
            let user_key = passkeys::key("users", user_id);
            let user: PasskeyUser = tx.read(&user_key).await?.ok_or_else(fail)?;
            if index.v != 1
                || index.session_digest != *digest
                || index.session_revision != *session_revision
                || index.user_id != *user_id
                || index.expires_at_ms != *expires_at_ms
                || tx.revision(&key).as_ref() != Some(index_revision)
                || tx.revision(&user_key).as_ref() != Some(user_revision)
                || user.id != *user_id
                || (stored.scope == NativeActorScope::Admin && !user.is_admin)
            {
                return Err(fail());
            }
            format!("passkey-user:{user_id}")
        }
        SourceActor::ApiKey {
            key_id,
            token_hash,
            hash_revision,
            policy_revision,
            ..
        } => {
            if stored.scope == NativeActorScope::Admin
                || token_hash.len() != 43
                || !token_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err(fail());
            }
            let key = api_keys::hash_key(token_hash);
            let record: api_keys::ApiKeyHashRecord = tx.read(&key).await?.ok_or_else(fail)?;
            let policy = api_keys::policy_from_record(token_hash.clone(), record, tx.now)?;
            let policy_key = keys::api_policy(key_id);
            let normalized: Option<crate::quota::ApiKeyPolicy> = tx.read(&policy_key).await?;
            if let Some(normalized) = &normalized {
                normalized.validate(&gateway_core::identity::ApiKeyId(key_id.clone()), tx.now)?;
            }
            if policy.key_id != *key_id
                || tx.revision(&key).as_ref() != Some(hash_revision)
                || tx.revision(&policy_key) != *policy_revision
                || normalized.as_ref().is_some_and(|normalized| {
                    policy.expires_at_ms != normalized.expires_at_ms
                        || policy.window_ms != normalized.window_ms
                        || policy.usage_limit_requests != normalized.usage_limit_requests
                })
            {
                return Err(fail());
            }
            format!("api-key:{key_id}")
        }
        SourceActor::Configuration {
            method, token_hash, ..
        } => match method {
            ConfigMethod::AuthAllowlist => {
                if stored.scope == NativeActorScope::Admin
                    || !config.auth_tokens.iter().any(|token| {
                        Some(sha256_hex(token.expose().as_bytes())).as_ref() == token_hash.as_ref()
                    })
                {
                    return Err(fail());
                }
                "auth-method:auth_tokens_allowlist".into()
            }
            ConfigMethod::AdminAllowlist => {
                if !config.admin_tokens.iter().any(|token| {
                    Some(sha256_hex(token.expose().as_bytes())).as_ref() == token_hash.as_ref()
                }) {
                    return Err(fail());
                }
                "auth-method:admin_allowlist".into()
            }
            ConfigMethod::Deno => {
                if token_hash.is_none() {
                    return Err(fail());
                }
                "auth-method:deno_deploy_token".into()
            }
            ConfigMethod::Disabled => token_hash.as_ref().map_or_else(
                || "local-auth-disabled".into(),
                |hash| format!("bearer-sha256:{hash}"),
            ),
        },
        SourceActor::Passport {
            sub,
            jti,
            expires_at_ms,
        } => {
            if stored.scope != NativeActorScope::Admin
                || sub.is_empty()
                || jti.is_empty()
                || *expires_at_ms <= tx.now
            {
                return Err(fail());
            }
            format!("passport-user:{sub}")
        }
        SourceActor::Kernel {
            owner,
            repo,
            scope,
            repo_revision,
            org_revision,
            defaults_revision,
            cutover_revision,
            keys_revision,
            ..
        } => {
            if stored.scope == NativeActorScope::Admin || !matches!(scope.as_str(), "org" | "repo")
            {
                return Err(fail());
            }
            if observed(tx, &keys::kernel_policy(owner, Some(repo))).await? != *repo_revision
                || observed(tx, &keys::kernel_policy(owner, None)).await? != *org_revision
                || observed(tx, &keys::kernel_defaults()).await? != *defaults_revision
                || observed(tx, &keys::kernel_cutover()).await? != *cutover_revision
                || observed(tx, &upstream::kernel_public_keys_key()).await? != *keys_revision
            {
                return Err(fail());
            }
            format!(
                "github-repo:{}/{}",
                owner.to_lowercase(),
                repo.to_lowercase()
            )
        }
    };
    if principal != stored.principal {
        return Err(fail());
    }
    Ok(CurrentNativeActor {
        principal,
        scope: stored.scope,
        policy_digest: digest(stored)?,
    })
}

fn ensure_lifetime(stored: &StoredNativeActor, now: i64) -> Result<(), GatewayError> {
    if stored
        .source_valid_until_ms
        .is_some_and(|expiry| expiry <= now)
    {
        return Err(fail());
    }
    let expiry = match &stored.source {
        SourceActor::Session { expires_at_ms, .. } | SourceActor::Kernel { expires_at_ms, .. } => {
            Some(*expires_at_ms)
        }
        SourceActor::Configuration { valid_until_ms, .. } => *valid_until_ms,
        SourceActor::Passport { expires_at_ms, .. } => Some(*expires_at_ms),
        SourceActor::ApiKey { expires_at_ms, .. } => *expires_at_ms,
    };
    if expiry.is_some_and(|expiry| expiry <= now) {
        return Err(fail());
    }
    Ok(())
}
pub(crate) fn validate_current_time(
    stored: &StoredNativeActor,
    now: i64,
) -> Result<(), GatewayError> {
    crate::validate_time(now)?;
    ensure_lifetime(stored, now)
}
fn required_expiry<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    Option::<i64>::deserialize(deserializer)
}
async fn observed<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    key: &RecordKey,
) -> Result<Option<String>, GatewayError> {
    tx.observe_revision(key).await?;
    Ok(tx.revision(key))
}
fn digest(value: &impl Serialize) -> Result<String, GatewayError> {
    Ok(sha256_hex(&serde_json::to_vec(value).map_err(|_| fail())?))
}
fn config_digest(config: &AuthConfig) -> Result<String, GatewayError> {
    digest(
        &json!({"v":1,"auth":config.auth_tokens.iter().map(|secret|sha256_hex(secret.expose().as_bytes())).collect::<Vec<_>>(),"admin":config.admin_tokens.iter().map(|secret|sha256_hex(secret.expose().as_bytes())).collect::<Vec<_>>(),"production":config.production,"hosted":config.hosted,"git":config.git_sha_known,"candidate":config.candidate_passkeys,"relay":config.extra_relay_origins,"kernel":config.kernel_public_keys_pem.iter().map(|pem|sha256_hex(pem.as_bytes())).collect::<Vec<_>>(),"app":config.deno_app_slug,"org":config.deno_org_slug,"deployment":config.deno_deployment_id}),
    )
}
/// Source-exact projection; only actual AuthService authentication can mint an actor.
pub fn principal_id(principal: &AuthPrincipal) -> String {
    match &principal.method {
        AuthMethod::KvApiKey { key_id, .. } => format!("api-key:{key_id}"),
        AuthMethod::PasskeySession { user_id, .. } => format!("passkey-user:{user_id}"),
        AuthMethod::PassportSession { claims } | AuthMethod::PassportBearer { claims } => {
            format!("passport-user:{}", claims.sub)
        }
        AuthMethod::GithubToken { owner, repo, .. } => format!(
            "github-repo:{}/{}",
            owner.to_lowercase(),
            repo.to_lowercase()
        ),
        AuthMethod::AuthTokensAllowlist => "auth-method:auth_tokens_allowlist".into(),
        AuthMethod::AdminAllowlist => "auth-method:admin_allowlist".into(),
        AuthMethod::DenoDeployToken => "auth-method:deno_deploy_token".into(),
        AuthMethod::Disabled => principal.token.as_ref().map_or_else(
            || "local-auth-disabled".into(),
            |token| format!("bearer-sha256:{}", sha256_hex(token.expose().as_bytes())),
        ),
    }
}
fn runtime_key() -> RecordKey {
    gateway_auth::store::key(json!(["uos_ai", "runtime_config", "v2"]))
}
fn fail() -> GatewayError {
    GatewayError::unavailable(
        "Original-request native actor authority is unavailable or changed.",
        "native_actor_unavailable",
    )
}

struct KernelBefore {
    owner: String,
    repo: String,
    repo_revision: Option<String>,
    org_revision: Option<String>,
    defaults_revision: Option<String>,
    cutover_revision: Option<String>,
    keys_revision: Option<String>,
}
async fn kernel_before<S: AuthorityStore, I: TokenSource>(
    authority: &Authority<S, I>,
    original: &AuthRequest,
) -> Result<Option<KernelBefore>, GatewayError> {
    if original
        .bearer()
        .is_none_or(|token| !upstream::github_token_shape(token))
    {
        return Ok(None);
    }
    let claims = original
        .header("x-ubiquity-kernel-token")
        .and_then(|jwt| jwt.split('.').nth(1))
        .and_then(|value| decode_base64url(value).ok())
        .and_then(|bytes| serde_json::from_slice::<upstream::KernelClaims>(&bytes).ok());
    let Some(claims) = claims else {
        return Ok(None);
    };
    // These selectors are observations only; real signature/repository authorization follows.
    let mut tx = authority.transaction(authority.fresh_time(0)?)?;
    Ok(Some(KernelBefore {
        owner: claims.owner.clone(),
        repo: claims.repo.clone(),
        repo_revision: observed(
            &mut tx,
            &keys::kernel_policy(&claims.owner, Some(&claims.repo)),
        )
        .await?,
        org_revision: observed(&mut tx, &keys::kernel_policy(&claims.owner, None)).await?,
        defaults_revision: observed(&mut tx, &keys::kernel_defaults()).await?,
        cutover_revision: observed(&mut tx, &keys::kernel_cutover()).await?,
        keys_revision: observed(&mut tx, &upstream::kernel_public_keys_key()).await?,
    }))
}

#[cfg(test)]
mod tests;

fn source_keys(stored: &StoredNativeActor) -> Result<Vec<RecordKey>, GatewayError> {
    let mut selected = vec![
        keys::paid_control_owner(),
        keys::paid_control_config(),
        runtime_key(),
    ];
    match &stored.source {
        SourceActor::ApiKey {
            key_id, token_hash, ..
        } => selected.extend([api_keys::hash_key(token_hash), keys::api_policy(key_id)]),
        SourceActor::Session {
            digest, user_id, ..
        } => selected.extend([
            session_index::index_key(digest)?,
            passkeys::key("users", user_id),
        ]),
        SourceActor::Kernel { owner, repo, .. } => selected.extend([
            keys::kernel_policy(owner, Some(repo)),
            keys::kernel_policy(owner, None),
            keys::kernel_defaults(),
            keys::kernel_cutover(),
            upstream::kernel_public_keys_key(),
        ]),
        _ => {}
    }
    Ok(selected)
}
