//! Actual response status/headers own proof classification. A caller supplies no exhaustion Boolean.
use crate::quota::{
    Exhaustion, QuotaObservation, QuotaWindow, STANDARD_FAMILIES, StandardWindow, WINDOWS,
};
pub use gateway_core::claude::ClaudeErrorEvidence as ErrorEvidence;
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use gateway_providers::Headers;
use gateway_schema::util::js_trim;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseKind {
    Ok,
    DurableExhaustion,
    TransientRateLimited,
    AuthInvalid,
    RequestRejected,
    WorkspaceRequired,
    WorkspaceNotFound,
    BillingBlocked,
    Forbidden,
    UpstreamError,
}
impl ResponseKind {
    pub fn id(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::DurableExhaustion => "durable_exhaustion",
            Self::TransientRateLimited => "transient_rate_limited",
            Self::AuthInvalid => "auth_invalid",
            Self::RequestRejected => "request_rejected",
            Self::WorkspaceRequired => "workspace_required",
            Self::WorkspaceNotFound => "workspace_not_found",
            Self::BillingBlocked => "billing_blocked",
            Self::Forbidden => "forbidden",
            Self::UpstreamError => "upstream_error",
        }
    }
    pub fn is_configuration(self) -> bool {
        matches!(
            self,
            Self::WorkspaceRequired
                | Self::WorkspaceNotFound
                | Self::BillingBlocked
                | Self::Forbidden
        )
    }
    pub fn health(self) -> &'static str {
        match self {
            Self::Ok => "success",
            Self::DurableExhaustion => "quota_exhausted",
            Self::AuthInvalid => "auth_invalid",
            Self::RequestRejected => "reachable",
            _ => "upstream_error",
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Classification {
    pub kind: ResponseKind,
    pub exhaustion: Option<Exhaustion>,
    pub retry_after_ms: Option<i64>,
    pub detail: Option<JsString16>,
}
pub fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}
fn js_number(value: &Value) -> Option<f64> {
    Some(gateway_admin_data::profile::js_number(value))
}
fn nonnegative(raw: Option<&str>) -> Option<f64> {
    let raw = raw.filter(|s| !js_trim(s).is_empty())?;
    js_number(&Value::String(raw.into())).filter(|n| n.is_finite() && *n >= 0.0)
}
fn reset_header(raw: Option<&str>) -> Option<f64> {
    nonnegative(raw)
        .filter(|n| {
            *n > 0.0 && n.fract() == 0.0 && *n <= gateway_core::identity::MAX_SAFE_INTEGER as f64
        })
        .map(|seconds| seconds * 1000.0)
}
pub fn observe_headers(headers: &Headers, now: i64) -> Option<QuotaObservation> {
    if now <= 0 {
        return None;
    }
    let mut windows = BTreeMap::new();
    let mut standard = BTreeMap::new();
    for id in WINDOWS {
        let prefix = format!("anthropic-ratelimit-unified-{id}");
        let raw_status = header(headers, &format!("{prefix}-status"));
        let status = raw_status
            .filter(|s| !js_trim(s).is_empty())
            .map(str::to_owned);
        let utilization = nonnegative(header(headers, &format!("{prefix}-utilization")));
        let reset_at_ms = reset_header(header(headers, &format!("{prefix}-reset")));
        if raw_status.is_some() || utilization.is_some() || reset_at_ms.is_some() {
            windows.insert(
                id.into(),
                QuotaWindow {
                    status,
                    utilization,
                    reset_at_ms,
                    observed_at_ms: now as f64,
                },
            );
        }
    }
    for id in STANDARD_FAMILIES {
        let prefix = format!("anthropic-ratelimit-{id}");
        let limit = nonnegative(header(headers, &format!("{prefix}-limit")));
        let remaining = nonnegative(header(headers, &format!("{prefix}-remaining")));
        let reset_at_ms = reset_header(header(headers, &format!("{prefix}-reset")));
        if limit.is_some() || remaining.is_some() || reset_at_ms.is_some() {
            standard.insert(
                id.into(),
                StandardWindow {
                    limit,
                    remaining,
                    reset_at_ms,
                    observed_at_ms: now as f64,
                },
            );
        }
    }
    let observation = QuotaObservation {
        windows,
        standard,
        representative_claim: header(headers, "anthropic-ratelimit-unified-representative-claim")
            .filter(|s| !js_trim(s).is_empty())
            .map(str::to_owned),
        observed_at_ms: now as f64,
    };
    (!observation.is_empty()).then_some(observation)
}
pub fn classify_headers(
    status: u16,
    headers: &Headers,
    now: i64,
    parse_date: &impl Fn(&str) -> Option<i64>,
) -> Classification {
    let mut result = Classification {
        kind: ResponseKind::RequestRejected,
        exhaustion: None,
        retry_after_ms: None,
        detail: None,
    };
    result.kind = match status {
        200..=299 => ResponseKind::Ok,
        429 => ResponseKind::TransientRateLimited,
        401 => ResponseKind::AuthInvalid,
        403 => ResponseKind::Forbidden,
        500..=u16::MAX => ResponseKind::UpstreamError,
        _ => ResponseKind::RequestRejected,
    };
    if status == 429 {
        result.exhaustion = observe_headers(headers, now).and_then(|observation| {
            WINDOWS.into_iter().find_map(|id| {
                let window = observation.windows.get(id)?;
                (window
                    .status
                    .as_ref()
                    .is_some_and(|s| js_trim(s).to_lowercase() != "allowed")
                    || window.utilization.is_some_and(|n| n >= 1.0))
                .then(|| Exhaustion {
                    window: id.into(),
                    reset_at_ms: window.reset_at_ms,
                })
            })
        });
        if result.exhaustion.is_some() {
            result.kind = ResponseKind::DurableExhaustion;
        } else if let Some(raw) = header(headers, "retry-after") {
            result.retry_after_ms = js_number(&Value::String(raw.into()))
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| (n * 1000.0).trunc().min(1_800_000.0) as i64)
                .or_else(|| {
                    parse_date(raw).map(|date| date.saturating_sub(now).clamp(0, 1_800_000))
                });
        }
    }
    result
}
pub fn refine_error(
    mut result: Classification,
    evidence: &ErrorEvidence,
) -> Result<Classification, gateway_core::GatewayError> {
    if !evidence.complete()
        || matches!(
            result.kind,
            ResponseKind::Ok | ResponseKind::DurableExhaustion | ResponseKind::UpstreamError
        )
    {
        return Ok(result);
    }
    let Some(units) = evidence.prefix() else {
        return Ok(result);
    };
    let body = JsString16::from_units(units.to_vec()).prefix_units(4096);
    let nested = body
        .try_utf8()
        .ok()
        .and_then(|text| SourceJson::parse(&text).ok())
        .and_then(|parsed| member(&parsed, "error"))
        .and_then(|error| member(&error, "message"))
        .and_then(|message| message.deserialize::<JsString16>().ok())
        .and_then(|message| message.sanitize_js_whitespace_prefix(240));
    let Some(detail) = nested.or_else(|| body.sanitize_js_whitespace_prefix(240)) else {
        return Ok(result);
    };
    if result.kind == ResponseKind::RequestRejected
        && includes_lowercase(&detail, "not scoped to a workspace")
    {
        result.kind = ResponseKind::WorkspaceRequired;
    } else if (includes_lowercase(&detail, "not found") && includes_lowercase(&detail, "workspace"))
        || (includes_lowercase(&detail, "workspace")
            && includes_lowercase(&detail, "valid workspace"))
    {
        result.kind = ResponseKind::WorkspaceNotFound;
    } else if includes_lowercase(&detail, "credit balance")
        || includes_lowercase(&detail, "purchase credits")
    {
        result.kind = ResponseKind::BillingBlocked;
    } else if includes_lowercase(&detail, "workspace")
        && includes_lowercase(&detail, "organization")
    {
        result.kind = ResponseKind::WorkspaceNotFound;
    }
    result.detail = Some(detail);
    Ok(result)
}
fn member(value: &SourceJson, name: &str) -> Option<SourceJson> {
    value
        .object_entries()
        .ok()?
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, value)| value)
}
fn includes_lowercase(text: &JsString16, needle: &str) -> bool {
    let mut folded = Vec::new();
    for scalar in char::decode_utf16(text.as_units().iter().copied()) {
        match scalar {
            Ok(scalar) => {
                for lower in scalar.to_lowercase() {
                    let mut buffer = [0; 2];
                    folded.extend_from_slice(lower.encode_utf16(&mut buffer));
                }
            }
            Err(error) => folded.push(error.unpaired_surrogate()),
        }
    }
    let needle = needle.encode_utf16().collect::<Vec<_>>();
    folded.windows(needle.len()).any(|part| part == needle)
}
