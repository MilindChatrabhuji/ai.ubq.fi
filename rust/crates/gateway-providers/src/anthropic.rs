//! Lossless Claude wire selection. Returning None retains the original Responses request.
use crate::types::*;
use serde_json::Value;
pub fn is_claude(model: &str) -> bool {
    is_claude_model(&gateway_core::model::ModelId::from_scalar(model))
}
pub fn is_claude_model(model: &gateway_core::model::ModelId) -> bool {
    let original = model.as_js_string().as_units();
    let without_tilde = original.strip_prefix(&[126]).unwrap_or(original);
    let prefix = "anthropic/".encode_utf16().collect::<Vec<_>>();
    let model = without_tilde
        .strip_prefix(prefix.as_slice())
        .unwrap_or(original);
    model.starts_with(&"claude-".encode_utf16().collect::<Vec<_>>())
}
pub fn try_native_messages(
    raw: &Value,
    options: &PrepareOptions,
) -> Option<gateway_core::source_json::SourceJson> {
    crate::source_anthropic::native(&crate::source::generated(raw), options)
}
pub fn try_claude_chat(
    raw: &Value,
    options: &PrepareOptions,
) -> Option<crate::chat::ChatProjection> {
    let projection = crate::source_anthropic::chat(&crate::source::generated(raw), options)?;
    Some(crate::chat::ChatProjection {
        body: projection.body,
        tool_names: projection.names,
        elisions: projection.elisions,
        warnings: projection.warnings,
    })
}
