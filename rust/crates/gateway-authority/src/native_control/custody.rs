//! Data-only private rollback validation. Never authenticates, revives or mints an operation.
use super::{
    NativeRenewalContext, NativeRenewalFence,
    rows::{self, ActionRow, GenerationEffect, OperationRow, Phase, TerminalPublication, fail},
};
use gateway_core::{
    GatewayError,
    source_control::decode_source_control_record,
    source_serialization as source,
    state::{RecordKey, StoredRecord},
    tuple_key::{DecodedKeyPart, TupleKey},
};
use serde_json::Value;

pub(super) fn hash(value: &str) -> Result<(), GatewayError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(fail());
    }
    Ok(())
}
fn time(value: i64) -> Result<(), GatewayError> {
    crate::validate_time(value)
}
fn terminal(row: &TerminalPublication) -> Result<(), GatewayError> {
    for text in [
        &row.publication_revision,
        &row.source_revision,
        &row.normalized_revision,
    ] {
        crate::text(text)?;
    }
    for value in [
        &row.native_source_generation,
        &row.access_generation,
        &row.credential_version,
    ] {
        hash(value)?;
    }
    if let Some(value) = &row.publication_request_digest {
        hash(value)?;
    }
    Ok(())
}
fn fence(row: &NativeRenewalFence) -> Result<(), GatewayError> {
    if row.v != super::NATIVE_RENEWAL_FENCE_VERSION {
        return Err(fail());
    }
    for value in [
        &row.owner_id,
        &row.owner_epoch,
        &row.owner_revision,
        &row.native_owner_id,
        &row.source_revision,
        &row.normalized_revision,
        &row.original_request_id,
        &row.principal,
    ] {
        crate::text(value)?;
    }
    for value in [
        &row.account_id_hash,
        &row.credential_version,
        &row.source_native_generation,
        &row.access_generation,
        &row.principal_policy_digest,
    ] {
        hash(value)?;
    }
    if let Some(at) = row.access_expires_at_ms {
        time(at)?;
    }
    if let Some(value) = &row.native_refreshed_at {
        crate::text(value)?;
    }
    match &row.context {
        NativeRenewalContext::Inference {
            attempt_id,
            original_admission_digest,
            model,
            slot,
        } => {
            crate::text(attempt_id)?;
            // Source models are already selected nonblank JSON strings, not
            // bounded scalar authority identifiers. Whole signed frames retain
            // their protocol bounds; custody must not invent a model-only cap.
            if model
                .as_js_string()
                .sanitize_js_whitespace_prefix(1)
                .is_none()
            {
                return Err(fail());
            }
            hash(original_admission_digest)?;
            if *slot > gateway_core::identity::MAX_SAFE_INTEGER as u64 {
                return Err(fail());
            }
        }
        NativeRenewalContext::LiveCreate {
            binding,
            active_generation,
            ..
        } => {
            crate::routing::validate_binding(binding)?;
            if *active_generation == 0
                || *active_generation > gateway_core::identity::MAX_SAFE_INTEGER as u64
            {
                return Err(fail());
            }
        }
        NativeRenewalContext::LiveMapped {
            call_id,
            mapping_revision,
        } => {
            crate::text(call_id)?;
            crate::text(mapping_revision)?;
        }
        NativeRenewalContext::CacheExperiment { context } => {
            context.target.validate()?;
            if context.v != 1
                || context.slot != 1
                || !(1..=3).contains(&context.cycle)
                || !crate::cache_experiment::release_valid(&context.release_git_sha)
            {
                return Err(fail());
            }
            for value in [
                &context.campaign_owner,
                &context.cycle_owner,
                &context.source_pool_revision,
                &context.state_revision,
                &context.cycle_lease_revision,
                &context.campaign_lease_revision,
            ] {
                crate::text(value)?;
            }
            for (index, sample) in context.prefix.iter().enumerate() {
                if !sample.valid(index) {
                    return Err(fail());
                }
            }
        }
    }
    Ok(())
}
pub(super) fn actor_shape(raw: &Value) -> Result<(), GatewayError> {
    let Some(fields) = raw.as_object() else {
        return Err(fail());
    };
    if fields.len() != 9
        || raw["v"] != 1
        || raw["principal"].as_str().is_none_or(|s| s.is_empty())
        || ![
            "owner_revision",
            "config_revision",
            "runtime_revision",
            "source_valid_until_ms",
        ]
        .iter()
        .all(|k| fields.contains_key(*k))
    {
        return Err(fail());
    }
    hash(raw["config_digest"].as_str().ok_or_else(fail)?)?;
    let source = raw["source"].as_object().ok_or_else(fail)?;
    let expected = match raw["source"]["kind"].as_str() {
        Some("api_key") => 6,
        Some("session") => 7,
        Some("configuration") => 4,
        Some("kernel") => 11,
        _ => return Err(fail()),
    };
    if source.len() != expected {
        return Err(fail());
    }
    Ok(())
}

/// Accept only exact current custody schemas; v1 generation-effect keys remain unchanged.
/// No actor authentication/current-row lookup, native I/O, permission object or schema upgrade.
pub fn validate_native_control_custody(
    key: &RecordKey,
    record: &StoredRecord,
) -> Result<(), GatewayError> {
    record.validate_version()?;
    crate::text(&record.revision)?;
    if record.expires_at_ms.is_some() {
        return Err(fail());
    }
    let parts = TupleKey::from_record_key(key)?.decoded_parts()?;
    let strings = parts
        .into_iter()
        .map(|part| match part {
            DecodedKeyPart::String(bytes) => String::from_utf8(bytes).map_err(|_| fail()),
            _ => Err(fail()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if strings.len() != 6 || strings[..4] != ["uos_ai", "authority", "native_owner_renewal", "v1"] {
        return Err(fail());
    }
    let kind = &strings[4];
    let id = &strings[5];
    crate::text(id)?;
    if rows::key(kind, id) != *key {
        return Err(fail());
    }
    match kind.as_str() {
        "action" => {
            let value = decode_source_control_record(record)?;
            if source::member(&value, "kind").is_some() {
                return super::import::validate_custody(&value, id);
            }
            let row: ActionRow = value.deserialize().map_err(|_| fail())?;
            if row.v != 2 || row.action_ref != *id || row.fence.principal != row.actor.principal() {
                return Err(fail());
            }
            hash(id)?;
            fence(&row.fence)?;
            let actor = source::member(&value, "actor")
                .ok_or_else(fail)?
                .deserialize::<Value>()
                .map_err(|_| fail())?;
            actor_shape(&actor)?;
            time(row.created_at_ms)?;
            time(row.deadline_ms)?;
            if row.deadline_ms <= row.created_at_ms
                || row.deadline_ms > crate::add(row.created_at_ms, super::OWNER_RENEWAL_MAX_MS)?
            {
                return Err(fail());
            }
            hash(&row.checks_digest)?;
            hash(&row.control_checks_digest)?;
            for value in &row.account_digests {
                hash(value)?;
            }
            if row.account_digests.is_empty() {
                return Err(fail());
            }
            if let Some(operation) = &row.operation_id {
                crate::text(operation)?;
            }
        }
        "operation" => {
            let value = record.json_value()?;
            let row: OperationRow = serde_json::from_value(value.clone()).map_err(|_| fail())?;
            if row.v != 1 || row.operation_id != *id {
                return Err(fail());
            }
            hash(&row.action_ref)?;
            crate::text(&row.claim_ref)?;
            hash(&row.request_digest)?;
            hash(&row.start_digest)?;
            if let Some(value) = &row.publication_revision {
                crate::text(value)?;
            }
            for value in [&row.native_source_generation, &row.access_generation]
                .into_iter()
                .flatten()
            {
                hash(value)?;
            }
            if let Some(value) = &row.terminal {
                terminal(value)?;
                if row.publication_revision.as_ref() != Some(&value.publication_revision) {
                    return Err(fail());
                }
            } else if row.phase == Phase::Published {
                return Err(fail());
            }
        }
        "generation" => {
            let value = record.json_value()?;
            let row: GenerationEffect =
                serde_json::from_value(value.clone()).map_err(|_| fail())?;
            if row.v != 1 {
                return Err(fail());
            }
            hash(id)?;
            crate::text(&row.operation_id)?;
            crate::text(&row.claim_ref)?;
            if let Some(value) = &row.publication_revision {
                crate::text(value)?;
            }
            if let Some(value) = &row.terminal {
                terminal(value)?;
                if row.publication_revision.as_ref() != Some(&value.publication_revision) {
                    return Err(fail());
                }
            }
        }
        _ => return Err(fail()),
    }
    Ok(())
}
