use crate::types::{RoutingInput, RoutingResult};
use chrono::{DateTime, Datelike, Utc};
use gateway_core::{
    GatewayError,
    model::ModelId,
    provider::{CodexQuotaClass, PaidProvider, UpstreamProvider},
    source_json::SourceJson,
    source_serialization as source,
};
use gateway_providers::{
    ClientSurface,
    policy::{self, DeepseekHop, PaidRoutingInput, PaidRoutingPlan},
};
use gateway_schema::{
    aliases,
    request::{RequestExtensions, RequestSurface},
    source_request::{SourceModelRequest, SourceRequestDocument, SourceRequestError},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum RouteHop {
    Direct {
        provider: UpstreamProvider,
        model: ModelId,
    },
    Codex,
    Claude,
    Paid {
        provider: PaidProvider,
        model: ModelId,
        synthetic: bool,
    },
}
#[derive(Clone, Debug)]
pub struct RoutePlan {
    pub model: ModelId,
    pub hops: Vec<RouteHop>,
    pub synthetic: bool,
    pub paid: PaidRoutingPlan,
    pub quota_class: CodexQuotaClass,
}
pub(crate) fn admission_plan(input: &RoutingInput) -> RoutePlan {
    RoutePlan {
        model: input
            .source_member("model")
            .and_then(|value| source::string(&value))
            .map(ModelId::from_source)
            .unwrap_or_else(|| ModelId::from_scalar("")),
        hops: Vec::new(),
        synthetic: false,
        paid: PaidRoutingPlan {
            providers: Vec::new(),
            paid_model_known: false,
            metered_only: true,
            codex_enabled: false,
            surplus_billing: None,
        },
        quota_class: CodexQuotaClass::Unknown,
    }
}
pub fn class(model: &ModelId) -> CodexQuotaClass {
    gateway_authority::routing::model_quota_class(model)
}
fn ids(rows: &[SourceJson]) -> Vec<ModelId> {
    rows.iter()
        .filter_map(|row| {
            source::member(row, "id")
                .or_else(|| source::member(row, "slug"))
                .and_then(|value| source::string(&value))
                .map(ModelId::from_source)
        })
        .collect()
}
pub fn provider_ids(input: &RoutingInput, provider: UpstreamProvider) -> Vec<ModelId> {
    if provider == UpstreamProvider::ChatgptCodex {
        return input
            .catalog
            .codex()
            .map(|snapshot| {
                snapshot
                    .models
                    .iter()
                    .filter_map(|value| {
                        source::member(value, "slug")
                            .and_then(|value| source::string(&value))
                            .map(ModelId::from_source)
                    })
                    .collect()
            })
            .unwrap_or_default();
    }
    ids(input.catalog.rows(match provider {
        UpstreamProvider::Metered => "openlux",
        UpstreamProvider::Surplus => "surplus",
        UpstreamProvider::Openrouter => "openrouter",
        UpstreamProvider::ClaudeCode => "claude_code",
        UpstreamProvider::Deepseek => "deepseek",
        UpstreamProvider::Lithos => "lithos",
        UpstreamProvider::Cerebras => "cerebras",
        _ => "",
    }))
}
pub(crate) fn validate_model(input: &RoutingInput, model: &ModelId, now: i64) -> RoutingResult<()> {
    let mut catalog = input.catalog.clone();
    catalog.snapshot = input.catalog.codex().cloned();
    let responses = input.surface != ClientSurface::Chat;
    let metadata = gateway_schema::catalog::request_model_metadata(&catalog, model, responses, now);
    gateway_schema::catalog::validate_model_available(model, responses, &metadata)
        .map_err(Into::into)
}
pub fn plan(
    input: &RoutingInput,
    now: i64,
    collator: &dyn aliases::SourceStringCollator,
) -> RoutingResult<RoutePlan> {
    let document = SourceRequestDocument::new(input.raw.clone())?;
    let surface = if input.surface == ClientSurface::Chat {
        RequestSurface::ChatCompletions
    } else {
        RequestSurface::Responses
    };
    let view = document.for_surface(surface);
    // The source peeks only to select envelope extensions/direct branches. Type/default
    // model validation remains later at its documented phase; no name is substituted.
    let requested = document.model_request().ok().and_then(|value| match value {
        SourceModelRequest::Named(name) => Some(ModelId::from_source(name)),
        SourceModelRequest::Default => None,
    });
    let deepseek_requested = requested.as_ref().is_some_and(|model| {
        gateway_providers::request::canonical_source_model(UpstreamProvider::Deepseek, model, &[])
            .is_some()
    });
    if input.surface == ClientSurface::Chat
        && input.source_member("thinking").is_some()
        && deepseek_requested
        && !input.catalog.enabled("deepseek")
    {
        return Err(SourceRequestError::invalid("The DeepSeek `thinking` extension requires the DeepSeek provider to be enabled; remove `thinking` or enable provider `deepseek`.",Some("thinking".into())).into());
    }
    let openrouter_cache_control = input.source_member("cache_control").is_some()
        && input.catalog.enabled("openrouter")
        && requested.as_ref().is_some_and(|model| {
            let units = model.as_js_string().as_units();
            (units.starts_with(&"anthropic/claude-".encode_utf16().collect::<Vec<_>>())
                || units.starts_with(&"~anthropic/claude-".encode_utf16().collect::<Vec<_>>()))
                && gateway_providers::request::canonical_source_model(
                    UpstreamProvider::Openrouter,
                    model,
                    &provider_ids(input, UpstreamProvider::Openrouter),
                )
                .is_some()
        });
    view.validate_fields(&RequestExtensions {
        deepseek_thinking: input.surface == ClientSurface::Chat
            && deepseek_requested
            && input.catalog.enabled("deepseek"),
        openrouter_cache_control,
    })?;
    let explicit_specialty = requested.as_ref().is_some_and(|model| {
        aliases::is_synthetic(model)
            || [
                ("deepseek", UpstreamProvider::Deepseek),
                ("lithos", UpstreamProvider::Lithos),
                ("cerebras", UpstreamProvider::Cerebras),
                ("openrouter", UpstreamProvider::Openrouter),
            ]
            .iter()
            .any(|(name, provider)| {
                input.catalog.enabled(name)
                    && gateway_providers::request::canonical_source_model(
                        *provider,
                        model,
                        &provider_ids(input, *provider),
                    )
                    .is_some()
            })
    });
    // Ordinary Responses stream syntax precedes model/default/availability. Direct
    // branches keep their own stream phase; OpenRouter deliberately uses === true.
    if input.surface == ClientSurface::Responses && !explicit_specialty {
        view.stream()?;
    }
    let model=match document.model_request()?{
        SourceModelRequest::Named(model)=>ModelId::from_source(model),
        SourceModelRequest::Default=>input.runtime.as_ref().and_then(|runtime|source::member(runtime,"default_model")).and_then(|value|source::string(&value)).map(ModelId::from_source)
            .or_else(||input.catalog.codex().and_then(|snapshot|snapshot.default_model()))
            .ok_or_else(||GatewayError::new(503,"Default model is unavailable: no configured default model or Codex model snapshot.",Some("server_error")))?,
    };
    if input.surface == ClientSurface::Chat {
        view.max_completion_tokens()?;
    }
    let codex_known = model.matches_scalar("gpt-reserve")
        || input
            .catalog
            .codex()
            .is_some_and(|s| s.find(&model).is_some());
    let paid = policy::resolve_paid_route(&PaidRoutingInput {
        model: model.clone(),
        endpoint_type: endpoint(input.surface).into(),
        request_uses_tools: input
            .source_member("tools")
            .and_then(|value| source::array(&value))
            .is_some_and(|a| !a.is_empty()),
        codex_model_known: codex_known,
        codex_enabled: input.catalog.enabled("codex"),
        surplus_enabled: input.catalog.enabled("surplus"),
        openlux_enabled: input.catalog.enabled("openlux"),
        surplus_configured: input.catalog.configured("surplus"),
        openlux_configured: input.catalog.configured("openlux"),
        surplus_catalog: input
            .catalog
            .providers
            .get("surplus")
            .map(|p| p.models.clone()),
        openlux_catalog: input
            .catalog
            .providers
            .get("openlux")
            .map(|p| p.models.clone()),
        allowed_paid_providers: None,
        synthetic_hop: None,
        ubiquity_enabled: input.catalog.enabled("ubiquity"),
    });
    let mut hops = vec![];
    let synthetic = input.surface == ClientSurface::Responses
        && requested.as_ref().is_some_and(aliases::is_synthetic);
    if synthetic {
        policy::validate_source_flash_effort(&input.raw)?;
        let year = DateTime::<Utc>::from_timestamp_millis(now)
            .map(|date| date.year())
            .filter(|year| *year >= 0)
            .ok_or_else(|| {
                GatewayError::unavailable("Routing clock is invalid.", "invalid_clock")
            })? as u32;
        let latest = aliases::resolve_flash_aliases(
            Some(input.catalog.rows("lithos")),
            Some(input.catalog.rows("openrouter")),
            Some(input.catalog.rows("surplus")),
            Some(input.catalog.rows("openlux")),
            year,
            collator,
        )?;
        let configured: Vec<_> = [
            ("lithos", DeepseekHop::Lithos),
            ("deepseek", DeepseekHop::Deepseek),
            ("openrouter", DeepseekHop::Openrouter),
            ("surplus", DeepseekHop::Surplus),
            ("openlux", DeepseekHop::Openlux),
        ]
        .into_iter()
        .filter(|(name, _)| input.catalog.configured(name))
        .map(|(_, hop)| hop)
        .collect();
        for hop in policy::deepseek_plan(&configured, input.catalog.enabled("ubiquity")) {
            hops.push(match hop {
                DeepseekHop::Lithos => RouteHop::Direct {
                    provider: UpstreamProvider::Lithos,
                    model: latest.lithos.clone(),
                },
                DeepseekHop::Deepseek => RouteHop::Direct {
                    provider: UpstreamProvider::Deepseek,
                    model: latest.deepseek.clone(),
                },
                DeepseekHop::Openrouter => RouteHop::Direct {
                    provider: UpstreamProvider::Openrouter,
                    model: latest.openrouter.clone(),
                },
                DeepseekHop::Surplus => RouteHop::Paid {
                    provider: PaidProvider::Surplus,
                    model: latest.surplus.clone(),
                    synthetic: true,
                },
                DeepseekHop::Openlux => RouteHop::Paid {
                    provider: PaidProvider::Metered,
                    model: latest.openlux.clone(),
                    synthetic: true,
                },
            });
        }
    } else {
        let providers = if input.surface == ClientSurface::Chat {
            vec![
                ("cerebras", UpstreamProvider::Cerebras),
                ("deepseek", UpstreamProvider::Deepseek),
                ("lithos", UpstreamProvider::Lithos),
                ("openrouter", UpstreamProvider::Openrouter),
            ]
        } else {
            vec![
                ("deepseek", UpstreamProvider::Deepseek),
                ("lithos", UpstreamProvider::Lithos),
                ("cerebras", UpstreamProvider::Cerebras),
                ("openrouter", UpstreamProvider::Openrouter),
            ]
        };
        for (name, provider) in providers {
            if (input.surface == ClientSurface::Chat || requested.is_some())
                && input.catalog.enabled(name)
                && let Some(served) = gateway_providers::request::canonical_source_model(
                    provider,
                    &model,
                    &provider_ids(input, provider),
                )
            {
                hops.push(RouteHop::Direct {
                    provider,
                    model: served,
                });
                break;
            }
        }
        if hops.is_empty() && model.matches_scalar("glm-5.2") && input.catalog.enabled("surplus") {
            hops.push(RouteHop::Direct {
                provider: UpstreamProvider::Surplus,
                model: model.clone(),
            });
        }
        if hops.is_empty() {
            validate_model(input, &model, now)?;
            hops.push(RouteHop::Claude);
            if matches!(policy::paid_entry(&paid), policy::PaidEntry::CodexPrimary) {
                hops.push(RouteHop::Codex);
            }
            for provider in &paid.providers {
                hops.push(RouteHop::Paid {
                    provider: *provider,
                    model: model.clone(),
                    synthetic: false,
                });
            }
        }
    }
    if hops.is_empty() {
        return Err(GatewayError::unavailable(
            "No configured provider can serve this model.",
            "provider_routing_unavailable",
        )
        .into());
    }
    Ok(RoutePlan {
        quota_class: class(&model),
        model,
        hops,
        synthetic,
        paid,
    })
}

pub fn endpoint(surface: ClientSurface) -> &'static str {
    if surface == ClientSurface::Chat {
        "openai"
    } else {
        "openai-response"
    }
}
