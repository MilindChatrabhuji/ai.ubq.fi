//! Source validation views of current common authority records, never a backup ledger.
use crate::*;
use gateway_admin_data::migration::{ObservedRow, audit, logical_fields};
use gateway_auth::AuthResponse;
use gateway_core::{query::*, value::PortableValue};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) async fn source_rows<S: QueryStore>(
    store: &S,
    now: i64,
) -> Result<Vec<ObservedRow>, GatewayError> {
    let mut rows = Vec::new();
    let mut cursor = None;
    let mut cursors = BTreeSet::new();
    let mut keys = BTreeSet::new();
    loop {
        let page = store
            .query(QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: TupleKey::from_parts(&[])?.to_record_key(),
                    start: None,
                    end: None,
                },
                reverse: false,
                limit: 256,
                cursor: cursor.clone(),
                now_ms: now,
            })
            .await?;
        for entry in page.entries {
            if !keys.insert(entry.key.0.clone()) {
                return Err(invalid("Profile validation repeated a key"));
            }
            let parts = parts(&entry.key)?;
            if private_source_key(&parts) || starts(&parts, &["uos_ai", "native_live"]) {
                continue;
            }
            let value = if entry.record.value_encoding
                == gateway_core::value::ValueEncoding::SourceGraphV1
            {
                entry
                    .record
                    .source_graph_value()?
                    .try_identity_free_tree()?
                    .unwrap_or(PortableValue::Null)
            } else {
                crate::inverse::inverse_value(
                    crate::inverse::transform_for_new(&parts),
                    &entry.record,
                    None,
                )
                .or_else(|_| entry.record.portable_value())?
            };
            let value = match value {
                PortableValue::Object(_) => logical_fields(&value),
                value => value.to_json_lossless().unwrap_or(Value::Null),
            };
            rows.push(ObservedRow {
                key: entry.key,
                parts,
                record: StoredRecord::json(
                    entry.record.revision,
                    value,
                    entry.record.expires_at_ms,
                ),
            });
        }
        cursor = page.next_cursor;
        match &cursor {
            Some(c) if !cursors.insert(c.clone()) => {
                return Err(invalid("Profile validation cursor repeated"));
            }
            Some(_) => {}
            None => break,
        }
    }
    Ok(rows)
}

pub(crate) async fn validate<S: QueryStore>(
    store: &S,
    now: i64,
) -> Result<AuthResponse, GatewayError> {
    let rows = source_rows(store, now).await?;
    let mut audited = audit::inspect_source_rows(&rows, true, now)?;
    crate::profile_reset::audit(&rows, &mut audited.errors)?;
    for row in rows
        .iter()
        .filter(|r| starts(&r.parts, &["uos_ai", "codex_manual_reset"]))
    {
        let intent = gateway_authority::manual_reset::parse_manual_intent(row.record.json_value()?);
        if row.parts.len() != 4
            || row.parts[2] != "v1"
            || !intent
                .as_ref()
                .is_ok_and(|i| row.parts[3] == i.account_id_hash)
        {
            audited
                .errors
                .push("codex manual reset intent is malformed".into());
        }
    }
    let mut counts = BTreeMap::new();
    for (name, prefix) in COUNTS {
        let count = rows
            .iter()
            .filter(|r| r.parts.len() > prefix.len() && starts(&r.parts, prefix))
            .count();
        counts.insert(
            *name,
            if *name == "embeddings_v2_at_most_10000" {
                count.min(10_000)
            } else {
                count
            },
        );
    }
    let reconciled = rows
        .iter()
        .filter(|r| {
            starts(
                &r.parts,
                &[
                    "uos_ai",
                    "migrations",
                    "kv_read_incident_v2",
                    "api_key_usage_baseline",
                ],
            ) && r.parts.len() > 4
                && r.record.json_value().is_ok_and(|v| {
                    gateway_admin_data::migration::counter::valid_baseline(v)
                        && !v["reconciled_at_ms"].is_null()
                })
        })
        .count();
    counts.insert(
        "api_key_bounded_counter_reconciled_baselines_v2",
        reconciled,
    );
    let get = |parts: Value| {
        rows.iter()
            .find(|r| r.parts == parts.as_array().unwrap().as_slice())
            .map(|r| r.record.json_value())
            .transpose()
    };
    let mut settings = BTreeMap::new();
    for (name, key) in SETTINGS {
        settings.insert(*name, get(json!(key))?.is_some_and(|v| !v.is_null()));
    }
    let config = get(json!(["uos_ai", "runtime_config", "v2"]))?
        .and_then(gateway_schema::runtime_config::normalize_runtime_config);
    settings.insert("runtime_config_v2", config.is_some());
    if config.is_none() {
        audited
            .errors
            .push("runtime config v2 is missing or invalid".into());
    }
    Ok(AuthResponse::json(
        200,
        json!({"counts":counts,"settings_present":settings,"errors":audited.errors}),
    ))
}

const COUNTS: &[(&str, &[&str])] = &[
    ("api_key_ids", &["ubq_ai", "api_keys", "id"]),
    ("api_key_hashes", &["ubq_ai", "api_keys", "hash"]),
    (
        "api_key_bounded_counters_v2",
        &["uos_ai", "api_key_usage", "v2"],
    ),
    (
        "api_key_bounded_counter_baselines_v2",
        &[
            "uos_ai",
            "migrations",
            "kv_read_incident_v2",
            "api_key_usage_baseline",
        ],
    ),
    (
        "api_key_bounded_counter_reconciled_baselines_v2",
        &[
            "uos_ai",
            "migrations",
            "kv_read_incident_v2",
            "api_key_usage_reconciled_baseline",
        ],
    ),
    (
        "api_key_usage_v3_windows",
        &["uos_ai", "api_key_usage", "v3", "window"],
    ),
    (
        "api_key_usage_v3_requests",
        &["uos_ai", "api_key_usage", "v3", "request"],
    ),
    (
        "paid_fallback_ledger",
        &["uos_ai", "paid_fallback", "ledger"],
    ),
    (
        "paid_fallback_v3_windows",
        &["uos_ai", "paid_fallback", "v3", "window"],
    ),
    (
        "paid_fallback_v3_requests",
        &["uos_ai", "paid_fallback", "v3", "request"],
    ),
    (
        "paid_fallback_v3_pending",
        &["uos_ai", "paid_fallback", "v3", "pending"],
    ),
    (
        "paid_fallback_v3_reconciliation_leases",
        &["uos_ai", "paid_fallback", "v3", "reconciliation_lease"],
    ),
    (
        "paid_fallback_v3_deletion_guards",
        &["uos_ai", "paid_fallback", "v3", "deletion_guard"],
    ),
    ("kernel_repo_limits", &["ubq_ai", "kernel_auth", "limits"]),
    (
        "kernel_org_limits",
        &["ubq_ai", "kernel_auth", "org_limits"],
    ),
    (
        "kernel_v2_repo_policies",
        &["uos_ai", "kernel_quota", "v2", "repo_policy"],
    ),
    (
        "kernel_v2_org_policies",
        &["uos_ai", "kernel_quota", "v2", "org_policy"],
    ),
    (
        "kernel_v2_repo_windows",
        &["uos_ai", "kernel_quota", "v2", "repo_window"],
    ),
    (
        "kernel_v2_org_windows",
        &["uos_ai", "kernel_quota", "v2", "org_window"],
    ),
    (
        "kernel_v2_repo_reservations",
        &["uos_ai", "kernel_quota", "v2", "repo_reservation"],
    ),
    (
        "kernel_v2_org_reservations",
        &["uos_ai", "kernel_quota", "v2", "org_reservation"],
    ),
    ("passkey_users", &["uos_ai", "auth", "users"]),
    ("passkey_credentials", &["uos_ai", "auth", "credentials"]),
    ("agent_messages", &["agent_messages"]),
    ("embeddings_v2_at_most_10000", &["embeddings", "v2"]),
    ("legacy_model_key_configs", &["key", "config"]),
    ("legacy_model_key_health", &["key", "health"]),
    ("codex_reset_usage", &["uos_ai", "codex_reset_usage"]),
];
const SETTINGS: &[(&str, &[&str])] = &[
    ("codex_auth", &["ubq_ai", "codex_auth"]),
    ("codex_models", &["ubq_ai", "codex_models"]),
    ("default_model", &["default", "model"]),
    ("default_reasoning_effort", &["default", "reasoning_effort"]),
    (
        "default_kernel_policy_limit_requests",
        &["default", "kernel_policy_limit_requests"],
    ),
    (
        "default_kernel_policy_window_ms",
        &["default", "kernel_policy_window_ms"],
    ),
    ("voyage_api_key", &["uos_ai", "voyage_api_key"]),
    ("kernel_pubkeys", &["uos_ai", "kernel_pubkeys"]),
];
