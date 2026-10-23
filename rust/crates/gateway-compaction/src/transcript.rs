//! Codex item mapping and source verbatim/bounded-provenance renderer.
use crate::{
    engine::truncated_result,
    model::*,
    text::{self, Text, text},
    types::{CompactionFailure, CompactionStats},
};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use serde::Serialize;
use std::{collections::BTreeMap, rc::Rc};
pub const SUMMARY_MARKER: &str = "# fast-jev-compaction memory summary";
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemRole {
    User,
    Assistant,
    Developer,
    System,
}
impl ItemRole {
    fn label(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Developer => "developer instructions",
            Self::System => "system instructions",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Entry {
    Text {
        item_type: Text,
        role: ItemRole,
        text: Text,
    },
    Call {
        item_type: Text,
        call_id: Text,
        tool: Text,
        #[serde(serialize_with = "crate::model::serialize_json")]
        input: Json,
        input_json: Text,
    },
    Result {
        item_type: Text,
        call_id: Text,
        text: Text,
        is_error: bool,
    },
}
#[derive(Clone, Debug, Serialize)]
pub struct Exclusion {
    pub index: usize,
    pub chars: usize,
    pub reason: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub entries: Vec<Entry>,
    pub messages: Vec<Message>,
    pub exclusion: Option<Exclusion>,
    pub opaque_items: usize,
}
fn field(item: &SourceJson, name: &str) -> Text {
    text::str_or_empty(text::member(item, name).as_ref())
}
fn equal(value: &Text, want: &str) -> bool {
    value.as_units().iter().copied().eq(want.encode_utf16())
}
pub fn message_text(content: Option<&SourceJson>) -> Text {
    let Some(content) = content else {
        return Text::default();
    };
    if let Some(s) = text::string(content) {
        return s;
    }
    let Some(values) = text::array(content) else {
        return Text::default();
    };
    let mut parts = Vec::new();
    for raw in values {
        if let Some(s) = text::string(&raw) {
            parts.push(s);
            continue;
        }
        if !text::is_object(&raw) {
            continue;
        }
        let kind = field(&raw, "type");
        if let Some(s) = text::member(&raw, "text").as_ref().and_then(text::string) {
            parts.push(s);
        } else if equal(&kind, "input_image") || equal(&kind, "image") {
            parts.push("[image]".into());
        } else if equal(&kind, "input_file") {
            parts.push("[file]".into());
        } else if equal(&kind, "refusal")
            && let Some(s) = text::member(&raw, "refusal")
                .as_ref()
                .and_then(text::string)
        {
            parts.push(s);
        }
    }
    text::join(&parts, "\n")
}
fn arguments(value: &Text) -> Result<SourceJson, CompactionFailure> {
    if value.trimmed().is_empty() {
        return text::raw("{}");
    }
    let Some(parsed) = text::parse_text(&value.trimmed()) else {
        return text::object(vec![("unparsed_arguments", text::quoted(value)?)]);
    };
    if text::is_object(&parsed) {
        Ok(parsed)
    } else {
        text::object(vec![("value", parsed)])
    }
}
fn output(value: Option<&SourceJson>) -> Text {
    match value {
        None => "[no output]".into(),
        Some(v) if v.as_str() == "null" => "[no output]".into(),
        Some(v) => text::string(v).unwrap_or_else(|| {
            text::canonical(v).map_or_else(
                |_| "[unserialisable output]".into(),
                |v| Text::from(v.as_str()),
            )
        }),
    }
}
fn opaque_key(key: &JsString16) -> bool {
    let s = key
        .as_units()
        .iter()
        .map(|&u| if (65..=90).contains(&u) { u + 32 } else { u })
        .collect::<Vec<_>>();
    ["encrypt", "ciphertext", "opaque", "blob", "signature"]
        .iter()
        .any(|needle| {
            let n = needle.encode_utf16().collect::<Vec<_>>();
            s.windows(n.len()).any(|w| w == n)
        })
}
fn redact(value: &SourceJson, depth: usize) -> Result<SourceJson, CompactionFailure> {
    if text::string(value).is_some()
        || matches!(value.as_str(), "null" | "true" | "false")
        || text::number(value).is_some()
    {
        return Ok(value.clone());
    }
    if depth > 6 {
        return text::quoted(&Text::from("[deeply nested value omitted]"));
    }
    if let Some(values) = text::array(value) {
        return text::json_array(
            &values
                .iter()
                .map(|v| redact(v, depth + 1))
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    let mut fields = Vec::new();
    for (k, v) in text::entries(value).ok_or_else(text::fail)? {
        if k.as_units().iter().copied().eq("__proto__".encode_utf16()) {
            continue;
        }
        let next = if opaque_key(&k) {
            text::quoted(&text!(
                "[opaque payload, ",
                text::string(&v).map_or(0, |v| v.len()),
                " chars omitted from this memory]"
            ))?
        } else {
            redact(&v, depth + 1)?
        };
        fields.push((k, next));
    }
    text::object_keys(fields)
}
fn to_message(entry: &Entry) -> Message {
    match entry {
        Entry::Text { role, text, .. } => Message {
            role: if matches!(role, ItemRole::Assistant) {
                Role::Assistant
            } else {
                Role::User
            },
            text: text.clone(),
            tool_uses: Vec::new(),
            tool_results: None,
        },
        Entry::Call {
            call_id,
            tool,
            input,
            ..
        } => Message {
            role: Role::Assistant,
            text: Text::default(),
            tool_uses: vec![ToolUse {
                tool_use_id: call_id.clone(),
                tool: tool.clone(),
                input: input.clone(),
                text: None,
                is_error: None,
            }],
            tool_results: None,
        },
        Entry::Result {
            call_id,
            text,
            is_error,
            ..
        } => Message {
            role: Role::User,
            text: Text::default(),
            tool_uses: Vec::new(),
            tool_results: Some(vec![ToolResult {
                tool_use_id: call_id.clone(),
                text: text.clone(),
                is_error: (*is_error).then_some(true),
            }]),
        },
    }
}
pub fn parse_input(input: &SourceJson) -> Result<Option<Transcript>, CompactionFailure> {
    let Some(values) = text::array(input) else {
        return Ok(None);
    };
    let mut items = Vec::new();
    for value in values {
        items.push(if text::is_object(&value) {
            value
        } else {
            text::object(vec![("type", text::raw("\"unknown\"")?), ("value", value)])?
        });
    }
    let exclusion = items.last().and_then(|last| {
        if !equal(&field(last, "type"), "message") || !equal(&field(last, "role"), "user") {
            return None;
        }
        let s = message_text(text::member(last, "content").as_ref());
        (!s.blank()).then(|| Exclusion {
            index: items.len() - 1,
            chars: s.len(),
            reason: if s.contains("CONTEXT CHECKPOINT COMPACTION")
                || s.contains("Create a handoff summary for another LLM")
            {
                "known-prompt"
            } else {
                "trailing-prompt-assumed"
            },
        })
    });
    let mut entries = Vec::new();
    let mut opaque_items = 0;
    for (i, item) in items.into_iter().enumerate() {
        if exclusion.as_ref().is_some_and(|e| e.index == i) {
            continue;
        }
        let kind = field(&item, "type");
        if equal(&kind, "message") {
            let role = field(&item, "role");
            entries.push(Entry::Text {
                item_type: "message".into(),
                role: if equal(&role, "assistant") {
                    ItemRole::Assistant
                } else if equal(&role, "developer") {
                    ItemRole::Developer
                } else if equal(&role, "system") {
                    ItemRole::System
                } else {
                    ItemRole::User
                },
                text: message_text(text::member(&item, "content").as_ref()),
            });
        } else if equal(&kind, "function_call") || equal(&kind, "custom_tool_call") {
            let function = equal(&kind, "function_call");
            let input = if function {
                arguments(&field(&item, "arguments"))?
            } else if let Some(s) = text::member(&item, "input").as_ref().and_then(text::string) {
                arguments(&s)?
            } else {
                text::member(&item, "input")
                    .filter(text::is_object)
                    .unwrap_or(text::raw("{}")?)
            };
            let input = text::canonical(&input)?;
            let name = field(&item, "name");
            let tool = if function || !name.is_empty() {
                name
            } else {
                "custom_tool".into()
            };
            entries.push(Entry::Call {
                item_type: kind,
                call_id: field(&item, "call_id"),
                tool,
                input_json: Text::from(input.as_str()),
                input: Rc::new(input),
            });
        } else if equal(&kind, "function_call_output") || equal(&kind, "custom_tool_call_output") {
            entries.push(Entry::Result {
                item_type: kind,
                call_id: field(&item, "call_id"),
                text: output(text::member(&item, "output").as_ref()),
                is_error: text::member(&item, "is_error").is_some_and(|v| v.as_str() == "true")
                    || text::member(&item, "success").is_some_and(|v| v.as_str() == "false"),
            });
        } else {
            let raw = Text::from(text::canonical(&redact(&item, 0)?)?.as_str());
            let opaque = raw.contains("opaque payload,");
            opaque_items += usize::from(opaque);
            let clipped = if raw.len() > 2000 {
                text!(
                    raw.slice(0, 2000),
                    "… [",
                    raw.len() - 2000,
                    " chars omitted]"
                )
            } else {
                raw
            };
            let label = if kind.is_empty() {
                Text::from("unknown item")
            } else {
                kind.clone()
            };
            entries.push(Entry::Text {
                item_type: if kind.is_empty() {
                    "unknown".into()
                } else {
                    kind
                },
                role: ItemRole::User,
                text: text!(
                    "[",
                    label,
                    "]",
                    if opaque {
                        " (contains an opaque payload)"
                    } else {
                        ""
                    },
                    " ",
                    clipped
                ),
            });
        }
    }
    let messages = entries.iter().map(to_message).collect();
    Ok(Some(Transcript {
        entries,
        messages,
        exclusion,
        opaque_items,
    }))
}
fn action(action: Action) -> &'static str {
    match action {
        Action::Keep => "keep",
        Action::DropResult => "drop_result",
        Action::DropCall => "drop_call",
    }
}
fn truncated_input(value: &Text, head: usize) -> Text {
    if value.len() <= head.saturating_add(60) {
        value.clone()
    } else {
        text!(
            value.slice(0, head),
            "\n[fast-jev-compaction truncated ",
            value.len() - head,
            " chars of this tool input; the call is kept as provenance]"
        )
    }
}
pub fn render(
    transcript: &Transcript,
    calls: &[ToolCall],
    decisions: &[Decision],
    head: usize,
    stats: Option<&CompactionStats>,
) -> Text {
    let ids = calls
        .iter()
        .map(|call| (call.id.clone(), call.tool_use_id.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut by = BTreeMap::new();
    for d in decisions {
        by.insert(ids.get(&d.id).unwrap_or(&d.id).clone(), d);
    }
    let mut out=vec![SUMMARY_MARKER.into(),"Tool calls and results below were classified by TypeSafe Jev (keep / truncate).".into(),"A dropped call keeps its provenance line and a bounded head of its result; nothing is erased".into(),"outright. Text kept verbatim is copied from the original transcript; this memory is text only, so".into(),"structured tool-call replay and opaque items (encrypted reasoning or compaction payloads) are not restored.".into(),Text::default()];
    for entry in &transcript.entries {
        match entry {
            Entry::Text { role, text, .. } => {
                out.extend([text!("[", role.label(), "]"), text.clone(), Text::default()])
            }
            Entry::Call {
                call_id,
                tool,
                input_json,
                ..
            } => {
                let d = by.get(call_id);
                let act = d.map_or(Action::Keep, |d| d.action);
                out.extend([
                    text!(
                        "[tool call ",
                        if call_id.is_empty() {
                            Text::from("(no call id)")
                        } else {
                            call_id.clone()
                        },
                        "] ",
                        if tool.is_empty() {
                            Text::from("(unnamed tool)")
                        } else {
                            tool.clone()
                        },
                        " — ",
                        d.map_or("no decision (kept)", |d| action(d.action))
                    ),
                    text!(
                        "input: ",
                        if act == Action::Keep {
                            input_json.clone()
                        } else {
                            truncated_input(input_json, head)
                        }
                    ),
                    Text::default(),
                ]);
            }
            Entry::Result {
                call_id,
                text: value,
                is_error,
                ..
            } => {
                if let Some(d) = by.get(call_id) {
                    if d.action == Action::Keep {
                        out.extend([
                            text!("[tool result ", call_id, " — kept verbatim]"),
                            value.clone(),
                            Text::default(),
                        ]);
                    } else {
                        out.extend([
                            text!(
                                "[tool result ",
                                call_id,
                                if d.action == Action::DropCall {
                                    " — truncated (call dropped), original was "
                                } else {
                                    " — truncated, original was "
                                },
                                value.len(),
                                " chars]"
                            ),
                            truncated_result(value, *is_error, head),
                            Text::default(),
                        ]);
                    }
                } else {
                    out.extend([
                        text!(
                            "[tool result ",
                            if call_id.is_empty() {
                                Text::from("(no call id)")
                            } else {
                                call_id.clone()
                            },
                            " — no matching call in this transcript]"
                        ),
                        value.clone(),
                        Text::default(),
                    ]);
                }
            }
        }
    }
    let line = if let Some(s) = stats {
        text!(
            "calls=",
            s.results_dropped + s.calls_dropped + s.kept + s.pinned,
            " kept=",
            s.kept,
            " results_dropped=",
            s.results_dropped,
            " calls_dropped=",
            s.calls_dropped,
            " pinned=",
            s.pinned,
            " chars_before=",
            s.chars_before,
            " chars_after=",
            s.chars_after,
            " requests=",
            s.requests,
            " stage=",
            if s.state_stage.is_empty() {
                "none"
            } else {
                &s.state_stage
            }
        )
    } else {
        "calls=0 kept=0 results_dropped=0 calls_dropped=0 pinned=0 chars_before=0 chars_after=0 requests=0 stage=none".into()
    };
    out.push(text!(
        "[fast-jev-compaction stats] items=",
        transcript.entries.len(),
        " excluded_prompt_chars=",
        transcript.exclusion.as_ref().map_or(0, |e| e.chars),
        " excluded_prompt_reason=",
        transcript.exclusion.as_ref().map_or("none", |e| e.reason),
        " opaque_items=",
        transcript.opaque_items,
        " ",
        line
    ));
    text::join(&out, "\n")
}
