//! Source buffered chunk rewrite with mechanical identifier ledger and verbatim tail.
use crate::{
    text::{self, Text, text},
    types::{CompactionFailure, CompactionHost},
};
use futures_util::{StreamExt, stream};
use gateway_core::source_json::SourceJson;
use serde::Serialize;
use std::{cmp::Reverse, collections::BTreeMap};
pub const CHUNK_CHARS: usize = 150_000;
const PROMPT: &str = "You are compacting a coding-agent session memory so another model can continue the session.\n\nInput: a machine-generated memory in sections:\n- [user] / [assistant] / [developer] text blocks kept verbatim from the transcript;\n- [tool call <id>] provenance lines with their input, labelled keep / drop_result / drop_call;\n- [tool result <id>] blocks: kept verbatim or a bounded head ending in a truncation note.\n\nProduce one compact memory that a continuation model can rely on, following these rules exactly:\n1. Preserve every identifier verbatim and exactly as written: hashes, revisions, paths, thread ids, service names, versions, commands, exit codes, file names.\n2. Resolve time order. When the same fact appears more than once, keep only the latest value. If an earlier blocker was later resolved, keep only the resolution (a historical note is allowed only when it explains a current decision).\n3. Merge documents that repeat (the same instructions or memory pasted multiple times) into a single copy.\n4. Keep: the goal and its current status, decisions and approvals with their times, ownership, exact next steps, and evidence pointers (paths and hashes).\n5. Drop: superseded text, process chatter, duplicated documents, and bulk from truncated tool results.\n6. Never invent facts, values, or identifiers that are not present in the input. When the memory shows a\n   state change (an approval, acknowledgement, consumption or merge), keep the LATEST state exactly; never\n   downgrade a state to its earlier form.\n7. Output plain markdown between 20000 and 35000 characters. If you cannot fit everything, drop narrative\n   prose first; never drop identifiers, current states, decisions, or next steps.\n\nMemory to compact:\n";
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub token: Text,
    pub last_index: usize,
    pub count: usize,
}
fn add(out: &mut Vec<LedgerEntry>, by: &mut BTreeMap<Text, usize>, token: Text, index: usize) {
    if token.len() < 8 {
        return;
    }
    if let Some(&i) = by.get(&token) {
        out[i].count += 1;
        out[i].last_index = out[i].last_index.max(index);
    } else {
        by.insert(token.clone(), out.len());
        out.push(LedgerEntry {
            token,
            last_index: index,
            count: 1,
        });
    }
}
fn trim_token(raw: &Text) -> Text {
    let leading = "`\"'()[]{},;:".encode_utf16().collect::<Vec<_>>();
    let trailing = "`\"'()[]{},;:.".encode_utf16().collect::<Vec<_>>();
    let lo = raw
        .as_units()
        .iter()
        .position(|u| !leading.contains(u))
        .unwrap_or(raw.len());
    let hi = raw
        .as_units()
        .iter()
        .rposition(|u| !trailing.contains(u))
        .map_or(lo, |i| i + 1);
    raw.slice(lo, hi.max(lo))
}
fn regex(pattern: &str) -> regress::Regex {
    regress::Regex::new(pattern).expect("fixed source regular expression")
}
pub fn harvest(memory: &Text, max: usize) -> Vec<LedgerEntry> {
    let mut out = Vec::new();
    let mut by = BTreeMap::new();
    for pattern in [
        r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b",
        r"\b[0-9a-f]{8,64}\b",
        r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",
        r"\b[\w-]+\.(?:json|md|ts|sqlite3|sh|yml|yaml|service)\b",
    ] {
        for found in regex(pattern).find_from_ucs2(memory.as_units(), 0) {
            add(
                &mut out,
                &mut by,
                memory.slice(found.range.start, found.range.end),
                found.range.start,
            );
        }
    }
    // Preserve the source path scanner's exact character set and second-slash condition.
    let mut cursor = 0;
    let path_char = |u: u16| {
        (65..=90).contains(&u)
            || (97..=122).contains(&u)
            || (48..=57).contains(&u)
            || [95, 46, 64, 45].contains(&u)
    };
    while cursor < memory.len() {
        let Some(relative) = memory.as_units()[cursor..].iter().position(|&u| u == 47) else {
            break;
        };
        let start = cursor + relative;
        let mut end = start + 1;
        while end < memory.len() && path_char(memory.as_units()[end]) {
            end += 1;
        }
        let token = memory.slice(start, end);
        if token.len() >= 8 && token.as_units()[1..].contains(&47) {
            add(&mut out, &mut by, token, start);
        }
        cursor = end.max(start + 1);
    }
    let hex = regex(r"[0-9a-f]{8,}");
    let lower = regex(r"[a-z-]");
    let mut start = 0;
    for end in 0..=memory.len() {
        if end != memory.len() && !text::whitespace(memory.as_units()[end]) {
            continue;
        }
        let token = trim_token(&memory.slice(start, end));
        start = end + 1;
        if token.len() < 8
            || hex.find_from_ucs2(token.as_units(), 0).next().is_none()
            || lower.find_from_ucs2(token.as_units(), 0).next().is_none()
        {
            continue;
        }
        let index = memory
            .as_units()
            .windows(token.len())
            .rposition(|w| w == token.as_units())
            .unwrap_or(0);
        add(&mut out, &mut by, token, index);
    }
    out.sort_by_key(|e| Reverse(e.last_index));
    out.truncate(max);
    out.sort_by_key(|e| e.last_index);
    out
}
pub fn compose(model: &Text, pure: &Text) -> Text {
    let ledger = harvest(pure, 300);
    let lines = ledger
        .iter()
        .filter(|e| e.last_index as f64 >= pure.len() as f64 * 0.6)
        .map(|e| {
            if e.count > 1 {
                text!("- ", e.token, " (seen ", e.count, "x)")
            } else {
                text!("- ", e.token)
            }
        })
        .collect::<Vec<_>>();
    let section = if lines.is_empty() {
        Text::default()
    } else {
        text!(
            "\n\n## Verbatim identifiers (last seen in the final 40% of the rewritten memory)\n",
            text::join(&lines, "\n"),
            "\n"
        )
    };
    let tail = (pure.len() as f64 * 0.12).floor() as usize;
    let tail_section = if tail == 0 {
        Text::default()
    } else {
        text!(
            "\n\n## Verbatim latest transcript tail (",
            tail,
            " chars)\n",
            pure.slice(pure.len() - tail, pure.len())
        )
    };
    text!(model, section, tail_section)
}
pub fn chunks(memory: &Text, max: usize) -> Vec<Text> {
    if max == 0 || memory.len() <= max {
        return vec![memory.clone()];
    }
    let mut blocks = Vec::new();
    let mut start = 0;
    for i in 0..memory.len().saturating_sub(1) {
        if memory.as_units()[i] == 10 && memory.as_units()[i + 1] == 91 {
            blocks.push(memory.slice(start, i));
            start = i + 1;
        }
    }
    blocks.push(memory.slice(start, memory.len()));
    let mut out = Vec::new();
    let mut current = Text::default();
    for block in blocks {
        if block.len() > max {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            for start in (0..block.len()).step_by(max) {
                out.push(block.slice(start, start.saturating_add(max)));
            }
            continue;
        }
        if !current.is_empty() && current.len() + block.len() + 1 > max {
            out.push(std::mem::take(&mut current));
            current = block;
        } else {
            current = if current.is_empty() {
                block
            } else {
                text!(current, "\n", block)
            };
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}
pub fn residue_body(memory: &Text) -> Result<SourceJson, CompactionFailure> {
    let required = harvest(memory, 300);
    let ids = required
        .iter()
        .map(|e| text!("- ", e.token))
        .collect::<Vec<_>>();
    let block = if ids.is_empty() {
        Text::default()
    } else {
        text!(
            "\n\nREQUIRED IDENTIFIERS - every one of these must appear verbatim in your output; do not drop, rename, or summarize them away:\n",
            text::join(&ids, "\n")
        )
    };
    let content = text!(PROMPT, memory, block);
    text::object(vec![
        ("model", text::raw("\"gpt-oss-120b\"")?),
        ("stream", text::raw("false")?),
        ("reasoning_effort", text::raw("\"medium\"")?),
        ("max_completion_tokens", text::raw("16000")?),
        (
            "messages",
            text::json_array(&[text::object(vec![
                ("role", text::raw("\"user\"")?),
                ("content", text::quoted(&content)?),
            ])?])?,
        ),
    ])
}
fn residue_text(payload: &SourceJson) -> Option<Text> {
    let choices = text::array(&text::member(payload, "choices")?)?;
    let message = text::member(choices.first()?, "message")?;
    let content = text::string(&text::member(&message, "content")?)?;
    (!content.blank()).then_some(content)
}
pub async fn run<H: CompactionHost>(
    pure: &Text,
    host: &H,
    max: usize,
    timeout_ms: u32,
) -> Option<Text> {
    let chunks = chunks(pure, max);
    let results = stream::iter(chunks.iter().enumerate().map(|(i, chunk)| async move {
        let result = match residue_body(chunk) {
            Ok(body) => host
                .rewrite_residue(&body, timeout_ms)
                .await
                .ok()
                .and_then(|r| residue_text(&r)),
            Err(_) => None,
        };
        (i, result)
    }))
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    if results.iter().all(|(_, result)| result.is_none()) {
        return None;
    }
    let mut texts = chunks;
    for (i, result) in results {
        if let Some(result) = result {
            texts[i] = result;
        }
    }
    let result = compose(&text::join(&texts, "\n\n"), pure);
    (!result.blank() && result.len() < pure.len()).then_some(result)
}
