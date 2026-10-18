//! Actual response status/headers own proof classification. A caller supplies no exhaustion Boolean.
use crate::quota::{Exhaustion, QuotaObservation, QuotaWindow, StandardWindow, STANDARD_FAMILIES, WINDOWS, prefix_utf16, sanitize_error};
use gateway_providers::Headers;
use gateway_schema::util::js_trim;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseKind { Ok, DurableExhaustion, TransientRateLimited, AuthInvalid, RequestRejected, WorkspaceRequired, WorkspaceNotFound, BillingBlocked, Forbidden, UpstreamError }
impl ResponseKind {
    pub fn id(self) -> &'static str { match self { Self::Ok=>"ok",Self::DurableExhaustion=>"durable_exhaustion",Self::TransientRateLimited=>"transient_rate_limited",Self::AuthInvalid=>"auth_invalid",Self::RequestRejected=>"request_rejected",Self::WorkspaceRequired=>"workspace_required",Self::WorkspaceNotFound=>"workspace_not_found",Self::BillingBlocked=>"billing_blocked",Self::Forbidden=>"forbidden",Self::UpstreamError=>"upstream_error" } }
    pub fn is_configuration(self) -> bool { matches!(self,Self::WorkspaceRequired|Self::WorkspaceNotFound|Self::BillingBlocked|Self::Forbidden) }
    pub fn health(self) -> &'static str { match self { Self::Ok=>"success",Self::DurableExhaustion=>"quota_exhausted",Self::AuthInvalid=>"auth_invalid",Self::RequestRejected=>"reachable",_=>"upstream_error" } }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Classification {
    pub kind: ResponseKind,
    pub exhaustion: Option<Exhaustion>,
    pub retry_after_ms: Option<i64>,
    pub detail: Option<String>,
}
#[derive(Debug, Default)]
pub struct ErrorEvidence {
    pub prefix: Option<Vec<u16>>,
    /// Complete bounded clone evidence, not the deliverable response body.
    pub complete: bool,
}
pub fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> { headers.iter().find(|(k,_)| k.eq_ignore_ascii_case(name)).map(|(_,v)| v.as_str()) }
fn js_number(value: &Value) -> Option<f64> { Some(gateway_admin_data::profile::js_number(value)) }
fn nonnegative(raw: Option<&str>) -> Option<f64> {
    let raw = raw.filter(|s| !js_trim(s).is_empty())?;
    js_number(&Value::String(raw.into())).filter(|n| n.is_finite() && *n >= 0.0)
}
fn reset_header(raw: Option<&str>) -> Option<f64> {
    nonnegative(raw).filter(|n| *n > 0.0 && n.fract() == 0.0 && *n <= gateway_core::identity::MAX_SAFE_INTEGER as f64).map(|seconds|seconds*1000.0)
}
pub fn observe_headers(headers: &Headers, now: i64) -> Option<QuotaObservation> {
    if now <= 0 { return None; }
    let mut windows = BTreeMap::new(); let mut standard = BTreeMap::new();
    for id in WINDOWS {
        let prefix = format!("anthropic-ratelimit-unified-{id}");
        let raw_status = header(headers,&format!("{prefix}-status"));
        let status = raw_status.filter(|s| !js_trim(s).is_empty()).map(str::to_owned);
        let utilization = nonnegative(header(headers,&format!("{prefix}-utilization")));
        let reset_at_ms = reset_header(header(headers,&format!("{prefix}-reset")));
        if raw_status.is_some() || utilization.is_some() || reset_at_ms.is_some() { windows.insert(id.into(),QuotaWindow { status,utilization,reset_at_ms,observed_at_ms:now as f64 }); }
    }
    for id in STANDARD_FAMILIES {
        let prefix = format!("anthropic-ratelimit-{id}");
        let limit = nonnegative(header(headers,&format!("{prefix}-limit"))); let remaining = nonnegative(header(headers,&format!("{prefix}-remaining"))); let reset_at_ms = reset_header(header(headers,&format!("{prefix}-reset")));
        if limit.is_some() || remaining.is_some() || reset_at_ms.is_some() { standard.insert(id.into(),StandardWindow { limit,remaining,reset_at_ms,observed_at_ms:now as f64 }); }
    }
    let observation = QuotaObservation { windows,standard,representative_claim:header(headers,"anthropic-ratelimit-unified-representative-claim").filter(|s| !js_trim(s).is_empty()).map(str::to_owned),observed_at_ms:now as f64 };
    (!observation.is_empty()).then_some(observation)
}
pub fn classify_headers(status: u16, headers: &Headers, now: i64, parse_date: &impl Fn(&str)->Option<i64>) -> Classification {
    let mut result = Classification { kind:ResponseKind::RequestRejected,exhaustion:None,retry_after_ms:None,detail:None };
    result.kind = match status { 200..=299=>ResponseKind::Ok,429=>ResponseKind::TransientRateLimited,401=>ResponseKind::AuthInvalid,403=>ResponseKind::Forbidden,500..=u16::MAX=>ResponseKind::UpstreamError,_=>ResponseKind::RequestRejected };
    if status == 429 {
        result.exhaustion = observe_headers(headers,now).and_then(|observation|WINDOWS.into_iter().find_map(|id| {
            let window = observation.windows.get(id)?;
            (window.status.as_ref().is_some_and(|s| js_trim(s).to_lowercase() != "allowed") || window.utilization.is_some_and(|n| n >= 1.0)).then(||Exhaustion { window:id.into(),reset_at_ms:window.reset_at_ms })
        }));
        if result.exhaustion.is_some() { result.kind=ResponseKind::DurableExhaustion; }
        else if let Some(raw) = header(headers,"retry-after") {
            result.retry_after_ms = js_number(&Value::String(raw.into())).filter(|n| n.is_finite() && *n >= 0.0).map(|n|(n*1000.0).trunc().min(1_800_000.0) as i64).or_else(||parse_date(raw).map(|date|date.saturating_sub(now).clamp(0,1_800_000)));
        }
    }
    result
}
pub fn refine_error(mut result: Classification, evidence: &ErrorEvidence) -> Result<Classification,gateway_core::GatewayError> {
    if !evidence.complete || matches!(result.kind,ResponseKind::Ok|ResponseKind::DurableExhaustion|ResponseKind::UpstreamError) { return Ok(result); }
    let Some(units) = evidence.prefix.as_deref() else { return Ok(result) };
    // The adapter retains exact source units. The shared lossless stored-text
    // extension is an explicit integration prerequisite; never normalize/drop.
    let body = String::from_utf16(&units[..units.len().min(4096)]).map_err(|_|gateway_core::GatewayError::unavailable("Exact Claude UTF16 detail storage is not yet bound.","claude_utf16_codec_unavailable"))?;
    let body = prefix_utf16(&body,4096);
    let parsed = serde_json::from_str::<Value>(&body).ok();
    let nested = parsed.as_ref().and_then(|p|p.pointer("/error/message")).and_then(Value::as_str).filter(|s|!js_trim(s).is_empty());
    let Some(detail) = sanitize_error(nested.or(Some(&body))) else { return Ok(result) };
    let lower = detail.to_lowercase();
    if result.kind == ResponseKind::RequestRejected && lower.contains("not scoped to a workspace") { result.kind=ResponseKind::WorkspaceRequired; }
    else if (lower.contains("not found") && lower.contains("workspace")) || (lower.contains("workspace") && lower.contains("valid workspace")) { result.kind=ResponseKind::WorkspaceNotFound; }
    else if lower.contains("credit balance") || lower.contains("purchase credits") { result.kind=ResponseKind::BillingBlocked; }
    else if lower.contains("workspace") && lower.contains("organization") { result.kind=ResponseKind::WorkspaceNotFound; }
    result.detail=Some(detail); Ok(result)
}
