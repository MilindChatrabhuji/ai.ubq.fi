//! Process/isolate-local authenticated native replay receipts. No signatures enter public wire/disk.
use serde_json::{Value, json};
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
    Original(Value),
    NativeAssistant {
        transport: ReplayTransport,
        payload: Value,
    },
}
#[derive(Clone)]
struct Receipt {
    context: ReplayContext,
    ids: Vec<String>,
    fingerprints: Vec<Value>,
    native: Value,
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
fn fingerprint(item: &Value) -> Option<Value> {
    let id = item["id"].as_str()?;
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
    match item["type"].as_str()? {
        "reasoning" => {
            if item.get("encrypted_content").is_some_and(|v| !v.is_null())
                || item
                    .get("content")
                    .is_some_and(|v| !v.is_null() && !v.as_array().is_some_and(Vec::is_empty))
            {
                return None;
            }
            let mut summary = vec![];
            for part in item["summary"].as_array()? {
                if part["type"] != "summary_text" {
                    return None;
                }
                summary.push(json!({"type":"summary_text","text":part["text"].as_str()?}));
            }
            Some(json!({"id":id,"type":"reasoning","summary":summary}))
        }
        "message" => {
            if item["role"] != "assistant" {
                return None;
            }
            let mut parts = vec![];
            for part in item["content"].as_array()? {
                parts.push(match part["type"].as_str()? {
                    "output_text" => json!({"type":"output_text","text":part["text"].as_str()?}),
                    "refusal" => json!({"type":"refusal","refusal":part["refusal"].as_str()?}),
                    _ => return None,
                });
            }
            Some(json!({"id":id,"type":"message","role":"assistant","content":parts}))
        }
        "function_call" | "custom_tool_call" => {
            let kind = item["type"].as_str()?;
            let call = item["call_id"].as_str().filter(|s| !s.is_empty())?;
            let name = item["name"].as_str().filter(|s| !s.is_empty())?;
            if item
                .get("encrypted_function_args")
                .is_some_and(|v| !v.is_null())
                || item
                    .get("namespace")
                    .is_some_and(|v| !v.is_null() && !v.is_string())
            {
                return None;
            }
            let mut result = json!({"id":id,"type":kind,"call_id":call,"name":name,"namespace":item.get("namespace").cloned().unwrap_or(Value::Null)});
            if kind == "custom_tool_call" {
                result["input"] = json!(item["input"].as_str()?);
            } else {
                let arguments: Value = serde_json::from_str(item["arguments"].as_str()?).ok()?;
                if !arguments.is_object() {
                    return None;
                }
                result["arguments"] = arguments;
            }
            Some(result)
        }
        _ => None,
    }
}
fn native_valid(native: &Value, transport: ReplayTransport) -> bool {
    match transport {
        ReplayTransport::Messages => native.as_array().is_some_and(|blocks| {
            !blocks.is_empty()
                && blocks.len() <= 256
                && blocks.iter().all(|b| match b["type"].as_str() {
                    Some("text") => b["text"].is_string(),
                    Some("thinking") => {
                        b["thinking"].is_string()
                            && b["signature"].as_str().is_some_and(|s| !s.is_empty())
                    }
                    Some("redacted_thinking") => b["data"].as_str().is_some_and(|s| !s.is_empty()),
                    Some("tool_use") => {
                        b["id"].as_str().is_some_and(|s| !s.is_empty())
                            && b["name"].as_str().is_some_and(|s| !s.is_empty())
                            && b["input"].is_object()
                    }
                    _ => false,
                })
        }),
        ReplayTransport::Chat => {
            native["role"] == "assistant"
                && native.is_object()
                && native.get("reasoning_details").is_none_or(|v| {
                    v.as_array().is_some_and(|a| {
                        a.iter().all(|d| {
                            d["type"] == "reasoning.text"
                                && d["text"].is_string()
                                && d["signature"].as_str().is_some_and(|s| !s.is_empty())
                        })
                    })
                })
        }
    }
}
fn native_matches(
    native: &Value,
    output: &[Value],
    transport: ReplayTransport,
    names: &crate::types::ToolMap,
) -> bool {
    if transport == ReplayTransport::Messages {
        let mut position = 0;
        for block in native.as_array().into_iter().flatten() {
            match block["type"].as_str().unwrap_or("") {
                "redacted_thinking" => (),
                "thinking" => {
                    if output
                        .get(position)
                        .is_some_and(|i| i["type"] == "reasoning")
                    {
                        if output[position]["summary"]
                            != json!([{"type":"summary_text","text":block["thinking"]}])
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
                    if item["type"] != "message"
                        || item["content"].as_array().is_none_or(|a| a.len() != 1)
                        || item["content"][0]["type"] != "output_text"
                        || item["content"][0]["text"] != block["text"]
                    {
                        return false;
                    }
                    position += 1;
                }
                "tool_use" => {
                    let Some(item) = output.get(position) else {
                        return false;
                    };
                    if item["type"] != "function_call"
                        || item["call_id"] != block["id"]
                        || item["name"] != block["name"]
                        || item["arguments"]
                            .as_str()
                            .and_then(|s| serde_json::from_str::<Value>(s).ok())
                            .as_ref()
                            != Some(&block["input"])
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
    let mut text = String::new();
    let mut thinking = String::new();
    let mut tools = vec![];
    match transport {
        ReplayTransport::Messages => {
            for block in native.as_array().into_iter().flatten() {
                match block["type"].as_str().unwrap_or("") {
                    "text" => text.push_str(block["text"].as_str().unwrap_or("")),
                    "thinking" => thinking.push_str(block["thinking"].as_str().unwrap_or("")),
                    "tool_use" => tools.push((
                        block["id"].clone(),
                        block["name"].clone(),
                        block["input"].to_string(),
                    )),
                    _ => (),
                }
            }
        }
        ReplayTransport::Chat => {
            if let Some(s) = native["content"].as_str() {
                text.push_str(s)
            }
            if let Some(s) = native["reasoning_content"]
                .as_str()
                .or_else(|| native["reasoning"].as_str())
            {
                thinking.push_str(s)
            }
            for call in native["tool_calls"].as_array().into_iter().flatten() {
                let wire = call["function"]["name"].as_str().unwrap_or("");
                let identity = crate::tools::original(wire, names);
                tools.push((
                    call["id"].clone(),
                    json!(identity.name),
                    call["function"]["arguments"].as_str().unwrap_or("").into(),
                ));
            }
        }
    }
    let mut actual_text = String::new();
    let mut actual_thinking = String::new();
    let mut actual_tools = vec![];
    for item in output {
        match item["type"].as_str().unwrap_or("") {
            "message" => {
                for part in item["content"].as_array().into_iter().flatten() {
                    if let Some(s) = part["text"].as_str() {
                        actual_text.push_str(s)
                    }
                    if let Some(s) = part["refusal"].as_str() {
                        actual_text.push_str(s)
                    }
                }
            }
            "reasoning" => {
                for part in item["summary"].as_array().into_iter().flatten() {
                    if let Some(s) = part["text"].as_str() {
                        actual_thinking.push_str(s)
                    }
                }
            }
            "function_call" => actual_tools.push((
                item["call_id"].clone(),
                item["name"].clone(),
                item["arguments"].as_str().unwrap_or("").into(),
            )),
            "custom_tool_call" => actual_tools.push((
                item["call_id"].clone(),
                item["name"].clone(),
                json!({"input":item["input"]}).to_string(),
            )),
            _ => return false,
        }
    }
    text == actual_text
        && (actual_thinking.is_empty() || thinking == actual_thinking)
        && tools == actual_tools
}
impl ReplayStore {
    fn prune(&mut self, now: i64) {
        self.rows.retain(|row| row.expires > now);
    }
    pub fn remember(
        &mut self,
        context: ReplayContext,
        output: &[Value],
        native: Value,
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
        output: &[Value],
        native: Value,
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
                v["id"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
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
        let bytes = native.to_string().len()
            + fingerprints
                .iter()
                .map(|v| v.to_string().len())
                .sum::<usize>();
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
        input: &[Value],
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
            if !item.is_object() {
                return None;
            }
            let id = item["id"].as_str().unwrap_or("");
            let found = self
                .rows
                .iter()
                .enumerate()
                .find(|(_, r)| r.context == *context && r.ids.iter().any(|s| s == id));
            if let Some((index, row)) = found {
                if row.transport != transport
                    || row.ids.first().map(String::as_str) != Some(id)
                    || !used.insert(index)
                    || i + row.ids.len() > input.len()
                {
                    return None;
                }
                for (offset, expected) in row.fingerprints.iter().enumerate() {
                    if input[i + offset]["id"].as_str() != Some(&row.ids[offset])
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
                if item["type"] == "reasoning"
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
