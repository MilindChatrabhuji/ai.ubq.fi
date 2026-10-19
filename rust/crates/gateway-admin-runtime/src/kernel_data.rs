//! Named kernel administrative source-data views and finite record codecs only.
//! No reservation/index permission, new namespace, or generic storage interpretation.
use crate::{parse, store};
use gateway_admin::source_input as body;
use gateway_auth::invalid;
use gateway_authority::quota::{KernelPolicy, KernelWindow};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{RecordKey, RecordMutation, StoredRecord},
    tuple_key::{DecodedKeyPart, TupleKey},
};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) type SourcePolicy = KernelPolicy<JsString16, f64>;
pub(crate) type SourceWindow = KernelWindow<JsString16>;
pub(crate) fn part(value: Option<&SourceJson>) -> Option<JsString16> {
    value
        .and_then(body::text)
        .map(|v| body::trim(&v))
        .filter(|v| {
            !v.as_units().is_empty()
                && v.as_units().len() <= 100
                && !v
                    .as_units()
                    .iter()
                    .any(|u| body::whitespace(*u) || *u == 47)
        })
}
fn scope(value: Option<&SourceJson>) -> bool {
    value
        .and_then(body::text)
        .map(|s| body::trim(&s))
        .and_then(|s| s.try_utf8().ok())
        .is_some_and(|s| s.eq_ignore_ascii_case("org"))
}
pub(crate) fn target(value: &SourceJson) -> Result<(JsString16, Option<JsString16>), GatewayError> {
    let owner =
        part(body::member(value, "owner").as_ref()).ok_or_else(|| invalid("owner is required"))?;
    let repo = part(body::member(value, "repo").as_ref());
    let selected = body::member(value, "scope").filter(|v| v.as_str() != "null");
    let org = selected.as_ref().map_or(repo.is_none(), |v| scope(Some(v)));
    if org && repo.is_some() {
        return Err(invalid("repo must be omitted for scope=org"));
    }
    if !org && repo.is_none() {
        return Err(invalid("repo is required for scope=repo"));
    }
    Ok((owner, repo))
}
pub(crate) fn data_value(
    row: Option<&StoredRecord>,
    now: i64,
) -> Result<Option<SourceJson>, GatewayError> {
    let Some(row) = row else { return Ok(None) };
    row.validate_version()?;
    if row.expires_at_ms.is_some_and(|at| at <= now) {
        return Ok(None);
    }
    decode_source_control_record(row).map(Some)
}
pub(crate) async fn data_read<S: gateway_core::state::AuthorityStore>(
    store: &S,
    key: &RecordKey,
    now: i64,
) -> Result<Option<SourceJson>, GatewayError> {
    data_value(store.read(key).await?.as_ref(), now)
}
pub(crate) fn data_put(
    key: RecordKey,
    document: &SourceJson,
    expiry: Option<i64>,
    revision: &str,
) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key,
        record: encode_source_control_record(revision, document, expiry)?,
    })
}
fn scalar(value: &SourceJson) -> Option<Value> {
    value.deserialize().ok()
}
pub(crate) fn limit(value: &SourceJson) -> Option<i64> {
    scalar(value).as_ref().and_then(parse::limit)
}
pub(crate) fn positive(value: &SourceJson) -> Option<i64> {
    scalar(value).as_ref().and_then(parse::positive)
}
pub(crate) fn expiry(value: &SourceJson, now: i64) -> Option<f64> {
    let value = scalar(value)?;
    if !value.is_number() && !value.is_string() {
        return None;
    }
    let n = gateway_admin_data::profile::js_number(&value).trunc();
    (n.is_finite() && (n == -1.0 || n > now as f64)).then_some(n)
}
pub(crate) fn decode_policy(
    value: SourceJson,
    owner: &JsString16,
    repo: Option<&JsString16>,
) -> Result<SourcePolicy, GatewayError> {
    let value = if body::member(&value, "scope").is_some() {
        SourcePolicy::normalize_source_document(&value, owner, repo)
            .ok_or_else(|| store::corrupt("Kernel quota policy is malformed"))?
    } else {
        value
    };
    let policy: SourcePolicy = value
        .deserialize()
        .map_err(|_| store::corrupt("Kernel quota policy is malformed"))?;
    if policy.v != 2
        || policy.owner != *owner
        || policy.repo.as_ref() != repo
        || policy.usage_limit_requests < -1
        || policy.window_ms <= 0
        || !policy.expires_at_ms.is_finite()
        || policy.expires_at_ms < -1.0
    {
        return Err(store::corrupt("Kernel quota policy is malformed"));
    }
    Ok(policy)
}
pub(crate) fn validate_window(
    value: SourceJson,
    owner: &JsString16,
    repo: Option<&JsString16>,
) -> Result<SourceWindow, GatewayError> {
    let window: SourceWindow = value
        .deserialize()
        .map_err(|_| store::corrupt("Kernel quota window is malformed or unbound"))?;
    if window.v != 2
        || window.owner != *owner
        || window.repo.as_ref() != repo
        || window.reserved_requests != window.reservations.len() as i64
        || window.usage_requests < 0
        || window.applied_window_ms <= 0
        || window.usage_reset_at_ms <= window.created_at_ms
        || body::member(&value, "scope").is_some()
            && SourceWindow::normalize_source_document(&value, owner, repo).is_none()
    {
        return Err(store::corrupt("Kernel quota window is malformed"));
    }
    Ok(window)
}
pub(crate) fn new_window(
    owner: &JsString16,
    repo: Option<&JsString16>,
    window_ms: i64,
    now: i64,
) -> SourceWindow {
    SourceWindow {
        v: 2,
        owner: owner.clone(),
        repo: repo.cloned(),
        usage_requests: 0,
        reserved_requests: 0,
        created_at_ms: now,
        usage_reset_at_ms: now + window_ms,
        applied_window_ms: window_ms,
        updated_at_ms: now,
        reservations: BTreeMap::new(),
    }
}
pub(crate) fn canonical(document: SourceJson) -> SourceJson {
    source::canonical(&document).expect("typed finite kernel data")
}
pub(crate) fn identity_fields(
    owner: &JsString16,
    repo: Option<&JsString16>,
) -> Vec<(&'static str, SourceJson)> {
    let mut fields = vec![("owner", body::json(owner))];
    if let Some(repo) = repo {
        fields.push(("repo", body::json(repo)));
    }
    fields
}
pub(crate) fn window_document(window: &SourceWindow) -> SourceJson {
    let mut fields = vec![
        ("v", body::json(&2)),
        (
            "scope",
            body::json(if window.repo.is_some() { "repo" } else { "org" }),
        ),
    ];
    fields.extend(identity_fields(&window.owner, window.repo.as_ref()));
    fields.extend([
        ("usage_requests", body::json(&window.usage_requests)),
        ("reserved_requests", body::json(&window.reserved_requests)),
        ("usage_reset_at_ms", body::json(&window.usage_reset_at_ms)),
        ("applied_window_ms", body::json(&window.applied_window_ms)),
        ("created_at_ms", body::json(&window.created_at_ms)),
        ("updated_at_ms", body::json(&window.updated_at_ms)),
    ]);
    if !window.reservations.is_empty() {
        fields.push(("reservations", body::json(&window.reservations)));
    }
    canonical(body::object(fields))
}
pub(crate) fn summary(policy: &SourcePolicy, window: &SourceWindow, now: i64) -> SourceJson {
    summary_document(policy, &window_document(window), now)
}
pub(crate) fn summary_document(policy: &SourcePolicy, window: &SourceJson, now: i64) -> SourceJson {
    let number = |name| body::member(window, name).expect("normalized source window number");
    let created = number("created_at_ms");
    let updated = number("updated_at_ms");
    let mut fields = identity_fields(&policy.owner, policy.repo.as_ref());
    fields.extend([
        (
            "usage_limit_requests",
            body::json(&policy.usage_limit_requests),
        ),
        ("usage_requests", number("usage_requests")),
        ("usage_reset_at_ms", number("usage_reset_at_ms")),
        ("window_ms", body::json(&policy.window_ms)),
        ("expires_at_ms", body::json(&policy.expires_at_ms)),
        (
            "created_at_ms",
            if body::number(&created) == Some(0.0) {
                body::json(&now)
            } else {
                created
            },
        ),
        (
            "updated_at_ms",
            body::json(&body::number(&updated).unwrap_or(now as f64).max(now as f64)),
        ),
    ]);
    canonical(body::object(fields))
}
pub(crate) fn source_truth(value: &SourceJson) -> bool {
    !matches!(value.as_str(), "null" | "false")
        && body::number(value).is_none_or(|n| n != 0.0 && !n.is_nan())
        && body::text(value).is_none_or(|s| !s.as_units().is_empty())
}
pub(crate) fn physical_labels(
    key: &RecordKey,
    org: bool,
) -> Result<Option<(JsString16, Option<JsString16>)>, GatewayError> {
    let parts = TupleKey::from_record_key(key)?.decoded_parts()?;
    let label = |at| match parts.get(at) {
        Some(DecodedKeyPart::String(bytes)) => {
            let decoded = String::from_utf8_lossy(bytes);
            let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
            (!decoded.is_empty()).then(|| JsString16::from_utf8(decoded))
        }
        _ => None,
    };
    let Some(owner) = label(4) else {
        return Ok(None);
    };
    let repo = if org {
        None
    } else {
        let Some(repo) = label(5) else {
            return Ok(None);
        };
        Some(repo)
    };
    Ok(Some((owner, repo)))
}
