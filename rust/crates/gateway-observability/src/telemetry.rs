//! Telemetry classifiers consume actual observations; none authorizes quota or settlement.
use crate::types::HealthEvent;
use serde_json::Value;

pub fn response_incomplete_failure_kind(event: &Value) -> Option<String> {
    let reason = event
        .get("response")?
        .get("incomplete_details")?
        .get("reason")?
        .as_str()?;
    let lower = reason.to_ascii_lowercase();
    if ![
        "gateway", "provider", "upstream", "server", "network", "timeout", "deadline",
    ]
    .iter()
    .any(|p| lower.starts_with(p))
        || !reason
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return None;
    }
    Some(format!("response_incomplete:{reason}"))
}
/// Latest source OpenRouter terminal attribution: ordinary incomplete is reachable.
pub fn responses_terminal_health(event_type: &str, event: &Value) -> Option<HealthEvent> {
    match event_type {
        "error" | "response.failed" => Some(HealthEvent::UpstreamError),
        "response.incomplete" if response_incomplete_failure_kind(event).is_some() => {
            Some(HealthEvent::UpstreamError)
        }
        "response.completed" | "response.incomplete" => Some(HealthEvent::Reachable),
        _ => None,
    }
}
