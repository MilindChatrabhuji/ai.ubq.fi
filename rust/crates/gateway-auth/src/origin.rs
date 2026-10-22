use url::Url;

use crate::{AuthConfig, AuthRequest, CANDIDATE_ORIGIN, CANONICAL_ORIGIN};

fn exact_origin(value: &str) -> Option<String> {
    let raw = value.trim();
    let parsed = Url::parse(raw).ok()?;
    let origin = parsed.origin().ascii_serialization();
    (origin != "null" && origin == raw.trim_end_matches('/')).then_some(origin)
}

fn deno_preview(host: &str, name: &str, suffix: &str) -> bool {
    if host == format!("{name}.{suffix}") {
        return true;
    }
    let Some(preview) = host
        .strip_prefix(&format!("{name}-"))
        .and_then(|v| v.strip_suffix(&format!(".{suffix}")))
    else {
        return false;
    };
    preview.len() == 12
        && preview
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

pub fn trusted_relay_origin(value: &str, config: &AuthConfig) -> Option<String> {
    let origin = exact_origin(value)?;
    let url = Url::parse(&origin).ok()?;
    if url.scheme() != "https" || url.port().is_some() {
        return None;
    }
    let host = url.host_str()?;
    let allowed = host == "ai.ubq.fi"
        || deno_preview(host, "ai-ubq-fi", "deno.dev")
        || [
            ("ai-ubq-fi", "ubiquity-dao.deno.net"),
            ("p-ai-ubq-fi", "ubiquity-dao.deno.net"),
            ("telegram-daily-exporter", "0x4007.deno.net"),
            ("agent-worker", "ubiquity-os.deno.net"),
        ]
        .iter()
        .any(|(name, suffix)| deno_preview(host, name, suffix))
        || config.extra_relay_origins.contains(&origin);
    allowed.then_some(origin)
}

pub fn loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

pub fn local_bypass(request: &AuthRequest, config: &AuthConfig) -> bool {
    if config.production {
        return false;
    }
    let Some(peer) = &request.native_peer else {
        return false;
    };
    if !peer.listener_bypass_enabled
        || !peer.tcp
        || !peer
            .hostname
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
    {
        return false;
    }
    let Ok(url) = Url::parse(&request.url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    loopback_host(host)
        && request
            .header("origin")
            .is_none_or(|origin| origin == url.origin().ascii_serialization())
        && request
            .header("sec-fetch-site")
            .is_none_or(|site| matches!(site, "same-origin" | "none"))
}

pub fn request_audience(request: &AuthRequest, config: &AuthConfig) -> Option<String> {
    if let Some(origin) = request.header("origin") {
        return trusted_relay_origin(origin, config);
    }
    Url::parse(&request.url)
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == "cors_origin")
        .and_then(|(_, value)| trusted_relay_origin(&value, config))
}

pub fn passkey_meta(
    request: &AuthRequest,
    client_origin: Option<&str>,
    config: &AuthConfig,
) -> (String, String) {
    let request_url = Url::parse(&request.url).ok();
    let first = |name| {
        request
            .header(name)
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let protocol = first("x-forwarded-proto")
        .or_else(|| request_url.as_ref().map(Url::scheme))
        .unwrap_or("https");
    let from_host = |name| first(name).map(|host| format!("{protocol}://{host}"));
    let forwarded = from_host("x-forwarded-host");
    let host = from_host("host");
    let own = request_url
        .as_ref()
        .map(|url| url.origin().ascii_serialization());
    for candidate in [
        client_origin,
        request.header("origin"),
        request.header("referer"),
        forwarded.as_deref(),
        host.as_deref(),
        own.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let Ok(url) = Url::parse(candidate.trim()) else {
            continue;
        };
        let origin = url.origin().ascii_serialization();
        if origin == CANONICAL_ORIGIN {
            return (origin, "ai.ubq.fi".into());
        }
        if config.candidate_passkeys && origin == CANDIDATE_ORIGIN {
            return (origin, "ai.ubq.fi".into());
        }
        if matches!(url.scheme(), "http" | "https")
            && url
                .host_str()
                .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
        {
            return (origin, url.host_str().unwrap_or_default().to_owned());
        }
    }
    (CANONICAL_ORIGIN.into(), "ai.ubq.fi".into())
}

/// Cookie-authenticated admin mutations require a browser-declared same-origin
/// request. Non-browser callers without Origin/Referer/Sec-Fetch-Site remain
/// compatible because they do not carry ambient cookies.
pub fn same_origin_mutation(request: &AuthRequest) -> bool {
    if matches!(request.method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        return true;
    }
    let Ok(url) = Url::parse(&request.url) else {
        return false;
    };
    let own = url.origin().ascii_serialization();
    if let Some(site) = request.header("sec-fetch-site").map(str::trim)
        && !matches!(site, "same-origin" | "none")
    {
        return false;
    }
    if let Some(origin) = request.header("origin").map(str::trim) {
        return exact_origin(origin).as_deref() == Some(own.as_str());
    }
    // Source cookie mutations validate Origin when present and do not infer it
    // from a Referer fallback.
    true
}
