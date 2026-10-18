use std::collections::BTreeMap;
use gateway_core::provider::UpstreamProvider;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Headers = BTreeMap<String, String>;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ClientSurface { Responses, Chat, SystemOne, Embeddings }
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ChatProfile { Deepseek, Lithos, Cerebras, Claude }
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ResponseDecode { Responses, Chat, ChatToResponses(ChatProfile), ResponsesToChat, AnthropicToResponses, AnthropicChatToResponses, Voyage, SystemOne }
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolIdentity { pub name: String, pub namespace: Option<String>, pub custom: bool }
pub type ToolMap = BTreeMap<String, ToolIdentity>;

/// Secrets are supplied by the host-owned credential capability; never discovered here.
#[derive(Clone, Default)]
pub struct AuthMaterial { pub secret: String, pub account_id: Option<String>, pub api_key: bool, pub workspace_id: Option<String> }
impl std::fmt::Debug for AuthMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.debug_struct("AuthMaterial").field("secret", &"[redacted]").field("api_key", &self.api_key).finish_non_exhaustive() }
}
#[derive(Clone, Debug)]
pub struct PrepareOptions {
    pub auth: AuthMaterial,
    pub client_version: String,
    pub native_session_id: Option<String>,
    pub response_id: String,
    pub created_at: i64,
    /// Host-supplied discovery evidence; absence must not invent provider support.
    pub allowed_models: Vec<String>,
    pub catalog_max_output_tokens: Option<u64>,
    pub native_reasoning_efforts: Option<Vec<String>>,
    pub supports_native_effort: bool,
    pub supports_disabled_thinking: bool,
    pub supports_parallel_tools: bool,
    pub reasoning_summary: Option<String>,
    /// Restored by ReplayStore in the same authenticated context, never by client input.
    pub restored_native_messages: Option<Vec<Value>>,
}
impl Default for PrepareOptions {
    fn default() -> Self { Self { auth: AuthMaterial::default(), client_version: "0.100.0".into(), native_session_id: None, response_id: "resp_gateway".into(), created_at: 0, allowed_models: Vec::new(), catalog_max_output_tokens: None, native_reasoning_efforts: None, supports_native_effort: false, supports_disabled_thinking: false, supports_parallel_tools: false, reasoning_summary: None, restored_native_messages: None } }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DecodePlan {
    pub provider: UpstreamProvider,
    pub surface: ClientSurface,
    pub decode: ResponseDecode,
    pub model: String,
    pub upstream_model: String,
    pub response_id: String,
    pub created_at: i64,
    pub stream: bool,
    pub request: Value,
    pub tool_names: ToolMap,
    pub reasoning_summary: Option<String>,
}
#[derive(Clone)]
pub struct PreparedRequest { pub provider: UpstreamProvider, pub url: String, pub method: String, pub headers: Headers, pub body: Value, pub decode: DecodePlan, pub warnings: Vec<String> }
impl std::fmt::Debug for PreparedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.debug_struct("PreparedRequest").field("provider", &self.provider).field("url", &self.url).field("method", &self.method).field("header_names", &self.headers.keys().collect::<Vec<_>>()).field("body", &"[request body omitted]").field("decode", &self.decode.decode).finish() }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderEvent { pub event: Option<String>, pub data: Value }
impl ProviderEvent {
    pub fn responses(data: Value) -> Self { Self { event: data.get("type").and_then(Value::as_str).map(str::to_owned), data } }
    pub fn chat(data: Value) -> Self { Self { event: None, data } }
    pub fn encode_sse(&self) -> String { if self.data == Value::String("[DONE]".into()) { return "data: [DONE]\n\n".into(); } let event = self.event.as_ref().map(|s| format!("event: {s}\n")).unwrap_or_default(); format!("{event}data: {}\n\n", self.data) }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DecodedResponse { pub status: u16, pub headers: Headers, pub body: Value, pub events: Vec<ProviderEvent>, pub terminal: Option<gateway_core::lifecycle::SemanticTerminal>, pub usage: Option<Value>, pub native_replay: Option<Value> }
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Elision { pub path: String, pub call_id: Option<String>, pub kind: String, pub original_bytes: usize, pub forwarded_bytes: usize, pub omitted_bytes: usize }
pub(crate) fn invalid(message: impl Into<String>, param: &str) -> gateway_core::GatewayError { gateway_core::GatewayError::new(400,message,Some("invalid_request_error")).with_param(Some(param)) }
pub(crate) fn malformed(message: impl Into<String>) -> gateway_core::GatewayError { gateway_core::GatewayError::new(502,message,Some("upstream_stream_error")).with_type("server_error") }
pub(crate) fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> { headers.iter().find(|(key,_)| key.eq_ignore_ascii_case(name)).map(|(_,v)|v.as_str()) }
pub(crate) fn object(value: &Value) -> Result<serde_json::Map<String,Value>,gateway_core::GatewayError> { value.as_object().cloned().ok_or_else(|| invalid("Invalid JSON body", "")) }
