//! Source-profile writes and their secretless derived indexes share one CAS.
use crate::*;
use gateway_core::{
    query::QueryStore,
    state::{AtomicTransition, RecordMutation, RevisionCheck},
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

async fn prospective<S: QueryStore>(
    store: &S,
    written: &RecordKey,
    record: &StoredRecord,
    key: &RecordKey,
    checks: &mut Vec<RevisionCheck>,
) -> Result<Option<StoredRecord>, GatewayError> {
    if key == written {
        return Ok(Some(record.clone()));
    }
    let observed = store.read(key).await?;
    checks.push(RevisionCheck {
        key: key.clone(),
        expected_revision: observed.as_ref().map(|r| r.revision.clone()),
    });
    Ok(observed)
}

pub(crate) struct Write<'a> {
    pub key: &'a RecordKey,
    pub parts: &'a [Value],
    pub record: &'a StoredRecord,
    pub previous: Option<&'a StoredRecord>,
    pub now: i64,
    pub revision: &'a str,
}
pub(crate) async fn bind<S: QueryStore>(
    store: &S,
    input: Write<'_>,
    transition: &mut AtomicTransition,
) -> Result<(), GatewayError> {
    crate::profile_coupling::bind(store, &input, transition).await?;
    let Write {
        key: written,
        parts: p,
        record,
        previous,
        now,
        revision,
    } = input;
    if p.len() == 2
        && p[0] == "default"
        && ["kernel_policy_limit_requests", "kernel_policy_window_ms"]
            .iter()
            .any(|name| p[1] == *name)
    {
        let mut defaults = gateway_authority::quota::KernelDefaults::default();
        for name in ["kernel_policy_limit_requests", "kernel_policy_window_ms"] {
            let key = key(json!(["default", name]));
            if let Some(row) =
                prospective(store, written, record, &key, &mut transition.checks).await?
                && let Ok(value) = row.json_value()
            {
                if name == "kernel_policy_limit_requests" {
                    defaults.usage_limit_requests =
                        gateway_admin_runtime::parse::limit(value).unwrap_or(-1);
                } else {
                    defaults.window_ms =
                        gateway_admin_runtime::parse::positive(value).unwrap_or(604800000);
                }
            }
        }
        transition.mutations.push(RecordMutation::Put {
            key: gateway_authority::keys::kernel_defaults(),
            record: StoredRecord::json(revision, json!(defaults), None),
        });
    }
    if starts(p, &["ubq_ai", "api_keys", "id"]) || starts(p, &["ubq_ai", "api_keys", "hash"]) {
        let mut ids = BTreeSet::new();
        if p.len() == 4
            && p[2] == "id"
            && let Some(id) = p[3].as_str()
        {
            ids.insert(id.to_owned());
        }
        for row in [previous, Some(record)].into_iter().flatten() {
            if let Ok(value) = row.json_value()
                && gateway_admin_data::migration::audit::api_id(value.get("id"))
                && let Some(id) = value.get("id").and_then(Value::as_str)
            {
                ids.insert(id.into());
            }
        }
        for id in ids {
            let derived = gateway_authority::keys::api_policy(&id);
            let id_key = gateway_auth::api_keys::id_key(&id);
            let row = prospective(store, written, record, &id_key, &mut transition.checks).await?;
            let parsed = row
                .as_ref()
                .and_then(|r| r.json_value().ok())
                .and_then(|v| {
                    serde_json::from_value::<gateway_admin::keys::ApiKeyRecord>(v.clone()).ok()
                })
                .filter(|r| r.policy.id == id && r.policy.usage_quota_version == 3);
            let mut policy = None;
            if let Some(parsed) = parsed {
                let hash_key = gateway_auth::api_keys::hash_key(&parsed.hash);
                let hash =
                    prospective(store, written, record, &hash_key, &mut transition.checks).await?;
                if let Some(hash) = hash
                    .and_then(|r| r.json_value().ok().cloned())
                    .and_then(|v| {
                        serde_json::from_value::<gateway_auth::api_keys::ApiKeyHashRecord>(v).ok()
                    })
                    && hash == parsed.policy
                    && row.as_ref().is_some_and(|r| {
                        r.json_value().is_ok_and(|v| {
                            gateway_admin_data::migration::audit::valid_key_policy(v, true)
                        })
                    })
                {
                    policy = Some(gateway_admin::keys::authority_policy(&parsed, now));
                }
            }
            transition.mutations.push(if let Some(policy) = policy {
                RecordMutation::Put {
                    key: derived,
                    record: StoredRecord::json(revision, json!(policy), None),
                }
            } else {
                RecordMutation::Delete { key: derived }
            });
        }
    }
    if starts(p, &["uos_ai", "auth", "sessions"])
        && p.len() == 4
        && let Some(token) = p[3].as_str()
    {
        let index =
            gateway_auth::session_index::index_key(&gateway_auth::session_index::digest(token))?;
        let session = record
            .json_value()
            .ok()
            .and_then(|v| {
                serde_json::from_value::<gateway_auth::passkeys::PasskeySession>(v.clone()).ok()
            })
            .filter(|s| s.token == token)
            .and_then(|session| {
                gateway_auth::session_index::record_for_session(
                    &session,
                    &record.revision,
                    record.expires_at_ms,
                )
                .ok()
            });
        transition.mutations.push(if let Some(record) = session {
            RecordMutation::Put { key: index, record }
        } else {
            RecordMutation::Delete { key: index }
        });
    }
    // A source write and an index can name the same key only through a bug.
    let mut keys = BTreeSet::new();
    if transition.mutations.iter().any(|m| {
        !keys.insert(match m {
            RecordMutation::Put { key, .. } | RecordMutation::Delete { key } => key.0.clone(),
        })
    }) {
        return Err(invalid("Profile index transition repeats a key"));
    }
    let mut checks = BTreeMap::new();
    for check in std::mem::take(&mut transition.checks) {
        if let Some(previous) = checks.insert(check.key.0, check.expected_revision.clone())
            && previous != check.expected_revision
        {
            return Err(invalid("Profile index facts changed during preparation"));
        }
    }
    transition.checks = checks
        .into_iter()
        .map(|(key, expected_revision)| RevisionCheck {
            key: RecordKey(key),
            expected_revision,
        })
        .collect();
    Ok(())
}
