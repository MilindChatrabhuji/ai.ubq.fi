//! Bounded redacted context only. No provider/network inference capability.
use crate::{
    redaction::{redact, redact_parts},
    supervisor::KnownThread,
    supervisor_inventory::{epoch_ms, text},
    supervisor_rollout::{SupervisorLogEvent, read_rollout_tail},
    transport::{SupervisorMethod, SupervisorTransport},
    unix::UnixSupervisor,
};
use gateway_core::GatewayError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct BriefTranscriptItem {
    pub r#type: String,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BriefTranscriptTurn {
    pub id: String,
    pub status: Option<String>,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub items: Vec<BriefTranscriptItem>,
    pub dropped_items: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fresh_tail: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorBriefContext {
    pub source_id: String,
    pub machine: String,
    pub thread_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub effort: Option<String>,
    pub state: Option<String>,
    pub active_flags: Vec<String>,
    pub updated_at_ms: Option<i64>,
    pub rollout_path: Option<String>,
    pub turns: Vec<BriefTranscriptTurn>,
    pub transcript_available: bool,
    pub truncated: bool,
    pub redactions: usize,
    pub context_bytes: usize,
    pub rollout_tail_events: usize,
    pub projected_history_behind_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefAssembly {
    pub turns: Vec<BriefTranscriptTurn>,
    pub transcript_available: bool,
    pub truncated: bool,
    pub redactions: usize,
    pub context_bytes: usize,
}
pub fn bounded(text: &str, limit: usize) -> String {
    if text.encode_utf16().count() <= limit {
        return text.into();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        if used + c.len_utf16() > limit.saturating_sub(1) {
            break;
        }
        used += c.len_utf16();
        out.push(c);
    }
    out.push('…');
    out
}
fn item_of(item: &Value) -> Option<BriefTranscriptItem> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let (kind, content) = match kind {
        "userMessage" => (
            "user",
            item.get("content")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|p| p["type"] == "text")
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
        ),
        "agentMessage" => (
            "assistant",
            item.get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
        ),
        "commandExecution" => {
            let command =
                text(item.get("command")).unwrap_or_else(|| "(command unavailable)".into());
            let status = text(item.get("status")).unwrap_or_else(|| "recorded".into());
            let exit = item
                .get("exitCode")
                .filter(|n| n.as_f64().is_some_and(f64::is_finite))
                .map(|v| format!(" (exit {v})"))
                .unwrap_or_default();
            let base = format!("{command} [{status}{exit}]");
            (
                "command",
                text(item.get("aggregatedOutput"))
                    .map(|out| format!("{base}\n{out}"))
                    .unwrap_or(base),
            )
        }
        "mcpToolCall" | "functionCall" | "customToolCall" | "localShellCall" | "webSearch"
        | "fileChange" => {
            let name = text(item.get("name"))
                .or_else(|| text(item.get("toolName")))
                .or_else(|| text(item.get("server")))
                .unwrap_or_default();
            let status = text(item.get("status")).unwrap_or_default();
            (
                "tool",
                [kind.to_owned(), name, status]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        }
        _ => return None,
    };
    Some(BriefTranscriptItem {
        r#type: kind.into(),
        text: content,
    })
}
pub fn brief_turn(value: &Value, head: bool) -> Option<BriefTranscriptTurn> {
    let id = text(value.get("id"))?;
    let visible = value
        .get("items")
        .and_then(Value::as_array)
        .map(|v| {
            v.iter()
                .filter_map(item_of)
                .filter(|v| !v.text.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let dropped_items = visible.len().saturating_sub(12);
    let items = if head {
        visible.into_iter().take(12).collect()
    } else {
        visible.into_iter().skip(dropped_items).collect()
    };
    Some(BriefTranscriptTurn {
        id,
        status: text(value.get("status")),
        started_at_ms: epoch_ms(value.get("startedAt")),
        completed_at_ms: epoch_ms(value.get("completedAt")),
        items,
        dropped_items,
        fresh_tail: None,
    })
}
pub fn dedupe_turns(turns: Vec<BriefTranscriptTurn>) -> Vec<BriefTranscriptTurn> {
    let mut out: Vec<BriefTranscriptTurn> = Vec::new();
    for mut turn in turns {
        if let Some(at) = out.iter().position(|v| v.id == turn.id) {
            let old = &out[at];
            turn.dropped_items += old.dropped_items;
            if let Some(request) = old.items.iter().find(|v| v.r#type == "user") {
                let mut items = vec![request.clone()];
                items.extend(
                    turn.items
                        .into_iter()
                        .rev()
                        .take(11)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .filter(|v| v.text != request.text),
                );
                turn.items = items;
            }
            out[at] = turn;
        } else {
            out.push(turn);
        }
    }
    out
}
fn time(turn: &BriefTranscriptTurn) -> i64 {
    turn.completed_at_ms.or(turn.started_at_ms).unwrap_or(0)
}
pub fn newest_turn_ms(turns: &[BriefTranscriptTurn]) -> i64 {
    turns.iter().map(time).max().unwrap_or(0).max(0)
}
pub fn append_rollout_tail(
    turns: &[BriefTranscriptTurn],
    thread_id: &str,
    state: Option<&str>,
    events: &[SupervisorLogEvent],
) -> Vec<BriefTranscriptTurn> {
    let mut known = turns
        .iter()
        .flat_map(|t| t.items.iter().map(|i| i.text.clone()))
        .collect::<std::collections::BTreeSet<_>>();
    let cutoff = newest_turn_ms(turns);
    let filtered = events
        .iter()
        .filter(|e| e.at_ms >= cutoff)
        .collect::<Vec<_>>();
    let parts = filtered.iter().map(|e| e.text.clone()).collect::<Vec<_>>();
    let texts = redact_parts(&parts);
    let mut kept = std::collections::VecDeque::new();
    let mut dropped = 0;
    for (event, result) in filtered.into_iter().zip(texts) {
        let clipped = bounded(&result.text, if event.kind == "tool" { 400 } else { 1200 });
        let content = clipped.trim_matches(crate::redaction::source_whitespace);
        if content.is_empty() || !known.insert(content.into()) {
            dropped += 1;
            continue;
        }
        kept.push_back((
            event.at_ms,
            BriefTranscriptItem {
                r#type: event.kind.clone(),
                text: content.into(),
            },
        ));
        if kept.len() > 12 {
            kept.pop_front();
            dropped += 1;
        }
    }
    let mut out = turns.to_vec();
    if let (Some(first), Some(last)) = (kept.front(), kept.back()) {
        out.push(BriefTranscriptTurn {
            id: format!("rollout-tail:{thread_id}"),
            status: state.map(str::to_owned),
            started_at_ms: Some(first.0),
            completed_at_ms: Some(last.0),
            items: kept.into_iter().map(|(_, item)| item).collect(),
            dropped_items: dropped,
            fresh_tail: Some(true),
        });
    }
    out
}
pub fn assemble_brief_context(turns: &[BriefTranscriptTurn]) -> BriefAssembly {
    let parts = turns
        .iter()
        .flat_map(|t| t.items.iter().map(|i| i.text.clone()))
        .collect::<Vec<_>>();
    let mut redacted = redact_parts(&parts).into_iter();
    let mut prepared = Vec::new();
    for turn in turns {
        let items = turn
            .items
            .iter()
            .map(|item| (item.clone(), redacted.next().unwrap_or_else(|| redact(""))))
            .collect::<Vec<_>>();
        prepared.push((turn.clone(), items));
    }
    let mut remaining = 32 * 1024;
    let mut redactions = 0;
    let mut truncated = turns.iter().any(|t| t.dropped_items > 0);
    let mut kept = vec![None; turns.len()];
    let order = (1..turns.len())
        .rev()
        .chain((!turns.is_empty()).then_some(0));
    for index in order {
        let (turn, items) = &prepared[index];
        let mut next = turn.clone();
        next.items.clear();
        for (item, result) in items {
            redactions += result.redactions;
            let value = bounded(&result.text, 1200);
            if value.len() > remaining {
                truncated = true;
                break;
            }
            remaining -= value.len();
            next.items.push(BriefTranscriptItem {
                r#type: item.r#type.clone(),
                text: value,
            });
        }
        if next.items.is_empty() {
            if !items.is_empty() {
                truncated = true;
            }
        } else {
            kept[index] = Some(next);
        }
    }
    let kept = kept.into_iter().flatten().collect::<Vec<_>>();
    BriefAssembly {
        transcript_available: !kept.is_empty(),
        truncated: truncated || kept.len() < turns.len(),
        turns: kept,
        redactions,
        context_bytes: 32 * 1024 - remaining,
    }
}
fn call(
    socket: &mut UnixSupervisor,
    method: SupervisorMethod,
    params: Value,
) -> Result<Value, GatewayError> {
    futures_executor::block_on(socket.call(method, params))
}
fn fetch_turns(
    socket: &mut UnixSupervisor,
    id: &str,
    direction: &str,
    limit: usize,
    view: &str,
) -> Result<Vec<BriefTranscriptTurn>, GatewayError> {
    let value = call(
        socket,
        SupervisorMethod::ThreadTurnsList,
        json!({"threadId":id,"limit":limit,"sortDirection":direction,"itemsView":view}),
    )?;
    Ok(value
        .get("data")
        .and_then(Value::as_array)
        .map(|v| {
            v.iter()
                .filter_map(|v| brief_turn(v, direction == "asc"))
                .collect()
        })
        .unwrap_or_default())
}
pub(crate) fn collect_context(
    socket_path: &Path,
    home: Option<&Path>,
    thread: &KnownThread,
    machine: &str,
    _now_ms: i64,
) -> Result<SupervisorBriefContext, GatewayError> {
    let mut socket = UnixSupervisor::configured_socket_until(
        socket_path,
        Instant::now() + Duration::from_secs(45),
    )?;
    let result = (|| {
        let reply = call(
            &mut socket,
            SupervisorMethod::ThreadRead,
            json!({"threadId":thread.id(),"includeTurns":false}),
        )?;
        let meta = reply.get("thread").cloned().unwrap_or(Value::Null);
        let status = meta.get("status");
        let state = status
            .and_then(|v| v.get("type"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let active_flags = status
            .and_then(|v| v.get("activeFlags"))
            .and_then(Value::as_array)
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let first = fetch_turns(&mut socket, thread.id(), "asc", 1, "summary")?;
        let mut recent = fetch_turns(&mut socket, thread.id(), "desc", 6, "summary")?;
        recent.reverse();
        let opening = first.first().map(|t| t.id.clone());
        let mut projected = dedupe_turns(first.into_iter().chain(recent).collect());
        if projected.last().is_some_and(|t| t.items.is_empty()) {
            let target = projected.last().map(|t| t.id.clone());
            let _opening_priority = opening;
            if let Ok(full) = fetch_turns(&mut socket, thread.id(), "desc", 1, "full")
                && let Some(mut full) = full
                    .into_iter()
                    .next()
                    .filter(|t| !t.items.is_empty() && Some(&t.id) == target.as_ref())
                && let Some(old) = projected.iter_mut().find(|t| t.id == full.id)
            {
                full.dropped_items += old.dropped_items;
                *old = full;
            }
        }
        let rollout_path = text(meta.get("path"));
        let events = read_rollout_tail(home, thread, rollout_path.as_deref());
        let turns = append_rollout_tail(&projected, thread.id(), state.as_deref(), &events);
        let tail_events = turns
            .iter()
            .find(|t| t.fresh_tail == Some(true))
            .map(|t| t.items.len())
            .unwrap_or(0);
        let updated = epoch_ms(meta.get("updatedAt"));
        let newest = newest_turn_ms(&projected);
        let behind = updated
            .filter(|_| newest > 0)
            .map(|n| n.saturating_sub(newest).max(0));
        let assembly = assemble_brief_context(&turns);
        let mut context = SupervisorBriefContext {
            source_id: thread.source().as_str().into(),
            machine: machine.into(),
            thread_id: thread.id().into(),
            title: text(meta.get("name")).or_else(|| text(meta.get("preview"))),
            cwd: text(meta.get("cwd")),
            model: text(meta.get("model")),
            provider: text(meta.get("modelProvider")),
            effort: text(meta.get("reasoningEffort")),
            state,
            active_flags,
            updated_at_ms: updated,
            rollout_path,
            turns: assembly.turns,
            transcript_available: assembly.transcript_available,
            truncated: assembly.truncated,
            redactions: assembly.redactions,
            context_bytes: assembly.context_bytes,
            rollout_tail_events: tail_events,
            projected_history_behind_ms: behind,
        };
        sanitize_context_metadata(&mut context);
        Ok(context)
    })();
    // A failed newest-full read may already have dropped its socket; closing
    // cannot replace the recorded-summary fallback with a transport failure.
    let _ = futures_executor::block_on(socket.close());
    result
}

/// Matches source per-field prompt framing; flags are redacted after comma join.
pub fn sanitize_context_metadata(context: &mut SupervisorBriefContext) {
    for value in [
        &mut context.title,
        &mut context.cwd,
        &mut context.model,
        &mut context.provider,
        &mut context.effort,
        &mut context.state,
        &mut context.rollout_path,
    ]
    .into_iter()
    .flatten()
    {
        *value = redact(value).text;
    }
    context.machine = redact(&context.machine).text;
    let joined = context.active_flags.join(",");
    let sanitized = redact(&joined);
    if sanitized.redactions > 0 {
        context.active_flags = vec![sanitized.text];
    }
}
