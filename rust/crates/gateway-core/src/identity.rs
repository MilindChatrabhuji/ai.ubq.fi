use serde::{Deserialize, Serialize};

macro_rules! opaque_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
    };
}

opaque_id!(RequestId);
opaque_id!(PaidAttemptId);
opaque_id!(PrincipalId);
opaque_id!(ApiKeyId);
opaque_id!(PoolVersionstamp);

// These are source-proven opaque digests, not raw credentials. They are intentionally
// different types: the administrative/selection hash and salted routing hash differ.
opaque_id!(SubscriptionSelectionHash);
opaque_id!(RoutingAccountHash);
opaque_id!(CredentialVersion);

pub type UnixMillis = i64;

/// Account-generation fence from RoutingAccount and CodexActiveAccountSelection.
/// The native owner supplies the credential version; WASM must not substitute a new recipe.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AccountBinding {
    pub account_id_hash: RoutingAccountHash,
    pub credential_version: CredentialVersion,
    pub pool_versionstamp: PoolVersionstamp,
    pub slot: u64,
    pub routing_generation: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActiveTransitionReason {
    QuotaExhausted,
    CredentialInvalid,
    AccountRemovedOrReplaced,
    ModelUnavailable,
}

/// Version 1 shape mirrors the existing durable active-account record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ActiveSelection {
    pub v: u32,
    #[serde(flatten)]
    pub binding: AccountBinding,
    pub generation: u64,
    pub transition_reason: Option<ActiveTransitionReason>,
    pub updated_at_ms: UnixMillis,
}

/// One client correlation survives all provider attempts and paid hops.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RequestContext {
    pub request_id: RequestId,
    pub principal: PrincipalId,
    pub key_id: Option<ApiKeyId>,
    pub route: String,
    pub started_at_ms: UnixMillis,
}

/// Paid attempt correlation never replaces the admitted request's original request_id.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PaidAttemptIdentity {
    pub request_id: RequestId,
    pub paid_attempt_id: PaidAttemptId,
    pub provider: crate::provider::PaidProvider,
}

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Source counters use exact JavaScript safe integers; preserve their range in portable JSON.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "i64", into = "i64")]
pub struct Microcredits(i64);

impl TryFrom<i64> for Microcredits {
    type Error = &'static str;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        if (0..=MAX_SAFE_INTEGER).contains(&value) {
            Ok(Self(value))
        } else {
            Err("microcredits must be a non-negative safe integer")
        }
    }
}

impl From<Microcredits> for i64 {
    fn from(value: Microcredits) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MicrocreditLimit {
    Unlimited,
    Bounded(Microcredits),
}

impl TryFrom<i64> for MicrocreditLimit {
    type Error = &'static str;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        match value {
            -1 => Ok(Self::Unlimited),
            1..=MAX_SAFE_INTEGER => Ok(Self::Bounded(Microcredits::try_from(value)?)),
            _ => Err("a paid limit must be -1 or a positive safe integer"),
        }
    }
}
