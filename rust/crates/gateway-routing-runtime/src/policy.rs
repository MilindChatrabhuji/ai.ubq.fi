use crate::types::RoutingInput;
use chrono::{DateTime, Datelike, Utc};
use gateway_core::{
    GatewayError,
    provider::{CodexQuotaClass, PaidProvider, UpstreamProvider},
};
use gateway_providers::{
    ClientSurface,
    policy::{self, DeepseekHop, PaidRoutingInput, PaidRoutingPlan},
};
use gateway_schema::aliases;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub enum RouteHop {
    Direct {
        provider: UpstreamProvider,
        model: String,
    },
    Codex,
    Claude,
    Paid {
        provider: PaidProvider,
        model: String,
        synthetic: bool,
    },
}
#[derive(Clone, Debug)]
pub struct RoutePlan {
    pub model: String,
    pub hops: Vec<RouteHop>,
    pub synthetic: bool,
    pub paid: PaidRoutingPlan,
    pub quota_class: CodexQuotaClass,
}
pub(crate) fn admission_plan(input: &RoutingInput) -> RoutePlan {
    RoutePlan {
        model: input
            .raw
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
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
pub fn class(model: &str) -> CodexQuotaClass {
    // Match the source quota-class table, not a broad provider-name inference.
    let id = model.trim().to_ascii_lowercase();
    if id == "gpt-5.3-codex-spark" {
        CodexQuotaClass::Spark
    } else if id == "gpt-oss-120b" {
        CodexQuotaClass::GptOss120b
    } else if id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        == "gptreserve"
    {
        CodexQuotaClass::Reserve
    } else if id.is_empty() {
        CodexQuotaClass::Unknown
    } else {
        CodexQuotaClass::Standard
    }
}
fn ids(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter_map(|row| {
            row.get("id")
                .or_else(|| row.get("slug"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect()
}
pub fn provider_ids(input: &RoutingInput, provider: UpstreamProvider) -> Vec<String> {
    if provider == UpstreamProvider::ChatgptCodex {
        return input
            .catalog
            .codex()
            .map(|snapshot| {
                snapshot
                    .models
                    .iter()
                    .filter_map(|v| v.get("slug").and_then(Value::as_str).map(str::to_owned))
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
pub(crate) fn validate_model(
    input: &RoutingInput,
    model: &str,
    now: i64,
) -> Result<(), GatewayError> {
    let mut catalog = input.catalog.clone();
    catalog.snapshot = input.catalog.codex().cloned();
    let responses = input.surface != ClientSurface::Chat;
    let metadata = gateway_schema::catalog::request_model_metadata(&catalog, model, responses, now);
    gateway_schema::catalog::validate_model_available(model, responses, &metadata)
}
pub fn plan(input: &RoutingInput, now: i64) -> Result<RoutePlan, GatewayError> {
    let default = input
        .runtime
        .as_ref()
        .and_then(|r| r.get("default_model"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| input.catalog.codex().and_then(|s| s.default_model()));
    let model = gateway_schema::request::resolve_model(input.raw.get("model"), default.as_deref())?;
    if input.surface == ClientSurface::Chat && input.raw.get("thinking").is_some() {
        let requested = input.raw.get("model").and_then(Value::as_str).unwrap_or("");
        let direct = gateway_providers::request::canonical_model(UpstreamProvider::Deepseek, requested, &[]).is_some();
        if direct && !input.catalog.enabled("deepseek") {
            return Err(GatewayError::new(400,"The DeepSeek `thinking` extension requires the DeepSeek provider to be enabled; remove `thinking` or enable provider `deepseek`.",Some("invalid_request_error")).with_param(Some("thinking")));
        }
        if !direct {
            gateway_schema::request::validate_request_fields(&input.raw,gateway_schema::request::RequestSurface::ChatCompletions,&gateway_schema::request::RequestExtensions::default())?;
        }
    }
    let codex_known = model == "gpt-reserve"
        || input
            .catalog
            .codex()
            .is_some_and(|s| s.find(&model).is_some());
    let paid = policy::resolve_paid_route(&PaidRoutingInput {
        model: model.clone(),
        endpoint_type: endpoint(input.surface).into(),
        request_uses_tools: input
            .raw
            .get("tools")
            .and_then(Value::as_array)
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
    let synthetic = aliases::is_synthetic(&model);
    if synthetic {
        policy::validate_flash_effort(&input.raw)?;
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
        );
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
            if input.catalog.enabled(name)
                && let Some(served) = gateway_providers::request::canonical_model(
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
        if hops.is_empty() && model == "glm-5.2" && input.catalog.enabled("surplus") {
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
        ));
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
