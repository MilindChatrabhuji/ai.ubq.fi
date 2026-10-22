//! Routing policy only. Authoritative pool/credential/paid admission remains external.
use crate::source as s;
use gateway_core::{
    js_string::JsString16,
    model::ModelId,
    provider::{PaidProvider, UpstreamProvider},
    source_json::SourceJson,
    source_serialization as source,
};
use serde_json::Value;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HopFailure {
    Status(u16),
    Transport,
    StreamBeforeSemantic,
    Cancelled,
    Deadline,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HopDecision {
    Advance,
    Deliver,
    Abort,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeepseekHop {
    Lithos,
    Deepseek,
    Openrouter,
    Surplus,
    Openlux,
}
pub const DEEPSEEK_ORDER: [DeepseekHop; 5] = [
    DeepseekHop::Lithos,
    DeepseekHop::Deepseek,
    DeepseekHop::Openrouter,
    DeepseekHop::Surplus,
    DeepseekHop::Openlux,
];
pub fn deepseek_decision(failure: HopFailure, semantic_committed: bool) -> HopDecision {
    match failure {
        HopFailure::Cancelled | HopFailure::Deadline => HopDecision::Abort,
        _ if semantic_committed => HopDecision::Deliver,
        HopFailure::Status(status) if status >= 500 || [429, 402, 403].contains(&status) => {
            HopDecision::Advance
        }
        HopFailure::Transport | HopFailure::StreamBeforeSemantic => HopDecision::Advance,
        _ => HopDecision::Deliver,
    }
}
pub fn paid_should_advance(status: Option<u16>, has_later_tier: bool) -> bool {
    has_later_tier && matches!(status, Some(402 | 429))
}
pub fn codex_paid_fallback_reason(
    status: u16,
    trusted_error: Option<&str>,
) -> Option<&'static str> {
    match (status, trusted_error) {
        (429, Some("codex_quota_blocked")) => Some("primary_quota_blocked"),
        (401 | 503, Some("codex_subscriptions_unavailable")) => {
            Some("primary_subscriptions_unavailable")
        }
        _ => None,
    }
}
pub fn paid_order(surplus: bool, openlux: bool) -> Vec<PaidProvider> {
    [
        surplus.then_some(PaidProvider::Surplus),
        openlux.then_some(PaidProvider::Metered),
    ]
    .into_iter()
    .flatten()
    .collect()
}
pub fn paid_hop_identity(request_id: &str, provider: PaidProvider) -> String {
    format!(
        "{request_id}:deepseek_waterfall:{}",
        if provider == PaidProvider::Surplus {
            "surplus"
        } else {
            "openlux"
        }
    )
}
pub fn response_has_answer(value: &Value) -> bool {
    crate::source_policy::response_has_answer(&crate::source::generated(value))
}
pub fn item_has_answer(value: &Value) -> bool {
    crate::source_policy::item_has_answer(&crate::source::generated(value))
}
fn nonempty(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|v| !v.is_empty())
}
pub fn semantic_event(value: &Value) -> bool {
    crate::source_policy::semantic_event(&crate::source::generated(value))
}
pub fn reasoning_progress(value: &Value) -> bool {
    crate::source_policy::reasoning_progress(&crate::source::generated(value))
}
pub fn chat_has_answer(value: &Value) -> bool {
    value
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|c| {
                let m = c
                    .get("message")
                    .or_else(|| c.get("delta"))
                    .unwrap_or(&Value::Null);
                nonempty(m.get("content"))
                    || nonempty(m.get("refusal"))
                    || m.get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|t| !t.is_empty())
            })
        })
}
/// Lithos refusal windows are per rung, not one deadline per original request model.
#[derive(Clone, Debug, Default)]
pub struct LithosWindows {
    deadlines: std::collections::BTreeMap<ModelId, i64>,
}
pub fn lithos_ladder(model: &ModelId) -> Vec<ModelId> {
    let model = lithos_canonical(model);
    let family = if s::starts(model.as_js_string(), "deepseek-ai/DeepSeek-V4.1-Flash") {
        "deepseek-ai/DeepSeek-V4.1-Flash"
    } else if s::starts(model.as_js_string(), "moonshotai/Kimi-K3") {
        "moonshotai/Kimi-K3"
    } else {
        return vec![];
    };
    if model.matches_scalar(&format!("{family}-ultra")) {
        vec![
            ModelId::from_scalar(&format!("{family}-fast")),
            ModelId::from_scalar(family),
        ]
    } else if model.matches_scalar(&format!("{family}-fast")) {
        vec![ModelId::from_scalar(family)]
    } else {
        vec![]
    }
}
pub fn lithos_canonical(model: &ModelId) -> ModelId {
    let value = s::trim(model.as_js_string());
    crate::request::LITHOS_MODELS
        .iter()
        .find(|known| {
            let literal = known.encode_utf16().collect::<Vec<_>>();
            value.as_units().len() == literal.len()
                && value.as_units().iter().zip(literal).all(|(&left, right)| {
                    let lower = |unit: u16| {
                        if (65..=90).contains(&unit) {
                            unit + 32
                        } else {
                            unit
                        }
                    };
                    lower(left) == lower(right)
                })
        })
        .map_or_else(
            || ModelId::from_source(value),
            |known| ModelId::from_scalar(known),
        )
}
impl LithosWindows {
    pub fn refuse(&mut self, rung: &ModelId, now: i64, wait_ms: i64) {
        if wait_ms > 0
            && let Some(deadline) = now.checked_add(wait_ms)
        {
            let row = self
                .deadlines
                .entry(lithos_canonical(rung))
                .or_insert(deadline);
            *row = (*row).max(deadline);
        }
    }
    pub fn select(&self, model: &ModelId, now: i64) -> ModelId {
        self.eligible(model, now, &Default::default(), &Default::default())
            .unwrap_or_else(|| lithos_canonical(model))
    }
    pub fn eligible(
        &self,
        model: &ModelId,
        now: i64,
        no_retry: &std::collections::BTreeSet<ModelId>,
        attempted: &std::collections::BTreeSet<ModelId>,
    ) -> Option<ModelId> {
        let canonical = lithos_canonical(model);
        std::iter::once(canonical.clone())
            .chain(lithos_ladder(&canonical))
            .find(|rung| {
                !no_retry.contains(rung)
                    && !attempted.contains(rung)
                    && self
                        .deadlines
                        .get(rung)
                        .is_none_or(|deadline| *deadline <= now)
            })
    }
    pub fn retry_eligible(
        &self,
        model: &ModelId,
        no_retry: &std::collections::BTreeSet<ModelId>,
    ) -> Option<ModelId> {
        let canonical = lithos_canonical(model);
        std::iter::once(canonical.clone())
            .chain(lithos_ladder(&canonical))
            .find(|rung| !no_retry.contains(rung))
    }
}
#[derive(Clone, Copy, Debug)]
pub struct WaitBudget {
    pub waits: u8,
    pub waited_ms: i64,
    pub streamed: bool,
}
impl WaitBudget {
    pub fn claim(&mut self, wait_ms: i64, retry_prohibited: bool) -> bool {
        let (max_waits, total) = if self.streamed {
            (5, 300_000)
        } else {
            (2, 120_000)
        };
        if retry_prohibited
            || wait_ms <= 0
            || wait_ms > 75_000
            || self.waits >= max_waits
            || self.waited_ms.saturating_add(wait_ms) > total
        {
            return false;
        };
        self.waits += 1;
        self.waited_ms += wait_ms;
        true
    }
}
pub fn direct_provider_label(provider: UpstreamProvider) -> &'static str {
    match provider {
        UpstreamProvider::ChatgptCodex => "chatgpt_codex",
        UpstreamProvider::ClaudeCode => "claude_code",
        UpstreamProvider::Deepseek => "deepseek",
        UpstreamProvider::Cerebras => "cerebras",
        UpstreamProvider::Lithos => "lithos",
        UpstreamProvider::Openrouter => "openrouter",
        UpstreamProvider::RemovedProvider => "removed_provider",
        UpstreamProvider::Metered => "metered",
        UpstreamProvider::Surplus => "surplus",
        UpstreamProvider::Voyage => "voyage",
    }
}
/// Catalog/capability evidence used by the existing paid router, before authority admission.
#[derive(Clone, Debug)]
pub struct PaidRoutingInput {
    pub model: ModelId,
    pub endpoint_type: String,
    pub request_uses_tools: bool,
    pub codex_model_known: bool,
    pub codex_enabled: bool,
    pub surplus_enabled: bool,
    pub openlux_enabled: bool,
    pub surplus_configured: bool,
    pub openlux_configured: bool,
    pub surplus_catalog: Option<Vec<SourceJson>>,
    pub openlux_catalog: Option<Vec<SourceJson>>,
    pub allowed_paid_providers: Option<Vec<PaidProvider>>,
    /// Server-owned scope; never derive this from a client JSON field.
    pub synthetic_hop: Option<DeepseekHop>,
    pub ubiquity_enabled: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct PaidRoutingPlan {
    pub providers: Vec<PaidProvider>,
    pub paid_model_known: bool,
    pub metered_only: bool,
    pub codex_enabled: bool,
    pub surplus_billing: Option<SourceJson>,
}
fn supports_endpoint(row: Option<&SourceJson>, endpoint: &str) -> bool {
    row.and_then(|row| source::array(&s::get(row, "supported_endpoint_types")))
        .is_some_and(|values| values.iter().any(|value| s::is(value, endpoint)))
}
fn valid_price(value: &SourceJson) -> Option<f64> {
    source::number(value).filter(|value| value.is_finite() && *value >= 0.0)
}
fn flash_paid_id(model: &ModelId) -> bool {
    // Only the finite ASCII slug grammar is observed; an opaque vendor prefix remains untouched.
    let units = model
        .as_js_string()
        .as_units()
        .rsplit(|&unit| unit == 47)
        .next()
        .unwrap_or_default();
    let Ok(slug) = String::from_utf16(units) else {
        return false;
    };
    let slug = slug.to_lowercase();
    let Some(rest) = slug.strip_prefix("deepseek-v") else {
        return false;
    };
    let Some((version, tail)) = rest.split_once("-flash") else {
        return false;
    };
    !version.is_empty()
        && version.chars().all(|c| c.is_ascii_digit() || c == '.')
        && (tail.is_empty()
            || tail.strip_prefix('-').is_some_and(|d| {
                (d.len() == 4 || d.len() == 8) && d.chars().all(|c| c.is_ascii_digit())
            }))
}
fn row_matches(row: &SourceJson, model: &ModelId) -> bool {
    source::string(&s::get(row, "id")).is_some_and(|id| id == *model.as_js_string())
}
pub fn resolve_paid_route(input: &PaidRoutingInput) -> PaidRoutingPlan {
    let surplus = input
        .surplus_catalog
        .as_ref()
        .and_then(|a| a.iter().find(|row| row_matches(row, &input.model)));
    let openlux = input
        .openlux_catalog
        .as_ref()
        .and_then(|a| a.iter().find(|row| row_matches(row, &input.model)));
    let pinned = match input.synthetic_hop {
        Some(DeepseekHop::Surplus) => Some(PaidProvider::Surplus),
        Some(DeepseekHop::Openlux) => Some(PaidProvider::Metered),
        _ => None,
    };
    let verified_hop = flash_paid_id(&input.model)
        && input.endpoint_type == "openai-response"
        && input.ubiquity_enabled
        && pinned.is_some()
        && input
            .allowed_paid_providers
            .as_ref()
            .is_some_and(|a| a.len() == 1 && a.first() == pinned.as_ref());
    let openlux_route = supports_endpoint(openlux, &input.endpoint_type)
        || (verified_hop
            && pinned == Some(PaidProvider::Metered)
            && supports_endpoint(openlux, "openai"));
    let surplus_route = supports_endpoint(surplus, &input.endpoint_type);
    let surplus_billing = surplus.and_then(|row| {
        let input_price = valid_price(&s::get(row, "input_price_per_token"))?;
        let output_price = valid_price(&s::get(row, "output_price_per_token"))?;
        let mut value = s::object(vec![
            ("input_price_per_token", s::generated(&input_price)),
            ("output_price_per_token", s::generated(&output_price)),
        ]);
        for key in ["cache_read_price_per_token", "cache_write_price_per_token"] {
            if let Some(price) = source::member(row, key) {
                s::set(&mut value, key, price);
            }
        }
        Some(value)
    });
    let surplus_ok = (input.surplus_enabled
        || (verified_hop && pinned == Some(PaidProvider::Surplus)))
        && input.surplus_configured
        && surplus_route
        && surplus_billing.is_some()
        && (!input.request_uses_tools
            || surplus.is_some_and(|row| s::boolean(&s::get(row, "supports_tools")) == Some(true)));
    let openlux_ok = (input.openlux_enabled
        || (verified_hop && pinned == Some(PaidProvider::Metered)))
        && input.openlux_configured
        && if input.openlux_catalog.is_none() {
            input.codex_model_known
        } else {
            openlux_route
        };
    let providers = paid_order(surplus_ok, openlux_ok)
        .into_iter()
        .filter(|p| {
            input
                .allowed_paid_providers
                .as_ref()
                .is_none_or(|a| a.contains(p))
        })
        .collect::<Vec<_>>();
    PaidRoutingPlan {
        metered_only: !providers.is_empty() && !input.codex_model_known,
        providers,
        paid_model_known: openlux_route || surplus_route,
        codex_enabled: input.codex_enabled,
        surplus_billing,
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PaidEntry {
    CodexPrimary,
    Direct(PaidProvider),
    Disabled,
}
pub fn paid_entry(plan: &PaidRoutingPlan) -> PaidEntry {
    if plan.metered_only || !plan.codex_enabled {
        plan.providers
            .first()
            .copied()
            .map(PaidEntry::Direct)
            .unwrap_or(PaidEntry::Disabled)
    } else {
        PaidEntry::CodexPrimary
    }
}
pub fn validate_flash_effort(raw: &Value) -> Result<(), gateway_core::GatewayError> {
    validate_source_flash_effort(&s::generated(raw)).map_err(s::scalar_error)
}
pub fn validate_source_flash_effort(
    raw: &SourceJson,
) -> Result<(), gateway_schema::source_request::SourceRequestError> {
    let effort = source::string(&s::path(raw, &["reasoning", "effort"]))
        .filter(|value| !s::trim(value).as_units().is_empty())
        .or_else(|| {
            source::string(&s::get(raw, "reasoning_effort"))
                .filter(|value| !s::trim(value).as_units().is_empty())
        });
    if let Some(effort) = effort
        && !["low", "high", "max"].iter().any(|level| {
            s::trim(&effort)
                .as_units()
                .iter()
                .copied()
                .eq(level.encode_utf16())
        })
    {
        return Err(gateway_schema::source_request::SourceRequestError::new(
            400,
            s::concat(&[
                &JsString16::from_utf8(
                    "The model 'ubiquity/deepseek-flash' supports reasoning efforts low, high, max; '",
                ),
                &effort,
                &JsString16::from_utf8("' is not supported."),
            ]),
            "invalid_request_error",
            Some("unsupported_reasoning_effort"),
            Some(Some(JsString16::from_utf8("reasoning.effort"))),
        ));
    }
    Ok(())
}
pub fn deepseek_plan(configured: &[DeepseekHop], ubiquity_enabled: bool) -> Vec<DeepseekHop> {
    if !ubiquity_enabled {
        return vec![];
    }
    DEEPSEEK_ORDER
        .into_iter()
        .filter(|p| configured.contains(p))
        .collect()
}
