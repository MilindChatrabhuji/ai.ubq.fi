//! Source-shaped serial routing records and proof capabilities.
use gateway_core::identity::{
    AccountBinding, CredentialVersion, PoolVersionstamp, RoutingAccountHash,
    SubscriptionSelectionHash,
};
use gateway_core::provider::CodexQuotaClass;
use gateway_core::state::RevisionCheck;
use gateway_core::{js_string::JsString16, model::ModelId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PoolAccount {
    pub account_id_hash: RoutingAccountHash,
    pub admin_account_hash: SubscriptionSelectionHash,
    pub credential_version: CredentialVersion,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SubscriptionPool {
    pub v: u32,
    pub pool_versionstamp: PoolVersionstamp,
    pub accounts: Vec<PoolAccount>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct QuotaBlock {
    pub blocked_until_ms: i64,
    pub source: QuotaBlockSource,
    pub legacy_fallback: bool,
    #[serde(rename = "quota_signal_observed_at_ms")]
    pub observed_at_ms: Option<i64>,
    #[serde(rename = "observed_reset_at_ms")]
    pub reset_at_ms: Option<i64>,
    #[serde(rename = "observed_reset_at_is_stable")]
    pub reset_is_stable: bool,
    #[serde(rename = "banked_reset_generation_ambiguous")]
    pub reset_ambiguous: bool,
    #[serde(rename = "banked_reset_recovery_probe_pending")]
    pub recovery_pending: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaBlockSource {
    BodyResetsAt,
    HeaderRetryAfter,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeCircuit {
    Quota,
    UpstreamTimeout,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProbeLease {
    pub token: String,
    pub generation: i64,
    pub circuit: ProbeCircuit,
    pub quota_class: Option<CodexQuotaClass>,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RoutingSlot {
    pub account_id_hash: Option<RoutingAccountHash>,
    pub credential_version: CredentialVersion,
    pub quota_blocked_until_ms: Option<i64>,
    pub quota_block_source: Option<QuotaBlockSource>,
    pub quota_blocked_classes: Vec<String>,
    pub generation: u64,
    pub invalid_credential_version: Option<CredentialVersion>,
    #[serde(rename = "quota_blocks_by_class")]
    pub quota_blocks: BTreeMap<String, QuotaBlock>,
    pub probe_lease: Option<ProbeLease>,
    pub primary_used_percent: Option<f64>,
    pub secondary_used_percent: Option<f64>,
    pub quota_signal_observed_at_ms: Option<i64>,
    pub capacity_observed_at_ms: Option<i64>,
    pub upstream_timeout_blocked_until_ms: Option<i64>,
    #[serde(rename = "observed_reset_at_ms")]
    pub retained_reset_at_ms: Option<i64>,
    #[serde(rename = "observed_reset_at_is_stable")]
    pub reset_identity_stable: bool,
    #[serde(rename = "banked_reset_generation_ambiguous")]
    pub reset_identity_ambiguous: bool,
    #[serde(rename = "banked_reset_recovery_probe_pending")]
    pub recovery_pending: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RoutingState {
    pub v: u32,
    pub updated_at_ms: i64,
    #[serde(rename = "banked_reset_legacy_identity_unresolved")]
    pub legacy_identity_unresolved: bool,
    pub slots: Vec<RoutingSlot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CapacityStore {
    pub v: u32,
    pub updated_at_ms: i64,
    pub observations: Vec<CapacityObservation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CapacityWindow {
    pub limit_window_seconds: Option<i64>,
    pub used_percent: Option<f64>,
    pub reset_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CapacityAdditionalRateLimit {
    pub limit_name: String,
    pub metered_feature: Option<String>,
    pub windows: CapacityWindows,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct CapacityWindows {
    pub primary: Option<CapacityWindow>,
    pub secondary: Option<CapacityWindow>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapacityState {
    Available,
    Stale,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CapacityObservation {
    pub slot: u8,
    pub account_id_hash: RoutingAccountHash,
    pub state: CapacityState,
    pub source_observed_at_ms: Option<i64>,
    pub snapshot_at_ms: i64,
    pub windows: CapacityWindows,
    pub additional_rate_limits: Vec<CapacityAdditionalRateLimit>,
}

impl Default for CapacityStore {
    fn default() -> Self {
        Self {
            v: 1,
            updated_at_ms: 0,
            observations: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountCatalog {
    pub client_version: String,
    pub models: Vec<ModelId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnsupportedModel {
    pub observed_at_ms: i64,
    pub detail: JsString16,
}

/// Transient hash-keyed view; the source account-model row uses raw account IDs.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelAvailability {
    pub catalogs: BTreeMap<String, AccountCatalog>,
    pub unsupported: BTreeMap<String, BTreeMap<ModelId, UnsupportedModel>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AdmittedAccount {
    pub binding: AccountBinding,
    pub active_generation: u64,
    pub requested_model: ModelId,
    pub quota_class: CodexQuotaClass,
    pub probe_required: bool,
    pub probe: Option<ProbeLease>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScopedOverageProbe {
    pub binding: AccountBinding,
    pub requested_model: ModelId,
    pub quota_class: CodexQuotaClass,
    pub probe: ProbeLease,
}

/// Constructed only by a successful strong selection. Never deserialize an external proof.
#[derive(Clone, Debug)]
pub struct CohortProof {
    pub(crate) checks: Vec<RevisionCheck>,
    pub(crate) model: ModelId,
    pub(crate) quota_class: CodexQuotaClass,
    pub(crate) exhausted: bool,
    pub(crate) unavailable: bool,
    pub(crate) bindings: Vec<AccountBinding>,
}

impl CohortProof {
    pub fn full_cohort_exhausted(&self) -> bool {
        self.exhausted
    }
    pub fn full_cohort_unavailable(&self) -> bool {
        self.unavailable
    }
    pub fn selected_count(&self) -> usize {
        self.bindings.len()
    }
    pub fn model(&self) -> &ModelId {
        &self.model
    }
    pub fn account_bindings(&self) -> &[AccountBinding] {
        &self.bindings
    }
    pub fn quota_class(&self) -> CodexQuotaClass {
        self.quota_class
    }
}

#[derive(Clone, Debug)]
pub enum RouteSelection {
    Eligible(AdmittedAccount),
    QuotaBlocked {
        retry_at_ms: Option<i64>,
        proof: CohortProof,
    },
    CredentialsInvalid {
        proof: CohortProof,
    },
    ModelUnavailable {
        model: ModelId,
        detail: Option<JsString16>,
    },
    RoutingUnavailable,
}
