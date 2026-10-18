use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformHost, provider_secret},
    observability_host,
};
use gateway_admin_runtime::claude::{self, AccountBinding, Bootstrap, CredentialKind};
use gateway_auth::{
    AuthHost,
    upstream::{AuthUpstreamRequest, AuthUpstreamResponse},
    webauthn::{CosePublicKey, SignatureInput, WebAuthnCrypto},
};
use gateway_catalog_runtime::ProviderBinding;
use gateway_claude_runtime::{
    AcceptedObservation, ClaudePoolHost, HealthObservation, WorkspaceResponse,
};
use gateway_core::{GatewayError, state::RevisionCheck};
use gateway_observability::{HealthEvent, HealthProvider, HealthTarget, ObservabilityRuntime};
use gateway_schema::catalog::ProviderCatalog;
use serde_json::json;
use std::{cmp::Ordering, rc::Rc};

#[derive(Clone)]
pub(super) struct Host {
    pub platform: PlatformHost,
    pub store: RemoteAuthorityStore,
}
impl Host {
    pub fn new(
        store: RemoteAuthorityStore,
        platform: PlatformHost,
        _context: Rc<worker::Context>,
    ) -> Self {
        Self { store, platform }
    }
}
pub(super) fn bootstrap(platform: &PlatformHost) -> Result<Bootstrap, GatewayError> {
    let now = platform.now_ms();
    if now <= 0 || now > gateway_core::identity::MAX_SAFE_INTEGER {
        return Err(super::invalid("Claude source clock is invalid."));
    }
    let credential = if let Some(secret) = provider_secret(&platform.env, "CLAUDE_API_KEY") {
        let mut credential = claude::parse_credential(
            &json!({"secret":secret,"updated_at_ms":now}),
            "CLAUDE_API_KEY",
        )
        .ok_or_else(|| super::invalid("Configured Claude credential is invalid."))?;
        credential.updated_at_ms = None;
        Some(credential)
    } else if let Some(secret) = provider_secret(&platform.env, "CLAUDE_CODE_OAUTH_TOKEN") {
        let mut credential = claude::parse_credential(
            &json!({"secret":secret,"kind":"oauth","updated_at_ms":now}),
            "CLAUDE_CODE_OAUTH_TOKEN",
        )
        .ok_or_else(|| super::invalid("Configured Claude credential is invalid."))?;
        credential.updated_at_ms = None;
        Some(credential)
    } else {
        None
    };
    let workspace = provider_secret(&platform.env, "CLAUDE_CODE_WORKSPACE_ID")
        .filter(|id| id.starts_with("wrkspc_"))
        .and_then(|id| claude::parse_workspace(&json!({"id":id,"source":"env"})));
    Ok(Bootstrap {
        credential,
        workspace,
    })
}
pub(super) async fn bootstrap_for_source(store: &RemoteAuthorityStore, platform: &PlatformHost) -> Result<Bootstrap, GatewayError> {
    // Existing roster/tombstone and source legacy credential win over environment values.
    if claude::read_roster(store, platform.now_ms()).await?.is_some() {
        return Ok(Bootstrap::default());
    }
    if claude::load_roster(store, platform, &Bootstrap::default()).await?.revision.is_some() {
        return Ok(Bootstrap::default());
    }
    bootstrap(platform)
}
impl WebAuthnCrypto for Host {
    async fn fetch_certificate_revocation_list(&self, url: &str) -> Result<Vec<u8>, GatewayError> {
        self.platform.fetch_certificate_revocation_list(url).await
    }
    async fn validate_key(&self, key: &CosePublicKey) -> Result<(), GatewayError> {
        self.platform.validate_key(key).await
    }
    async fn verify_signature(&self, input: SignatureInput) -> Result<bool, GatewayError> {
        self.platform.verify_signature(input).await
    }
}
impl AuthHost for Host {
    fn now_ms(&self) -> i64 {
        self.platform.now_ms()
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        self.platform.random_bytes(length)
    }
    async fn fetch_auth(
        &self,
        request: AuthUpstreamRequest,
    ) -> Result<AuthUpstreamResponse, GatewayError> {
        self.platform.fetch_auth(request).await
    }
    async fn kernel_principal(
        &self,
        owner: &str,
        repo: &str,
        state_id: &str,
        path: &str,
    ) -> Result<String, GatewayError> {
        self.platform
            .kernel_principal(owner, repo, state_id, path)
            .await
    }
}
impl ClaudePoolHost for Host {
    fn compare_principals(&self, left: &str, right: &str) -> Result<Ordering, GatewayError> {
        crate::admin_host::compare_labels(left, right)
    }
    fn parse_retry_after_date(&self, raw: &str) -> Option<i64> {
        let value = worker::js_sys::Date::parse(raw);
        value.is_finite().then_some(value as i64)
    }
    async fn credential_checks(
        &self,
        binding: &AccountBinding,
    ) -> Result<Vec<RevisionCheck>, GatewayError> {
        // These are all source roster parser variants. There is no native-Claude producer.
        if !["kv", "CLAUDE_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
            .contains(&binding.credential.source.as_str())
        {
            return Err(super::invalid(
                "Claude credential has no supported source owner.",
            ));
        }
        claude::current_binding(&self.store, binding, self.now_ms())
            .await?
            .map(|check| vec![check])
            .ok_or_else(|| super::invalid("Claude source credential changed."))
    }
    async fn catalog(
        &self,
        binding: &AccountBinding,
        identity: &ProviderBinding,
    ) -> Result<ProviderCatalog, GatewayError> {
        super::catalog::for_account(self, binding, identity).await
    }
    async fn workspace_list(
        &self,
        binding: &AccountBinding,
    ) -> Result<WorkspaceResponse, GatewayError> {
        let response = super::catalog::workspace_list(self, binding).await?;
        Ok(WorkspaceResponse {
            status: response.status,
            body: response.body,
        })
    }
    async fn accepted_observation(&self, event: &AcceptedObservation) -> Result<(), GatewayError> {
        let event = serde_json::from_value::<
            gateway_observability::host_types::ClaudeAcceptedObservation,
        >(event.source_value())
        .map_err(|_| super::invalid("Accepted Claude history DTO is invalid."))?;
        let runtime = ObservabilityRuntime::with_state(
            self.store.clone(),
            observability_host::Host,
            observability_host::shared_state(),
        );
        let _accepted = runtime.record_claude_capacity_observation(&event).await?;
        Ok(())
    }
    async fn health_observation(&self, event: &HealthObservation) -> Result<(), GatewayError> {
        let kind = match event.event.as_str() {
            "success" => HealthEvent::Success,
            "reachable" => HealthEvent::Reachable,
            "auth_invalid" => HealthEvent::AuthInvalid,
            "quota_exhausted" => HealthEvent::QuotaExhausted,
            "upstream_error" => HealthEvent::UpstreamError,
            _ => return Err(super::invalid("Unknown Claude health event.")),
        };
        let runtime = ObservabilityRuntime::with_state(
            self.store.clone(),
            observability_host::Host,
            observability_host::shared_state(),
        );
        let _written = runtime
            .observe_provider(
                HealthTarget {
                    provider: HealthProvider::ClaudeCode,
                    identity: event.identity.clone(),
                    source_checks: event.checks.clone(),
                },
                kind,
                event.status,
                event.provider_request_id.as_deref(),
            )
            .await;
        Ok(())
    }
}

pub(super) fn headers(binding: &AccountBinding, workspace: bool) -> gateway_providers::Headers {
    let mut headers = gateway_providers::Headers::from([
        ("Content-Type".into(), "application/json".into()),
        ("Accept".into(), "application/json".into()),
        ("anthropic-version".into(), "2023-06-01".into()),
    ]);
    match binding.credential.kind {
        CredentialKind::Oauth => {
            headers.insert(
                "Authorization".into(),
                format!("Bearer {}", binding.credential.secret.expose()),
            );
            headers.insert("anthropic-beta".into(), "oauth-2025-04-20".into());
        }
        CredentialKind::ApiKey => {
            headers.insert(
                "x-api-key".into(),
                binding.credential.secret.expose().into(),
            );
        }
    }
    if workspace && let Some(workspace) = &binding.workspace {
        headers.insert("anthropic-workspace-id".into(), workspace.id.clone());
    }
    headers
}
