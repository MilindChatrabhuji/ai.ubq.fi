//! Existing finite provider body/control transformations over source JSON.
use crate::{source as s, types::*};
use gateway_core::{
    js_string::JsString16, model::ModelId, source_json::SourceJson, source_serialization as json,
};
use gateway_schema::source_request::{SourceField, SourceRequestDocument};
use std::collections::{BTreeMap, BTreeSet};
pub(crate) fn replay(input: &SourceJson) -> SourceJson {
    let Some(items) = json::array(input) else {
        return input.clone();
    };
    s::array(
        &items
            .into_iter()
            .filter_map(|mut item| {
                let Some(id) = s::control(&s::get(&item, "id"))
                    .filter(|id| crate::request::codex_synthetic_id(id))
                else {
                    return Some(item);
                };
                let _ = id;
                if s::is(&s::get(&item, "type"), "reasoning")
                    && s::string(&s::get(&item, "encrypted_content"))
                        .is_none_or(|value| value.as_units().is_empty())
                {
                    return None;
                }
                if json::entries(&item).is_some() {
                    s::remove(&mut item, "id");
                }
                Some(item)
            })
            .collect::<Vec<_>>(),
    )
}
pub(crate) fn codex(raw: &SourceJson) -> s::Result<SourceJson> {
    let model = s::present(raw, "model")
        .filter(|value| s::string(value).is_some())
        .ok_or_else(|| s::invalid(JsString16::from_utf8("model must be a string"), "model"))?;
    let input = s::present(raw, "input")
        .ok_or_else(|| s::invalid(JsString16::from_utf8("input is required"), "input"))?;
    let mut body = s::object(vec![
        ("model", model),
        ("input", replay(&input)),
        ("stream", s::generated(&true)),
        ("store", s::generated(&false)),
    ]);
    for key in [
        "instructions",
        "reasoning",
        "max_output_tokens",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "prompt_cache_key",
        "prompt_cache_options",
        "prompt_cache_retention",
        "text",
        "include",
        "context_management",
    ] {
        if let Some(value) = s::present(raw, key) {
            s::set(&mut body, key, value);
        }
    }
    ultra(&mut body);
    if let Some(mut tools) = json::array(&s::get(&body, "tools")) {
        for tool in &mut tools {
            let function = s::get(tool, "function");
            if s::is(&s::get(tool, "type"), "function") && json::entries(&function).is_some() {
                let mut function = function;
                s::set(&mut function, "type", s::text("function"));
                *tool = function;
            }
        }
        s::set(&mut body, "tools", s::array(&tools));
    }
    let choice = s::get(&body, "tool_choice");
    if s::is(&s::get(&choice, "type"), "function")
        && json::entries(&s::get(&choice, "function")).is_some()
    {
        s::set(
            &mut body,
            "tool_choice",
            s::object(vec![
                ("type", s::text("function")),
                ("name", s::path(&choice, &["function", "name"])),
            ]),
        );
    }
    Ok(body)
}
/// One ordinary phase coordinator; direct/OpenRouter branches never enter it.
pub(crate) fn ordinary(
    raw: &SourceJson,
    surface: ClientSurface,
    model: &ModelId,
    context: Option<&OrdinaryPreparationContext>,
) -> s::Result<SourceJson> {
    let document = SourceRequestDocument::new(raw.clone())?;
    let model_raw = match document.model_request()? {
        gateway_schema::source_request::SourceModelRequest::Default => model.as_js_string().clone(),
        gateway_schema::source_request::SourceModelRequest::Named(name) => name,
    };
    let mut body = if surface == ClientSurface::Chat {
        let view = document.for_surface(gateway_schema::request::RequestSurface::ChatCompletions);
        let messages = s::get(raw, "messages");
        let messages = json::array(&messages).ok_or_else(|| {
            gateway_schema::source_request::SourceRequestError::new(
                400,
                "messages must be an array",
                "invalid_request_error",
                Some("invalid_request_error"),
                None,
            )
        })?;
        if messages.is_empty() {
            return Err(gateway_schema::source_request::SourceRequestError::new(
                400,
                "messages must be a non-empty array",
                "invalid_request_error",
                Some("invalid_request_error"),
                None,
            ));
        }
        // Chat effort syntax and stream options precede content conversion; metadata mapping does not.
        let effort = view.reasoning_effort()?;
        let stream = view.stream()?;
        view.chat_stream_options()?;
        let normalized = document.normalize_chat_for_codex()?;
        validate_cache(context, &model_raw, raw, &normalized.input, "messages")?;
        let mut body = s::object(vec![
            ("model", s::quoted(model.as_js_string())),
            ("input", s::array(&normalized.input)),
            ("stream", s::generated(&stream)),
            ("store", s::generated(&false)),
        ]);
        if let Some(instructions) = normalized.instructions {
            s::set(&mut body, "instructions", s::quoted(&instructions));
        }
        for key in [
            "tools",
            "tool_choice",
            "parallel_tool_calls",
            "prompt_cache_key",
            "prompt_cache_options",
            "prompt_cache_retention",
        ] {
            if let Some(value) = s::present(raw, key) {
                s::set(&mut body, key, value);
            }
        }
        let effort = effort.or_else(|| context.map(|context| context.default_effort().clone()));
        if let Some(effort) = effort {
            s::set(
                &mut body,
                "reasoning",
                s::object(vec![("effort", map_effort(&effort, context))]),
            );
        }
        if let Some(max) =
            s::present(raw, "max_completion_tokens").filter(|value| !s::is_null(value))
        {
            s::set(&mut body, "max_output_tokens", max);
        }
        if s::canonical(&s::get(raw, "response_format"))?.as_str() == r#"{"type":"json_object"}"# {
            s::set(
                &mut body,
                "text",
                s::generated(&serde_json::json!({"format":{"type":"json_object"}})),
            );
        }
        body
    } else {
        let input = document.normalize_responses_input()?;
        validate_cache(context, &model_raw, raw, &input, "input")?;
        let reasoning = document.reasoning()?;
        let instructions = document.instructions()?;
        // Both syntax phases finish before selected-model effort mapping/default injection.
        let reasoning = match reasoning {
            Some(mut value) => {
                if let Some(effort) = s::string(&s::get(&value, "effort")) {
                    s::set(&mut value, "effort", map_effort(&effort, context));
                }
                Some(value)
            }
            None => context.map(|context| {
                s::object(vec![(
                    "effort",
                    map_effort(&context.default_effort().clone(), Some(context)),
                )])
            }),
        };
        let mut body = raw.clone();
        s::set(&mut body, "input", s::array(&input));
        if let Some(value) = reasoning {
            s::set(&mut body, "reasoning", value);
        } else {
            s::remove(&mut body, "reasoning");
        }
        match instructions {
            SourceField::Missing => (),
            SourceField::Null => s::remove(&mut body, "instructions"),
            SourceField::Value(text) => s::set(&mut body, "instructions", s::quoted(&text)),
        }
        body
    };
    s::set(&mut body, "model", s::quoted(model.as_js_string()));
    Ok(body)
}
fn map_effort(effort: &JsString16, context: Option<&OrdinaryPreparationContext>) -> SourceJson {
    s::quoted(&context.map_or_else(
        || effort.clone(),
        |context| gateway_schema::reasoning::effort_for_codex(effort, context.reasoning()),
    ))
}
fn validate_cache(
    context: Option<&OrdinaryPreparationContext>,
    model: &JsString16,
    raw: &SourceJson,
    input: &[SourceJson],
    input_key: &str,
) -> s::Result<()> {
    if let Some(context) = context {
        gateway_schema::source_request::validate_known_unsupported_prompt_cache(
            model,
            context.prompt_cache(),
            raw,
            input,
            input_key,
        )?;
    }
    Ok(())
}
pub(crate) fn ultra(body: &mut SourceJson) {
    let mut reasoning = s::get(body, "reasoning");
    if s::is(&s::get(&reasoning, "effort"), "ultra") {
        s::set(&mut reasoning, "effort", s::text("max"));
        s::set(body, "reasoning", reasoning);
    }
}
pub(crate) fn roles(body: &mut SourceJson, field: &str, remove_reasoning: bool) {
    if let Some(mut messages) = json::array(&s::get(body, field)) {
        for message in &mut messages {
            if s::is(&s::get(message, "role"), "developer") {
                s::set(message, "role", s::text("system"));
            }
            if remove_reasoning && s::is(&s::get(message, "role"), "assistant") {
                s::remove(message, "reasoning_content");
            }
        }
        s::set(body, field, s::array(&messages));
    }
}
pub(crate) fn openrouter(body: &mut SourceJson, model: &ModelId) {
    if (s::starts(model.as_js_string(), "openai/") || s::starts(model.as_js_string(), "~openai/"))
        && !model
            .as_js_string()
            .as_units()
            .split(|&unit| unit == 58)
            .any(|part| part.iter().copied().eq("batch".encode_utf16()))
        && s::present(body, "tool_choice").is_none_or(|v| s::is(&v, "auto"))
        && s::present(body, "functions").is_none()
        && s::present(body, "function_call").is_none()
        && s::present(body, "tools").is_none_or(|v| json::array(&v).is_some_and(|a| !a.is_empty()))
    {
        let mut tools = json::array(&s::get(body, "tools")).unwrap_or_default();
        for kind in ["web_search", "web_fetch"] {
            if !tools.iter().any(|tool| {
                s::control(&s::get(tool, "type")).is_some_and(|name| {
                    name == kind
                        || name == format!("openrouter:{kind}")
                        || name.starts_with(&format!("{kind}_"))
                })
            }) {
                tools.push(s::object(vec![(
                    "type",
                    s::text(&format!("openrouter:{kind}")),
                )]));
            }
        }
        s::set(body, "tools", s::array(&tools));
    }
    if (s::starts(model.as_js_string(), "anthropic/claude-")
        || s::starts(model.as_js_string(), "~anthropic/claude-"))
        && s::present(body, "cache_control").is_none()
        && !s::is(
            &s::path(body, &["prompt_cache_options", "mode"]),
            "explicit",
        )
        && !cache_block(body)
    {
        s::set(
            body,
            "cache_control",
            s::generated(&serde_json::json!({"type":"ephemeral"})),
        );
    }
}
fn cache_block(value: &SourceJson) -> bool {
    if let Some(array) = json::array(value) {
        array.iter().any(cache_block)
    } else if let Some(fields) = json::entries(value) {
        s::present(value, "cache_control").is_some()
            || s::present(value, "prompt_cache_breakpoint").is_some()
            || fields
                .iter()
                .filter(|(key, _)| {
                    [
                        "instructions",
                        "input",
                        "messages",
                        "tools",
                        "content",
                        "output",
                        "function",
                    ]
                    .iter()
                    .any(|name| key.as_units().iter().copied().eq(name.encode_utf16()))
                })
                .any(|(_, value)| cache_block(value))
    } else {
        false
    }
}
pub(crate) fn strip_codex(body: &mut SourceJson, warnings: &mut Vec<String>) {
    for (field, warning) in [
        ("prompt_cache_options", "prompt_cache_options_ignored"),
        ("prompt_cache_retention", "prompt_cache_retention_ignored"),
        ("max_output_tokens", "max_output_tokens_ignored"),
        ("max_completion_tokens", "max_output_tokens_ignored"),
    ] {
        if s::present(body, field).is_some() {
            s::remove(body, field);
            if !warnings.iter().any(|v| v == warning) {
                warnings.push(warning.into());
            }
        }
    }
    fn strip(value: &mut SourceJson) -> bool {
        let mut removed = false;
        if let Some(mut array) = json::array(value) {
            for value in &mut array {
                removed = strip(value) || removed;
            }
            *value = s::array(&array);
        } else if json::entries(value).is_some() {
            removed = s::present(value, "prompt_cache_breakpoint").is_some();
            s::remove(value, "prompt_cache_breakpoint");
            for key in ["content", "output"] {
                if let Some(mut child) = s::present(value, key) {
                    removed = strip(&mut child) || removed;
                    s::set(value, key, child);
                }
            }
        }
        removed
    }
    if let Some(mut input) = s::present(body, "input") {
        if strip(&mut input) {
            warnings.push("prompt_cache_breakpoint_ignored".into());
        }
        s::set(body, "input", input);
    }
}
fn schema(value: &SourceJson, properties: bool) -> SourceJson {
    if let Some(values) = json::array(value) {
        return s::array(&values.iter().map(|v| schema(v, false)).collect::<Vec<_>>());
    }
    let Some(fields) = json::entries(value) else {
        return value.clone();
    };
    let mut result = vec![];
    for (key, value) in fields {
        let scalar = key.try_utf8().ok();
        if !properties
            && scalar.as_deref().is_some_and(|key| {
                [
                    "format",
                    "maxItems",
                    "maxLength",
                    "maxProperties",
                    "minItems",
                    "minLength",
                    "minProperties",
                    "pattern",
                    "uniqueItems",
                ]
                .contains(&key)
            })
        {
            continue;
        }
        if !properties && scalar.as_deref() == Some("const") {
            result.push((
                JsString16::from_utf8("enum"),
                s::array(&[schema(&value, false)]),
            ));
        } else {
            result.push((
                if !properties && scalar.as_deref() == Some("oneOf") {
                    JsString16::from_utf8("anyOf")
                } else {
                    key
                },
                schema(&value, scalar.as_deref() == Some("properties")),
            ));
        }
    }
    s::object_keys(result)
}
pub(crate) fn cerebras_schema(value: &SourceJson) -> SourceJson {
    let projected = schema(value, false);
    if s::is(&s::get(&projected, "type"), "object") {
        return projected;
    }
    let Some(variants) = json::array(&s::get(&projected, "anyOf")).filter(|a| {
        !a.is_empty()
            && a.iter().all(|v| {
                s::is(&s::get(v, "type"), "object")
                    && json::entries(&s::get(v, "properties")).is_some()
            })
    }) else {
        return projected;
    };
    let mut properties: BTreeMap<JsString16, SourceJson> = BTreeMap::new();
    let mut required: Option<BTreeSet<JsString16>> = None;
    for variant in variants {
        for (name, value) in json::entries(&s::get(&variant, "properties")).unwrap_or_default() {
            if let Some(old) = properties.get(&name).cloned() {
                if old != value {
                    if name
                        .as_units()
                        .iter()
                        .copied()
                        .eq("operationId".encode_utf16())
                        && json::array(&s::get(&old, "enum")).is_some()
                        && json::array(&s::get(&value, "enum")).is_some()
                    {
                        let mut values = json::array(&s::get(&old, "enum")).unwrap_or_default();
                        for value in json::array(&s::get(&value, "enum")).unwrap_or_default() {
                            if !values.contains(&value) {
                                values.push(value);
                            }
                        }
                        properties.insert(name, s::object(vec![("enum", s::array(&values))]));
                    } else {
                        let mut choices =
                            json::array(&s::get(&old, "anyOf")).unwrap_or_else(|| vec![old]);
                        if !choices.contains(&value) {
                            choices.push(value);
                        }
                        properties.insert(name, s::object(vec![("anyOf", s::array(&choices))]));
                    }
                }
            } else {
                properties.insert(name, value);
            }
        }
        let row = json::array(&s::get(&variant, "required"))
            .unwrap_or_default()
            .iter()
            .filter_map(s::string)
            .collect::<BTreeSet<_>>();
        required = Some(required.map_or_else(
            || row.clone(),
            |old| old.intersection(&row).cloned().collect(),
        ));
    }
    s::object(vec![
        ("type", s::text("object")),
        (
            "properties",
            s::object_keys(properties.into_iter().collect()),
        ),
        (
            "required",
            s::array(
                &required
                    .unwrap_or_default()
                    .iter()
                    .map(s::quoted)
                    .collect::<Vec<_>>(),
            ),
        ),
        ("additionalProperties", s::generated(&false)),
    ])
}
pub(crate) fn cerebras(body: &mut SourceJson) -> s::Result<()> {
    roles(body, "messages", true);
    if let Some(messages) = json::array(&s::get(body, "messages")) {
        let mut system = vec![];
        let mut kept = vec![];
        for message in messages {
            if s::is(&s::get(&message, "role"), "system") {
                let content = s::get(&message, "content");
                if let Some(text) = s::string(&content) {
                    system.push(text);
                } else if let Some(parts) = json::array(&content) {
                    let mut text = vec![];
                    for part in parts {
                        if !s::is(&s::get(&part, "type"), "text")
                            || s::string(&s::get(&part, "text")).is_none()
                        {
                            return Err(s::invalid(
                                JsString16::from_utf8(
                                    "Cerebras supports only text content in system and developer messages.",
                                ),
                                "messages",
                            ));
                        }
                        text.push(s::string(&s::get(&part, "text")).unwrap_or_default());
                    }
                    system.push(s::join(&text, ""));
                } else {
                    return Err(s::invalid(
                        JsString16::from_utf8(
                            "Cerebras supports only text content in system and developer messages.",
                        ),
                        "messages",
                    ));
                }
            } else {
                kept.push(message);
            }
        }
        if !system.is_empty() {
            kept.insert(
                0,
                s::object(vec![
                    ("role", s::text("system")),
                    ("content", s::quoted(&s::join(&system, "\n\n"))),
                ]),
            );
        }
        s::set(body, "messages", s::array(&kept));
    }
    if let Some(mut tools) = json::array(&s::get(body, "tools")) {
        for tool in &mut tools {
            let mut function = s::get(tool, "function");
            if let Some(parameters) = s::present(&function, "parameters") {
                s::set(&mut function, "parameters", cerebras_schema(&parameters));
                s::set(tool, "function", function);
            }
        }
        s::set(body, "tools", s::array(&tools));
    }
    Ok(())
}
pub(crate) fn claude_transport(body: &mut SourceJson, kind: ClaudeCredentialKind) {
    s::remove(body, "prompt_cache_key");
    if kind == ClaudeCredentialKind::Oauth {
        let mut system = vec![s::generated(
            &serde_json::json!({"type":"text","text":crate::finalize::CLAUDE_ATTRIBUTION}),
        )];
        system.extend(json::array(&s::get(body, "system")).unwrap_or_default());
        s::set(body, "system", s::array(&system));
    }
}
