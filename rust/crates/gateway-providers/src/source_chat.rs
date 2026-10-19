//! Provider-owned Responses-to-Chat phases over immutable source fragments.
use crate::{
    chat::{FORWARD_LIMIT, FORWARD_VERSION, bound_source},
    source as s, source_tools,
    types::*,
};
use gateway_core::{
    js_string::JsString16, model::ModelId, source_json::SourceJson, source_serialization as json,
};

pub(crate) struct Projection {
    pub body: SourceJson,
    pub names: ToolMap,
    pub elisions: Vec<Elision>,
    pub warnings: Vec<String>,
}
fn error(message: &str, param: &str) -> gateway_schema::source_request::SourceRequestError {
    s::invalid(JsString16::from_utf8(message), param)
}
fn bytes(text: &JsString16) -> usize {
    char::decode_utf16(text.as_units().iter().copied())
        .map(|v| v.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
        .sum()
}
fn bound(
    text: &JsString16,
    path: &str,
    id: Option<&JsString16>,
    kind: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
) -> s::Result<SourceJson> {
    bound_source(text, path, id, kind, reject, elisions).map(|text| s::quoted(&text))
}
fn content(
    value: &SourceJson,
    role: &str,
    path: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
) -> s::Result<SourceJson> {
    if let Some(text) = s::string(value) {
        return bound(&text, path, None, "message", reject, elisions);
    }
    let parts = json::array(value).ok_or_else(|| {
        error(
            "input.content must be a string or an array",
            "input.content",
        )
    })?;
    let mut texts = vec![];
    let mut images = vec![];
    for (index, part) in parts.iter().enumerate() {
        if json::entries(part).is_none() {
            return Err(error(
                "input.content items must be objects",
                "input.content",
            ));
        }
        let kind = s::get(part, "type");
        if ["text", "input_text", "output_text"]
            .iter()
            .any(|kind_name| s::is(&kind, kind_name))
        {
            texts.push(s::string(&s::get(part, "text")).ok_or_else(|| {
                error("input.content text must be a string", "input.content.text")
            })?);
        } else if role == "assistant" && s::is(&kind, "refusal") {
            texts.push(s::string(&s::get(part, "refusal")).ok_or_else(|| {
                error(
                    "input.content refusal must be a string",
                    "input.content.refusal",
                )
            })?);
        } else if s::is(&kind, "input_image") {
            let url = s::string(&s::get(part, "image_url"))
                .or_else(|| s::string(&s::get(part, "file_url")))
                .filter(|value| !value.as_units().is_empty())
                .ok_or_else(|| {
                    error("input_image requires image_url", "input.content.image_url")
                })?;
            let size = bytes(&url);
            if size > FORWARD_LIMIT {
                if reject {
                    return Err(crate::chat::oversized(
                        &format!("{path}[{index}]"),
                        size,
                        None,
                    ));
                }
                omit_image(&url, &format!("{path}[{index}]"), &mut texts, elisions);
            } else {
                let mut reference = s::object(vec![("url", s::quoted(&url))]);
                if let Some(detail) = s::present(part, "detail").filter(|value| {
                    s::string(value).is_some_and(|value| !value.as_units().is_empty())
                }) {
                    s::set(&mut reference, "detail", detail);
                }
                images.push(s::object(vec![
                    ("type", s::text("image_url")),
                    ("image_url", reference),
                ]));
            }
        } else {
            let name = s::string(&kind).unwrap_or_else(|| JsString16::from_utf8("unknown"));
            return Err(s::invalid(
                s::concat(&[
                    &JsString16::from_utf8("input.content type '"),
                    &name,
                    &JsString16::from_utf8("' is not supported"),
                ]),
                "input.content.type",
            ));
        }
    }
    let text = s::join(&texts, "");
    if images.is_empty() {
        return bound(&text, path, None, "message", reject, elisions);
    }
    if !texts.is_empty() {
        images.insert(
            0,
            s::object(vec![("type", s::text("text")), ("text", s::quoted(&text))]),
        );
    }
    bounded_parts(images, path, reject, elisions)
}
fn part_bytes(part: &SourceJson) -> usize {
    let text = if s::is(&s::get(part, "type"), "text") {
        s::string(&s::get(part, "text"))
    } else if s::is(&s::get(part, "type"), "image_url") {
        s::string(&s::path(part, &["image_url", "url"]))
    } else {
        None
    };
    text.as_ref().map_or(0, bytes)
}
fn bounded_parts(
    mut parts: Vec<SourceJson>,
    path: &str,
    reject: bool,
    elisions: &mut Vec<Elision>,
) -> s::Result<SourceJson> {
    let original = parts.iter().map(part_bytes).sum::<usize>();
    if original <= FORWARD_LIMIT {
        return Ok(s::array(&parts));
    }
    if reject {
        return Err(crate::chat::oversized(path, original, None));
    }
    while parts.iter().map(part_bytes).sum::<usize>() > FORWARD_LIMIT {
        let Some(index) = parts
            .iter()
            .rposition(|part| s::is(&s::get(part, "type"), "image_url"))
        else {
            break;
        };
        let url = s::string(&s::path(&parts[index], &["image_url", "url"])).unwrap_or_default();
        let mut marker = vec![];
        omit_image(&url, &format!("{path}[{index}]"), &mut marker, elisions);
        parts[index] = s::object(vec![
            ("type", s::text("text")),
            ("text", s::quoted(&marker[0])),
        ]);
    }
    let total = parts.iter().map(part_bytes).sum::<usize>();
    if total > FORWARD_LIMIT
        && let Some(index) = parts.iter().position(|part| {
            s::is(&s::get(part, "type"), "text") && s::string(&s::get(part, "text")).is_some()
        })
    {
        let text = s::string(&s::get(&parts[index], "text")).unwrap_or_default();
        let available = (FORWARD_LIMIT + bytes(&text)).saturating_sub(total);
        let text = crate::chat::bound_source_limit(
            &text, path, None, "message", false, elisions, available,
        )?;
        parts[index] = s::object(vec![("type", s::text("text")), ("text", s::quoted(&text))]);
    }
    if parts.iter().map(part_bytes).sum::<usize>() > FORWARD_LIMIT {
        let marker = format!(
            "\n[gateway: {FORWARD_VERSION} elided {original} bytes omitted; the model did not receive the elided bytes; this route forwards at most {FORWARD_LIMIT} bytes per message because the provider counts forwarded payloads as text tokens]"
        );
        elisions.push(Elision {
            path: path.into(),
            call_id: None,
            kind: "message".into(),
            original_bytes: original,
            forwarded_bytes: marker.len(),
            omitted_bytes: original,
        });
        return Ok(s::text(&marker));
    }
    Ok(s::array(&parts))
}

fn omit_image(
    url: &JsString16,
    path: &str,
    text: &mut Vec<JsString16>,
    elisions: &mut Vec<Elision>,
) {
    let original = bytes(url);
    let marker = format!(
        "[gateway: {FORWARD_VERSION} image omitted ({original} bytes); the model did not receive this image; this route forwards at most {FORWARD_LIMIT} bytes per message because the provider counts forwarded payloads as text tokens]"
    );
    elisions.push(Elision {
        path: path.into(),
        kind: "image".into(),
        original_bytes: original,
        forwarded_bytes: marker.len(),
        omitted_bytes: original,
        call_id: None,
    });
    text.push(JsString16::from_utf8(&marker));
}
fn reasoning(item: &SourceJson) -> JsString16 {
    let mut parts = vec![];
    for key in ["summary", "content"] {
        for part in json::array(&s::get(item, key)).into_iter().flatten() {
            if let Some(text) = s::string(&s::get(&part, "text")) {
                parts.push(text);
            }
        }
    }
    if let Some(text) = s::string(&s::get(item, "text")) {
        parts.push(text);
    }
    s::join(&parts, "")
}
pub(crate) fn messages(raw: &SourceJson) -> s::Result<(Vec<SourceJson>, Vec<Elision>)> {
    let truncation = s::get(raw, "truncation");
    let reject = s::is(&truncation, "disabled");
    if !s::is_null(&truncation) && !reject && !s::is(&truncation, "auto") {
        let value = s::string(&truncation).unwrap_or_else(|| {
            JsString16::from_utf8(if json::number(&truncation).is_some() {
                "number"
            } else if s::boolean(&truncation).is_some() {
                "boolean"
            } else {
                "object"
            })
        });
        return Err(s::invalid(
            s::concat(&[
                &JsString16::from_utf8("truncation '"),
                &value,
                &JsString16::from_utf8("' is not supported; expected 'auto' or 'disabled'"),
            ]),
            "truncation",
        ));
    }
    let mut messages = vec![];
    let mut elisions = vec![];
    let mut pending = JsString16::default();
    if let Some(instructions) =
        s::string(&s::get(raw, "instructions")).filter(|text| !s::trim(text).as_units().is_empty())
    {
        messages.push(s::object(vec![
            ("role", s::text("system")),
            (
                "content",
                bound(
                    &instructions,
                    "instructions",
                    None,
                    "message",
                    reject,
                    &mut elisions,
                )?,
            ),
        ]));
    }
    let input = s::get(raw, "input");
    let items = if s::string(&input).is_some() {
        vec![s::object(vec![
            ("role", s::text("user")),
            ("content", input),
        ])]
    } else {
        json::array(&input).ok_or_else(|| error("input must be a string or an array", "input"))?
    };
    for (index, item) in items.iter().enumerate() {
        let path = format!("input[{index}]");
        if let Some(text) = s::string(item) {
            pending = JsString16::default();
            messages.push(s::object(vec![
                ("role", s::text("user")),
                (
                    "content",
                    bound(&text, &path, None, "message", reject, &mut elisions)?,
                ),
            ]));
            continue;
        }
        let kind = s::present(item, "type")
            .filter(|value| s::string(value).is_some())
            .unwrap_or_else(|| s::text("message"));
        if s::is(&kind, "reasoning") {
            pending = s::concat(&[&pending, &reasoning(item)]);
        } else if s::is(&kind, "message") {
            let role_source =
                s::string(&s::get(item, "role")).unwrap_or_else(|| JsString16::from_utf8("user"));
            let role = role_source
                .try_utf8()
                .ok()
                .filter(|value| {
                    ["user", "assistant", "developer", "system"].contains(&value.as_str())
                })
                .ok_or_else(|| {
                    s::invalid(
                        s::concat(&[
                            &JsString16::from_utf8("input role '"),
                            &role_source,
                            &JsString16::from_utf8("' is not supported"),
                        ]),
                        "input.role",
                    )
                })?;
            if role == "user" {
                pending = JsString16::default();
            }
            let role = if role == "developer" { "system" } else { &role };
            let mut message = s::object(vec![
                ("role", s::text(role)),
                (
                    "content",
                    content(
                        &s::get(item, "content"),
                        role,
                        &format!("{path}.content"),
                        reject,
                        &mut elisions,
                    )?,
                ),
            ]);
            if role == "assistant" && !pending.as_units().is_empty() {
                s::set(
                    &mut message,
                    "reasoning_content",
                    s::quoted(&std::mem::take(&mut pending)),
                );
            }
            messages.push(message);
        } else if s::is(&kind, "function_call") || s::is(&kind, "custom_tool_call") {
            let label = if s::is(&kind, "custom_tool_call") {
                "custom_tool_call"
            } else {
                "function_call"
            };
            let call_id = s::present(item, "call_id")
                .filter(|value| s::string(value).is_some())
                .or_else(|| s::present(item, "id").filter(|value| s::string(value).is_some()))
                .ok_or_else(|| {
                    error(&format!("{label} items require call_id and name"), "input")
                })?;
            let name = s::present(item, "name")
                .filter(|value| s::string(value).is_some_and(|value| !value.as_units().is_empty()))
                .ok_or_else(|| {
                    error(&format!("{label} items require call_id and name"), "input")
                })?;
            let arguments = if label == "custom_tool_call" {
                let input = s::present(item, "input")
                    .filter(|value| s::string(value).is_some())
                    .unwrap_or_else(|| s::text(""));
                let object = s::canonical(&s::object(vec![("input", input)]))?;
                s::text(object.as_str())
            } else {
                s::present(item, "arguments")
                    .filter(|value| s::string(value).is_some())
                    .unwrap_or_else(|| s::text("{}"))
            };
            let call = s::object(vec![
                ("id", call_id),
                ("type", s::text("function")),
                (
                    "function",
                    s::object(vec![("name", name), ("arguments", arguments)]),
                ),
            ]);
            if let Some(previous) = messages.last_mut().filter(|message| {
                s::is(&s::get(message, "role"), "assistant")
                    && s::is_null(&s::get(message, "content"))
                    && json::array(&s::get(message, "tool_calls")).is_some()
            }) {
                let mut calls = json::array(&s::get(previous, "tool_calls")).unwrap_or_default();
                calls.push(call);
                s::set(previous, "tool_calls", s::array(&calls));
                if !pending.as_units().is_empty() {
                    let old = s::string(&s::get(previous, "reasoning_content")).unwrap_or_default();
                    s::set(
                        previous,
                        "reasoning_content",
                        s::quoted(&s::concat(&[&old, &std::mem::take(&mut pending)])),
                    );
                }
            } else {
                let mut message = s::object(vec![
                    ("role", s::text("assistant")),
                    ("content", s::null()),
                    ("tool_calls", s::array(&[call])),
                ]);
                if !pending.as_units().is_empty() {
                    s::set(
                        &mut message,
                        "reasoning_content",
                        s::quoted(&std::mem::take(&mut pending)),
                    );
                }
                messages.push(message);
            }
        } else if s::is(&kind, "function_call_output") || s::is(&kind, "custom_tool_call_output") {
            let Some(call_id) =
                s::string(&s::get(item, "call_id")).filter(|value| !value.as_units().is_empty())
            else {
                continue;
            };
            let output = s::get(item, "output");
            let output = if s::is_null(&output) {
                s::text("")
            } else {
                output
            };
            let text = match s::string(&output) {
                Some(text) => text,
                None => JsString16::from_utf8(s::canonical(&output)?.as_str()),
            };
            messages.push(s::object(vec![
                ("role", s::text("tool")),
                ("tool_call_id", s::quoted(&call_id)),
                (
                    "content",
                    bound(
                        &text,
                        &format!("{path}.output"),
                        Some(&call_id),
                        "tool_output",
                        reject,
                        &mut elisions,
                    )?,
                ),
            ]));
        } else if s::is(&kind, "agent_message") {
            pending = JsString16::default();
            let author = s::string(&s::get(item, "author"))
                .unwrap_or_else(|| JsString16::from_utf8("agent"));
            let recipient = s::string(&s::get(item, "recipient"))
                .unwrap_or_else(|| JsString16::from_utf8("root"));
            let mut texts = vec![];
            let mut omitted = 0;
            for part in json::array(&s::get(item, "content")).into_iter().flatten() {
                if let Some(text) = s::string(&s::get(&part, "text")) {
                    texts.push(text);
                } else if let Some(text) = s::string(&s::get(&part, "encrypted_content")) {
                    if text
                        .as_units()
                        .starts_with(&"gAAAAA".encode_utf16().collect::<Vec<_>>())
                        && text.as_units().len() >= 100
                    {
                        omitted += 1;
                    } else {
                        texts.push(text);
                    }
                }
            }
            let notice = if omitted > 0 {
                format!(
                    "\n[gateway: {omitted} sealed agent-message part(s) were not readable and omitted]"
                )
            } else {
                String::new()
            };
            let text = s::concat(&[
                &JsString16::from_utf8("[agent message] "),
                &author,
                &JsString16::from_utf8(" -> "),
                &recipient,
                &JsString16::from_utf8(":\n"),
                &s::join(&texts, "\n"),
                &JsString16::from_utf8(&notice),
            ]);
            messages.push(s::object(vec![
                ("role", s::text("user")),
                (
                    "content",
                    bound(&text, &path, None, "agent_message", reject, &mut elisions)?,
                ),
            ]));
        } else {
            return Err(s::invalid(
                s::concat(&[
                    &JsString16::from_utf8("input item type '"),
                    &s::string(&kind).unwrap_or_default(),
                    &JsString16::from_utf8("' is not supported"),
                ]),
                "input.type",
            ));
        }
    }
    Ok((messages, elisions))
}

pub(crate) fn thinking(raw: &SourceJson, effort: Option<&str>) -> bool {
    effort.filter(|v| !v.trim().is_empty()).map_or_else(
        || {
            !s::control(&s::path(raw, &["thinking", "type"]))
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("disabled"))
        },
        |effort| !effort.trim().eq_ignore_ascii_case("none"),
    )
}
pub(crate) fn validate_thinking(raw: &SourceJson, field: &str) -> s::Result<()> {
    if thinking(raw, s::control(&s::get(raw, "reasoning_effort")).as_deref())
        && (s::is(&s::get(raw, "tool_choice"), "required")
            || json::entries(&s::get(raw, "tool_choice")).is_some())
    {
        let choice = s::string(&s::get(raw, "tool_choice")).unwrap_or_else(|| {
            s::concat(&[
                &JsString16::from_utf8("function:"),
                &s::string(&s::path(raw, &["tool_choice", "function", "name"])).unwrap_or_default(),
            ])
        });
        return Err(s::invalid(
            s::concat(&[
                &JsString16::from_utf8("tool_choice '"),
                &choice,
                &JsString16::from_utf8(&format!(
                    "' is not supported while {field} keeps DeepSeek thinking mode active; set {field} to 'none' or use tool_choice 'auto'"
                )),
            ]),
            "tool_choice",
        ));
    }
    Ok(())
}
pub(crate) fn effort(
    value: &JsString16,
    profile: ChatProfile,
    param: &str,
) -> s::Result<SourceJson> {
    let control = s::trim(value)
        .try_utf8()
        .ok()
        .map(|value| value.to_lowercase());
    if profile == ChatProfile::Deepseek {
        return Ok(if control.as_deref() == Some("ultra") {
            s::text("max")
        } else {
            s::quoted(value)
        });
    }
    let allowed = match profile {
        ChatProfile::Lithos => {
            ["none", "minimal", "low", "medium", "high", "xhigh", "max"].as_slice()
        }
        ChatProfile::Cerebras => ["none", "low", "medium", "high"].as_slice(),
        _ => return Ok(s::quoted(value)),
    };
    if let Some(control) = control.filter(|value| allowed.contains(&value.as_str())) {
        return Ok(s::text(&control));
    }
    let label = match profile {
        ChatProfile::Lithos => "LithosAI",
        ChatProfile::Cerebras => "Cerebras",
        _ => "DeepSeek",
    };
    Err(s::invalid(
        s::concat(&[
            &JsString16::from_utf8("reasoning.effort '"),
            value,
            &JsString16::from_utf8(&format!("' is not supported by {label}")),
        ]),
        param,
    ))
}
pub(crate) fn project(
    raw: &SourceJson,
    model: &ModelId,
    stream: bool,
    profile: ChatProfile,
) -> s::Result<Projection> {
    let (mut messages, mut elisions) = messages(raw)?;
    if messages.is_empty() {
        return Err(error("input must contain at least one message", "input"));
    }
    let mut body = s::object(vec![
        ("model", s::quoted(model.as_js_string())),
        ("messages", s::array(&[])),
        ("stream", s::generated(&stream)),
    ]);
    if let Some(max) = s::present(raw, "max_output_tokens").filter(|value| !s::is_null(value)) {
        if !json::number(&max)
            .is_some_and(|v| v > 0.0 && v <= 9_007_199_254_740_991.0 && v.fract() == 0.0)
        {
            return Err(error(
                "max_output_tokens must be a positive integer",
                "max_output_tokens",
            ));
        }
        s::set(&mut body, "max_tokens", max);
    }
    if let Some(reasoning) = s::present(raw, "reasoning").filter(|value| !s::is_null(value))
        && json::entries(&reasoning).is_none()
    {
        return Err(error("reasoning must be an object", "reasoning"));
    }
    if let Some(value) = s::string(&s::path(raw, &["reasoning", "effort"]))
        .filter(|value| !value.as_units().is_empty())
    {
        s::set(
            &mut body,
            "reasoning_effort",
            effort(&value, profile, "reasoning.effort")?,
        );
    } else if profile == ChatProfile::Deepseek && !thinking(raw, None) {
        s::set(&mut body, "reasoning_effort", s::text("none"));
    }
    let active = profile == ChatProfile::Deepseek
        && thinking(
            raw,
            s::control(&s::get(&body, "reasoning_effort")).as_deref(),
        );
    let mut warnings = vec![];
    for field in ["temperature", "top_p"] {
        if let Some(value) = s::present(raw, field) {
            if active {
                warnings.push(format!("{field}_ignored"));
            } else {
                s::set(&mut body, field, value);
            }
        }
    }
    if stream && profile == ChatProfile::Deepseek {
        s::set(
            &mut body,
            "stream_options",
            s::generated(&serde_json::json!({"include_usage":true})),
        );
    }
    if profile == ChatProfile::Cerebras
        && let Some(key) = s::present(raw, "prompt_cache_key")
    {
        s::set(&mut body, "prompt_cache_key", key);
    }
    let (tools, names) = source_tools::flatten(s::present(raw, "tools").as_ref(), 128)?;
    if let Some(choice) = source_tools::choice(s::present(raw, "tool_choice").as_ref(), &names)? {
        s::set(&mut body, "tool_choice", choice);
    }
    if let Some(parallel) =
        s::present(raw, "parallel_tool_calls").filter(|value| s::boolean(value).is_some())
    {
        s::set(&mut body, "parallel_tool_calls", parallel);
    }
    if let Some(text) = s::present(raw, "text").filter(|value| !s::is_null(value)) {
        if json::entries(&text).is_none() {
            return Err(error("text must be an object", "text"));
        }
        if let Some(format) = s::present(&text, "format").filter(|value| !s::is_null(value)) {
            if json::entries(&format).is_none() {
                return Err(error("text.format must be an object", "text.format"));
            }
            let kind = s::present(&format, "type")
                .filter(|value| s::string(value).is_some())
                .unwrap_or_else(|| s::text("text"));
            if s::is(&kind, "json_object") {
                s::set(
                    &mut body,
                    "response_format",
                    s::generated(&serde_json::json!({"type":"json_object"})),
                );
            } else if !s::is(&kind, "text") {
                return Err(s::invalid(
                    s::concat(&[
                        &JsString16::from_utf8("text.format type '"),
                        &s::string(&kind).unwrap_or_default(),
                        &JsString16::from_utf8("' is not supported upstream"),
                    ]),
                    "text.format.type",
                ));
            }
        }
    }
    if profile == ChatProfile::Deepseek {
        validate_thinking(&body, "reasoning.effort")?;
    }
    if !tools.is_empty() {
        if !s::is(&s::get(raw, "tool_choice"), "none") {
            let continuation = JsString16::from_utf8(crate::chat::CONTINUATION);
            if let Some(index) = messages.iter().position(|m| {
                s::is(&s::get(m, "role"), "system") && s::string(&s::get(m, "content")).is_some()
            }) {
                let old = s::string(&s::get(&messages[index], "content")).unwrap_or_default();
                let text = s::concat(&[&old, &JsString16::from_utf8("\n\n"), &continuation]);
                s::set(
                    &mut messages[index],
                    "content",
                    bound(
                        &text,
                        "instructions",
                        None,
                        "message",
                        s::is(&s::get(raw, "truncation"), "disabled"),
                        &mut elisions,
                    )?,
                );
            } else {
                messages.insert(
                    0,
                    s::object(vec![
                        ("role", s::text("system")),
                        ("content", s::quoted(&continuation)),
                    ]),
                );
            }
        }
        let start = messages
            .iter()
            .rposition(|m| s::is(&s::get(m, "role"), "user"))
            .map_or(0, |i| i + 1);
        for message in messages.iter_mut().skip(start) {
            if s::is(&s::get(message, "role"), "assistant")
                && s::string(&s::get(message, "reasoning_content")).is_none()
            {
                s::set(message, "reasoning_content", s::text(""));
            }
        }
        s::set(&mut body, "tools", s::array(&tools));
    }
    s::set(&mut body, "messages", s::array(&messages));
    Ok(Projection {
        body,
        names,
        elisions,
        warnings,
    })
}
