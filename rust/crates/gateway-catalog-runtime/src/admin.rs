//! Finite, already-authorized administrator catalog operations; no HTTP or credential ownership.
use crate::{CatalogRuntime, CatalogState, host::*, state};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    source_control::encode_source_control_record,
    source_json::SourceJson,
    source_serialization as source,
    state::{AtomicTransition, CommitOutcome, RecordMutation},
};
use gateway_schema::{
    catalog::{
        ProviderCatalog, build_catalog_snapshot, public_catalog as public_catalog_projection,
    },
    catalog_store,
    runtime_config::{
        build_runtime_config, default_model, default_reasoning_effort, normalize_runtime_config,
    },
    selection::{ModelWhitelist, normalize_whitelist_ids},
    snapshot::{SnapshotOverrides, normalize_snapshot},
    source_request::SourceRequestError,
    util,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::{Future, poll_fn},
    task::Poll,
};

const SAFE_KV_BYTES: usize = 60_000;
const MAX_KV_BYTES: usize = 65_536;

/// Source String.localeCompare is supplied by the existing host, never byte-order emulated.
pub trait AdminCatalogHost: CatalogHost {
    /// Schedule the fixed optional OpenRouter refresh on the current request's lifetime.
    /// This must return immediately; the existing discovery deadline remains in force.
    fn warm_openrouter(&self);
}

pub enum AdminCatalogOperation {
    CodexModelsGet,
    CodexModelsSet { document: SourceJson },
    WhitelistGet,
    WhitelistSet { document: SourceJson },
    Catalog,
    Refresh,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AdminCatalogResponse {
    pub status: u16,
    pub body: SourceJson,
    pub headers: BTreeMap<String, String>,
}
impl AdminCatalogResponse {
    fn json(body: SourceJson, no_store: bool) -> Self {
        let mut headers = BTreeMap::from([("content-type".into(), "application/json".into())]);
        if no_store {
            headers.insert("cache-control".into(), "no-store".into());
        }
        Self {
            status: 200,
            body,
            headers,
        }
    }
}
fn persist_error(message: &str) -> GatewayError {
    GatewayError::new(500, message, Some("server_error")).with_type("server_error")
}
fn lift(error: GatewayError) -> SourceRequestError {
    SourceRequestError::from_gateway(error)
}
fn invalid(message: &str, param: Option<&str>) -> SourceRequestError {
    lift(util::invalid(message, param))
}
fn json_source<T: Serialize + ?Sized>(value: &T) -> SourceJson {
    SourceJson::from_serializable(value).expect("finite catalog control")
}
fn object(fields: Vec<(&str, SourceJson)>) -> SourceJson {
    source::object(fields).expect("catalog source response")
}
fn member(value: &SourceJson, key: &str) -> SourceJson {
    source::member(value, key).unwrap_or_else(|| json_source(&()))
}
fn runtime_error(error: SourceRequestError) -> SourceRequestError {
    let message = source::member(error.body(), "error")
        .and_then(|v| source::member(&v, "message"))
        .as_ref()
        .and_then(source::string)
        .expect("source error message");
    let includes = |text: &str| {
        let pattern = text.encode_utf16().collect::<Vec<_>>();
        message
            .as_units()
            .windows(pattern.len())
            .any(|part| part == pattern)
    };
    let status = if includes("too large") || includes("4 KiB") {
        413
    } else {
        409
    };
    SourceRequestError::new(
        status,
        message,
        "invalid_request_error",
        Some("runtime_config_invalid"),
        None,
    )
}
fn truthy(value: &SourceJson) -> bool {
    match value.as_str() {
        "null" | "false" => false,
        _ => {
            if let Some(value) = source::string(value) {
                !value.as_units().is_empty()
            } else {
                source::number(value) != Some(0.0)
            }
        }
    }
}
fn whitelist(document: Option<&SourceJson>) -> SourceJson {
    document
        .and_then(ModelWhitelist::normalize)
        .as_ref()
        .map(json_source)
        .unwrap_or_else(|| json_source(&json!({"model_ids":[],"updated_at_ms":0})))
}
fn provider_summary(snapshot: Option<&ProviderCatalog>) -> Value {
    json!({"models":snapshot.map(|s|s.models.len()).unwrap_or(0),"updated_at_ms":snapshot.and_then(|s|s.updated_at_ms)})
}

impl CatalogRuntime {
    /// Public catalog projection only; administrator operations retain separate authorization.
    pub async fn public_catalog<S: QueryStore, H: AdminCatalogHost>(
        &self,
        store: &S,
        host: &H,
    ) -> Result<AdminCatalogResponse, SourceRequestError> {
        let loaded = self.admin_catalog_view(store, host).await.map_err(lift)?;
        let collator = self.source_string_collator(host);
        let catalog = public_catalog_projection(&loaded.input, collator.as_ref()).map_err(lift)?;
        Ok(AdminCatalogResponse::json(catalog, true))
    }

    async fn admin_catalog_view<S: QueryStore, H: AdminCatalogHost>(
        &self,
        store: &S,
        host: &H,
    ) -> Result<CatalogState, GatewayError> {
        host.warm_openrouter();
        self.admin_discover(
            store,
            host,
            [
                CatalogProvider::Openlux,
                CatalogProvider::Surplus,
                CatalogProvider::ClaudeCode,
            ],
            false,
        )
        .await?;
        let publication = host.publication().await?;
        self.load_public_state(store, &publication, host.now_ms())
            .await
    }

    /// Call only after the application's existing administrator authorization succeeds.
    pub async fn admin_catalog<S: QueryStore, H: AdminCatalogHost>(
        &self,
        store: &S,
        host: &H,
        operation: AdminCatalogOperation,
    ) -> Result<AdminCatalogResponse, SourceRequestError> {
        match operation {
            AdminCatalogOperation::CodexModelsGet => {
                let snapshot =
                    state::read_source_control(store, &catalog_store::codex_snapshot_key())
                        .await
                        .ok()
                        .flatten()
                        .filter(|row| state::parse_full_snapshot(&row.document).is_some())
                        .map(|row| row.document)
                        .unwrap_or_else(|| json_source(&()));
                Ok(AdminCatalogResponse::json(
                    object(vec![("ok", json_source(&true)), ("data", snapshot)]),
                    false,
                ))
            }
            AdminCatalogOperation::CodexModelsSet { document } => {
                self.admin_save_models(store, host, &document).await
            }
            AdminCatalogOperation::WhitelistGet => {
                let current = state::read_source_control(store, &state::whitelist_key())
                    .await
                    .map_err(lift)?;
                Ok(AdminCatalogResponse::json(
                    object(vec![
                        ("ok", json_source(&true)),
                        ("data", whitelist(current.as_ref().map(|r| &r.document))),
                    ]),
                    false,
                ))
            }
            AdminCatalogOperation::WhitelistSet { document } => {
                self.admin_save_whitelist(store, host, &document).await
            }
            AdminCatalogOperation::Catalog => {
                let loaded = self.admin_catalog_view(store, host).await.map_err(lift)?;
                let collator = self.source_string_collator(host);
                let catalog =
                    build_catalog_snapshot(&loaded.input, collator.as_ref()).map_err(lift)?;
                let whitelist = loaded
                    .input
                    .whitelist
                    .as_ref()
                    .map(json_source)
                    .unwrap_or_else(|| json_source(&json!({"model_ids":[],"updated_at_ms":0})));
                let active = source::member(&whitelist, "model_ids")
                    .as_ref()
                    .and_then(source::array)
                    .is_some_and(|ids| !ids.is_empty());
                Ok(AdminCatalogResponse::json(
                    object(vec![
                        ("ok", json_source(&true)),
                        (
                            "data",
                            object(vec![
                                ("models", member(&catalog, "models")),
                                ("sources", member(&catalog, "sources")),
                                ("whitelist", whitelist),
                                ("filter_active", json_source(&active)),
                            ]),
                        ),
                    ]),
                    true,
                ))
            }
            AdminCatalogOperation::Refresh => self.admin_refresh(store, host).await.map_err(lift),
        }
    }

    async fn admin_save_models<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        document: &SourceJson,
    ) -> Result<AdminCatalogResponse, SourceRequestError> {
        if !truthy(document) {
            return Err(invalid("Invalid JSON body", None));
        }
        let snapshot =
            normalize_snapshot(document, &SnapshotOverrides::default(), host.now_ms())
                .ok_or_else(|| invalid("models must include a non-empty models array", None))?;
        let size = source::canonical(&json_source(&snapshot))
            .map_err(lift)?
            .as_str()
            .len();
        if size > SAFE_KV_BYTES {
            return Err(lift(GatewayError::new(
                413,
                format!("models snapshot too large ({size} bytes; max {MAX_KV_BYTES})."),
                Some("invalid_request_error"),
            )));
        }
        for _ in 0..3 {
            let current = state::read_source_control(store, &catalog_store::codex_snapshot_key())
                .await
                .map_err(lift)?;
            let runtime = state::read_source_control(store, &catalog_store::runtime_config_key())
                .await
                .map_err(lift)?;
            let previous = current
                .as_ref()
                .and_then(|r| state::parse_full_snapshot(&r.document));
            let next = snapshot.merge_prompt_cache(previous.as_ref());
            let old_runtime = runtime
                .as_ref()
                .and_then(|r| normalize_runtime_config(&r.document));
            let old_default = old_runtime.as_ref().and_then(default_model);
            let old_effort = old_runtime.as_ref().and_then(default_reasoning_effort);
            let default = next.preserve_default(old_default.as_ref());
            let next_runtime =
                build_runtime_config(&next, default.as_ref(), old_effort.as_ref(), host.now_ms())
                    .map_err(runtime_error)?;
            let revision = host.unique_id();
            if store
                .commit(AtomicTransition {
                    checks: vec![
                        state::check(
                            catalog_store::codex_snapshot_key(),
                            current.as_ref().map(|r| &r.record),
                        ),
                        state::check(
                            catalog_store::runtime_config_key(),
                            runtime.as_ref().map(|r| &r.record),
                        ),
                    ],
                    mutations: vec![
                        RecordMutation::Put {
                            key: catalog_store::codex_snapshot_key(),
                            record: encode_source_control_record(
                                &revision,
                                &json_source(&next),
                                None,
                            )
                            .map_err(lift)?,
                        },
                        RecordMutation::Put {
                            key: catalog_store::runtime_config_key(),
                            record: encode_source_control_record(&revision, &next_runtime, None)
                                .map_err(lift)?,
                        },
                    ],
                })
                .await
                .map_err(lift)?
                == CommitOutcome::Committed
            {
                return Ok(AdminCatalogResponse::json(
                    object(vec![
                        ("ok", json_source(&true)),
                        ("stored", json_source(&true)),
                        ("count", json_source(&snapshot.models.len())),
                        ("source", json_source(&snapshot.source)),
                        ("updated_at_ms", json_source(&snapshot.updated_at_ms)),
                        ("client_version", json_source(&snapshot.client_version)),
                    ]),
                    false,
                ));
            }
        }
        Err(lift(persist_error(
            "Deno KV is not available; cannot persist Codex models",
        )))
    }
    async fn admin_save_whitelist<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        document: &SourceJson,
    ) -> Result<AdminCatalogResponse, SourceRequestError> {
        if source::entries(document).is_none() && source::array(document).is_none() {
            return Err(invalid("Invalid JSON body", None));
        }
        let raw = source::member(document, "model_ids")
            .as_ref()
            .and_then(source::array)
            .ok_or_else(|| invalid("model_ids must be an array", None))?;
        if raw.iter().any(|v| source::string(v).is_none()) {
            return Err(invalid("model_ids must contain only strings", None));
        }
        let ids = normalize_whitelist_ids(&raw);
        let minimal = object(vec![("model_ids", json_source(&ids))]);
        if source::canonical(&minimal).map_err(lift)?.as_str().len() > SAFE_KV_BYTES {
            return Err(lift(GatewayError::new(
                413,
                format!("model_ids payload too large (max {MAX_KV_BYTES} bytes)."),
                Some("invalid_request_error"),
            )));
        }
        let now = host.now_ms();
        let row = object(vec![
            ("model_ids", json_source(&ids)),
            ("updated_at_ms", json_source(&now)),
        ]);
        if store
            .commit(AtomicTransition {
                checks: vec![],
                mutations: vec![RecordMutation::Put {
                    key: state::whitelist_key(),
                    record: encode_source_control_record(host.unique_id(), &row, None)
                        .map_err(lift)?,
                }],
            })
            .await
            .map_err(lift)?
            == CommitOutcome::Committed
        {
            return Ok(AdminCatalogResponse::json(
                object(vec![
                    ("ok", json_source(&true)),
                    ("stored", json_source(&true)),
                    ("model_ids", json_source(&ids)),
                    ("updated_at_ms", json_source(&host.now_ms())),
                ]),
                false,
            ));
        }
        Err(lift(persist_error(
            "Deno KV is not available; cannot persist model whitelist",
        )))
    }

    async fn admin_refresh<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
    ) -> Result<AdminCatalogResponse, GatewayError> {
        let before = host.publication().await?;
        let old_router = self
            .cached_provider(&before, CatalogProvider::Openrouter)
            .and_then(|s| s.updated_at_ms);
        let old_lithos = self
            .cached_provider(&before, CatalogProvider::Lithos)
            .and_then(|s| s.updated_at_ms);
        let surplus = self
            .admin_discover(
                store,
                host,
                [
                    CatalogProvider::Openrouter,
                    CatalogProvider::Openlux,
                    CatalogProvider::Surplus,
                    CatalogProvider::Lithos,
                    CatalogProvider::ClaudeCode,
                ],
                true,
            )
            .await?;
        let current = host.publication().await?;
        let router = self.cached_provider(&current, CatalogProvider::Openrouter);
        let lithos = self.cached_provider(&current, CatalogProvider::Lithos);
        let claude = self.cached_provider(&current, CatalogProvider::ClaudeCode);
        let mut lithos_value = provider_summary(lithos.as_ref());
        lithos_value["refreshed"] =
            json!(lithos.as_ref().and_then(|s| s.updated_at_ms) != old_lithos);
        Ok(AdminCatalogResponse::json(
            json_source(&json!({"ok":true,"data":{
                "openrouter":{"upstream_models":router.as_ref().map(|s|s.models.len()).unwrap_or(0),"updated_at_ms":router.as_ref().and_then(|s|s.updated_at_ms),"refreshed":router.as_ref().and_then(|s|s.updated_at_ms) != old_router},
                "openlux":provider_summary(self.cached_provider(&current,CatalogProvider::Openlux).as_ref()),
                "surplus":provider_summary(surplus.as_ref()),
                "lithos":lithos_value,
                "claude_code":{"models":claude.as_ref().map(|s|s.models.len()).unwrap_or(0),"updated_at_ms":claude.as_ref().and_then(|s|s.updated_at_ms),"status":if claude.as_ref().is_some_and(|s|!s.stale){"available"}else{"unavailable"},"stale":claude.as_ref().is_some_and(|s|s.stale)}
            }})),
            true,
        ))
    }

    async fn admin_discover<S: QueryStore, H: CatalogHost, const N: usize>(
        &self,
        store: &S,
        host: &H,
        providers: [CatalogProvider; N],
        force: bool,
    ) -> Result<Option<ProviderCatalog>, GatewayError> {
        let mut futures = providers
            .iter()
            .map(|provider| {
                Box::pin(async move {
                    if *provider == CatalogProvider::Surplus {
                        self.refresh_anonymous_surplus(store, host, force).await
                    } else {
                        self.refresh_provider(store, host, *provider, force).await
                    }
                })
            })
            .collect::<Vec<_>>();
        let mut done = [false; N];
        let mut surplus = None;
        poll_fn(|context| {
            for (index, future) in futures.iter_mut().enumerate() {
                if !done[index] {
                    match future.as_mut().poll(context) {
                        Poll::Ready(Ok(snapshot)) => {
                            if providers[index] == CatalogProvider::Surplus {
                                surplus = snapshot;
                            }
                            done[index] = true;
                        }
                        Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                        Poll::Pending => {}
                    }
                }
            }
            if done.iter().all(|done| *done) {
                Poll::Ready(Ok(surplus.take()))
            } else {
                Poll::Pending
            }
        })
        .await
    }
}

#[cfg(test)]
mod source_error_tests {
    use super::*;
    #[test]
    fn runtime_error_keeps_opaque_model_units_and_original_status_mapping() {
        let message = gateway_core::js_string::JsString16::from_units(
            "runtime config default model is absent from the catalog: "
                .encode_utf16()
                .chain([0xd800])
                .collect(),
        );
        let error = runtime_error(SourceRequestError::new(
            503,
            message.clone(),
            "server_error",
            Some("runtime_config_invalid"),
            None,
        ));
        assert_eq!(error.status, 409);
        assert_eq!(
            source::string(&member(&member(error.body(), "error"), "message")),
            Some(message)
        );
        assert_eq!(
            member(&member(error.body(), "error"), "code"),
            json_source("runtime_config_invalid")
        );
        assert!(error.body().deserialize::<Value>().is_err());
        let large = runtime_error(lift(GatewayError::new(
            503,
            "runtime config is too large",
            Some("runtime_config_invalid"),
        )));
        assert_eq!(large.status, 413);
    }
}
