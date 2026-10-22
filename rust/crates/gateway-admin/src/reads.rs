use crate::source_input as input;
use gateway_auth::{
    AuthResponse, api_keys, invalid,
    passkeys::{PasskeyUser, user_wire},
    store,
};
use gateway_core::source_json::SourceJson;
use gateway_core::{
    GatewayError,
    query::{QueryRequest, QuerySelector, QueryStore},
    state::{RecordKey, StoredRecord},
};
use serde_json::json;

use crate::{
    audit::{self, RETENTION_MS},
    keys::{ApiKeyRecord, public_record},
};

/// Each storage call is bounded; source list endpoints exhaust the cursor rather than truncate silently.
async fn prefix_rows<S: QueryStore>(
    store: &S,
    prefix: RecordKey,
    now: i64,
) -> Result<Vec<(RecordKey, StoredRecord)>, GatewayError> {
    let mut rows = Vec::new();
    let mut cursor = None;
    loop {
        let page = store
            .query(QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: prefix.clone(),
                    start: None,
                    end: None,
                },
                reverse: false,
                limit: 500,
                cursor: cursor.clone(),
                now_ms: now,
            })
            .await?;
        for entry in page.entries {
            entry.record.validate_version()?;
            if entry.record.expires_at_ms.is_none_or(|expiry| expiry > now) {
                rows.push((entry.key, entry.record));
            }
        }
        let Some(next) = page.next_cursor else {
            break;
        };
        if cursor.as_ref() == Some(&next) {
            return Err(GatewayError::unavailable(
                "Storage query cursor did not advance",
                "authority_query_invalid",
            ));
        }
        cursor = Some(next);
    }
    Ok(rows)
}

pub async fn passkey_users<S: QueryStore>(
    store: &S,
    now: i64,
) -> Result<AuthResponse, GatewayError> {
    let rows = prefix_rows(store, store::key(json!(["uos_ai", "auth", "users"])), now).await?;
    let mut users = Vec::new();
    for (_, row) in rows {
        let user: PasskeyUser =
            serde_json::from_value(row.json_value()?.clone()).map_err(|_| {
                GatewayError::unavailable("Passkey user state is corrupt", "auth_state_corrupt")
            })?;
        users.push(user);
    }
    users.sort_by_key(|user| std::cmp::Reverse(user.updated_at_ms));
    Ok(AuthResponse::json(
        200,
        json!({"object":"list","data":users.iter().map(user_wire).collect::<Vec<_>>()}),
    ))
}

pub async fn effective_key_record<S: QueryStore>(
    store: &S,
    record: &ApiKeyRecord,
    now: i64,
) -> Result<SourceJson, GatewayError> {
    let mut value = public_record(record);
    let (start, reset) = api_keys::current_window(
        record.policy.usage_reset_at_ms,
        record.policy.window_ms,
        now,
    )?;
    let window = store
        .read(&gateway_authority::keys::api_window(
            &record.policy.id,
            &format!("v3:{}", record.policy.window_ms),
            start,
        ))
        .await?;
    let committed = match window {
        None => 0,
        Some(row) => {
            row.validate_version()?;
            let usage: gateway_authority::quota::ApiUsageWindow =
                serde_json::from_value(row.json_value()?.clone()).map_err(|_| {
                    GatewayError::unavailable(
                        "API key quota ledger is corrupt",
                        "api_key_policy_invalid",
                    )
                })?;
            if usage.key_id.0 != record.policy.id
                || usage.window_start_ms != start
                || usage.window_reset_at_ms != reset
                || usage.committed_requests < 0
            {
                return Err(GatewayError::unavailable(
                    "API key quota ledger identity is invalid",
                    "api_key_policy_invalid",
                ));
            }
            usage.committed_requests
        }
    };
    input::set(&mut value, "usage_requests", input::json(&committed));
    input::set(&mut value, "usage_reset_at_ms", input::json(&reset));
    let paid = store
        .read(&gateway_authority::keys::paid_window(
            &record.policy.id,
            reset,
        ))
        .await?;
    if let Some(row) = paid {
        row.validate_version()?;
        let paid: gateway_authority::paid::PaidWindow =
            serde_json::from_value(row.json_value()?.clone()).map_err(|_| {
                GatewayError::unavailable(
                    "Paid billing window is corrupt",
                    "paid_fallback_unavailable",
                )
            })?;
        if paid.key_id.0 != record.policy.id
            || paid.window_reset_at_ms != reset
            || paid.settled_microcredits < 0
            || paid.reserved_microcredits < 0
        {
            return Err(GatewayError::unavailable(
                "Paid billing window identity is invalid",
                "paid_fallback_unavailable",
            ));
        }
        input::set(
            &mut value,
            "paid_fallback_spent_credits",
            input::json(&(paid.settled_microcredits as f64 / 1_000_000.0)),
        );
        input::set(
            &mut value,
            "paid_fallback_reserved_credits",
            input::json(&(paid.reserved_microcredits as f64 / 1_000_000.0)),
        );
    }
    input::set(
        &mut value,
        "paid_fallback_limit_credits",
        input::json(&if record.policy.paid_fallback_limit_microcredits == -1 {
            -1.0
        } else {
            record.policy.paid_fallback_limit_microcredits as f64 / 1_000_000.0
        }),
    );
    input::set(
        &mut value,
        "effective_limits",
        input::object(vec![
            ("counted_requests", input::json(&committed)),
            (
                "request_limit",
                input::json(&record.policy.usage_limit_requests),
            ),
            (
                "remaining_requests",
                input::json(&if record.policy.usage_limit_requests == -1 {
                    None
                } else {
                    Some((record.policy.usage_limit_requests - committed).max(0))
                }),
            ),
            ("resets_at_ms", input::json(&reset)),
        ]),
    );
    Ok(value)
}

pub async fn api_keys<S: QueryStore>(store: &S, now: i64) -> Result<AuthResponse, GatewayError> {
    let rows = prefix_rows(store, store::key(json!(["ubq_ai", "api_keys", "id"])), now).await?;
    let mut records = Vec::new();
    for (key, row) in rows {
        let record = crate::keys::decode_id_record(&key, &row)?;
        records.push(record);
    }
    records.sort_by_key(|record| std::cmp::Reverse(record.created_at_ms));
    let mut data = Vec::new();
    for record in records {
        data.push(effective_key_record(store, &record, now).await?);
    }
    Ok(AuthResponse::source_json(
        200,
        input::object(vec![
            ("object", input::json("list")),
            ("data", input::json(&data)),
        ]),
    ))
}

pub async fn key_changes<S: QueryStore>(
    store: &S,
    query: &std::collections::BTreeMap<String, Vec<String>>,
    now: i64,
) -> Result<AuthResponse, GatewayError> {
    let limit = match query.get("limit").and_then(|values| values.first()) {
        None => 20,
        Some(value) => {
            if !value.trim().bytes().all(|b| b.is_ascii_digit()) || value.trim().is_empty() {
                return Err(invalid("limit must be a positive integer"));
            }
            value
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|n| *n > 0 && *n <= gateway_core::identity::MAX_SAFE_INTEGER as u64)
                .ok_or_else(|| invalid("limit must be a positive integer"))?
                .min(50) as u32
        }
    };
    let cursor = query
        .get("cursor")
        .and_then(|values| values.first())
        .map(|value| value.trim().to_owned());
    if cursor
        .as_ref()
        .is_some_and(|value| value.len() > 1024 || value.is_empty())
    {
        return Err(invalid("cursor is invalid"));
    }
    let page = store
        .query(QueryRequest {
            selector: QuerySelector::Prefix {
                prefix: store::key(json!(["uos_ai", "api_keys", "change"])),
                start: None,
                end: None,
            },
            reverse: false,
            limit,
            cursor,
            now_ms: now,
        })
        .await?;
    let mut events = Vec::new();
    for entry in page.entries {
        if let Some(event) = audit::retained_event(&entry.record, now - RETENTION_MS)? {
            events.push(event);
        }
    }
    Ok(AuthResponse::source_json(
        200,
        audit::page(&events, page.next_cursor.as_deref())?,
    ))
}
