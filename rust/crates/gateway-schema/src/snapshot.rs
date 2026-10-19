//! Full uploaded snapshot normalization and evidence-preserving refresh projection.
use crate::{prompt_cache, reasoning::advertised_effort, util::*};
use gateway_core::{model::ModelId, source_json::SourceJson};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelSnapshot {
    pub models: Vec<SourceJson>,
    pub source: String,
    pub updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct SnapshotOverrides {
    pub source: Option<String>,
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
    value: &Value,
    overrides: &SnapshotOverrides,
    now_ms: i64,
) -> Option<ModelSnapshot> {
    let raw = if let Some(list) = value.as_array() {
        list
    } else {
        value
            .get("models")
            .and_then(Value::as_array)
            .or_else(|| value.get("data").and_then(Value::as_array))?
    };
    let mut models = Vec::new();
    let mut seen = Vec::new();
    for item in raw {
        if !is_record(item) {
            continue;
        }
        let hidden = item
            .get("visibility")
            .and_then(Value::as_str)
            .is_some_and(|s| {
                s.trim_matches(crate::util::js_whitespace)
                    .eq_ignore_ascii_case("hide")
            })
            && item.get("supported_in_api") != Some(&Value::Bool(true));
        if hidden {
            continue;
        }
        let Some(slug) = identifier(item).filter(|s| !s.is_empty()) else {
            continue;
        };
        if seen.contains(&slug) {
            continue;
        }
        seen.push(slug);
        let mut model = json!({"slug":slug});
        if let Some(name) = item
            .get("display_name")
            .and_then(Value::as_str)
            .or_else(|| item.get("displayName").and_then(Value::as_str))
            .or_else(|| item.get("name").and_then(Value::as_str))
            .filter(|s| !s.is_empty())
        {
            model["display_name"] = json!(name);
        }
        for key in ["description", "visibility"] {
            if let Some(s) = item
                .get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                model[key] = json!(s);
            }
        }
        if let Some(v) = item.get("supported_in_api").filter(|v| v.is_boolean()) {
            model["supported_in_api"] = v.clone();
        }
        for key in [
            "context_window",
            "max_context_window",
            "auto_compact_token_limit",
            "effective_context_window_percent",
        ] {
            if item.get(key) == Some(&Value::Null) {
                model[key] = Value::Null;
            } else if let Some(n) = nonnegative_truncated_value(item.get(key)) {
                model[key] = n;
            }
        }
        if let Some(v) = item.get("default_reasoning_level") {
            if v.is_null() {
                model["default_reasoning_level"] = json!("none");
            } else if let Some(level) = normalized_string(Some(v)) {
                model["default_reasoning_level"] = json!(level);
            }
        }
        if let Some(raw_levels) = item
            .get("supported_reasoning_levels")
            .and_then(Value::as_array)
        {
            let levels: Vec<_> = raw_levels.iter().filter_map(advertised_effort).collect();
            if !levels.is_empty() {
                model["supported_reasoning_levels"] = json!(levels);
            }
            let mut wire = serde_json::Map::new();
            for level in raw_levels {
                if let Some(effort) = advertised_effort(level) {
                    let upstream = if effort == "ultra" {
                        Some("max".to_owned())
                    } else {
                        normalized_string(level.get("wire_effort"))
                    };
                    if let Some(upstream) = upstream.filter(|s| s != &effort) {
                        wire.insert(effort, json!(upstream));
                    }
                }
            }
            if !wire.is_empty() {
                model["reasoning_effort_wire_map"] = Value::Object(wire);
            }
        }
        if let Some(cache) = prompt_cache::normalize_capabilities(item.get("prompt_cache")) {
            model["prompt_cache"] = cache;
        }
        models.push(model);
    }
    if models.is_empty() {
        return None;
    }
    let source = overrides
        .source
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| {
            value
                .get("source")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "codex_cli".into());
    let client_version = overrides
        .client_version
        .as_ref()
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| {
            value
                .get("client_version")
                .and_then(Value::as_str)
                .or_else(|| value.get("clientVersion").and_then(Value::as_str))
                .map(str::to_owned)
        });
    let updated_at_ms = overrides
        .updated_at_ms
        .or_else(|| {
            value
                .get("updated_at_ms")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .map(|n| n.trunc() as i64)
        })
        .unwrap_or(now_ms);
    Some(ModelSnapshot {
        models,
        source,
        client_version,
        updated_at_ms,
    })
}
impl ModelSnapshot {
    pub fn default_model(&self) -> Option<ModelId> {
        self.models.iter().find_map(|m| {
            identifier(m)
                .map(crate::util::js_trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
    }
    pub fn find(&self, id: &ModelId) -> Option<&SourceJson> {
        self.models.iter().find(|m| {
            identifier(m).is_some_and(|s| {
                s.trim_matches(crate::util::js_whitespace)
                    == id.trim_matches(crate::util::js_whitespace)
            })
        })
    }
    pub fn unique(&self, id: &ModelId) -> Option<&SourceJson> {
        let matches: Vec<_> = self
            .models
            .iter()
            .filter(|m| {
                m.is_object()
                    && identifier(m).is_some_and(|s| {
                        s.trim_matches(crate::util::js_whitespace)
                            == id.trim_matches(crate::util::js_whitespace)
                    })
            })
            .collect();
        (matches.len() == 1).then(|| matches[0])
    }
    pub fn preserve_default(&self, candidate: Option<&ModelId>) -> Option<ModelId> {
        candidate
            .map(crate::util::js_trim)
            .filter(|s| !s.is_empty() && self.find(s).is_some())
            .map(str::to_owned)
    }
    pub fn merge_prompt_cache(&self, previous: Option<&ModelSnapshot>) -> Self {
        let mut next = self.clone();
        for model in &mut next.models {
            let prior = previous.and_then(|s| identifier(model).and_then(|id| s.find(id)));
            if let Some(cache) = prompt_cache::merge_capabilities(
                prior.and_then(|p| p.get("prompt_cache")),
                model.get("prompt_cache"),
            ) {
                model["prompt_cache"] = cache;
            }
        }
        next
    }
    pub fn with_prompt_cache_scope(
        &self,
        slug: &str,
        provider_id: &str,
        scope: &Value,
    ) -> Option<Self> {
        let model = self.unique(slug)?;
        let scope = prompt_cache::normalize_scope(scope)?;
        let mut cache = prompt_cache::normalize_capabilities(model.get("prompt_cache"))?;
        let providers = cache.get_mut("providers")?.as_array_mut()?;
        let provider = providers
            .iter_mut()
            .find(|p| p.get("id").and_then(Value::as_str) == Some(provider_id))?;
        provider["scope"] = scope;
        let mut next = self.clone();
        for record in &mut next.models {
            if identifier(record).is_some_and(|s| {
                s.trim_matches(crate::util::js_whitespace)
                    == slug.trim_matches(crate::util::js_whitespace)
            }) {
                record["prompt_cache"] = cache.clone();
            }
        }
        Some(next)
    }
    pub fn scope_experiment_eligible(&self, slug: &str) -> bool {
        let cache = self
            .unique(slug)
            .and_then(|m| prompt_cache::normalize_capabilities(m.get("prompt_cache")));
        let controls = cache
            .as_ref()
            .and_then(|c| c.get("providers"))
            .and_then(Value::as_array)
            .and_then(|ps| {
                ps.iter().find(|p| {
                    p.get("id").and_then(Value::as_str) == Some(prompt_cache::CODEX_PROVIDER)
                })
            })
            .and_then(|p| p.get("controls"));
        controls.is_some_and(|c| {
            c.get("key") == Some(&Value::Bool(true))
                && c.get("implicit") != Some(&Value::Bool(false))
                && c.get("expected_usage_fields")
                    .and_then(Value::as_array)
                    .is_some_and(|fields| {
                        ["cached_tokens", "cache_write_tokens"]
                            .iter()
                            .all(|key| fields.iter().any(|v| v.as_str() == Some(key)))
                    })
        })
    }
}
/// Pool order and first row are authoritative; unknown top-level metadata stays verbatim.
pub type AccountCatalogEvidence = Vec<(String, Vec<String>)>;
pub type AccountCatalogUnion = (Value, AccountCatalogEvidence);
pub fn union_account_catalogs(catalogs: &[(String, Value)]) -> Option<AccountCatalogUnion> {
    let mut envelope = None;
    let mut models = Vec::new();
    let mut seen = Vec::new();
    let mut accounts = Vec::new();
    for (account, catalog) in catalogs {
        let Some(rows) = catalog.get("models").and_then(Value::as_array) else {
            continue;
        };
        if !catalog.is_object() {
            continue;
        }
        if envelope.is_none() {
            envelope = Some(catalog.clone());
        }
        let mut slugs = Vec::new();
        for row in rows {
            let Some(slug) = identifier(row)
                .map(crate::util::js_trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            push_unique(&mut slugs, slug.to_owned());
            if !seen.contains(&slug.to_owned()) {
                models.push(row.clone());
                seen.push(slug.to_owned());
            }
        }
        accounts.push((account.clone(), slugs));
    }
    let mut envelope = envelope?;
    envelope["models"] = json!(models);
    Some((envelope, accounts))
}
