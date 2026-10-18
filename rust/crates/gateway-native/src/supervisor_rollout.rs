//! Bounded visible rollout reads for an already selected thread only.
use crate::supervisor::{KnownThread, resolve_rollout_path};
use crate::supervisor_inventory::text;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorLogEvent {
    pub at_ms: i64,
    pub kind: String,
    pub text: String,
}
pub fn parse_rollout_tail(input: &str) -> Vec<SupervisorLogEvent> {
    let mut events = std::collections::VecDeque::new();
    for line in input.lines() {
        let line = line.trim_matches(crate::redaction::source_whitespace);
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record["type"] != "response_item" {
            continue;
        }
        let Some(payload) = record.get("payload").filter(|p| p.is_object()) else {
            continue;
        };
        let Some(stamp) = record
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
        else {
            continue;
        };
        let at_ms = (stamp.unix_timestamp_nanos() / 1_000_000) as i64;
        let event = match payload.get("type").and_then(Value::as_str) {
            Some("message") => {
                let visible = ["channel", "phase"].iter().all(|key| {
                    text(payload.get(key)).is_none_or(|s| {
                        matches!(
                            s.to_ascii_lowercase().as_str(),
                            "commentary" | "final" | "final_answer"
                        )
                    })
                });
                let role = payload.get("role").and_then(Value::as_str);
                if !visible || !role.is_some_and(|s| s == "user" || s == "assistant") {
                    continue;
                }
                let content = payload
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter(|p| {
                                p.get("type").and_then(Value::as_str).is_some_and(|t| {
                                    matches!(t, "output_text" | "input_text" | "text")
                                })
                            })
                            .filter_map(|p| p.get("text").and_then(Value::as_str))
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                if content.is_empty() {
                    continue;
                }
                SupervisorLogEvent {
                    at_ms,
                    kind: role.unwrap_or("assistant").into(),
                    text: content,
                }
            }
            Some("custom_tool_call" | "function_call") => SupervisorLogEvent {
                at_ms,
                kind: "tool".into(),
                text: format!(
                    "tool: {} {}",
                    text(payload.get("name"))
                        .unwrap_or_else(|| payload["type"].as_str().unwrap_or("tool").into()),
                    text(payload.get("status")).unwrap_or_else(|| "recorded".into())
                ),
            },
            Some("custom_tool_call_output" | "function_call_output") => {
                let Some(output) = text(payload.get("output")) else {
                    continue;
                };
                SupervisorLogEvent {
                    at_ms,
                    kind: "tool".into(),
                    text: format!("tool output: {output}"),
                }
            }
            _ => continue,
        };
        events.push_back(event);
        if events.len() > 200 {
            events.pop_front();
        }
    }
    events.into_iter().collect()
}
pub fn read_rollout_tail(
    home: Option<&Path>,
    thread: &KnownThread,
    rollout: Option<&str>,
) -> Vec<SupervisorLogEvent> {
    fn read(home: &Path, thread: &KnownThread, raw: &str) -> Option<Vec<SupervisorLogEvent>> {
        let home = home.to_str()?;
        let lexical = resolve_rollout_path(home, thread.id(), raw)?;
        let resolved = fs::canonicalize(&lexical).ok()?;
        resolve_rollout_path(home, thread.id(), resolved.to_str()?)?;
        if !fs::metadata(&resolved).ok()?.is_file() {
            return None;
        }
        let mut file = File::open(&resolved).ok()?;
        let info = file.metadata().ok()?;
        if !info.is_file() {
            return None;
        }
        let rechecked = fs::canonicalize(&lexical).ok()?;
        resolve_rollout_path(home, thread.id(), rechecked.to_str()?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let current = fs::metadata(&rechecked).ok()?;
            if current.dev() != info.dev() || current.ino() != info.ino() {
                return None;
            }
        }
        let start = info.len().saturating_sub(256 * 1024);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.take(256 * 1024).read_to_end(&mut bytes).ok()?;
        let decoded = String::from_utf8_lossy(&bytes);
        let complete = if start > 0 {
            decoded
                .find('\n')
                .map(|at| &decoded[at + 1..])
                .unwrap_or(&decoded)
        } else {
            &decoded
        };
        Some(parse_rollout_tail(complete))
    }
    home.zip(rollout)
        .and_then(|(home, path)| read(home, thread, path))
        .unwrap_or_default()
}
