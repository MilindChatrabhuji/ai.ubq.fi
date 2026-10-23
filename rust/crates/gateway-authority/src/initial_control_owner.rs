//! Initial installation by the private account operator, never native MAC publication.
//! The deployment seal is produced after independent local physical custody checks.
//! Neither a signed identity nor a captured row can construct installation authority.
use gateway_auth::{crypto::sha256_hex, native_auth::NativeTransportIdentity};
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    state::{AtomicTransition, RecordMutation, RevisionCheck, StoredRecord},
};
use serde::Serialize;
use std::collections::BTreeSet;

use crate::{keys, paid_control::PaidControlOwner};

pub const INITIAL_AUTHORITY_BINDING: &str = "AUTHORITY";
pub const INITIAL_AUTHORITY_OBJECT: &str = "gateway-authority-v1";

/// Local producer attestation, not account selectors or a Worker physical read.
/// The physical generation is verified locally before the sealed RPC is launched.
/// There is deliberately no request deserializer for this deployment seal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitialNativeCustodyBinding {
    pub account_id_hash: String,
    pub native_source_generation: String,
    pub access_generation: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitialAdoptionBinding {
    pub worker_git_sha: String,
    pub worker_git_tree: String,
    pub authority_namespace_id: String,
    pub authority_object_id: String,
    pub capture_id: String,
    pub source_git_sha: String,
    pub source_native_version: String,
    pub source_native_sequence: String,
    pub source_pool_revision: String,
    pub normalized_pool_revision: String,
    pub custody: Vec<InitialNativeCustodyBinding>,
    pub custody_observed_at_ms: i64,
    pub valid_through_ms: i64,
    pub owner_revision: String,
}

/// Access-only facts independently reconstructed by the typed migration consumer.
/// No Worker build, namespace, physical custody or owner authority comes from these.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitialAdoptionAccountFacts {
    pub account_id_hash: String,
    /// Generation marker in the adopted source's access-only ownership projection.
    pub projection_generation: String,
    /// Generation recomputed from the adopted account and access-only credentials.
    pub access_generation: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitialAdoptionFacts {
    pub capture_id: String,
    pub source_git_sha: String,
    /// Exact source capture clock. It cannot follow the sealed local custody observation.
    pub source_captured_at_ms: i64,
    pub source_native_version: String,
    pub source_native_sequence: String,
    pub source_pool_revision: String,
    pub normalized_pool_revision: String,
    pub accounts: Vec<InitialAdoptionAccountFacts>,
}

/// Trusted private deployment composition only. Never construct from RPC JSON.
/// The operator must publish the exact seal emitted by actual local custody
/// preparation, rather than computing a seal from an unverified capture.
pub struct InitialControlOwnerDeployment {
    binding: InitialAdoptionBinding,
    payload_sha256: String,
    owner: PaidControlOwner,
}

impl InitialControlOwnerDeployment {
    pub fn configured(
        readonly_identity: &NativeTransportIdentity,
        binding: InitialAdoptionBinding,
        payload_sha256: String,
    ) -> Result<Self, GatewayError> {
        validate_binding(&binding)?;
        if !hex(&payload_sha256, 64) {
            return Err(refused());
        }
        Ok(Self {
            binding,
            payload_sha256,
            owner: PaidControlOwner {
                v: 1,
                owner_id: readonly_identity.owner_id().into(),
                owner_epoch: readonly_identity.owner_epoch().into(),
                key_fingerprint: readonly_identity.key_fingerprint().into(),
            },
        })
    }

    /// Exact payload binding is required before decoding the private capture.
    /// The actual object ID comes from the real namespace's fixed-name lookup.
    /// This validates the trusted local attestation's binding and lifetime; it
    /// does not observe native files or claim current physical custody at runtime.
    pub fn prepare(
        &self,
        payload: &[u8],
        actual_git_sha: &str,
        actual_git_tree: &str,
        actual_authority_object_id: &str,
        now_ms: i64,
    ) -> Result<PreparedInitialControlOwner, GatewayError> {
        if payload.is_empty()
            || sha256_hex(payload) != self.payload_sha256
            || actual_git_sha != self.binding.worker_git_sha
            || actual_git_tree != self.binding.worker_git_tree
            || actual_authority_object_id != self.binding.authority_object_id
            || now_ms < self.binding.custody_observed_at_ms
            || now_ms > self.binding.valid_through_ms
        {
            return Err(refused());
        }
        Ok(PreparedInitialControlOwner {
            binding: self.binding.clone(),
            owner: self.owner.clone(),
        })
    }
}

/// Opaque, nonserializable capability for exactly one fixed initial owner row.
/// ```compile_fail
/// use gateway_authority::initial_control_owner::PreparedInitialControlOwner;
/// let forged: PreparedInitialControlOwner = serde_json::from_str("{}").unwrap();
/// ```
pub struct PreparedInitialControlOwner {
    binding: InitialAdoptionBinding,
    owner: PaidControlOwner,
}

impl PreparedInitialControlOwner {
    /// Compare only facts genuinely reconstructed from validated PreparedAdoption.
    /// Local physical custody remains a separate producer attestation. In a
    /// sanitized capture both projected and recomputed access generations must
    /// equal the sealed access generation, not its physical native generation.
    pub fn require_adoption_facts(
        &self,
        actual: &InitialAdoptionFacts,
        now_ms: i64,
    ) -> Result<(), GatewayError> {
        if actual.capture_id != self.binding.capture_id
            || actual.source_git_sha != self.binding.source_git_sha
            || !(0..=MAX_SAFE_INTEGER).contains(&actual.source_captured_at_ms)
            || actual.source_captured_at_ms > self.binding.custody_observed_at_ms
            || actual.source_native_version != self.binding.source_native_version
            || actual.source_native_sequence != self.binding.source_native_sequence
            || actual.source_pool_revision != self.binding.source_pool_revision
            || actual.normalized_pool_revision != self.binding.normalized_pool_revision
            || actual.accounts.len() != self.binding.custody.len()
            || actual
                .accounts
                .iter()
                .zip(&self.binding.custody)
                .any(|(account, expected)| {
                    account.account_id_hash != expected.account_id_hash
                        || account.projection_generation != expected.access_generation
                        || account.access_generation != expected.access_generation
                })
            || now_ms < self.binding.custody_observed_at_ms
            || now_ms > self.binding.valid_through_ms
        {
            return Err(refused());
        }
        Ok(())
    }

    /// Only the typed empty-adoption seam calls this. All adoption and owner
    /// writes remain one CAS; this method performs no I/O or independent commit.
    pub fn bind_empty_adoption(
        &self,
        transition: &mut AtomicTransition,
    ) -> Result<(), GatewayError> {
        let owner_key = keys::paid_control_owner();
        let mut checked = BTreeSet::new();
        if transition.checks.is_empty()
            || transition.mutations.is_empty()
            || transition.checks.iter().any(|check| {
                check.expected_revision.is_some()
                    || check.key == owner_key
                    || !checked.insert(check.key.0.clone())
            })
            || transition.mutations.iter().any(|mutation| match mutation {
                RecordMutation::Put { key, .. } => key == &owner_key || !checked.remove(&key.0),
                RecordMutation::Delete { .. } => true,
            })
            || !checked.is_empty()
        {
            return Err(refused());
        }
        let value = serde_json::to_value(&self.owner).map_err(|_| refused())?;
        transition.checks.push(RevisionCheck {
            key: owner_key.clone(),
            expected_revision: None,
        });
        transition.mutations.push(RecordMutation::Put {
            key: owner_key,
            record: StoredRecord::json(&self.binding.owner_revision, value, None),
        });
        Ok(())
    }

    /// Matching reconciliation never rotates, replaces or rewrites the row.
    /// The migration consumer additionally checks its exact manifest/source facts.
    pub fn matches_current_owner(&self, row: Option<&StoredRecord>) -> bool {
        row.is_some_and(|row| {
            row.revision == self.binding.owner_revision
                && row.expires_at_ms.is_none()
                && serde_json::to_value(&self.owner)
                    .is_ok_and(|expected| row.json_value().is_ok_and(|actual| actual == &expected))
        })
    }

    pub fn receipt(&self) -> InitialControlOwnerReceipt {
        InitialControlOwnerReceipt {
            v: 1,
            worker_git_sha: self.binding.worker_git_sha.clone(),
            worker_git_tree: self.binding.worker_git_tree.clone(),
            authority_namespace_id: self.binding.authority_namespace_id.clone(),
            authority_object_id: self.binding.authority_object_id.clone(),
            capture_id: self.binding.capture_id.clone(),
            owner_id: self.owner.owner_id.clone(),
            owner_epoch: self.owner.owner_epoch.clone(),
            key_fingerprint: self.owner.key_fingerprint.clone(),
            owner_revision: self.binding.owner_revision.clone(),
        }
    }
}

#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct InitialControlOwnerReceipt {
    pub v: u32,
    pub worker_git_sha: String,
    pub worker_git_tree: String,
    pub authority_namespace_id: String,
    pub authority_object_id: String,
    pub capture_id: String,
    pub owner_id: String,
    pub owner_epoch: String,
    pub key_fingerprint: String,
    pub owner_revision: String,
}

fn validate_binding(binding: &InitialAdoptionBinding) -> Result<(), GatewayError> {
    let decimal = |value: &str| {
        value
            .parse::<i64>()
            .ok()
            .is_some_and(|number| number >= 0 && number.to_string() == value)
    };
    let opaque = |value: &str| !value.trim().is_empty() && value.len() <= 4096;
    let mut accounts = BTreeSet::new();
    if !hex(&binding.worker_git_sha, 40)
        || !hex(&binding.worker_git_tree, 40)
        || !hex(&binding.source_git_sha, 40)
        || !hex(&binding.capture_id, 64)
        || !hex(&binding.authority_namespace_id, 32)
        || !hex(&binding.authority_object_id, 64)
        || !decimal(&binding.source_native_version)
        || !decimal(&binding.source_native_sequence)
        || !opaque(&binding.source_pool_revision)
        || !opaque(&binding.normalized_pool_revision)
        || !opaque(&binding.owner_revision)
        || !(1..=2).contains(&binding.custody.len())
        || binding.custody.iter().any(|custody| {
            !hex(&custody.account_id_hash, 64)
                || !hex(&custody.native_source_generation, 64)
                || !hex(&custody.access_generation, 64)
                || !accounts.insert(custody.account_id_hash.clone())
        })
        || !(0..=MAX_SAFE_INTEGER).contains(&binding.custody_observed_at_ms)
        || binding.valid_through_ms < binding.custody_observed_at_ms
        || binding.valid_through_ms > MAX_SAFE_INTEGER
    {
        return Err(refused());
    }
    Ok(())
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn refused() -> GatewayError {
    GatewayError::unavailable(
        "The private initial control installation was refused",
        "initial_control_owner_refused",
    )
}

#[cfg(test)]
mod tests;
