//! Source-observed discovery only; no guessed model capabilities or reasoning tiers.
use crate::host::{CatalogProvider, unavailable};
use gateway_core::{
    GatewayError, js_string::JsString16, model::ModelId, source_json::SourceJson,
    source_serialization as source,
};
use gateway_schema::{reasoning::js_trim_source, util::js_trim};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
fn json<T: Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).expect("finite provider metadata")
}
fn get(value: &SourceJson, key: &str) -> Option<SourceJson> {
    source::member(value, key)
}
fn path(value: &SourceJson, path: &str) -> Option<SourceJson> {
    path.trim_start_matches('/')
        .split('/')
        .try_fold(value.clone(), |value, key| get(&value, key))
}
fn set(value: &mut SourceJson, key: &str, next: SourceJson) {
    let key = JsString16::from_utf8(key);
    let mut fields = source::entries(value).expect("constructed provider row");
    if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k == &key) {
        *old = next;
    } else {
        fields.push((key, next));
    }
    *value = source::object_keys(fields).expect("provider row fields");
}
fn object(fields: Vec<(&str, SourceJson)>) -> SourceJson {
    source::object(fields).expect("provider row")
}
fn same(value: &JsString16, literal: &str) -> bool {
    value.as_units().iter().copied().eq(literal.encode_utf16())
}
fn text(value: Option<SourceJson>) -> Option<JsString16> {
    value
        .as_ref()
        .and_then(source::string)
        .map(|value| js_trim_source(&value))
        .filter(|value| !value.as_units().is_empty())
}
fn integer(value: Option<SourceJson>) -> Option<i64> {
    value
        .as_ref()
        .and_then(source::number)
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && n.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64
        })
        .map(|n| n as i64)
}
fn positive(value: Option<SourceJson>) -> Option<i64> {
    integer(value).filter(|n| *n > 0)
}
fn nonnegative(value: Option<SourceJson>) -> i64 {
    integer(value).filter(|n| *n >= 0).unwrap_or(0)
}
fn strings(value: Option<SourceJson>) -> Vec<JsString16> {
    value
        .as_ref()
        .and_then(source::array)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| text(Some(v)))
        .collect()
}
fn copy_string(row: &mut SourceJson, raw: &SourceJson, key: &str) {
    if let Some(value) = text(get(raw, key)) {
        set(row, key, json(&value));
    }
}
fn copy_positive(row: &mut SourceJson, key: &str, value: Option<SourceJson>) {
    if let Some(value) = positive(value) {
        set(row, key, json(&value));
    }
}
fn flag(value: Option<SourceJson>) -> Option<bool> {
    match value?.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
fn number(value: Option<SourceJson>) -> Option<f64> {
    let value = value?;
    let n = if let Some(n) = source::number(&value) {
        n
    } else {
        // Only the independently finite numeric grammar is observed as scalar text.
        let text = source::string(&value)?.try_utf8().ok()?;
        let s = js_trim(&text);
        if s.is_empty() {
            return None;
        }
        if let Some(s) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            u64::from_str_radix(s, 16).ok()? as f64
        } else if let Some(s) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
            u64::from_str_radix(s, 2).ok()? as f64
        } else if let Some(s) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
            u64::from_str_radix(s, 8).ok()? as f64
        } else {
            s.parse().ok()?
        }
    };
    (n.is_finite() && n >= 0.0).then_some(n)
}
fn openlux(raw: &SourceJson) -> Option<SourceJson> {
    let id = text(get(raw, "id"))?;
    let endpoints = get(raw, "supported_endpoint_types")
        .as_ref()
        .and_then(source::array)
        .unwrap_or_default()
        .into_iter()
        .filter(|v| source::string(v).is_some())
        .collect::<Vec<_>>();
    let mut row = object(vec![
        ("id", json(&id)),
        ("object", json("model")),
        ("created", json(&nonnegative(get(raw, "created")))),
        (
            "owned_by",
            json(&text(get(raw, "owned_by")).unwrap_or_else(|| "openlux".into())),
        ),
        ("supported_endpoint_types", json(&endpoints)),
    ]);
    for key in ["model_type", "description", "tags"] {
        copy_string(&mut row, raw, key);
    }
    copy_positive(
        &mut row,
        "max_output_tokens",
        get(raw, "max_completion_tokens")
            .filter(|v| v.as_str() != "null")
            .or_else(|| get(raw, "max_output_tokens").filter(|v| v.as_str() != "null"))
            .or_else(|| path(raw, "/top_provider/max_completion_tokens")),
    );
    Some(row)
}
fn modality_has_text(value: &JsString16) -> bool {
    value.as_units().split(|&u| u == 43 || u == 44).any(|part| {
        same(
            &js_trim_source(&JsString16::from_units(part.to_vec())),
            "text",
        )
    })
}
fn supports_text(raw: &SourceJson) -> bool {
    let Some(architecture) = get(raw, "architecture").filter(|v| source::entries(v).is_some())
    else {
        return true;
    };
    let (mut input, mut output) = (None, None);
    for (key, dest) in [
        ("input_modalities", &mut input),
        ("output_modalities", &mut output),
    ] {
        let values = get(&architecture, key)
            .as_ref()
            .and_then(source::array)
            .unwrap_or_default()
            .iter()
            .filter_map(source::string)
            .collect::<Vec<_>>();
        if !values.is_empty() {
            *dest = Some(values.iter().any(|v| same(v, "text")));
        }
    }
    if let Some(modality) = text(get(&architecture, "modality")) {
        let units = modality.as_units();
        if let Some(at) = units.windows(2).rposition(|s| s == [45, 62]) {
            input = Some(modality_has_text(&JsString16::from_units(
                units[..at].to_vec(),
            )));
            output = Some(modality_has_text(&JsString16::from_units(
                units[at + 2..].to_vec(),
            )));
        } else {
            input = Some(modality_has_text(&modality));
            output = input;
        }
    }
    input != Some(false) && output != Some(false)
}
fn surplus(raw: &SourceJson) -> Option<SourceJson> {
    if !supports_text(raw) {
        return None;
    }
    let id = text(get(raw, "id"))?;
    let mut row = object(vec![
        ("id", json(&id)),
        ("object", json("model")),
        ("created", json(&nonnegative(get(raw, "created")))),
        (
            "owned_by",
            json(
                &text(get(raw, "provider"))
                    .or_else(|| text(get(raw, "owned_by")))
                    .unwrap_or_else(|| "surplus".into()),
            ),
        ),
        (
            "supported_endpoint_types",
            json(&["openai", "openai-response"]),
        ),
    ]);
    copy_string(&mut row, raw, "description");
    let parameters = strings(get(raw, "supported_parameters"));
    let has = |key: &str| parameters.iter().any(|v| same(v, key));
    if has("tools")
        && has("tool_choice")
        && strings(get(raw, "supported_features"))
            .iter()
            .any(|v| same(v, "tools"))
    {
        set(&mut row, "supports_tools", json(&true));
    }
    if has("parallel_tool_calls") {
        set(&mut row, "supports_parallel_tool_calls", json(&true));
    }
    copy_positive(
        &mut row,
        "max_output_tokens",
        path(raw, "/top_provider/max_completion_tokens"),
    );
    if let Some(pricing) = get(raw, "pricing").filter(|v| source::entries(v).is_some()) {
        for (target, keys) in [
            ("input_price_per_token", &["prompt", "input"][..]),
            ("output_price_per_token", &["completion", "output"][..]),
            (
                "cache_read_price_per_token",
                &["input_cache_read", "cache_read", "cache_read_input"][..],
            ),
            (
                "cache_write_price_per_token",
                &["input_cache_write", "cache_write", "cache_write_input"][..],
            ),
        ] {
            if let Some(value) = number(
                keys.iter()
                    .find_map(|key| get(&pricing, key).filter(|v| v.as_str() != "null")),
            ) {
                set(&mut row, target, json(&value));
            }
        }
    }
    Some(row)
}
fn openrouter(raw: &SourceJson) -> Option<SourceJson> {
    let id = text(get(raw, "id"))?;
    let context = positive(get(raw, "context_length"));
    let widest = context
        .into_iter()
        .chain(positive(path(raw, "/top_provider/context_length")))
        .max();
    let reasoning = get(raw, "reasoning")
        .filter(|v| source::entries(v).is_some())
        .and_then(|v| {
            let mut seen = BTreeSet::new();
            let efforts = strings(get(&v, "supported_efforts"))
                .into_iter()
                .filter(|e| seen.insert(e.clone()))
                .collect::<Vec<_>>();
            let default = text(get(&v, "default_effort"));
            (!efforts.is_empty() || default.is_some()).then(|| {
                object(vec![
                    ("supported_efforts", json(&efforts)),
                    ("default_effort", json(&default)),
                    (
                        "mandatory",
                        json(&(flag(get(&v, "mandatory")) == Some(true))),
                    ),
                ])
            })
        });
    Some(object(vec![
        ("id", json(&id)),
        ("context_window_tokens", json(&context)),
        ("max_context_window_tokens", json(&widest)),
        ("reasoning", json(&reasoning)),
    ]))
}
fn observed_flag(raw: &SourceJson, p: &str) -> Option<bool> {
    flag(path(raw, p).as_ref().and_then(|v| get(v, "supported")))
}
fn claude(raw: &SourceJson) -> Option<SourceJson> {
    let id = get(raw, "id").as_ref().and_then(source::string)?;
    let units = id.as_units();
    let prefix = |s: &str| s.encode_utf16().collect::<Vec<_>>();
    let rest = units
        .strip_prefix(prefix("~anthropic/").as_slice())
        .or_else(|| units.strip_prefix(prefix("anthropic/").as_slice()))
        .unwrap_or(units);
    if !rest.starts_with(&prefix("claude-")) || units.len() > 512 {
        return None;
    }
    // Date.parse's finite ISO grammar cannot contain unpaired units; invalid dates retain zero.
    let created = get(raw, "created_at")
        .as_ref()
        .and_then(source::string)
        .and_then(|v| v.try_utf8().ok())
        .as_deref()
        .and_then(iso_timestamp)
        .unwrap_or(0);
    let mut row = object(vec![("id", json(&id)), ("created", json(&created))]);
    if let Some(display) = get(raw, "display_name").filter(|v| source::string(v).is_some()) {
        set(&mut row, "display_name", display);
    }
    for (target, key) in [
        ("context_window_tokens", "max_input_tokens"),
        ("max_output_tokens", "max_tokens"),
    ] {
        copy_positive(&mut row, target, get(raw, key));
    }
    for (target, path) in [
        (
            "supports_disabled_thinking",
            "/capabilities/thinking/types/disabled",
        ),
        (
            "supports_adaptive_thinking",
            "/capabilities/thinking/types/adaptive",
        ),
        ("supports_image_input", "/capabilities/image_input"),
        ("supports_pdf_input", "/capabilities/pdf_input"),
    ] {
        if let Some(value) = observed_flag(raw, path) {
            set(&mut row, target, json(&value));
        }
    }
    let mut levels = Vec::new();
    if flag(path(raw, "/capabilities/effort/supported")) == Some(true)
        && flag(get(&row, "supports_adaptive_thinking")) == Some(true)
        && let Some(effort) = path(raw, "/capabilities/effort")
            .as_ref()
            .and_then(source::entries)
    {
        for (key, value) in effort {
            if !same(&key, "supported")
                && !same(&key, "none")
                && !key.as_units().is_empty()
                && flag(get(&value, "supported")) == Some(true)
            {
                levels.push(key);
            }
        }
    }
    set(&mut row, "supported_reasoning_levels", json(&levels));
    Some(row)
}
/// Upstream Models API publishes ISO-8601 instants. Invalid dates retain the source's zero.
fn iso_timestamp(raw: &str) -> Option<i64> {
    let date = raw.get(..10)?;
    let year = date.get(..4)?.parse::<i64>().ok()?;
    let month = date.get(5..7)?.parse::<i64>().ok()?;
    let day = date.get(8..10)?.parse::<i64>().ok()?;
    if date.get(4..5)? != "-"
        || date.get(7..8)? != "-"
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let adjusted = year - i64::from(month <= 2);
    let era = adjusted.div_euclid(400);
    let yoe = adjusted - era * 400;
    let month = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * month + 2) / 5 + day - 1 - 719468;
    let time = raw.get(11..19)?;
    let hour = time.get(..2)?.parse::<i64>().ok()?;
    let minute = time.get(3..5)?.parse::<i64>().ok()?;
    let second = time.get(6..8)?.parse::<i64>().ok()?;
    if raw.get(10..11)? != "T" || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let suffix = raw.get(19..)?;
    let zone_start = suffix.find(['Z', '+', '-'])?;
    let zone = &suffix[zone_start..];
    let offset = if zone == "Z" {
        0
    } else {
        if zone.len() != 6 || zone.get(3..4)? != ":" {
            return None;
        }
        let h = zone.get(1..3)?.parse::<i64>().ok()?;
        let m = zone.get(4..6)?.parse::<i64>().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        (h * 3600 + m * 60) * if zone.starts_with('-') { -1 } else { 1 }
    };
    let timestamp = days * 86400 + hour * 3600 + minute * 60 + second - offset;
    (timestamp > 0).then_some(timestamp)
}
pub fn parse_page(
    provider: CatalogProvider,
    payload: &SourceJson,
) -> Result<(Vec<SourceJson>, Option<JsString16>), GatewayError> {
    let data = get(payload, "data")
        .as_ref()
        .and_then(source::array)
        .ok_or_else(|| unavailable("Provider did not return a model catalog"))?;
    let (mut seen, mut models) = (BTreeSet::new(), Vec::new());
    for raw in data {
        if provider == CatalogProvider::ClaudeCode && text(get(&raw, "id")).is_none() {
            return Err(unavailable(
                "Claude model discovery returned an invalid row",
            ));
        }
        let row = match provider {
            CatalogProvider::Openlux => openlux(&raw),
            CatalogProvider::Surplus => surplus(&raw),
            CatalogProvider::Openrouter => openrouter(&raw),
            CatalogProvider::Lithos => text(get(&raw, "id")).map(|id| {
                object(vec![
                    ("id", json(&id)),
                    ("created", json(&integer(get(&raw, "created")).unwrap_or(0))),
                ])
            }),
            CatalogProvider::ClaudeCode => claude(&raw),
            CatalogProvider::Deepseek | CatalogProvider::Cerebras => {
                return Err(unavailable("This provider has no discovery endpoint"));
            }
        };
        if let Some(row) = row {
            let id = get(&row, "id")
                .as_ref()
                .and_then(source::string)
                .expect("constructed provider model id");
            if seen.insert(id) {
                models.push(row);
            }
        }
    }
    if provider == CatalogProvider::Openrouter && models.is_empty() {
        return Err(unavailable("OpenRouter model discovery returned no models"));
    }
    let next = if provider == CatalogProvider::ClaudeCode {
        match flag(get(payload, "has_more")) {
            Some(false) => None,
            Some(true) => Some(
                get(payload, "last_id")
                    .as_ref()
                    .and_then(source::string)
                    .filter(|s| !s.as_units().is_empty())
                    .ok_or_else(|| {
                        unavailable("Claude model discovery returned an invalid cursor")
                    })?,
            ),
            None => {
                return Err(unavailable(
                    "Claude model discovery omitted pagination evidence",
                ));
            }
        }
    } else {
        None
    };
    Ok((models, next))
}
pub(crate) fn withdraw_stale_reasoning(models: &mut [SourceJson]) {
    for model in models {
        if let Some(fields) = source::entries(model) {
            *model = source::object_keys(
                fields
                    .into_iter()
                    .filter(|(key, _)| {
                        ![
                            "supports_disabled_thinking",
                            "supports_adaptive_thinking",
                            "supported_reasoning_levels",
                        ]
                        .iter()
                        .any(|s| same(key, s))
                    })
                    .collect(),
            )
            .expect("provider model fields");
        }
    }
}
fn normalize_key(raw: &JsString16) -> JsString16 {
    let lower = gateway_core::js_string_case::lowercase_source(&js_trim_source(raw));
    let mut key = Vec::new();
    for &unit in lower.as_units() {
        if (48..=57).contains(&unit) || (97..=122).contains(&unit) {
            key.push(unit);
        } else if !key.is_empty() && key.last() != Some(&45) {
            key.push(45);
        }
    }
    if key.last() == Some(&45) {
        key.pop();
    }
    JsString16::from_units(key)
}
fn strip_suffix(raw: &JsString16, suffix: &str) -> Option<JsString16> {
    raw.as_units()
        .strip_suffix(suffix.encode_utf16().collect::<Vec<_>>().as_slice())
        .map(|units| JsString16::from_units(units.to_vec()))
}
fn slug(raw: &JsString16) -> JsString16 {
    JsString16::from_units(
        raw.as_units()
            .rsplit(|&u| u == 47)
            .next()
            .unwrap_or_default()
            .to_vec(),
    )
}
fn billing_base(raw: &JsString16) -> Option<JsString16> {
    [":free", "-free", ":batch", "-batch"]
        .iter()
        .find_map(|s| strip_suffix(raw, s))
}
/// Ambiguous joins degrade to unknown. Source tier precedence and exact UTF16 identity are preserved.
pub fn match_openrouter<'a>(
    models: &'a [SourceJson],
    model_id: &ModelId,
) -> Option<&'a SourceJson> {
    use gateway_core::js_string_case::lowercase_source;
    let target = js_trim_source(model_id.as_js_string());
    if target.as_units().is_empty() {
        return None;
    }
    let target_slug = slug(&target);
    let mut tiers: Vec<BTreeMap<JsString16, Option<usize>>> =
        (0..6).map(|_| BTreeMap::new()).collect();
    for (index, model) in models.iter().enumerate() {
        let Some(id) = get(model, "id").as_ref().and_then(source::string) else {
            continue;
        };
        let model_slug = slug(&id);
        let alias = id
            .as_units()
            .strip_prefix(&[126])
            .map(|units| slug(&JsString16::from_units(units.to_vec())))
            .map(|s| {
                strip_suffix(&s, "-latest")
                    .or_else(|| strip_suffix(&s, ":latest"))
                    .unwrap_or(s)
            })
            .map(|s| normalize_key(&s));
        let keys = [
            Some(lowercase_source(&id)),
            Some(lowercase_source(&model_slug)),
            Some(normalize_key(&id)),
            Some(normalize_key(&model_slug)),
            alias,
            billing_base(&model_slug).map(|s| normalize_key(&s)),
        ];
        for (tier, key) in tiers.iter_mut().zip(keys) {
            if let Some(key) = key.filter(|s| !s.as_units().is_empty()) {
                match tier.get(&key) {
                    None => {
                        tier.insert(key, Some(index));
                    }
                    Some(Some(old))
                        if get(&models[*old], "id").as_ref().and_then(source::string)
                            != Some(id.clone()) =>
                    {
                        tier.insert(key, None);
                    }
                    _ => {}
                }
            }
        }
    }
    let keys = [
        lowercase_source(&target),
        lowercase_source(&target_slug),
        normalize_key(&target),
        normalize_key(&target_slug),
        normalize_key(&target_slug),
        normalize_key(&target_slug),
    ];
    for (tier, key) in tiers.iter().zip(keys) {
        if let Some(Some(index)) = tier.get(&key) {
            return models.get(*index);
        }
    }
    if let Some(stripped) = billing_base(&target_slug) {
        for (tier, key) in [
            (&tiers[1], lowercase_source(&stripped)),
            (&tiers[3], normalize_key(&stripped)),
        ] {
            if let Some(Some(index)) = tier.get(&key) {
                return models.get(*index);
            }
        }
    }
    None
}
