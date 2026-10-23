//! Source call decisions, request batching, local windows and projected transcript.
use crate::{
    model::*,
    state::{self, estimate_tokens, fit_state},
    text::{self, Text, text},
    types::{CompactionFailure, CompactionHost, CompactionStats, FailureKind, JEV_TIMEOUT_MS},
};
use futures_util::{StreamExt, TryStreamExt, future::try_join_all, stream};
use gateway_core::source_json::SourceJson;
use std::collections::{BTreeMap, BTreeSet};
fn failed(detail: &'static str) -> CompactionFailure {
    CompactionFailure::new(FailureKind::JevFailed, detail)
}
pub fn check<H: CompactionHost>(host: &H) -> Result<(), CompactionFailure> {
    if host.cancelled() {
        Err(CompactionFailure::new(FailureKind::Cancelled, "aborted"))
    } else {
        Ok(())
    }
}
pub fn now<H: CompactionHost>(host: &H) -> Result<i64, CompactionFailure> {
    host.now_ms().map_err(|_| failed("clock-unavailable"))
}
fn questions(call: &ToolCall) -> Result<SourceJson, CompactionFailure> {
    let call_text = text!(
        "Tool call ",
        call.id,
        " (",
        call.tool,
        ") should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next"
    );
    let result_text = text!(
        "The full output of tool call ",
        call.id,
        " (",
        call.tool,
        ", ",
        call.result_chars,
        " chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do"
    );
    let question = |s: &Text| {
        text::object(vec![
            ("type", text::raw("\"noul\"")?),
            ("instructions", text::quoted(s)?),
        ])
    };
    text::object_keys(vec![
        (text!("call_", call.id).core(), question(&call_text)?),
        (text!("result_", call.id).core(), question(&result_text)?),
    ])
}
fn batches(
    candidates: &[ToolCall],
    tokens: usize,
    options: &Resolved,
) -> Result<Vec<Vec<ToolCall>>, CompactionFailure> {
    let budget = options.request_tokens - tokens as f64 - 20.0;
    let mut out = Vec::new();
    let mut current = Vec::new();
    let mut used = 0;
    for call in candidates {
        let size = estimate_tokens(&Text::from(questions(call)?.as_str()));
        if !current.is_empty() && (used + size) as f64 > budget {
            out.push(std::mem::take(&mut current));
            used = 0;
        }
        if current.is_empty() && size as f64 > budget {
            return Err(failed("state-over-budget"));
        }
        current.push(call.clone());
        used += size;
    }
    if !current.is_empty() {
        out.push(current);
    }
    Ok(out)
}
async fn ask_batch<H: CompactionHost>(
    host: &H,
    state: &SourceJson,
    batch: &[ToolCall],
) -> Result<Vec<(Text, (f64, f64))>, CompactionFailure> {
    check(host)?;
    let mut fields = Vec::new();
    for call in batch {
        fields.extend(text::entries(&questions(call)?).ok_or_else(|| failed("invalid questions"))?);
    }
    let questions = text::object_keys(fields)?;
    let response = host
        .ask_jev(state, &questions, JEV_TIMEOUT_MS)
        .await
        .map_err(|_| {
            if host.cancelled() {
                CompactionFailure::new(FailureKind::Cancelled, "aborted")
            } else {
                failed("upstream")
            }
        })?;
    check(host)?;
    let answers = text::member(&response, "answers")
        .filter(|v| text::is_object(v) || text::array(v).is_some())
        .ok_or_else(|| failed("missing-answers"))?;
    let answer = |name: &Text| -> Result<f64, CompactionFailure> {
        let name = name.try_utf8().map_err(|_| failed("invalid answer"))?;
        let entry = text::member(&answers, &name).ok_or_else(|| failed("invalid-answer"))?;
        text::member(&entry, "noul")
            .as_ref()
            .and_then(text::number)
            .filter(|v| v.is_finite())
            .ok_or_else(|| failed("invalid-answer"))
    };
    batch
        .iter()
        .map(|call| {
            Ok((
                call.id.clone(),
                (
                    answer(&text!("call_", call.id))?,
                    answer(&text!("result_", call.id))?,
                ),
            ))
        })
        .collect()
}
pub fn truncated_result(value: &Text, error: bool, head: usize) -> Text {
    if value.len() <= head.saturating_add(120) {
        return value.clone();
    }
    let prefix = if head > 0 {
        text!(value.slice(0, head), "\n")
    } else {
        Text::default()
    };
    text!(
        prefix,
        "[fast-jev-compaction truncated ",
        value.len() - head,
        " chars of this tool result",
        if error { " (error)" } else { "" },
        "; re-run the tool if needed]"
    )
}
fn projected(
    messages: &[Message],
    calls: &[ToolCall],
    decisions: &[Decision],
    head: usize,
) -> Vec<Message> {
    let by = calls
        .iter()
        .map(|c| (c.id.clone(), c))
        .collect::<BTreeMap<_, _>>();
    let mut actions = BTreeMap::new();
    for d in decisions {
        if let Some(call) = by.get(&d.id)
            && d.action != Action::Keep
        {
            actions.insert(call.tool_use_id.clone(), d.action);
        }
    }
    let mut kept = Vec::new();
    for message in messages {
        let touched = message
            .tool_uses
            .iter()
            .any(|t| actions.contains_key(&t.tool_use_id))
            || message
                .tool_results
                .iter()
                .flatten()
                .any(|t| actions.contains_key(&t.tool_use_id));
        if !touched {
            kept.push(message.clone());
            continue;
        }
        let tools = message
            .tool_uses
            .iter()
            .filter(|t| actions.get(&t.tool_use_id) != Some(&Action::DropCall))
            .map(|t| {
                let mut next = t.clone();
                if actions.get(&t.tool_use_id) == Some(&Action::DropResult) {
                    let old = t.text.clone().unwrap_or_default();
                    let text = truncated_result(&old, t.is_error.unwrap_or(false), head);
                    if old != text {
                        next.text = Some(text);
                        next.is_error = t.is_error.filter(|v| *v);
                    }
                }
                next
            })
            .collect::<Vec<_>>();
        let results = message
            .tool_results
            .iter()
            .flatten()
            .filter(|t| actions.get(&t.tool_use_id) != Some(&Action::DropCall))
            .map(|t| {
                let mut next = t.clone();
                if actions.get(&t.tool_use_id) == Some(&Action::DropResult) {
                    next.text = truncated_result(&t.text, t.is_error.unwrap_or(false), head);
                }
                next
            })
            .collect::<Vec<_>>();
        if tools == message.tool_uses
            && results.as_slice() == message.tool_results.as_deref().unwrap_or_default()
        {
            kept.push(message.clone());
            continue;
        }
        if message.text.blank() && tools.is_empty() && results.is_empty() {
            continue;
        }
        kept.push(Message {
            role: message.role,
            text: message.text.clone(),
            tool_uses: tools,
            tool_results: (!results.is_empty()).then_some(results),
        });
    }
    kept
}
pub fn message_chars(message: &Message) -> usize {
    message.text.len()
        + message
            .tool_uses
            .iter()
            .map(|t| text::canonical(&t.input).map_or(20, |v| Text::from(v.as_str()).len()))
            .sum::<usize>()
        + message
            .tool_results
            .iter()
            .flatten()
            .map(|r| r.text.len())
            .sum::<usize>()
}
pub fn plan_windows(messages: &[Message], calls: &[ToolCall], max: usize) -> Vec<(usize, usize)> {
    let mut required = BTreeMap::new();
    for c in calls {
        let lo = c.call_index.min(c.result_index);
        let hi = c.call_index.max(c.result_index);
        required
            .entry(lo)
            .and_modify(|n: &mut usize| *n = (*n).max(hi))
            .or_insert(hi);
    }
    let mut windows = Vec::new();
    let (mut start, mut chars, mut i) = (0, 0, 0);
    while i < messages.len() {
        let size = message_chars(&messages[i]);
        if i > start && chars + size > max {
            let mut end = i;
            let mut cursor = start;
            while cursor < end {
                if let Some(&n) = required.get(&cursor) {
                    end = end.max(n + 1);
                }
                cursor += 1;
            }
            windows.push((start, end));
            start = end;
            chars = 0;
            i = i.max(end.saturating_sub(1));
        } else {
            chars += size;
        }
        i += 1;
    }
    if start < messages.len() {
        windows.push((start, messages.len()));
    }
    windows
}
pub async fn compact<H: CompactionHost>(
    messages: &[Message],
    host: &H,
    options: &Options,
) -> Result<CompactResult, CompactionFailure> {
    check(host)?;
    let started = now(host)?;
    let options = options.resolve();
    let calls = state::collect_calls(messages, options.recent);
    let candidates = calls
        .iter()
        .filter(|c| !c.pinned)
        .cloned()
        .collect::<Vec<_>>();
    let chars_before = messages.iter().map(message_chars).sum();
    let mut answers = BTreeMap::new();
    let (mut tokens, mut stage, mut requests, mut windows) = (0, String::new(), 0, 0);
    if !candidates.is_empty() {
        let fitted = fit_state(messages, &calls, &options)?;
        let plan = plan_windows(messages, &calls, 80_000);
        let degraded = fitted.stage != "full" && !fitted.stage.starts_with("inputs<=");
        if candidates.len() >= 40 && degraded && plan.len() > 1 {
            let ids = candidates
                .iter()
                .map(|c| c.id.clone())
                .collect::<BTreeSet<_>>();
            let tasks = plan
                .into_iter()
                .filter_map(|(start, end)| {
                    let own = calls
                        .iter()
                        .filter(|c| {
                            c.call_index >= start && c.call_index < end && c.result_index < end
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    let candidates = own
                        .iter()
                        .filter(|c| ids.contains(&c.id))
                        .cloned()
                        .collect::<Vec<_>>();
                    (!candidates.is_empty()).then_some((start, end, own, candidates))
                })
                .collect::<Vec<_>>();
            windows = tasks.len();
            let results = stream::iter(tasks.iter().enumerate().map(
                |(index, (start, end, own, candidates))| {
                    let options = &options;
                    async move {
                        let local = fit_state(
                            &messages[*start..*end],
                            own,
                            &Resolved {
                                recent: 0,
                                ..options.clone()
                            },
                        )?;
                        let wire = state::json(&local.state)?;
                        let mut answers = Vec::new();
                        let groups = batches(candidates, local.tokens, options)?;
                        for group in &groups {
                            answers.extend(ask_batch(host, &wire, group).await?);
                        }
                        Ok::<_, CompactionFailure>((
                            index,
                            local.stage,
                            local.tokens,
                            groups.len(),
                            answers,
                        ))
                    }
                },
            ))
            .buffer_unordered(3)
            .try_collect::<Vec<_>>()
            .await?;
            let mut results = results;
            results.sort_by_key(|r| r.0);
            let mut stages = Vec::new();
            for (_, s, t, r, a) in results {
                stages.push(s);
                tokens = tokens.max(t);
                requests += r;
                answers.extend(a);
            }
            stage = format!("windowed x{windows} [{}]", stages.join(", "));
            stage.truncate(stage.len().min(200));
        } else {
            tokens = fitted.tokens;
            stage = fitted.stage;
            let wire = state::json(&fitted.state)?;
            let groups = batches(&candidates, tokens, &options)?;
            requests = groups.len();
            for group in
                try_join_all(groups.iter().map(|batch| ask_batch(host, &wire, batch))).await?
            {
                answers.extend(group);
            }
        }
    }
    // Pinned calls are the only defaults. Every candidate's two answers must exist.
    let mut decisions = Vec::new();
    for call in &calls {
        let (keep_call, keep_result) = if call.pinned {
            (1.0, 1.0)
        } else {
            *answers
                .get(&call.id)
                .ok_or_else(|| failed("missing-decision"))?
        };
        let (action, reason) = if call.pinned {
            (Action::Keep, Reason::Pinned)
        } else if keep_result >= options.threshold {
            (Action::Keep, Reason::Kept)
        } else if keep_call >= options.threshold {
            (Action::DropResult, Reason::ResultDropped)
        } else {
            (Action::DropCall, Reason::CallDropped)
        };
        decisions.push(Decision {
            id: call.id.clone(),
            tool: call.tool.clone(),
            keep_call,
            keep_result,
            action,
            reason,
        });
    }
    let kept = projected(messages, &calls, &decisions, options.head);
    let count = |r| decisions.iter().filter(|d| d.reason == r).count();
    let stats = CompactionStats {
        messages_before: messages.len(),
        messages_after: kept.len(),
        chars_before,
        chars_after: kept.iter().map(message_chars).sum(),
        calls: calls.len(),
        kept: count(Reason::Kept),
        results_dropped: count(Reason::ResultDropped),
        calls_dropped: count(Reason::CallDropped),
        pinned: count(Reason::Pinned),
        state_tokens: tokens,
        state_stage: stage,
        windows,
        requests,
        ms: now(host)? - started,
    };
    Ok(CompactResult {
        messages: kept,
        decisions,
        stats,
    })
}
