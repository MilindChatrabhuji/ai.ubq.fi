//! Dynamic metadata resolution: source-specific reasoning precedence, widest sourced context.
use crate::{reasoning::advertised_effort, util::*};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MetadataHint {
    pub context_window_tokens: Option<i64>,
    pub max_context_window_tokens: Option<i64>,
    pub auto_compact_token_limit_tokens: Option<i64>,
    pub effective_context_window_percent: Option<i64>,
    pub supported_reasoning_levels: Option<Vec<SourceJson>>,
    pub default_reasoning_effort: Option<JsString16>,
}
impl MetadataHint {
    pub fn codex(record: &SourceJson) -> Self {
        use crate::model_control as c;
        Self {
            context_window_tokens: c::positive(c::get(record, "context_window").as_ref()),
            max_context_window_tokens: c::positive(c::get(record, "max_context_window").as_ref()),
            auto_compact_token_limit_tokens: c::positive(
                c::get(record, "auto_compact_token_limit").as_ref(),
            ),
            effective_context_window_percent: c::positive(
                c::get(record, "effective_context_window_percent").as_ref(),
            ),
            supported_reasoning_levels: c::get(record, "supported_reasoning_levels")
                .as_ref()
                .and_then(c::array),
            default_reasoning_effort: c::get(record, "default_reasoning_level").as_ref().and_then(
                |v| {
                    if v.as_str() == "null" {
                        Some("none".into())
                    } else {
                        c::normalized(Some(v))
                    }
                },
            ),
        }
    }
    pub fn subscription() -> Self {
        Self {
            context_window_tokens: Some(272_000),
            max_context_window_tokens: Some(872_000),
            ..Self::default()
        }
    }
    pub fn provider(window: i64, levels: &[&str], default: &str) -> Self {
        Self {
            context_window_tokens: Some(window),
            max_context_window_tokens: Some(window),
            supported_reasoning_levels: Some(
                levels.iter().map(crate::model_control::json).collect(),
            ),
            default_reasoning_effort: Some(default.into()),
            ..Self::default()
        }
    }
    pub fn from_openrouter(record: &SourceJson) -> Self {
        use crate::model_control as c;
        let reasoning = c::get(record, "reasoning");
        Self {
            context_window_tokens: c::positive(c::get(record, "context_window_tokens").as_ref()),
            max_context_window_tokens: c::positive(
                c::get(record, "max_context_window_tokens").as_ref(),
            ),
            supported_reasoning_levels: reasoning
                .as_ref()
                .and_then(|r| c::get(r, "supported_efforts"))
                .as_ref()
                .and_then(c::array),
            default_reasoning_effort: reasoning
                .as_ref()
                .and_then(|r| c::get(r, "default_effort"))
                .as_ref()
                .and_then(|v| c::normalized(Some(v))),
            ..Self::default()
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct MetadataSources {
    pub codex: Option<MetadataHint>,
    pub subscription: Option<MetadataHint>,
    pub provider: Option<MetadataHint>,
    pub openrouter: Option<MetadataHint>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedMetadata {
    pub context_window_tokens: Option<i64>,
    pub max_context_window_tokens: Option<i64>,
    pub auto_compact_token_limit_tokens: Option<i64>,
    pub effective_context_window_percent: Option<i64>,
    pub supported_reasoning_levels: Option<Vec<JsString16>>,
    pub default_reasoning_effort: Option<JsString16>,
    pub context_source: String,
    pub reasoning_source: String,
}
pub fn resolved_auto_compact(window: i64, configured: Option<i64>) -> i64 {
    if let Some(n) = configured.filter(|n| *n > 0 && *n <= window) {
        return n;
    }
    if window > 50_000 {
        ((window as f64 * 0.85).floor() as i64).min(window - 50_000)
    } else {
        1.max((window - 1).min((window as f64 * 0.85).floor() as i64))
    }
}
fn first_positive(values: impl IntoIterator<Item = Option<i64>>) -> Option<i64> {
    values
        .into_iter()
        .flatten()
        .find(|n| *n > 0 && (*n as f64) <= MAX_SAFE_INTEGER)
}
fn window(hint: Option<&MetadataHint>) -> Option<i64> {
    hint.and_then(|h| first_positive([h.context_window_tokens, h.max_context_window_tokens]))
}
pub fn resolve_metadata(sources: &MetadataSources) -> ResolvedMetadata {
    let subscription = if window(sources.codex.as_ref()).is_none() {
        sources.subscription.as_ref()
    } else {
        None
    };
    let candidates = [
        ("openrouter", sources.openrouter.as_ref()),
        ("codex_upload", sources.codex.as_ref()),
        ("provider_discovery", sources.provider.as_ref()),
        ("codex_subscription", subscription),
    ];
    let mut context = None;
    let mut context_source = "unknown";
    let mut maximum = None;
    for (source, hint) in candidates {
        if let Some(count) = window(hint)
            && context.is_none_or(|n| count > n)
        {
            context = Some(count);
            context_source = source;
        }
        if let Some(count) = hint
            .and_then(|h| h.max_context_window_tokens)
            .filter(|n| *n > 0 && (*n as f64) <= MAX_SAFE_INTEGER)
        {
            maximum = Some(maximum.map_or(count, |n: i64| n.max(count)));
        }
    }
    if let Some(context) = context {
        maximum = Some(maximum.map_or(context, |n| n.max(context)));
    }
    let mut levels = None;
    let mut default = None;
    let mut reasoning_source = "unknown";
    for (source, hint) in [
        ("codex_upload", sources.codex.as_ref()),
        ("provider_discovery", sources.provider.as_ref()),
        ("openrouter", sources.openrouter.as_ref()),
    ] {
        let Some(hint) = hint else {
            continue;
        };
        let mut list = Vec::new();
        if let Some(raw) = &hint.supported_reasoning_levels {
            for effort in raw.iter().filter_map(advertised_effort) {
                crate::model_control::push_unique(&mut list, effort);
            }
        }
        if let Some(effort) = &hint.default_reasoning_effort {
            crate::model_control::push_unique(&mut list, effort.clone());
        }
        if !list.is_empty() {
            levels = Some(list);
            default = hint.default_reasoning_effort.clone();
            reasoning_source = source;
            break;
        }
    }
    let configured = first_positive([
        sources
            .codex
            .as_ref()
            .and_then(|h| h.auto_compact_token_limit_tokens),
        sources
            .provider
            .as_ref()
            .and_then(|h| h.auto_compact_token_limit_tokens),
    ]);
    let percent = first_positive([sources
        .codex
        .as_ref()
        .and_then(|h| h.effective_context_window_percent)
        .or_else(|| {
            sources
                .provider
                .as_ref()
                .and_then(|h| h.effective_context_window_percent)
        })]);
    ResolvedMetadata {
        context_window_tokens: context,
        max_context_window_tokens: maximum,
        auto_compact_token_limit_tokens: context
            .map(|w| resolved_auto_compact(w, configured))
            .or(configured),
        effective_context_window_percent: percent.or_else(|| context.map(|_| 95)),
        supported_reasoning_levels: levels,
        default_reasoning_effort: default,
        context_source: context_source.into(),
        reasoning_source: reasoning_source.into(),
    }
}
pub fn ascending_external_levels(levels: &[JsString16]) -> Vec<JsString16> {
    let order = [
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    let rank = |effort: &JsString16| {
        order
            .iter()
            .position(|s| crate::model_control::matches(effort, s))
    };
    let mut standard: Vec<_> = levels
        .iter()
        .filter(|e| rank(e).is_some())
        .cloned()
        .collect();
    standard.sort_by_key(|e| rank(e));
    let mut iter = standard.into_iter();
    levels
        .iter()
        .map(|e| {
            if rank(e).is_some() {
                iter.next().unwrap_or_else(|| e.clone())
            } else {
                e.clone()
            }
        })
        .collect()
}
