use crate::{
    reset::{ResetCandidate, ResetConfig},
    routing::CohortProof,
};
use gateway_core::{
    GatewayError,
    identity::{AccountBinding, RequestContext},
    js_string::JsString16,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FullPoolFence {
    pub slot: u64,
    pub account_id_hash: String,
    pub quota_generation: String,
    pub routing_generation: u64,
    pub quota_reset_at_ms: i64,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FullPoolShadowDecision {
    pub v: u8,
    pub episode_hash: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub decision_reason: String,
    pub selected_account_id_hash: Option<String>,
    pub selected_credit_id_hash: Option<String>,
    pub selected_credit_expires_at_ms: Option<i64>,
    pub fences: Vec<FullPoolFence>,
}

/// Provider observations are not grants. Raw opaque IDs never serialize into audit KV.
#[derive(Clone)]
pub struct SourceResetCredit {
    pub credit_id: JsString16,
    pub status: JsString16,
    pub reset_type: JsString16,
    pub expires_at_ms: Option<i64>,
}
#[derive(Clone)]
pub struct SourceResetInventory {
    pub binding: AccountBinding,
    pub observed_at_ms: i64,
    pub available_count: i64,
    pub credits: Vec<SourceResetCredit>,
}
pub trait SourceCreditCollation {
    fn compare_credit_ids(
        &self,
        left: &JsString16,
        right: &JsString16,
    ) -> Result<Ordering, GatewayError>;
}

pub enum FullPoolPreparation {
    Declined { reason: String },
    Cached { decision: FullPoolShadowDecision },
    Observe(Box<FullPoolResetPlan>),
}
pub enum FullPoolEvaluation {
    Declined {
        reason: String,
    },
    Shadow {
        decision: FullPoolShadowDecision,
        duplicate: bool,
    },
    Ready(Box<AutomaticResetPermit>),
}
#[derive(Clone)]
pub(super) struct Member {
    pub candidate: ResetCandidate,
    pub administrative_hash: String,
    pub enabled: bool,
}
#[derive(Clone)]
pub(super) struct Facts {
    pub proof: CohortProof,
    pub original: RequestContext,
    pub config: ResetConfig,
    pub members: Vec<Member>,
    pub fences: Vec<FullPoolFence>,
    pub settings_version: String,
    pub episode_hash: String,
}
pub struct FullPoolResetPlan {
    pub(super) facts: Facts,
    pub(super) audit_present: bool,
}
impl FullPoolResetPlan {
    pub fn bindings(&self) -> impl Iterator<Item = &AccountBinding> {
        self.facts
            .members
            .iter()
            .filter(|member| member.enabled)
            .map(|member| &member.candidate.binding)
    }
    pub fn original(&self) -> &RequestContext {
        &self.facts.original
    }
}

/// Minted only by live evaluation in the current complete source transaction; never reconstructed from wire.
/// ```compile_fail
/// use gateway_authority::full_pool_reset::AutomaticResetPermit;
/// let _: AutomaticResetPermit = serde_json::from_str("{}").unwrap();
/// ```
pub struct AutomaticResetPermit {
    pub(super) facts: Facts,
    pub(super) candidate: ResetCandidate,
    pub(super) decision: FullPoolShadowDecision,
    pub(super) credit: SourceResetCredit,
    pub(super) observed_at_ms: i64,
}
impl AutomaticResetPermit {
    pub(crate) fn candidate(&self) -> &ResetCandidate {
        &self.candidate
    }
    pub fn binding(&self) -> &AccountBinding {
        &self.candidate.binding
    }
    pub fn credit_id(&self) -> &JsString16 {
        &self.credit.credit_id
    }
    pub fn episode_hash(&self) -> &str {
        &self.decision.episode_hash
    }
    pub fn original(&self) -> &RequestContext {
        &self.facts.original
    }
    pub fn invocation(&self) -> Result<crate::reset::ResetInvocation, GatewayError> {
        crate::reset::reset_invocation(
            self.decision
                .selected_account_id_hash
                .as_deref()
                .ok_or_else(super::invalid)?,
            &self.candidate.binding.credential_version.0,
            self.candidate.quota_reset_at_ms,
        )
    }
    pub fn check_deadline(&self, now: i64) -> Result<(), GatewayError> {
        if now < self.observed_at_ms
            || now - self.observed_at_ms > 30_000
            || self.decision.expires_at_ms <= now
            || self
                .credit
                .expires_at_ms
                .is_some_and(|expiry| expiry <= now)
        {
            return Err(super::declined("inventory_response_invalid_or_expired"));
        }
        Ok(())
    }
    pub fn consume_body(&self) -> Result<gateway_core::source_json::SourceJson, GatewayError> {
        #[derive(Serialize)]
        struct Body<'a> {
            redeem_request_id: &'a str,
            credit_id: &'a JsString16,
        }
        let invocation = self.invocation()?;
        gateway_core::source_json::SourceJson::from_serializable(&Body {
            redeem_request_id: &invocation.idempotency_key,
            credit_id: &self.credit.credit_id,
        })
    }
}

macro_rules! opaque_debug {
    ($($name:ty),+ $(,)?) => { $(impl std::fmt::Debug for $name {
        fn fmt(&self, formatter:&mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(concat!(stringify!($name), "([opaque])")) }
    })+ };
}
opaque_debug!(
    SourceResetCredit,
    SourceResetInventory,
    FullPoolResetPlan,
    AutomaticResetPermit,
    FullPoolPreparation,
    FullPoolEvaluation
);
