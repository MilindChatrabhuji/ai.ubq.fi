//! Observed prompt cache metadata is distinct from the official request control schema.
use gateway_core::GatewayError;
use serde_json::Value;
pub const SCOPE_PROFILE: &str = "responses_implicit_input_text_keyed_cycle_isolated_v5";
pub const CODEX_PROVIDER: &str = "codex_chatgpt";
pub fn normalize_breakpoint(
    value: Option<&Value>,
    param: &str,
) -> Result<Option<Value>, GatewayError> {
    let value = value
        .map(gateway_core::source_json::SourceJson::from_serializable)
        .transpose()?;
    crate::source_request::normalize_breakpoint(value.as_ref(), param)
        .map_err(crate::source_request::SourceRequestError::into_scalar)?
        .map(|value| value.deserialize())
        .transpose()
}

pub fn validate_prompt_cache_controls(body: &Value) -> Result<(), GatewayError> {
    crate::source_request::validate_prompt_cache_controls(
        &gateway_core::source_json::SourceJson::from_serializable(body)?,
    )
    .map_err(crate::source_request::SourceRequestError::into_scalar)
}

fn scalar_source(value: &Value) -> Option<gateway_core::source_json::SourceJson> {
    gateway_core::source_json::SourceJson::from_serializable(value).ok()
}
fn scalar_result(value: Option<gateway_core::source_json::SourceJson>) -> Option<Value> {
    value?.deserialize().ok()
}
pub fn normalize_capabilities_source(
    value: Option<&gateway_core::source_json::SourceJson>,
) -> Option<gateway_core::source_json::SourceJson> {
    crate::source_request::cache_metadata::normalize_capabilities_source(value)
}
pub fn compact_capabilities_source(
    value: Option<&gateway_core::source_json::SourceJson>,
) -> Option<gateway_core::source_json::SourceJson> {
    crate::source_request::cache_metadata::compact_capabilities_source(value)
}
pub fn normalize_scope_source(
    value: &gateway_core::source_json::SourceJson,
) -> Option<gateway_core::source_json::SourceJson> {
    crate::source_request::cache_metadata::normalize_scope_source(value)
}
pub fn merge_capabilities_source(
    previous: Option<&gateway_core::source_json::SourceJson>,
    next: Option<&gateway_core::source_json::SourceJson>,
) -> Option<gateway_core::source_json::SourceJson> {
    crate::source_request::cache_metadata::merge_capabilities_source(previous, next)
}
pub fn concrete_scope_source(value: &gateway_core::source_json::SourceJson, cycles: i64) -> bool {
    crate::source_request::cache_metadata::concrete_scope_source(value, cycles)
}
pub fn normalize_capabilities(value: Option<&Value>) -> Option<Value> {
    let value = value.and_then(scalar_source);
    scalar_result(normalize_capabilities_source(value.as_ref()))
}
pub fn compact_capabilities(value: Option<&Value>) -> Option<Value> {
    let value = value.and_then(scalar_source);
    scalar_result(compact_capabilities_source(value.as_ref()))
}
pub fn normalize_scope(value: &Value) -> Option<Value> {
    scalar_result(normalize_scope_source(&scalar_source(value)?))
}
pub fn merge_capabilities(previous: Option<&Value>, next: Option<&Value>) -> Option<Value> {
    let previous = previous.and_then(scalar_source);
    let next = next.and_then(scalar_source);
    scalar_result(merge_capabilities_source(previous.as_ref(), next.as_ref()))
}
pub fn concrete_scope(value: &Value, cycles: i64) -> bool {
    scalar_source(value).is_some_and(|value| concrete_scope_source(&value, cycles))
}
pub fn validate_known_unsupported(
    model: &str,
    record: Option<&Value>,
    body: &Value,
    input: &[Value],
    input_key: &str,
) -> Result<(), GatewayError> {
    let body = gateway_core::source_json::SourceJson::from_serializable(body)?;
    let input = input
        .iter()
        .map(gateway_core::source_json::SourceJson::from_serializable)
        .collect::<Result<Vec<_>, _>>()?;
    let prompt_cache = record
        .and_then(|record| record.get("prompt_cache"))
        .map(gateway_core::source_json::SourceJson::from_serializable)
        .transpose()?;
    crate::source_request::validate_known_unsupported_prompt_cache(
        &gateway_core::js_string::JsString16::from_utf8(model),
        prompt_cache.as_ref(),
        &body,
        &input,
        input_key,
    )
    .map_err(crate::source_request::SourceRequestError::into_scalar)
}
