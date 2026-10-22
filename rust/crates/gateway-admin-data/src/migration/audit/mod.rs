//! Audits complete supplied source-schema inventories; does not adopt them as authority state.
mod keys;
mod paid;
mod source_fields;
mod source_model;
pub use source_model::{inspect_model_inventory, inspect_model_snapshot};
mod usage;
pub use keys::{AuditedKeyPair, inspect_key_pairs, valid_key_policy, valid_source_key_policy};
pub use paid::{inspect_paid, inspect_paid_inventory, valid_source_paid_request};
pub use usage::{
    inspect_api_inventory, inspect_api_usage, inspect_kernel, inspect_kernel_inventory,
};

use super::{ObservedRow, starts};
use crate::{integer, number, text};
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Replayable complete inventory. Each visit starts at the original first row and
/// must validate its complete EOF before success; callback/I/O errors propagate.
pub trait AuditInventory {
    fn visit(
        &self,
        row: &mut dyn FnMut(&ObservedRow) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError>;
}
pub struct SliceInventory<'a>(pub &'a [ObservedRow]);
impl AuditInventory for SliceInventory<'_> {
    fn visit(
        &self,
        row: &mut dyn FnMut(&ObservedRow) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError> {
        for value in self.0 {
            row(value)?;
        }
        Ok(())
    }
}
/// Same six complete coupled audits used by native preparation, without owning
/// every source payload or collecting all complete model-bearing policy pairs.
pub fn inspect_inventory(rows: &dyn AuditInventory, now: i64) -> Result<Audit, GatewayError> {
    let mut known = std::collections::BTreeSet::new();
    let mut unlimited = std::collections::BTreeSet::new();
    let mut api = usage::ApiAudit::new();
    let mut kernel = usage::KernelAudit::new();
    let mut paid = paid::PaidAudit::new(now);
    let mut reset = Audit::default();
    let mut reset_error = None;
    let mut model = source_model::ModelAudit::default();
    let mut audit = keys::visit_key_pairs_with(
        rows,
        &mut |pair| {
            if pair.unlimited_paid {
                unlimited.insert(pair.key_id.clone());
            }
            known.insert(pair.key_id);
            Ok(())
        },
        &mut |row| {
            api.accept(row);
            kernel.accept(row);
            paid.accept(row);
            if reset_error.is_none() {
                reset_error = inspect_reset_row(row, &mut reset).err();
            }
            model.accept(row);
        },
    )?;
    audit.merge(api.finish(&known)?);
    audit.merge(kernel.finish()?);
    audit.merge(paid.finish(&known, &unlimited)?);
    if let Some(error) = reset_error {
        return Err(error);
    }
    audit.merge(reset);
    audit.errors.extend(model.finish()?);
    Ok(audit)
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct Audit {
    pub counts: BTreeMap<String, usize>,
    pub errors: Vec<JsString16>,
}
impl Audit {
    pub fn count(&mut self, name: &str) {
        *self.counts.entry(name.into()).or_default() += 1;
    }
    pub fn merge(&mut self, other: Self) {
        self.counts.extend(other.counts);
        self.errors.extend(other.errors);
    }
    pub fn source_json(&self) -> Result<SourceJson, GatewayError> {
        SourceJson::from_serializable(self)
    }
    pub fn error_message(&self, prefix: &str) -> JsString16 {
        let mut units = prefix.encode_utf16().collect::<Vec<_>>();
        for (index, error) in self.errors.iter().enumerate() {
            if index != 0 {
                units.extend("; ".encode_utf16());
            }
            units.extend_from_slice(error.as_units());
        }
        JsString16::from_units(units)
    }
}
pub fn api_id(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.len() <= 200 && s == s.trim())
}
pub fn safe(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|v| {
        v.is_finite() && v.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&v)
    })
}
pub fn positive(value: Option<&Value>) -> bool {
    safe(value) && value.and_then(Value::as_f64).is_some_and(|v| v > 0.0)
}
pub fn nullable_safe(value: Option<&Value>, positive_only: bool) -> bool {
    value.is_some_and(|v| {
        v.is_null()
            || if positive_only {
                positive(Some(v))
            } else {
                safe(Some(v))
            }
    })
}
pub fn nullable_text(value: Option<&Value>, nonempty: bool) -> bool {
    value.is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| !nonempty || !s.is_empty()))
}
pub fn under(parts: &[Value], prefix: &[&str]) -> bool {
    parts.len() > prefix.len() && starts(parts, prefix)
}
pub fn reference(parts: &[Value]) -> String {
    let parts: Vec<Value> = parts
        .iter()
        .map(|v| {
            if let Some(n) = v.as_f64() {
                crate::json_number(Some(n))
            } else {
                v.clone()
            }
        })
        .collect();
    serde_json::to_string(&parts).unwrap_or_default()
}
pub fn valid_api_window(v: &Value) -> bool {
    v["v"] == 3
        && text(v, "key_id").is_some_and(|s| !s.is_empty())
        && text(v, "policy_version").is_some_and(|s| !s.is_empty())
        && [
            "window_start_ms",
            "window_reset_at_ms",
            "committed_requests",
            "reserved_requests",
            "updated_at_ms",
        ]
        .iter()
        .all(|f| safe(v.get(f)))
        && number(v, "window_reset_at_ms") > number(v, "window_start_ms")
}
pub fn valid_api_request(v: &Value) -> bool {
    if v["v"] != 3
        || !["key_id", "request_id", "route"]
            .iter()
            .all(|f| text(v, f).is_some_and(|s| !s.is_empty()))
        || !["reserved_at_ms", "lease_expires_at_ms"]
            .iter()
            .all(|f| safe(v.get(f)))
        || !nullable_safe(v.get("dispatched_at_ms"), false)
        || !nullable_safe(v.get("released_at_ms"), false)
        || !nullable_text(v.get("release_reason"), false)
    {
        return false;
    }
    let provider = &v["provider"];
    if !v.get("provider").is_some_and(|p| {
        p.is_null()
            || p.as_str().is_some_and(|p| {
                [
                    "cerebras",
                    "chatgpt_codex",
                    "claude_code",
                    "deepseek",
                    "lithos",
                    "openrouter",
                    "removed_provider",
                    "metered",
                    "surplus",
                    "voyage",
                ]
                .contains(&p)
            })
    }) {
        return false;
    }
    match text(v, "state") {
        Some("reserved") => {
            provider.is_null()
                && v["dispatched_at_ms"].is_null()
                && v["released_at_ms"].is_null()
                && v["release_reason"].is_null()
        }
        Some("dispatched") => {
            !provider.is_null()
                && !v["dispatched_at_ms"].is_null()
                && v["released_at_ms"].is_null()
                && v["release_reason"].is_null()
        }
        Some("released") => {
            provider.is_null()
                && v["dispatched_at_ms"].is_null()
                && !v["released_at_ms"].is_null()
                && !v["release_reason"].is_null()
        }
        _ => false,
    }
}
pub fn valid_kernel_policy(v: &Value, scope: &str, owner: &str, repo: Option<&str>) -> bool {
    super::kernel::normalize_policy(v, scope, owner, repo).is_some()
}
pub fn inspect_reset_usage(rows: &[ObservedRow]) -> Result<Audit, GatewayError> {
    inspect_reset_inventory(&SliceInventory(rows))
}
pub fn inspect_reset_inventory(rows: &dyn AuditInventory) -> Result<Audit, GatewayError> {
    let mut audit = Audit::default();
    rows.visit(&mut |row| inspect_reset_row(row, &mut audit))?;
    Ok(audit)
}
fn inspect_reset_row(row: &ObservedRow, audit: &mut Audit) -> Result<(), GatewayError> {
    if !under(&row.parts, &["uos_ai", "codex_reset_usage"]) {
        return Ok(());
    }
    audit.count("codex_reset_usage");
    let p = &row.parts;
    let valid = p.len() == 5
        && p[2] == "account"
        && p[3] == "v1"
        && p[4].as_str().is_some_and(|s| !s.is_empty());
    if !valid {
        audit.errors.push(
            format!("codex reset usage key is malformed: {}", reference(p))
                .as_str()
                .into(),
        );
        return Ok(());
    }
    if !row.value()?.get("enabled").is_some_and(Value::is_boolean) {
        audit.errors.push(
            format!("codex reset usage record is malformed: {}", reference(p))
                .as_str()
                .into(),
        );
    }
    Ok(())
}
pub fn inspect_source_rows(
    rows: &[ObservedRow],
    complete: bool,
    now: i64,
) -> Result<Audit, GatewayError> {
    if !complete {
        return Err(crate::error(
            "Migration validation requires complete source inventories.",
        ));
    }
    let (pairs, mut audit) = inspect_key_pairs(rows)?;
    let known: std::collections::BTreeSet<String> =
        pairs.iter().map(|pair| pair.key_id.clone()).collect();
    let unlimited: std::collections::BTreeSet<String> = pairs
        .iter()
        .filter(|pair| pair.unlimited_paid)
        .map(|pair| pair.key_id.clone())
        .collect();
    audit.merge(inspect_api_usage(rows, &known)?);
    audit.merge(inspect_kernel(rows)?);
    audit.merge(inspect_paid(rows, &known, &unlimited, now)?);
    audit.merge(inspect_reset_usage(rows)?);
    audit.errors.extend(inspect_model_snapshot(rows)?);
    let repo = rows
        .iter()
        .filter(|r| under(&r.parts, &["ubq_ai", "kernel_auth", "limits"]))
        .count();
    let org = rows
        .iter()
        .filter(|r| under(&r.parts, &["ubq_ai", "kernel_auth", "org_limits"]))
        .count();
    audit.counts.insert("kernel_repo_limits".into(), repo);
    audit.counts.insert("kernel_org_limits".into(), org);
    if repo > 0 || org > 0 {
        audit.errors.push(
            format!("legacy combined kernel quota records remain: repo={repo} org={org}")
                .as_str()
                .into(),
        );
    }
    for pair in pairs {
        let record = &pair.id;
        let hash = &pair.hash;
        let id = pair.key_id.as_str();
        if !source_fields::equals(record, "usage_quota_version", &json!(3))
            || !source_fields::equals(hash, "usage_quota_version", &json!(3))
        {
            audit.errors.push(
                format!("api key quota ledger version is not V3: {id}")
                    .as_str()
                    .into(),
            );
            continue;
        }
        if !source_fields::equals(record, "usage_limit_requests", &json!(-1)) {
            // Same revoked-clock rule as counter::migration_policy_now, without
            // converting the complete model-bearing source policy into Value.
            let clock = if source_fields::member(record, "revoked_at_ms")
                .is_some_and(|value| value.as_str() == "null")
            {
                now
            } else {
                source_fields::integer(record, "usage_reset_at_ms")
                    .map(|reset| (reset - 1).max(0))
                    .ok_or_else(|| crate::error("Invalid API-key migration clock."))?
            };
            let span = source_fields::integer(record, "window_ms")
                .ok_or_else(|| crate::error("Invalid API-key window."))?;
            let initial = source_fields::integer(record, "usage_reset_at_ms")
                .ok_or_else(|| crate::error("Invalid API-key reset."))?
                - span;
            let start = if clock < initial + span {
                initial
            } else {
                initial + (clock - initial).div_euclid(span) * span
            };
            let reset = start + span;
            let version = format!("v3:{span}");
            let wp = vec![
                json!("uos_ai"),
                json!("api_key_usage"),
                json!("v3"),
                json!("window"),
                json!(id),
                json!(version),
                json!(start),
            ];
            let valid = rows
                .iter()
                .find(|r| r.parts == wp)
                .map(ObservedRow::value)
                .transpose()?
                .is_some_and(|v| {
                    valid_api_window(v)
                        && text(v, "key_id") == Some(id)
                        && text(v, "policy_version") == Some(&version)
                        && integer(v, "window_start_ms") == Some(start)
                        && integer(v, "window_reset_at_ms") == Some(reset)
                });
            if !valid {
                audit.errors.push(
                    format!("bounded V3 aggregate is missing or invalid: {id}")
                        .as_str()
                        .into(),
                );
            }
            let bp = vec![
                json!("uos_ai"),
                json!("migrations"),
                json!("kv_read_incident_v2"),
                json!("api_key_usage_baseline"),
                json!(id),
                json!(version),
                json!(start),
            ];
            let valid = rows
                .iter()
                .find(|r| r.parts == bp)
                .map(ObservedRow::value)
                .transpose()?
                .is_some_and(|v| {
                    super::counter::valid_baseline(v)
                        && text(v, "key_id") == Some(id)
                        && text(v, "policy_version") == Some(&version)
                        && integer(v, "window_start_ms") == Some(start)
                });
            if !valid {
                audit.errors.push(
                    format!(
                        "bounded counter migration baseline is missing, stale, or invalid: {id}"
                    )
                    .as_str()
                    .into(),
                );
            }
        }
        if let Some(request) = source_fields::member(record, "paid_fallback_reservation_request_id")
            .filter(|value| value.as_str() != "null")
            && !rows.iter().any(|row| {
                under(&row.parts, &["uos_ai", "paid_fallback", "ledger"])
                    && gateway_core::source_control::decode_source_control_record(&row.record)
                        .is_ok_and(|value| {
                            source_fields::text(&value, "key_id").as_deref() == Some(id)
                                && source_fields::member(&value, "id").is_some_and(|actual| {
                                    source_fields::same_value(&actual, &request)
                                })
                                && (source_fields::equals(
                                    &value,
                                    "billing_status",
                                    &json!("pending"),
                                ) || source_fields::equals(
                                    &value,
                                    "billing_status",
                                    &json!("unresolved"),
                                ))
                        })
            })
        {
            audit.errors.push(
                format!("paid fallback reservation has no pending ledger record: {id}")
                    .as_str()
                    .into(),
            );
        }
    }
    Ok(audit)
}
