//! The owner publishes references, never bearer tokens, into this catalog boundary.
use gateway_core::{GatewayError, js_string::JsString16, state::RevisionCheck};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, future::Future};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogProvider {
    Openlux,
    Surplus,
    Lithos,
    Openrouter,
    ClaudeCode,
    Deepseek,
    Cerebras,
}
impl CatalogProvider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Openlux => "openlux",
            Self::Surplus => "surplus",
            Self::Lithos => "lithos",
            Self::Openrouter => "openrouter",
            Self::ClaudeCode => "claude_code",
            Self::Deepseek => "deepseek",
            Self::Cerebras => "cerebras",
        }
    }
    pub fn discovery(self) -> bool {
        !matches!(self, Self::Deepseek | Self::Cerebras)
    }
    /// Fixed targets only; the adapter cannot receive an arbitrary caller URL.
    pub fn models_url(self) -> Option<&'static str> {
        match self {
            Self::Openlux => Some("https://api.openlux.ai/v1/models"),
            Self::Surplus => Some("https://api.surplusintelligence.ai/v1/models"),
            Self::Lithos => Some("https://api.lithosai.cloud/v1/models"),
            Self::Openrouter => Some("https://openrouter.ai/api/v1/models"),
            Self::ClaudeCode => Some("https://api.anthropic.com/v1/models"),
            Self::Deepseek | Self::Cerebras => None,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAccount {
    pub account_id: String,
    /// The source routing credential fingerprint, not a file timestamp or account hash.
    pub credential_fingerprint: String,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderBinding {
    /// Credential/workspace/generation identity from its existing credential owner.
    pub identity: String,
}
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CredentialPublication {
    /// Source pool order is significant, including when one account fails.
    pub codex_accounts: Vec<CodexAccount>,
    /// Exact revisions of the existing source pool/account/credential rows.
    pub source_checks: Vec<RevisionCheck>,
    /// Presence means configured; public OpenRouter discovery needs no entry.
    pub providers: BTreeMap<CatalogProvider, ProviderBinding>,
}
impl CredentialPublication {
    pub fn validate(&self) -> Result<(), GatewayError> {
        let mut seen = std::collections::BTreeSet::new();
        if self.codex_accounts.iter().any(|a| {
            a.account_id.trim().is_empty()
                || a.credential_fingerprint.trim().is_empty()
                || !seen.insert(&a.account_id)
        }) || self
            .providers
            .values()
            .any(|b| b.identity.trim().is_empty())
        {
            return Err(unavailable(
                "The credential owner published an invalid catalog identity",
            ));
        }
        Ok(())
    }
    pub fn binding(&self, provider: CatalogProvider) -> Option<ProviderBinding> {
        if provider == CatalogProvider::Openrouter {
            Some(
                self.providers
                    .get(&provider)
                    .cloned()
                    .unwrap_or(ProviderBinding {
                        identity: "public-openrouter-models".into(),
                    }),
            )
        } else {
            self.providers.get(&provider).cloned()
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogFetch {
    /// Fixed public Surplus model discovery. Never resolves a spend credential.
    AnonymousSurplus,
    /// Resolve the configured Codex base's /models endpoint; append this exact version
    /// iff that base ends in /codex. Use source originator/user-agent and manual redirects.
    Codex {
        account: CodexAccount,
        client_version: String,
        if_none_match: Option<String>,
    },
    Provider {
        provider: CatalogProvider,
        binding: ProviderBinding,
        /// Claude-only after_id cursor. Other sources must reject this field.
        after_id: Option<JsString16>,
        /// One absolute deadline for the whole Claude pagination sequence.
        deadline_ms: Option<i64>,
    },
}
impl CatalogFetch {
    pub fn max_body_bytes(&self) -> Option<usize> {
        if matches!(
            self,
            Self::Provider {
                provider: CatalogProvider::ClaudeCode,
                ..
            }
        ) {
            Some(2 * 1024 * 1024)
        } else {
            None
        }
    }
    pub fn timeout_ms(&self) -> Option<u32> {
        match self {
            Self::Codex { .. } => None,
            Self::AnonymousSurplus => Some(10_000),
            Self::Provider {
                provider: CatalogProvider::ClaudeCode,
                ..
            } => Some(8_000),
            Self::Provider { .. } => Some(10_000),
        }
    }
    pub fn remaining_timeout_ms(&self, now_ms: i64) -> Result<Option<u32>, GatewayError> {
        if let Self::Provider {
            deadline_ms: Some(deadline),
            ..
        } = self
        {
            let remaining = deadline.saturating_sub(now_ms);
            if remaining <= 0 {
                return Err(unavailable(
                    "Provider model discovery exceeded its request deadline",
                ));
            }
            return Ok(Some(
                (remaining as u64).min(u64::from(self.timeout_ms().unwrap_or(u32::MAX))) as u32,
            ));
        }
        Ok(self.timeout_ms())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogFetchResponse {
    pub status: u16,
    pub body: String,
    pub content_type: Option<String>,
    /// Upstream validator, never the client validator.
    pub etag: Option<String>,
    /// True only after a cloned single-account observation completed within the
    /// source 4-MiB / 1-second limit. This never caps the main catalog body.
    pub single_account_observation_complete: bool,
    /// Source response headers and access-token expiry, supplied by the exact fetch capability.
    pub provider_request_id: Option<String>,
    pub access_token_expired: Option<bool>,
    pub observed_at_ms: Option<i64>,
}
impl CatalogFetchResponse {
    pub fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
            content_type: Some("application/json".into()),
            etag: None,
            single_account_observation_complete: false,
            provider_request_id: None,
            access_token_expired: None,
            observed_at_ms: None,
        }
    }
    pub fn is_json(&self) -> bool {
        self.content_type
            .as_ref()
            .is_some_and(|v| v.to_ascii_lowercase().contains("application/json"))
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogObservation {
    CodexResponse {
        account: CodexAccount,
        status: u16,
        provider_request_id: Option<String>,
        access_token_expired: Option<bool>,
        observed_at_ms: Option<i64>,
    },
    CodexTransportFailure {
        account: CodexAccount,
        code: Option<String>,
    },
    ProviderDegradation {
        client_version: String,
    },
    MaintenanceFailure {
        operation: CatalogMaintenance,
        code: Option<String>,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogMaintenance {
    SnapshotPublication,
    VersionPruning,
}
/// Implementations own cancellation and actual response bounds. Fetches must bind the
/// exact current reference before sending; a different credential may not be substituted.
pub trait CatalogHost {
    /// Same trusted constructor-owned source ordering used by routing/authority; never request data.
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator>;
    fn now_ms(&self) -> i64;
    fn unique_id(&self) -> String;
    fn wait(&self, milliseconds: u32) -> impl Future<Output = Result<(), GatewayError>>;
    fn publication(&self) -> impl Future<Output = Result<CredentialPublication, GatewayError>>;
    fn fetch(
        &self,
        request: CatalogFetch,
    ) -> impl Future<Output = Result<CatalogFetchResponse, GatewayError>>;
    /// Apply the existing provider-health/capacity sampling or standalone degradation seam.
    /// Optional telemetry never gates catalog serving or becomes quota/capacity proof.
    /// The default explicitly reports missing persistence; adapters may log it.
    fn observe(
        &self,
        _observation: CatalogObservation,
    ) -> impl Future<Output = Result<(), GatewayError>> {
        async {
            Err(GatewayError::unavailable(
                "Catalog observation persistence is unavailable",
                "catalog_observation_unavailable",
            ))
        }
    }
    /// Invoke only the existing credential owner's coordinated valid-auth/401 flow.
    /// Unsupported owners fail explicitly; this default never refreshes OAuth.
    fn refresh_codex(
        &self,
        _expected: &CodexAccount,
    ) -> impl Future<Output = Result<CodexAccount, GatewayError>> {
        async {
            Err(GatewayError::unavailable(
                "The Codex credential owner cannot refresh here",
                "catalog_credential_owner_unavailable",
            ))
        }
    }
}
pub(crate) fn unavailable(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("codex_catalog_unavailable"))
}
