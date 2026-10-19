//! Latest Flash aliases resolve only from injected cached catalog observations.
use gateway_core::{model::ModelId, source_json::SourceJson};
use serde::{Deserialize, Serialize};
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
    let mut lower = Vec::new();
    for scalar in char::decode_utf16(units.as_units().iter().copied()) {
        match scalar {
            Ok(c) => {
                for c in c.to_lowercase() {
                    let mut buf = [0; 2];
                    lower.extend_from_slice(c.encode_utf16(&mut buf));
                }
            }
            Err(e) => lower.push(e.unpaired_surrogate()),
        }
    }
    lower
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
fn simple_unversioned_alias(id: &str) -> bool {
    id.strip_prefix('~')
        .and_then(|s| s.split_once('/'))
        .is_some_and(|(owner, slug)| {
            !owner.is_empty()
                && owner
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                && slug.eq_ignore_ascii_case("deepseek-flash-latest")
        })
}
fn provider_alias(models: &[SourceJson], year: u32) -> Option<ModelId> {
    let ids: Vec<_> = models
        .iter()
        .filter_map(|v| v.get("id").and_then(Value::as_str))
        .map(crate::util::js_trim)
        .collect();
    let mut latest: Vec<_> = ids
        .iter()
        .filter(|id| latest_alias_id(id))
        .copied()
        .collect();
    latest.sort_by_key(|id| (!simple_unversioned_alias(id), *id));
    if let Some(id) = latest.first() {
        return Some((*id).to_owned());
    }
    let mut newest: Option<(&str, FlashCandidate)> = None;
    for id in &ids {
        if let Some(candidate) = candidate(id, year)
            && newest
                .as_ref()
                .is_none_or(|(_, n)| compare_candidates(&candidate, n) > 0.0)
        {
            newest = Some((id, candidate));
        }
    }
    let (id, newest) = newest?;
    let mut base = None;
    for entry in &ids {
        if candidate(entry, year).is_some_and(|c| c.version == newest.version && c.date == 0) {
            base = Some((*entry).to_owned());
        }
    }
    base.or_else(|| Some(id.to_owned()))
}
pub fn resolve_flash_aliases(
    lithos: Option<&[SourceJson]>,
    openrouter: Option<&[SourceJson]>,
    surplus: Option<&[SourceJson]>,
    openlux: Option<&[SourceJson]>,
    utc_year: u32,
) -> FlashAliases {
    let fallback = FlashAliases::default();
    FlashAliases {
        lithos: lithos
            .and_then(|m| provider_alias(m, utc_year))
            .unwrap_or(fallback.lithos),
        deepseek: fallback.deepseek,
        openrouter: openrouter
            .and_then(|m| provider_alias(m, utc_year))
            .unwrap_or(fallback.openrouter),
        surplus: surplus
            .and_then(|m| provider_alias(m, utc_year))
            .unwrap_or(fallback.surplus),
        openlux: openlux
            .and_then(|m| provider_alias(m, utc_year))
            .unwrap_or(fallback.openlux),
    }
}
