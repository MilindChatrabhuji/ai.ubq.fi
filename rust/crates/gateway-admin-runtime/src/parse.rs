use crate::capabilities::*;
use gateway_admin::AdminInput;
use gateway_auth::{crypto::Secret, invalid};
use gateway_core::{GatewayError, identity::MAX_SAFE_INTEGER};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub fn first<'a>(query: &'a BTreeMap<String, Vec<String>>, name: &str) -> Option<&'a str> {
    query.get(name).and_then(|values| values.first()).map(String::as_str)
}
pub fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}
pub fn integer(value: &Value) -> Option<i64> {
    let n = if let Some(s) = value.as_str() { s.trim().parse::<f64>().ok()? } else { value.as_f64()? };
    (n.is_finite() && n.abs() <= MAX_SAFE_INTEGER as f64).then_some(n.trunc() as i64)
}
pub fn limit(value: &Value) -> Option<i64> {
    if value.as_str().is_some_and(|s| s.trim().eq_ignore_ascii_case("unlimited")) { return Some(-1) }
    integer(value).filter(|v| *v >= -1)
}
pub fn positive(value: &Value) -> Option<i64> { integer(value).filter(|v| *v > 0) }
pub fn truth(value: Option<&str>) -> bool { value.is_some_and(|s| ["1", "true", "yes", "on"].contains(&s.trim().to_lowercase().as_str())) }
fn boolean(value: Option<&str>) -> Option<bool> {
    let s = value?.trim().to_lowercase();
    if ["1", "true", "yes", "on"].contains(&s.as_str()) { Some(true) }
    else if ["0", "false", "no", "off"].contains(&s.as_str()) { Some(false) } else { None }
}
pub fn digits(value: &str) -> bool { !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) }
pub fn bounded_positive(value: Option<&str>, default: u32, max: u32) -> Result<u32, GatewayError> {
    let Some(value) = value else { return Ok(default) };
    if !digits(value.trim()) { return Err(invalid("limit must be a positive integer")) }
    let value = value.trim().parse::<u64>().ok().filter(|v| *v > 0 && *v <= MAX_SAFE_INTEGER as u64).ok_or_else(|| invalid("limit must be a positive integer"))?;
    Ok(value.min(u64::from(max)) as u32)
}
pub fn uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i,b)| if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
fn cursor(value: Option<&str>, empty: bool) -> Result<Option<String>, GatewayError> {
    let Some(value) = value else { return Ok(None) };
    if value.is_empty() && empty { return Ok(None) }
    let unpadded = value.trim_end_matches('=');
    if value.len() > 2048 || unpadded.is_empty() || value.len()-unpadded.len() > 2 || !unpadded.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(invalid("Invalid capture cursor"))
    }
    Ok(Some(value.into()))
}
fn incident_id(value: &str) -> bool {
    value.strip_prefix("provider-").is_some_and(|id| uuid(id) && id.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b==b'-') && id.as_bytes()[14]==b'4' && b"89ab".contains(&id.as_bytes()[19]))
}

pub fn capture(input: &AdminInput, incidents: bool) -> Result<CaptureRequest, GatewayError> {
    let q = &input.query;
    if incidents {
        if q.keys().any(|k| !["limit", "cursor", "incident_id"].contains(&k.as_str())) || q.values().any(|v| v.len() != 1) { return Err(invalid("Invalid incident query")) }
        let limit = bounded_positive(first(q,"limit"),20,100)?;
        if first(q,"limit").is_some_and(|s| !digits(s) || s.parse::<u64>().is_ok_and(|v| v>100)) { return Err(invalid("limit must be an integer from 1 to 100")) }
        let id = first(q,"incident_id").map(str::to_owned);
        if id.as_ref().is_some_and(|s| !incident_id(s)) { return Err(invalid("Invalid incident id")) }
        return Ok(CaptureRequest::Incidents { incident_id:id, cursor:cursor(first(q,"cursor"),false)?, limit })
    }
    let incident = first(q,"incident_id").map(str::trim).filter(|s| !s.is_empty());
    let request = first(q,"request_id").map(str::trim).filter(|s| !s.is_empty());
    if let Some(request) = request {
        if incident.is_some() || request.len() > 128 || request.is_empty() || !request.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) { return Err(invalid("Invalid replay request id")) }
        return Ok(CaptureRequest::Request { request_id: request.into() })
    }
    let number = |name, fallback| first(q,name).filter(|s| !s.is_empty()).map(|s| s.parse::<f64>().ok().filter(|n| n.is_finite() && n.fract()==0.0 && *n>=0.0 && *n<=MAX_SAFE_INTEGER as f64).map(|n|n as i64)).unwrap_or(Some(fallback));
    let after = number("after_ms",0).ok_or_else(|| invalid("Invalid replay interval"))?;
    let before = number("before_ms",-1).ok_or_else(|| invalid("Invalid replay interval"))?;
    if before < after || number("limit",1) != Some(1) { return Err(invalid("Invalid replay interval or limit")) }
    let cursor = cursor(first(q,"cursor"),true)?;
    if let Some(id) = incident {
        if !incident_id(id) { return Err(invalid("Invalid incident id")) }
        Ok(CaptureRequest::Incident { incident_id:id.into(),cursor })
    } else { Ok(CaptureRequest::Interval { after_ms:after,before_ms:before,cursor }) }
}

pub fn migration(input: &AdminInput) -> Result<MigrationImport, GatewayError> {
    let ndjson = input.body.as_str().ok_or_else(|| GatewayError::unavailable("Migration import requires the preserved raw NDJSON body", "admin_raw_body_unavailable"))?;
    if ndjson.len() > 5*1024*1024 { return Err(GatewayError::new(413,"Migration body is too large",Some("invalid_request_error"))) }
    let q = &input.query;
    let profile = match first(q,"profile").unwrap_or("").trim() { ""|"prod" => MigrationProfile::Prod, "local"=>MigrationProfile::Local, _=>return Err(invalid("profile must be local or prod")) };
    let write = boolean(first(q,"write")) == Some(true);
    if write && boolean(first(q,"dry_run")) == Some(true) { return Err(invalid("dry_run and write are mutually exclusive")) }
    Ok(MigrationImport { ndjson:ndjson.into(), profile, include_cache:truth(first(q,"include_cache")), include_legacy:boolean(first(q,"include_legacy")).unwrap_or(profile==MigrationProfile::Local), overwrite:truth(first(q,"overwrite")), dry_run:!write })
}

pub fn claude(body: &Value) -> Result<ClaudeSubmission, GatewayError> {
    let credential = body.get("credential").and_then(Value::as_str).or_else(||body.get("api_key").and_then(Value::as_str)).map(str::trim);
    if credential.is_some_and(|s| s.is_empty()) { return Err(invalid("credential must not be blank")) }
    if credential.is_some_and(|s| s.encode_utf16().count()>512) { return Err(invalid("credential is too long")) }
    if credential.is_some_and(|s| !s.starts_with("sk-ant-")) { return Err(invalid("credential must be an Anthropic API key or Claude Code OAuth token")) }
    let label = body.get("label").and_then(Value::as_str).map(str::trim).map(str::to_owned);
    if label.as_ref().is_some_and(|s|s.encode_utf16().count()>64) { return Err(invalid("label is too long")) }
    let workspace_id = match body.get("workspace_id") {
        None=>None, Some(Value::Null)=>Some(None), Some(Value::String(s)) if s.is_empty()=>Some(None),
        Some(Value::String(s)) if s.trim().starts_with("wrkspc_") && s.trim().encode_utf16().count()<=256=>Some(Some(s.trim().into())),
        _=>return Err(invalid("workspace_id must be a wrkspc_ workspace id")),
    };
    if credential.is_none() && workspace_id.is_none() { return Err(invalid("credential or workspace_id is required")) }
    let account_id = match body.get("account_id") { None=>None, Some(Value::String(s)) if s.len()==36 && s.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b==b'-')=>Some(s.clone()), _=>return Err(invalid("account_id is invalid")) };
    for name in ["create_new","activate"] { if body.get(name).is_some_and(|v|!v.is_boolean()) { return Err(invalid(&format!("{name} must be boolean"))) } }
    let create_new = body.get("create_new")==Some(&Value::Bool(true));
    if create_new && account_id.is_some() { return Err(invalid("create_new cannot target an existing account")) }
    Ok(ClaudeSubmission { credential:credential.map(|s|Secret::new(s.into())), label, workspace_id, account_id, create_new, activate:body.get("activate")==Some(&Value::Bool(true)) })
}

pub fn prompt_groups(input: &AdminInput) -> Result<Vec<String>, GatewayError> {
    if input.query.keys().any(|k| k!="group_by") { return Err(invalid("Only group_by is supported for prompt-cache analytics")) }
    if input.query.get("group_by").is_some_and(|v|v.len()>1) { return Err(invalid("group_by may appear only once")) }
    let groups:Vec<String> = first(&input.query,"group_by").unwrap_or("key_presence").split(',').map(|s|s.trim().into()).collect();
    let allowed = ["provider","model","route","key_presence","mode","fallback"];
    if groups.is_empty() || groups.len()>2 || groups.iter().any(|s| !allowed.contains(&s.as_str())) || groups.iter().collect::<BTreeSet<_>>().len()!=groups.len() { return Err(invalid("group_by must contain up to two distinct values from provider, model, route, key_presence, mode, or fallback")) }
    Ok(groups)
}
