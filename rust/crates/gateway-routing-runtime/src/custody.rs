//! Data-only custody of the actual private routing journal. Never mints a runtime capability.
use crate::{
    journal::{self, Journal},
    types::CredentialFence,
};
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    provider::{PaidProvider, UpstreamProvider},
    state::{RecordKey, StoredRecord},
    tuple_key::TupleKey,
};
use std::collections::BTreeSet;

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Private routing journal custody is invalid.",
        "routing_journal_custody_invalid",
    )
}
fn text(value: &str) -> Result<(), GatewayError> {
    if value.trim().is_empty() {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn time(value: i64) -> Result<(), GatewayError> {
    if (0..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(invalid())
    }
}
fn hash(value: &str) -> Result<(), GatewayError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// Validate the complete current stored schema without returning a Journal,
/// admission or proof. Absolute expiry is checked, not renewed or interpreted as live.
pub fn validate_journal_row(key: &RecordKey, record: &StoredRecord) -> Result<(), GatewayError> {
    let value = record.json_value()?;
    text(&record.revision)?;
    TupleKey::from_record_key(key)?.validate_stored_key()?;
    let row: Journal = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    // Option/default fields and unknown nested members may not be silently lost
    // during private rollback. This is the current writer's full exact shape.
    if serde_json::to_value(&row).map_err(|_| invalid())? != *value
        || row.v != 1
        || journal::key(&row.context.request_id.0) != *key
    {
        return Err(invalid());
    }
    text(&row.context.request_id.0)?;
    text(&row.context.principal.0)?;
    text(&row.context.route)?;
    if let Some(key) = &row.context.key_id {
        text(&key.0)?;
    }
    hash(&row.input_digest)?;
    for value in [
        row.context.started_at_ms,
        row.updated_at_ms,
        row.lease_expires_at_ms,
    ] {
        time(value)?;
    }
    if row.updated_at_ms < row.context.started_at_ms
        || row.lease_expires_at_ms < row.context.started_at_ms
    {
        return Err(invalid());
    }
    let expected_expiry = if row.finished {
        Some(
            row.context
                .started_at_ms
                .checked_add(gateway_authority::PAID_RETENTION_MS)
                .ok_or_else(invalid)?,
        )
    } else {
        None
    };
    if record.expires_at_ms != expected_expiry {
        return Err(invalid());
    }
    if let Some(expiry) = expected_expiry {
        time(expiry)?;
    }
    if let Some(api) = &row.api {
        if row.context.key_id.as_ref() != Some(&api.key_id)
            || api.request_id != row.context.request_id
            || api.route != row.context.route
        {
            return Err(invalid());
        }
        text(&api.policy_version)?;
        time(api.window_start_ms)?;
        time(api.window_reset_at_ms)?;
    }
    if let Some(kernel) = &row.kernel {
        kernel.validate()?;
        if kernel.request_id != row.context.request_id || kernel.route != row.context.route {
            return Err(invalid());
        }
        text(&kernel.owner)?;
        for value in [
            kernel.window_created_at_ms,
            kernel.window_reset_at_ms,
            kernel.reserved_at_ms,
            kernel.lease_expires_at_ms,
        ] {
            time(value)?;
        }
        if let Some(value) = kernel.terminal_at_ms {
            time(value)?;
        }
    }
    let mut attempts = BTreeSet::new();
    for attempt in &row.attempts {
        text(&attempt.id)?;
        text(&attempt.model)?;
        if !attempts.insert(&attempt.id) || (attempt.known_not_started && attempt.transport_started)
        {
            return Err(invalid());
        }
        match &attempt.fence {
            CredentialFence::Direct { provider } => {
                if *provider != attempt.provider {
                    return Err(invalid());
                }
            }
            CredentialFence::Paid {
                provider,
                owner_id,
                owner_epoch,
                configuration_generation,
                credential_binding,
            } => {
                if *provider != attempt.provider
                    || !matches!(
                        provider,
                        UpstreamProvider::Surplus | UpstreamProvider::Metered
                    )
                {
                    return Err(invalid());
                }
                for value in [
                    owner_id,
                    owner_epoch,
                    configuration_generation,
                    credential_binding,
                ] {
                    text(value)?;
                }
            }
            CredentialFence::Codex {
                admission,
                source_key,
                source_revision,
                native_generation,
            } => {
                if attempt.provider != UpstreamProvider::ChatgptCodex
                    || admission.requested_model != attempt.model
                {
                    return Err(invalid());
                }
                TupleKey::from_record_key(source_key)?.validate_stored_key()?;
                if *source_key != gateway_auth::provider_credentials::codex_source_pool_key()
                    || admission.binding.pool_versionstamp.0 != *source_revision
                {
                    return Err(invalid());
                }
                for value in [
                    admission.binding.slot,
                    admission.binding.routing_generation,
                    admission.active_generation,
                ] {
                    time(i64::try_from(value).map_err(|_| invalid())?)?;
                }
                hash(&admission.binding.account_id_hash.0)?;
                hash(&admission.binding.credential_version.0)?;
                text(&admission.binding.pool_versionstamp.0)?;
                text(source_revision)?;
                hash(native_generation)?;
                if let Some(probe) = &admission.probe {
                    text(&probe.token)?;
                    time(probe.generation)?;
                    time(probe.expires_at_ms)?;
                }
            }
            CredentialFence::Claude {
                account_id,
                cohort_id,
                credential_fingerprint,
                evidence_generation,
                workspace_id,
                checks,
            } => {
                if attempt.provider != UpstreamProvider::ClaudeCode {
                    return Err(invalid());
                }
                for value in [
                    account_id,
                    cohort_id,
                    credential_fingerprint,
                    evidence_generation,
                ] {
                    text(value)?;
                }
                if let Some(value) = workspace_id {
                    text(value)?;
                }
                for check in checks {
                    TupleKey::from_record_key(&check.key)?.validate_stored_key()?;
                    if let Some(value) = &check.expected_revision {
                        text(value)?;
                    }
                }
            }
        }
        if let Some(paid) = &attempt.paid {
            let provider = match paid.provider {
                PaidProvider::Surplus => UpstreamProvider::Surplus,
                PaidProvider::Metered => UpstreamProvider::Metered,
            };
            if provider != attempt.provider || row.context.key_id.as_ref() != Some(&paid.key_id) {
                return Err(invalid());
            }
            text(&paid.request_id.0)?;
            text(&paid.attempt_id.0)?;
            for value in [
                paid.window_reset_at_ms,
                paid.created_at_ms,
                paid.reserved_microcredits,
            ] {
                time(value)?;
            }
        }
        if let Some(billing) = &attempt.billing {
            billing.to_usage()?;
            if !billing.quota.is_finite() || billing.quota < 0.0 {
                return Err(invalid());
            }
            time(billing.input)?;
            time(billing.output)?;
            if let Some(value) = billing.cached {
                time(value)?;
            }
            if let Some(value) = &billing.provider_request_id {
                text(value)?;
            }
            if let Some((attempt, cost)) = &billing.surplus {
                text(&attempt.0)?;
                if let Some(cost) = cost {
                    time(*cost)?;
                }
            }
        }
    }
    if row.active.as_ref().is_some_and(|id| !attempts.contains(id)) {
        return Err(invalid());
    }
    let mut nonces = BTreeSet::new();
    for child in &row.children {
        text(&child.nonce)?;
        text(&child.request_id)?;
        if !nonces.insert(&child.nonce) || (child.known_not_started && child.transport_started) {
            return Err(invalid());
        }
    }
    if let Some(dispatch) = &row.extras_dispatch {
        text(&dispatch.nonce)?;
    }
    for version in &row.refreshed_versions {
        text(version)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gateway_core::identity::{PrincipalId, RequestContext, RequestId};
    use serde_json::json;

    fn row(finished: bool) -> (RecordKey, StoredRecord) {
        let journal = Journal {
            v: 1,
            context: RequestContext {
                request_id: RequestId("custody-request".into()),
                principal: PrincipalId("fixture-principal".into()),
                key_id: None,
                route: "responses".into(),
                started_at_ms: 1_800_000_000_000,
            },
            input_digest: gateway_auth::crypto::sha256_hex(b"{}"),
            api: None,
            kernel: None,
            cursor: 0,
            attempts: vec![],
            active: None,
            model_sibling_retries: 0,
            refreshed_versions: vec![],
            recovery_attempted: false,
            claude_unavailable: false,
            semantic_committed: false,
            terminal_intent: finished.then(Default::default),
            finished,
            recovering: false,
            lease_expires_at_ms: 1_800_000_060_000,
            updated_at_ms: 1_800_000_000_000,
            extras_family: None,
            extras_child_count: None,
            extras_dispatch: None,
            children: vec![],
            kernel_override: None,
        };
        let expiry = finished
            .then_some(journal.context.started_at_ms + gateway_authority::PAID_RETENTION_MS);
        (
            journal::key(&journal.context.request_id.0),
            StoredRecord::json(
                "fixture-revision",
                serde_json::to_value(journal).unwrap(),
                expiry,
            ),
        )
    }

    #[test]
    fn exact_current_writer_shape_and_absolute_retention_roundtrip() {
        for finished in [false, true] {
            let (key, record) = row(finished);
            let original = record.clone();
            validate_journal_row(&key, &record).unwrap();
            assert_eq!(record, original);
        }
    }

    #[test]
    fn partial_unknown_or_mismatched_journal_is_not_silently_rewritten() {
        let (key, record) = row(false);
        for mutation in ["missing", "unknown", "nested", "digest", "identity"] {
            let mut bad = record.clone();
            match mutation {
                "missing" => {
                    bad.value.as_object_mut().unwrap().remove("api");
                }
                "unknown" => {
                    bad.value["caller_permission"] = json!(true);
                }
                "nested" => {
                    bad.value["context"]["caller_permission"] = json!(true);
                }
                "digest" => {
                    bad.value["input_digest"] = json!("partial");
                }
                _ => {
                    bad.value["context"]["request_id"] = json!("other");
                }
            }
            assert!(validate_journal_row(&key, &bad).is_err(), "{mutation}");
        }
        assert!(validate_journal_row(&journal::key("other"), &record).is_err());
    }

    #[test]
    fn custody_never_refreshes_or_accepts_wrong_finished_expiry() {
        for finished in [false, true] {
            let (key, mut record) = row(finished);
            record.expires_at_ms = if finished {
                record.expires_at_ms.map(|at| at + 1)
            } else {
                Some(1_800_000_060_000)
            };
            assert!(validate_journal_row(&key, &record).is_err());
        }
    }
}
