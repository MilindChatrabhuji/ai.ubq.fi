//! Independent paid attempt, semantic terminal and billing record contracts.
use crate::claude::ClaudeCohortProof;
use crate::routing::CohortProof;
use gateway_core::identity::{ApiKeyId, PaidAttemptId, RequestId};
use gateway_core::lifecycle::{BillingState, DispatchState, PaidTerminalState};
use gateway_core::provider::PaidProvider;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PaidRoutingPolicy {
    pub v: u32,
    pub codex_enabled: bool,
    pub codex_models: Vec<String>,
    pub models: BTreeMap<String, Vec<PaidProvider>>,
}

#[derive(Clone, Debug)]
pub enum PaidAuthorization {
    SubscriptionUnavailable(CohortProof),
    ClaudeSubscriptionUnavailable(ClaudeCohortProof),
    DirectPaidModel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PaidReservation {
    pub key_id: ApiKeyId,
    pub request_id: RequestId,
    pub attempt_id: PaidAttemptId,
    pub provider: PaidProvider,
    pub window_reset_at_ms: i64,
    pub created_at_ms: i64,
    pub reserved_microcredits: i64,
}

#[derive(Clone, Debug)]
pub enum PaidAdmission {
    Reserved(PaidReservation),
    Existing(PaidReservation),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PaidRequest {
    pub key_id: ApiKeyId,
    pub request_id: RequestId,
    pub attempt_id: PaidAttemptId,
    pub provider: PaidProvider,
    pub model: String,
    pub route: String,
    pub path: String,
    pub stream: bool,
    pub reasoning: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PaidAttempt {
    pub v: u32,
    pub reservation: PaidReservation,
    pub policy_version: String,
    pub model: String,
    pub route: String,
    pub path: String,
    pub stream: bool,
    pub reasoning: Option<String>,
    pub quota_per_credit: i64,
    pub provider_request_id: Option<String>,
    pub dispatch_state: DispatchState,
    pub terminal_state: PaidTerminalState,
    pub billing_state: BillingState,
    pub provider_quota: Option<f64>,
    pub input_tokens: Option<i64>,
    pub cached_input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub spend_microcredits: Option<i64>,
    pub transport_started: bool,
    pub reconciliation_attempts: i64,
    pub last_reconciliation_at_ms: Option<i64>,
    pub dispatched_at_ms: Option<i64>,
    pub terminal_at_ms: Option<i64>,
    pub settled_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    pub usage_rollup_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PaidWindow {
    pub v: u32,
    pub key_id: ApiKeyId,
    pub policy_version: String,
    pub window_reset_at_ms: i64,
    pub limit_microcredits: i64,
    pub settled_microcredits: i64,
    pub reserved_microcredits: i64,
    pub pending_count: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PendingPaid {
    pub key_id: ApiKeyId,
    pub attempt_id: PaidAttemptId,
    pub created_at_ms: i64,
    pub next_reconciliation_at_ms: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReconciliationGate {
    pub next_due_at_ms: Option<i64>,
    /// Only outstanding work, never settled history. Event owners enumerate due keys.
    pub pending: BTreeMap<String, PendingPaid>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReconciliationLease {
    pub token: String,
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PaidRollup {
    pub v: u32,
    pub bucket_start_at_ms: i64,
    pub model: String,
    pub provider: PaidProvider,
    pub request_count: i64,
    #[serde(rename = "quota_sum")]
    pub provider_quota: f64,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub spend_microcredits: i64,
    pub first_request_at_ms: i64,
    pub last_request_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct PaidUsage {
    pub provider_quota: f64,
    pub input_tokens: i64,
    pub cached_input_tokens: Option<i64>,
    pub output_tokens: i64,
    pub correlation: PaidCorrelation,
}

#[derive(Clone, Debug)]
pub enum PaidCorrelation {
    ProviderRequestId(String),
    SurplusReservation {
        attempt_id: PaidAttemptId,
        buyer_cost_micro: Option<i64>,
    },
}
