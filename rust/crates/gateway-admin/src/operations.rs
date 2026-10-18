use gateway_auth::{AuthPrincipal, AuthResponse};
use gateway_core::GatewayError;
use serde_json::Value;
use std::{collections::BTreeMap, future::Future};

use crate::AdminOperation;

/// Finite business capabilities, not an arbitrary command/path/SQL/URL forwarding interface.
pub struct AdminInput {
    pub parameter: Option<String>,
    pub query: BTreeMap<String, Vec<String>>,
    pub body: Value,
    pub actor: AuthPrincipal,
    pub request_id: String,
    pub now_ms: i64,
}

pub trait AdminHost {
    /// Catalog/provider/authority/native owners implement their named operation. Missing capability MUST fail closed.
    fn execute(
        &self,
        operation: AdminOperation,
        input: AdminInput,
    ) -> impl Future<Output = Result<AuthResponse, GatewayError>>;
    /// Claim the common paid-deletion guard before inspecting unsettled billing,
    /// and return its new nonempty revision plus every required ledger fence.
    /// Refuse pending/unknown billing and release only the caller's claim on failure.
    /// The final key/hash/policy/audit transaction checks these exact revisions.
    fn prepare_key_deletion(
        &self,
        key_id: &str,
    ) -> impl Future<Output = Result<Vec<gateway_core::state::RevisionCheck>, GatewayError>>;
    /// Source pricing/exposure discovery belongs before the atomic key-policy write, outside the transaction.
    fn paid_key_policy(
        &self,
        body: &Value,
    ) -> impl Future<Output = Result<PaidKeyFields, GatewayError>>;
}

#[derive(Clone, Debug)]
pub struct PaidKeyFields {
    pub enabled: bool,
    pub limit_microcredits: i64,
    pub model_ids: Vec<String>,
    pub quota_per_credit: i64,
    pub max_exposure_microcredits: BTreeMap<String, i64>,
    pub pricing_checked_at_ms: Option<i64>,
}

impl PaidKeyFields {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            limit_microcredits: 0,
            model_ids: Vec::new(),
            quota_per_credit: 1,
            max_exposure_microcredits: BTreeMap::new(),
            pricing_checked_at_ms: None,
        }
    }
}

pub fn missing_capability(operation: AdminOperation) -> GatewayError {
    GatewayError::unavailable(
        format!(
            "Required {} capability is not configured",
            operation.capability()
        ),
        "admin_capability_unavailable",
    )
}
