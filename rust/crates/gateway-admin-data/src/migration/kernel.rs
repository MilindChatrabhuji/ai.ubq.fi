use super::{ObservedRow, check, key, put, starts};
use crate::{error, integer, json_number, number, present, text};
use gateway_core::{
    GatewayError,
    state::{AtomicTransition, RecordMutation},
};
use serde_json::{Value, json};

pub fn identity(parts: &[Value], kind: &str) -> Option<(String, String, Option<String>)> {
    if !starts(parts, &["uos_ai", "kernel_quota", "v2"]) {
        return None;
    }
    let name = parts.get(3)?.as_str()?;
    let scope = if name == format!("repo_{kind}") {
        "repo"
    } else if name == format!("org_{kind}") {
        "org"
    } else {
        return None;
    };
    let owner = parts.get(4)?.as_str().filter(|s| !s.is_empty())?.to_owned();
    let repo = if scope == "repo" {
        Some(parts.get(5)?.as_str().filter(|s| !s.is_empty())?.to_owned())
    } else {
        None
    };
    if kind != "reservation" && parts.len() != if scope == "repo" { 6 } else { 5 } {
        return None;
    }
    Some((scope.into(), owner, repo))
}
fn valid_identity(value: &Value, scope: &str, owner: &str, repo: Option<&str>) -> bool {
    value.is_object()
        && value["v"] == 2
        && text(value, "scope") == Some(scope)
        && text(value, "owner") == Some(owner)
        && if scope == "repo" {
            text(value, "repo") == repo
        } else {
            value.get("repo").is_none_or(Value::is_null)
        }
}
pub fn normalize_policy(
    value: &Value,
    scope: &str,
    owner: &str,
    repo: Option<&str>,
) -> Option<Value> {
    if !valid_identity(value, scope, owner, repo)
        || integer(value, "created_at_ms").is_none()
        || integer(value, "updated_at_ms").is_none()
    {
        return None;
    }
    let window = legacy_number(value.get("window_ms"), 0.0);
    let limit = legacy_number(value.get("usage_limit_requests"), f64::NAN);
    if !(window > 0.0
        && window <= 9_007_199_254_740_991.0
        && (limit == -1.0 || (0.0..=9_007_199_254_740_991.0).contains(&limit)))
    {
        return None;
    }
    let expiration = number(value, "expires_at_ms")
        .filter(|v| v.is_finite())
        .map(f64::trunc)
        .filter(|v| *v == -1.0 || *v >= 0.0)
        .unwrap_or(-1.0);
    let mut output = json!({"v":2,"scope":scope,"owner":owner,"usage_limit_requests":json_number(Some(limit)),"window_ms":json_number(Some(window)),"expires_at_ms":json_number(Some(expiration)),"created_at_ms":value["created_at_ms"],"updated_at_ms":value["updated_at_ms"]});
    if let Some(repo) = repo.filter(|_| scope == "repo") {
        output["repo"] = json!(repo);
    }
    Some(output)
}
pub fn normalize_window(
    value: &Value,
    scope: &str,
    owner: &str,
    repo: Option<&str>,
) -> Option<Value> {
    if !valid_identity(value, scope, owner, repo) {
        return None;
    }
    for field in ["usage_requests", "created_at_ms", "updated_at_ms"] {
        integer(value, field)?;
    }
    if integer(value, "usage_reset_at_ms")? <= 0 || integer(value, "applied_window_ms")? <= 0 {
        return None;
    }
    let reserved = if value.get("reserved_requests").is_none() {
        0
    } else {
        integer(value, "reserved_requests")?
    };
    let mut result = json!({"v":2,"scope":scope,"owner":owner,"usage_requests":value["usage_requests"],"reserved_requests":reserved,"usage_reset_at_ms":value["usage_reset_at_ms"],"applied_window_ms":value["applied_window_ms"],"created_at_ms":value["created_at_ms"],"updated_at_ms":value["updated_at_ms"]});
    if let Some(repo) = repo.filter(|_| scope == "repo") {
        result["repo"] = json!(repo);
    }
    Some(result)
}
pub fn normalize_reservation(
    value: &Value,
    scope: &str,
    owner: &str,
    repo: Option<&str>,
) -> Option<Value> {
    if !valid_identity(value, scope, owner, repo)
        || text(value, "request_id")?.is_empty()
        || text(value, "route")?.is_empty()
    {
        return None;
    }
    let created = integer(value, "window_created_at_ms")?;
    let reset = integer(value, "window_reset_at_ms")?;
    let reserved = integer(value, "reserved_at_ms")?;
    let lease = integer(value, "lease_expires_at_ms")?;
    if reset <= created || lease <= reserved {
        return None;
    }
    let state = text(value, "state")?;
    if !["reserved", "committed", "released"].contains(&state) {
        return None;
    }
    let intent = present(value, "terminal_intent");
    if !intent.is_null() && intent != "committed" && intent != "released" {
        return None;
    }
    for field in ["committed_at_ms", "released_at_ms"] {
        if !value.get(field)?.is_null() {
            integer(value, field)?;
        }
    }
    if !value.get("release_reason")?.is_null() && text(value, "release_reason").is_none() {
        return None;
    }
    let commit = value["committed_at_ms"].is_null();
    let release = value["released_at_ms"].is_null();
    let reason = value["release_reason"].is_null();
    if (state == "reserved" && (!commit || !release || !reason))
        || (state == "committed" && (commit || !release || !reason || intent == "released"))
        || (state == "released"
            && (!commit
                || release
                || text(value, "release_reason").is_none_or(|s| s.trim().is_empty())
                || intent == "committed"))
    {
        return None;
    }
    let mut result = value.clone();
    result["terminal_intent"] = intent;
    Some(result)
}

/// Source import only repairs newly imported windows whose reserved aggregate was absent.
pub fn reconcile_imported_window(
    window: &ObservedRow,
    reservations: &[ObservedRow],
    complete: bool,
    now: i64,
    new_revision: &str,
) -> Result<Option<AtomicTransition>, GatewayError> {
    if !complete {
        return Err(error(
            "A complete reservation scan is required before aggregate reconciliation.",
        ));
    }
    let Some((scope, owner, repo)) = identity(&window.parts, "window") else {
        return Ok(None);
    };
    let raw = window.value()?;
    let Some(mut value) = normalize_window(raw, &scope, &owner, repo.as_deref()) else {
        return Ok(None);
    };
    if raw.get("reserved_requests").is_some() {
        return Ok(None);
    }
    let created = value["created_at_ms"].clone();
    let mut prefix = vec![
        json!("uos_ai"),
        json!("kernel_quota"),
        json!("v2"),
        json!(format!("{scope}_reservation")),
        json!(owner),
    ];
    if let Some(repo) = &repo {
        prefix.push(json!(repo));
    }
    prefix.push(created.clone());
    let mut count = 0;
    for row in reservations {
        if row.parts.len() < prefix.len() || row.parts[..prefix.len()] != prefix[..] {
            continue;
        }
        if let Some(reservation) =
            normalize_reservation(row.value()?, &scope, &owner, repo.as_deref())
            && row.parts.last().and_then(Value::as_str) == text(&reservation, "request_id")
            && reservation["window_created_at_ms"] == created
            && reservation["state"] == "reserved"
        {
            count += 1;
        }
    }
    value["reserved_requests"] = json!(count);
    let expiry = integer(&value, "usage_reset_at_ms")
        .and_then(|t| t.checked_add(7 * super::retention::DAY))
        .ok_or_else(|| error("Kernel retention overflows."))?
        .max(now.saturating_add(1));
    Ok(Some(AtomicTransition {
        checks: vec![check(window)],
        mutations: vec![put(window.key.clone(), value, Some(expiry), new_revision)],
    }))
}

pub fn legacy_number(value: Option<&Value>, fallback: f64) -> f64 {
    let number = match value {
        Some(Value::String(s)) => super::super::profile::js_number(&Value::String(s.clone())),
        Some(v) => v.as_f64().unwrap_or(f64::NAN),
        None => f64::NAN,
    };
    if number.is_finite() {
        number.trunc()
    } else {
        fallback
    }
}
pub fn normalize_legacy_limit(
    value: &Value,
    default_limit: f64,
    default_window: f64,
    now: f64,
) -> Option<Value> {
    if !value.is_object() && !value.is_array() {
        return None;
    }
    let limit = legacy_number(value.get("usage_limit_requests"), default_limit);
    let usage = legacy_number(value.get("usage_requests"), 0.0).max(0.0);
    let window = legacy_number(value.get("window_ms"), default_window);
    let reset = legacy_number(value.get("usage_reset_at_ms"), now + window.max(1.0));
    let expiry = legacy_number(value.get("expires_at_ms"), -1.0);
    if !(limit == -1.0 || limit >= 0.0)
        || window <= 0.0
        || reset <= 0.0
        || !(expiry == -1.0 || expiry >= 0.0)
    {
        return None;
    }
    let mut row = json!({});
    for (field, v) in [
        ("usage_limit_requests", limit),
        ("usage_requests", usage),
        ("window_ms", window),
        ("usage_reset_at_ms", reset),
        ("expires_at_ms", expiry),
        (
            "created_at_ms",
            legacy_number(value.get("created_at_ms"), now).max(0.0),
        ),
        (
            "updated_at_ms",
            legacy_number(value.get("updated_at_ms"), now).max(0.0),
        ),
    ] {
        row[field] = json_number(Some(v));
    }
    Some(row)
}

/// Existing V2 policy wins. Otherwise source policy/window creation and legacy deletion are atomic.
pub struct LegacyKernelContext<'a> {
    pub default_limit: f64,
    pub default_window: f64,
    pub now: i64,
    pub new_revision: &'a str,
    pub reservations_complete: bool,
}
pub fn plan_legacy_kernel(
    legacy: &ObservedRow,
    policy: Option<&ObservedRow>,
    window: Option<&ObservedRow>,
    reservations: &[ObservedRow],
    context: LegacyKernelContext<'_>,
) -> Result<AtomicTransition, GatewayError> {
    let LegacyKernelContext {
        default_limit,
        default_window,
        now,
        new_revision,
        reservations_complete,
    } = context;
    let scope = if starts(&legacy.parts, &["ubq_ai", "kernel_auth", "limits"]) {
        "repo"
    } else if starts(&legacy.parts, &["ubq_ai", "kernel_auth", "org_limits"]) {
        "org"
    } else {
        return Err(error("Legacy kernel prefix is malformed."));
    };
    let owner = legacy
        .parts
        .get(3)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error("Legacy kernel owner is malformed."))?;
    let repo = if scope == "repo" {
        Some(
            legacy
                .parts
                .get(4)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| error("Legacy kernel repository is malformed."))?,
        )
    } else {
        None
    };
    let value = normalize_legacy_limit(legacy.value()?, default_limit, default_window, now as f64)
        .ok_or_else(|| error("Legacy kernel value is malformed."))?;
    let mut policy_parts = vec![
        json!("uos_ai"),
        json!("kernel_quota"),
        json!("v2"),
        json!(format!("{scope}_policy")),
        json!(owner),
    ];
    if let Some(repo) = repo {
        policy_parts.push(json!(repo));
    }
    let policy_key = key(&policy_parts)?;
    policy_parts[3] = json!(format!("{scope}_window"));
    let window_key = key(&policy_parts)?;
    let mut checks = vec![
        check(legacy),
        super::RevisionCheck {
            key: policy_key.clone(),
            expected_revision: policy.map(|r| r.record.revision.clone()),
        },
        super::RevisionCheck {
            key: window_key.clone(),
            expected_revision: window.map(|r| r.record.revision.clone()),
        },
    ];
    if let Some(policy) = policy
        && super::audit::valid_kernel_policy(policy.value()?, scope, owner, repo)
    {
        return Ok(AtomicTransition {
            checks,
            mutations: vec![RecordMutation::Delete {
                key: legacy.key.clone(),
            }],
        });
    }
    let default_backed = value["expires_at_ms"] == -1
        && number(&value, "usage_limit_requests") == Some(default_limit)
        && number(&value, "window_ms") == Some(default_window);
    let span = if default_backed {
        default_window
    } else {
        number(&value, "window_ms").unwrap_or(default_window)
    };
    if policy.is_some_and(|r| r.key != policy_key) || window.is_some_and(|r| r.key != window_key) {
        return Err(error("Kernel migration snapshot key identity mismatch."));
    }
    let mut current = window
        .map(ObservedRow::value)
        .transpose()?
        .and_then(|v| normalize_window(v, scope, owner, repo));
    if let (Some(observed), Some(current)) = (window, current.as_mut())
        && observed.value()?.get("reserved_requests").is_none()
    {
        if !reservations_complete {
            return Err(error(
                "A complete reservation scan is required before legacy conversion.",
            ));
        }
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
        prefix.push(current["created_at_ms"].clone());
        let mut reserved = 0;
        for row in reservations {
            if row.parts.len() > prefix.len() && row.parts[..prefix.len()] == prefix[..] {
                let r =
                    normalize_reservation(row.value()?, scope, owner, repo).ok_or_else(|| {
                        error("Malformed kernel reservation during legacy migration.")
                    })?;
                if row.parts.len() != prefix.len() + 1
                    || row.parts.last().and_then(Value::as_str) != text(&r, "request_id")
                    || r["window_created_at_ms"] != current["created_at_ms"]
                {
                    return Err(error(
                        "Kernel reservation identity mismatch during legacy migration.",
                    ));
                }
                if r["state"] == "reserved" {
                    reserved += 1;
                }
            }
        }
        current["reserved_requests"] = json!(reserved);
    }
    let same = current.as_ref().is_some_and(|w| {
        number(w, "applied_window_ms") == Some(span)
            && w["usage_reset_at_ms"] == value["usage_reset_at_ms"]
    });
    let mut output = if same {
        let mut w = current.unwrap_or(Value::Null);
        w["usage_requests"] = json_number(Some(
            number(&w, "usage_requests")
                .unwrap_or(0.0)
                .max(number(&value, "usage_requests").unwrap_or(0.0)),
        ));
        w
    } else {
        json!({"v":2,"scope":scope,"owner":owner,"usage_requests":if number(&value,"usage_reset_at_ms").is_some_and(|r|r<=now as f64){json!(0)}else{value["usage_requests"].clone()},"reserved_requests":0,"usage_reset_at_ms":if number(&value,"usage_reset_at_ms").is_some_and(|r|r<=now as f64){json_number(Some(now as f64+span))}else{value["usage_reset_at_ms"].clone()},"applied_window_ms":json_number(Some(span)),"created_at_ms":value["created_at_ms"]})
    };
    output["updated_at_ms"] = json!(now);
    if let Some(repo) = repo {
        output["repo"] = json!(repo);
    }
    let mut migrated_policy = value.clone();
    let object = migrated_policy
        .as_object_mut()
        .ok_or_else(|| error("Malformed legacy policy."))?;
    object.remove("usage_requests");
    object.remove("usage_reset_at_ms");
    object.insert("v".into(), json!(2));
    object.insert("scope".into(), json!(scope));
    object.insert("owner".into(), json!(owner));
    object.insert("updated_at_ms".into(), json!(now));
    if let Some(repo) = repo {
        object.insert("repo".into(), json!(repo));
    }
    let mutations = vec![
        put(window_key, output, None, new_revision),
        RecordMutation::Delete {
            key: legacy.key.clone(),
        },
        if default_backed {
            RecordMutation::Delete { key: policy_key }
        } else {
            put(policy_key, migrated_policy, None, new_revision)
        },
    ];
    Ok(AtomicTransition {
        checks: std::mem::take(&mut checks),
        mutations,
    })
}
