//! The existing lossless Claude selection, without a scalar transcript mirror.
use crate::{
    replay::{ReplayEntry, ReplayTransport},
    source as s, source_tools,
    types::*,
};
use gateway_core::{source_json::SourceJson, source_serialization as json};
fn eq(value: &SourceJson, literal: &str) -> bool {
    s::canonical(value).is_ok_and(|value| value.as_str() == literal)
}
fn only(value: &SourceJson, keys: &[&str]) -> bool {
    json::entries(value).is_some_and(|entries| {
        entries.iter().all(|(key, _)| {
            keys.iter()
                .any(|name| key.as_units().iter().copied().eq(name.encode_utf16()))
        })
    })
}
fn base(raw: &SourceJson) -> bool {
    s::string(&s::get(raw, "model")).is_some_and(|model| {
        crate::anthropic::is_claude_model(&gateway_core::model::ModelId::from_source(model))
    }) && s::present(raw, "store").is_none_or(|v| s::boolean(&v) == Some(false))
        && s::present(raw, "previous_response_id").is_none_or(|v| s::is_null(&v))
        && [
            "context_management",
            "max_tool_calls",
            "truncation",
            "metadata",
            "service_tier",
            "safety_identifier",
            "user",
        ]
        .iter()
        .all(|key| s::present(raw, key).is_none())
        && s::present(raw, "include").is_none_or(|value| {
            json::array(&value).is_some_and(|values| {
                values
                    .iter()
                    .all(|value| s::is(value, "reasoning.encrypted_content"))
            })
        })
}
fn cache(value: &SourceJson) -> Option<SourceJson> {
    (only(value, &["type", "ttl"])
        && s::is(&s::get(value, "type"), "ephemeral")
        && s::present(value, "ttl").is_none_or(|v| s::is(&v, "5m") || s::is(&v, "1h")))
    .then(|| value.clone())
}
fn block(mut block: SourceJson, source: &SourceJson) -> Option<SourceJson> {
    if let Some(marker) = s::present(source, "prompt_cache_breakpoint") {
        if !eq(&marker, r#"{"mode":"explicit"}"#) {
            return None;
        }
        s::set(
            &mut block,
            "cache_control",
            s::generated(&serde_json::json!({"type":"ephemeral"})),
        );
    }
    if let Some(control) = s::present(source, "cache_control") {
        s::set(&mut block, "cache_control", cache(&control)?);
    }
    Some(block)
}
fn policy(raw: &SourceJson) -> bool {
    s::present(raw, "prompt_cache_retention").is_none_or(|v| s::is(&v, "in_memory"))
        && s::present(raw, "prompt_cache_options").is_none_or(|v| {
            only(&v, &["mode"])
                && s::present(&v, "mode")
                    .is_none_or(|v| s::is(&v, "implicit") || s::is(&v, "explicit"))
        })
        && s::present(raw, "cache_control").is_none_or(|v| cache(&v).is_some())
}
fn count(value: &SourceJson) -> usize {
    if let Some(values) = json::array(value) {
        values.iter().map(count).sum()
    } else if let Some(fields) = json::entries(value) {
        usize::from(s::present(value, "cache_control").is_some())
            + fields
                .iter()
                .filter(|(key, _)| {
                    !["parameters", "input_schema"]
                        .iter()
                        .any(|name| key.as_units().iter().copied().eq(name.encode_utf16()))
                })
                .map(|(_, value)| count(value))
                .sum::<usize>()
    } else {
        0
    }
}
fn text(value: SourceJson) -> SourceJson {
    s::object(vec![("type", s::text("text")), ("text", value)])
}
fn content(value: &SourceJson, native: bool) -> Option<Vec<SourceJson>> {
    if s::string(value).is_some() {
        return Some(vec![text(value.clone())]);
    }
    let mut blocks = vec![];
    for part in json::array(value)? {
        let kind = s::control(&s::get(&part, "type"))?;
        let result = match kind.as_str() {
            "input_text" | "output_text" | "text" => {
                let value = s::get(&part, "text");
                s::string(&value)?;
                text(value)
            }
            "input_image" => {
                if s::present(&part, "file_id").is_some() {
                    return None;
                }
                let url = s::get(&part, "image_url");
                s::string(&url)?;
                if native {
                    if s::present(&part, "detail")
                        .is_some_and(|v| !s::is_null(&v) && !s::is(&v, "auto"))
                    {
                        return None;
                    }
                    let value = s::control(&url)?;
                    let source = if let Some(data) = value.strip_prefix("data:") {
                        let (kind, data) = data.split_once(";base64,")?;
                        if !["image/jpeg", "image/png", "image/gif", "image/webp"].contains(&kind) {
                            return None;
                        }
                        s::object(vec![
                            ("type", s::text("base64")),
                            ("media_type", s::text(kind)),
                            ("data", s::text(data)),
                        ])
                    } else if value.starts_with("https://") || value.starts_with("http://") {
                        s::object(vec![("type", s::text("url")), ("url", url)])
                    } else {
                        return None;
                    };
                    s::object(vec![("type", s::text("image")), ("source", source)])
                } else {
                    let mut reference = s::object(vec![("url", url)]);
                    if let Some(detail) = s::present(&part, "detail") {
                        s::set(&mut reference, "detail", detail);
                    }
                    s::object(vec![
                        ("type", s::text("image_url")),
                        ("image_url", reference),
                    ])
                }
            }
            _ => return None,
        };
        blocks.push(block(result, &part)?);
    }
    Some(blocks)
}
fn merge(messages: &mut Vec<SourceJson>, role: &str, blocks: Vec<SourceJson>) {
    if let Some(last) = messages
        .last_mut()
        .filter(|value| s::is(&s::get(value, "role"), role))
    {
        let mut old = json::array(&s::get(last, "content")).unwrap_or_default();
        old.extend(blocks);
        s::set(last, "content", s::array(&old));
    } else {
        messages.push(s::object(vec![
            ("role", s::text(role)),
            ("content", s::array(&blocks)),
        ]));
    }
}
fn valid_name(value: &SourceJson) -> bool {
    s::control(value).is_some_and(|name| {
        !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}
/// The native body algorithm cannot inspect auth material.
struct NativeBodyOptions<'a> {
    restored_native_messages: Option<&'a Vec<SourceJson>>,
    supports_native_effort: bool,
    supports_disabled_thinking: bool,
    native_reasoning_efforts: Option<&'a Vec<gateway_core::js_string::JsString16>>,
    catalog_max_output_tokens: Option<u64>,
}
impl<'a> From<&'a PrepareOptions> for NativeBodyOptions<'a> {
    fn from(options: &'a PrepareOptions) -> Self {
        Self {
            restored_native_messages: options.restored_native_messages.as_ref(),
            supports_native_effort: options.supports_native_effort,
            supports_disabled_thinking: options.supports_disabled_thinking,
            native_reasoning_efforts: options.native_reasoning_efforts.as_ref(),
            catalog_max_output_tokens: options.catalog_max_output_tokens,
        }
    }
}
fn native_messages(
    raw: &SourceJson,
    system: &mut Vec<SourceJson>,
    options: &NativeBodyOptions<'_>,
) -> Option<Vec<SourceJson>> {
    if let Some(restored) = &options.restored_native_messages {
        return restored_native_messages(restored, system);
    }
    let input = s::get(raw, "input");
    if s::string(&input).is_some() {
        return Some(vec![s::object(vec![
            ("role", s::text("user")),
            ("content", s::array(&[text(input)])),
        ])]);
    }
    let mut messages = vec![];
    for item in json::array(&input)? {
        append_native_item(&item, system, &mut messages)?;
    }
    (!messages.is_empty()).then_some(messages)
}
fn restored_native_messages(
    restored: &[SourceJson],
    system: &mut Vec<SourceJson>,
) -> Option<Vec<SourceJson>> {
    let mut messages = vec![];
    for item in restored {
        let role = s::control(&s::get(item, "role"))?;
        let blocks = json::array(&s::get(item, "content"))?;
        match role.as_str() {
            "system" | "developer" => system.extend(blocks),
            "user" | "assistant" => merge(&mut messages, &role, blocks),
            _ => return None,
        }
    }
    (!messages.is_empty()).then_some(messages)
}
fn append_native_item(
    item: &SourceJson,
    system: &mut Vec<SourceJson>,
    messages: &mut Vec<SourceJson>,
) -> Option<()> {
    let kind = s::control(&s::get(item, "type")).unwrap_or_else(|| "message".into());
    match kind.as_str() {
        "message" => {
            let role = s::control(&s::get(item, "role"))?;
            let blocks = content(&s::get(item, "content"), true)?;
            if role == "system" || role == "developer" {
                if blocks
                    .iter()
                    .any(|block| !s::is(&s::get(block, "type"), "text"))
                {
                    return None;
                }
                system.extend(blocks);
            } else if role == "user" || role == "assistant" {
                merge(messages, &role, blocks);
            } else {
                return None;
            }
        }
        "function_call" => {
            if s::present(item, "namespace").is_some_and(|v| !s::is_null(&v))
                || !valid_name(&s::get(item, "name"))
            {
                return None;
            }
            // This is the existing native protocol's JSON.parse operation, not an opaque Chat argument rewrite.
            let arguments = s::control(&s::get(item, "arguments"))?;
            let input = SourceJson::parse(&arguments).ok()?;
            json::entries(&input)?;
            let id = s::get(item, "call_id");
            s::string(&id)?;
            merge(
                messages,
                "assistant",
                vec![s::object(vec![
                    ("type", s::text("tool_use")),
                    ("id", id),
                    ("name", s::get(item, "name")),
                    ("input", input),
                ])],
            );
        }
        "function_call_output" => {
            let id = s::get(item, "call_id");
            s::string(&id)?;
            let mut result = s::object(vec![
                ("type", s::text("tool_result")),
                ("tool_use_id", id),
                (
                    "content",
                    s::array(&content(&s::get(item, "output"), true)?),
                ),
            ]);
            if let Some(value) = s::present(item, "is_error") {
                s::set(&mut result, "is_error", value);
            }
            merge(messages, "user", vec![result]);
        }
        _ => return None,
    }
    Some(())
}
fn native_tools(raw: &SourceJson) -> Option<Vec<SourceJson>> {
    let Some(value) = s::present(raw, "tools") else {
        return Some(vec![]);
    };
    let mut tools = vec![];
    for tool in json::array(&value)? {
        if !s::is(&s::get(&tool, "type"), "function")
            || s::present(&tool, "namespace").is_some()
            || !valid_name(&s::get(&tool, "name"))
        {
            return None;
        }
        let mut result = s::object(vec![
            ("name", s::get(&tool, "name")),
            (
                "input_schema",
                s::present(&tool, "parameters")
                    .unwrap_or_else(|| s::generated(&serde_json::json!({"type":"object"}))),
            ),
        ]);
        if let Some(value) = s::present(&tool, "description") {
            s::set(&mut result, "description", value);
        }
        tools.push(block(result, &tool)?);
    }
    Some(tools)
}
fn valid_reasoning(reasoning: &SourceJson) -> bool {
    only(reasoning, &["effort", "summary"])
        && s::present(reasoning, "summary").is_none_or(|v| {
            ["auto", "detailed", "none"]
                .iter()
                .any(|value| s::is(&v, value))
        })
}
fn native_reasoning(raw: &SourceJson, options: &NativeBodyOptions<'_>) -> Option<SourceJson> {
    let Some(reasoning) = s::present(raw, "reasoning").filter(|v| !s::is_null(v)) else {
        return Some(s::object(vec![]));
    };
    if !valid_reasoning(&reasoning) {
        return None;
    }
    let Some(effort) = s::present(&reasoning, "effort") else {
        return Some(s::object(vec![]));
    };
    if s::is(&effort, "none") {
        return options
            .supports_disabled_thinking
            .then(|| s::generated(&serde_json::json!({"thinking":{"type":"disabled"}})));
    }
    if !options.supports_native_effort {
        return None;
    }
    let effort = s::string(&effort)?;
    let effort = if effort.as_units().iter().copied().eq("ultra".encode_utf16())
        && options.native_reasoning_efforts.is_none()
    {
        gateway_core::js_string::JsString16::from_utf8("max")
    } else {
        effort
    };
    let allowed = options
        .native_reasoning_efforts
        .cloned()
        .unwrap_or_else(|| {
            ["low", "medium", "high", "xhigh", "max"]
                .map(gateway_core::js_string::JsString16::from_utf8)
                .to_vec()
        });
    allowed.contains(&effort).then(|| {
        s::object(vec![
            (
                "thinking",
                s::generated(&serde_json::json!({"type":"adaptive"})),
            ),
            (
                "output_config",
                s::object(vec![("effort", s::quoted(&effort))]),
            ),
        ])
    })
}

fn native_choice(raw: &SourceJson) -> Option<SourceJson> {
    let mut choice = match s::present(raw, "tool_choice") {
        None => s::object(vec![]),
        Some(value) if s::is(&value, "auto") || s::is(&value, "none") => {
            s::object(vec![("type", value)])
        }
        Some(value) if s::is(&value, "required") => s::object(vec![("type", s::text("any"))]),
        Some(value)
            if s::is(&s::get(&value, "type"), "function")
                && s::present(&value, "namespace").is_none()
                && valid_name(&s::get(&value, "name")) =>
        {
            s::object(vec![
                ("type", s::text("tool")),
                ("name", s::get(&value, "name")),
            ])
        }
        _ => return None,
    };
    if let Some(parallel) = s::present(raw, "parallel_tool_calls") {
        let parallel = s::boolean(&parallel)?;
        if s::present(&choice, "type").is_none() {
            s::set(&mut choice, "type", s::text("auto"));
        }
        s::set(
            &mut choice,
            "disable_parallel_tool_use",
            s::generated(&!parallel),
        );
    }
    Some(choice)
}
fn add_cache(body: &mut SourceJson, raw: &SourceJson, native: bool) -> Option<()> {
    let count = count(body);
    if count > 4 {
        return None;
    }
    if count == 0 && !s::is(&s::path(raw, &["prompt_cache_options", "mode"]), "explicit") {
        let control = s::present(raw, "cache_control")
            .unwrap_or_else(|| s::generated(&serde_json::json!({"type":"ephemeral"})));
        let mut messages = json::array(&s::get(body, "messages"))?;
        if let Some(last) = messages.last_mut()
            && let Some(mut blocks) =
                json::array(&s::get(last, "content")).filter(|blocks| !blocks.is_empty())
        {
            s::set(blocks.last_mut()?, "cache_control", control);
            s::set(last, "content", s::array(&blocks));
            s::set(body, "messages", s::array(&messages));
            return Some(());
        }
        if native {
            let mut system = json::array(&s::get(body, "system"))?;
            s::set(system.last_mut()?, "cache_control", control);
            s::set(body, "system", s::array(&system));
        } else {
            let mut tools = json::array(&s::get(body, "tools"))?;
            let last = tools.last_mut()?;
            let mut function = s::get(last, "function");
            s::set(&mut function, "cache_control", control);
            s::set(last, "function", function);
            s::set(body, "tools", s::array(&tools));
        }
    }
    Some(())
}
pub(crate) fn native(raw: &SourceJson, options: &PrepareOptions) -> Option<SourceJson> {
    native_body(raw, &NativeBodyOptions::from(options))
}
pub(crate) fn native_claude(raw: &SourceJson, options: &ClaudeBodyOptions) -> Option<SourceJson> {
    native_body(
        raw,
        &NativeBodyOptions {
            restored_native_messages: options.restored_native_messages.as_ref(),
            supports_native_effort: options
                .native_reasoning_efforts
                .as_ref()
                .is_some_and(|values| !values.is_empty()),
            supports_disabled_thinking: options.supports_disabled_thinking,
            native_reasoning_efforts: options.native_reasoning_efforts.as_ref(),
            catalog_max_output_tokens: Some(32_000),
        },
    )
}
fn native_body(raw: &SourceJson, options: &NativeBodyOptions<'_>) -> Option<SourceJson> {
    if !base(raw) || !policy(raw) {
        return None;
    }
    if let Some(text) = s::present(raw, "text")
        && (!only(&text, &["format"])
            || s::present(&text, "format").is_some_and(|value| !eq(&value, r#"{"type":"text"}"#)))
    {
        return None;
    }
    let max = s::present(raw, "max_output_tokens")
        .and_then(|value| json::number(&value))
        .filter(|v| *v >= 0.0 && v.fract() == 0.0)
        .map(|v| v as u64)
        .or(options.catalog_max_output_tokens)
        .or_else(|| s::is(&s::get(raw, "model"), "claude-opus-5-5").then_some(128_000))?;
    if max == 0 || max > 9_007_199_254_740_991 {
        return None;
    }
    let mut system = match s::present(raw, "instructions").filter(|v| !s::is_null(v)) {
        Some(value) => content(&value, true)?,
        None => vec![],
    };
    if system
        .iter()
        .any(|value| !s::is(&s::get(value, "type"), "text"))
    {
        return None;
    }
    let messages = native_messages(raw, &mut system, options)?;
    let tools = native_tools(raw)?;
    let choice = native_choice(raw)?;
    let reasoning = native_reasoning(raw, options)?;
    let mut body = s::object(vec![
        ("model", s::get(raw, "model")),
        ("max_tokens", s::generated(&max)),
        ("messages", s::array(&messages)),
        (
            "stream",
            s::generated(&(s::boolean(&s::get(raw, "stream")) == Some(true))),
        ),
    ]);
    if !system.is_empty() {
        s::set(&mut body, "system", s::array(&system));
    }
    if !tools.is_empty() {
        s::set(&mut body, "tools", s::array(&tools));
    }
    if !json::entries(&choice)?.is_empty() {
        s::set(&mut body, "tool_choice", choice);
    }
    for (key, value) in json::entries(&reasoning)? {
        s::set(&mut body, &key.try_utf8().ok()?, value);
    }
    for key in ["temperature", "top_p", "prompt_cache_key"] {
        if let Some(value) = s::present(raw, key) {
            s::set(&mut body, key, value);
        }
    }
    add_cache(&mut body, raw, true)?;
    Some(body)
}
fn chat_tool(tool: &SourceJson) -> bool {
    let valid = valid_name(&s::get(tool, "name"));
    match s::control(&s::get(tool, "type")).as_deref() {
        Some("function") => valid,
        Some("custom") => {
            valid && s::present(tool, "format").is_none_or(|value| eq(&value, r#"{"type":"text"}"#))
        }
        Some("namespace") => {
            valid
                && json::array(&s::get(tool, "tools")).is_some_and(|tools| {
                    tools.iter().all(|tool| {
                        s::is(&s::get(tool, "type"), "function")
                            && valid_name(&s::get(tool, "name"))
                    })
                })
        }
        _ => false,
    }
}
pub(crate) fn chat(
    raw: &SourceJson,
    options: &PrepareOptions,
) -> Option<crate::source_chat::Projection> {
    if !base(raw) || !policy(raw) {
        return None;
    }
    if let Some(tools) = s::present(raw, "tools")
        && json::array(&tools)?.iter().any(|tool| !chat_tool(tool))
    {
        return None;
    }
    let (tools, names) = source_tools::flatten(s::present(raw, "tools").as_ref(), 64).ok()?;
    let mut messages = vec![];
    if let Some(instructions) = s::present(raw, "instructions").filter(|v| !s::is_null(v)) {
        messages.push(s::object(vec![
            ("role", s::text("system")),
            ("content", s::array(&content(&instructions, false)?)),
        ]));
    }
    let input = s::get(raw, "input");
    if let Some(restored) = &options.restored_native_messages {
        messages.extend(restored.iter().cloned());
    } else if s::string(&input).is_some() {
        messages.push(s::object(vec![
            ("role", s::text("user")),
            ("content", s::array(&[text(input)])),
        ]));
    } else {
        for item in json::array(&input)? {
            append_chat_item(&item, &mut messages, &names)?;
        }
    }
    let stream = s::boolean(&s::get(raw, "stream")) == Some(true);
    let mut body = s::object(vec![
        ("model", s::get(raw, "model")),
        ("messages", s::array(&messages)),
        ("stream", s::generated(&stream)),
    ]);
    if stream {
        s::set(
            &mut body,
            "stream_options",
            s::generated(&serde_json::json!({"include_usage":true})),
        );
    }
    if !tools.is_empty() {
        s::set(&mut body, "tools", s::array(&tools));
    }
    if let Some(max) = s::present(raw, "max_output_tokens")
        .and_then(|value| json::number(&value))
        .filter(|v| *v >= 0.0 && v.fract() == 0.0)
        .map(|v| v as u64)
        .or(options.catalog_max_output_tokens)
    {
        if max == 0 {
            return None;
        }
        s::set(&mut body, "max_tokens", s::generated(&max));
    }
    if let Some(reasoning) = s::present(raw, "reasoning").filter(|v| !s::is_null(v)) {
        if !valid_reasoning(&reasoning) {
            return None;
        }
        if let Some(effort) = s::present(&reasoning, "effort") {
            if s::trim(&s::string(&effort)?).as_units().is_empty() {
                return None;
            }
            s::set(&mut body, "reasoning_effort", effort);
        }
    }
    if let Some(choice) =
        source_tools::choice(s::present(raw, "tool_choice").as_ref(), &names).ok()?
    {
        s::set(&mut body, "tool_choice", choice);
    }
    if let Some(format) = s::present(&s::get(raw, "text"), "format") {
        match s::control(&s::get(&format, "type")).as_deref()? {
            "text" => (),
            "json_object" => s::set(
                &mut body,
                "response_format",
                s::generated(&serde_json::json!({"type":"json_object"})),
            ),
            "json_schema" => {
                let mut schema = format;
                s::remove(&mut schema, "type");
                s::set(
                    &mut body,
                    "response_format",
                    s::object(vec![
                        ("type", s::text("json_schema")),
                        ("json_schema", schema),
                    ]),
                );
            }
            _ => return None,
        }
    }
    for key in [
        "parallel_tool_calls",
        "temperature",
        "top_p",
        "prompt_cache_key",
    ] {
        if let Some(value) = s::present(raw, key) {
            s::set(&mut body, key, value);
        }
    }
    add_cache(&mut body, raw, false)?;
    Some(crate::source_chat::Projection {
        body,
        names,
        elisions: vec![],
        warnings: vec![],
    })
}
fn append_chat_item(
    item: &SourceJson,
    messages: &mut Vec<SourceJson>,
    names: &crate::types::ToolMap,
) -> Option<()> {
    let kind = s::control(&s::get(item, "type")).unwrap_or_else(|| "message".into());
    match kind.as_str() {
        "message" => {
            let role = s::control(&s::get(item, "role"))?;
            messages.push(s::object(vec![
                (
                    "role",
                    s::text(if role == "developer" { "system" } else { &role }),
                ),
                (
                    "content",
                    s::array(&content(&s::get(item, "content"), false)?),
                ),
            ]));
        }
        "function_call" | "custom_tool_call" => {
            let name = s::string(&s::get(item, "name"))?;
            let namespace = s::string(&s::get(item, "namespace"));
            let projected = names
                .iter()
                .find(|(_, identity)| identity.name == name && identity.namespace == namespace)
                .map(|(wire, _)| wire.clone())
                .unwrap_or(name);
            let arguments = if kind == "custom_tool_call" {
                let input = s::get(item, "input");
                s::string(&input)?;
                s::text(
                    s::canonical(&s::object(vec![("input", input)]))
                        .ok()?
                        .as_str(),
                )
            } else {
                let value = s::get(item, "arguments");
                s::string(&value)?;
                value
            };
            let id = s::get(item, "call_id");
            s::string(&id)?;
            let call = s::object(vec![
                ("id", id),
                ("type", s::text("function")),
                (
                    "function",
                    s::object(vec![
                        ("name", s::quoted(&projected)),
                        ("arguments", arguments),
                    ]),
                ),
            ]);
            if let Some(previous) = messages.last_mut().filter(|value| {
                s::is(&s::get(value, "role"), "assistant")
                    && json::array(&s::get(value, "tool_calls")).is_some()
            }) {
                let mut calls = json::array(&s::get(previous, "tool_calls"))?;
                calls.push(call);
                s::set(previous, "tool_calls", s::array(&calls));
            } else {
                messages.push(s::object(vec![
                    ("role", s::text("assistant")),
                    ("content", s::null()),
                    ("tool_calls", s::array(&[call])),
                ]));
            }
        }
        "function_call_output" | "custom_tool_call_output" => {
            let id = s::get(item, "call_id");
            s::string(&id)?;
            messages.push(s::object(vec![
                ("role", s::text("tool")),
                ("tool_call_id", id),
                (
                    "content",
                    s::array(&content(&s::get(item, "output"), false)?),
                ),
            ]));
        }
        _ => return None,
    }
    Some(())
}
pub(crate) fn replay_messages(
    raw: &SourceJson,
    transport: ReplayTransport,
    entries: &[ReplayEntry],
) -> Option<Vec<SourceJson>> {
    let (_, names) = source_tools::flatten(s::present(raw, "tools").as_ref(), 64).ok()?;
    let mut messages = vec![];
    match transport {
        ReplayTransport::Messages => {
            let mut system = vec![];
            for entry in entries {
                match entry {
                    ReplayEntry::Original(item) => {
                        let item = item.clone();
                        let role = s::control(&s::get(&item, "role")).unwrap_or_default();
                        if ["system", "developer"].contains(&role.as_str()) && !messages.is_empty()
                        {
                            return None;
                        }
                        append_native_item(&item, &mut system, &mut messages)?;
                    }
                    ReplayEntry::NativeAssistant {
                        transport: ReplayTransport::Messages,
                        payload,
                    } => {
                        let blocks = if let Some(blocks) = json::array(payload) {
                            blocks
                        } else if json::entries(payload).is_some() {
                            json::array(&s::get(payload, "content"))?
                        } else {
                            return None;
                        };
                        merge(&mut messages, "assistant", blocks);
                    }
                    ReplayEntry::NativeAssistant { .. } => return None,
                }
            }
            if !system.is_empty() {
                messages.insert(
                    0,
                    s::object(vec![
                        ("role", s::text("system")),
                        ("content", s::array(&system)),
                    ]),
                );
            }
        }
        ReplayTransport::Chat => {
            for entry in entries {
                match entry {
                    ReplayEntry::Original(item) => {
                        append_chat_item(item, &mut messages, &names)?;
                    }
                    ReplayEntry::NativeAssistant {
                        transport: ReplayTransport::Chat,
                        payload,
                    } if s::is(&s::get(payload, "role"), "assistant") => {
                        messages.push(payload.clone());
                    }
                    ReplayEntry::NativeAssistant { .. } => return None,
                }
            }
        }
    }
    if messages.is_empty() {
        return None;
    }
    Some(messages)
}
