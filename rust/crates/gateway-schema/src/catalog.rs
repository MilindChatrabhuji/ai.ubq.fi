//! Catalog assembly consumes observations; network, authentication and refresh are adapter-owned.
pub use crate::catalog_views::{
    build_catalog_snapshot, capabilities, ordinary_models, public_catalog,
};
pub use crate::native_catalog::{native_catalog, native_catalog_fallback};
use crate::{
    aliases::*, metadata::*, model_control as c, reasoning::ModelReasoning, selection::*,
    snapshot::ModelSnapshot, source_request::SourceRequestError,
};
use gateway_core::{
    js_string::JsString16, model::ModelId, source_json::SourceJson, source_serialization as source,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProviderCatalog {
    pub models: Vec<SourceJson>,
    pub updated_at_ms: Option<i64>,
    pub configured: bool,
    pub available: bool,
    pub stale: bool,
}
#[derive(Clone, Debug, Default)]
pub struct CatalogInput {
    pub snapshot: Option<ModelSnapshot>,
    pub full_snapshot: Option<ModelSnapshot>,
    pub providers: BTreeMap<String, ProviderCatalog>,
    pub enrichment: BTreeMap<ModelId, MetadataHint>,
    pub selection: Option<ProviderSelection>,
    pub whitelist: Option<ModelWhitelist>,
}
impl CatalogInput {
    pub fn enabled(&self, provider: &str) -> bool {
        ProviderSelection::enabled(self.selection.as_ref(), provider)
    }
    pub fn configured(&self, provider: &str) -> bool {
        self.providers.get(provider).is_some_and(|p| p.configured)
    }
    pub fn rows(&self, provider: &str) -> &[SourceJson] {
        self.providers
            .get(provider)
            .map(|p| p.models.as_slice())
            .unwrap_or(&[])
    }
    pub fn available_rows(&self, provider: &str) -> &[SourceJson] {
        if self.enabled(provider) {
            self.rows(provider)
        } else {
            &[]
        }
    }
    pub fn codex(&self) -> Option<&ModelSnapshot> {
        self.full_snapshot.as_ref().or(self.snapshot.as_ref())
    }
    pub fn metadata(
        &self,
        id: &ModelId,
        codex: Option<&SourceJson>,
        provider: Option<MetadataHint>,
        subscription: bool,
    ) -> ResolvedMetadata {
        resolve_metadata(&MetadataSources {
            codex: codex.map(MetadataHint::codex),
            subscription: subscription.then(MetadataHint::subscription),
            provider,
            openrouter: self.enrichment.get(id).cloned(),
        })
    }
    pub fn synthetic_configured(&self) -> bool {
        FLASH_ORDER.iter().any(|p| self.configured(p))
    }
    pub fn synthetic_enabled(&self) -> bool {
        self.enabled("ubiquity") && self.synthetic_configured()
    }
}
pub fn endpoint_paths(model: &SourceJson) -> Vec<String> {
    let mut paths = Vec::new();
    if endpoint_supports(model, "openai-response") {
        paths.push("/v1/responses".into());
    }
    if endpoint_supports(model, "openai") {
        paths.push("/v1/chat/completions".into());
    }
    paths
}
pub fn endpoint_supports(model: &SourceJson, endpoint: &str) -> bool {
    c::get(model, "supported_endpoint_types")
        .as_ref()
        .and_then(c::array)
        .is_some_and(|types| {
            types
                .iter()
                .any(|v| c::string(v).is_some_and(|s| c::matches(&s, endpoint)))
        })
}
pub fn model_list_row(record: &SourceJson, fallback_created: i64) -> Option<SourceJson> {
    let id = ["id", "slug", "model", "name"]
        .iter()
        .find_map(|key| c::get(record, key).as_ref().and_then(c::string))?;
    if id.as_units().is_empty() {
        return None;
    }
    let created = c::get(record, "created")
        .as_ref()
        .and_then(source::number)
        .map(f64::trunc)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| {
            if n <= crate::util::MAX_SAFE_INTEGER {
                c::json(&(n as i64))
            } else {
                c::json(&n)
            }
        })
        .unwrap_or_else(|| c::json(&fallback_created));
    let owner = c::get(record, "owned_by")
        .as_ref()
        .and_then(c::string)
        .unwrap_or_else(|| "openai".into());
    Some(c::object(vec![
        ("id", c::json(&id)),
        ("object", c::json("model")),
        ("created", created),
        ("owned_by", c::json(&owner)),
    ]))
}
pub fn normalize_model_list(payload: &SourceJson) -> Option<SourceJson> {
    if !c::is_record(payload) {
        return None;
    }
    let fallback = c::get(payload, "updated_at_ms")
        .as_ref()
        .and_then(source::number)
        .filter(|n| n.is_finite())
        .map(|n| (n / 1000.0).trunc().max(0.0) as i64)
        .unwrap_or(0);
    let rows = c::get(payload, "data")
        .as_ref()
        .and_then(c::array)
        .or_else(|| c::get(payload, "models").as_ref().and_then(c::array))?;
    Some(c::object(vec![
        ("object", c::json("list")),
        (
            "data",
            c::json(
                &rows
                    .iter()
                    .filter_map(|row| model_list_row(row, fallback))
                    .collect::<Vec<_>>(),
            ),
        ),
    ]))
}
fn field_equal(a: Option<SourceJson>, b: Option<SourceJson>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => source::canonical(&a).ok() == source::canonical(&b).ok(),
        _ => false,
    }
}
pub fn append_unique(
    rows: &mut Vec<SourceJson>,
    new_rows: impl IntoIterator<Item = SourceJson>,
    key: &str,
) {
    for row in new_rows {
        if !rows
            .iter()
            .any(|r| field_equal(c::get(r, key), c::get(&row, key)))
        {
            rows.push(row);
        }
    }
}
pub fn filter_whitelist(
    rows: Vec<SourceJson>,
    whitelist: Option<&ModelWhitelist>,
    native: bool,
) -> Vec<SourceJson> {
    rows.into_iter()
        .filter(|row| {
            let id = if native {
                c::identifier(row)
            } else {
                c::get(row, "id").as_ref().and_then(c::string)
            };
            id.is_some_and(|id| {
                let id = if native { c::trim(&id) } else { id };
                ModelWhitelist::permits(whitelist, &ModelId::from_source(id))
            })
        })
        .collect()
}
pub fn claude_levels(model: &SourceJson) -> Vec<JsString16> {
    let mut levels = Vec::new();
    if c::get(model, "supports_disabled_thinking").is_some_and(|v| v.as_str() == "true") {
        levels.push("none".into());
    }
    if let Some(raw) = c::get(model, "supported_reasoning_levels")
        .as_ref()
        .and_then(c::array)
    {
        levels.extend(raw.iter().filter_map(c::string));
    }
    levels
}
#[derive(Clone, Debug, PartialEq)]
pub struct RequestModelMetadata {
    pub snapshot: Option<ModelSnapshot>,
    pub record: Option<SourceJson>,
    pub reasoning: ModelReasoning,
    pub supported_endpoints: Option<Vec<String>>,
}
impl RequestModelMetadata {
    pub fn prompt_cache(&self) -> Option<SourceJson> {
        self.record
            .as_ref()
            .and_then(|record| c::get(record, "prompt_cache"))
    }
}
pub fn request_model_metadata(
    input: &CatalogInput,
    model: &ModelId,
    responses: bool,
    now_ms: i64,
) -> RequestModelMetadata {
    if model.matches_scalar("glm-5.2") {
        let record = c::object(vec![("slug", c::json("glm-5.2"))]);
        return RequestModelMetadata {
            snapshot: None,
            reasoning: ModelReasoning::from_record(Some(&record)),
            record: Some(record),
            supported_endpoints: Some(vec!["openai".into(), "openai-response".into()]),
        };
    }
    let snapshot = input.snapshot.clone();
    if let Some(record) = snapshot.as_ref().and_then(|s| s.find(model)).cloned() {
        return RequestModelMetadata {
            snapshot,
            reasoning: ModelReasoning::from_record(Some(&record)),
            record: Some(record),
            supported_endpoints: None,
        };
    }
    let matches_model = |row: &&SourceJson| {
        c::get(row, "id")
            .as_ref()
            .and_then(c::string)
            .is_some_and(|id| &id == model.as_js_string())
    };
    if input.enabled("claude_code")
        && let Some(row) = input.rows("claude_code").iter().find(matches_model)
    {
        let mut record = c::object(vec![
            ("slug", c::get(row, "id").expect("matched model")),
            ("supported_reasoning_levels", c::json(&claude_levels(row))),
        ]);
        if c::get(row, "supports_disabled_thinking").is_some_and(|v| v.as_str() == "true") {
            c::set(&mut record, "default_reasoning_level", c::json("none"));
        }
        return RequestModelMetadata {
            snapshot,
            reasoning: ModelReasoning::from_record(Some(&record)),
            record: Some(record),
            supported_endpoints: Some(vec!["openai".into(), "openai-response".into()]),
        };
    }
    let endpoint = if responses {
        "openai-response"
    } else {
        "openai"
    };
    let candidates = ["openlux", "surplus"]
        .iter()
        .filter_map(|provider| {
            input
                .rows(provider)
                .iter()
                .find(matches_model)
                .map(|r| (*provider, r))
        })
        .collect::<Vec<_>>();
    if let Some((provider, paid)) = candidates
        .iter()
        .find(|(_, m)| endpoint_supports(m, endpoint))
        .or_else(|| candidates.first())
    {
        let record = c::object(vec![
            ("slug", c::json(model)),
            ("supported_reasoning_levels", c::json(&["none"])),
            ("default_reasoning_level", c::json("none")),
        ]);
        let snapshot = snapshot.or_else(|| {
            Some(ModelSnapshot {
                models: Vec::new(),
                source: if *provider == "openlux" {
                    "metered"
                } else {
                    "surplus"
                }
                .into(),
                updated_at_ms: input
                    .providers
                    .get(*provider)
                    .and_then(|p| p.updated_at_ms)
                    .unwrap_or(now_ms),
                client_version: None,
            })
        });
        // Only finite endpoint membership is consumed here; original source rows remain authoritative.
        let endpoints = c::get(paid, "supported_endpoint_types")
            .as_ref()
            .and_then(c::array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| c::string(item).and_then(|s| s.try_utf8().ok()))
                    .collect()
            });
        return RequestModelMetadata {
            snapshot,
            reasoning: ModelReasoning::from_record(Some(&record)),
            record: Some(record),
            supported_endpoints: endpoints,
        };
    }
    RequestModelMetadata {
        snapshot,
        record: None,
        reasoning: ModelReasoning::default(),
        supported_endpoints: None,
    }
}
pub fn validate_model_available(
    model: &ModelId,
    responses: bool,
    metadata: &RequestModelMetadata,
) -> Result<(), SourceRequestError> {
    let route = if responses {
        "responses"
    } else {
        "chat.completions"
    };
    let endpoint = if responses {
        "openai-response"
    } else {
        "openai"
    };
    let suffix = if metadata
        .supported_endpoints
        .as_ref()
        .is_some_and(|e| !e.iter().any(|e| e == endpoint))
    {
        Some(format!(
            "' does not support {route}. Use /v1/models for supported models."
        ))
    } else if metadata
        .snapshot
        .as_ref()
        .is_some_and(|s| !s.models.is_empty())
        && metadata.record.is_none()
        && !c::matches(&c::trim(model.as_js_string()), "gpt-reserve")
    {
        Some("' does not exist or is not available through this gateway. Use /v1/models for supported models.".into())
    } else {
        None
    };
    if let Some(suffix) = suffix {
        let prefix = JsString16::from_utf8("The model '");
        let suffix = JsString16::from_utf8(&suffix);
        Err(SourceRequestError::new(
            404,
            c::concat(&[&prefix, model.as_js_string(), &suffix]),
            "invalid_request_error",
            Some("model_not_found"),
            Some(Some("model".into())),
        ))
    } else {
        Ok(())
    }
}
