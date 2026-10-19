//! Exact source redemption/day validation; no redemption or promotion capability is minted.
use gateway_admin_data::migration::{ObservedRow, starts};
use gateway_authority::reset::{ResetRecord, ResetState};
use serde_json::Value;

fn safe(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_i64)
        .is_some_and(|v| (0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&v))
}
fn text(value: Option<&Value>, limit: usize) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= limit)
}
pub(crate) fn redemption(value: &Value) -> bool {
    if value["v"] != 1
        || ![
            "account_id_hash",
            "credential_version",
            "quota_generation",
            "idempotency_key_hash",
            "owner_token",
        ]
        .iter()
        .all(|k| text(value.get(*k), 512))
        || ![
            "routing_generation",
            "fence",
            "lease_expires_at_ms",
            "created_at_ms",
            "updated_at_ms",
        ]
        .iter()
        .all(|k| safe(value.get(*k)))
    {
        return false;
    }
    for (field, limit) in [("provider_receipt_id", 512), ("last_error_code", 128)] {
        if !value
            .get(field)
            .is_some_and(|v| v.is_null() || text(Some(v), limit))
        {
            return false;
        }
    }
    for field in ["submitted_at_ms", "verified_at_ms"] {
        if !value
            .get(field)
            .is_some_and(|v| v.is_null() || safe(Some(v)))
        {
            return false;
        }
    }
    let Ok(row) = serde_json::from_value::<ResetRecord>(value.clone()) else {
        return false;
    };
    if row.updated_at_ms < row.created_at_ms
        || row
            .submitted_at_ms
            .is_some_and(|v| v < row.created_at_ms || v > row.updated_at_ms)
        || row
            .verified_at_ms
            .is_some_and(|v| row.submitted_at_ms.is_none_or(|s| v < s) || v > row.updated_at_ms)
    {
        return false;
    }
    match row.state {
        ResetState::Claimed => {
            row.provider_receipt_id.is_none()
                && row.submitted_at_ms.is_none()
                && row.verified_at_ms.is_none()
                && row.last_error_code.is_none()
        }
        ResetState::Submitted => {
            row.submitted_at_ms.is_some()
                && row.verified_at_ms.is_none()
                && row.last_error_code.is_none()
        }
        ResetState::Unknown => {
            row.submitted_at_ms.is_some()
                && row.verified_at_ms.is_none()
                && row.last_error_code.is_some()
        }
        ResetState::Verified => {
            row.submitted_at_ms.is_some()
                && row.verified_at_ms.is_some()
                && row.last_error_code.is_none()
        }
        ResetState::Rejected => row.verified_at_ms.is_none() && row.last_error_code.is_some(),
    }
}
fn daily(parts: &[Value], value: &Value) -> bool {
    let account = parts.get(2).is_some_and(|v| v == "account_day");
    let expected = if account { 6 } else { 5 };
    if parts.len() != expected || (!account && parts[2] != "global_day") || parts[3] != "v1" {
        return false;
    }
    if account
        && !parts[4].as_str().is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return false;
    }
    let Some(day) = parts.last().and_then(Value::as_str) else {
        return false;
    };
    day.len() == 10
        && day.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
        && value["v"] == 1
        && value["day"] == day
        && safe(value.get("updated_at_ms"))
        && safe(value.get("submission_count"))
}
pub(crate) fn audit(
    rows: &[ObservedRow],
    errors: &mut Vec<gateway_core::js_string::JsString16>,
) -> Result<(), gateway_core::GatewayError> {
    for row in rows
        .iter()
        .filter(|r| starts(&r.parts, &["uos_ai", "codex_reset_shadow_decision"]))
    {
        if gateway_authority::full_pool_reset::FullPoolShadowDecision::validate_record(
            &row.key,
            &row.record,
        )
        .is_err()
        {
            errors.push("codex reset shadow decision is malformed".into());
        }
    }
    for row in rows
        .iter()
        .filter(|r| starts(&r.parts, &["uos_ai", "codex_reset_redemption"]))
    {
        let p = &row.parts;
        let value = row.record.json_value()?;
        if p.get(2).is_some_and(|v| v == "v1") {
            if p.len() != 5
                || !p[3].is_string()
                || !p[4].is_string()
                || !redemption(value)
                || p[3] != value["account_id_hash"]
                || p[4] != value["quota_generation"]
            {
                errors.push("codex reset redemption is malformed".into());
            }
        } else if !daily(p, value) {
            errors.push("codex reset daily budget is malformed".into());
        }
    }
    Ok(())
}
