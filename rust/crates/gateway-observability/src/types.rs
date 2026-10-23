use gateway_admin_runtime::capabilities::Context;
use gateway_core::{GatewayError, state::RevisionCheck};
use serde::{Deserialize, Serialize};
use std::future::Future;

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
        Self {
            provider,
            identity: "default".into(),
            source_checks: Vec::new(),
        }
    }
    pub fn codex(account_id: impl Into<String>) -> Self {
        Self {
            provider: HealthProvider::Codex,
            identity: account_id.into(),
            source_checks: Vec::new(),
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthProvider {
    Cerebras,
    ClaudeCode,
    Codex,
    Deepseek,
    Lithos,
    Metered,
    Openrouter,
    Surplus,
    Ubiquity,
}
impl HealthProvider {
    pub fn id(self) -> &'static str {
        match self {
            Self::Cerebras => "cerebras",
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::Deepseek => "deepseek",
            Self::Lithos => "lithos",
            Self::Metered => "metered",
            Self::Openrouter => "openrouter",
            Self::Surplus => "surplus",
            Self::Ubiquity => "ubiquity",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthEvent {
    Success,
    Reachable,
    AuthInvalid,
    QuotaExhausted,
    UpstreamError,
    RefreshSuccess,
    RefreshFailed,
}
impl HealthEvent {
    pub fn record(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Reachable => "reachable",
            Self::AuthInvalid => "auth_invalid",
            Self::QuotaExhausted => "quota_exhausted",
            Self::UpstreamError => "upstream_error",
            Self::RefreshSuccess | Self::RefreshFailed => "refresh",
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
pub enum HealthWrite {
    Stored,
    Throttled,
    Coalesced,
    Unavailable,
    BindingChanged,
}

/// The fixed host owns real clock/wait/RNG. Pure storage algorithms never call a provider.
pub trait ObservabilityHost {
    /// The same trusted pure runtime capability used by source model controls.
    /// It is never supplied by a request/body and has no scalar fallback.
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator>;
    fn now_ms(&self) -> i64;
    fn compare_labels(
        &self,
        _left: &str,
        _right: &str,
    ) -> Result<std::cmp::Ordering, GatewayError> {
        Err(crate::store::missing("source_locale_compare"))
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError>;
    fn metered_balance_fingerprint(
        &self,
    ) -> impl Future<Output = Result<Option<String>, GatewayError>> {
        async { Err(crate::store::missing("metered_balance_account_identity")) }
    }
    /// Existing paid authority owns the idempotent backfill and its anchored TTL rewrite.
    fn backfill_paid_usage(
        &self,
        _limit: u32,
    ) -> impl Future<Output = Result<crate::host_types::PaidBackfillReceipt, GatewayError>> {
        async { Err(crate::store::missing("paid_authority_backfill")) }
    }
    fn capacity_observation_body(
        &self,
        _context: &Context,
    ) -> impl Future<Output = Result<Vec<u8>, GatewayError>> {
        async { Err(crate::store::missing("request_bound_capacity_body")) }
    }
    fn codex_reset_available_count(
        &self,
        _account: &crate::host_types::CapacityAccountRef,
        _deadline_ms: i64,
    ) -> impl Future<Output = Result<Option<i64>, GatewayError>> {
        async { Err(crate::store::missing("codex_reset_count_diagnostic")) }
    }
    fn codex_reset_credits(
        &self,
        _account: &crate::host_types::CapacityAccountRef,
        _deadline_ms: i64,
    ) -> impl Future<Output = Result<Option<Vec<crate::host_types::ResetCreditDiagnostic>>, GatewayError>>
    {
        async { Err(crate::store::missing("codex_reset_credit_diagnostic")) }
    }
    fn codex_overage_diagnostics(
        &self,
        _account: &crate::host_types::CapacityAccountRef,
        _deadline_ms: i64,
    ) -> impl Future<Output = Result<Option<serde_json::Value>, GatewayError>> {
        async { Err(crate::store::missing("codex_overage_diagnostic")) }
    }
    /// Delegates only to the existing authority's half-open recheck; never inference.
    fn recheck_codex_slot(&self, _slot: u8) -> impl Future<Output = Result<bool, GatewayError>> {
        async { Err(crate::store::missing("codex_authority_recheck")) }
    }
    fn cache_experiment_target(
        &self,
    ) -> impl Future<Output = Result<crate::host_types::CacheExperimentTarget, GatewayError>> {
        async { Err(crate::store::missing("fixed_cache_experiment_target")) }
    }
    /// Native ownership/refresh and the source's fixed three-cycle operation remain with the native owner.
    /// Recheck the exact current target/cohort/release and source leases before any experiment I/O.
    fn run_fixed_cache_experiment(
        &self,
        _baseline: &serde_json::Value,
    ) -> impl Future<Output = Result<serde_json::Value, GatewayError>> {
        async { Err(crate::store::missing("fixed_cache_experiment")) }
    }
    fn wait_ms(&self, milliseconds: u32) -> impl Future<Output = Result<(), GatewayError>>;
    fn build_identity(&self) -> Result<crate::host_types::BuildIdentity, GatewayError> {
        Err(crate::store::missing("immutable_build_identity"))
    }
    fn provider_inventory(
        &self,
        _context: &Context,
    ) -> impl Future<Output = Result<crate::host_types::ProviderInventory, GatewayError>> {
        async { Err(crate::store::missing("provider_inventory")) }
    }
    /// Only the source fixed Codex models, monitoring quota and Claude models GETs.
    /// Implementations enforce this one absolute 3-second deadline and cancel late bodies.
    fn probe_upstream_health(
        &self,
        _deadline_ms: i64,
    ) -> impl Future<Output = Result<crate::host_types::UpstreamHealthEvidence, GatewayError>> {
        async { Err(crate::store::missing("active_upstream_health")) }
    }
    fn codex_capacity_accounts(
        &self,
    ) -> impl Future<Output = Result<Vec<crate::host_types::CapacityAccountRef>, GatewayError>>
    {
        async { Err(crate::store::missing("codex_capacity_accounts")) }
    }
    fn probe_codex_capacity(
        &self,
        _account: &crate::host_types::CapacityAccountRef,
        _fence: &gateway_authority::capacity::CodexCapacityObservationFence,
        _deadline_ms: i64,
    ) -> impl Future<Output = Result<crate::host_types::CapacityProbe, GatewayError>> {
        async { Err(crate::store::missing("codex_capacity_probe")) }
    }
    /// Capture original authority facts before any GET. The returned fence is opaque, not caller JSON.
    fn begin_codex_capacity_observation(
        &self,
        _accounts: &[crate::host_types::CapacityAccountRef],
    ) -> impl Future<
        Output = Result<gateway_authority::capacity::CodexCapacityObservationFence, GatewayError>,
    > {
        async { Err(crate::store::missing("capacity_authority_source_fence")) }
    }
    fn metered_quota_snapshot(
        &self,
        _force_refresh: bool,
        _deadline_ms: i64,
    ) -> impl Future<Output = Result<Option<serde_json::Value>, GatewayError>> {
        async { Err(crate::store::missing("metered_quota_snapshot")) }
    }
    /// Fixed non-billable monitoring GET. A provider inference key is never substituted.
    fn fetch_metered_quota(
        &self,
        _deadline_ms: i64,
    ) -> impl Future<Output = Result<serde_json::Value, GatewayError>> {
        async { Err(crate::store::missing("metered_quota_monitoring_get")) }
    }
    /// Calls the existing authority's current-binding observation writer; never another ledger.
    fn accept_capacity_observations(
        &self,
        _fence: &gateway_authority::capacity::CodexCapacityObservationFence,
        _observations: &[gateway_authority::capacity::CodexCapacitySample],
    ) -> impl Future<
        Output = Result<
            gateway_authority::capacity::AcceptedCodexCapacityObservations,
            GatewayError,
        >,
    > {
        async { Err(crate::store::missing("capacity_authority_observation")) }
    }
}
