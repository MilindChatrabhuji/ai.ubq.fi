//! Exact refusal-header precedence, with the host supplying its HTTP date parser.
use crate::types::{Headers, header};
#[derive(Clone, Debug, PartialEq)]
pub struct RateLimitWait {
    pub wait_ms: f64,
    pub source: &'static str,
}
fn integer(value: Option<&str>) -> Option<f64> {
    let value = value?.trim();
    if value.is_empty() || !value.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    value.parse::<f64>().ok().filter(|v| v.is_finite())
}
fn duration(value: Option<&str>) -> Option<f64> {
    let value = value?.split_whitespace().collect::<String>();
    if value.is_empty() {
        return None;
    }
    let bytes = value.as_bytes();
    let mut cursor = 0;
    let mut total = 0.0;
    while cursor < bytes.len() {
        let start = cursor;
        while cursor < bytes.len() && (bytes[cursor].is_ascii_digit() || bytes[cursor] == b'.') {
            cursor += 1
        }
        if cursor == start {
            return None;
        }
        let magnitude = value[start..cursor]
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())?;
        let (unit, width) = if value[cursor..].starts_with("ms") {
            (1.0, 2)
        } else {
            match bytes.get(cursor) {
                Some(b's') => (1000.0, 1),
                Some(b'm') => (60_000.0, 1),
                Some(b'h') => (3_600_000.0, 1),
                _ => return None,
            }
        };
        total += magnitude * unit;
        cursor += width;
    }
    total.is_finite().then_some(total)
}
pub fn retry_prohibited(headers: &Headers) -> bool {
    header(headers, "x-should-retry").is_some_and(|s| s.trim().eq_ignore_ascii_case("false"))
}
pub fn rate_limit_wait(
    headers: &Headers,
    now_ms: f64,
    parse_http_date: impl Fn(&str) -> Option<f64>,
) -> Option<RateLimitWait> {
    if retry_prohibited(headers) {
        return None;
    }
    if let Some(wait_ms) = integer(header(headers, "retry-after-ms")) {
        return Some(RateLimitWait {
            wait_ms,
            source: "retry-after-ms",
        });
    }
    if let Some(raw) = header(headers, "retry-after") {
        let wait = integer(Some(raw)).map(|s| s * 1000.0).or_else(|| {
            parse_http_date(raw.trim())
                .map(|date| date - now_ms)
                .filter(|wait| wait.is_finite() && *wait > 0.0)
        });
        if let Some(wait_ms) = wait.filter(|v| v.is_finite()) {
            return Some(RateLimitWait {
                wait_ms,
                source: "retry-after",
            });
        }
    }
    let mut latest: Option<RateLimitWait> = None;
    for source in ["x-ratelimit-reset-tokens", "x-ratelimit-reset-requests"] {
        if let Some(wait_ms) = duration(header(headers, source))
            && latest.as_ref().is_none_or(|w| wait_ms > w.wait_ms)
        {
            latest = Some(RateLimitWait { wait_ms, source });
        }
    }
    latest
}
