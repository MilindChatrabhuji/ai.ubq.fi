//! Independent paid attempt, semantic terminal and billing record contracts.
use crate::claude::ClaudeCohortProof;
use crate::routing::CohortProof;
use gateway_core::identity::{ApiKeyId, PaidAttemptId, RequestId};
use gateway_core::{js_string::JsString16, model::ModelId};
pub mod model_map;
use gateway_core::lifecycle::{BillingState, DispatchState, PaidTerminalState};
use gateway_core::provider::PaidProvider;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PaidRoutingPolicy {
    pub v: u32,
    pub codex_enabled: bool,
    pub codex_models: Vec<ModelId>,
    #[serde(with = "model_map")]
    pub models: BTreeMap<ModelId, Vec<PaidProvider>>,
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
    pub model: ModelId,
    pub route: String,
    pub path: String,
    pub stream: bool,
    pub reasoning: Option<JsString16>,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PaidAttempt {
    pub v: u32,
    pub reservation: PaidReservation,
    pub policy_version: String,
    pub model: ModelId,
    pub route: String,
    pub path: String,
    pub stream: bool,
    pub reasoning: Option<JsString16>,
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
    pub model: ModelId,
    pub provider: PaidProvider,
    pub request_count: i64,
    #[serde(rename = "quota_sum")]
    pub provider_quota: f64,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    #[serde(
        serialize_with = "serialize_rollup_spend",
        deserialize_with = "deserialize_rollup_spend"
    )]
    pub spend_microcredits: f64,
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

// Source rollup spend is finite/nonnegative, unlike exact integer request/window billing.
fn deserialize_rollup_spend<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<f64, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("Invalid source aggregate spend"))
    }
}
fn serialize_rollup_spend<S: serde::Serializer>(
    value: &f64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if !value.is_finite() || *value < 0.0 {
        return Err(serde::ser::Error::custom("Invalid source aggregate spend"));
    }
    if value.fract() == 0.0 && *value <= gateway_core::identity::MAX_SAFE_INTEGER as f64 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}
