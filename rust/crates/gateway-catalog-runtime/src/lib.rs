//! Request-owned catalog runtime. Network and credential ownership are typed host capabilities.
pub mod host;
pub mod providers;
pub mod state;
mod versioned;
pub use host::*;
pub use state::CatalogState;

use gateway_core::{GatewayError, query::QueryStore};
use gateway_schema::{catalog::ProviderCatalog, catalog_cache::CatalogResponse};
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

const PROVIDER_FRESH_MS: i64 = 300_000;
const PROVIDER_RETRY_MS: i64 = 30_000;
#[derive(Clone)]
struct MemoEntry {
    identity: String,
    snapshot: Option<ProviderCatalog>,
    expires_ms: i64,
    retry_ms: i64,
    published_generation: u64,
    shared_request: Option<u64>,
}
#[derive(Default)]
struct Memo {
    entries: BTreeMap<CatalogProvider, MemoEntry>,
    next_request: u64,
}
/// Dropping a cancelled request releases only that request's memo ownership.
struct PendingGuard {
    memo: Rc<RefCell<Memo>>,
    provider: CatalogProvider,
    request: u64,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some(entry) = self.memo.borrow_mut().entries.get_mut(&self.provider)
            && entry.shared_request == Some(self.request)
        {
            entry.shared_request = None;
        }
    }
}
#[derive(Clone, Default)]
pub struct CatalogRuntime {
    memo: Rc<RefCell<Memo>>,
}
impl CatalogRuntime {
    pub fn new() -> Self {
        Self::default()
    }
    fn snapshots(
        &self,
        publication: &CredentialPublication,
    ) -> BTreeMap<CatalogProvider, ProviderCatalog> {
        self.memo
            .borrow()
            .entries
            .iter()
            .filter_map(|(provider, entry)| {
                publication
                    .binding(*provider)
                    .filter(|b| b.identity == entry.identity)?;
                entry.snapshot.clone().map(|s| (*provider, s))
            })
            .collect()
    }
    pub async fn load_state<S: QueryStore>(
        &self,
        store: &S,
        publication: &CredentialPublication,
        now_ms: i64,
    ) -> Result<CatalogState, GatewayError> {
        let mut state =
            state::load_state(store, publication, self.snapshots(publication), now_ms).await?;
        state.refresh_due.retain(|provider| {
            self.memo
                .borrow()
                .entries
                .get(provider)
                .is_none_or(|e| e.retry_ms <= now_ms && e.shared_request.is_none())
        });
        Ok(state)
    }
    pub fn cached_provider(
        &self,
        publication: &CredentialPublication,
        provider: CatalogProvider,
    ) -> Option<ProviderCatalog> {
        self.snapshots(publication).remove(&provider)
    }
    /// Ordinary requests coalesce; forced independent refreshes retain generation ordering.
    /// Claude always coalesces and keys its capability proof by owner publication identity.
    pub async fn refresh_provider<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        provider: CatalogProvider,
        force: bool,
    ) -> Result<Option<ProviderCatalog>, GatewayError> {
        if !provider.discovery() {
            return Err(unavailable("This provider has no discovery endpoint"));
        }
        let publication = host.publication().await?;
        publication.validate()?;
        let Some(binding) = publication.binding(provider) else {
            return Ok(None);
        };
        let now = host.now_ms();
        for _ in 0..401 {
            let pending = {
                let mut memo = self.memo.borrow_mut();
                let entry = memo.entries.entry(provider).or_insert_with(|| MemoEntry {
                    identity: binding.identity.clone(),
                    snapshot: None,
                    expires_ms: 0,
                    retry_ms: 0,
                    published_generation: 0,
                    shared_request: None,
                });
                if entry.identity != binding.identity {
                    *entry = MemoEntry {
                        identity: binding.identity.clone(),
                        snapshot: None,
                        expires_ms: 0,
                        retry_ms: 0,
                        published_generation: 0,
                        shared_request: None,
                    };
                }
                if !force && (entry.expires_ms > now || entry.retry_ms > now) {
                    return Ok(entry.snapshot.clone());
                }
                if !force || provider == CatalogProvider::ClaudeCode {
                    entry.shared_request
                } else {
                    None
                }
            };
            if pending.is_none() {
                break;
            }
            host.wait(25).await?;
            if host.publication().await?.binding(provider).as_ref() != Some(&binding) {
                return Ok(None);
            }
            if self
                .memo
                .borrow()
                .entries
                .get(&provider)
                .is_some_and(|entry| entry.shared_request.is_none())
            {
                return Ok(self
                    .memo
                    .borrow()
                    .entries
                    .get(&provider)
                    .and_then(|entry| entry.snapshot.clone()));
            }
        }
        let request = {
            let mut memo = self.memo.borrow_mut();
            // A nonadvancing host clock cannot turn an outstanding refresh into duplicate work.
            if (!force || provider == CatalogProvider::ClaudeCode)
                && memo
                    .entries
                    .get(&provider)
                    .is_some_and(|e| e.shared_request.is_some())
            {
                return Ok(memo.entries.get(&provider).and_then(|e| e.snapshot.clone()));
            }
            memo.next_request = memo
                .next_request
                .checked_add(1)
                .ok_or_else(|| unavailable("Provider catalog request generation overflowed"))?;
            let request = memo.next_request;
            if (!force || provider == CatalogProvider::ClaudeCode)
                && let Some(entry) = memo.entries.get_mut(&provider)
            {
                entry.shared_request = Some(request);
            }
            request
        };
        let _guard = PendingGuard {
            memo: self.memo.clone(),
            provider,
            request,
        };
        let result = self.discover(host, provider, &binding).await;
        let latest = host.publication().await?;
        if latest.binding(provider).as_ref() != Some(&binding)
            || !state::checks_current(store, &publication.source_checks).await?
        {
            return Ok(None);
        }
        let mut memo = self.memo.borrow_mut();
        let Some(entry) = memo
            .entries
            .get_mut(&provider)
            .filter(|e| e.identity == binding.identity)
        else {
            return Ok(None);
        };
        if request < entry.published_generation {
            return Ok(entry.snapshot.clone());
        }
        match result {
            Ok(models) => {
                entry.published_generation = request;
                entry.retry_ms = 0;
                entry.expires_ms = host.now_ms().saturating_add(PROVIDER_FRESH_MS);
                entry.snapshot = Some(ProviderCatalog {
                    models,
                    updated_at_ms: Some(host.now_ms()),
                    configured: publication.providers.contains_key(&provider),
                    available: true,
                    stale: false,
                });
            }
            Err(error) => {
                if error.status == 499 {
                    return Err(error);
                }
                entry.retry_ms = host.now_ms().saturating_add(PROVIDER_RETRY_MS);
                if provider == CatalogProvider::ClaudeCode {
                    if let Some(snapshot) = &mut entry.snapshot {
                        providers::withdraw_stale_reasoning(&mut snapshot.models);
                        snapshot.stale = true;
                    }
                    entry.expires_ms = entry.retry_ms;
                }
            }
        }
        Ok(entry.snapshot.clone())
    }
    async fn discover<H: CatalogHost>(
        &self,
        host: &H,
        provider: CatalogProvider,
        binding: &ProviderBinding,
    ) -> Result<Vec<Value>, GatewayError> {
        let started = host.now_ms();
        let mut all = Vec::<Value>::new();
        let mut cursors = BTreeSet::new();
        let mut cursor = None;
        for _ in 0..if provider == CatalogProvider::ClaudeCode {
            20
        } else {
            1
        } {
            let request = CatalogFetch::Provider {
                provider,
                binding: binding.clone(),
                after_id: cursor,
                deadline_ms: (provider == CatalogProvider::ClaudeCode)
                    .then_some(started.saturating_add(8_000)),
            };
            let _remaining_timeout = request.remaining_timeout_ms(host.now_ms())?;
            let max_bytes = request.max_body_bytes();
            let response = host.fetch(request).await?;
            if max_bytes.is_some_and(|limit| response.body.len() > limit)
                || !(200..300).contains(&response.status)
            {
                return Err(unavailable("Provider model discovery is unavailable"));
            }
            if provider == CatalogProvider::ClaudeCode
                && host.now_ms().saturating_sub(started) > 8_000
            {
                return Err(unavailable(
                    "Claude model discovery exceeded its request deadline",
                ));
            }
            let parsed = serde_json::from_str(&response.body)
                .map_err(|_| unavailable("Provider model discovery did not return JSON"))?;
            let (rows, next) = providers::parse_page(provider, &parsed)?;
            for row in rows {
                if let Some(old) = all.iter_mut().find(|old| old.get("id") == row.get("id")) {
                    *old = row;
                } else {
                    all.push(row);
                }
            }
            match next {
                None => return Ok(all),
                Some(next) => {
                    if !cursors.insert(next.clone()) {
                        return Err(unavailable("Claude model discovery repeated a cursor"));
                    }
                    cursor = Some(next);
                }
            }
        }
        Err(unavailable(
            "Claude model discovery exceeded its page bound",
        ))
    }
    pub async fn versioned_models<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        raw_version: &str,
        conditional: Option<&str>,
    ) -> Result<CatalogResponse, GatewayError> {
        versioned::serve(self, store, host, raw_version, conditional).await
    }
}
