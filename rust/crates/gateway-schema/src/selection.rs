//! Operator selection, whitelist and non-secret per-account model eligibility hints.
use crate::aliases::SourceStringCollator;
use crate::{
    aliases::{LEGACY_SYNTHETIC_MODEL, SYNTHETIC_MODEL},
    util::*,
};
use gateway_core::{model::ModelId, source_json::SourceJson};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
pub const PROVIDERS: &[&str] = &[
    "codex",
    "claude_code",
    "surplus",
    "openlux",
    "deepseek",
    "cerebras",
    "lithos",
    "openrouter",
    "ubiquity",
];
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderSelection {
    pub provider_ids: Vec<String>,
    pub updated_at_ms: i64,
}
fn subscription_hash(id: &str) -> Option<&str> {
    id.strip_prefix("codex:").filter(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn normalize_provider_ids(values: &[Value]) -> Vec<String> {
    let mut subscriptions = Vec::new();
    let mut submitted = Vec::new();
    for value in values {
        if let Some(id) = normalized_string(Some(value)) {
            if PROVIDERS.contains(&id.as_str()) {
                push_unique(&mut submitted, id);
            } else if subscription_hash(&id).is_some() {
                push_unique(&mut subscriptions, id);
            }
        }
    }
    let mut result: Vec<_> = PROVIDERS
        .iter()
        .filter(|p| submitted.iter().any(|s| s == **p))
        .map(|s| (*s).to_owned())
        .collect();
    if !submitted.iter().any(|s| s == "codex") {
        subscriptions.sort();
        result.extend(subscriptions);
    }
    result
}
impl ProviderSelection {
    pub fn enabled(selection: Option<&Self>, provider: &str) -> bool {
        selection.is_none_or(|s| {
            s.provider_ids.is_empty()
                || s.provider_ids.iter().any(|p| p == provider)
                || (provider == "codex"
                    && s.provider_ids
                        .iter()
                        .any(|p| subscription_hash(p).is_some()))
        })
    }
    pub fn account_eligible(&self, hash: &str) -> bool {
        self.provider_ids.is_empty()
            || self
                .provider_ids
                .iter()
                .any(|p| p == "codex" || subscription_hash(p) == Some(hash))
    }
    pub fn normalize(value: &Value) -> Option<Self> {
        let ids = value.get("provider_ids")?.as_array()?;
        if ids.iter().any(|v| !v.is_string()) {
            return None;
        }
        let updated = positive_integer(value.get("updated_at_ms"))?;
        Some(Self {
            provider_ids: normalize_provider_ids(ids),
            updated_at_ms: updated,
        })
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelWhitelist {
    pub model_ids: Vec<ModelId>,
    pub updated_at_ms: i64,
}
pub fn canonical_whitelist_id(id: &ModelId) -> ModelId {
    if id.matches_scalar(LEGACY_SYNTHETIC_MODEL) {
        ModelId::from_scalar(SYNTHETIC_MODEL)
    } else {
        id.clone()
    }
}
pub fn normalize_whitelist_ids(values: &[SourceJson]) -> Vec<ModelId> {
    let mut ids = Vec::new();
    for value in values {
        if let Some(id) = crate::model_control::normalized(Some(value)).map(ModelId::from_source) {
            crate::model_control::push_unique(&mut ids, canonical_whitelist_id(&id));
        }
    }
    ids
}
impl ModelWhitelist {
    pub fn normalize(value: &SourceJson) -> Option<Self> {
        let raw = crate::model_control::get(value, "model_ids")
            .as_ref()
            .and_then(crate::model_control::array)?;
        let mut ids = Vec::new();
        for item in &raw {
            ids.push(canonical_whitelist_id(&ModelId::from_source(
                crate::model_control::normalized(Some(item))?,
            )));
        }
        Some(Self {
            model_ids: ids,
            updated_at_ms: crate::model_control::positive(
                crate::model_control::get(value, "updated_at_ms").as_ref(),
            )?,
        })
    }
    pub fn permits(whitelist: Option<&Self>, id: &ModelId) -> bool {
        whitelist.is_none_or(|w| w.model_ids.is_empty() || w.model_ids.iter().any(|s| s == id))
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AccountModelCatalog {
    pub slugs: Vec<ModelId>,
    pub client_version: String,
    pub updated_at_ms: i64,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountModelsStore {
    pub accounts: BTreeMap<String, AccountModelCatalog>,
    pub unsupported: BTreeMap<String, IndexMap<ModelId, i64>>,
}
impl AccountModelsStore {
    pub fn record_catalogs(&self, entries: &[(String, AccountModelCatalog)]) -> Self {
        let mut next = self.clone();
        for (account, catalog) in entries {
            let mut catalog = catalog.clone();
            let mut slugs = Vec::new();
            for slug in &catalog.slugs {
                let slug = crate::model_control::trim(slug.as_js_string());
                if !slug.as_units().is_empty() {
                    crate::model_control::push_unique(&mut slugs, ModelId::from_source(slug));
                }
            }
            catalog.slugs = slugs;
            next.accounts.insert(account.clone(), catalog.clone());
            if let Some(rejections) = next.unsupported.get_mut(account) {
                for slug in &catalog.slugs {
                    rejections.shift_remove(slug);
                }
                if rejections.is_empty() {
                    next.unsupported.remove(account);
                }
            }
        }
        next
    }
    pub fn record_unsupported(
        &self,
        account: &str,
        model: &ModelId,
        at_ms: i64,
        collator: &dyn SourceStringCollator,
    ) -> Result<Self, gateway_core::GatewayError> {
        use gateway_core::source_serialization as source;
        let mut next = self.clone();
        let entries = next.unsupported.entry(account.into()).or_default();
        entries.insert(model.clone(), at_ms);
        let raw = source::object_keys(
            entries
                .iter()
                .map(|(model, at)| (model.as_js_string().clone(), crate::model_control::json(at)))
                .collect(),
        )?;
        // Object.entries enumerates numeric keys first, even after inserting a new numeric-looking model.
        let mut ordered = source::entries(&raw)
            .expect("model object")
            .into_iter()
            .map(|(key, _)| {
                let model = ModelId::from_source(key);
                let time = entries[&model];
                (model, time)
            })
            .collect::<Vec<_>>();
        ordered.retain(|(_, at)| at_ms - *at <= 7 * 24 * 60 * 60_000);
        let mut ordered =
            crate::aliases::sort_source(ordered, &|a: &(ModelId, i64), b: &(ModelId, i64)| {
                let by_time = b.1.cmp(&a.1);
                if by_time == std::cmp::Ordering::Equal {
                    collator.compare(a.0.as_js_string(), b.0.as_js_string())
                } else {
                    Ok(by_time)
                }
            })?;
        ordered.truncate(32);
        *entries = ordered.into_iter().collect();
        Ok(next)
    }
    pub fn unavailable(
        &self,
        model: &ModelId,
        current_accounts: &[String],
        now_ms: i64,
    ) -> Vec<String> {
        let target = ModelId::from_source(crate::model_control::trim(model.as_js_string()));
        if target.as_js_string().as_units().is_empty() {
            return Vec::new();
        }
        let mut result = Vec::new();
        for account in current_accounts {
            let learned = self
                .unsupported
                .get(account)
                .and_then(|m| m.get(&target))
                .is_some_and(|at| now_ms - *at <= 7 * 24 * 60 * 60_000);
            let absent = self.accounts.get(account).is_some_and(|c| {
                !c.slugs.contains(&target)
                    && current_accounts.iter().any(|other| {
                        other != account
                            && self.accounts.get(other).is_some_and(|s| {
                                s.client_version == c.client_version && s.slugs.contains(&target)
                            })
                    })
            });
            if learned || absent {
                push_unique(&mut result, account.clone());
            }
        }
        result
    }
    pub fn parse(value: &SourceJson) -> Option<Self> {
        use crate::model_control as c;
        use gateway_core::source_serialization as source;
        let accounts = c::get(value, "accounts").filter(c::is_record);
        let unsupported = c::get(value, "unsupported").filter(c::is_record);
        if accounts.is_none() && unsupported.is_none() {
            return None;
        }
        let mut store = Self::default();
        if let Some(accounts) = accounts.as_ref().and_then(source::entries) {
            for (account, raw) in accounts {
                let Ok(account) = account.try_utf8() else {
                    continue;
                };
                if crate::util::js_trim(&account).is_empty() {
                    continue;
                }
                let Some(client_version) = c::normalized(c::get(&raw, "client_version").as_ref())
                    .and_then(|s| s.try_utf8().ok())
                else {
                    continue;
                };
                let Some(updated_at_ms) = c::positive(c::get(&raw, "updated_at_ms").as_ref())
                else {
                    continue;
                };
                let Some(raw_slugs) = c::get(&raw, "slugs").as_ref().and_then(c::array) else {
                    continue;
                };
                let mut slugs = Vec::new();
                for slug in raw_slugs.iter().filter_map(|v| c::normalized(Some(v))) {
                    c::push_unique(&mut slugs, ModelId::from_source(slug));
                }
                store.accounts.insert(
                    account,
                    AccountModelCatalog {
                        slugs,
                        client_version,
                        updated_at_ms,
                    },
                );
            }
        }
        if let Some(unsupported) = unsupported.as_ref().and_then(source::entries) {
            for (account, raw) in unsupported {
                let Ok(account) = account.try_utf8() else {
                    continue;
                };
                if crate::util::js_trim(&account).is_empty() {
                    continue;
                }
                let Some(models) = source::entries(&raw) else {
                    continue;
                };
                let entries: IndexMap<_, _> = models
                    .into_iter()
                    .filter_map(|(model, value)| {
                        if c::trim(&model).as_units().is_empty() {
                            None
                        } else {
                            c::positive(Some(&value)).map(|n| (ModelId::from_source(model), n))
                        }
                    })
                    .collect();
                if !entries.is_empty() {
                    store.unsupported.insert(account, entries);
                }
            }
        }
        Some(store)
    }
    pub fn to_source_json(&self) -> SourceJson {
        use gateway_core::{js_string::JsString16, source_serialization as source};
        let rows = self
            .unsupported
            .iter()
            .map(|(account, entries)| {
                let row = source::object_keys(
                    entries
                        .iter()
                        .map(|(model, at)| {
                            (model.as_js_string().clone(), crate::model_control::json(at))
                        })
                        .collect(),
                )
                .expect("model-keyed source record");
                (JsString16::from_utf8(account), row)
            })
            .collect();
        crate::model_control::object(vec![
            ("accounts", crate::model_control::json(&self.accounts)),
            (
                "unsupported",
                source::object_keys(rows).expect("account-keyed source record"),
            ),
        ])
    }
}
impl Serialize for AccountModelsStore {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_source_json().serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for AccountModelsStore {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <SourceJson as Deserialize>::deserialize(deserializer)?;
        Self::parse(&raw)
            .ok_or_else(|| serde::de::Error::custom("Malformed source account-model record"))
    }
}
