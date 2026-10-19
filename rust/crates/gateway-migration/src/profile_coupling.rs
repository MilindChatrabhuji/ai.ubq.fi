//! Same-authority reservation and paid-event indexes for public profile writes.
use crate::*;
use gateway_core::{query::*, state::*};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) async fn scan<S: QueryStore>(
    store: &S,
    prefix: Value,
    now: i64,
) -> Result<Vec<QueryEntry>, GatewayError> {
    let prefix = key(prefix);
    let mut cursor = None;
    let mut cursors = BTreeSet::new();
    let mut rows = BTreeMap::new();
    loop {
        let page = store
            .query(QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: prefix.clone(),
                    start: None,
                    end: None,
                },
                reverse: false,
                limit: 256,
                cursor: cursor.clone(),
                now_ms: now,
            })
            .await?;
        for row in page.entries {
            if rows.insert(row.key.0.clone(), row).is_some() {
                return Err(invalid("Profile index scan repeated a row"));
            }
        }
        cursor = page.next_cursor;
        match &cursor {
            Some(c) if !cursors.insert(c.clone()) => {
                return Err(invalid("Profile index scan repeated its cursor"));
            }
            Some(_) => {}
            None => break,
        }
    }
    Ok(rows.into_values().collect())
}
fn upsert(transition: &mut AtomicTransition, key: RecordKey, record: StoredRecord) {
    if let Some(mutation) = transition.mutations.iter_mut().find(|m| match m {
        RecordMutation::Put { key: k, .. } | RecordMutation::Delete { key: k } => *k == key,
    }) {
        *mutation = RecordMutation::Put { key, record };
    } else {
        transition
            .mutations
            .push(RecordMutation::Put { key, record });
    }
}
fn check(transition: &mut AtomicTransition, key: &RecordKey, record: Option<&StoredRecord>) {
    transition.checks.push(RevisionCheck {
        key: key.clone(),
        expected_revision: record.map(|r| r.revision.clone()),
    });
}

pub(crate) async fn bind<S: QueryStore>(
    store: &S,
    input: &crate::profile_bindings::Write<'_>,
    transition: &mut AtomicTransition,
) -> Result<(), GatewayError> {
    let p = input.parts;
    if starts(p, &["uos_ai", "api_key_usage", "v3"]) && p.len() >= 7 {
        let window_parts = vec![
            json!("uos_ai"),
            json!("api_key_usage"),
            json!("v3"),
            json!("window"),
            p[4].clone(),
            p[5].clone(),
            p[6].clone(),
        ];
        let window_key = key(json!(window_parts));
        let observed = store.read(&window_key).await?;
        let current = if window_key == *input.key {
            Some(input.record.clone())
        } else {
            observed.clone()
        };
        if let Some(mut current) = current
            && let Ok(value) = current.json_value()
            && gateway_admin_data::migration::audit::valid_api_window(value)
            && value["key_id"] == p[4]
            && value["policy_version"] == p[5]
            && value["window_start_ms"] == p[6]
        {
            let prefix = json!(["uos_ai", "api_key_usage", "v3", "request", p[4], p[5], p[6]]);
            let mut rows = scan(store, prefix, input.now).await?;
            for row in &rows {
                check(transition, &row.key, Some(&row.record));
            }
            rows.retain(|r| r.key != *input.key);
            if p[3] == "request" {
                rows.push(QueryEntry {
                    key: input.key.clone(),
                    record: input.record.clone(),
                });
            }
            let mut reservations = BTreeMap::new();
            for row in rows {
                let rp = parts(&row.key)?;
                let Ok(v) = row.record.json_value() else {
                    continue;
                };
                if rp.len() == 8
                    && gateway_admin_data::migration::audit::valid_api_request(v)
                    && v["state"] == "reserved"
                    && v["key_id"] == p[4]
                    && rp[7] == v["request_id"]
                    && let (Some(id), Some(lease)) =
                        (v["request_id"].as_str(), v["lease_expires_at_ms"].as_i64())
                {
                    reservations.insert(id.to_owned(), lease);
                }
            }
            if current.value["reserved_requests"].as_i64() == Some(reservations.len() as i64) {
                current.value["reservations"] = json!(reservations);
            } else if let Some(value) = current.value.as_object_mut() {
                value.remove("reservations");
            }
            current.revision = input.revision.into();
            check(transition, &window_key, observed.as_ref());
            upsert(transition, window_key, current);
        }
    }
    if starts(p, &["uos_ai", "kernel_quota", "v2"]) && p.len() >= 5 {
        let Some(kind) = p[3].as_str() else {
            return Ok(());
        };
        if !kind.ends_with("_window") && !kind.ends_with("_reservation") {
            return Ok(());
        }
        let scope = if kind.starts_with("repo_") {
            "repo"
        } else if kind.starts_with("org_") {
            "org"
        } else {
            return Ok(());
        };
        let mut window_parts = vec![
            json!("uos_ai"),
            json!("kernel_quota"),
            json!("v2"),
            json!(format!("{scope}_window")),
            p[4].clone(),
        ];
        if scope == "repo" {
            if p.len() < 6 {
                return Ok(());
            }
            window_parts.push(p[5].clone());
        }
        let window_key = key(json!(window_parts));
        let observed = store.read(&window_key).await?;
        let current = if window_key == *input.key {
            Some(input.record.clone())
        } else {
            observed.clone()
        };
        if let Some(mut current) = current
            && let Ok(source) =
                crate::inverse::inverse_value(Transform::KernelWindow, &current, None)
                    .or_else(|_| current.portable_value())
            && let Some(source) = source.to_json_lossless()
            && let (Some(owner), repo) = (
                p[4].as_str(),
                if scope == "repo" { p[5].as_str() } else { None },
            )
            && let Some(source) =
                gateway_admin_data::migration::kernel::normalize_window(&source, scope, owner, repo)
        {
            let mut prefix = vec![
                json!("uos_ai"),
                json!("kernel_quota"),
                json!("v2"),
                json!(format!("{scope}_reservation")),
                json!(owner),
            ];
            if let Some(repo) = repo {
                prefix.push(json!(repo));
            }
            prefix.push(source["created_at_ms"].clone());
            let mut rows = scan(store, json!(prefix), input.now).await?;
            for row in &rows {
                check(transition, &row.key, Some(&row.record));
            }
            rows.retain(|r| r.key != *input.key);
            if kind.ends_with("_reservation") {
                rows.push(QueryEntry {
                    key: input.key.clone(),
                    record: input.record.clone(),
                });
            }
            let mut reservations = BTreeMap::new();
            for row in rows {
                let rp = parts(&row.key)?;
                let source =
                    crate::inverse::inverse_value(Transform::KernelRequest, &row.record, None)
                        .or_else(|_| row.record.portable_value())?;
                let Some(v) = source.to_json_lossless() else {
                    continue;
                };
                if let Some(v) = gateway_admin_data::migration::kernel::normalize_reservation(
                    &v, scope, owner, repo,
                ) && v["state"] == "reserved"
                    && v["window_created_at_ms"] == source_value_created(&current)?
                    && rp.last() == v.get("request_id")
                    && let (Some(id), Some(lease)) =
                        (v["request_id"].as_str(), v["lease_expires_at_ms"].as_i64())
                {
                    reservations.insert(id.to_owned(), lease);
                }
            }
            // Keep source reserved_requests as imported; only the source's explicit
            // missing-aggregate postpass may repair it after all lines arrive.
            if current.value["reserved_requests"].as_i64() == Some(reservations.len() as i64) {
                current.value["reservations"] = json!(reservations);
            } else if let Some(value) = current.value.as_object_mut() {
                value.remove("reservations");
            }
            current.revision = input.revision.into();
            check(transition, &window_key, observed.as_ref());
            upsert(transition, window_key, current);
        }
    }
    if starts(p, &["uos_ai", "paid_fallback", "v3", "pending"])
        || starts(p, &["uos_ai", "paid_fallback", "v3", "reconciliation_gate"])
    {
        use gateway_authority::paid::{PendingPaid, ReconciliationGate};
        let gate_key = gateway_authority::keys::paid_gate();
        let observed = store.read(&gate_key).await?;
        let current = if gate_key == *input.key {
            Some(input.record.clone())
        } else {
            observed.clone()
        };
        let mut gate = match current
            .as_ref()
            .map(|r| r.json_value())
            .transpose()?
            .map(|v| serde_json::from_value::<ReconciliationGate>(v.clone()))
            .transpose()
        {
            Ok(Some(g)) => g,
            Ok(None) => ReconciliationGate {
                next_due_at_ms: None,
                pending: BTreeMap::new(),
            },
            Err(_) => return Ok(()),
        };
        let mut rows = scan(
            store,
            json!(["uos_ai", "paid_fallback", "v3", "pending"]),
            input.now,
        )
        .await?;
        for row in &rows {
            check(transition, &row.key, Some(&row.record));
        }
        rows.retain(|r| r.key != *input.key);
        if p[3] == "pending" {
            rows.push(QueryEntry {
                key: input.key.clone(),
                record: input.record.clone(),
            });
        }
        for row in rows {
            let rp = parts(&row.key)?;
            if let Ok(v) = row.record.json_value()
                && let Ok(marker) = serde_json::from_value::<PendingPaid>(v.clone())
                && rp.len() == 6
                && rp[4] == marker.key_id.0
                && rp[5] == marker.attempt_id.0
            {
                gate.pending.insert(
                    json!([marker.key_id.0, marker.attempt_id.0]).to_string(),
                    marker,
                );
            }
        }
        let next = gate
            .pending
            .values()
            .map(|p| p.next_reconciliation_at_ms)
            .min();
        gate.next_due_at_ms = match (gate.next_due_at_ms, next) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        check(transition, &gate_key, observed.as_ref());
        upsert(
            transition,
            gate_key,
            StoredRecord::json(input.revision, json!(gate), None),
        );
    }
    Ok(())
}

fn source_value_created(record: &StoredRecord) -> Result<Value, GatewayError> {
    Ok(record.json_value()?["created_at_ms"].clone())
}

pub(crate) async fn finish_kernel<S: QueryStore, H: crate::profile_runtime::ProfileHost>(
    store: &S,
    host: &H,
    windows: &BTreeSet<String>,
    now: i64,
) -> Result<(), GatewayError> {
    use gateway_admin_data::migration::{ObservedRow, kernel};
    for key in windows {
        let key = RecordKey(key.clone());
        let Some(record) = store.read(&key).await? else {
            continue;
        };
        let p = parts(&key)?;
        let source = crate::inverse::inverse_value(Transform::KernelWindow, &record, None)
            .or_else(|_| record.portable_value())?;
        let Some(value) = source.to_json_lossless() else {
            continue;
        };
        let window = ObservedRow {
            key: key.clone(),
            parts: p.clone(),
            record: StoredRecord::json(&record.revision, value, record.expires_at_ms),
        };
        let Some((scope, owner, repo)) = kernel::identity(&p, "window") else {
            continue;
        };
        let mut prefix = vec![
            json!("uos_ai"),
            json!("kernel_quota"),
            json!("v2"),
            json!(format!("{scope}_reservation")),
            json!(owner),
        ];
        if let Some(repo) = repo {
            prefix.push(json!(repo));
        }
        let mut reservations = Vec::new();
        for entry in scan(store, json!(prefix), now).await? {
            let parts = parts(&entry.key)?;
            let source =
                crate::inverse::inverse_value(Transform::KernelRequest, &entry.record, None)
                    .or_else(|_| entry.record.portable_value())?;
            if let Some(value) = source.to_json_lossless() {
                reservations.push(ObservedRow {
                    key: entry.key,
                    parts,
                    record: StoredRecord::json(
                        entry.record.revision,
                        value,
                        entry.record.expires_at_ms,
                    ),
                });
            }
        }
        let revision = host.next_revision()?;
        let Some(mut transition) =
            kernel::reconcile_imported_window(&window, &reservations, true, now, &revision)?
        else {
            continue;
        };
        let Some(RecordMutation::Put { record: next, .. }) = transition.mutations.first_mut()
        else {
            return Err(invalid("Kernel reconciliation has no write"));
        };
        *next = crate::profile_runtime::project(&key, &p, next.clone())?;
        let next = next.clone();
        crate::profile_bindings::bind(
            store,
            crate::profile_bindings::Write {
                key: &key,
                parts: &p,
                record: &next,
                previous: Some(&record),
                now,
                revision: &revision,
            },
            &mut transition,
        )
        .await?;
        if store.commit(transition).await? != CommitOutcome::Committed {
            return Err(invalid(
                "Kernel window changed during profile reconciliation",
            ));
        }
    }
    Ok(())
}
