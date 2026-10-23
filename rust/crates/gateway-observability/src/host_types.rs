//! Fixed secretless receipts from native publication and the actual Worker transport.
use crate::types::{HealthProvider, HealthTarget};
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuildIdentity {
    pub git_sha: String,
    pub deployment_id: String,
}
impl BuildIdentity {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.git_sha.len() != 40
            || !self
                .git_sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.deployment_id.is_empty()
            || self.deployment_id.len() > 256
        {
            return Err(crate::store::missing("valid_immutable_build_identity"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct CodexAuthAccount {
    pub account_id: String,
    pub slot: u8,
    pub updated_at_ms: Option<i64>,
    pub access_token_exp_ms: Option<i64>,
    pub refresh_sha256: Option<String>,
    pub native_owner_codex_home: Option<String>,
}
#[derive(Clone, Debug)]
pub struct CodexAuthMetadata {
    pub source: CredentialSource,
    pub updated_at_ms: Option<i64>,
    pub access_token_exp_ms: Option<i64>,
    pub accounts: Vec<CodexAuthAccount>,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialSource {
    Kv,
    Env,
    None,
}
#[derive(Clone, Debug, Serialize)]
pub struct CredentialMetadata {
    pub kind: CredentialKind,
    pub source: String,
    pub hint: JsString16,
    pub label: Option<JsString16>,
    pub updated_at_ms: Option<i64>,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    ApiKey,
    Oauth,
}
#[derive(Clone, Debug, Serialize)]
pub struct WorkspaceMetadata {
    pub id: JsString16,
    pub name: Option<JsString16>,
    pub source: Option<String>,
    pub pinned_by_env: bool,
    pub discovered_at_ms: Option<i64>,
    pub verified_at_ms: Option<i64>,
    pub last_error: Option<SourceJson>,
}
#[derive(Clone, Debug)]
pub struct ClaudeAccountReadback {
    pub target: HealthTarget,
    pub account_id: String,
    pub account_cohort_id: String,
    pub label: Option<JsString16>,
    pub credential: CredentialMetadata,
    pub workspace: Option<WorkspaceMetadata>,
    /// Validated source quota state, without pool proof or credential fields.
    pub quota: Option<gateway_core::source_json::SourceJson>,
}
#[derive(Clone, Debug)]
pub struct ClaudeRosterReadback {
    pub accounts: Vec<ClaudeAccountReadback>,
    pub active_account_id: Option<String>,
    pub active_reason: Option<JsString16>,
    pub access: Option<ClaudeAccessReadback>,
    pub enabled: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct ClaudeAccessReadback {
    pub source: String,
    pub allowed_key_ids: Vec<JsString16>,
    pub updated_at_ms: Option<i64>,
}
#[derive(Clone, Debug)]
pub struct ProviderInventory {
    pub codex: CodexAuthMetadata,
    pub configured: BTreeSet<HealthProvider>,
    pub claude: ClaudeRosterReadback,
    /// Cached monitoring observation only; this passive method performs no refresh.
    pub metered_quota: Option<Value>,
    pub quota_monitoring_configured: bool,
    pub ubiquity_configured: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct ActiveProbe {
    pub status: u16,
    pub provider: ProbeProvider,
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<gateway_core::js_string::JsString16>,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeProvider {
    ChatgptCodex,
    MeteredQuota,
    ClaudeSubscription,
}
#[derive(Clone, Debug)]
pub struct UpstreamHealthEvidence {
    pub auth: Option<CodexAuthMetadata>,
    pub codex: ActiveProbe,
    pub metered_quota: Option<ActiveProbe>,
    pub claude_subscription: Option<ActiveProbe>,
    pub claude_workspace: Option<SourceJson>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapacityAccountRef {
    pub slot: u8,
    pub account_id: String,
    pub label: Option<String>,
}
#[derive(Clone, Debug)]
pub enum CapacityProbe {
    Http { status: u16, json: Option<Value> },
    Unreachable,
}
#[derive(Clone, Debug, Serialize)]
pub struct ResetCreditDiagnostic {
    pub status: String,
    pub expires_at_ms: Option<i64>,
}
/// The fixed experiment chooses its target; no request body may supply these fields.
#[derive(Clone, Debug)]
pub struct CacheExperimentTarget {
    pub provider: String,
    pub model: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct PaidRequestBackfill {
    pub scanned: u32,
    pub processed: u32,
    pub rollups_written: u32,
    pub failed: u32,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct PaidWindowBackfill {
    pub scanned: u32,
    pub rewritten: u32,
    pub truncated: bool,
}
#[derive(Clone, Debug)]
pub struct PaidBackfillReceipt {
    pub requests: PaidRequestBackfill,
    pub windows: PaidWindowBackfill,
}
/// Source ClaudeCodeAcceptedObservation, emitted only after its current-binding quota CAS.
/// History/health subscribers never write quota or credential state from this event.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ClaudeAcceptedObservation {
    pub v: u8,
    pub observation_id: String,
    pub account_id: String,
    pub account_cohort_id: String,
    pub credential_kind: CredentialKind,
    pub workspace_id: Option<JsString16>,
    pub source_observed_at_ms: Option<i64>,
    pub sampled_at_ms: i64,
    pub response_status: Option<u16>,
    pub state: ClaudeObservationState,
    pub observation: SourceJson,
}
impl ClaudeAcceptedObservation {
    pub fn from_source(value: &SourceJson) -> Result<Self, GatewayError> {
        value.deserialize()
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeObservationState {
    Available,
    Unavailable,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ClaudeQuotaObservation {
    pub windows: std::collections::BTreeMap<String, ClaudeQuotaWindow>,
    pub standard: std::collections::BTreeMap<String, ClaudeStandardWindow>,
    pub representative_claim: Option<String>,
    pub observed_at_ms: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ClaudeQuotaWindow {
    pub status: Option<String>,
    pub utilization: Option<f64>,
    pub reset_at_ms: Option<i64>,
    pub observed_at_ms: i64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ClaudeStandardWindow {
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub reset_at_ms: Option<i64>,
    pub observed_at_ms: i64,
}
