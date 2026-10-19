//! Latest Flash aliases resolve only from injected cached catalog observations.
use gateway_core::{GatewayError, js_string::JsString16, model::ModelId, source_json::SourceJson};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
/// Constructor-owned synchronous source locale ordering; no model or authority normalization.
pub trait SourceStringCollator: Send + Sync {
    fn compare(&self, left: &JsString16, right: &JsString16) -> Result<Ordering, GatewayError>;
}
impl<T: SourceStringCollator + ?Sized> SourceStringCollator for std::sync::Arc<T> {
    fn compare(&self, left: &JsString16, right: &JsString16) -> Result<Ordering, GatewayError> {
        (**self).compare(left, right)
    }
}
/// Stable fallible merge sort. Comparator failure escapes before any result is published.
pub fn sort_source<T, F>(mut values: Vec<T>, compare: &F) -> Result<Vec<T>, GatewayError>
where
    F: Fn(&T, &T) -> Result<Ordering, GatewayError>,
{
    if values.len() < 2 {
        return Ok(values);
    }
    let right = values.split_off(values.len() / 2);
    let left = sort_source(values, compare)?;
    let right = sort_source(right, compare)?;
    let mut out = Vec::with_capacity(left.len() + right.len());
    let mut left = left.into_iter().peekable();
    let mut right = right.into_iter().peekable();
    while let (Some(a), Some(b)) = (left.peek(), right.peek()) {
        if compare(a, b)? != Ordering::Greater {
            out.push(left.next().expect("left present"));
        } else {
            out.push(right.next().expect("right present"));
        }
    }
    out.extend(left);
    out.extend(right);
    Ok(out)
}
pub const SYNTHETIC_MODEL: &str = "ubiquity/deepseek-flash";
pub const LEGACY_SYNTHETIC_MODEL: &str = "ubiquity/deepseek-v4.1-flash";
pub const FLASH_ORDER: &[&str] = &["lithos", "deepseek", "openrouter", "surplus", "openlux"];
pub const LITHOS_IDS: &[&str] = &[
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4.1-Flash-fast",
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra",
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat",
    "moonshotai/Kimi-K3",
    "moonshotai/Kimi-K3-fast",
    "moonshotai/Kimi-K3-ultra",
    "moonshotai/Kimi-K3-ultra-chat",
];
pub const DEEPSEEK_IDS: &[&str] = &["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"];
fn lower_units(model: &ModelId) -> Vec<u16> {
    let units = crate::source_request::trim(model.as_js_string());
    gateway_core::js_string_case::lowercase_source(&units)
        .as_units()
        .to_vec()
}
pub fn direct_deepseek_model(model: &ModelId) -> Option<ModelId> {
    let lower = lower_units(model);
    let same = |s: &str| lower.iter().copied().eq(s.encode_utf16());
    if same("deepseek-flash") || same("deepseek-v4-flash") {
        Some("deepseek-flash".into())
    } else if same("deepseek-v4-pro") {
        Some("deepseek-v4-pro".into())
    } else {
        None
    }
}
pub fn is_synthetic(model: &ModelId) -> bool {
    let lower = lower_units(model);
    [SYNTHETIC_MODEL, LEGACY_SYNTHETIC_MODEL]
        .iter()
        .any(|literal| lower.iter().copied().eq(literal.encode_utf16()))
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FlashAliases {
    pub lithos: ModelId,
    pub deepseek: ModelId,
    pub openrouter: ModelId,
    pub surplus: ModelId,
    pub openlux: ModelId,
}
impl Default for FlashAliases {
    fn default() -> Self {
        Self {
            lithos: LITHOS_IDS[0].into(),
            deepseek: "deepseek-flash".into(),
            openrouter: "~deepseek/deepseek-flash-latest".into(),
            surplus: "deepseek-v4.1-flash".into(),
            openlux: "deepseek-v4.1-flash".into(),
        }
    }
}

#[derive(Clone, Debug)]
struct FlashCandidate {
    version: String,
    parts: Vec<f64>,
    date: u32,
}
fn candidate(id: &str, year: u32) -> Option<FlashCandidate> {
    let lower = crate::util::js_trim(id).to_ascii_lowercase();
    let words: Vec<_> = lower.split(['-', ':']).collect();
    if [
        "fast", "ultra", "chat", "vision", "exp", "web", "e2ee", "free", "batch",
    ]
    .iter()
    .any(|v| words.contains(v))
    {
        return None;
    }
    let slug = lower.rsplit('/').next()?;
    let after = slug.strip_prefix("deepseek-v")?;
    let (version, date) = after.split_once("-flash")?;
    let raw: Vec<_> = version.split('.').collect();
    if raw.is_empty()
        || raw.len() > 2
        || raw
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let parts = raw
        .into_iter()
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let order = if date.is_empty() {
        0
    } else {
        let date = date.strip_prefix('-')?;
        if ![4, 8].contains(&date.len()) || !date.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let (y, m, d) = if date.len() == 8 {
            (
                date[0..4].parse::<u32>().ok()?,
                date[4..6].parse::<u32>().ok()?,
                date[6..8].parse::<u32>().ok()?,
            )
        } else {
            (
                year,
                date[0..2].parse::<u32>().ok()?,
                date[2..4].parse::<u32>().ok()?,
            )
        };
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return None;
        }
        y * 10000 + m * 100 + d
    };
    Some(FlashCandidate {
        version: version.into(),
        parts,
        date: order,
    })
}
fn compare_candidates(left: &FlashCandidate, right: &FlashCandidate) -> f64 {
    for i in 0..left.parts.len().max(right.parts.len()) {
        let difference =
            left.parts.get(i).copied().unwrap_or(0.0) - right.parts.get(i).copied().unwrap_or(0.0);
        if difference != 0.0 {
            return difference;
        }
    }
    f64::from(left.date) - f64::from(right.date)
}
fn latest_alias_id(id: &str) -> bool {
    if !id.starts_with('~') {
        return false;
    }
    let lower = id.to_ascii_lowercase();
    lower.match_indices("deepseek").any(|(index, _)| {
        if index > 0 && !matches!(lower.as_bytes()[index - 1], b'/' | b'-') {
            return false;
        }
        let rest = &lower[index..];
        rest == "deepseek-flash-latest"
            || rest
                .strip_prefix("deepseek-v")
                .and_then(|s| s.strip_suffix("-flash-latest"))
                .is_some_and(|s| {
                    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                })
    })
}
fn latest_source(id: &ModelId) -> bool {
    let lower = lower_units(id);
    if lower.first() != Some(&126) {
        return false;
    }
    let pattern = "deepseek".encode_utf16().collect::<Vec<_>>();
    for index in 0..lower.len() {
        if !lower[index..].starts_with(&pattern)
            || (index > 0 && !matches!(lower[index - 1], 47 | 45))
        {
            continue;
        }
        let suffix = &lower[index..];
        if !suffix.iter().all(|u| *u < 128) {
            continue;
        }
        let suffix = suffix
            .iter()
            .map(|u| char::from(*u as u8))
            .collect::<String>();
        if latest_alias_id(&format!("~/{suffix}")) {
            return true;
        }
    }
    false
}
fn simple_source(id: &ModelId) -> bool {
    let units = id.as_js_string().as_units();
    if units.first() != Some(&126) {
        return false;
    }
    let Some(slash) = units.iter().position(|u| *u == 47) else {
        return false;
    };
    if slash == 1
        || !units[1..slash].iter().all(|u| {
            u8::try_from(*u)
                .ok()
                .is_some_and(|u| u.is_ascii_alphanumeric() || u == b'_')
        })
    {
        return false;
    }
    units[slash + 1..]
        .iter()
        .copied()
        .map(|u| if (65..=90).contains(&u) { u + 32 } else { u })
        .eq("deepseek-flash-latest".encode_utf16())
}
fn source_candidate(id: &ModelId, year: u32) -> Option<FlashCandidate> {
    let lower = lower_units(id);
    for word in lower.split(|u| matches!(*u, 45 | 58)) {
        if [
            "fast", "ultra", "chat", "vision", "exp", "web", "e2ee", "free", "batch",
        ]
        .iter()
        .any(|s| word.iter().copied().eq(s.encode_utf16()))
        {
            return None;
        }
    }
    let start = lower.iter().rposition(|u| *u == 47).map_or(0, |i| i + 1);
    let suffix = &lower[start..];
    if !suffix.iter().all(|u| *u < 128) {
        return None;
    }
    let suffix = suffix
        .iter()
        .map(|u| char::from(*u as u8))
        .collect::<String>();
    candidate(&suffix, year)
}
fn provider_alias(
    models: &[SourceJson],
    year: u32,
    collator: &dyn SourceStringCollator,
) -> Result<Option<ModelId>, GatewayError> {
    let ids = models
        .iter()
        .filter_map(|row| {
            crate::model_control::get(row, "id")
                .as_ref()
                .and_then(crate::model_control::string)
        })
        .map(|id| ModelId::from_source(crate::source_request::trim(&id)))
        .collect::<Vec<_>>();
    let latest = ids.iter().filter(|id| latest_source(id)).cloned().collect();
    let latest = sort_source(latest, &|left: &ModelId, right: &ModelId| {
        let priority = (!simple_source(left)).cmp(&(!simple_source(right)));
        if priority == Ordering::Equal {
            collator.compare(left.as_js_string(), right.as_js_string())
        } else {
            Ok(priority)
        }
    })?;
    if let Some(id) = latest.into_iter().next() {
        return Ok(Some(id));
    }
    let mut newest: Option<(&ModelId, FlashCandidate)> = None;
    for id in &ids {
        if let Some(candidate) = source_candidate(id, year)
            && newest
                .as_ref()
                .is_none_or(|(_, n)| compare_candidates(&candidate, n) > 0.0)
        {
            newest = Some((id, candidate));
        }
    }
    let Some((id, newest)) = newest else {
        return Ok(None);
    };
    let mut base = None;
    for entry in &ids {
        if source_candidate(entry, year).is_some_and(|c| c.version == newest.version && c.date == 0)
        {
            base = Some(entry.clone());
        }
    }
    Ok(base.or_else(|| Some(id.clone())))
}
pub fn resolve_flash_aliases(
    lithos: Option<&[SourceJson]>,
    openrouter: Option<&[SourceJson]>,
    surplus: Option<&[SourceJson]>,
    openlux: Option<&[SourceJson]>,
    utc_year: u32,
    collator: &dyn SourceStringCollator,
) -> Result<FlashAliases, GatewayError> {
    let fallback = FlashAliases::default();
    let choose =
        |models: Option<&[SourceJson]>, fallback: ModelId| -> Result<ModelId, GatewayError> {
            Ok(match models {
                Some(models) => provider_alias(models, utc_year, collator)?.unwrap_or(fallback),
                None => fallback,
            })
        };
    Ok(FlashAliases {
        lithos: choose(lithos, fallback.lithos)?,
        deepseek: fallback.deepseek,
        openrouter: choose(openrouter, fallback.openrouter)?,
        surplus: choose(surplus, fallback.surplus)?,
        openlux: choose(openlux, fallback.openlux)?,
    })
}
