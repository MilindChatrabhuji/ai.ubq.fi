//! Lossless Claude wire selection. Returning None retains the original Responses request.
use crate::types::*;
use serde_json::Value;
pub fn is_claude(model: &str) -> bool {
    model
        .strip_prefix('~')
        .unwrap_or(model)
        .strip_prefix("anthropic/")
        .unwrap_or(model)
        .starts_with("claude-")
}
pub fn try_native_messages(raw: &Value,options: &PrepareOptions) -> Option<gateway_core::source_json::SourceJson> { crate::source_anthropic::native(&crate::source::generated(raw),options) }
pub fn try_claude_chat(raw: &Value,options: &PrepareOptions) -> Option<crate::chat::ChatProjection> {
    let projection=crate::source_anthropic::chat(&crate::source::generated(raw),options)?;
    Some(crate::chat::ChatProjection{body:projection.body,tool_names:projection.names,elisions:projection.elisions,warnings:projection.warnings})
}
