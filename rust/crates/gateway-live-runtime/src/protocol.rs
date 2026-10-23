use std::collections::BTreeMap;

use gateway_auth::{AuthMethod, AuthPrincipal};
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};

use crate::types::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveRoute {
    Create,
    Sideband(String),
}

pub fn live_route(method: &str, path: &str) -> Option<LiveRoute> {
    let path = if path == "/" {
        path
    } else {
        path.trim_end_matches('/')
    };
    if method == "POST" && path == "/v1/live" {
        return Some(LiveRoute::Create);
    }
    let raw = path.strip_prefix("/v1/live/")?;
    if method != "GET" || raw.contains('/') {
        return None;
    }
    let bytes = raw.as_bytes();
    let mut decoded = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let value = u8::from_str_radix(raw.get(at + 1..at + 3)?, 16).ok()?;
            decoded.push(value);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    let id = String::from_utf8(decoded).ok()?;
    (!matches!(id.as_str(), "" | "." | "..")).then_some(LiveRoute::Sideband(id))
}

pub fn encode_call_id(id: &str) -> String {
    let mut result = String::new();
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(char::from(byte));
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}

pub fn call_id_from_location(location: &str) -> Option<String> {
    location
        .split('?')
        .next()?
        .split('/')
        .rev()
        .find_map(|part| {
            let uuid = part.len() == 36
                && part.bytes().enumerate().all(|(i, c)| {
                    if [8, 13, 18, 23].contains(&i) {
                        c == b'-'
                    } else {
                        c.is_ascii_hexdigit()
                    }
                });
            ((part.starts_with("rtc_") && part.len() > 4) || uuid).then(|| part.to_owned())
        })
}

pub fn principal_id(principal: &AuthPrincipal) -> String {
    match &principal.method {
        AuthMethod::KvApiKey { key_id, .. } => format!("api-key:{key_id}"),
        AuthMethod::GithubToken { owner, repo, .. } => format!(
            "github-repo:{}/{}",
            owner.to_lowercase(),
            repo.to_lowercase()
        ),
        AuthMethod::PasskeySession { user_id, .. } => format!("passkey-user:{user_id}"),
        AuthMethod::PassportSession { claims } | AuthMethod::PassportBearer { claims } => {
            format!("passport-user:{}", claims.sub)
        }
        AuthMethod::AuthTokensAllowlist => "auth-method:auth_tokens_allowlist".into(),
        AuthMethod::AdminAllowlist => "auth-method:admin_allowlist".into(),
        AuthMethod::DenoDeployToken => "auth-method:deno_deploy_token".into(),
        AuthMethod::Disabled => principal
            .token
            .as_ref()
            .map(|t| {
                format!(
                    "bearer-sha256:{}",
                    gateway_auth::crypto::sha256_hex(t.expose().as_bytes())
                )
            })
            .unwrap_or_else(|| "local-auth-disabled".into()),
    }
}

/// Source Content-Length canonicality is checked before any actual body read.
pub fn validate_declared_length(value: Option<&str>) -> Result<(), GatewayError> {
    let Some(value) = value else { return Ok(()) };
    let value = value.trim();
    if value.is_empty()
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.starts_with('0') && value.len() > 1)
    {
        return Err(invalid(
            400,
            "Live call creation Content-Length is invalid.",
        ));
    }
    if value
        .parse::<u64>()
        .ok()
        .is_none_or(|n| n > LIVE_CALL_MAX_BODY_BYTES as u64)
    {
        return Err(body_too_large());
    }
    Ok(())
}

pub fn validate_body_read(bytes: usize, complete: bool) -> Result<(), GatewayError> {
    if bytes > LIVE_CALL_MAX_BODY_BYTES {
        return Err(body_too_large());
    }
    if !complete {
        return Err(invalid(
            400,
            "Live call creation body could not be read completely.",
        ));
    }
    Ok(())
}

fn body_too_large() -> GatewayError {
    invalid(
        413,
        "Live call creation bodies must be no larger than 1048576 bytes.",
    )
}

pub(crate) fn parse_create(
    input: &LiveCreateInput,
) -> Result<(SourceJson, Option<JsString16>), GatewayError> {
    let media = input.content_type.split(';').next().unwrap_or("").trim();
    if !media.eq_ignore_ascii_case("multipart/form-data")
        || !input
            .content_type
            .to_ascii_lowercase()
            .contains("boundary=")
    {
        return Err(invalid(
            400,
            "Live call creation requires multipart/form-data with a declared boundary.",
        ));
    }
    let sdp = input
        .sdp
        .as_ref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            invalid(400, "Live call creation requires a non-empty `sdp` part.")
                .with_param(Some("sdp"))
        })?;
    let text = input.session.as_ref().ok_or_else(|| {
        invalid(400, "Live call creation requires a `session` part.").with_param(Some("session"))
    })?;
    let session = SourceJson::parse(text.trim()).map_err(|_| {
        invalid(400, "Live call creation `session` part must be valid JSON.")
            .with_param(Some("session"))
    })?;
    let entries = session.object_entries().map_err(|_| {
        invalid(
            400,
            "Live call creation `session` part must be a JSON object.",
        )
        .with_param(Some("session"))
    })?;
    let model = entries
        .iter()
        .rev()
        .find(|(key, _)| key == &JsString16::from_utf8("model"))
        .and_then(|(_, v)| JsString16::from_json_token(v.as_raw()).ok());
    let normalized = normalize_json(&session)?;
    let body = SourceJson::parse(&format!(
        "{{\"sdp\":{},\"session\":{normalized}}}",
        serde_json::to_string(sdp).expect("SDP string serializes")
    ))?;
    Ok((body, model))
}

/// Match JSON.parse/stringify: last duplicate wins, source object key order, JS number precision,
/// infinity->null and -0->0. String code units never pass through serde_json::Value.
fn normalize_json(raw: &SourceJson) -> Result<String, GatewayError> {
    let text = raw.as_str().trim();
    if text.starts_with('{') {
        let mut members: Vec<(JsString16, SourceJson)> = Vec::new();
        for (key, value) in raw.object_entries()? {
            if let Some((_, previous)) = members.iter_mut().find(|(existing, _)| existing == &key) {
                *previous = value;
            } else {
                members.push((key, value));
            }
        }
        fn index(key: &JsString16) -> Option<u32> {
            let text = key.try_utf8().ok()?;
            let n = text.parse::<u32>().ok()?;
            (n != u32::MAX && n.to_string() == text).then_some(n)
        }
        members.sort_by_key(|(key, _)| index(key).map_or((1, 0), |n| (0, n)));
        let entries = members
            .iter()
            .map(|(k, v)| {
                Ok(format!(
                    "{}:{}",
                    serde_json::to_string(k).expect("source string serializes"),
                    normalize_json(v)?
                ))
            })
            .collect::<Result<Vec<_>, GatewayError>>()?;
        return Ok(format!("{{{}}}", entries.join(",")));
    }
    if text.starts_with('[') {
        let values = raw
            .array_items()?
            .iter()
            .map(normalize_json)
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(format!("[{}]", values.join(",")));
    }
    if text.starts_with('"') || matches!(text, "null" | "true" | "false") {
        return Ok(text.into());
    }
    let number = text
        .parse::<f64>()
        .map_err(|_| invalid(400, "Invalid session JSON number."))?;
    if !number.is_finite() {
        return Ok("null".into());
    }
    Ok(ryu_js::Buffer::new().format(number).into())
}

pub(crate) fn create_headers(
    input: &LiveCreateInput,
    user_agent: String,
) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::from([
        ("content-type".into(), "application/json".into()),
        ("originator".into(), "codex_cli_rs".into()),
        ("user-agent".into(), user_agent),
        ("openai-alpha".into(), LIVE_OPENAI_ALPHA_DEFAULT.into()),
    ]);
    for name in [
        "openai-alpha",
        "x-session-id",
        "session-id",
        "thread-id",
        "x-codex-turn-metadata",
        "x-oai-attestation",
    ] {
        if let Some(value) = input.headers.get(name).filter(|v| !v.trim().is_empty()) {
            headers.insert(name.into(), value.clone());
        }
    }
    headers
}
