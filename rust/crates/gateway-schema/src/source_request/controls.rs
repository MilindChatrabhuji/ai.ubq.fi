//! Request controls share the same source string view as content validation.
use super::{
    SourceRequestError,
    value::{Value, json, keyed_error, unknown_key},
};
fn invalid(message: impl AsRef<str>, param: Option<&str>) -> SourceRequestError {
    SourceRequestError::scalar(message.as_ref(), param)
}
pub(super) fn normalize_breakpoint(
    value: Option<&Value>,
    param: &str,
) -> Result<Option<Value>, SourceRequestError> {
    let Some(value) = value else { return Ok(None) };
    if !value.is_object() {
        return Err(invalid(format!("{param} must be an object"), Some(param)));
    }
    if let Some(key) = unknown_key(value, &["mode"]) {
        return Err(keyed_error(
            "Unknown cache breakpoint field: ",
            &key,
            Some(&format!("{param}.")),
        ));
    }
    if value.get("mode").and_then(Value::as_str) != Some("explicit") {
        return Err(invalid(
            format!("{param}.mode must be explicit"),
            Some(&format!("{param}.mode")),
        ));
    }
    Ok(Some(json!({"mode":"explicit"})))
}
