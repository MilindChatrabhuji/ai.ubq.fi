//! Bounded incremental SSE parsing. Reader EOF never substitutes for a Responses terminal.
use crate::{types::*, writer::ResponseWriter};
use gateway_core::GatewayError;
use gateway_core::provider::UpstreamProvider;
use serde_json::{Value, json};
use std::collections::BTreeMap;
pub const MAX_RESPONSES_EVENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CHAT_EVENT_BYTES: usize = 4 * 1024 * 1024;
pub const KEEPALIVE_INTERVAL_MS: u64 = 15_000;
/// The source contract that must be translated into an in-band stream terminal.
pub fn is_lithos_stream_refusal(plan: &DecodePlan, status: u16) -> bool {
    plan.provider == UpstreamProvider::Lithos && plan.stream && status == 429
}
#[derive(Clone, Debug)]
pub struct SseFrame {
    pub event: Option<String>,
    pub data: String,
}
#[derive(Clone, Debug)]
pub struct SseParser {
    pending: Vec<u8>,
    limit: usize,
}
impl SseParser {
    pub fn new(limit: usize) -> Self {
        Self {
            pending: vec![],
            limit,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseFrame>, GatewayError> {
        self.pending.extend_from_slice(bytes);
        let mut frames = vec![];
        while let Some((end, width)) = boundary(&self.pending) {
            if end > self.limit {
                return Err(malformed("Upstream SSE frame exceeded its bound."));
            }
            let raw = self.pending.drain(..end + width).collect::<Vec<_>>();
            let text = std::str::from_utf8(&raw[..end])
                .map_err(|_| malformed("Upstream SSE contains invalid UTF-8."))?;
            if let Some(frame) = parse_frame(text) {
                frames.push(frame);
            }
        }
        if self.pending.len() > self.limit {
            return Err(malformed("Upstream SSE frame exceeded its bound."));
        }
        Ok(frames)
    }
    pub fn finish(&mut self) -> Result<Vec<SseFrame>, GatewayError> {
        if self.pending.is_empty() {
            return Ok(vec![]);
        }
        let bytes = std::mem::take(&mut self.pending);
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| malformed("Upstream SSE contains invalid UTF-8."))?;
        Ok(parse_frame(text).into_iter().collect())
    }
}
fn boundary(bytes: &[u8]) -> Option<(usize, usize)> {
    for i in 0..bytes.len() {
        let Some(first) = line_ending(bytes, i) else {
            continue;
        };
        if let Some(second) = line_ending(bytes, i + first) {
            return Some((i, first + second));
        }
    }
    None
}
fn line_ending(bytes: &[u8], index: usize) -> Option<usize> {
    match bytes.get(index) {
        Some(b'\r') if bytes.get(index + 1) == Some(&b'\n') => Some(2),
        Some(b'\r' | b'\n') => Some(1),
        _ => None,
    }
}
fn parse_frame(text: &str) -> Option<SseFrame> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut event = None;
    let mut data = vec![];
    for line in normalized.lines() {
        if line.starts_with(':') {
            continue;
        }
        let (key, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match key {
            "data" => data.push(value),
            "event" => event = Some(value.to_owned()),
            _ => (),
        }
    }
    (!data.is_empty()).then(|| SseFrame {
        event,
        data: data.join("\n"),
    })
}
#[derive(Clone, Debug, Default)]
struct NativeBlock {
    kind: String,
    text: String,
    args: String,
    native: Value,
    id: String,
    name: String,
    closed: bool,
}
#[derive(Clone)]
pub struct StreamDecoder {
    plan: DecodePlan,
    parser: SseParser,
    writer: ResponseWriter,
    terminal: bool,
    done: bool,
    native: BTreeMap<usize, NativeBlock>,
    native_usage: Value,
    chat: ChatCollector,
    native_replay: Option<Value>,
    claude_chat: crate::claude_chat_stream::ClaudeChatState,
    sequence: u64,
    semantic: bool,
    precommit_events: usize,
    precommit_chars: usize,
    native_started: bool,
}
impl StreamDecoder {
    pub fn new(plan: DecodePlan) -> Self {
        let chat = ChatCollector::new(plan.clone());
        let limit = if matches!(
            plan.decode,
            ResponseDecode::Chat
                | ResponseDecode::ChatToResponses(_)
                | ResponseDecode::AnthropicChatToResponses
        ) {
            MAX_CHAT_EVENT_BYTES
        } else {
            MAX_RESPONSES_EVENT_BYTES
        };
        Self {
            writer: ResponseWriter::new(plan.clone()),
            plan,
            parser: SseParser::new(limit),
            terminal: false,
            done: false,
            native: BTreeMap::new(),
            native_usage: json!({}),
            chat,
            native_replay: None,
            claude_chat: Default::default(),
            sequence: 0,
            semantic: false,
            precommit_events: 0,
            precommit_chars: 0,
            native_started: false,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<ProviderEvent>, GatewayError> {
        let frames = self.parser.push(bytes)?;
        self.frames(frames)
    }
    pub fn finish(&mut self) -> Result<Vec<ProviderEvent>, GatewayError> {
        let frames = self.parser.finish()?;
        let result = self.frames(frames)?;
        if !self.terminal {
            return Err(malformed("Upstream stream ended before a terminal event."));
        }
        Ok(result)
    }
    pub fn terminal_observed(&self) -> bool {
        self.terminal
    }
    pub fn observed_usage(&self) -> Option<&Value> {
        self.chat.usage.as_ref().or(self.writer.usage.as_ref())
    }
    pub fn semantic_committed(&self) -> bool {
        self.semantic
    }
    pub fn native_replay(&self) -> Option<&Value> {
        self.native_replay.as_ref()
    }
    fn frames(&mut self, frames: Vec<SseFrame>) -> Result<Vec<ProviderEvent>, GatewayError> {
        let mut events = vec![];
        for frame in frames {
            if self.terminal {
                break;
            }
            if frame.data.trim() == "[DONE]" {
                self.done = true;
                match self.plan.decode {
                    ResponseDecode::ChatToResponses(_)
                    | ResponseDecode::AnthropicChatToResponses => {
                        if self.plan.decode == ResponseDecode::AnthropicChatToResponses {
                            let message = self.claude_chat.finish_message();
                            let finish = self.claude_chat.finish.as_deref().ok_or_else(|| {
                                malformed("Claude Chat ended without a finish reason.")
                            })?;
                            self.writer.finish_reason = Some(finish.into());
                            for (index, call) in message["tool_calls"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .enumerate()
                            {
                                let translated = self.writer.tool_delta(
                                    index,
                                    call["id"].as_str(),
                                    call["function"]["name"].as_str(),
                                    call["function"]["arguments"].as_str().unwrap_or(""),
                                );
                                events.extend(self.deliver(translated)?);
                            }
                            if self.claude_chat.replayable
                                && self
                                    .writer
                                    .finish_reason
                                    .as_deref()
                                    .is_some_and(|r| matches!(r, "stop" | "tool_calls"))
                            {
                                self.native_replay = Some(message);
                            }
                        }
                        let translated = self.writer.finish();
                        self.terminal = true;
                        events.extend(self.deliver(translated)?);
                    }
                    ResponseDecode::Chat => {
                        self.terminal = true;
                        events.push(ProviderEvent::chat(json!("[DONE]")));
                    }
                    _ => {
                        return Err(malformed(
                            "Responses sentinel arrived without a semantic terminal.",
                        ));
                    }
                }
                continue;
            }
            let mut value: Value = serde_json::from_str(&frame.data)
                .map_err(|_| malformed("Upstream SSE data is not valid JSON."))?;
            if !value.is_object() {
                return Err(malformed("Upstream SSE event must be an object."));
            }
            if value.get("type").is_none()
                && let Some(kind) = frame.event
            {
                value["type"] = json!(kind);
            }
            match self.plan.decode {
                ResponseDecode::Responses | ResponseDecode::ResponsesToChat => {
                    let kind = value["type"]
                        .as_str()
                        .ok_or_else(|| malformed("Upstream Responses event has no type."))?;
                    if [
                        "response.completed",
                        "response.failed",
                        "response.incomplete",
                    ]
                    .contains(&kind)
                    {
                        if !value["response"].is_object() {
                            return Err(malformed(
                                "Upstream terminal has invalid response payload.",
                            ));
                        }
                        if kind == "response.completed"
                            && !crate::policy::response_has_answer(&value["response"])
                        {
                            return Err(GatewayError::new(
                                502,
                                "Upstream response completed with no translated semantic output.",
                                Some("empty_upstream_completion"),
                            )
                            .with_type("server_error"));
                        }
                        self.terminal = true;
                    } else if kind == "error" {
                        if !value["error"].is_object()
                            && !(value["message"].is_string() && value["type"].is_string())
                        {
                            return Err(malformed("Upstream error terminal has invalid payload."));
                        }
                        self.terminal = true;
                    }
                    events.extend(self.deliver(vec![ProviderEvent::responses(value)])?);
                }
                ResponseDecode::ChatToResponses(profile) => {
                    validate_chat_chunk(&value)?;
                    let translated = self.writer.chat_chunk(&value, profile);
                    events.extend(self.deliver(translated)?);
                }
                ResponseDecode::AnthropicChatToResponses => {
                    validate_chat_chunk(&value)?;
                    let projected = self.claude_chat.push(&value)?;
                    let translated = self.writer.chat_chunk(&projected, ChatProfile::Claude);
                    events.extend(self.deliver(translated)?);
                }
                ResponseDecode::Chat => {
                    validate_chat_chunk(&value)?;
                    let mut body = crate::source::generated(&value);
                    crate::source::set(
                        &mut body,
                        "model",
                        crate::source::quoted(self.plan.model.as_js_string()),
                    );
                    events.push(ProviderEvent::chat_source(body));
                }
                ResponseDecode::AnthropicToResponses => {
                    let translated = self.native_event(&value)?;
                    events.extend(self.deliver(translated)?);
                }
                _ => return Err(malformed("This provider uses a buffered response.")),
            }
        }
        Ok(events)
    }
    fn deliver(
        &mut self,
        mut events: Vec<ProviderEvent>,
    ) -> Result<Vec<ProviderEvent>, GatewayError> {
        for event in &mut events {
            if !self.semantic {
                self.precommit_events += 1;
                self.precommit_chars += event.data.as_str().encode_utf16().count();
                if self.precommit_events > 10_000 || self.precommit_chars > 32 * 1024 * 1024 {
                    return Err(malformed("Upstream precommit output exceeded its bound."));
                }
                if crate::source_policy::semantic_event(&event.data) {
                    self.semantic = true;
                }
            }
            if !matches!(
                self.plan.decode,
                ResponseDecode::Responses | ResponseDecode::ResponsesToChat
            ) {
                crate::source::set(
                    &mut event.data,
                    "sequence_number",
                    crate::source::generated(&self.sequence),
                );
                self.sequence += 1;
            }
        }
        if self.plan.surface != ClientSurface::Chat || self.plan.decode == ResponseDecode::Chat {
            return Ok(events);
        }
        let mut result = vec![];
        for event in events {
            result.extend(self.chat.push(&event.data)?);
        }
        Ok(result)
    }
    fn native_event(&mut self, value: &Value) -> Result<Vec<ProviderEvent>, GatewayError> {
        let kind = value["type"].as_str().unwrap_or("");
        if !self.native_started && kind != "message_start" && kind != "ping" {
            return Err(malformed("Anthropic event arrived before message_start."));
        }
        let mut events = vec![];
        match kind {
            "message_start" => {
                if self.native_started {
                    return Err(malformed(
                        "Anthropic Messages emitted more than one message_start.",
                    ));
                }
                self.native_started = true;
                let message = &value["message"];
                if message["type"] != "message" || message["role"] != "assistant" {
                    return Err(malformed(
                        "Anthropic Messages returned an invalid assistant message.",
                    ));
                }
                if let Some(id) = message["id"].as_str().filter(|s| !s.is_empty()) {
                    self.writer.plan.response_id =
                        crate::response::native_response_id(id, &self.plan.response_id);
                    self.plan.response_id = self.writer.plan.response_id.clone();
                }
                if let Some(usage) = message.get("usage") {
                    self.native_usage = usage.clone();
                }
                events.extend(self.writer.start());
            }
            "content_block_start" => {
                if !self.native_started {
                    return Err(malformed("Anthropic block arrived before message_start."));
                }
                let index = value["index"]
                    .as_u64()
                    .ok_or_else(|| malformed("Anthropic block index is invalid."))?
                    as usize;
                if self.native.contains_key(&index) {
                    return Err(malformed("Anthropic repeated a content block index."));
                }
                let block = &value["content_block"];
                let kind = block["type"]
                    .as_str()
                    .ok_or_else(|| malformed("Anthropic content block has no type."))?;
                if !["text", "thinking", "tool_use", "redacted_thinking"].contains(&kind) {
                    return Err(malformed("Anthropic content block has unknown type."));
                }
                let mut entry = NativeBlock {
                    kind: kind.into(),
                    native: block.clone(),
                    ..Default::default()
                };
                match kind {
                    "text" => {
                        entry.text = block["text"].as_str().unwrap_or("").into();
                        events.extend(self.writer.text(&entry.text, false));
                    }
                    "thinking" => {
                        entry.text = block["thinking"].as_str().unwrap_or("").into();
                        events.extend(self.writer.reasoning(&entry.text));
                    }
                    "tool_use" => {
                        entry.id = block["id"]
                            .as_str()
                            .ok_or_else(|| malformed("Anthropic tool_use is missing id."))?
                            .into();
                        entry.name = block["name"]
                            .as_str()
                            .ok_or_else(|| malformed("Anthropic tool_use is missing name."))?
                            .into();
                        if !block["input"].is_object() {
                            return Err(malformed("Anthropic tool input must be object."));
                        }
                    }
                    _ => (),
                }
                self.native.insert(index, entry);
            }
            "content_block_delta" => {
                let index = value["index"]
                    .as_u64()
                    .ok_or_else(|| malformed("Anthropic block index is invalid."))?
                    as usize;
                let block = self
                    .native
                    .get_mut(&index)
                    .ok_or_else(|| malformed("Anthropic delta names an absent block."))?;
                if block.closed {
                    return Err(malformed("Anthropic delta names a closed block."));
                }
                let delta = &value["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" if block.kind == "text" => {
                        let text = delta["text"]
                            .as_str()
                            .ok_or_else(|| malformed("Anthropic text delta is not string."))?;
                        block.text.push_str(text);
                        events.extend(self.writer.text(text, false));
                    }
                    "thinking_delta" if block.kind == "thinking" => {
                        let text = delta["thinking"]
                            .as_str()
                            .ok_or_else(|| malformed("Anthropic thinking delta is not string."))?;
                        block.text.push_str(text);
                        events.extend(self.writer.reasoning(text));
                    }
                    "signature_delta" if block.kind == "thinking" => {
                        let signature = delta["signature"]
                            .as_str()
                            .ok_or_else(|| malformed("Anthropic signature delta is not string."))?;
                        let previous = block.native["signature"].as_str().unwrap_or("");
                        block.native["signature"] = json!(format!("{previous}{signature}"));
                    }
                    "input_json_delta" if block.kind == "tool_use" => {
                        block.args.push_str(
                            delta["partial_json"].as_str().ok_or_else(|| {
                                malformed("Anthropic argument delta is not string.")
                            })?,
                        );
                    }
                    _ => return Err(malformed("Anthropic delta does not match its block type.")),
                }
            }
            "content_block_stop" => {
                let index = value["index"]
                    .as_u64()
                    .ok_or_else(|| malformed("Anthropic block index is invalid."))?
                    as usize;
                let block = self
                    .native
                    .get_mut(&index)
                    .ok_or_else(|| malformed("Anthropic stop names an absent block."))?;
                if block.closed {
                    return Err(malformed("Anthropic block stopped more than once."));
                }
                block.closed = true;
                if block.kind == "tool_use" {
                    let args = if block.args.is_empty() {
                        block.native["input"].to_string()
                    } else {
                        block.args.clone()
                    };
                    let parsed: Value = serde_json::from_str(&args)
                        .map_err(|_| malformed("Anthropic tool JSON is incomplete."))?;
                    if !parsed.is_object() {
                        return Err(malformed("Anthropic tool JSON is not object."));
                    }
                    block.native["input"] = parsed;
                    events.extend(self.writer.tool_delta(
                        index,
                        Some(&block.id),
                        Some(&block.name),
                        &args,
                    ));
                } else if block.kind == "thinking" {
                    block.native["thinking"] = json!(block.text);
                } else if block.kind == "text" {
                    block.native["text"] = json!(block.text);
                }
                events.extend(self.writer.close());
            }
            "message_delta" => {
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    self.writer.finish_reason = Some(crate::writer::anthropic_reason(reason));
                }
                if let Some(usage) = value["usage"].as_object() {
                    for (k, v) in usage {
                        self.native_usage[k] = v.clone();
                    }
                }
            }
            "message_stop" => {
                if !self.native_started || self.native.values().any(|b| !b.closed) {
                    return Err(malformed(
                        "Anthropic message_stop arrived with unclosed blocks.",
                    ));
                }
                if self.writer.finish_reason.is_none() {
                    return Err(malformed("Anthropic message_stop has no stop reason."));
                }
                self.writer.usage = crate::usage::anthropic_to_responses(&self.native_usage);
                events.extend(self.writer.finish());
                crate::finalize::native_stop_error(
                    &mut events,
                    self.writer.finish_reason.as_deref().unwrap_or("unknown"),
                );
                self.terminal = true;
                if self.writer.terminal
                    == Some(gateway_core::lifecycle::SemanticTerminal::Completed)
                {
                    self.native_replay = Some(
                        json!({"role":"assistant","content":self.native.values().map(|b|b.native.clone()).collect::<Vec<_>>() }),
                    );
                }
            }
            "ping" => (),
            "error" => return Err(malformed("Anthropic emitted an error terminal.")),
            _ => return Err(malformed("Anthropic emitted an unknown event.")),
        }
        Ok(events)
    }
}
fn validate_chat_chunk(value: &Value) -> Result<(), GatewayError> {
    let choices = value["choices"]
        .as_array()
        .ok_or_else(|| malformed("Upstream Chat chunk has no choices."))?;
    for choice in choices {
        if !choice.is_object() {
            return Err(malformed("Upstream Chat choice is invalid."));
        }
        if let Some(delta) = choice.get("delta") {
            if !delta.is_object() {
                return Err(malformed("Upstream Chat delta is invalid."));
            }
            for key in ["content", "refusal", "reasoning_content", "reasoning"] {
                if delta
                    .get(key)
                    .is_some_and(|v| !v.is_null() && !v.is_string())
                {
                    return Err(malformed(format!("Upstream Chat {key} is not string.")));
                }
            }
        }
    }
    Ok(())
}
pub use crate::source_collector::ChatCollector;

impl std::fmt::Debug for StreamDecoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamDecoder")
            .field("decode", &self.plan.decode)
            .field("terminal", &self.terminal)
            .field("semantic", &self.semantic)
            .finish_non_exhaustive()
    }
}
