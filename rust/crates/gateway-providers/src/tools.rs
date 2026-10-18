//! Reversible function/namespace/freeform projection from the frozen Chat-only adapters.
use crate::types::{ToolIdentity, ToolMap, invalid};
use gateway_core::GatewayError;
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub fn flatten_tools(
    value: Option<&Value>,
    limit: usize,
) -> Result<(Vec<Value>, ToolMap), GatewayError> {
    let mut tools = vec![];
    let mut names = ToolMap::new();
    let mut used = BTreeSet::new();
    let Some(value) = value else {
        return Ok((tools, names));
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid("tools must be an array", "tools"))?;
    for tool in values {
        if !tool.is_object() {
            return Err(invalid("tools must contain objects", "tools"));
        }
        if tool["type"] == "namespace" {
            let nested = tool["tools"]
                .as_array()
                .ok_or_else(|| invalid("namespace tools must nest a tools array", "tools.tools"))?;
            for entry in nested {
                if !entry.is_object() {
                    return Err(invalid(
                        "namespace tools must contain objects",
                        "tools.tools",
                    ));
                }
                if entry["type"] == "function" {
                    collect_tool(
                        entry,
                        tool["name"].as_str(),
                        limit,
                        &mut tools,
                        &mut names,
                        &mut used,
                    )?;
                }
            }
        } else {
            collect_tool(tool, None, limit, &mut tools, &mut names, &mut used)?;
        }
    }
    Ok((tools, names))
}
fn collect_tool(
    tool: &Value,
    namespace: Option<&str>,
    limit: usize,
    tools: &mut Vec<Value>,
    names: &mut ToolMap,
    used: &mut BTreeSet<String>,
) -> Result<(), GatewayError> {
    let custom = tool["type"] == "custom";
    let nested = tool.get("function").filter(|v| v.is_object());
    if !custom && nested.is_none() && tool["type"] != "function" {
        return Ok(());
    }
    let function = nested.unwrap_or(tool);
    let name = function["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            invalid(
                if custom {
                    "custom tools require a name"
                } else {
                    "function tools require a name"
                },
                "tools.name",
            )
        })?;
    let preferred = if used.contains(name) && namespace.is_some() {
        format!("{}_{}", namespace.unwrap_or(""), name)
    } else {
        name.to_owned()
    };
    let mut projected: String = preferred.chars().take(limit).collect();
    let mut suffix = 2;
    while used.contains(&projected) {
        let ending = format!("_{suffix}");
        projected = format!(
            "{}{}",
            preferred
                .chars()
                .take(limit.saturating_sub(ending.len()))
                .collect::<String>(),
            ending
        );
        suffix += 1;
    }
    used.insert(projected.clone());
    names.insert(
        projected.clone(),
        ToolIdentity {
            name: name.into(),
            namespace: namespace.map(str::to_owned),
            custom,
        },
    );
    let mut function_body = json!({"name":projected});
    if let Some(description) = function.get("description").filter(|v| v.is_string()) {
        function_body["description"] = description.clone();
    }
    if custom {
        function_body["parameters"] = json!({"type":"object","properties":{"input":{"type":"string","description":"Freeform input for the tool."}},"required":["input"],"additionalProperties":false});
    } else {
        if let Some(parameters) = function.get("parameters") {
            function_body["parameters"] = parameters.clone();
        }
        if let Some(strict) = function.get("strict").filter(|v| v.is_boolean()) {
            function_body["strict"] = strict.clone();
        }
    }
    tools.push(json!({"type":"function","function":function_body}));
    Ok(())
}
pub fn project_tool_choice(
    value: Option<&Value>,
    names: &ToolMap,
) -> Result<Option<Value>, GatewayError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    if let Some(choice) = value.as_str() {
        return if ["none", "auto", "required"].contains(&choice) {
            Ok(Some(value.clone()))
        } else {
            Err(invalid(
                format!("tool_choice '{choice}' is not supported"),
                "tool_choice",
            ))
        };
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| value.get("function").and_then(|f| f.get("name")).and_then(Value::as_str))
        .filter(|name| !name.is_empty())
        .ok_or_else(|| invalid("a named tool_choice requires a name", "tool_choice.name"))?;
    let namespace = if value.get("namespace").is_some() { value.get("namespace").and_then(Value::as_str) } else { value.get("function").and_then(|f| f.get("namespace")).and_then(Value::as_str) };
    let projected = names
        .iter()
        .find(|(_, item)| {
            item.name == name && item.namespace.as_deref() == namespace
        })
        .map(|(wire, _)| wire.as_str())
        .unwrap_or_else(|| if namespace.is_none() { names.get(name).map(|item|item.name.as_str()).unwrap_or(name) } else { name });
    Ok(Some(
        json!({"type":"function","function":{"name":projected}}),
    ))
}
pub fn original<'a>(wire: &'a str, names: &'a ToolMap) -> ToolIdentity {
    names.get(wire).cloned().unwrap_or_else(|| ToolIdentity {
        name: wire.into(),
        namespace: None,
        custom: false,
    })
}
pub fn custom_input(arguments: &str) -> String {
    serde_json::from_str::<Value>(arguments)
        .ok()
        .and_then(|v| v.get("input").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| arguments.into())
}
pub fn function_item(
    id: &str,
    call_id: &str,
    wire_name: &str,
    arguments: &str,
    names: &ToolMap,
    status: &str,
) -> Value {
    let identity = original(wire_name, names);
    let mut item = json!({"id":id,"type":if identity.custom{"custom_tool_call"}else{"function_call"},"status":status,"call_id":call_id,"name":identity.name});
    if identity.custom {
        item["input"] = Value::String(custom_input(arguments));
    } else {
        item["arguments"] = Value::String(arguments.into());
        if let Some(namespace) = identity.namespace {
            item["namespace"] = Value::String(namespace);
        }
    }
    item
}
