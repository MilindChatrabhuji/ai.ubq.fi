//! Mechanical source state fitting ladder and calibrated UTF16 token estimator.
use crate::{
    model::*,
    text::{self, Text, text},
    types::{CompactionFailure, FailureKind},
};
use gateway_core::source_json::SourceJson;
use serde::Serialize;
use std::collections::BTreeMap;
const CONTEXT: &str = "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";
pub fn json<T: Serialize + ?Sized>(value: &T) -> Result<SourceJson, CompactionFailure> {
    SourceJson::from_serializable(value)
        .map_err(|_| CompactionFailure::new(FailureKind::JevFailed, "state serialization failed"))
}
pub fn estimate_tokens(text: &Text) -> usize {
    let units = text.as_units();
    let mut at = 0;
    let mut tokens = 0.0_f64;
    while at < units.len() {
        let u = units[at];
        if text::whitespace(u) {
            at += 1;
            continue;
        }
        let letter = |v: u16| (65..=90).contains(&v) || (97..=122).contains(&v);
        let digit = |v: u16| (48..=57).contains(&v);
        if letter(u) || digit(u) {
            let begin = at;
            at += 1;
            while at < units.len()
                && if letter(u) {
                    letter(units[at])
                } else {
                    digit(units[at])
                }
            {
                at += 1;
            }
            let len = at - begin;
            tokens += if digit(u) {
                len as f64 / 2.0
            } else {
                (1 + (len - 1) / 6) as f64
            };
        } else {
            tokens += 0.9;
            at += 1;
        }
    }
    tokens.ceil() as usize
}
pub fn truncate(text: &Text, limit: usize) -> Text {
    if text.len() <= limit {
        text.clone()
    } else {
        text!(text.slice(0, limit.saturating_sub(1)), "…")
    }
}
fn abridge(value: &Text, head: usize, tail: usize) -> Text {
    if value.len() <= head + tail + 40 {
        return value.clone();
    }
    text!(
        value.slice(0, head),
        "\n[… ",
        value.len() - head - tail,
        " chars omitted …]\n",
        value.slice(value.len().saturating_sub(tail), value.len())
    )
}
fn pinned(i: usize, total: usize, recent: usize) -> bool {
    i == 0 || i >= total.saturating_sub(recent)
}
pub fn collect_calls(messages: &[Message], recent: usize) -> Vec<ToolCall> {
    let mut results = BTreeMap::new();
    for (i, m) in messages.iter().enumerate() {
        for result in m.tool_results.iter().flatten() {
            results.insert(result.tool_use_id.clone(), (i, result));
        }
    }
    let mut calls = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        for tool in &m.tool_uses {
            if let Some((j, result)) = results.get(&tool.tool_use_id) {
                calls.push(ToolCall {
                    id: text!("t", calls.len() + 1),
                    tool_use_id: tool.tool_use_id.clone(),
                    tool: tool.tool.clone(),
                    input: tool.input.clone(),
                    call_index: i,
                    result_index: *j,
                    result_chars: result.text.len(),
                    is_error: result.is_error.unwrap_or(false),
                    pinned: pinned(i, messages.len(), recent) || pinned(*j, messages.len(), recent),
                });
            }
        }
    }
    calls
}
fn input_text(input: &SourceJson, limit: usize) -> Text {
    let text = text::canonical(input)
        .map(|v| Text::from(v.as_str()))
        .unwrap_or_else(|_| Text::from("[unserializable input]"));
    truncate(&text, limit)
}
fn compact_call(call: &ToolCall) -> Result<Text, CompactionFailure> {
    let mut values = Vec::new();
    for (key, value) in text::entries(&call.input).unwrap_or_default() {
        let val = if let Some(s) = text::string(&value) {
            s
        } else {
            input_text(&text::object_keys(vec![(key.clone(), value)])?, 200)
        };
        values.push(text!(Text::from(key), "=", text::collapsed(&val)));
    }
    Ok(text!(
        call.id,
        " ",
        call.tool,
        " ",
        truncate(&text::join(&values, " "), 60),
        " → ",
        if call.is_error { "error" } else { "ok" },
        " ",
        call.result_chars,
        "ch"
    ))
}
fn by_message(calls: &[ToolCall]) -> BTreeMap<usize, Vec<&ToolCall>> {
    let mut map: BTreeMap<usize, Vec<&ToolCall>> = BTreeMap::new();
    for call in calls {
        map.entry(call.call_index).or_default().push(call);
    }
    map
}
fn history(messages: &[Message], calls: &[ToolCall], limit: usize) -> Vec<HistoryEntry> {
    let by = by_message(calls);
    let mut entries = Vec::new();
    for (i, m) in messages.iter().enumerate() {
        let own = by
            .get(&i)
            .into_iter()
            .flatten()
            .map(|call| HistoryCall {
                id: call.id.clone(),
                tool: call.tool.clone(),
                input: input_text(&call.input, limit),
                result: text!(
                    if call.is_error { "error" } else { "ok" },
                    ", ",
                    call.result_chars,
                    " chars (omitted)"
                ),
            })
            .collect::<Vec<_>>();
        if m.text.blank() && own.is_empty() {
            continue;
        }
        entries.push(HistoryEntry {
            i,
            role: m.role,
            text: m.text.clone(),
            tool_calls: if own.is_empty() {
                None
            } else {
                Some(HistoryCalls::Structured(own))
            },
        });
    }
    entries
}
fn goal(messages: &[Message]) -> Text {
    let values = messages
        .iter()
        .filter(|m| {
            m.role == Role::User
                && !m.text.blank()
                && m.tool_results.as_ref().is_none_or(Vec::is_empty)
        })
        .map(|m| truncate(&m.text, 500))
        .collect::<Vec<_>>();
    text::join(&values[values.len().saturating_sub(3)..], "\n")
}
fn entry_tokens(entry: &HistoryEntry) -> Result<usize, CompactionFailure> {
    Ok(estimate_tokens(&Text::from(json(entry)?.as_str())) + 1)
}
fn state(history: Vec<HistoryEntry>, goal: Text) -> State {
    State {
        context: CONTEXT.into(),
        goal,
        history,
    }
}
fn fitted(history: Vec<HistoryEntry>, goal: &Text, tokens: usize, stage: &str) -> Fitted {
    Fitted {
        state: state(history, goal.clone()),
        tokens,
        stage: stage.into(),
    }
}
fn recount(
    history: &[HistoryEntry],
    base: usize,
) -> Result<(Vec<usize>, usize), CompactionFailure> {
    let per = history
        .iter()
        .map(entry_tokens)
        .collect::<Result<Vec<_>, _>>()?;
    let total = base + per.iter().sum::<usize>();
    Ok((per, total))
}
fn update(
    history: &[HistoryEntry],
    per: &mut [usize],
    tokens: &mut usize,
    i: usize,
) -> Result<(), CompactionFailure> {
    let now = entry_tokens(&history[i])?;
    *tokens = *tokens - per[i] + now;
    per[i] = now;
    Ok(())
}
pub fn fit_state(
    messages: &[Message],
    calls: &[ToolCall],
    options: &Resolved,
) -> Result<Fitted, CompactionFailure> {
    let goal = if options.goal.is_empty() {
        goal(messages)
    } else {
        options.goal.clone()
    };
    let base = estimate_tokens(&Text::from(
        json(&state(Vec::new(), goal.clone()))?.as_str(),
    ));
    let mut entries = Vec::new();
    let mut per = Vec::new();
    let mut tokens = 0;
    for limit in [1000, 200, 60] {
        entries = history(messages, calls, limit);
        (per, tokens) = recount(&entries, base)?;
        if tokens as f64 <= options.state_tokens {
            return Ok(fitted(
                entries,
                &goal,
                tokens,
                if limit == 1000 {
                    "full"
                } else if limit == 200 {
                    "inputs<=200"
                } else {
                    "inputs<=60"
                },
            ));
        }
    }
    let pin = |entry: &HistoryEntry| pinned(entry.i, messages.len(), options.recent);
    let order = (0..entries.len())
        .filter(|&i| !pin(&entries[i]))
        .chain((0..entries.len()).filter(|&i| pin(&entries[i])))
        .collect::<Vec<_>>();
    for &i in &order {
        if entries[i].text.len() <= 590 {
            continue;
        }
        entries[i].text = abridge(&entries[i].text, 400, 150);
        update(&entries, &mut per, &mut tokens, i)?;
        if tokens as f64 <= options.state_tokens {
            return Ok(fitted(entries, &goal, tokens, "texts abridged"));
        }
    }
    for &i in &order {
        let e = &entries[i];
        if pin(e) || e.text.is_empty() {
            continue;
        }
        let original = messages.get(e.i).map_or(e.text.len(), |m| m.text.len());
        entries[i].text = text!("[… ", original, " chars omitted …]");
        update(&entries, &mut per, &mut tokens, i)?;
        if tokens as f64 <= options.state_tokens {
            return Ok(fitted(entries, &goal, tokens, "old messages collapsed"));
        }
    }
    let by = by_message(calls);
    for &i in &order {
        if pin(&entries[i]) {
            continue;
        }
        let Some(own) = by.get(&entries[i].i) else {
            continue;
        };
        entries[i].tool_calls = Some(HistoryCalls::Compact(
            own.iter()
                .map(|call| compact_call(call))
                .collect::<Result<Vec<_>, _>>()?,
        ));
        update(&entries, &mut per, &mut tokens, i)?;
        if tokens as f64 <= options.state_tokens {
            return Ok(fitted(entries, &goal, tokens, "old calls compacted"));
        }
    }
    let mut removed = vec![false; entries.len()];
    for &i in &order {
        if pin(&entries[i]) || entries[i].tool_calls.is_some() {
            continue;
        }
        removed[i] = true;
        tokens -= per[i];
        if tokens as f64 <= options.state_tokens {
            return Ok(fitted(
                entries
                    .into_iter()
                    .enumerate()
                    .filter_map(|(i, e)| (!removed[i]).then_some(e))
                    .collect(),
                &goal,
                tokens,
                "old messages left out",
            ));
        }
    }
    let mut merged: Vec<HistoryEntry> = Vec::new();
    for entry in entries
        .into_iter()
        .enumerate()
        .filter_map(|(i, e)| (!removed[i]).then_some(e))
    {
        let fold = |e: &HistoryEntry| {
            !pin(e)
                && e.text.is_empty()
                && matches!(&e.tool_calls,Some(HistoryCalls::Compact(v))if!v.is_empty())
        };
        if merged
            .last()
            .is_some_and(|prev| fold(prev) && fold(&entry) && prev.role == entry.role)
        {
            if let (Some(HistoryCalls::Compact(prior)), Some(HistoryCalls::Compact(next))) = (
                &mut merged.last_mut().expect("checked prior").tool_calls,
                entry.tool_calls,
            ) {
                prior.extend(next);
            }
        } else {
            merged.push(entry);
        }
    }
    entries = merged;
    (per, tokens) = recount(&entries, base)?;
    if tokens as f64 <= options.state_tokens {
        return Ok(fitted(entries, &goal, tokens, "old calls merged"));
    }
    let mut i = 0;
    while i < entries.len() {
        if pin(&entries[i]) {
            i += 1;
            continue;
        }
        tokens -= per.remove(i);
        entries.remove(i);
        if tokens as f64 <= options.state_tokens {
            return Ok(fitted(entries, &goal, tokens, "old call runs left out"));
        }
    }
    Err(CompactionFailure::new(
        FailureKind::JevFailed,
        "state-too-large",
    ))
}
