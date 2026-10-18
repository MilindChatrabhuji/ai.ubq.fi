use std::collections::{BTreeMap, BTreeSet};

use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::transport::{SupervisorMethod, SupervisorTransport};

pub const MAX_SOURCES: usize = 8;
pub const INVENTORY_LIMIT: usize = 60;
pub const LIVE_PROBE_LIMIT: usize = 24;
pub const OVERALL_DEADLINE_MS: u64 = 9_000;
pub const FOLLOW_MAX_DURATION_MS: i64 = 600_000;
pub const FOLLOW_POLL_MS: u64 = 2_000;
pub const SUPERVISOR_FRAME_LIMIT: usize = 1_048_576;
pub const RENEWAL_FRAME_LIMIT: usize = 65_536;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct SourceId(String);
impl TryFrom<String> for SourceId {
    type Error = GatewayError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}
impl From<SourceId> for String {
    fn from(value: SourceId) -> Self {
        value.0
    }
}
impl SourceId {
    pub fn parse(id: &str) -> Result<Self, GatewayError> {
        if id.is_empty()
            || id.len() > 32
            || !id.as_bytes()[0].is_ascii_lowercase() && !id.as_bytes()[0].is_ascii_digit()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
        {
            return Err(invalid("Invalid supervisor source id"));
        }
        Ok(Self(id.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug)]
pub struct KnownThread {
    source: SourceId,
    id: String,
    inventory_generation: String,
}
impl KnownThread {
    pub fn source(&self) -> &SourceId {
        &self.source
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn inventory_generation(&self) -> &str {
        &self.inventory_generation
    }
}

#[derive(Clone, Debug)]
pub struct InventoryScope {
    pub generation: String,
    pub source: SourceId,
    pub available: bool,
    pub thread_ids: BTreeSet<String>,
}
impl InventoryScope {
    pub fn select(&self, id: &str) -> Result<KnownThread, GatewayError> {
        if id.is_empty()
            || id.len() > 200
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
        {
            return Err(invalid("Invalid thread id"));
        }
        if !self.available {
            return Err(GatewayError::new(
                409,
                "Supervisor source is unavailable",
                Some("invalid_request_error"),
            ));
        }
        if !self.thread_ids.contains(id) {
            return Err(GatewayError::new(
                409,
                "Session is not in the sampled inventory for this source; refresh the panel and select a listed session",
                Some("invalid_request_error"),
            ));
        }
        Ok(KnownThread {
            source: self.source.clone(),
            id: id.to_owned(),
            inventory_generation: self.generation.clone(),
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupervisorState {
    Active,
    Idle,
    Stale,
    Unknown,
    SystemError,
}

pub fn classify_state(runtime: Option<&str>, turn: Option<&str>, loaded: bool) -> SupervisorState {
    let terminal = turn.is_some_and(|status| {
        matches!(
            status,
            "completed"
                | "interrupted"
                | "failed"
                | "declined"
                | "cancelled"
                | "canceled"
                | "errored"
                | "aborted"
        )
    });
    match runtime {
        Some("active") => SupervisorState::Active,
        Some("systemError") => SupervisorState::SystemError,
        Some("idle") => SupervisorState::Idle,
        Some("notLoaded") => {
            if turn.is_some() && !terminal {
                SupervisorState::Stale
            } else if terminal {
                SupervisorState::Idle
            } else {
                SupervisorState::Unknown
            }
        }
        _ => {
            if turn.is_some() && !terminal {
                if loaded {
                    SupervisorState::Active
                } else {
                    SupervisorState::Stale
                }
            } else {
                SupervisorState::Unknown
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowEntry {
    pub key: String,
    pub kind: String,
    pub turn_id: String,
    pub text: String,
    pub command: Option<String>,
    pub status: Option<String>,
    pub exit_code: Option<i64>,
    pub at_ms: Option<i64>,
    pub revision: String,
    #[serde(skip)]
    pub index: usize,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpdate {
    pub entries: Vec<FollowEntry>,
    pub cursor: String,
    pub turn_id: Option<String>,
    pub turn_status: Option<String>,
    pub enriched: bool,
}

fn bounded(value: &str, max: usize) -> String {
    if value.encode_utf16().count() <= max {
        value.into()
    } else {
        let mut used = 0;
        let mut output = String::new();
        for ch in value.chars() {
            if used + ch.len_utf16() > max.saturating_sub(1) {
                break;
            }
            used += ch.len_utf16();
            output.push(ch);
        }
        output.push('…');
        output
    }
}
fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

pub fn extract_follow(turn_id: &str, items: &Value) -> Vec<FollowEntry> {
    let Some(items) = items.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let (kind, text, command, status, exit_code) = match str_field(item, "type") {
                Some("agentMessage") => (
                    "message",
                    str_field(item, "text").unwrap_or(""),
                    None,
                    str_field(item, "phase"),
                    None,
                ),
                Some("commandExecution") => (
                    "command",
                    str_field(item, "aggregatedOutput").unwrap_or(""),
                    Some(str_field(item, "command").unwrap_or("")),
                    str_field(item, "status"),
                    item.get("exitCode").and_then(Value::as_i64),
                ),
                _ => return None,
            };
            let id = str_field(item, "id")
                .map(str::to_owned)
                .unwrap_or_else(|| index.to_string());
            let mut hash = 2166136261u32;
            // Source JS hashes UTF16 code units; Rust bytes would change mutable-entry revisions.
            for unit in text.encode_utf16() {
                hash ^= u32::from(unit);
                hash = hash.wrapping_mul(16777619);
            }
            let revision = format!(
                "{}:{hash}:{}:{}",
                text.encode_utf16().count(),
                status.unwrap_or(""),
                exit_code.map(|n| n.to_string()).unwrap_or_default()
            );
            Some(FollowEntry {
                key: format!("{turn_id}:{id}"),
                kind: kind.into(),
                turn_id: turn_id.into(),
                text: bounded(text, 4000),
                command: command.map(|s| bounded(s, 400)),
                status: status.map(str::to_owned),
                exit_code,
                at_ms: None,
                revision,
                index,
            })
        })
        .collect()
}

pub fn parse_cursor(value: &str) -> Option<(&str, i64)> {
    let (id, index) = value.rsplit_once(':')?;
    let index = index.parse::<i64>().ok()?;
    (!id.is_empty() && index >= -1).then_some((id, index))
}
fn newest_turn(value: &Value) -> Option<&Value> {
    value.get("data")?.as_array()?.first()
}

/// Preserve raw source revisions while sanitizing full fields before clipping.
fn redacted_follow_entries(turn_id: &str, items: &Value) -> Vec<FollowEntry> {
    let raw_revisions: BTreeMap<usize, String> = extract_follow(turn_id, items)
        .into_iter()
        .map(|entry| (entry.index, entry.revision))
        .collect();
    let sanitized = crate::redaction::sanitize_follow_items(items);
    let mut entries = extract_follow(turn_id, &sanitized);
    for entry in &mut entries {
        if let Some(revision) = raw_revisions.get(&entry.index) {
            entry.revision = revision.clone();
        }
    }
    entries
}

/// Only emitted revisions become seen. Filtered/capped entries remain eligible
/// on a later poll even after the cursor advances to the last recorded item.
pub fn select_follow_updates(
    entries: Vec<FollowEntry>,
    start: i64,
    revisions: &mut BTreeMap<String, String>,
) -> Vec<FollowEntry> {
    let mut updates: Vec<_> = entries
        .into_iter()
        .filter(|entry| {
            (entry.index as i64 > start || revisions.get(&entry.key) != Some(&entry.revision))
                && (entry.kind == "command" || !entry.text.is_empty())
        })
        .collect();
    if updates.len() > 120 {
        updates.drain(..updates.len() - 120);
    }
    for entry in &updates {
        revisions.insert(entry.key.clone(), entry.revision.clone());
    }
    updates
}

pub async fn follow_update<T: SupervisorTransport>(
    transport: &mut T,
    thread: &KnownThread,
    cursor: &str,
    revisions: &mut BTreeMap<String, String>,
) -> Result<FollowUpdate, GatewayError> {
    let result = async {
        let summary = transport.call(SupervisorMethod::ThreadTurnsList,
            json!({"threadId":thread.id,"limit":1,"sortDirection":"desc","itemsView":"summary"})).await?;
        let Some(turn) = newest_turn(&summary) else {
            return Ok(FollowUpdate { entries: Vec::new(), cursor: cursor.into(), turn_id: None, turn_status: None, enriched: false });
        };
        let Some(id) = str_field(turn, "id") else {
            return Ok(FollowUpdate { entries: Vec::new(), cursor: cursor.into(), turn_id: None, turn_status: None, enriched: false });
        };
        let start = parse_cursor(cursor).filter(|(old, _)| *old == id).map(|(_, index)| index).unwrap_or(-1);
        let items = turn.get("items").unwrap_or(&Value::Null);
        let mut entries = redacted_follow_entries(id, items);
        let mut last = entries.last().map(|entry| entry.index as i64).unwrap_or(start);
        let mut enriched = false;
        if entries.iter().any(|entry| entry.text.is_empty()) {
            match transport.call(SupervisorMethod::ThreadTurnsList,
                json!({"threadId":thread.id,"limit":1,"sortDirection":"desc","itemsView":"full"})).await {
                Ok(full) if newest_turn(&full).and_then(|turn| str_field(turn, "id")) == Some(id) => {
                    entries = redacted_follow_entries(id, newest_turn(&full).and_then(|turn| turn.get("items")).unwrap_or(&Value::Null));
                    last = entries.last().map(|entry| entry.index as i64).unwrap_or(start);
                    enriched = true;
                }
                _ => entries.retain(|entry| !entry.text.is_empty()),
            }
        }
        let entries = select_follow_updates(entries, start, revisions);
        Ok(FollowUpdate { entries, cursor: format!("{id}:{last}"), turn_id: Some(id.into()),
            turn_status: str_field(turn, "status").map(str::to_owned), enriched })
    }.await;
    let closed = transport.close().await;
    result.and_then(|result| closed.map(|()| result))
}

pub fn resolve_rollout_path(home: &str, thread_id: &str, path: &str) -> Option<String> {
    if !path.starts_with('/') || path.contains("..") || home.is_empty() {
        return None;
    }
    let home = home.trim_end_matches('/');
    if !path.starts_with(&format!("{home}/sessions/"))
        && !path.starts_with(&format!("{home}/archived_sessions/"))
    {
        return None;
    }
    path.rsplit('/')
        .next()
        .is_some_and(|name| name.contains(thread_id))
        .then(|| path.to_owned())
}

fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error"))
}
