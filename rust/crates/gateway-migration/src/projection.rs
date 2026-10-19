use crate::*;
use gateway_authority::{paid::*, quota::*};
use gateway_core::{lifecycle::BillingState, value::PortableValue};
use serde_json::json;

pub(crate) fn forward(row: &mut Row) -> Result<(), GatewayError> {
    if crate::paid_controls::forward(row)? {
        return Ok(());
    }
    if crate::source_metadata::retain_raw(row)? {
        return Ok(());
    }
    let p = &row.parts;
    if starts(p, &["uos_ai", "codex_reset_shadow_decision"]) {
        gateway_authority::full_pool_reset::FullPoolShadowDecision::validate_record(
            &row.key,
            &row.record,
        )?;
        return Ok(());
    }
    if starts(p, &["ubq_ai", "codex_catalog_chunk"])
        || starts(p, &["ubq_ai", "codex_catalog_source_chunk"])
    {
        if p.len() != 5 || p[4].as_f64().is_none_or(|n| n < 0.0 || n.fract() != 0.0) {
            return Err(invalid("Catalog chunk tuple is malformed"));
        }
        let PortableValue::Binary {
            kind,
            bytes,
            byte_offset,
            byte_length,
        } = row.record.portable_value()?
        else {
            return Err(invalid("Source catalog chunk must be Uint8Array"));
        };
        if kind != "Uint8Array" || byte_offset != 0 || byte_length != bytes.len() as u64 {
            return Err(invalid("Catalog chunk view is unsupported"));
        }
        row.record.value = json!(bytes);
        row.record.value_encoding = gateway_core::value::ValueEncoding::Json;
        row.mapping.transform = Transform::CatalogBytes;
        return Ok(());
    }
    if row.record.value_encoding != gateway_core::value::ValueEncoding::Json {
        if quota_family(p) {
            gateway_claude_runtime::quota::parse_record(&row.record, 0)?;
            return Ok(());
        }
        if retained_typed(p) && known(p) {
            return Ok(());
        }
        return Err(invalid(
            "An effective business schema requires its explicit JSON codec",
        ));
    }
    let v = row.record.json_value()?.clone();
    if starts(p, &["ubq_ai", "api_keys", "id"]) {
        let record: gateway_admin::keys::ApiKeyRecord = decode(&v)?;
        if p.len() != 4
            || p[3] != record.policy.id
            || record.policy.usage_quota_version != 3
            || !gateway_admin_data::migration::audit::valid_key_policy(&v, true)
        {
            return Err(invalid(
                "API key ID policy is malformed or requires legacy migration",
            ));
        }
    } else if starts(p, &["ubq_ai", "api_keys", "hash"]) {
        let _: gateway_auth::api_keys::ApiKeyHashRecord = decode(&v)?;
        if p.len() != 4 || !gateway_admin_data::migration::audit::valid_key_policy(&v, false) {
            return Err(invalid("API key hash policy is malformed"));
        }
    } else if starts(p, &["uos_ai", "api_key_usage", "v3", "window"]) {
        let mut projected = v.clone();
        projected["reservations"] = json!({});
        let window: ApiUsageWindow = decode(&projected)?;
        if window.v != 3
            || p.len() != 7
            || p[4] != window.key_id.0
            || p[5] != window.policy_version
            || p[6].as_f64() != Some(window.window_start_ms as f64)
            || window.reserved_requests < 0
            || window.committed_requests < 0
        {
            return Err(invalid("API window identity/counters conflict"));
        }
        row.record.value = projected;
        row.mapping.transform = Transform::ApiWindow;
    } else if starts(p, &["uos_ai", "api_key_usage", "v3", "request"]) {
        let mut projected = v.clone();
        projected["transport_started"] = json!(false);
        let request: ApiUsageRequest = decode(&projected)?;
        if request.v != 3
            || p.len() != 8
            || p[4] != request.key_id.0
            || p[7] != request.request_id.0
        {
            return Err(invalid("API request identity conflicts"));
        }
        // This is an absent marker, NOT known-before-transport evidence. Source state remains exact.
        row.record.value = projected;
        row.mapping.transform = Transform::ApiRequest;
    } else if starts(p, &["uos_ai", "kernel_quota", "v2"]) {
        let kind = p
            .get(3)
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("Kernel tuple missing kind"))?;
        if matches!(kind, "repo_window" | "org_window") {
            let (scope, owner, repo) = gateway_admin_data::migration::kernel::identity(p, "window")
                .ok_or_else(|| invalid("Kernel source window identity is malformed"))?;
            if gateway_admin_data::migration::kernel::normalize_window(
                &v,
                &scope,
                &owner,
                repo.as_deref(),
            )
            .is_none()
            {
                return Err(invalid("Kernel source window is malformed"));
            }
            // This is still source data, not a live window. The complete
            // reservation inventory binds its exact index in indexes.rs.
            row.mapping.transform = Transform::KernelWindow;
        } else if kind.ends_with("_window") {
            let mut projected = v.clone();
            projected["reservations"] = json!({});
            let _: KernelWindow = decode(&projected)?;
            row.record.value = projected;
            row.mapping.transform = Transform::KernelWindow;
        } else if kind.ends_with("_reservation") {
            let mut projected = v.clone();
            let state = v["state"]
                .as_str()
                .ok_or_else(|| invalid("Kernel state missing"))?;
            projected["state"] = if state == "reserved" {
                Value::Null
            } else {
                json!(state)
            };
            projected["terminal_at_ms"] = match state {
                "reserved" => Value::Null,
                "committed" => v["committed_at_ms"].clone(),
                "released" => v["released_at_ms"].clone(),
                _ => return Err(invalid("Kernel terminal state invalid")),
            };
            let _: KernelReservation = decode(&projected)?;
            row.record.value = projected;
            row.mapping.transform = Transform::KernelRequest;
        } else if kind.ends_with("_policy") {
            let _: KernelPolicy = decode(&v)?;
        }
    } else if starts(p, &["uos_ai", "paid_fallback", "v3", "pending"]) {
        if p.len() != 6 {
            return Err(invalid("Paid pending identity malformed"));
        }
        let mut projected = v.clone();
        projected["key_id"] = p[4].clone();
        projected["attempt_id"] = p[5].clone();
        let _: PendingPaid = decode(&projected)?;
        row.record.value = projected;
        row.mapping.transform = Transform::PaidPending;
    } else if starts(p, &["uos_ai", "paid_fallback", "v3", "reconciliation_gate"]) {
        let mut projected = v.clone();
        projected["pending"] = json!({});
        let _: ReconciliationGate = decode(&projected)?;
        row.record.value = projected;
        row.mapping.transform = Transform::PaidGate;
    } else if starts(p, &["uos_ai", "paid_fallback", "v3", "window"]) {
        let window: PaidWindow = decode(&v)?;
        if p.len() != 6
            || p[4] != window.key_id.0
            || p[5].as_f64() != Some(window.window_reset_at_ms as f64)
            || window.reserved_microcredits < 0
            || window.pending_count < 0
        {
            return Err(invalid("Paid window identity/counters malformed"));
        }
    } else if starts(p, &["ubq_ai", "codex_auth"]) {
        let pool = gateway_auth::provider_credentials::parse_codex_source_pool(&v)?
            .ok_or_else(|| invalid("Source Codex pool is malformed"))?;
        if pool
            .accounts
            .iter()
            .any(|a| !a.refresh_token.expose().is_empty())
        {
            return Err(unavailable(
                "Managed source credentials require trusted offline native-owner normalization before common-candidate ingestion",
            ));
        }
    } else if starts(p, &["uos_ai", "codex_active_account"]) {
        let _: gateway_core::identity::ActiveSelection = decode(&v)?;
    } else if starts(p, &["uos_ai", "codex_account_routing"]) {
        gateway_authority::routing::parse_routing_state(&v)?;
    } else if starts(p, &["uos_ai", "codex_capacity_routing"]) {
        gateway_authority::routing::parse_capacity_store(&v)?;
    } else if starts(p, &["uos_ai", "codex_manual_reset"]) {
        let intent = gateway_authority::manual_reset::parse_manual_intent(&v)?;
        if p.len() != 4
            || p[2] != "v1"
            || p[3] != intent.account_id_hash
            || row.record.expires_at_ms.is_some()
        {
            return Err(invalid(
                "Manual reset intent identity or permanent retention is invalid",
            ));
        }
    } else if quota_family(p) {
        gateway_claude_runtime::quota::parse_record(&row.record, 0)?;
    } else if starts(p, &["uos_ai", "claude_code_accounts"]) {
        gateway_admin_runtime::claude::parse_roster(&v)?;
    } else if starts(p, &["uos_ai", "auth", "users"]) {
        let user: gateway_auth::passkeys::PasskeyUser = decode(&v)?;
        if p.len() != 4 || p[3] != user.id {
            return Err(invalid("Passkey user identity conflicts"));
        }
    } else if starts(p, &["uos_ai", "auth", "credentials"]) {
        let credential: gateway_auth::passkeys::PasskeyCredential = decode(&v)?;
        if p.len() != 4 || p[3] != credential.credential_id {
            return Err(invalid("Passkey credential identity conflicts"));
        }
    } else if starts(p, &["uos_ai", "auth", "sessions"]) {
        let _: gateway_auth::passkeys::PasskeySession = decode(&v)?;
    } else if starts(p, &["uos_ai", "auth", "challenges"]) {
        let _: gateway_auth::passkeys::PasskeyChallenge = decode(&v)?;
    } else if starts(p, &["ubq_ai", "codex_catalog"]) {
        let metadata: gateway_schema::catalog_cache::CatalogMetadata = decode(&v)?;
        if !metadata.valid() || p.get(2) != Some(&json!(metadata.client_version)) {
            return Err(invalid("Catalog metadata/version conflicts"));
        }
    } else if !known(p) {
        return Err(unavailable(
            "Source key has no reviewed runtime schema or retained-data family",
        ));
    }
    Ok(())
}

pub fn known_source_family(p: &[Value]) -> bool {
    const UOS: &[&str] = &[
        "admin_error_log",
        "api_key_usage",
        "api_keys",
        "auth",
        "claude_code_access",
        "claude_code_accounts",
        "claude_code_quota",
        "codex_account_models",
        "codex_account_routing",
        "codex_active_account",
        "codex_auth_refresh",
        "codex_banked_reset_usage",
        "codex_capacity_routing",
        "codex_instructions",
        "codex_instructions_chunk",
        "codex_live_calls",
        "codex_manual_reset",
        "codex_models_whitelist",
        "codex_overage_usage",
        "codex_reset_redemption",
        "codex_reset_shadow_decision",
        "codex_reset_usage",
        "codex_session_activity",
        "debug_routing",
        "kernel_policy_queue",
        "kernel_pubkeys",
        "kernel_quota",
        "metered_quota",
        "migrations",
        "paid_fallback",
        "prompt_cache_analytics",
        "prompt_cache_scope_experiment",
        "prompt_cache_telemetry_gate",
        "provider_capacity",
        "provider_health",
        "provider_selection",
        "runtime_config",
        "sentinel_incident",
        "sentinel_replay",
        "voyage_api_key",
    ];
    const UBQ: &[&str] = &[
        "api_keys",
        "claude_code_auth",
        "claude_code_quota",
        "claude_code_workspace",
        "codex_auth",
        "codex_catalog",
        "codex_catalog_auth_generation",
        "codex_catalog_chunk",
        "codex_catalog_refresh_lease",
        "codex_catalog_source_chunk",
        "codex_models",
        "kernel_auth",
    ];
    (p.first() == Some(&serde_json::json!("uos_ai"))
        && p.get(1)
            .and_then(Value::as_str)
            .is_some_and(|s| UOS.contains(&s)))
        || (p.first() == Some(&serde_json::json!("ubq_ai"))
            && p.get(1)
                .and_then(Value::as_str)
                .is_some_and(|s| UBQ.contains(&s)))
        || p.first()
            .and_then(Value::as_str)
            .is_some_and(|s| ["default", "key", "agent_messages", "embeddings"].contains(&s))
}
pub(crate) fn known(p: &[Value]) -> bool {
    known_source_family(p)
}
pub(crate) fn retained_typed(p: &[Value]) -> bool {
    p.first()
        .and_then(Value::as_str)
        .is_some_and(|s| ["default", "key", "agent_messages", "embeddings"].contains(&s))
        || (p.first() == Some(&serde_json::json!("uos_ai"))
            && p.get(1).and_then(Value::as_str).is_some_and(|s| {
                [
                    "admin_error_log",
                    "api_keys",
                    "sentinel_incident",
                    "sentinel_replay",
                    "provider_capacity",
                    "provider_health",
                    "prompt_cache_analytics",
                    "prompt_cache_scope_experiment",
                    "prompt_cache_telemetry_gate",
                    "codex_session_activity",
                ]
                .contains(&s)
            }))
}
pub(crate) fn outstanding(row: &PaidAttempt) -> bool {
    matches!(
        row.billing_state,
        BillingState::Pending | BillingState::Unresolved
    )
}

pub(crate) fn quota_family(parts: &[Value]) -> bool {
    starts(parts, &["uos_ai", "claude_code_quota"])
}
