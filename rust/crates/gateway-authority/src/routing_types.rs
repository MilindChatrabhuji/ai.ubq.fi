//! Source-shaped serial routing records and proof capabilities.
use gateway_core::identity::{
    AccountBinding, CredentialVersion, PoolVersionstamp, RoutingAccountHash,
    SubscriptionSelectionHash,
};
use gateway_core::provider::CodexQuotaClass;
use gateway_core::state::RevisionCheck;
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
    pub observed_at_ms: i64,
    pub reset_at_ms: Option<i64>,
    pub reset_is_stable: bool,
    pub reset_ambiguous: bool,
    pub recovery_pending: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaBlockSource {
    BodyResetsAt,
    HeaderRetryAfter,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProbeLease {
    pub token: String,
    pub generation: u64,
    pub quota_class: CodexQuotaClass,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RoutingSlot {
    pub account_id_hash: RoutingAccountHash,
    pub credential_version: CredentialVersion,
    pub generation: u64,
    pub invalid_credential_version: Option<CredentialVersion>,
    pub quota_blocks: BTreeMap<String, QuotaBlock>,
    pub probe_lease: Option<ProbeLease>,
    pub retained_reset_at_ms: Option<i64>,
    pub reset_identity_ambiguous: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RoutingState {
    pub v: u32,
    pub updated_at_ms: i64,
    pub legacy_identity_unresolved: bool,
    pub slots: Vec<RoutingSlot>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct CapacityStore {
    pub observations: Vec<CapacityObservation>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CapacityWindow {
    pub used_percent: Option<f64>,
    pub reset_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ModelCapacity {
    pub model: String,
    pub windows: Vec<CapacityWindow>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CapacityObservation {
    pub account_id_hash: RoutingAccountHash,
    pub available: bool,
    pub snapshot_at_ms: i64,
    pub windows: Vec<CapacityWindow>,
    pub additional: Vec<ModelCapacity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountCatalog {
    pub client_version: String,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnsupportedModel {
    pub observed_at_ms: i64,
    pub detail: String,
}

/// Transient hash-keyed view; the source account-model row uses raw account IDs.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelAvailability {
    pub catalogs: BTreeMap<String, AccountCatalog>,
    pub unsupported: BTreeMap<String, BTreeMap<String, UnsupportedModel>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AdmittedAccount {
    pub binding: AccountBinding,
    pub active_generation: u64,
    pub requested_model: String,
    pub quota_class: CodexQuotaClass,
    pub probe_required: bool,
    pub probe: Option<ProbeLease>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScopedOverageProbe {
    pub binding: AccountBinding,
    pub requested_model: String,
    pub quota_class: CodexQuotaClass,
    pub probe: ProbeLease,
}

/// Constructed only by a successful strong selection. Never deserialize an external proof.
#[derive(Clone, Debug)]
pub struct CohortProof {
    pub(crate) checks: Vec<RevisionCheck>,
    pub(crate) model: String,
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
    pub fn model(&self) -> &str {
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
        model: String,
        detail: Option<String>,
    },
    RoutingUnavailable,
}
