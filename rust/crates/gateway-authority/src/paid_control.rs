//! Fixed same-authority derived control metadata; these DTOs grant no write capability.
use gateway_core::provider::PaidProvider;
use gateway_core::state::RevisionCheck;
use gateway_providers::ClientSurface;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paid::{PaidRequest, PaidRoutingPolicy};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PaidSourceCheck {
    pub key: String,
    pub expected_revision: Option<String>,
}

impl From<&RevisionCheck> for PaidSourceCheck {
    fn from(value: &RevisionCheck) -> Self {
        Self { key: value.key.0.clone(), expected_revision: value.expected_revision.clone() }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PaidControlOwner {
    pub v: u32,
    pub owner_id: String,
    pub owner_epoch: String,
    pub key_fingerprint: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PaidControlConfig {
    pub v: u32,
    pub owner_id: String,
    pub owner_epoch: String,
    pub generation: String,
    pub configuration_fingerprint: String,
    pub surplus_binding: Option<String>,
    pub openlux_binding: Option<String>,
    pub source_checks: Vec<PaidSourceCheck>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PaidProviderObservation {
    pub v: u32,
    pub provider: PaidProvider,
    pub owner_id: String,
    pub owner_epoch: String,
    pub configuration_generation: String,
    pub configuration_fingerprint: String,
    pub credential_binding: String,
    pub observed_at_ms: i64,
    pub source_valid_until_ms: Option<i64>,
    pub stale: bool,
    pub models: Vec<Value>,
    pub source_checks: Vec<PaidSourceCheck>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PaidProjectionProvenance {
    pub v: u32,
    pub owner_revision: String,
    pub config_revision: String,
    pub surplus_observation_revision: Option<String>,
    pub openlux_observation_revision: Option<String>,
    pub observed_at_ms: i64,
    pub source_valid_until_ms: Option<i64>,
    pub source_checks: Vec<PaidSourceCheck>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PaidRoutingProjection {
    #[serde(flatten)]
    pub policy: PaidRoutingPolicy,
    pub provenance: PaidProjectionProvenance,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PaidSyntheticHop { Surplus, Openlux }

/// Construct only from the validated server request and its server-owned pinned hop.
/// The normalized body carries original_model, never a client synthetic-hop flag.
#[derive(Clone)]
pub struct PaidRequestContext {
    pub original_model: String,
    pub body: Value,
    pub surface: ClientSurface,
    pub synthetic_hop: Option<PaidSyntheticHop>,
}

/// Exact request capability. There is no public constructor or client deserializer.
#[derive(Clone)]
pub struct PaidRoutingReceipt {
    pub(crate) request: PaidRequest,
    pub(crate) context: PaidRequestContext,
    pub(crate) checks: Vec<RevisionCheck>,
}

impl std::fmt::Debug for PaidRoutingReceipt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaidRoutingReceipt")
            .field("request_id", &self.request.request_id)
            .field("attempt_id", &self.request.attempt_id)
            .field("model", &self.request.model)
            .field("provider", &self.request.provider)
            .finish_non_exhaustive()
    }
}
