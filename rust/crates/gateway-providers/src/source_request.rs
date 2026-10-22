//! One source-phase-aware dispatcher. Host routing and accounting remain outside this crate.
use crate::{
    request::{bearer_headers, canonical_source_model, codex_user_agent},
    source as s, source_anthropic, source_chat, source_controls as controls,
    types::*,
};
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, provider::UpstreamProvider,
    source_json::SourceJson, source_serialization as json,
};
use gateway_schema::{
    request::RequestSurface,
    source_request::{SourceModelRequest, SourceRequestDocument, SourceRequestError},
};
fn lift(error: GatewayError) -> SourceRequestError {
    SourceRequestError::from_gateway(error)
}
fn invalid(message: &str, field: &str) -> SourceRequestError {
    s::invalid(JsString16::from_utf8(message), field)
}
fn unavailable(message: &str, code: &str) -> SourceRequestError {
    lift(GatewayError::unavailable(message, code))
}
pub fn prepare_source_request(
    provider: UpstreamProvider,
    surface: ClientSurface,
    raw: &SourceJson,
    selected_model: &ModelId,
    options: &PrepareOptions,
) -> s::Result<PreparedRequest> {
    let (document, client_stream, requested, model) = source_prelude(
        provider,
        surface,
        raw,
        selected_model,
        &options.allowed_models,
    )?;
    let schema_surface = if surface == ClientSurface::Chat {
        RequestSurface::ChatCompletions
    } else {
        RequestSurface::Responses
    };
    let view = document.for_surface(schema_surface);
    if options.auth.secret.trim().is_empty() {
        return Err(unavailable(
            "The requested provider is not configured.",
            &format!(
                "{}_api_key_missing",
                crate::policy::direct_provider_label(provider)
            ),
        ));
    }
    if provider == UpstreamProvider::ClaudeCode {
        let body_options = ClaudeBodyOptions::from_scalar(options);
        let body =
            prepare_claude_resolved(surface, raw, requested, model, client_stream, &body_options)?;
        return Ok(finalize_scalar_claude(body, &options.auth));
    }
    let direct = matches!(
        provider,
        UpstreamProvider::Deepseek | UpstreamProvider::Lithos | UpstreamProvider::Cerebras
    );
    let mut client_stream = client_stream;
    let mut effort = None;
    if surface == ClientSurface::Chat && direct {
        let messages = s::get(raw, "messages");
        let values = json::array(&messages)
            .filter(|values| !values.is_empty())
            .ok_or_else(|| invalid("messages must be a non-empty array", "messages"))?;
        if values.iter().any(|value| json::entries(value).is_none()) {
            return Err(invalid("messages must contain objects", "messages"));
        }
        effort = view.reasoning_effort()?;
        // The direct model tier rule precedes stream/stream_options at this surface.
        if let Some(value) = &effort {
            project_effort(value, profile(provider), "reasoning_effort")?;
        }
        client_stream = view.stream()?;
        view.chat_stream_options()?;
    }
    let mut body = raw.clone();
    let mut names = ToolMap::new();
    let mut warnings = vec![];
    let mut decode = if surface == ClientSurface::Responses {
        ResponseDecode::Responses
    } else {
        ResponseDecode::Chat
    };
    let mut headers = bearer_headers(&options.auth.secret, "application/json");
    let url;
    match provider {
        UpstreamProvider::Deepseek | UpstreamProvider::Lithos | UpstreamProvider::Cerebras => {
            let profile = profile(provider);
            if surface == ClientSurface::Responses {
                let projection = source_chat::project(
                    raw,
                    &model,
                    client_stream && profile != ChatProfile::Cerebras,
                    profile,
                )?;
                body = projection.body;
                names = projection.names;
                warnings = projection.warnings;
                if s::present(&body, "reasoning_effort").is_none() {
                    s::set(
                        &mut body,
                        "reasoning_effort",
                        s::text(default_effort(profile, &model)),
                    );
                }
                decode = ResponseDecode::ChatToResponses(profile);
            } else {
                s::set(&mut body, "model", s::quoted(model.as_js_string()));
                let chosen = effort.unwrap_or_else(|| {
                    JsString16::from_utf8(
                        if profile == ChatProfile::Deepseek && !source_chat::thinking(raw, None) {
                            "none"
                        } else {
                            default_effort(profile, &model)
                        },
                    )
                });
                s::set(
                    &mut body,
                    "reasoning_effort",
                    project_effort(&chosen, profile, "reasoning_effort")?,
                );
                if let Some(max) =
                    s::present(raw, "max_completion_tokens").filter(|value| !s::is_null(value))
                {
                    s::set(&mut body, "max_tokens", max);
                }
                s::remove(&mut body, "max_completion_tokens");
                if profile == ChatProfile::Deepseek {
                    source_chat::validate_thinking(&body, "reasoning_effort")?;
                }
            }
            if provider == UpstreamProvider::Deepseek {
                url = "https://api.deepseek.com/chat/completions".into();
                s::remove(&mut body, "thinking");
                if s::boolean(&s::get(&body, "stream")) == Some(true) {
                    if json::entries(&s::get(&body, "stream_options")).is_none() {
                        s::set(
                            &mut body,
                            "stream_options",
                            s::generated(&serde_json::json!({"include_usage":true})),
                        );
                    }
                } else {
                    s::remove(&mut body, "stream_options");
                }
                controls::roles(&mut body, "messages", false);
            } else if provider == UpstreamProvider::Lithos {
                url = "https://api.lithosai.cloud/v1/chat/completions".into();
                if s::boolean(&s::get(&body, "stream")) != Some(true) {
                    s::remove(&mut body, "stream_options");
                }
            } else {
                url = "https://api.cerebras.ai/v1/chat/completions".into();
                if model.matches_scalar("gpt-oss-120b")
                    && s::is(&s::get(&body, "reasoning_effort"), "none")
                {
                    return Err(invalid(
                        "reasoning_effort 'none' is not supported by gpt-oss-120b",
                        "reasoning_effort",
                    ));
                }
                s::set(&mut body, "stream", s::generated(&false));
                for key in ["stream_options", "store", "metadata"] {
                    s::remove(&mut body, key);
                }
                if s::boolean(&s::get(&body, "logprobs")) != Some(true) {
                    s::remove(&mut body, "top_logprobs");
                }
                controls::cerebras(&mut body)?;
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
            s::set(&mut body, "model", s::quoted(model.as_js_string()));
            controls::openrouter(&mut body, &model);
        }
        UpstreamProvider::ChatgptCodex => {
            let normalized =
                controls::ordinary(raw, surface, &model, options.ordinary_preparation.as_ref())?;
            if surface == ClientSurface::Chat {
                client_stream = s::boolean(&s::get(&normalized, "stream")).unwrap_or(false);
            }
            body = controls::codex(&normalized)?;
            controls::strip_codex(&mut body, &mut warnings);
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
                    unavailable(
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
                    unavailable(
                        "Codex conversation identity is unavailable",
                        "codex_session_identity_missing",
                    )
                })?;
            headers.insert("conversation_id".into(), conversation.clone());
        }
        UpstreamProvider::Surplus | UpstreamProvider::Metered => {
            let normalized =
                controls::ordinary(raw, surface, &model, options.ordinary_preparation.as_ref())?;
            let mut provider_projection = normalized.clone();
            let previous_response_id_ignored = surface == ClientSurface::Responses
                && s::present(raw, "previous_response_id").is_some();
            if previous_response_id_ignored {
                // Claude's native projection cannot represent response-store state.
                // Ignore it on the provider clone, not the original source echo.
                s::remove(&mut provider_projection, "previous_response_id");
                warnings.push("previous_response_id_ignored".into());
            }
            if surface == ClientSurface::Chat {
                client_stream = s::boolean(&s::get(&normalized, "stream")).unwrap_or(false);
            }
            body = provider_projection.clone();
            decode = if surface == ClientSurface::Chat {
                ResponseDecode::ResponsesToChat
            } else {
                ResponseDecode::Responses
            };
            headers = bearer_headers(&options.auth.secret, "text/event-stream");
            if provider == UpstreamProvider::Surplus {
                headers.insert("X-SI-Mask-Secrets".into(), "on".into());
                if let Some(projection) = source_anthropic::chat(&provider_projection, options) {
                    body = projection.body;
                    names = projection.names;
                    url = "https://api.surplusintelligence.ai/v1/chat/completions".into();
                    decode = ResponseDecode::AnthropicChatToResponses;
                } else {
                    url = "https://api.surplusintelligence.ai/v1/responses".into();
                    if options.supports_parallel_tools == Some(false) {
                        s::remove(&mut body, "parallel_tool_calls");
                    }
                    if crate::anthropic::is_claude_model(&model) {
                        warnings.push("surplus_claude_native_prompt_cache_unavailable".into());
                    }
                    controls::roles(&mut body, "input", false);
                    controls::ultra(&mut body);
                }
            } else {
                let mut native_options = options.clone();
                native_options.supports_native_effort = false;
                native_options.supports_disabled_thinking = false;
                if let Some(native) =
                    source_anthropic::native(&provider_projection, &native_options)
                {
                    body = native;
                    url = "https://api.openlux.ai/v1/messages".into();
                    decode = ResponseDecode::AnthropicToResponses;
                    headers.insert("anthropic-version".into(), "2023-06-01".into());
                } else {
                    url = "https://api.openlux.ai/v1/responses".into();
                    if model.matches_scalar("gpt-5.6-sol")
                        && let Some(effort) = s::control(&s::path(&body, &["reasoning", "effort"]))
                    {
                        let suffix = match effort.as_str() {
                            "none" | "minimal" => "low",
                            "ultra" => "max",
                            other => other,
                        };
                        if ["low", "medium", "high", "xhigh", "max"].contains(&suffix) {
                            s::set(
                                &mut body,
                                "model",
                                s::text(&format!("gpt-5.6-sol-{suffix}")),
                            );
                            s::remove(&mut body, "reasoning");
                        }
                    }
                    if crate::anthropic::is_claude_model(&model) {
                        warnings.push("openlux_claude_native_prompt_cache_unavailable".into());
                    }
                }
            }
        }
        _ => {
            return Err(unavailable(
                "This provider has no Chat/Responses transport",
                "provider_route_unavailable",
            ));
        }
    }
    // Codex's whitelist already excludes this, so detect the source field after its projection.
    if surface == ClientSurface::Responses
        && provider == UpstreamProvider::ChatgptCodex
        && s::present(raw, "previous_response_id").is_some()
    {
        s::remove(&mut body, "previous_response_id");
        warnings.push("previous_response_id_ignored".into());
    }
    let plan = DecodePlan {
        provider,
        surface,
        decode,
        model: if surface == ClientSurface::Chat && direct {
            model.clone()
        } else {
            requested
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
        body: s::canonical(&body)?,
        decode: plan,
        warnings,
    })
}
fn source_prelude(
    provider: UpstreamProvider,
    surface: ClientSurface,
    raw: &SourceJson,
    selected_model: &ModelId,
    allowed_models: &[ModelId],
) -> s::Result<(SourceRequestDocument, bool, ModelId, ModelId)> {
    let document = SourceRequestDocument::new(raw.clone())?;
    let schema_surface = if surface == ClientSurface::Chat {
        RequestSurface::ChatCompletions
    } else {
        RequestSurface::Responses
    };
    let view = document.for_surface(schema_surface);
    // The caller owns the common envelope phase; selected-provider preparation must not repeat it.
    let native_openrouter = provider == UpstreamProvider::Openrouter;
    // OpenRouter's native wire uses `=== true`, not ordinary parse_stream.
    let client_stream = if native_openrouter {
        s::boolean(&s::get(raw, "stream")) == Some(true)
    } else if surface == ClientSurface::Responses {
        view.stream()?
    } else {
        false
    };
    let requested = match view.model_request()? {
        SourceModelRequest::Default => selected_model.clone(),
        SourceModelRequest::Named(name) => ModelId::from_source(name),
    };
    if surface == ClientSurface::Chat {
        view.max_completion_tokens()?;
    }
    let model =
        canonical_source_model(provider, selected_model, allowed_models).ok_or_else(|| {
            SourceRequestError::new(
                404,
                s::concat(&[
                    &JsString16::from_utf8("The model '"),
                    requested.as_js_string(),
                    &JsString16::from_utf8("' does not exist or is not available."),
                ]),
                "invalid_request_error",
                Some("model_not_found"),
                None,
            )
        })?;
    Ok((document, client_stream, requested, model))
}

impl PreparedClaudeOrdinary {
    /// Finish the one ordinary source phase before any selected-account capability lookup.
    pub fn prepare(
        surface: ClientSurface,
        original: &SourceJson,
        selected_model: &ModelId,
        options: &OrdinaryPhaseOptions,
    ) -> s::Result<Self> {
        let (_, stream, requested, model) = source_prelude(
            UpstreamProvider::ClaudeCode,
            surface,
            original,
            selected_model,
            &options.allowed_models,
        )?;
        prepare_claude_ordinary_resolved(surface, original, requested, model, stream, options)
    }
}
fn prepare_claude_ordinary_resolved(
    surface: ClientSurface,
    raw: &SourceJson,
    requested: ModelId,
    model: ModelId,
    mut client_stream: bool,
    options: &OrdinaryPhaseOptions,
) -> s::Result<PreparedClaudeOrdinary> {
    let normalized =
        controls::ordinary(raw, surface, &model, options.ordinary_preparation.as_ref())?;
    if surface == ClientSurface::Chat {
        client_stream = s::boolean(&s::get(&normalized, "stream")).unwrap_or(false);
    }
    // Syntax/default/mapping already ran in the shared coordinator. This is only
    // the exact data outcome used for account-bound lookup, never a proof.
    let effective_effort = json::member(&normalized, "reasoning")
        .and_then(|reasoning| json::member(&reasoning, "effort"))
        .as_ref()
        .and_then(json::string);
    Ok(PreparedClaudeOrdinary {
        normalized,
        surface,
        requested,
        model,
        client_stream,
        effective_effort,
    })
}
impl PreparedClaudeBody {
    /// Convenience API: the same single ordinary phase followed by native finalization.
    pub fn prepare(
        surface: ClientSurface,
        raw: &SourceJson,
        selected_model: &ModelId,
        options: &ClaudeBodyOptions,
    ) -> s::Result<Self> {
        let phase = PreparedClaudeOrdinary::prepare(
            surface,
            raw,
            selected_model,
            &OrdinaryPhaseOptions {
                allowed_models: options.allowed_models.clone(),
                ordinary_preparation: options.ordinary_preparation.clone(),
            },
        )?;
        Self::from_ordinary(phase, raw, options)
    }
    /// Consume the existing outcome once after real same-account capability selection.
    /// The caller retains the immutable original binding/echo; no normalization runs here.
    pub fn from_ordinary(
        phase: PreparedClaudeOrdinary,
        original: &SourceJson,
        options: &ClaudeBodyOptions,
    ) -> s::Result<Self> {
        let mut body = source_anthropic::native_claude(&phase.normalized, options).ok_or_else(|| invalid(
            "Claude request cannot be represented losslessly with the current credential/workspace capability proof",
            "reasoning",
        ))?;
        controls::claude_transport(&mut body, options.kind);
        let stream = s::boolean(&s::get(&body, "stream")) == Some(true);
        let body = s::canonical(&body)?;
        Ok(Self {
            body,
            kind: options.kind,
            stream,
            warnings: Vec::new(),
            decode: DecodePlan {
                provider: UpstreamProvider::ClaudeCode,
                surface: phase.surface,
                decode: ResponseDecode::AnthropicToResponses,
                model: phase.requested,
                upstream_model: phase.model,
                response_id: options.response_id.clone(),
                created_at: options.created_at,
                stream: phase.client_stream,
                request: original.clone(),
                tool_names: ToolMap::new(),
                reasoning_summary: options.reasoning_summary.clone(),
            },
        })
    }
}
fn prepare_claude_resolved(
    surface: ClientSurface,
    raw: &SourceJson,
    requested: ModelId,
    model: ModelId,
    client_stream: bool,
    options: &ClaudeBodyOptions,
) -> s::Result<PreparedClaudeBody> {
    let phase = prepare_claude_ordinary_resolved(
        surface,
        raw,
        requested,
        model,
        client_stream,
        &OrdinaryPhaseOptions {
            allowed_models: options.allowed_models.clone(),
            ordinary_preparation: options.ordinary_preparation.clone(),
        },
    )?;
    PreparedClaudeBody::from_ordinary(phase, raw, options)
}
fn finalize_scalar_claude(body: PreparedClaudeBody, auth: &AuthMaterial) -> PreparedRequest {
    let mut headers = bearer_headers(
        &auth.secret,
        if body.stream {
            "text/event-stream"
        } else {
            "application/json"
        },
    );
    headers.insert("anthropic-version".into(), "2023-06-01".into());
    if auth.api_key {
        headers.remove("Authorization");
        headers.insert("x-api-key".into(), auth.secret.clone());
    } else {
        headers.insert("anthropic-beta".into(), "oauth-2025-04-20".into());
    }
    if let Some(workspace) = &auth.workspace_id {
        headers.insert("anthropic-workspace-id".into(), workspace.clone());
    }
    PreparedRequest {
        provider: UpstreamProvider::ClaudeCode,
        url: body.url().into(),
        method: body.method().into(),
        headers,
        body: body.body,
        decode: body.decode,
        warnings: body.warnings,
    }
}
fn profile(provider: UpstreamProvider) -> ChatProfile {
    match provider {
        UpstreamProvider::Deepseek => ChatProfile::Deepseek,
        UpstreamProvider::Lithos => ChatProfile::Lithos,
        _ => ChatProfile::Cerebras,
    }
}
fn default_effort(profile: ChatProfile, model: &ModelId) -> &'static str {
    match profile {
        ChatProfile::Deepseek => "high",
        ChatProfile::Lithos => "medium",
        _ => {
            if model.matches_scalar("qwen-3.8-27b") {
                "high"
            } else {
                "medium"
            }
        }
    }
}
fn project_effort(value: &JsString16, profile: ChatProfile, param: &str) -> s::Result<SourceJson> {
    source_chat::effort(value, profile, param)
}
