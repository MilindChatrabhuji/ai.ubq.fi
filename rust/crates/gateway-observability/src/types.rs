use gateway_core::{GatewayError, state::RevisionCheck};
use serde::{Deserialize, Serialize};
use std::future::Future;

pub use gateway_admin_runtime::capabilities::{AnalyticsRequest, CaptureRequest, CodexRequest, Context, ErrorDiagnostics, ProviderRequest};

/// Observational identities only. No credential or caller-selected URL is carried.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HealthTarget {
    pub provider: HealthProvider,
    pub identity: String,
    /// Claude observations must check their accepted account/cohort/generation row.
    pub source_checks: Vec<RevisionCheck>,
}
impl HealthTarget {
    pub fn default_identity(provider: HealthProvider) -> Self {
        Self { provider, identity: "default".into(), source_checks: Vec::new() }
    }
    pub fn codex(account_id: impl Into<String>) -> Self {
        Self { provider: HealthProvider::Codex, identity: account_id.into(), source_checks: Vec::new() }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthProvider { Cerebras, ClaudeCode, Codex, Deepseek, Lithos, Metered, Openrouter, Surplus, Ubiquity }
impl HealthProvider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Cerebras=>"cerebras",Self::ClaudeCode=>"claude_code",Self::Codex=>"codex",Self::Deepseek=>"deepseek",Self::Lithos=>"lithos",Self::Metered=>"metered",Self::Openrouter=>"openrouter",Self::Surplus=>"surplus",Self::Ubiquity=>"ubiquity",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthEvent { Success, Reachable, AuthInvalid, QuotaExhausted, UpstreamError, RefreshSuccess, RefreshFailed }
impl HealthEvent {
    pub fn record(self) -> &'static str {
        match self {
            Self::Success=>"success",Self::Reachable=>"reachable",Self::AuthInvalid=>"auth_invalid",Self::QuotaExhausted=>"quota_exhausted",Self::UpstreamError=>"upstream_error",Self::RefreshSuccess|Self::RefreshFailed=>"refresh",
        }
    }
}
/// Source parser accepts finite status/time numbers; the live writer supplies its truncated real clock.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct HealthObservation {
    pub event: HealthEvent,
    pub status: Option<f64>,
    pub observed_at_ms: f64,
    #[serde(default)]
    pub provider_request_id: Option<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HealthWrite { Stored, Throttled, Coalesced, Unavailable, BindingChanged }

/// The fixed host owns real clock/wait/RNG. Pure storage algorithms never call a provider.
pub trait ObservabilityHost {
    fn now_ms(&self) -> i64;
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError>;
    fn wait_ms(&self, milliseconds: u32) -> impl Future<Output=Result<(), GatewayError>>;
}
