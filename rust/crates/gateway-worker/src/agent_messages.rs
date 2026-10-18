//! Source GitHub/kernel-scoped agent-message API over the shared tuple store.
use gateway_auth::{AuthMethod, AuthPrincipal};
use gateway_core::{
    GatewayError,
    query::{QueryRequest, QuerySelector, QueryStore},
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck,
        StoredRecord,
    },
    tuple_key::{ScalarKeyPart, TupleKey},
};
use gateway_schema::{
    request::parse_json_body,
    util::{js_trim, json_stringify},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{Method, Request, Response};

use crate::{
    authority::RemoteAuthorityStore,
    storage::now_ms,
    transport::{body::inference_bytes, random},
};

#[derive(Deserialize, Serialize)]
struct AgentMessage {
    id: String,
    owner: String,
    repo: String,
    state_id: String,
    agent_id: String,
    channel: Option<String>,
    kind: Option<String>,
    body: String,
    metadata: Option<Value>,
    created_at_ms: i64,
}

fn tag(value: Option<&Value>) -> Option<String> {
    let value = js_trim(value?.as_str()?);
    (!value.is_empty() && value.encode_utf16().count() <= 120 && !value.contains(['\r', '\n']))
        .then(|| value.to_owned())
}

fn positive_integer(raw: Option<&str>) -> Option<f64> {
    let raw = js_trim(raw?);
    let sign = usize::from(raw.starts_with(['+', '-']));
    let digits = raw.as_bytes()[sign..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    raw[..sign + digits]
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(f64::trunc)
}

fn source_key(parts: &[ScalarKeyPart<'_>]) -> gateway_core::state::RecordKey {
    TupleKey::from_scalar_parts(parts).to_record_key()
}

pub async fn handle(
    mut request: Request,
    principal: &AuthPrincipal,
    store: &RemoteAuthorityStore,
) -> Result<Response, GatewayError> {
    let AuthMethod::GithubToken {
        owner,
        repo,
        state_id,
        ..
    } = &principal.method
    else {
        return Err(GatewayError::new(
            403,
            "GitHub token auth required",
            Some("forbidden"),
        ));
    };
    if request.method() == Method::Post {
        let raw = parse_json_body(&inference_bytes(&mut request).await?)?;
        if !raw.is_object() {
            return Err(invalid("Invalid JSON body"));
        }
        let agent_id = tag(raw.get("agent_id"))
            .ok_or_else(|| invalid("agent_id must be a non-empty string (<=120 chars)"))?;
        let body = raw
            .get("body")
            .and_then(Value::as_str)
            .filter(|body| !js_trim(body).is_empty() && body.encode_utf16().count() <= 8000)
            .ok_or_else(|| invalid("body must be a non-empty string (<=8000 chars)"))?
            .to_owned();
        let channel = tag(raw.get("channel"));
        if raw.get("channel").is_some_and(|value| !value.is_null()) && channel.is_none() {
            return Err(invalid("channel must be a string (<=120 chars)"));
        }
        let kind = tag(raw.get("kind"));
        if raw.get("kind").is_some_and(|value| !value.is_null()) && kind.is_none() {
            return Err(invalid("kind must be a string (<=120 chars)"));
        }
        let metadata = raw
            .get("metadata")
            .filter(|value| !value.is_null())
            .cloned();
        if metadata.as_ref().is_some_and(|value| {
            !value.is_object() || json_stringify(value).encode_utf16().count() > 8000
        }) {
            return Err(invalid("metadata must be a JSON object (<=8000 chars)"));
        }
        let record = AgentMessage {
            id: random::random_uuid()?,
            owner: owner.clone(),
            repo: repo.clone(),
            state_id: state_id.clone(),
            agent_id,
            channel,
            kind,
            body,
            metadata,
            created_at_ms: now_ms()?,
        };
        let key = source_key(&[
            ScalarKeyPart::String("agent_messages"),
            ScalarKeyPart::String(owner),
            ScalarKeyPart::String(repo),
            ScalarKeyPart::String(state_id),
            ScalarKeyPart::Number(record.created_at_ms),
            ScalarKeyPart::String(&record.id),
        ]);
        let value = serde_json::to_value(&record).map_err(|_| unavailable())?;
        if store
            .commit(AtomicTransition {
                checks: vec![RevisionCheck {
                    key: key.clone(),
                    expected_revision: None,
                }],
                mutations: vec![RecordMutation::Put {
                    key,
                    record: StoredRecord::json(random::opaque_token()?, value, None),
                }],
            })
            .await?
            != CommitOutcome::Committed
        {
            return Err(unavailable());
        }
        return Response::from_json(&json!({"message":record})).map_err(|_| unavailable());
    }
    if request.method() != Method::Get {
        return Err(GatewayError::new(
            405,
            "Method not allowed",
            Some("method_not_allowed"),
        ));
    }
    let url = request.url().map_err(|_| invalid("Invalid request URL"))?;
    let get = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let limit = positive_integer(get("limit").as_deref())
        .unwrap_or(50.0)
        .clamp(1.0, 200.0) as u32;
    let since = positive_integer(get("since").as_deref());
    let channel = tag(get("channel").map(Value::String).as_ref());
    let agent_id = tag(get("agent_id").map(Value::String).as_ref());
    let scan_limit = if channel.is_some() || agent_id.is_some() {
        (limit * 2).min(200)
    } else {
        limit
    };
    let cursor = get("cursor")
        .map(|value| js_trim(&value).to_owned())
        .filter(|value| !value.is_empty());
    let selector = QuerySelector::Prefix {
        prefix: source_key(&[
            ScalarKeyPart::String("agent_messages"),
            ScalarKeyPart::String(owner),
            ScalarKeyPart::String(repo),
            ScalarKeyPart::String(state_id),
        ]),
        start: None,
        end: None,
    };
    let query = QueryRequest {
        selector,
        reverse: false,
        limit: scan_limit,
        cursor,
        now_ms: now_ms()?,
    };
    let validated = query.validate()?;
    let page = store.query(query).await?;
    let mut messages = Vec::new();
    let mut next_cursor = page.next_cursor;
    let total = page.entries.len();
    for (index, entry) in page.entries.into_iter().enumerate() {
        let message: AgentMessage = serde_json::from_value(entry.record.json_value()?.clone())
            .map_err(|_| unavailable())?;
        if since.is_some_and(|since| (message.created_at_ms as f64) < since)
            || agent_id.as_ref().is_some_and(|id| *id != message.agent_id)
            || channel
                .as_ref()
                .is_some_and(|channel| Some(channel) != message.channel.as_ref())
        {
            continue;
        }
        messages.push(message);
        if messages.len() >= limit as usize {
            if index + 1 < total {
                next_cursor = Some(validated.cursor_after(&entry.key)?);
            }
            break;
        }
    }
    let next_since = messages.last().map(|message| message.created_at_ms);
    Response::from_json(&json!({"messages":messages,"next_since":next_since,"has_more":next_cursor.is_some(),"next_cursor":next_cursor})).map_err(|_| unavailable())
}

fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error"))
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable("Agent-message storage is unavailable.", "server_error")
}
