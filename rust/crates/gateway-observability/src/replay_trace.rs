//! Request-owned passive source upstream recorder. Hooks only consume bytes the transport already read.
use base64::{Engine, engine::general_purpose::STANDARD};
use gateway_core::GatewayError;
use serde::Serialize;
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};
use zeroize::Zeroizing;
pub const SAFE_HEADERS: &[&str] = &[
    "cache-control",
    "content-length",
    "content-type",
    "openai-processing-ms",
    "retry-after",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
];
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceProvider {
    ChatgptCodex,
    Surplus,
    Metered,
    Cerebras,
    Deepseek,
    Lithos,
    Openrouter,
    ClaudeCode,
}
#[derive(Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceTerminal {
    Pending,
    FetchError,
    Eof,
    ReadError,
    Cancelled,
}
#[derive(Clone, Serialize)]
struct AttemptWire {
    provider: TraceProvider,
    status: Option<u16>,
    content_type: Option<&'static str>,
    chunks_base64: Vec<String>,
    terminal: TraceTerminal,
    headers: BTreeMap<String, String>,
    headers_truncated: bool,
    chunk_times_ms: Vec<i64>,
    started_at_ms: i64,
    headers_at_ms: Option<i64>,
    ended_at_ms: Option<i64>,
}
#[derive(Clone, Serialize)]
struct TraceDocument {
    version: u8,
    attempts: Vec<AttemptWire>,
    attempts_truncated: bool,
    bytes_truncated: bool,
    chunks_truncated: bool,
}
#[derive(Clone)]
pub struct UpstreamTrace(Rc<TraceDocument>);
impl Serialize for UpstreamTrace {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(s)
    }
}
impl UpstreamTrace {
    pub fn empty() -> Self {
        Self(Rc::new(TraceDocument {
            version: 2,
            attempts: Vec::new(),
            attempts_truncated: false,
            bytes_truncated: false,
            chunks_truncated: false,
        }))
    }
    pub(crate) fn canonical(&self) -> Result<String, GatewayError> {
        self.validate()?;
        let value = serde_json::to_value(self.0.as_ref())
            .map_err(|_| crate::store::error("Upstream trace serialization failed"))?;
        fn canonical(value: &serde_json::Value) -> String {
            match value {
                serde_json::Value::Object(fields) => {
                    let mut keys = fields.keys().collect::<Vec<_>>();
                    keys.sort();
                    format!(
                        "{{{}}}",
                        keys.into_iter()
                            .map(|key| format!(
                                "{}:{}",
                                gateway_schema::util::json_stringify(&serde_json::Value::String(
                                    key.clone()
                                )),
                                canonical(&fields[key])
                            ))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                }
                serde_json::Value::Array(values) => format!(
                    "[{}]",
                    values.iter().map(canonical).collect::<Vec<_>>().join(",")
                ),
                _ => gateway_schema::util::json_stringify(value),
            }
        }
        Ok(canonical(&value))
    }
    pub(crate) fn validate(&self) -> Result<(), GatewayError> {
        for attempt in &self.0.attempts {
            if matches!(attempt.provider, TraceProvider::ClaudeCode) {
                return Err(crate::store::error(
                    "The frozen source upstream parser rejects Claude trace providers",
                ));
            }
            if attempt.started_at_ms < 0
                || attempt.started_at_ms > gateway_core::identity::MAX_SAFE_INTEGER
                || attempt
                    .chunk_times_ms
                    .iter()
                    .any(|t| !(0..=604_800_000).contains(t))
            {
                return Err(crate::store::error("Upstream trace timing is invalid"));
            }
            if attempt.terminal != TraceTerminal::Pending && attempt.ended_at_ms.is_none() {
                return Err(crate::store::error(
                    "Upstream trace termination time is missing",
                ));
            }
        }
        Ok(())
    }
    pub(crate) fn reasons(
        &self,
        client: &crate::replay_producer::ClientFailureObservation,
    ) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.0.attempts.is_empty() && !(400..500).contains(&client.status) {
            out.push("upstream_trace_empty")
        }
        if self.0.attempts_truncated || self.0.bytes_truncated || self.0.chunks_truncated {
            out.push("upstream_trace_truncated")
        }
        if self
            .0
            .attempts
            .iter()
            .any(|a| a.terminal == TraceTerminal::Pending)
        {
            out.push("upstream_attempt_pending")
        }
        if self.0.attempts.iter().any(|a| a.headers_truncated) {
            out.push("upstream_response_headers_unavailable")
        }
        if client.terminal_body_base64.is_none() {
            out.push("downstream_terminal_body_unavailable")
        }
        out
    }
    pub(crate) fn coverage(
        &self,
        client: &crate::replay_producer::ClientFailureObservation,
        reasons: &[&str],
    ) -> &'static str {
        if reasons.contains(&"upstream_trace_truncated")
            || reasons.contains(&"upstream_attempt_pending")
        {
            "partial"
        } else if self.0.attempts.is_empty() {
            if (400..500).contains(&client.status) {
                "full"
            } else {
                "unavailable"
            }
        } else if reasons.is_empty() {
            "full"
        } else {
            "partial"
        }
    }
}
struct MutableAttempt {
    wire: AttemptWire,
    chunks: Vec<Zeroizing<Vec<u8>>>,
}
#[derive(Default)]
struct State {
    attempts: Vec<MutableAttempt>,
    attempts_truncated: bool,
    bytes_truncated: bool,
    chunks_truncated: bool,
    total_bytes: usize,
    total_chunks: usize,
    sealed: Option<UpstreamTrace>,
    disposed: bool,
}
#[derive(Clone, Default)]
pub struct TraceRecorder(Rc<RefCell<State>>);
#[derive(Clone)]
pub struct AttemptTrace {
    state: Rc<RefCell<State>>,
    index: Option<usize>,
}
impl TraceRecorder {
    pub fn start(&self, provider: TraceProvider, at: i64) -> AttemptTrace {
        let mut state = self.0.borrow_mut();
        let index = if state.disposed || state.sealed.is_some() {
            None
        } else if state.attempts.len() >= 8 {
            state.attempts_truncated = true;
            None
        } else {
            let index = state.attempts.len();
            state.attempts.push(MutableAttempt {
                wire: AttemptWire {
                    provider,
                    status: None,
                    content_type: None,
                    chunks_base64: Vec::new(),
                    terminal: TraceTerminal::Pending,
                    headers: BTreeMap::new(),
                    headers_truncated: false,
                    chunk_times_ms: Vec::new(),
                    started_at_ms: at,
                    headers_at_ms: None,
                    ended_at_ms: None,
                },
                chunks: Vec::new(),
            });
            Some(index)
        };
        AttemptTrace {
            state: self.0.clone(),
            index,
        }
    }
    pub fn seal(&self) -> UpstreamTrace {
        let mut state = self.0.borrow_mut();
        if let Some(trace) = state.sealed.as_ref() {
            return trace.clone();
        }
        let attempts = state
            .attempts
            .iter()
            .map(|a| {
                let mut wire = a.wire.clone();
                wire.chunks_base64 = a
                    .chunks
                    .iter()
                    .map(|chunk| STANDARD.encode(chunk.as_slice()))
                    .collect();
                wire
            })
            .collect();
        let trace = UpstreamTrace(Rc::new(TraceDocument {
            version: 2,
            attempts,
            attempts_truncated: state.attempts_truncated,
            bytes_truncated: state.bytes_truncated,
            chunks_truncated: state.chunks_truncated,
        }));
        state.sealed = Some(trace.clone());
        for attempt in &mut state.attempts {
            attempt.chunks.clear()
        }
        trace
    }
    pub fn dispose(&self) {
        let mut state = self.0.borrow_mut();
        state.disposed = true;
        for attempt in &mut state.attempts {
            attempt.chunks.clear();
        }
    }
}
impl AttemptTrace {
    pub fn headers(
        &self,
        status: u16,
        headers: &BTreeMap<String, String>,
        at: i64,
        bodyless: bool,
    ) {
        let Some(index) = self.index else { return };
        let mut state = self.state.borrow_mut();
        if state.disposed || state.sealed.is_some() {
            return;
        }
        let attempt = &mut state.attempts[index];
        attempt.wire.status = (100..=599).contains(&status).then_some(status);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.trim_matches(gateway_schema::util::js_whitespace))
                .filter(|v| !v.is_empty())
        };
        attempt.wire.content_type = Some(match get("content-type").map(str::to_ascii_lowercase) {
            Some(v) if v.contains("text/event-stream") => "text/event-stream",
            Some(v) if v.contains("application/json") => "application/json",
            _ => "other",
        });
        for name in SAFE_HEADERS {
            if let Some(value) = get(name) {
                if value.encode_utf16().count() > 512 {
                    attempt.wire.headers_truncated = true
                } else {
                    attempt.wire.headers.insert((*name).into(), value.into());
                }
            }
        }
        attempt.wire.headers_at_ms = Some(at);
        if bodyless {
            attempt.wire.terminal = TraceTerminal::Eof;
            attempt.wire.ended_at_ms = Some(at.max(attempt.wire.started_at_ms));
        }
    }
    pub fn consumed(&self, bytes: &[u8], at: i64) {
        let Some(index) = self.index else { return };
        let mut state = self.state.borrow_mut();
        if state.disposed
            || state.sealed.is_some()
            || bytes.is_empty()
            || state.attempts[index].wire.terminal != TraceTerminal::Pending
        {
            return;
        }
        if state.total_chunks >= 4096 {
            state.chunks_truncated = true;
            if state.total_bytes >= 4 * 1024 * 1024 {
                state.bytes_truncated = true
            }
            return;
        }
        if state.total_bytes >= 4 * 1024 * 1024 {
            state.bytes_truncated = true;
            return;
        }
        let keep = bytes.len().min(4 * 1024 * 1024 - state.total_bytes);
        let attempt = &mut state.attempts[index];
        attempt.chunks.push(Zeroizing::new(bytes[..keep].to_vec()));
        let elapsed = at
            .saturating_sub(attempt.wire.started_at_ms)
            .clamp(0, 604_800_000)
            .max(attempt.wire.chunk_times_ms.last().copied().unwrap_or(0));
        attempt.wire.chunk_times_ms.push(elapsed);
        state.total_chunks += 1;
        state.total_bytes += keep;
        if keep < bytes.len() {
            state.bytes_truncated = true
        }
    }
    pub fn finish(&self, terminal: TraceTerminal, at: i64) {
        let Some(index) = self.index else { return };
        if terminal == TraceTerminal::Pending {
            return;
        }
        let mut state = self.state.borrow_mut();
        if state.disposed || state.sealed.is_some() {
            return;
        }
        let attempt = &mut state.attempts[index];
        if attempt.wire.terminal != TraceTerminal::Pending
            || (terminal == TraceTerminal::FetchError && attempt.wire.status.is_some())
        {
            return;
        }
        attempt.wire.terminal = terminal;
        attempt.wire.ended_at_ms = Some(
            at.max(
                attempt
                    .wire
                    .headers_at_ms
                    .unwrap_or(attempt.wire.started_at_ms),
            )
            .max(attempt.wire.started_at_ms),
        );
    }
    pub fn fetch_error(&self, at: i64) {
        self.finish(TraceTerminal::FetchError, at)
    }
}
