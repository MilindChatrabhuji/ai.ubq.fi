//! Reset records, immutable identities and pure credit selection.
use crate::reset::hash;
use crate::routing::{AdmittedAccount, CohortProof};
use crate::{nonnegative, text, unavailable};
use gateway_core::GatewayError;
use gateway_core::identity::AccountBinding;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    Disabled,
    Shadow,
    Live,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetConfig {
    pub enabled: bool,
    pub mode: ResetMode,
    pub max_per_account_per_day: i64,
    pub max_per_account_per_window: i64,
    pub provider_approved: bool,
    pub supports_idempotent_lookup: bool,
    pub redeem_outcome_is_final: bool,
}

impl Default for ResetConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            mode: ResetMode::Live,
            // An absent configuration must never authorize an external spend.
            max_per_account_per_day: 0,
            max_per_account_per_window: 1,
            provider_approved: true,
            supports_idempotent_lookup: false,
            redeem_outcome_is_final: true,
        }
    }
}

impl ResetConfig {
    pub(crate) fn live_reason(&self) -> Option<&'static str> {
        if !self.enabled {
            Some("feature_disabled")
        } else if self.mode != ResetMode::Live {
            Some("mode_not_live")
        } else if self.max_per_account_per_day != 1 {
            Some("per_account_day_limit_invalid")
        } else if self.max_per_account_per_window != 1 {
            Some("per_account_window_limit_invalid")
        } else if !self.provider_approved
            || !(self.supports_idempotent_lookup || self.redeem_outcome_is_final)
        {
            Some("provider_contract_unproven")
        } else {
            None
        }
    }
}

#[derive(Clone, Debug)]
pub struct ResetCandidate {
    pub binding: AccountBinding,
    pub quota_reset_at_ms: i64,
    pub request_started_at_ms: i64,
    pub proof: CohortProof,
}

/// Existing-ledger-only preflight; none of these outcomes authorizes credit use.
#[derive(Debug)]
pub enum FullPoolResetReconciliation {
    NoExisting,
    Blocked { reason: String },
    Recovered(AdmittedAccount),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetIdentity {
    pub account_id_hash: String,
    pub credential_version: String,
    pub quota_generation: String,
    pub idempotency_key_hash: String,
}

/// The raw provider idempotency key is returned only to the approved native provider boundary.
/// It is never included in a stored redemption record.
#[derive(Clone, Debug)]
pub struct ResetInvocation {
    pub identity: ResetIdentity,
    pub idempotency_key: String,
}

pub fn reset_invocation(
    admin_account_hash: &str,
    credential_version: &str,
    reset: i64,
) -> Result<ResetInvocation, GatewayError> {
    text(admin_account_hash)?;
    text(credential_version)?;
    nonnegative(reset)?;
    let credential_version = format!(
        "v1:{}",
        hash(&format!(
            "uos_ai\0codex_reset_credential_version\0{credential_version}"
        ))
    );
    let quota_generation = format!(
        "v1:{}",
        hash(&format!(
            "uos_ai\0codex_reset_generation\0{admin_account_hash}\0{reset}"
        ))
    );
    let idempotency_key = format!(
        "uos_ai_codex_reset_v1_{}",
        hash(&format!(
            "uos_ai\0codex_reset_idempotency\0{admin_account_hash}\0{quota_generation}"
        ))
    );
    let identity = ResetIdentity {
        account_id_hash: admin_account_hash.to_owned(),
        credential_version,
        quota_generation,
        idempotency_key_hash: hash(&idempotency_key),
    };
    Ok(ResetInvocation {
        identity,
        idempotency_key,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetState {
    Claimed,
    Submitted,
    Unknown,
    Verified,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetRecord {
    pub v: u32,
    #[serde(flatten)]
    pub identity: ResetIdentity,
    pub routing_generation: u64,
    pub state: ResetState,
    pub owner_token: String,
    pub fence: u64,
    pub lease_expires_at_ms: i64,
    pub provider_receipt_id: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub submitted_at_ms: Option<i64>,
    pub verified_at_ms: Option<i64>,
    pub last_error_code: Option<String>,
}

#[derive(Clone, Debug)]
pub enum ResetClaim {
    Submit {
        record: ResetRecord,
        invocation: ResetInvocation,
    },
    Reconcile {
        record: ResetRecord,
        invocation: ResetInvocation,
    },
    InProgress(ResetRecord),
    Verified(ResetRecord),
    Rejected(ResetRecord),
    Disabled(&'static str),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AccountDayBudget {
    pub v: u32,
    pub day: String,
    pub submission_count: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetCredit {
    pub credit_id: String,
    pub expires_at_ms: Option<i64>,
    pub observed_at_ms: i64,
    pub eligible: bool,
}

#[derive(Clone, Debug)]
pub struct AccountResetInventory {
    pub binding: AccountBinding,
    pub observed_at_ms: i64,
    pub credits: Vec<ResetCredit>,
}

#[derive(Clone, Debug)]
pub struct SelectedResetCredit {
    pub binding: AccountBinding,
    pub credit: ResetCredit,
}

/// Complete typed inventory observations come from the approved native provider boundary.
/// Any malformed/stale observation invalidates this pool decision; no credit is fabricated.
pub fn select_reset_credit(
    inventories: &[AccountResetInventory],
    now: i64,
) -> Result<Option<SelectedResetCredit>, GatewayError> {
    nonnegative(now)?;
    let mut candidates = Vec::new();
    for inventory in inventories {
        if inventory.observed_at_ms < 0
            || inventory.observed_at_ms > now
            || now - inventory.observed_at_ms > 30_000
        {
            return Err(unavailable(
                "inventory_response_invalid_or_expired",
                "Reset pool inventory is stale.",
            ));
        }
        for credit in &inventory.credits {
            text(&credit.credit_id)?;
            if credit.eligible
                && credit.observed_at_ms <= now
                && now - credit.observed_at_ms <= 30_000
                && credit.expires_at_ms.is_none_or(|expiry| expiry > now)
            {
                candidates.push(SelectedResetCredit {
                    binding: inventory.binding.clone(),
                    credit: credit.clone(),
                });
            }
        }
    }
    candidates.sort_by(|left, right| {
        left.credit
            .expires_at_ms
            .unwrap_or(i64::MAX)
            .cmp(&right.credit.expires_at_ms.unwrap_or(i64::MAX))
            .then_with(|| left.binding.slot.cmp(&right.binding.slot))
            .then_with(|| left.credit.credit_id.cmp(&right.credit.credit_id))
    });
    Ok(candidates.into_iter().next())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetShadow {
    pub v: u32,
    pub episode_hash: String,
    pub account_id_hash: String,
    pub quota_generation: String,
    pub selected_credit_id_hash: String,
    pub credit_expires_at_ms: Option<i64>,
    pub observed_at_ms: i64,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub armed_at_ms: Option<i64>,
}
