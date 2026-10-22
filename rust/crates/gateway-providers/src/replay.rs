//! Process/isolate-local authenticated native replay receipts. No signatures enter public wire/disk.
use crate::{source as s, types::PrepareOptions};
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use std::collections::{BTreeSet, VecDeque};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayContext {
    pub scope: String,
    pub provider: String,
    pub model: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayTransport {
    Messages,
    Chat,
}
#[derive(Clone, PartialEq)]
pub enum ReplayEntry {
    Original(SourceJson),
    NativeAssistant {
        transport: ReplayTransport,
        payload: SourceJson,
    },
}
#[derive(Clone)]
struct Receipt {
    context: ReplayContext,
    ids: Vec<String>,
    fingerprints: Vec<SourceJson>,
    native: SourceJson,
    transport: ReplayTransport,
    expires: i64,
    bytes: usize,
}
#[derive(Clone)]
pub struct ReplayStore {
    rows: VecDeque<Receipt>,
    pub ttl_ms: i64,
    pub max_entries: usize,
    pub max_bytes: usize,
    pub max_entry_bytes: usize,
}
impl Default for ReplayStore {
    fn default() -> Self {
        Self {
            rows: VecDeque::new(),
            ttl_ms: 1_800_000,
            max_entries: 64,
            max_bytes: 8 * 1024 * 1024,
            max_entry_bytes: 1024 * 1024,
        }
    }
}
fn context_valid(c: &ReplayContext) -> bool {
    !c.scope.is_empty()
        && c.scope.len() <= 512
        && !c.provider.is_empty()
        && c.provider.len() <= 64
        && !c.model.is_empty()
        && c.model.len() <= 256
}
fn fingerprint(item: &SourceJson) -> Option<SourceJson> {
    let id = s::control(&s::get(item, "id"))?;
    let (prefix, tail) = id.split_once('_')?;
    if !["rs", "msg", "fc", "ctc"].contains(&prefix)
        || tail.is_empty()
        || tail.len() > 240
        || !tail
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    match s::control(&s::get(item, "type"))?.as_str() {
        "reasoning" => {
            if s::present(item, "encrypted_content").is_some_and(|v| !s::is_null(&v))
                || s::present(item, "content").is_some_and(|v| {
                    !s::is_null(&v) && !source::array(&v).is_some_and(|values| values.is_empty())
                })
            {
                return None;
            }
            let mut summary = vec![];
            for part in source::array(&s::get(item, "summary"))? {
                if !s::is(&s::get(&part, "type"), "summary_text") {
                    return None;
                }
                summary.push(s::object(vec![
                    ("type", s::text("summary_text")),
                    ("text", s::quoted(&s::string(&s::get(&part, "text"))?)),
                ]));
            }
            Some(s::object(vec![
                ("id", s::text(&id)),
                ("type", s::text("reasoning")),
                ("summary", s::array(&summary)),
            ]))
        }
        "message" => {
            if !s::is(&s::get(item, "role"), "assistant") {
                return None;
            }
            let mut parts = vec![];
            for part in source::array(&s::get(item, "content"))? {
                parts.push(match s::control(&s::get(&part, "type"))?.as_str() {
                    "output_text" => s::object(vec![
                        ("type", s::text("output_text")),
                        ("text", s::quoted(&s::string(&s::get(&part, "text"))?)),
                    ]),
                    "refusal" => s::object(vec![
                        ("type", s::text("refusal")),
                        ("refusal", s::quoted(&s::string(&s::get(&part, "refusal"))?)),
                    ]),
                    _ => return None,
                });
            }
            Some(s::object(vec![
                ("id", s::text(&id)),
                ("type", s::text("message")),
                ("role", s::text("assistant")),
                ("content", s::array(&parts)),
            ]))
        }
        "function_call" | "custom_tool_call" => {
            let kind = s::control(&s::get(item, "type"))?;
            let call = s::string(&s::get(item, "call_id")).filter(|s| !s.as_units().is_empty())?;
            let name = s::string(&s::get(item, "name")).filter(|s| !s.as_units().is_empty())?;
            if s::present(item, "encrypted_function_args").is_some_and(|v| !s::is_null(&v))
                || s::present(item, "namespace")
                    .is_some_and(|v| !s::is_null(&v) && s::string(&v).is_none())
            {
                return None;
            }
            let mut result = s::object(vec![
                ("id", s::text(&id)),
                ("type", s::text(&kind)),
                ("call_id", s::quoted(&call)),
                ("name", s::quoted(&name)),
                (
                    "namespace",
                    s::present(item, "namespace").unwrap_or_else(s::null),
                ),
            ]);
            if kind == "custom_tool_call" {
                s::set(
                    &mut result,
                    "input",
                    s::quoted(&s::string(&s::get(item, "input"))?),
                );
            } else {
                let arguments = s::string(&s::get(item, "arguments"))?;
                let arguments = SourceJson::parse(&arguments.try_utf8().ok()?).ok()?;
                source::entries(&arguments)?;
                s::set(&mut result, "arguments", arguments);
            }
            Some(result)
        }
        _ => None,
    }
}
fn native_valid(native: &SourceJson, transport: ReplayTransport) -> bool {
    match transport {
        ReplayTransport::Messages => source::array(native).is_some_and(|blocks| {
            !blocks.is_empty()
                && blocks.len() <= 256
                && blocks
                    .iter()
                    .all(|b| match s::control(&s::get(b, "type")).as_deref() {
                        Some("text") => s::string(&s::get(b, "text")).is_some(),
                        Some("thinking") => {
                            s::string(&s::get(b, "thinking")).is_some()
                                && s::string(&s::get(b, "signature"))
                                    .is_some_and(|s| !s.as_units().is_empty())
                        }
                        Some("redacted_thinking") => {
                            s::string(&s::get(b, "data")).is_some_and(|s| !s.as_units().is_empty())
                        }
                        Some("tool_use") => {
                            s::string(&s::get(b, "id")).is_some_and(|s| !s.as_units().is_empty())
                                && s::string(&s::get(b, "name"))
                                    .is_some_and(|s| !s.as_units().is_empty())
                                && source::entries(&s::get(b, "input")).is_some()
                        }
                        _ => false,
                    })
        }),
        ReplayTransport::Chat => {
            s::is(&s::get(native, "role"), "assistant")
                && source::entries(native).is_some()
                && ["content", "refusal", "reasoning_content", "reasoning"]
                    .iter()
                    .all(|key| {
                        s::present(native, key).is_none_or(|value| s::string(&value).is_some())
                    })
                && s::present(native, "tool_calls").is_none_or(|value| {
                    source::array(&value).is_some_and(|calls| calls.len() <= 256)
                })
                && chat_readable_reasoning(native).is_some()
        }
    }
}
fn chat_readable_reasoning(native: &SourceJson) -> Option<JsString16> {
    let detail_text = chat_detail_text(native)?;
    for key in ["reasoning_content", "reasoning"] {
        let Some(value) = s::present(native, key) else {
            continue;
        };
        let value = s::string(&value)?;
        if !value.as_units().is_empty() {
            return Some(value);
        }
    }
    Some(detail_text)
}
fn chat_detail_text(native: &SourceJson) -> Option<JsString16> {
    let Some(details) = s::present(native, "reasoning_details") else {
        return Some(JsString16::from_units(vec![]));
    };
    let details = source::array(&details)?;
    if details.len() > 256 {
        return None;
    }
    let mut text = JsString16::from_units(vec![]);
    for detail in details {
        if !s::is(&s::get(&detail, "type"), "reasoning.text")
            || s::string(&s::get(&detail, "signature"))
                .is_none_or(|signature| signature.as_units().is_empty())
            || s::present(&detail, "index")
                .is_some_and(|index| !s::is_null(&index) && !safe_index(&index))
        {
            return None;
        }
        text = s::concat(&[&text, &s::string(&s::get(&detail, "text"))?]);
    }
    Some(text)
}
fn safe_index(value: &SourceJson) -> bool {
    source::number(value).is_some_and(|value| {
        value.is_finite()
            && value >= 0.0
            && value.fract() == 0.0
            && value <= 9_007_199_254_740_991.0
    })
}
fn empty_string() -> JsString16 {
    JsString16::from_units(vec![])
}
fn native_matches(
    native: &SourceJson,
    output: &[SourceJson],
    transport: ReplayTransport,
    names: &crate::types::ToolMap,
) -> bool {
    if transport == ReplayTransport::Messages {
        let Some(blocks) = source::array(native) else {
            return false;
        };
        let mut position = 0;
        for block in blocks {
            match s::control(&s::get(&block, "type")).as_deref().unwrap_or("") {
                "redacted_thinking" => (),
                "thinking" => {
                    if output
                        .get(position)
                        .is_some_and(|item| s::is(&s::get(item, "type"), "reasoning"))
                    {
                        let expected = s::object(vec![
                            ("type", s::text("summary_text")),
                            ("text", s::get(&block, "thinking")),
                        ]);
                        if source::array(&s::get(&output[position], "summary"))
                            .is_none_or(|summary| summary != [expected])
                        {
                            return false;
                        }
                        position += 1;
                    }
                }
                "text" => {
                    let Some(item) = output.get(position) else {
                        return false;
                    };
                    let Some(content) = source::array(&s::get(item, "content")) else {
                        return false;
                    };
                    if !s::is(&s::get(item, "type"), "message")
                        || content.len() != 1
                        || !s::is(&s::get(&content[0], "type"), "output_text")
                        || s::string(&s::get(&content[0], "text"))
                            != s::string(&s::get(&block, "text"))
                    {
                        return false;
                    }
                    position += 1;
                }
                "tool_use" => {
                    let Some(item) = output.get(position) else {
                        return false;
                    };
                    let Some(arguments) = s::string(&s::get(item, "arguments")) else {
                        return false;
                    };
                    let Ok(arguments) =
                        SourceJson::parse(&arguments.try_utf8().unwrap_or_default())
                    else {
                        return false;
                    };
                    if !s::is(&s::get(item, "type"), "function_call")
                        || s::string(&s::get(item, "call_id")) != s::string(&s::get(&block, "id"))
                        || s::string(&s::get(item, "name")) != s::string(&s::get(&block, "name"))
                        || arguments != s::get(&block, "input")
                    {
                        return false;
                    }
                    position += 1;
                }
                _ => return false,
            }
        }
        return position == output.len();
    }
    let text = s::string(&s::get(native, "content")).unwrap_or_else(empty_string);
    let mut tools = vec![];
    let Some(reasoning) = chat_readable_reasoning(native) else {
        return false;
    };
    let thinking = reasoning;
    for call in source::array(&s::get(native, "tool_calls"))
        .into_iter()
        .flatten()
    {
        let function = s::get(&call, "function");
        let Some(wire) = s::string(&s::get(&function, "name")) else {
            return false;
        };
        let Some(wire) = wire.try_utf8().ok() else {
            return false;
        };
        let identity = crate::tools::original(&wire, names);
        let Some(arguments) = s::string(&s::get(&function, "arguments")) else {
            return false;
        };
        let Ok(arguments) = SourceJson::parse(&arguments.try_utf8().unwrap_or_default()) else {
            return false;
        };
        let Some(id) = s::string(&s::get(&call, "id")) else {
            return false;
        };
        tools.push((id, identity.name, arguments));
    }
    let mut actual_text = JsString16::from_units(vec![]);
    let mut actual_thinking = JsString16::from_units(vec![]);
    let mut actual_tools = vec![];
    for item in output {
        match s::control(&s::get(item, "type")).as_deref().unwrap_or("") {
            "message" => {
                for part in source::array(&s::get(item, "content"))
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = s::string(&s::get(&part, "text")) {
                        actual_text = s::concat(&[&actual_text, &text]);
                    }
                    if let Some(refusal) = s::string(&s::get(&part, "refusal")) {
                        actual_text = s::concat(&[&actual_text, &refusal]);
                    }
                }
            }
            "reasoning" => {
                for part in source::array(&s::get(item, "summary"))
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = s::string(&s::get(&part, "text")) {
                        actual_thinking = s::concat(&[&actual_thinking, &text]);
                    }
                }
            }
            "function_call" => {
                let Some(id) = s::string(&s::get(item, "call_id")) else {
                    return false;
                };
                let Some(name) = s::string(&s::get(item, "name")) else {
                    return false;
                };
                let Some(arguments) = s::string(&s::get(item, "arguments")) else {
                    return false;
                };
                let Ok(arguments) = SourceJson::parse(&arguments.try_utf8().unwrap_or_default())
                else {
                    return false;
                };
                actual_tools.push((id, name, arguments));
            }
            "custom_tool_call" => {
                let Some(id) = s::string(&s::get(item, "call_id")) else {
                    return false;
                };
                let Some(name) = s::string(&s::get(item, "name")) else {
                    return false;
                };
                let Some(input) = s::string(&s::get(item, "input")) else {
                    return false;
                };
                actual_tools.push((id, name, s::object(vec![("input", s::quoted(&input))])));
            }
            _ => return false,
        }
    }
    text == actual_text
        && (actual_thinking.as_units().is_empty() || thinking == actual_thinking)
        && tools == actual_tools
}
impl ReplayStore {
    fn prune(&mut self, now: i64) {
        self.rows.retain(|row| row.expires > now);
    }
    pub fn remember(
        &mut self,
        context: ReplayContext,
        output: &[SourceJson],
        native: SourceJson,
        transport: ReplayTransport,
        now_ms: i64,
    ) -> bool {
        self.remember_with_tools(
            context,
            output,
            native,
            transport,
            &crate::types::ToolMap::new(),
            now_ms,
        )
    }
    pub fn remember_with_tools(
        &mut self,
        context: ReplayContext,
        output: &[SourceJson],
        native: SourceJson,
        transport: ReplayTransport,
        names: &crate::types::ToolMap,
        now_ms: i64,
    ) -> bool {
        if !context_valid(&context)
            || output.is_empty()
            || output.len() > 256
            || !native_valid(&native, transport)
            || !native_matches(&native, output, transport, names)
        {
            return false;
        }
        let ids = output
            .iter()
            .map(|v| {
                s::string(&s::get(v, "id"))
                    .filter(|s| !s.as_units().is_empty())
                    .and_then(|s| s.try_utf8().ok())
            })
            .collect::<Option<Vec<_>>>();
        let Some(ids) = ids else { return false };
        if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
            return false;
        }
        let Some(fingerprints) = output.iter().map(fingerprint).collect::<Option<Vec<_>>>() else {
            return false;
        };
        self.prune(now_ms);
        if self
            .rows
            .iter()
            .any(|r| r.context == context && r.ids.iter().any(|id| ids.contains(id)))
        {
            return false;
        }
        let bytes =
            native.as_str().len() + fingerprints.iter().map(|v| v.as_str().len()).sum::<usize>();
        if bytes > self.max_entry_bytes.min(1024 * 1024)
            || bytes > self.max_bytes.min(8 * 1024 * 1024)
        {
            return false;
        }
        let limit = self.max_entries.min(64);
        if limit == 0 {
            return false;
        }
        while self.rows.len() >= limit
            || self.rows.iter().map(|r| r.bytes).sum::<usize>() + bytes
                > self.max_bytes.min(8 * 1024 * 1024)
        {
            if self.rows.pop_front().is_none() {
                return false;
            }
        }
        self.rows.push_back(Receipt {
            context,
            ids,
            fingerprints,
            native,
            transport,
            expires: now_ms.saturating_add(self.ttl_ms.clamp(1, 1_800_000)),
            bytes,
        });
        true
    }
    pub fn restore(
        &mut self,
        context: &ReplayContext,
        input: &[SourceJson],
        transport: ReplayTransport,
        now_ms: i64,
    ) -> Option<Vec<ReplayEntry>> {
        if !context_valid(context) {
            return None;
        }
        self.prune(now_ms);
        let mut result = vec![];
        let mut used = BTreeSet::new();
        let mut i = 0;
        while i < input.len() {
            let item = &input[i];
            source::entries(item)?;
            let id = s::control(&s::get(item, "id")).unwrap_or_default();
            let found = self
                .rows
                .iter()
                .enumerate()
                .find(|(_, r)| r.context == *context && r.ids.iter().any(|s| s == &id));
            if let Some((index, row)) = found {
                if row.transport != transport
                    || row.ids.first().map(String::as_str) != Some(&id)
                    || !used.insert(index)
                    || i + row.ids.len() > input.len()
                {
                    return None;
                }
                for (offset, expected) in row.fingerprints.iter().enumerate() {
                    if s::control(&s::get(&input[i + offset], "id")).as_deref()
                        != Some(&row.ids[offset])
                        || fingerprint(&input[i + offset]).as_ref() != Some(expected)
                    {
                        return None;
                    }
                }
                result.push(ReplayEntry::NativeAssistant {
                    transport,
                    payload: row.native.clone(),
                });
                i += row.ids.len();
            } else {
                if s::is(&s::get(item, "type"), "reasoning")
                    || id.starts_with("msg_resp_")
                    || id.starts_with("rs_resp_")
                    || id.starts_with("fc_resp_")
                    || id.starts_with("ctc_resp_")
                {
                    return None;
                }
                result.push(ReplayEntry::Original(item.clone()));
                i += 1;
            }
        }
        Some(result)
    }
    /// Retains the assistant envelope emitted by `DecodedResponse::native_replay`.
    pub fn remember_decoded_native(
        &mut self,
        context: ReplayContext,
        output: &[SourceJson],
        native: SourceJson,
        transport: ReplayTransport,
        names: &crate::types::ToolMap,
        now_ms: i64,
    ) -> bool {
        let payload = match transport {
            ReplayTransport::Messages => {
                if !s::is(&s::get(&native, "role"), "assistant") {
                    return false;
                }
                s::get(&native, "content")
            }
            ReplayTransport::Chat => native,
        };
        self.remember_with_tools(context, output, payload, transport, names, now_ms)
    }
    /// Restores a complete provider history into the existing PrepareOptions seam.
    ///
    /// The helper never mutates the raw request or its decode echo. It fails
    /// closed when an input item cannot be represented by the selected transport.
    pub fn restore_prepare_options(
        &mut self,
        context: &ReplayContext,
        raw: &SourceJson,
        options: &mut PrepareOptions,
        transport: ReplayTransport,
        now_ms: i64,
    ) -> bool {
        let Some(input) = source::array(&s::get(raw, "input")) else {
            return false;
        };
        let Some(entries) = self.restore(context, &input, transport, now_ms) else {
            return false;
        };
        let Some(messages) = crate::source_anthropic::replay_messages(raw, transport, &entries)
        else {
            return false;
        };
        options.restored_native_messages = Some(messages);
        true
    }
}

impl std::fmt::Debug for ReplayStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplayStore")
            .field("receipt_count", &self.rows.len())
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for ReplayEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Original(_) => f.write_str("Original([private conversation item])"),
            Self::NativeAssistant { transport, .. } => f
                .debug_struct("NativeAssistant")
                .field("transport", transport)
                .field("payload", &"[private signed blocks]")
                .finish(),
        }
    }
}
