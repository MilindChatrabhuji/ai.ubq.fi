//! Exact provider-bound request construction. The caller supplies account/discovery capabilities.
use crate::{anthropic, chat, types::*};
use gateway_core::{GatewayError, provider::UpstreamProvider};
use serde_json::{Map, Value, json};
pub const LITHOS_MODELS: [&str; 8] = [
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4.1-Flash-fast",
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra",
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat",
    "moonshotai/Kimi-K3",
    "moonshotai/Kimi-K3-fast",
    "moonshotai/Kimi-K3-ultra",
    "moonshotai/Kimi-K3-ultra-chat",
];
pub fn canonical_model(
    provider: UpstreamProvider,
    model: &str,
    allowed: &[String],
) -> Option<String> {
    let lower = model.trim().to_lowercase();
    match provider {
        UpstreamProvider::Deepseek => match lower.as_str() {
            "deepseek-flash" | "deepseek-v4-flash" => Some("deepseek-flash".into()),
            "deepseek-v4-pro" => Some(lower),
            _ => None,
        },
        UpstreamProvider::Lithos => LITHOS_MODELS
            .iter()
            .find(|s| s.eq_ignore_ascii_case(&lower))
            .map(|s| (*s).into()),
        UpstreamProvider::Cerebras => ["gpt-oss-120b", "qwen-3.8-27b"]
            .contains(&lower.as_str())
            .then_some(lower),
        UpstreamProvider::Openrouter => {
            allowed.iter().find(|s| s.as_str() == model.trim()).cloned()
        }
        _ => (!model.trim().is_empty()).then(|| model.trim().to_owned()),
    }
}
fn bearer_headers(secret: &str, accept: &str) -> Headers {
    Headers::from([
        ("Authorization".into(), format!("Bearer {}", secret.trim())),
        ("Content-Type".into(), "application/json".into()),
        ("Accept".into(), accept.into()),
    ])
}
fn codex_synthetic_id(id: &str) -> bool {
    let (response, rest) = if let Some(rest) = id.strip_prefix("resp_") {
        let Some((response, rest)) = rest.split_once('_') else {
            return false;
        };
        (response, rest)
    } else {
        let Some((kind, rest)) = id.split_once('_') else {
            return false;
        };
        if !["rs", "msg", "fc", "ctc"].contains(&kind) {
            return false;
        }
        let Some(rest) = rest.strip_prefix("resp_") else {
            return false;
        };
        let Some((response, rest)) = rest.split_once('_') else {
            return false;
        };
        if response.is_empty()
            || response.len() > 40
            || !response.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return false;
        }
        return rest.split('_').count() <= 2
            && rest
                .split('_')
                .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()));
    };
    if response.is_empty()
        || response.len() > 40
        || !response.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return false;
    }
    let Some((kind, indexes)) = rest.split_once('_') else {
        return false;
    };
    ["rs", "msg", "fc", "ctc"].contains(&kind)
        && indexes.split('_').count() <= 2
        && indexes
            .split('_')
            .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
}
pub fn codex_replay_input(input: &Value) -> Value {
    let Some(items) = input.as_array() else {
        return input.clone();
    };
    Value::Array(
        items
            .iter()
            .filter_map(|item| {
                let mut copy = item.clone();
                let Some(id) = item["id"].as_str().filter(|id| codex_synthetic_id(id)) else {
                    return Some(copy);
                };
                let _ = id;
                if item["type"] == "reasoning"
                    && item["encrypted_content"].as_str().is_none_or(str::is_empty)
                {
                    return None;
                }
                if let Some(object) = copy.as_object_mut() {
                    object.remove("id");
                }
                Some(copy)
            })
            .collect(),
    )
}
pub fn build_codex_body(raw: &Value) -> Result<Value, GatewayError> {
    let model = raw["model"]
        .as_str()
        .ok_or_else(|| invalid("model must be a string", "model"))?;
    let input = raw
        .get("input")
        .ok_or_else(|| invalid("input is required", "input"))?;
    let mut body =
        json!({"model":model,"input":codex_replay_input(input),"stream":true,"store":false});
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
        if let Some(value) = raw.get(key) {
            body[key] = value.clone();
        }
    }
    if body["reasoning"]["effort"] == "ultra" {
        body["reasoning"]["effort"] = json!("max");
    }
    if let Some(tools) = body["tools"].as_array_mut() {
        for tool in tools {
            if tool["type"] == "function" && tool["function"].is_object() {
                let mut function = tool["function"].as_object().cloned().unwrap_or_default();
                function.insert("type".into(), json!("function"));
                *tool = Value::Object(function);
            }
        }
    }
    if body["tool_choice"]["type"] == "function" && body["tool_choice"]["function"].is_object() {
        body["tool_choice"] =
            json!({"type":"function","name":body["tool_choice"]["function"]["name"]});
    }
    Ok(body)
}
/// OpenAI Chat -> normalized Responses wire. m02 remains the validation authority.
pub fn chat_request_to_responses(raw: &Value) -> Result<Value, GatewayError> {
    let messages = raw["messages"]
        .as_array()
        .ok_or_else(|| invalid("messages must be an array", "messages"))?;
    let mut input = vec![];
    let mut instructions = vec![];
    for message in messages {
        let role = message["role"].as_str().unwrap_or("user");
        if role == "system" || role == "developer" {
            if let Some(text) = message["content"].as_str() {
                instructions.push(text.to_owned());
                continue;
            }
        }
        if role == "tool" {
            if let Some(call) = message["tool_call_id"].as_str() {
                input.push(json!({"type":"function_call_output","call_id":call,"output":message["content"]}));
            }
            continue;
        }
        if !message["content"].is_null() {
            let content = if let Some(text) = message["content"].as_str() {
                json!([{"type":if role=="assistant"{"output_text"}else{"input_text"},"text":text}])
            } else {
                Value::Array(message["content"].as_array().unwrap_or(&vec![]).iter().map(|part|{if part["type"]=="text"{json!({"type":if role=="assistant"{"output_text"}else{"input_text"},"text":part["text"]})}else if part["type"]=="image_url"{let mut image=json!({"type":"input_image","image_url":part["image_url"]["url"]});if let Some(detail)=part["image_url"].get("detail"){image["detail"]=detail.clone();}image}else{part.clone()}}).collect())
            };
            input.push(json!({"type":"message","role":role,"content":content}));
        }
        if let Some(calls) = message["tool_calls"].as_array() {
            for call in calls {
                input.push(json!({"type":"function_call","call_id":call["id"],"name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
            }
        }
    }
    let mut body =
        json!({"model":raw["model"],"input":input,"stream":raw["stream"]==true,"store":false});
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions.join("\n\n"));
    }
    for key in [
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "prompt_cache_key",
        "prompt_cache_options",
        "prompt_cache_retention",
    ] {
        if let Some(value) = raw.get(key) {
            body[key] = value.clone();
        }
    }
    if let Some(effort) = raw.get("reasoning_effort").filter(|v| !v.is_null()) {
        body["reasoning"] = json!({"effort":effort});
    }
    if let Some(max) = raw.get("max_completion_tokens").filter(|v| !v.is_null()) {
        body["max_output_tokens"] = max.clone();
    }
    if raw["response_format"] == json!({"type":"json_object"}) {
        body["text"] = json!({"format":{"type":"json_object"}});
    }
    Ok(body)
}
pub fn prepare_request(
    provider: UpstreamProvider,
    surface: ClientSurface,
    raw: &Value,
    options: &PrepareOptions,
) -> Result<PreparedRequest, GatewayError> {
    if !raw.is_object() {
        return Err(invalid("Invalid JSON body", ""));
    }
    if options.auth.secret.trim().is_empty() {
        return Err(GatewayError::unavailable(
            "The requested provider is not configured.",
            &format!(
                "{}_api_key_missing",
                crate::policy::direct_provider_label(provider)
            ),
        ));
    }
    if surface == ClientSurface::SystemOne {
        return crate::extras::prepare_systemone(raw, options);
    }
    if surface == ClientSurface::Embeddings {
        return crate::extras::prepare_embeddings(raw, options);
    }
    let requested = raw["model"]
        .as_str()
        .ok_or_else(|| invalid("model must be a string", "model"))?;
    let model = canonical_model(provider, requested, &options.allowed_models).ok_or_else(|| {
        GatewayError::new(
            404,
            format!("The model '{requested}' does not exist or is not available."),
            Some("model_not_found"),
        )
    })?;
    let client_stream = raw.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut body = raw.clone();
    let mut names = ToolMap::new();
    let mut warnings = vec![];
    let mut decode = if surface == ClientSurface::Responses {
        ResponseDecode::Responses
    } else {
        ResponseDecode::Chat
    };
    let mut url: String;
    let mut headers = bearer_headers(&options.auth.secret, "application/json");
    match provider {
        UpstreamProvider::Deepseek | UpstreamProvider::Lithos | UpstreamProvider::Cerebras => {
            let profile = match provider {
                UpstreamProvider::Deepseek => ChatProfile::Deepseek,
                UpstreamProvider::Lithos => ChatProfile::Lithos,
                _ => ChatProfile::Cerebras,
            };
            if surface == ClientSurface::Responses {
                let projection = chat::project_responses(
                    raw,
                    &model,
                    client_stream && profile != ChatProfile::Cerebras,
                    profile,
                )?;
                body = projection.body;
                names = projection.tool_names;
                if body.get("reasoning_effort").is_none() {
                    body["reasoning_effort"] = json!(match profile {
                        ChatProfile::Deepseek => "high",
                        ChatProfile::Lithos => "medium",
                        _ =>
                            if model == "qwen-3.8-27b" {
                                "high"
                            } else {
                                "medium"
                            },
                    });
                }
                decode = ResponseDecode::ChatToResponses(profile);
            } else {
                body["model"] = json!(model);
                let effort = raw["reasoning_effort"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        match profile {
                            ChatProfile::Deepseek => {
                                if raw["thinking"]["type"] == "disabled" {
                                    "none"
                                } else {
                                    "high"
                                }
                            }
                            ChatProfile::Lithos => "medium",
                            _ => {
                                if model == "qwen-3.8-27b" {
                                    "high"
                                } else {
                                    "medium"
                                }
                            }
                        }
                        .into()
                    });
                body["reasoning_effort"] = json!(chat::project_effort(&effort, profile)?);
                if let Some(max) = raw.get("max_completion_tokens").filter(|v| !v.is_null()) {
                    body["max_tokens"] = max.clone();
                }
                body.as_object_mut()
                    .expect("object")
                    .remove("max_completion_tokens");
                if profile == ChatProfile::Deepseek {
                    chat::validate_thinking_choice(&body, "reasoning_effort")?;
                }
            }
            if provider == UpstreamProvider::Deepseek {
                url = "https://api.deepseek.com/chat/completions".into();
                body.as_object_mut().expect("object").remove("thinking");
                if body["stream"] == true {
                    if !body["stream_options"].is_object() {
                        body["stream_options"] = json!({"include_usage":true});
                    }
                } else {
                    body.as_object_mut()
                        .expect("object")
                        .remove("stream_options");
                }
                if let Some(messages) = body["messages"].as_array_mut() {
                    for message in messages {
                        if message["role"] == "developer" {
                            message["role"] = json!("system")
                        }
                    }
                }
            } else if provider == UpstreamProvider::Lithos {
                url = "https://api.lithosai.cloud/v1/chat/completions".into();
                if body["stream"] != true {
                    body.as_object_mut()
                        .expect("object")
                        .remove("stream_options");
                }
            } else {
                url = "https://api.cerebras.ai/v1/chat/completions".into();
                if model == "gpt-oss-120b" && body["reasoning_effort"] == "none" {
                    return Err(invalid(
                        "reasoning_effort 'none' is not supported by gpt-oss-120b",
                        "reasoning_effort",
                    ));
                }
                body["stream"] = json!(false);
                for key in ["stream_options", "store", "metadata"] {
                    body.as_object_mut().expect("object").remove(key);
                }
                if body["logprobs"] != true {
                    body.as_object_mut().expect("object").remove("top_logprobs");
                }
                project_cerebras(&mut body)?;
                if client_stream {
                    warnings.push("gpt_oss_stream_downgraded".into());
                }
            }
        }
        UpstreamProvider::Openrouter => {
            url = format!(
                "https://openrouter.ai/api/v1/{}",
                if surface == ClientSurface::Responses {
                    "responses"
                } else {
                    "chat/completions"
                }
            );
            body["model"] = json!(model);
            openrouter_controls(&mut body, &model);
        }
        UpstreamProvider::ChatgptCodex => {
            let normalized = if surface == ClientSurface::Chat {
                chat_request_to_responses(raw)?
            } else {
                raw.clone()
            };
            body = build_codex_body(&normalized)?;
            strip_codex_transport_fields(&mut body, &mut warnings);
            decode = if surface == ClientSurface::Chat {
                ResponseDecode::ResponsesToChat
            } else {
                ResponseDecode::Responses
            };
            url = "https://chatgpt.com/backend-api/codex/responses".into();
            headers = bearer_headers(&options.auth.secret, "text/event-stream");
            headers.insert(
                "ChatGPT-Account-ID".into(),
                options.auth.account_id.clone().ok_or_else(|| {
                    GatewayError::unavailable(
                        "Codex account identity is unavailable",
                        "codex_auth_missing",
                    )
                })?,
            );
            headers.insert("originator".into(), "codex_cli_rs".into());
            headers.insert(
                "user-agent".into(),
                codex_user_agent(&options.client_version),
            );
            if let Some(identity) = &options.native_session_id {
                for key in ["session-id", "thread-id", "x-client-request-id"] {
                    headers.insert(key.into(), identity.clone());
                }
            }
            let conversation = options
                .native_session_id
                .as_ref()
                .or(options.conversation_id.as_ref())
                .ok_or_else(|| {
                    GatewayError::unavailable(
                        "Codex conversation identity is unavailable",
                        "codex_session_identity_missing",
                    )
                })?;
            headers.insert("conversation_id".into(), conversation.clone());
        }
        UpstreamProvider::Surplus | UpstreamProvider::Metered | UpstreamProvider::ClaudeCode => {
            let normalized = if surface == ClientSurface::Chat {
                chat_request_to_responses(raw)?
            } else {
                raw.clone()
            };
            body = normalized.clone();
            decode = if surface == ClientSurface::Chat {
                ResponseDecode::ResponsesToChat
            } else {
                ResponseDecode::Responses
            };
            headers = bearer_headers(&options.auth.secret, "text/event-stream");
            if provider == UpstreamProvider::Surplus {
                url = "https://api.surplusintelligence.ai/v1/responses".into();
                if let Some(projection) = anthropic::try_claude_chat(&normalized, options) {
                    body = projection.body;
                    names = projection.tool_names;
                    url = "https://api.surplusintelligence.ai/v1/chat/completions".into();
                    decode = ResponseDecode::AnthropicChatToResponses;
                } else {
                    if options.supports_parallel_tools == Some(false) {
                        body.as_object_mut()
                            .expect("object")
                            .remove("parallel_tool_calls");
                    }
                    if crate::anthropic::is_claude(&model) {
                        warnings.push("surplus_claude_native_prompt_cache_unavailable".into());
                    }
                    if let Some(items) = body["input"].as_array_mut() {
                        for item in items {
                            if item["type"] == "message" && item["role"] == "developer" {
                                item["role"] = json!("system");
                            }
                        }
                    }
                    if body["reasoning"]["effort"] == "ultra" {
                        body["reasoning"]["effort"] = json!("max");
                    }
                }
            } else {
                let mut native_options = options.clone();
                if provider == UpstreamProvider::ClaudeCode {
                    native_options.catalog_max_output_tokens = Some(32_000);
                    native_options.supports_native_effort = native_options
                        .native_reasoning_efforts
                        .as_ref()
                        .is_some_and(|v| !v.is_empty());
                }
                if provider != UpstreamProvider::ClaudeCode {
                    native_options.supports_native_effort = false;
                    native_options.supports_disabled_thinking = false;
                }
                let native = anthropic::try_native_messages(&normalized, &native_options);
                if let Some(native) = native {
                    body = native;
                    url = if provider == UpstreamProvider::ClaudeCode {
                        "https://api.anthropic.com/v1/messages"
                    } else {
                        "https://api.openlux.ai/v1/messages"
                    }
                    .into();
                    decode = ResponseDecode::AnthropicToResponses;
                    headers.insert("anthropic-version".into(), "2023-06-01".into());
                    if provider == UpstreamProvider::ClaudeCode {
                        crate::finalize::claude_native_transport(&mut body, options);
                        if options.auth.api_key {
                            headers.remove("Authorization");
                            headers.insert("x-api-key".into(), options.auth.secret.clone());
                        } else {
                            headers.insert("anthropic-beta".into(), "oauth-2025-04-20".into());
                        }
                        if let Some(workspace) = &options.auth.workspace_id {
                            headers.insert("anthropic-workspace-id".into(), workspace.clone());
                        }
                        headers.insert(
                            "Accept".into(),
                            if body["stream"] == true {
                                "text/event-stream"
                            } else {
                                "application/json"
                            }
                            .into(),
                        );
                    }
                } else if provider == UpstreamProvider::ClaudeCode {
                    return Err(invalid(
                        "Claude request cannot be represented losslessly with the current credential/workspace capability proof",
                        "reasoning",
                    ));
                } else {
                    url = "https://api.openlux.ai/v1/responses".into();
                    if model == "gpt-5.6-sol" {
                        if let Some(effort) = body["reasoning"]["effort"].as_str() {
                            let suffix = match effort {
                                "none" | "minimal" => "low",
                                "ultra" => "max",
                                other => other,
                            };
                            if ["low", "medium", "high", "xhigh", "max"].contains(&suffix) {
                                body["model"] = json!(format!("{model}-{suffix}"));
                                body.as_object_mut().expect("object").remove("reasoning");
                            }
                        }
                    }
                    if crate::anthropic::is_claude(&model) {
                        warnings.push("openlux_claude_native_prompt_cache_unavailable".into());
                    }
                }
            }
        }
        _ => {
            return Err(GatewayError::unavailable(
                "This provider has no Chat/Responses transport",
                "provider_route_unavailable",
            ));
        }
    }
    let plan = DecodePlan {
        provider,
        surface,
        decode,
        model: if surface == ClientSurface::Chat
            && matches!(
                provider,
                UpstreamProvider::Deepseek | UpstreamProvider::Lithos | UpstreamProvider::Cerebras
            ) {
            model.clone()
        } else {
            requested.into()
        },
        upstream_model: model,
        response_id: options.response_id.clone(),
        created_at: options.created_at,
        stream: client_stream,
        request: raw.clone(),
        tool_names: names,
        reasoning_summary: options.reasoning_summary.clone(),
    };
    Ok(PreparedRequest {
        provider,
        url,
        method: "POST".into(),
        headers,
        body,
        decode: plan,
        warnings,
    })
}
fn openrouter_controls(body: &mut Value, model: &str) {
    let openai = model.starts_with("openai/") || model.starts_with("~openai/");
    if openai
        && !model.split(':').any(|v| v == "batch")
        && body.get("tool_choice").is_none_or(|v| v == "auto")
        && body.get("functions").is_none()
        && body.get("function_call").is_none()
        && body
            .get("tools")
            .is_none_or(|v| v.as_array().is_some_and(|t| !t.is_empty()))
    {
        if body.get("tools").is_none() {
            body["tools"] = json!([]);
        }
        for kind in ["web_search", "web_fetch"] {
            let found = body["tools"].as_array().is_some_and(|t| {
                t.iter().any(|v| {
                    v["type"].as_str().is_some_and(|s| {
                        s == kind
                            || s == format!("openrouter:{kind}")
                            || s.starts_with(&format!("{kind}_"))
                    })
                })
            });
            if !found {
                body["tools"]
                    .as_array_mut()
                    .expect("array")
                    .push(json!({"type":format!("openrouter:{kind}")}));
            }
        }
    }
    if (model.starts_with("anthropic/claude-") || model.starts_with("~anthropic/claude-"))
        && body.get("cache_control").is_none()
        && body["prompt_cache_options"]["mode"] != "explicit"
        && !has_cache_block(body)
    {
        body["cache_control"] = json!({"type":"ephemeral"});
    }
}
fn has_cache_block(value: &Value) -> bool {
    match value {
        Value::Array(a) => a.iter().any(has_cache_block),
        Value::Object(o) => {
            o.contains_key("cache_control")
                || o.contains_key("prompt_cache_breakpoint")
                || o.iter()
                    .filter(|(k, _)| {
                        [
                            "instructions",
                            "input",
                            "messages",
                            "tools",
                            "content",
                            "output",
                            "function",
                        ]
                        .contains(&k.as_str())
                    })
                    .any(|(_, v)| has_cache_block(v))
        }
        _ => false,
    }
}
fn schema_project(value: &Value, properties: bool) -> Value {
    match value {
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| schema_project(v, false)).collect())
        }
        Value::Object(object) => {
            let mut result = Map::new();
            for (k, v) in object {
                if !properties
                    && [
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
                    .contains(&k.as_str())
                {
                    continue;
                }
                if !properties && k == "const" {
                    result.insert("enum".into(), json!([schema_project(v, false)]));
                } else {
                    result.insert(
                        if !properties && k == "oneOf" {
                            "anyOf".into()
                        } else {
                            k.clone()
                        },
                        schema_project(v, k == "properties"),
                    );
                }
            }
            Value::Object(result)
        }
        _ => value.clone(),
    }
}
pub fn project_cerebras_schema(value: &Value) -> Value {
    let projected = schema_project(value, false);
    if projected["type"] == "object" {
        return projected;
    }
    let Some(variants) = projected["anyOf"].as_array().filter(|a| {
        !a.is_empty()
            && a.iter()
                .all(|v| v["type"] == "object" && v["properties"].is_object())
    }) else {
        return projected;
    };
    let mut properties = Map::<String, Value>::new();
    let mut required: Option<std::collections::BTreeSet<String>> = None;
    for variant in variants {
        for (name, schema) in variant["properties"].as_object().into_iter().flatten() {
            if let Some(old) = properties.get(name).cloned() {
                if old != *schema {
                    if name == "operationId" && old["enum"].is_array() && schema["enum"].is_array()
                    {
                        let mut enums = old["enum"].as_array().cloned().unwrap_or_default();
                        for value in schema["enum"].as_array().into_iter().flatten() {
                            if !enums.contains(value) {
                                enums.push(value.clone());
                            }
                        }
                        properties.insert(name.clone(), json!({"enum":enums}));
                    } else {
                        let mut choices = old["anyOf"]
                            .as_array()
                            .cloned()
                            .unwrap_or_else(|| vec![old]);
                        if !choices.contains(schema) {
                            choices.push(schema.clone());
                        }
                        properties.insert(name.clone(), json!({"anyOf":choices}));
                    }
                }
            } else {
                properties.insert(name.clone(), schema.clone());
            }
        }
        let row = variant["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>();
        required = Some(required.map_or(row.clone(), |r| r.intersection(&row).cloned().collect()));
    }
    json!({"type":"object","properties":properties,"required":required.unwrap_or_default(),"additionalProperties":false})
}
fn project_cerebras(body: &mut Value) -> Result<(), GatewayError> {
    let mut system = vec![];
    if let Some(messages) = body["messages"].as_array_mut() {
        for message in messages.iter_mut() {
            if message["role"] == "developer" {
                message["role"] = json!("system");
            }
            if message["role"] == "assistant" {
                message
                    .as_object_mut()
                    .expect("message object")
                    .remove("reasoning_content");
            }
            if message["role"] == "system" {
                if let Some(text) = message["content"].as_str() {
                    system.push(text.to_owned());
                } else if let Some(parts) = message["content"].as_array() {
                    let mut text = String::new();
                    for part in parts {
                        if part["type"] != "text" || !part["text"].is_string() {
                            return Err(invalid(
                                "Cerebras supports only text content in system and developer messages.",
                                "messages",
                            ));
                        }
                        text.push_str(part["text"].as_str().unwrap_or(""));
                    }
                    system.push(text);
                } else {
                    return Err(invalid(
                        "Cerebras supports only text content in system and developer messages.",
                        "messages",
                    ));
                }
            }
        }
        messages.retain(|m| m["role"] != "system");
        if !system.is_empty() {
            messages.insert(0, json!({"role":"system","content":system.join("\n\n")}));
        }
    }
    if let Some(tools) = body["tools"].as_array_mut() {
        for tool in tools {
            if let Some(parameters) = tool["function"].get("parameters") {
                let value = project_cerebras_schema(parameters);
                tool["function"]["parameters"] = value;
            }
        }
    }
    Ok(())
}

fn strip_codex_transport_fields(body: &mut Value, warnings: &mut Vec<String>) {
    for (field, warning) in [
        ("prompt_cache_options", "prompt_cache_options_ignored"),
        ("prompt_cache_retention", "prompt_cache_retention_ignored"),
        ("max_output_tokens", "max_output_tokens_ignored"),
        ("max_completion_tokens", "max_output_tokens_ignored"),
    ] {
        if body
            .as_object_mut()
            .is_some_and(|o| o.remove(field).is_some())
            && !warnings.iter().any(|s| s == warning)
        {
            warnings.push(warning.into());
        }
    }
    fn strip(value: &mut Value) -> bool {
        match value {
            Value::Array(a) => a.iter_mut().fold(false, |removed, v| strip(v) || removed),
            Value::Object(o) => {
                let mut removed = o.remove("prompt_cache_breakpoint").is_some();
                for key in ["content", "output"] {
                    if let Some(child) = o.get_mut(key) {
                        removed = strip(child) || removed;
                    }
                }
                removed
            }
            _ => false,
        }
    }
    if body.get_mut("input").is_some_and(strip) {
        warnings.push("prompt_cache_breakpoint_ignored".into());
    }
}
fn codex_user_agent(version: &str) -> String {
    let version = version.trim();
    let parts = version
        .split('.')
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>();
    let chosen = if version.is_empty() {
        "0.100.0"
    } else if let Ok(parts) = parts {
        if (2..=3).contains(&parts.len())
            && parts.iter().all(|v| v.is_finite() && *v >= 0.0)
            && [
                parts[0] as u64,
                parts[1] as u64,
                parts.get(2).copied().unwrap_or(0.0) as u64,
            ] < [0, 100, 0]
        {
            "0.100.0"
        } else {
            version
        }
    } else {
        version
    };
    format!("codex_cli_rs/{chosen} (ai.ubq.fi)")
}
