//! Dynamic metadata resolution: source-specific reasoning precedence, widest sourced context.
use crate::{reasoning::advertised_effort, util::*};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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
    pub fn codex(record: &Value) -> Self {
        Self {
            context_window_tokens: positive_integer(record.get("context_window")),
            max_context_window_tokens: positive_integer(record.get("max_context_window")),
            auto_compact_token_limit_tokens: positive_integer(
                record.get("auto_compact_token_limit"),
            ),
            effective_context_window_percent: positive_integer(
                record.get("effective_context_window_percent"),
            ),
            supported_reasoning_levels: record
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .cloned(),
            default_reasoning_effort: record.get("default_reasoning_level").and_then(|v| {
                if v.is_null() {
                    Some("none".into())
                } else {
                    normalized_string(Some(v))
                }
            }),
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
            supported_reasoning_levels: Some(levels.iter().map(|s| json!(s)).collect()),
            default_reasoning_effort: Some(default.into()),
            ..Self::default()
        }
    }
    pub fn from_openrouter(record: &Value) -> Self {
        Self {
            context_window_tokens: positive_integer(record.get("context_window_tokens")),
            max_context_window_tokens: positive_integer(record.get("max_context_window_tokens")),
            supported_reasoning_levels: record
                .pointer("/reasoning/supported_efforts")
                .and_then(Value::as_array)
                .cloned(),
            default_reasoning_effort: normalized_string(
                record.pointer("/reasoning/default_effort"),
            ),
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
                push_unique(&mut list, effort);
            }
        }
        if let Some(effort) = &hint.default_reasoning_effort {
            push_unique(&mut list, effort.clone());
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
pub fn ascending_external_levels(levels: &[String]) -> Vec<String> {
    let order = [
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    let rank = |effort: &String| order.iter().position(|s| *s == effort.as_str());
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
