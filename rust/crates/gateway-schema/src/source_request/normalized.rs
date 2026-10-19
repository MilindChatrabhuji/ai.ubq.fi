//! Public source normalization results borrow no scalar transcript representation.
use super::{SourceRequestDocument, SourceRequestError, value::Value};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
#[derive(Clone, Debug, PartialEq)]
pub struct SourceChatMessage {
    pub instruction: Option<JsString16>,
    pub instruction_content: Option<Vec<SourceJson>>,
    pub input: Vec<SourceJson>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct SourceChatInput {
    pub input: Vec<SourceJson>,
    pub instructions: Option<JsString16>,
}
fn output(value: Value) -> Result<SourceJson, SourceRequestError> {
    value.source().map_err(SourceRequestError::from_scalar)
}
fn values(values: Vec<Value>) -> Result<Vec<SourceJson>, SourceRequestError> {
    values.into_iter().map(output).collect()
}
pub fn normalize_response_content(
    value: &SourceJson,
    param: &str,
    role: &str,
) -> Result<SourceJson, SourceRequestError> {
    super::content_engine::normalize_response_content(
        &Value::from_source(value.clone()),
        param,
        role,
    )
    .and_then(output)
}
pub fn normalize_response_message(
    value: &SourceJson,
    param: &str,
) -> Result<SourceJson, SourceRequestError> {
    super::content_engine::normalize_response_message(&Value::from_source(value.clone()), param)
        .and_then(output)
}
pub fn is_gateway_failover_warning(value: &SourceJson) -> bool {
    super::content_engine::is_gateway_failover_warning(&Value::from_source(value.clone()))
}
pub fn normalize_function_output(
    value: &SourceJson,
    param: &str,
) -> Result<SourceJson, SourceRequestError> {
    super::content_engine::normalize_function_output(&Value::from_source(value.clone()), param)
        .and_then(output)
}
pub fn normalize_responses_input(
    value: Option<&SourceJson>,
) -> Result<Vec<SourceJson>, SourceRequestError> {
    let value = value.map(|value| Value::from_source(value.clone()));
    super::content_engine::normalize_responses_input(value.as_ref()).and_then(values)
}
pub fn normalize_chat_message(
    value: &SourceJson,
    index: usize,
) -> Result<SourceChatMessage, SourceRequestError> {
    let value =
        super::chat_engine::normalize_chat_message(&Value::from_source(value.clone()), index)?;
    Ok(SourceChatMessage {
        instruction: value.instruction.map(|text| text.core()),
        instruction_content: value.instruction_content.map(values).transpose()?,
        input: values(value.input)?,
    })
}
pub fn normalize_chat_messages(value: &SourceJson) -> Result<SourceChatInput, SourceRequestError> {
    let value = super::chat_engine::normalize_chat_messages(&Value::from_source(value.clone()))?;
    Ok(SourceChatInput {
        input: values(value.input)?,
        instructions: value.instructions.map(|text| text.core()),
    })
}
pub fn normalize_breakpoint(
    value: Option<&SourceJson>,
    param: &str,
) -> Result<Option<SourceJson>, SourceRequestError> {
    let value = value.map(|value| Value::from_source(value.clone()));
    super::controls::normalize_breakpoint(value.as_ref(), param)?
        .map(output)
        .transpose()
}

impl SourceRequestDocument {
    pub fn normalize_responses_input(&self) -> Result<Vec<SourceJson>, SourceRequestError> {
        normalize_responses_input(super::member(self.original_source(), "input")?.as_ref())
    }
    /// Explicit Codex/paid Chat phase, never an unconditional direct-provider gate.
    pub fn normalize_chat_for_codex(&self) -> Result<SourceChatInput, SourceRequestError> {
        let value = super::member(self.original_source(), "messages")?
            .ok_or_else(|| SourceRequestError::scalar("messages must be an array", None))?;
        normalize_chat_messages(&value)
    }
}
