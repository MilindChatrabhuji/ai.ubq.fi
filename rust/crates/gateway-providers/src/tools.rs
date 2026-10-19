//! Reversible source-unit function/namespace/freeform projection.
use crate::types::{ToolIdentity, ToolMap};
use gateway_core::{GatewayError, source_json::SourceJson};
use serde_json::Value;
pub fn flatten_tools(
    value: Option<&Value>,
    limit: usize,
) -> Result<(Vec<SourceJson>, ToolMap), GatewayError> {
    crate::source_tools::flatten(value.map(crate::source::generated).as_ref(), limit)
        .map_err(crate::source::scalar_error)
}
pub fn project_tool_choice(
    value: Option<&Value>,
    names: &ToolMap,
) -> Result<Option<SourceJson>, GatewayError> {
    crate::source_tools::choice(value.map(crate::source::generated).as_ref(), names)
        .map_err(crate::source::scalar_error)
}
pub fn original<'a>(wire: &'a str, names: &'a ToolMap) -> ToolIdentity {
    names.get(wire).cloned().unwrap_or_else(|| ToolIdentity {
        name: wire.into(),
        namespace: None,
        custom: false,
    })
}
pub fn custom_input(arguments: &str) -> gateway_core::js_string::JsString16 {
    SourceJson::parse(arguments)
        .ok()
        .and_then(|value| gateway_core::source_serialization::member(&value, "input"))
        .and_then(|value| gateway_core::source_serialization::string(&value))
        .unwrap_or_else(|| gateway_core::js_string::JsString16::from_utf8(arguments))
}
pub fn function_item(
    id: &str,
    call_id: &str,
    wire_name: &str,
    arguments: &str,
    names: &ToolMap,
    status: &str,
) -> SourceJson {
    use crate::source as s;
    let identity = original(wire_name, names);
    let mut item = s::object(vec![
        ("id", s::text(id)),
        (
            "type",
            s::text(if identity.custom {
                "custom_tool_call"
            } else {
                "function_call"
            }),
        ),
        ("status", s::text(status)),
        ("call_id", s::text(call_id)),
        ("name", s::quoted(&identity.name)),
    ]);
    if identity.custom {
        s::set(&mut item, "input", s::quoted(&custom_input(arguments)));
    } else {
        s::set(&mut item, "arguments", s::text(arguments));
        if let Some(namespace) = identity.namespace {
            s::set(&mut item, "namespace", s::quoted(&namespace));
        }
    }
    item
}
