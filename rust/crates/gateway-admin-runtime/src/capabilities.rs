//! Finite native/provider capabilities. No URL, process, path, SQL, or Bun relay interface.
use gateway_auth::{AuthResponse, crypto::Secret};
use gateway_core::GatewayError;
use serde_json::Value;
use std::{collections::BTreeMap, future::Future};

#[derive(Clone, Debug)]
pub struct Context {
    pub request_id: String,
    pub now_ms: i64,
}

pub enum CatalogRequest {
    CodexModelsGet,
    CodexModelsSet { document: Value },
    WhitelistGet,
    WhitelistSet { document: Value },
    Catalog,
    Refresh,
}

pub enum CodexRequest {
    /// The native credential owner validates ownership, refresh effects, fingerprint and upstream auth.
    ImportCredentials { document: Value },
    ResetSettings,
    SetResetSettings { document: Value },
    OverageSettings,
    SetOverageSettings { document: Value },
    ShadowDecisions,
    Recheck { slot: u8 },
    CacheExperimentBaseline,
    /// No caller-selected account, prompt, model, or cache partition exists.
    RunCacheExperiment,
}

pub enum ProviderRequest {
    Inventory,
    PassiveHealth,
    UpstreamHealth,
    Capacity { live: bool },
    Observations { document: Value },
    Rollups { query: BTreeMap<String, Vec<String>> },
}

pub struct ClaudeSubmission {
    pub credential: Option<Secret>,
    pub label: Option<String>,
    /// None means unchanged; Some(None) explicitly removes the workspace pin.
    pub workspace_id: Option<Option<String>>,
    pub account_id: Option<String>,
    pub create_new: bool,
    pub activate: bool,
}

pub enum ClaudeRequest {
    State,
    SetCredential(ClaudeSubmission),
    DeleteAccount { account_id: Option<String> },
    SelectAccount { account_id: String },
    ClearQuota { account_id: Option<String>, cohort_id: Option<String> },
}

pub enum NativeRequest {
    SupervisorSessions,
    SupervisorOutput { source_id: String, thread_id: String, cursor: String },
    SupervisorBrief { source_id: String, thread_id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CaptureRequest {
    Request { request_id: String },
    Interval { after_ms: i64, before_ms: i64, cursor: Option<String> },
    Incident { incident_id: String, cursor: Option<String> },
    Incidents { incident_id: Option<String>, cursor: Option<String>, limit: u32 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MigrationImport {
    pub ndjson: String,
    pub profile: MigrationProfile,
    pub include_cache: bool,
    pub include_legacy: bool,
    pub overwrite: bool,
    pub dry_run: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MigrationProfile { Local, Prod }
pub enum MigrationRequest { Import(MigrationImport), Validate }

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AnalyticsRequest {
    PromptCache { group_by: Vec<String> },
    QuotaProjection { window_days: u32, balance_window_days: u32 },
    QuotaProjectionBackfill { limit: u32 },
    PaidHistory { key_id: String, limit: u32 },
}

#[derive(Clone, Debug)]
pub struct PricingSnapshot {
    pub eligible_model_ids: Vec<String>,
    pub quota_per_credit: i64,
    pub model_quota_coefficients: BTreeMap<String, f64>,
    pub checked_at_ms: i64,
}

fn unavailable(name: &str) -> GatewayError {
    GatewayError::unavailable(format!("Required {name} capability is not configured"), "admin_capability_unavailable")
}

/// Each binding must implement the named source operation, including its redaction and event-owned maintenance.
/// Defaults fail closed; an unbound capability cannot return an empty or successful placeholder.
pub trait RuntimeCapabilities {
    fn catalog(&self, _: CatalogRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("model_catalog")) }
    }
    fn codex(&self, _: CodexRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("codex_capacity_authority")) }
    }
    fn provider(&self, _: ProviderRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("provider_capacity")) }
    }
    fn claude(&self, _: ClaudeRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("claude_account_authority")) }
    }
    fn native(&self, _: NativeRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("native_supervisor")) }
    }
    fn capture(&self, _: CaptureRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("encrypted_failure_capture")) }
    }
    fn migration(&self, _: MigrationRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("portable_state_migration")) }
    }
    fn analytics(&self, _: AnalyticsRequest, _: Context) -> impl Future<Output = Result<AuthResponse, GatewayError>> {
        async { Err(unavailable("analytics")) }
    }
    /// Public picker metadata, without a selection field; the runtime supplies the current authority selection.
    fn provider_picker(&self, _: Context) -> impl Future<Output = Result<Value, GatewayError>> {
        async { Err(unavailable("provider_picker")) }
    }
    fn metered_diagnostics(&self) -> impl Future<Output = Result<Value, GatewayError>> {
        async { Err(unavailable("metered_quota")) }
    }
    /// Reads only configured paid-provider pricing. It must never issue inference or buy credits.
    fn pricing(&self, _: &[String]) -> impl Future<Output = Result<PricingSnapshot, GatewayError>> {
        async { Err(unavailable("paid_fallback_pricing")) }
    }
    /// Independent retention status and stat-only host log diagnostics used by /admin/errors.
    fn error_diagnostics(&self, _: Context) -> impl Future<Output = Result<ErrorDiagnostics, GatewayError>> {
        async { Err(unavailable("error_diagnostics")) }
    }
}

pub struct ErrorDiagnostics { pub retention: Value, pub log_files: Value }
pub struct UnboundCapabilities;
impl RuntimeCapabilities for UnboundCapabilities {}
