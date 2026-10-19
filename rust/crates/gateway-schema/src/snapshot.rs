//! Full uploaded snapshot normalization and evidence-preserving refresh projection.
use crate::{model_control as c, prompt_cache, reasoning::advertised_effort};
use gateway_core::{js_string::JsString16, model::ModelId, source_json::SourceJson};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelSnapshot {
    pub models: Vec<SourceJson>,
    pub source: JsString16,
    pub updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct SnapshotOverrides {
    pub source: Option<JsString16>,
    pub client_version: Option<String>,
    pub updated_at_ms: Option<i64>,
}
pub fn parse_client_version(raw: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = raw
        .trim_matches(crate::util::js_whitespace)
        .split('.')
        .collect();
    if parts.len() != 3 {
        return None;
    }
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n = part.parse::<u64>().ok()?;
        if n > 9_007_199_254_740_991 {
            return None;
        }
        result[i] = n;
    }
    Some(result)
}
pub fn compare_client_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    Some(parse_client_version(left)?.cmp(&parse_client_version(right)?))
}
pub fn normalize_snapshot(
    value: &SourceJson,
    overrides: &SnapshotOverrides,
    now_ms: i64,
) -> Option<ModelSnapshot> {
    let raw = c::array(value)
        .or_else(|| c::get(value, "models").as_ref().and_then(c::array))
        .or_else(|| c::get(value, "data").as_ref().and_then(c::array))?;
    let mut models = Vec::new();
    let mut seen = Vec::new();
    for item in &raw {
        if !c::is_record(item) {
            continue;
        }
        let hidden = c::get(item, "visibility")
            .as_ref()
            .and_then(c::string)
            .is_some_and(|v| {
                c::trim(&v)
                    .as_units()
                    .iter()
                    .copied()
                    .map(|u| if (65..=90).contains(&u) { u + 32 } else { u })
                    .eq("hide".encode_utf16())
            })
            && c::get(item, "supported_in_api").is_none_or(|v| v.as_str() != "true");
        if hidden {
            continue;
        }
        let Some(slug) = c::identifier(item).filter(|s| !s.as_units().is_empty()) else {
            continue;
        };
        if seen.contains(&slug) {
            continue;
        }
        seen.push(slug.clone());
        let mut model = c::object(vec![("slug", c::json(&slug))]);
        if let Some(name) = ["display_name", "displayName", "name"]
            .iter()
            .find_map(|key| c::get(item, key).as_ref().and_then(c::string))
            .filter(|s| !s.as_units().is_empty())
        {
            c::set(&mut model, "display_name", c::json(&name));
        }
        for key in ["description", "visibility"] {
            if let Some(value) = c::get(item, key)
                .as_ref()
                .and_then(c::string)
                .filter(|s| !s.as_units().is_empty())
            {
                c::set(&mut model, key, c::json(&value));
            }
        }
        if let Some(value) =
            c::get(item, "supported_in_api").filter(|v| matches!(v.as_str(), "true" | "false"))
        {
            c::set(&mut model, "supported_in_api", value);
        }
        for key in [
            "context_window",
            "max_context_window",
            "auto_compact_token_limit",
            "effective_context_window_percent",
        ] {
            if let Some(value) = c::get(item, key) {
                if value.as_str() == "null" {
                    c::set(&mut model, key, value);
                } else if let Some(n) = gateway_core::source_serialization::number(&value)
                    .filter(|n| n.is_finite() && *n >= 0.0)
                {
                    let n = n.trunc();
                    c::set(
                        &mut model,
                        key,
                        if n <= crate::util::MAX_SAFE_INTEGER {
                            c::json(&(n as i64))
                        } else {
                            c::json(&n)
                        },
                    );
                }
            }
        }
        if let Some(v) = c::get(item, "default_reasoning_level") {
            if v.as_str() == "null" {
                c::set(&mut model, "default_reasoning_level", c::json("none"));
            } else if let Some(level) = c::normalized(Some(&v)) {
                c::set(&mut model, "default_reasoning_level", c::json(&level));
            }
        }
        if let Some(raw_levels) = c::get(item, "supported_reasoning_levels")
            .as_ref()
            .and_then(c::array)
        {
            let levels = raw_levels
                .iter()
                .filter_map(advertised_effort)
                .collect::<Vec<_>>();
            if !levels.is_empty() {
                c::set(&mut model, "supported_reasoning_levels", c::json(&levels));
            }
            let mut wire = Vec::new();
            for level in raw_levels {
                if let Some(effort) = advertised_effort(&level) {
                    let upstream = if c::matches(&effort, "ultra") {
                        Some("max".into())
                    } else {
                        c::normalized(c::get(&level, "wire_effort").as_ref())
                    };
                    if let Some(upstream) = upstream.filter(|s| s != &effort) {
                        let value = c::json(&upstream);
                        if let Some((_, old)) = wire.iter_mut().find(|(key, _)| key == &effort) {
                            *old = value;
                        } else {
                            wire.push((effort, value));
                        }
                    }
                }
            }
            if !wire.is_empty() {
                c::set(
                    &mut model,
                    "reasoning_effort_wire_map",
                    gateway_core::source_serialization::object_keys(wire).expect("source wire map"),
                );
            }
        }
        if let Some(cache) =
            prompt_cache::normalize_capabilities_source(c::get(item, "prompt_cache").as_ref())
        {
            c::set(&mut model, "prompt_cache", cache);
        }
        models.push(model);
    }
    if models.is_empty() {
        return None;
    }
    let source = overrides
        .source
        .as_ref()
        .filter(|s| !s.as_units().is_empty())
        .cloned()
        .or_else(|| c::get(value, "source").as_ref().and_then(c::string))
        .unwrap_or_else(|| "codex_cli".into());
    let client_version = overrides
        .client_version
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| {
            c::scalar(c::get(value, "client_version").as_ref())
                .or_else(|| c::scalar(c::get(value, "clientVersion").as_ref()))
        });
    let updated_at_ms = overrides
        .updated_at_ms
        .or_else(|| {
            c::get(value, "updated_at_ms")
                .as_ref()
                .and_then(gateway_core::source_serialization::number)
                .filter(|n| n.is_finite())
                .map(|n| n.trunc() as i64)
        })
        .unwrap_or(now_ms);
    Some(ModelSnapshot {
        models,
        source,
        updated_at_ms,
        client_version,
    })
}
impl ModelSnapshot {
    pub fn default_model(&self) -> Option<ModelId> {
        self.models.iter().find_map(|m| {
            c::identifier(m)
                .map(|s| c::trim(&s))
                .filter(|s| !s.as_units().is_empty())
                .map(ModelId::from_source)
        })
    }
    pub fn find(&self, id: &ModelId) -> Option<&SourceJson> {
        let target = c::trim(id.as_js_string());
        self.models
            .iter()
            .find(|m| c::identifier(m).is_some_and(|s| c::trim(&s) == target))
    }
    pub fn unique(&self, id: &ModelId) -> Option<&SourceJson> {
        let target = c::trim(id.as_js_string());
        let matches = self
            .models
            .iter()
            .filter(|m| c::is_object(m) && c::identifier(m).is_some_and(|s| c::trim(&s) == target))
            .collect::<Vec<_>>();
        (matches.len() == 1).then(|| matches[0])
    }
    pub fn preserve_default(&self, candidate: Option<&ModelId>) -> Option<ModelId> {
        candidate
            .map(|m| ModelId::from_source(c::trim(m.as_js_string())))
            .filter(|m| !m.as_js_string().as_units().is_empty() && self.find(m).is_some())
    }
    pub fn merge_prompt_cache(&self, previous: Option<&ModelSnapshot>) -> Self {
        let mut next = self.clone();
        for model in &mut next.models {
            let id = c::model(model);
            let prior = previous.and_then(|s| id.as_ref().and_then(|id| s.find(id)));
            let prior = prior.and_then(|p| c::get(p, "prompt_cache"));
            let current = c::get(model, "prompt_cache");
            if let Some(cache) =
                prompt_cache::merge_capabilities_source(prior.as_ref(), current.as_ref())
            {
                c::set(model, "prompt_cache", cache);
            }
        }
        next
    }
    pub fn with_prompt_cache_scope(
        &self,
        slug: &ModelId,
        provider_id: &str,
        scope: &SourceJson,
    ) -> Option<Self> {
        let model = self.unique(slug)?;
        let scope = prompt_cache::normalize_scope_source(scope)?;
        let mut cache =
            prompt_cache::normalize_capabilities_source(c::get(model, "prompt_cache").as_ref())?;
        let mut providers = c::get(&cache, "providers").as_ref().and_then(c::array)?;
        let provider = providers.iter_mut().find(|p| {
            c::get(p, "id")
                .as_ref()
                .and_then(c::string)
                .is_some_and(|id| c::matches(&id, provider_id))
        })?;
        c::set(provider, "scope", scope);
        c::set(&mut cache, "providers", c::json(&providers));
        let mut next = self.clone();
        let target = c::trim(slug.as_js_string());
        for record in &mut next.models {
            if c::identifier(record).is_some_and(|s| c::trim(&s) == target) {
                c::set(record, "prompt_cache", cache.clone());
            }
        }
        Some(next)
    }
    pub fn scope_experiment_eligible(&self, slug: &ModelId) -> bool {
        let cache = self.unique(slug).and_then(|m| {
            prompt_cache::normalize_capabilities_source(c::get(m, "prompt_cache").as_ref())
        });
        let controls = cache
            .as_ref()
            .and_then(|c| crate::model_control::get(c, "providers"))
            .as_ref()
            .and_then(c::array)
            .and_then(|ps| {
                ps.into_iter().find(|p| {
                    c::get(p, "id")
                        .as_ref()
                        .and_then(c::string)
                        .is_some_and(|id| c::matches(&id, prompt_cache::CODEX_PROVIDER))
                })
            })
            .and_then(|p| c::get(&p, "controls"));
        controls.is_some_and(|controls| {
            c::get(&controls, "key").is_some_and(|v| v.as_str() == "true")
                && c::get(&controls, "implicit").is_none_or(|v| v.as_str() != "false")
                && c::get(&controls, "expected_usage_fields")
                    .as_ref()
                    .and_then(c::array)
                    .is_some_and(|fields| {
                        ["cached_tokens", "cache_write_tokens"].iter().all(|key| {
                            fields
                                .iter()
                                .any(|v| c::string(v).is_some_and(|s| c::matches(&s, key)))
                        })
                    })
        })
    }
}
/// Pool order and first row are authoritative; unknown top-level metadata stays verbatim.
pub type AccountCatalogEvidence = Vec<(String, Vec<ModelId>)>;
pub type AccountCatalogUnion = (SourceJson, AccountCatalogEvidence);
pub fn union_account_catalogs(catalogs: &[(String, SourceJson)]) -> Option<AccountCatalogUnion> {
    let mut envelope = None;
    let mut models = Vec::new();
    let mut seen = Vec::new();
    let mut accounts = Vec::new();
    for (account, catalog) in catalogs {
        let Some(rows) = c::get(catalog, "models").as_ref().and_then(c::array) else {
            continue;
        };
        if !c::is_object(catalog) {
            continue;
        }
        if envelope.is_none() {
            envelope = Some(catalog.clone());
        }
        let mut slugs = Vec::new();
        for row in rows {
            let Some(slug) = c::identifier(&row)
                .map(|s| c::trim(&s))
                .filter(|s| !s.as_units().is_empty())
                .map(ModelId::from_source)
            else {
                continue;
            };
            c::push_unique(&mut slugs, slug.clone());
            if !seen.contains(&slug) {
                models.push(row);
                seen.push(slug);
            }
        }
        accounts.push((account.clone(), slugs));
    }
    let mut envelope = envelope?;
    c::set(&mut envelope, "models", c::json(&models));
    Some((envelope, accounts))
}
