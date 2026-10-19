use super::NativeRenewalFence;
use gateway_core::{
    GatewayError,
    state::RecordKey,
    tuple_key::{ScalarKeyPart, TupleKey},
};
use serde::{Deserialize, Serialize};

pub(super) fn key(kind: &str, id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("authority"),
        ScalarKeyPart::String("native_owner_renewal"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String(kind),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}

pub(super) fn session_key(id: &str) -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("routing_runtime"),
        ScalarKeyPart::String("v1"),
        ScalarKeyPart::String("session"),
        ScalarKeyPart::String(id),
    ])
    .to_record_key()
}

pub(super) fn prefix() -> RecordKey {
    TupleKey::from_scalar_parts(&[
        ScalarKeyPart::String("uos_ai"),
        ScalarKeyPart::String("authority"),
        ScalarKeyPart::String("native_owner_renewal"),
        ScalarKeyPart::String("v1"),
    ])
    .to_record_key()
}

pub(super) fn fail() -> GatewayError {
    GatewayError::unavailable(
        "Native renewal authority is missing, stale, or unavailable.",
        "native_renewal_authority_unavailable",
    )
}
pub(super) fn conflict() -> GatewayError {
    GatewayError::new(
        409,
        "Native renewal operation conflicts with current authority.",
        Some("native_renewal_conflict"),
    )
}

pub(super) use super::actor::StoredNativeActor as Actor;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ActionRow {
    pub v: u8,
    pub action_ref: String,
    pub actor: Actor,
    pub created_at_ms: i64,
    pub deadline_ms: i64,
    pub fence: NativeRenewalFence,
    pub checks_digest: String,
    pub control_checks_digest: String,
    pub account_digests: Vec<String>,
    pub operation_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Phase {
    Claimed,
    Started,
    Unknown,
    Published,
}

/// One fixed native source generation can start at most one refresh across all original requests.
/// This marker is retained after uncertainty; it is not a routing/accounting ledger or a lease.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct GenerationEffect {
    pub v: u8,
    pub operation_id: String,
    pub claim_ref: String,
    pub publication_revision: Option<String>,
    pub terminal: Option<TerminalPublication>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TerminalPublication {
    pub publication_revision: String,
    pub source_revision: String,
    pub normalized_revision: String,
    pub native_source_generation: String,
    pub access_generation: String,
    pub credential_version: String,
    pub publication_request_digest: Option<String>,
}

pub(super) fn generation_key(fence: &NativeRenewalFence) -> Result<RecordKey, GatewayError> {
    Ok(key(
        "generation",
        &super::facts::digest(&(
            "uos-native-renewal-generation-v1",
            &fence.native_owner_id,
            &fence.account_id_hash,
            &fence.source_native_generation,
        ))?,
    ))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OperationRow {
    pub v: u8,
    pub action_ref: String,
    pub operation_id: String,
    pub request_digest: String,
    pub claim_ref: String,
    pub start_digest: String,
    pub phase: Phase,
    pub publication_revision: Option<String>,
    pub native_source_generation: Option<String>,
    pub access_generation: Option<String>,
    pub terminal: Option<TerminalPublication>,
}
