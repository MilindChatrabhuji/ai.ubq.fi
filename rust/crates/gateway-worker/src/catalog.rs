//! Source catalog projections over the same strong authority used by admission.
use std::collections::BTreeMap;

use gateway_core::tuple_key::{ScalarKeyPart, TupleKey};
use gateway_core::{
    GatewayError,
    state::{AuthorityStore, RecordKey},
};
use gateway_schema::{
    catalog::{CatalogInput, ProviderCatalog},
    catalog_cache::{self, CacheState, CatalogResponse},
    catalog_store,
    selection::{ModelWhitelist, ProviderSelection},
    snapshot::ModelSnapshot,
};
use serde_json::Value;
use worker::{Env, Request};

use crate::{authority::RemoteAuthorityStore, host::setting};

pub const DIRECT_PROVIDERS: &[(&str, &str)] = &[
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("cerebras", "CEREBRAS_API_KEY"),
    ("lithos", "LITHOSAI_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("surplus", "SURPLUS_API_KEY"),
    ("openlux", "OPENLUX_API_KEY"),
];

pub fn key(parts: &[&str]) -> RecordKey {
    TupleKey::from_scalar_parts(
        &parts
            .iter()
            .map(|part| ScalarKeyPart::String(part))
            .collect::<Vec<_>>(),
    )
    .to_record_key()
}

pub async fn json_record<S: AuthorityStore>(
    store: &S,
    key: &RecordKey,
    now: i64,
) -> Result<Option<Value>, GatewayError> {
    let Some(record) = store.read(key).await? else {
        return Ok(None);
    };
    if record.expires_at_ms.is_some_and(|expiry| expiry <= now) {
        return Ok(None);
    }
    Ok(Some(record.json_value()?.clone()))
}

pub struct CatalogState {
    pub input: CatalogInput,
    pub runtime: Option<Value>,
    pub secrets: BTreeMap<String, String>,
}

impl CatalogState {
    pub async fn load(
        store: &RemoteAuthorityStore,
        env: &Env,
        now: i64,
    ) -> Result<Self, GatewayError> {
        let runtime = json_record(store, &catalog_store::runtime_config_key(), now)
            .await?
            .and_then(|raw| gateway_schema::runtime_config::normalize_runtime_config(&raw));
        let full_snapshot = json_record(store, &catalog_store::codex_snapshot_key(), now)
            .await?
            .map(|raw| {
                serde_json::from_value::<ModelSnapshot>(raw)
                    .map_err(|_| unavailable("Stored Codex catalog is corrupt."))
            })
            .transpose()?;
        let snapshot = runtime
            .as_ref()
            .and_then(|raw| raw.get("codex_models"))
            .map(|raw| {
                serde_json::from_value::<ModelSnapshot>(raw.clone())
                    .map_err(|_| unavailable("Stored runtime catalog is corrupt."))
            })
            .transpose()?
            .or_else(|| full_snapshot.clone());
        let selection = json_record(store, &key(&["uos_ai", "provider_selection", "v1"]), now)
            .await?
            .as_ref()
            .and_then(ProviderSelection::normalize);
        let whitelist = json_record(store, &key(&["uos_ai", "codex_models_whitelist"]), now)
            .await?
            .as_ref()
            .and_then(ModelWhitelist::normalize);
        let mut providers = BTreeMap::new();
        let mut secrets = BTreeMap::new();
        for (provider, binding) in DIRECT_PROVIDERS {
            let secret = setting(env, binding)
                .or_else(|| {
                    if *provider == "openlux" {
                        setting(env, "METERED_API_KEY")
                    } else {
                        None
                    }
                })
                .filter(|secret| !secret.trim().is_empty());
            let configured = secret.is_some();
            if let Some(secret) = secret {
                secrets.insert((*provider).to_owned(), secret);
            }
            providers.insert(
                (*provider).to_owned(),
                ProviderCatalog {
                    configured,
                    available: configured,
                    ..Default::default()
                },
            );
        }
        Ok(Self {
            input: CatalogInput {
                snapshot,
                full_snapshot,
                providers,
                selection,
                whitelist,
                ..Default::default()
            },
            runtime,
            secrets,
        })
    }

    pub async fn native_models(
        &self,
        store: &RemoteAuthorityStore,
        request: &Request,
        version: &str,
        now: i64,
    ) -> Result<CatalogResponse, GatewayError> {
        let version = catalog_cache::validate_client_version(version)?;
        let generation = json_record(store, &catalog_store::auth_generation_key(), now).await?;
        if let Some(generation) = generation.as_ref().and_then(Value::as_str)
            && let Some(catalog) =
                catalog_store::load_catalog(store, &version, generation, now).await?
        {
            let conditional = request
                .headers()
                .get("if-none-match")
                .map_err(|_| unavailable("Invalid conditional catalog header."))?;
            let state = if catalog.metadata.fresh(now) {
                CacheState::Hit
            } else {
                CacheState::Stale
            };
            return Ok(catalog_cache::catalog_response(
                &catalog,
                conditional.as_deref(),
                state,
                &self.input,
            ));
        }
        catalog_cache::fallback_response(&self.input).ok_or_else(|| {
            unavailable("Codex model catalog is unavailable for this exact client version.")
        })
    }
}

fn unavailable(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("codex_catalog_unavailable"))
}
