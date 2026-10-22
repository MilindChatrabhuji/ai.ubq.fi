//! Trusted candidate composition. These values are never read from a request.
//! Secret metadata is verified by deployment receipts; no variable fallback exists.
use gateway_auth::{
    crypto::{base64url, decode_base64url},
    native_auth::{NativeCapability, NativeTransportIdentity},
};
use gateway_authority::initial_control_owner::{
    InitialAdoptionBinding, InitialControlOwnerDeployment, InitialNativeCustodyBinding,
};
use gateway_core::GatewayError;
use serde::Deserialize;
use std::collections::BTreeSet;
use worker::Env;

pub(crate) const NATIVE_BINDING: &str = "UOS_CANDIDATE_NATIVE_V1";
pub(crate) const INSTALL_SEAL_BINDING: &str = "UOS_CANDIDATE_INITIAL_SEAL_V1";
const CONFIG_MAX_BYTES: usize = 16_384;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeConfiguration {
    v: u32,
    role: String,
    origin: String,
    key_id: String,
    owner_id: String,
    owner_epoch: String,
    key_base64url: String,
}

pub(crate) struct CandidateNativeConfiguration {
    origin: String,
    identity: NativeTransportIdentity,
}

impl CandidateNativeConfiguration {
    fn parse(raw: &str) -> Result<Self, GatewayError> {
        if raw.len() > CONFIG_MAX_BYTES {
            return Err(refused());
        }
        let config: NativeConfiguration = serde_json::from_str(raw).map_err(|_| refused())?;
        let key = decode_base64url(&config.key_base64url).map_err(|_| refused())?;
        if config.v != 1
            || config.role != "readonly_live"
            || config.origin.len() > 4096
            || key.len() != 32
            || base64url(&key) != config.key_base64url
        {
            return Err(refused());
        }
        let identity = NativeTransportIdentity::new(
            config.key_id,
            config.owner_id,
            config.owner_epoch,
            key.try_into().map_err(|_| refused())?,
            BTreeSet::from([
                NativeCapability::SupervisorRead,
                NativeCapability::LiveSideband,
            ]),
        )
        .map_err(|_| refused())?;
        let result = Self {
            origin: config.origin,
            identity,
        };
        // Validate the exact existing HTTPS carrier contract before accepting config.
        result.bindings()?;
        Ok(result)
    }

    pub(crate) fn bindings(&self) -> Result<crate::NativeBindings, GatewayError> {
        crate::NativeBindings::configured_https(&self.origin, self.identity.clone())
            .map_err(|_| refused())
    }
}

/// Absence leaves this candidate binding unavailable, so the ordinary entrypoint
/// may consult the separate exact `UOS_NATIVE_CARRIER` binding. A present malformed
/// candidate binding never falls back to that carrier, a variable or another identity.
pub(crate) fn native(env: &Env) -> Result<Option<CandidateNativeConfiguration>, GatewayError> {
    secret(env, NATIVE_BINDING)?
        .map(|raw| CandidateNativeConfiguration::parse(&raw))
        .transpose()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedReadonlyOwner {
    owner_id: String,
    owner_epoch: String,
    key_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CustodySeal {
    account_id_hash: String,
    native_source_generation: String,
    access_generation: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdoptionSeal {
    worker_git_sha: String,
    worker_git_tree: String,
    authority_namespace_id: String,
    authority_object_id: String,
    capture_id: String,
    source_git_sha: String,
    source_native_version: String,
    source_native_sequence: String,
    source_pool_revision: String,
    normalized_pool_revision: String,
    custody: Vec<CustodySeal>,
    custody_observed_at_ms: i64,
    valid_through_ms: i64,
    owner_revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallationSeal {
    v: u32,
    payload_sha256: String,
    expected_readonly_owner: ExpectedReadonlyOwner,
    adoption: AdoptionSeal,
}

fn parse_seal(
    raw: &str,
    identity: &NativeTransportIdentity,
) -> Result<InitialControlOwnerDeployment, GatewayError> {
    if raw.len() > CONFIG_MAX_BYTES {
        return Err(refused());
    }
    let seal: InstallationSeal = serde_json::from_str(raw).map_err(|_| refused())?;
    if seal.v != 1
        || seal.expected_readonly_owner.owner_id != identity.owner_id()
        || seal.expected_readonly_owner.owner_epoch != identity.owner_epoch()
        || seal.expected_readonly_owner.key_fingerprint != identity.key_fingerprint()
    {
        return Err(refused());
    }
    let adoption = seal.adoption;
    InitialControlOwnerDeployment::configured(
        identity,
        InitialAdoptionBinding {
            worker_git_sha: adoption.worker_git_sha,
            worker_git_tree: adoption.worker_git_tree,
            authority_namespace_id: adoption.authority_namespace_id,
            authority_object_id: adoption.authority_object_id,
            capture_id: adoption.capture_id,
            source_git_sha: adoption.source_git_sha,
            source_native_version: adoption.source_native_version,
            source_native_sequence: adoption.source_native_sequence,
            source_pool_revision: adoption.source_pool_revision,
            normalized_pool_revision: adoption.normalized_pool_revision,
            custody: adoption
                .custody
                .into_iter()
                .map(|custody| InitialNativeCustodyBinding {
                    account_id_hash: custody.account_id_hash,
                    native_source_generation: custody.native_source_generation,
                    access_generation: custody.access_generation,
                })
                .collect(),
            custody_observed_at_ms: adoption.custody_observed_at_ms,
            valid_through_ms: adoption.valid_through_ms,
            owner_revision: adoption.owner_revision,
        },
        seal.payload_sha256,
    )
    .map_err(|_| refused())
}

/// Called only by the named private installer, never ordinary public fetch.
pub(crate) fn initial_deployment(env: &Env) -> Result<InitialControlOwnerDeployment, GatewayError> {
    let native = native(env)?.ok_or_else(refused)?;
    let raw = secret(env, INSTALL_SEAL_BINDING)?.ok_or_else(refused)?;
    parse_seal(&raw, &native.identity)
}

fn secret(env: &Env, name: &str) -> Result<Option<String>, GatewayError> {
    use worker::{js_sys::Reflect, wasm_bindgen::JsValue};
    let raw = Reflect::get(env.as_ref(), &JsValue::from_str(name)).map_err(|_| refused())?;
    if raw.is_undefined() {
        return Ok(None);
    }
    env.secret(name)
        .map(|value| Some(value.to_string()))
        .map_err(|_| refused())
}

fn refused() -> GatewayError {
    GatewayError::unavailable(
        "The private candidate configuration is unavailable",
        "candidate_configuration_unavailable",
    )
}

#[cfg(test)]
#[path = "candidate_bindings_tests.rs"]
mod tests;
