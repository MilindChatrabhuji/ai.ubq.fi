//! Source Jev SDK and hybrid-residue wire, without ordinary route/admission planners.
use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};
use serde::Serialize;
use std::collections::BTreeMap;

const JEV_URL: &str = "https://openrouter.ai/api/v1/systemone";
const JEV_MODEL: &str = "~typesafe/jev-latest";
const RESIDUE_URL: &str = "https://api.cerebras.ai/v1/chat/completions";

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Call {
    Jev,
    Residue,
}

pub(super) struct RequestPlan {
    pub url: &'static str,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}
fn headers(key: &str, accept: bool) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::from([
        ("authorization".into(), format!("Bearer {key}")),
        ("content-type".into(), "application/json".into()),
    ]);
    if accept {
        headers.insert("accept".into(), "application/json".into());
    }
    headers
}
pub(super) fn jev_request(
    state: &SourceJson,
    questions: &SourceJson,
    key: &str,
) -> Result<RequestPlan, GatewayError> {
    #[derive(Serialize)]
    struct Body<'a> {
        model: &'static str,
        state: &'a SourceJson,
        questions: &'a SourceJson,
    }
    let body = SourceJson::from_serializable(&Body {
        model: JEV_MODEL,
        state,
        questions,
    })?;
    Ok(RequestPlan {
        url: JEV_URL,
        headers: headers(key, false),
        body: body.into_bytes(),
    })
}
fn member(value: &SourceJson, name: &str) -> Option<SourceJson> {
    let key = JsString16::from_utf8(name);
    value
        .object_entries()
        .ok()?
        .into_iter()
        .rev()
        .find(|(field, _)| field == &key)
        .map(|(_, value)| value)
}
fn is_text(value: Option<SourceJson>, text: &str) -> bool {
    value
        .and_then(|value| value.deserialize::<JsString16>().ok())
        .is_some_and(|value| value == JsString16::from_utf8(text))
}
pub(super) fn residue_request(body: &SourceJson, key: &str) -> Result<RequestPlan, GatewayError> {
    let fields = body.object_entries().map_err(|_| invalid_request())?;
    let allowed = [
        "model",
        "stream",
        "reasoning_effort",
        "max_completion_tokens",
        "messages",
    ]
    .map(JsString16::from_utf8);
    let messages = member(body, "messages")
        .and_then(|value| value.array_items().ok())
        .ok_or_else(invalid_request)?;
    let valid = fields.iter().all(|(key, _)| allowed.contains(key))
        && is_text(member(body, "model"), "gpt-oss-120b")
        && member(body, "stream").is_some_and(|value| value.deserialize::<bool>() == Ok(false))
        && is_text(member(body, "reasoning_effort"), "medium")
        && member(body, "max_completion_tokens")
            .is_some_and(|value| value.deserialize::<f64>() == Ok(16_000.0))
        && messages.len() == 1
        && is_text(member(&messages[0], "role"), "user")
        && member(&messages[0], "content")
            .is_some_and(|value| value.deserialize::<JsString16>().is_ok());
    if !valid {
        return Err(invalid_request());
    }
    // Source projection is identity for this fixed user-message body, including the token field.
    Ok(RequestPlan {
        url: RESIDUE_URL,
        headers: headers(key, true),
        body: body.as_bytes().to_vec(),
    })
}
fn error(message: impl Into<String>, code: &'static str) -> GatewayError {
    GatewayError::new(502, message, Some(code)).with_type("server_error")
}
pub(super) fn invalid_request() -> GatewayError {
    error(
        "The compaction provider request is invalid.",
        "compaction_request_invalid",
    )
}
pub(super) fn cancelled() -> GatewayError {
    gateway_admission::cancellation_error()
}
pub(super) fn interruption(
    original: bool,
    child: bool,
    call: Call,
    timeout_ms: u32,
) -> Option<GatewayError> {
    if original {
        Some(cancelled())
    } else if child {
        Some(match call {
            Call::Jev => error(
                format!("Jev request timed out after {timeout_ms} ms"),
                "compaction_jev_timeout",
            ),
            Call::Residue => error(
                "The residue request timed out.",
                "compaction_residue_timeout",
            ),
        })
    } else {
        None
    }
}
pub(super) fn transport_error(call: Call) -> GatewayError {
    match call {
        Call::Jev => error("Jev transport error", "compaction_jev_transport"),
        Call::Residue => error(
            "The residue transport failed.",
            "compaction_residue_transport",
        ),
    }
}
pub(super) fn body_error(call: Call) -> GatewayError {
    match call {
        Call::Jev => error("Jev response body could not be read", "compaction_jev_body"),
        Call::Residue => error(
            "The residue response body could not be read.",
            "compaction_residue_body",
        ),
    }
}
pub(super) fn http_error(call: Call, status: u16) -> GatewayError {
    match call {
        Call::Jev => error(
            format!("Jev request failed ({status})"),
            "compaction_jev_http",
        ),
        Call::Residue => error(
            format!("Residue upstream failed ({status})"),
            "compaction_residue_http",
        ),
    }
}
pub(super) fn parse_response(
    call: Call,
    status: u16,
    bytes: &[u8],
) -> Result<SourceJson, GatewayError> {
    if !(200..300).contains(&status) {
        return Err(http_error(call, status));
    }
    // Response.text()/json() use replacement UTF8 decoding and consume one leading BOM.
    let text = String::from_utf8_lossy(bytes);
    let value = SourceJson::parse(text.strip_prefix('\u{feff}').unwrap_or(&text)).map_err(
        |_| match call {
            Call::Jev => error("Jev returned malformed JSON", "compaction_jev_json"),
            Call::Residue => error(
                "The residue response was malformed JSON.",
                "compaction_residue_json",
            ),
        },
    )?;
    if call == Call::Jev
        && !member(&value, "answers").is_some_and(|answers| {
            let raw = answers.as_str().trim_start();
            raw.starts_with('{') || raw.starts_with('[')
        })
    {
        return Err(error(
            "Jev response is missing answers",
            "compaction_jev_answers",
        ));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
