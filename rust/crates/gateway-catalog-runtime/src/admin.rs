//! Finite, already-authorized administrator catalog operations; no HTTP or credential ownership.
use crate::{CatalogRuntime, CatalogState, host::*, state};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::{AtomicTransition, CommitOutcome, RecordMutation, StoredRecord},
};
use gateway_schema::{
    catalog::{
        ProviderCatalog, build_catalog_snapshot, public_catalog as public_catalog_projection,
    },
    catalog_store,
    runtime_config::{build_runtime_config, normalize_runtime_config},
    selection::{ModelWhitelist, normalize_whitelist_ids},
    snapshot::{SnapshotOverrides, normalize_snapshot},
    util::{invalid, json_stringify},
};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::BTreeMap,
    future::{Future, poll_fn},
    task::Poll,
};

const SAFE_KV_BYTES: usize = 60_000;
const MAX_KV_BYTES: usize = 65_536;

/// Source String.localeCompare is supplied by the existing host, never byte-order emulated.
pub trait AdminCatalogHost: CatalogHost {
    fn compare_model_ids(&self, left: &str, right: &str) -> Result<Ordering, GatewayError>;
    /// Schedule the fixed optional OpenRouter refresh on the current request's lifetime.
    /// This must return immediately; the existing discovery deadline remains in force.
    fn warm_openrouter(&self);
}

pub enum AdminCatalogOperation {
    CodexModelsGet,
    CodexModelsSet { document: Value },
    WhitelistGet,
    WhitelistSet { document: Value },
    Catalog,
    Refresh,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AdminCatalogResponse {
    pub status: u16,
    pub body: Value,
    pub headers: BTreeMap<String, String>,
}
impl AdminCatalogResponse {
    fn json(body: Value, no_store: bool) -> Self {
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
fn runtime_error(error: GatewayError) -> GatewayError {
    let message = error.envelope.error.message;
    let status = if message.contains("too large") || message.contains("4 KiB") {
        413
    } else {
        409
    };
    GatewayError::new(status, message, Some("runtime_config_invalid"))
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64() != Some(0.0),
        _ => true,
    }
}
fn whitelist(record: Option<&StoredRecord>) -> Value {
    record
        .and_then(|row| ModelWhitelist::normalize(&row.value))
        .map(|row| json!(row))
        .unwrap_or_else(|| json!({"model_ids":[],"updated_at_ms":0}))
}
fn provider_summary(snapshot: Option<&ProviderCatalog>) -> Value {
    json!({"models":snapshot.map(|s|s.models.len()).unwrap_or(0),"updated_at_ms":snapshot.and_then(|s|s.updated_at_ms)})
}

fn order_rows<H: AdminCatalogHost>(host: &H, rows: &mut [Value]) -> Result<(), GatewayError> {
    let mut failed = None;
    rows.sort_by(|left, right| {
        if failed.is_some() {
            return Ordering::Equal;
        }
        match host.compare_model_ids(
            left["id"].as_str().unwrap_or(""),
            right["id"].as_str().unwrap_or(""),
        ) {
            Ok(order) => order,
            Err(error) => {
                failed = Some(error);
                Ordering::Equal
            }
        }
    });
    match failed {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

impl CatalogRuntime {
    /// Public catalog projection only; administrator operations retain separate authorization.
    pub async fn public_catalog<S: QueryStore, H: AdminCatalogHost>(
        &self,
        store: &S,
        host: &H,
    ) -> Result<AdminCatalogResponse, GatewayError> {
        let loaded = self.admin_catalog_view(store, host).await?;
        let mut catalog = public_catalog_projection(&loaded.input);
        if let Some(models) = catalog["data"].as_array_mut() {
            order_rows(host, models)?;
        }
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
    ) -> Result<AdminCatalogResponse, GatewayError> {
        match operation {
            AdminCatalogOperation::CodexModelsGet => {
                let snapshot = state::read_json(store, &catalog_store::codex_snapshot_key())
                    .await
                    .ok()
                    .flatten()
                    .filter(|row| state::parse_full_snapshot(&row.value).is_some())
                    .map(|row| row.value)
                    .unwrap_or(Value::Null);
                Ok(AdminCatalogResponse::json(
                    json!({"ok":true,"data":snapshot}),
                    false,
                ))
            }
            AdminCatalogOperation::CodexModelsSet { document } => {
                self.admin_save_models(store, host, &document).await
            }
            AdminCatalogOperation::WhitelistGet => {
                let current = state::read_json(store, &state::whitelist_key()).await?;
                Ok(AdminCatalogResponse::json(
                    json!({"ok":true,"data":whitelist(current.as_ref())}),
                    false,
                ))
            }
            AdminCatalogOperation::WhitelistSet { document } => {
                self.admin_save_whitelist(store, host, &document).await
            }
            AdminCatalogOperation::Catalog => {
                let loaded = self.admin_catalog_view(store, host).await?;
                let mut catalog = build_catalog_snapshot(&loaded.input);
                if let Some(models) = catalog["models"].as_array_mut() {
                    order_rows(host, models)?;
                }
                let whitelist = loaded
                    .input
                    .whitelist
                    .map(|row| json!(row))
                    .unwrap_or_else(|| json!({"model_ids":[],"updated_at_ms":0}));
                let active = whitelist["model_ids"]
                    .as_array()
                    .is_some_and(|ids| !ids.is_empty());
                Ok(AdminCatalogResponse::json(
                    json!({"ok":true,"data":{"models":catalog["models"],"sources":catalog["sources"],"whitelist":whitelist,"filter_active":active}}),
                    true,
                ))
            }
            AdminCatalogOperation::Refresh => self.admin_refresh(store, host).await,
        }
    }

    async fn admin_save_models<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        document: &Value,
    ) -> Result<AdminCatalogResponse, GatewayError> {
        if !truthy(document) {
            return Err(invalid("Invalid JSON body", None));
        }
        let snapshot =
            normalize_snapshot(document, &SnapshotOverrides::default(), host.now_ms())
                .ok_or_else(|| invalid("models must include a non-empty models array", None))?;
        let size = json_stringify(&json!(snapshot)).len();
        if size > SAFE_KV_BYTES {
            return Err(GatewayError::new(
                413,
                format!("models snapshot too large ({size} bytes; max {MAX_KV_BYTES})."),
                Some("invalid_request_error"),
            ));
        }
        for _ in 0..3 {
            let current = state::read_json(store, &catalog_store::codex_snapshot_key()).await?;
            let runtime = state::read_json(store, &catalog_store::runtime_config_key()).await?;
            let previous = current
                .as_ref()
                .and_then(|row| state::parse_full_snapshot(&row.value));
            let next = snapshot.merge_prompt_cache(previous.as_ref());
            let old_runtime = runtime
                .as_ref()
                .and_then(|row| normalize_runtime_config(&row.value));
            let default = next.preserve_default(
                old_runtime
                    .as_ref()
                    .and_then(|r| r["default_model"].as_str()),
            );
            let next_runtime = build_runtime_config(
                &next,
                default.as_deref(),
                old_runtime
                    .as_ref()
                    .and_then(|r| r["default_reasoning_effort"].as_str()),
                host.now_ms(),
            )
            .map_err(runtime_error)?;
            let revision = host.unique_id();
            if store
                .commit(AtomicTransition {
                    checks: vec![
                        state::check(catalog_store::codex_snapshot_key(), current.as_ref()),
                        state::check(catalog_store::runtime_config_key(), runtime.as_ref()),
                    ],
                    mutations: vec![
                        RecordMutation::Put {
                            key: catalog_store::codex_snapshot_key(),
                            record: StoredRecord::json(&revision, json!(next), None),
                        },
                        RecordMutation::Put {
                            key: catalog_store::runtime_config_key(),
                            record: StoredRecord::json(&revision, next_runtime, None),
                        },
                    ],
                })
                .await?
                == CommitOutcome::Committed
            {
                return Ok(AdminCatalogResponse::json(
                    json!({"ok":true,"stored":true,"count":snapshot.models.len(),"source":snapshot.source,"updated_at_ms":snapshot.updated_at_ms,"client_version":snapshot.client_version}),
                    false,
                ));
            }
        }
        Err(persist_error(
            "Deno KV is not available; cannot persist Codex models",
        ))
    }

    async fn admin_save_whitelist<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        document: &Value,
    ) -> Result<AdminCatalogResponse, GatewayError> {
        if !document.is_object() && !document.is_array() {
            return Err(invalid("Invalid JSON body", None));
        }
        let raw = document
            .get("model_ids")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("model_ids must be an array", None))?;
        if raw.iter().any(|value| !value.is_string()) {
            return Err(invalid("model_ids must contain only strings", None));
        }
        let ids = normalize_whitelist_ids(raw);
        if json_stringify(&json!({"model_ids":ids})).len() > SAFE_KV_BYTES {
            return Err(GatewayError::new(
                413,
                format!("model_ids payload too large (max {MAX_KV_BYTES} bytes)."),
                Some("invalid_request_error"),
            ));
        }
        let now = host.now_ms();
        if store
            .commit(AtomicTransition {
                checks: vec![],
                mutations: vec![RecordMutation::Put {
                    key: state::whitelist_key(),
                    record: StoredRecord::json(
                        host.unique_id(),
                        json!({"model_ids":ids,"updated_at_ms":now}),
                        None,
                    ),
                }],
            })
            .await?
            == CommitOutcome::Committed
        {
            return Ok(AdminCatalogResponse::json(
                json!({"ok":true,"stored":true,"model_ids":ids,"updated_at_ms":host.now_ms()}),
                false,
            ));
        }
        Err(persist_error(
            "Deno KV is not available; cannot persist model whitelist",
        ))
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
            json!({"ok":true,"data":{
                "openrouter":{"upstream_models":router.as_ref().map(|s|s.models.len()).unwrap_or(0),"updated_at_ms":router.as_ref().and_then(|s|s.updated_at_ms),"refreshed":router.as_ref().and_then(|s|s.updated_at_ms) != old_router},
                "openlux":provider_summary(self.cached_provider(&current,CatalogProvider::Openlux).as_ref()),
                "surplus":provider_summary(surplus.as_ref()),
                "lithos":lithos_value,
                "claude_code":{"models":claude.as_ref().map(|s|s.models.len()).unwrap_or(0),"updated_at_ms":claude.as_ref().and_then(|s|s.updated_at_ms),"status":if claude.as_ref().is_some_and(|s|!s.stale){"available"}else{"unavailable"},"stale":claude.as_ref().is_some_and(|s|s.stale)}
            }}),
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
