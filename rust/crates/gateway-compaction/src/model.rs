//! Source library data model; text shares immutable UTF16 buffers like JS strings.
use crate::{text::Text, types::CompactionStats};
use gateway_core::source_json::SourceJson;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::rc::Rc;
pub type Json = Rc<SourceJson>;
pub(crate) fn serialize_json<S: Serializer>(v: &Json, s: S) -> Result<S::Ok, S::Error> {
    v.as_ref().serialize(s)
}
fn deserialize_json<'de, D: Deserializer<'de>>(d: D) -> Result<Json, D::Error> {
    <SourceJson as Deserialize>::deserialize(d).map(Rc::new)
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    #[serde(rename = "tool_use_id")]
    pub tool_use_id: Text,
    pub tool: Text,
    #[serde(
        serialize_with = "serialize_json",
        deserialize_with = "deserialize_json"
    )]
    pub input: Json,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<Text>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    #[serde(rename = "tool_use_id")]
    pub tool_use_id: Text,
    pub text: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub text: Text,
    pub tool_uses: Vec<ToolUse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_results: Option<Vec<ToolResult>>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: Text,
    #[serde(rename = "tool_use_id")]
    pub tool_use_id: Text,
    pub tool: Text,
    #[serde(serialize_with = "serialize_json")]
    pub input: Json,
    pub call_index: usize,
    pub result_index: usize,
    pub result_chars: usize,
    pub is_error: bool,
    pub pinned: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Keep,
    DropResult,
    DropCall,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    Pinned,
    Kept,
    ResultDropped,
    CallDropped,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: Text,
    pub tool: Text,
    pub keep_call: f64,
    pub keep_result: f64,
    pub action: Action,
    pub reason: Reason,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryCall {
    pub id: Text,
    pub tool: Text,
    pub input: Text,
    pub result: Text,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum HistoryCalls {
    Structured(Vec<HistoryCall>),
    Compact(Vec<Text>),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub i: usize,
    pub role: Role,
    pub text: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<HistoryCalls>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct State {
    pub context: Text,
    pub goal: Text,
    pub history: Vec<HistoryEntry>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Fitted {
    pub state: State,
    pub tokens: usize,
    pub stage: String,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub goal: Option<Text>,
    pub keep_threshold: Option<f64>,
    pub preserve_recent_messages: Option<f64>,
    pub max_state_tokens: Option<f64>,
    pub max_request_tokens: Option<f64>,
    pub truncate_head_chars: Option<f64>,
}
#[derive(Clone, Debug)]
pub struct Resolved {
    pub goal: Text,
    pub threshold: f64,
    pub recent: usize,
    pub state_tokens: f64,
    pub request_tokens: f64,
    pub head: usize,
}
impl Options {
    pub fn resolve(&self) -> Resolved {
        let finite =
            |v: Option<f64>, fallback: f64| v.filter(|v| v.is_finite()).unwrap_or(fallback);
        Resolved {
            goal: self.goal.clone().unwrap_or_default(),
            threshold: finite(self.keep_threshold, 0.5),
            recent: finite(self.preserve_recent_messages, 6.0).floor().max(0.0) as usize,
            state_tokens: finite(self.max_state_tokens, 25_000.0).max(1.0),
            request_tokens: finite(self.max_request_tokens, 30_000.0).max(1.0),
            head: finite(self.truncate_head_chars, 300.0).floor().max(0.0) as usize,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct CompactResult {
    pub messages: Vec<Message>,
    pub decisions: Vec<Decision>,
    pub stats: CompactionStats,
}
