use gateway_core::{
    js_string::JsString16, model::ModelId, provider::UpstreamProvider, source_json::SourceJson,
    source_serialization,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Headers = BTreeMap<String, String>;
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ClientSurface {
    Responses,
    Chat,
    SystemOne,
    Embeddings,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ChatProfile {
    Deepseek,
    Lithos,
    Cerebras,
    Claude,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ResponseDecode {
    Responses,
    Chat,
    ChatToResponses(ChatProfile),
    ResponsesToChat,
    AnthropicToResponses,
    AnthropicChatToResponses,
    Voyage,
    SystemOne,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ToolIdentity {
    pub name: JsString16,
    pub namespace: Option<JsString16>,
    pub custom: bool,
}
pub use crate::source_tools::ToolMap;

/// Secrets are supplied by the host-owned credential capability; never discovered here.
#[derive(Clone, Default)]
pub struct AuthMaterial {
    pub secret: String,
    pub account_id: Option<String>,
    pub api_key: bool,
    pub workspace_id: Option<String>,
}
impl std::fmt::Debug for AuthMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthMaterial")
            .field("secret", &"[redacted]")
            .field("api_key", &self.api_key)
            .finish_non_exhaustive()
    }
}
/// Immutable Rust-only selected-model observations, never request JSON or authority.
#[derive(Clone, Debug)]
pub struct OrdinaryPreparationContext {
    prompt_cache: Option<SourceJson>,
    reasoning: gateway_schema::reasoning::ModelReasoning,
    default_effort: JsString16,
}
impl OrdinaryPreparationContext {
    pub fn from_metadata(
        metadata: &gateway_schema::catalog::RequestModelMetadata,
        default_effort: &JsString16,
    ) -> Self {
        Self {
            prompt_cache: metadata.prompt_cache(),
            reasoning: metadata.reasoning.clone(),
            default_effort: default_effort.clone(),
        }
    }
    pub fn prompt_cache(&self) -> Option<&SourceJson> {
        self.prompt_cache.as_ref()
    }
    pub fn reasoning(&self) -> &gateway_schema::reasoning::ModelReasoning {
        &self.reasoning
    }
    pub fn default_effort(&self) -> &JsString16 {
        &self.default_effort
    }
}
#[derive(Clone, Debug)]
pub struct PrepareOptions {
    pub auth: AuthMaterial,
    pub client_version: String,
    pub native_session_id: Option<String>,
    pub response_id: String,
    pub created_at: i64,
    /// Host-supplied discovery evidence; absence must not invent provider support.
    pub allowed_models: Vec<ModelId>,
    pub catalog_max_output_tokens: Option<u64>,
    pub native_reasoning_efforts: Option<Vec<JsString16>>,
    pub supports_native_effort: bool,
    pub supports_disabled_thinking: bool,
    pub supports_parallel_tools: Option<bool>,
    /// Random per request unless a verified native-session identity is supplied.
    pub conversation_id: Option<String>,
    pub reasoning_summary: Option<JsString16>,
    /// Restored by ReplayStore in the same authenticated context, never by client input.
    pub restored_native_messages: Option<Vec<Value>>,
    /// Runtime callers supply Some even for unknown metadata. None is the legacy pure adapter contract.
    pub ordinary_preparation: Option<OrdinaryPreparationContext>,
}
impl Default for PrepareOptions {
    fn default() -> Self {
        Self {
            auth: AuthMaterial::default(),
            client_version: "0.100.0".into(),
            native_session_id: None,
            response_id: "resp_gateway".into(),
            created_at: 0,
            allowed_models: Vec::new(),
            catalog_max_output_tokens: None,
            native_reasoning_efforts: None,
            supports_native_effort: false,
            supports_disabled_thinking: false,
            supports_parallel_tools: None,
            conversation_id: None,
            reasoning_summary: None,
            restored_native_messages: None,
            ordinary_preparation: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DecodePlan {
    pub provider: UpstreamProvider,
    pub surface: ClientSurface,
    pub decode: ResponseDecode,
    pub model: ModelId,
    pub upstream_model: ModelId,
    pub response_id: String,
    pub created_at: i64,
    pub stream: bool,
    pub request: SourceJson,
    pub tool_names: ToolMap,
    pub reasoning_summary: Option<JsString16>,
}
#[derive(Clone)]
pub struct PreparedRequest {
    pub provider: UpstreamProvider,
    pub url: String,
    pub method: String,
    pub headers: Headers,
    pub body: SourceJson,
    pub decode: DecodePlan,
    pub warnings: Vec<String>,
}
impl std::fmt::Debug for PreparedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedRequest")
            .field("provider", &self.provider)
            .field("url", &self.url)
            .field("method", &self.method)
            .field("header_names", &self.headers.keys().collect::<Vec<_>>())
            .field("body", &"[request body omitted]")
            .field("decode", &self.decode.decode)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderEvent {
    pub event: Option<String>,
    pub data: SourceJson,
}
impl ProviderEvent {
    pub fn responses(data: Value) -> Self {
        Self {
            event: data.get("type").and_then(Value::as_str).map(str::to_owned),
            data: crate::source::generated(&data),
        }
    }
    pub fn chat(data: Value) -> Self {
        Self {
            event: None,
            data: crate::source::generated(&data),
        }
    }
    pub fn responses_source(data: SourceJson) -> Self {
        let event = source_serialization::member(&data, "type")
            .and_then(|value| source_serialization::string(&value))
            .and_then(|value| value.try_utf8().ok());
        Self { event, data }
    }
    pub fn chat_source(data: SourceJson) -> Self {
        Self { event: None, data }
    }
    pub fn field(&self, name: &str) -> Option<SourceJson> {
        source_serialization::member(&self.data, name)
    }
    pub fn type_name(&self) -> Option<String> {
        self.field("type")
            .and_then(|value| source_serialization::string(&value))
            .and_then(|value| value.try_utf8().ok())
    }
    pub fn is_done(&self) -> bool {
        crate::source::is(&self.data, "[DONE]")
    }
    pub fn semantic_event(&self) -> bool {
        crate::source_policy::semantic_event(&self.data)
    }
    pub fn reasoning_progress(&self) -> bool {
        crate::source_policy::reasoning_progress(&self.data)
    }
    /// Only the isolated numeric/accounting fragment crosses the scalar decoder boundary.
    pub fn observed_usage(&self) -> Option<Value> {
        self.field("usage")
            .as_ref()
            .and_then(crate::source_collector::usage)
            .or_else(|| {
                self.field("response").and_then(|response| {
                    crate::source_collector::usage(&crate::source::get(&response, "usage"))
                })
            })
    }
    pub fn terminal(&self) -> Option<gateway_core::lifecycle::SemanticTerminal> {
        use gateway_core::lifecycle::SemanticTerminal;
        match self.type_name().as_deref() {
            Some("response.completed") => Some(SemanticTerminal::Completed),
            Some("response.incomplete") => Some(SemanticTerminal::Incomplete),
            Some("response.failed") => Some(SemanticTerminal::Failed),
            Some("error") => Some(SemanticTerminal::Error),
            _ if self.field("error").is_some() => Some(SemanticTerminal::Error),
            _ => self
                .field("choices")
                .and_then(|value| source_serialization::array(&value))
                .into_iter()
                .flatten()
                .find_map(|choice| {
                    match crate::source::control(&crate::source::get(&choice, "finish_reason"))
                        .as_deref()
                    {
                        Some("stop" | "tool_calls" | "function_call") => {
                            Some(SemanticTerminal::Completed)
                        }
                        Some("length" | "content_filter") => Some(SemanticTerminal::Incomplete),
                        _ => None,
                    }
                }),
        }
    }
    pub fn encode_sse(&self) -> String {
        if self.is_done() {
            return "data: [DONE]\n\n".into();
        }
        let event = self
            .event
            .as_ref()
            .map(|s| format!("event: {s}\n"))
            .unwrap_or_default();
        format!("{event}data: {}\n\n", self.data.as_str())
    }
}
#[derive(Clone)]
pub struct DecodedResponse {
    pub status: u16,
    pub headers: Headers,
    pub body: SourceJson,
    pub events: Vec<ProviderEvent>,
    pub terminal: Option<gateway_core::lifecycle::SemanticTerminal>,
    pub usage: Option<Value>,
    pub native_replay: Option<Value>,
    pub raw_body: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Elision {
    pub path: String,
    pub call_id: Option<JsString16>,
    pub kind: String,
    pub original_bytes: usize,
    pub forwarded_bytes: usize,
    pub omitted_bytes: usize,
}
pub(crate) fn invalid(message: impl Into<String>, param: &str) -> gateway_core::GatewayError {
    gateway_core::GatewayError::new(400, message, Some("invalid_request_error"))
        .with_param(Some(param))
}
pub(crate) fn malformed(message: impl Into<String>) -> gateway_core::GatewayError {
    gateway_core::GatewayError::new(502, message, Some("upstream_stream_error"))
        .with_type("server_error")
}
pub(crate) fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

impl std::fmt::Debug for DecodedResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DecodedResponse")
            .field("status", &self.status)
            .field("terminal", &self.terminal)
            .field("event_count", &self.events.len())
            .field("native_replay", &self.native_replay.is_some())
            .finish_non_exhaustive()
    }
}
