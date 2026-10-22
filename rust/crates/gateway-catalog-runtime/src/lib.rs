//! Request-owned catalog runtime. Network and credential ownership are typed host capabilities.
pub mod admin;
pub mod control;
pub mod host;
pub mod providers;
pub mod state;
mod versioned;
pub use host::*;
pub use state::CatalogState;

use gateway_core::{
    GatewayError, query::QueryStore, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::{catalog::ProviderCatalog, catalog_cache::CatalogResponse};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

const PROVIDER_FRESH_MS: i64 = 300_000;
const PROVIDER_RETRY_MS: i64 = 30_000;
#[derive(Clone, Eq, PartialEq)]
enum MemoIdentity {
    Anonymous,
    Credential(ProviderBinding),
}
struct Discovery {
    provider: CatalogProvider,
    identity: MemoIdentity,
    publication: Option<CredentialPublication>,
    force: bool,
    coalesce: bool,
}
#[derive(Clone)]
struct MemoEntry {
    identity: MemoIdentity,
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
    source_string_collator:
        Option<std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator>>,
}
impl CatalogRuntime {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_source_string_collator(
        mut self,
        collator: std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator>,
    ) -> Self {
        self.source_string_collator = Some(collator);
        self
    }
    pub(crate) fn source_string_collator<H: CatalogHost>(
        &self,
        host: &H,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        self.source_string_collator
            .clone()
            .unwrap_or_else(|| host.source_string_collator())
    }
    fn snapshots(
        &self,
        publication: &CredentialPublication,
    ) -> BTreeMap<CatalogProvider, ProviderCatalog> {
        self.snapshots_for_view(publication, false)
    }
    fn snapshots_for_view(
        &self,
        publication: &CredentialPublication,
        public: bool,
    ) -> BTreeMap<CatalogProvider, ProviderCatalog> {
        self.memo
            .borrow()
            .entries
            .iter()
            .filter_map(|(provider, entry)| {
                match &entry.identity {
                    MemoIdentity::Anonymous if *provider == CatalogProvider::Surplus => {
                        if !public && !publication.providers.contains_key(provider) {
                            return None;
                        }
                    }
                    MemoIdentity::Credential(binding) => {
                        publication.binding(*provider).filter(|b| b == binding)?;
                    }
                    MemoIdentity::Anonymous => return None,
                }
                entry.snapshot.clone().map(|mut snapshot| {
                    snapshot.configured = publication.providers.contains_key(provider);
                    (*provider, snapshot)
                })
            })
            .collect()
    }
    pub async fn load_state<S: QueryStore>(
        &self,
        store: &S,
        publication: &CredentialPublication,
        now_ms: i64,
    ) -> Result<CatalogState, GatewayError> {
        self.load_view(store, publication, now_ms, false).await
    }
    /// The source public/admin picker may show anonymous discovery without
    /// claiming that its provider has a configured inference credential.
    pub async fn load_public_state<S: QueryStore>(
        &self,
        store: &S,
        publication: &CredentialPublication,
        now_ms: i64,
    ) -> Result<CatalogState, GatewayError> {
        self.load_view(store, publication, now_ms, true).await
    }
    async fn load_view<S: QueryStore>(
        &self,
        store: &S,
        publication: &CredentialPublication,
        now_ms: i64,
        public: bool,
    ) -> Result<CatalogState, GatewayError> {
        self.hydrate_observations(store, publication, public, now_ms)
            .await?;
        let mut state = state::load_state(
            store,
            publication,
            self.snapshots_for_view(publication, public),
            now_ms,
            public,
        )
        .await?;
        state.refresh_due.retain(|provider| {
            self.memo
                .borrow()
                .entries
                .get(provider)
                .is_none_or(|e| e.retry_ms <= now_ms && e.shared_request.is_none())
        });
        Ok(state)
    }
    /// Durable provider inputs keep a fresh process's assembled catalog
    /// equivalent to the publishing process without persisting the final body.
    async fn hydrate_observations<S: gateway_core::state::AuthorityStore>(
        &self,
        store: &S,
        publication: &CredentialPublication,
        public: bool,
        now: i64,
    ) -> Result<(), GatewayError> {
        let Some(generation) = state::auth_generation(store).await? else {
            return Ok(());
        };
        let mut providers = publication.providers.keys().copied().collect::<Vec<_>>();
        if public && !providers.contains(&CatalogProvider::Surplus) {
            providers.push(CatalogProvider::Surplus);
        }
        for provider in providers {
            if !provider.discovery() {
                continue;
            }
            let binding = if provider == CatalogProvider::Surplus {
                None
            } else {
                publication.binding(provider)
            };
            if binding.is_none() && provider != CatalogProvider::Surplus {
                continue;
            }
            let identity = binding
                .clone()
                .map(MemoIdentity::Credential)
                .unwrap_or(MemoIdentity::Anonymous);
            if self
                .memo
                .borrow()
                .entries
                .get(&provider)
                .is_some_and(|entry| entry.identity == identity && entry.snapshot.is_some())
            {
                continue;
            }
            let Some(mut snapshot) = state::load_provider_observation(
                store,
                &generation,
                provider,
                binding.as_ref(),
                now,
            )
            .await?
            else {
                continue;
            };
            snapshot.configured = publication.providers.contains_key(&provider);
            let mut memo = self.memo.borrow_mut();
            if memo
                .entries
                .get(&provider)
                .is_some_and(|entry| entry.identity == identity && entry.snapshot.is_some())
            {
                continue;
            }
            memo.entries.insert(
                provider,
                MemoEntry {
                    identity,
                    snapshot: Some(snapshot),
                    expires_ms: now.saturating_add(PROVIDER_FRESH_MS),
                    retry_ms: 0,
                    published_generation: 0,
                    shared_request: None,
                },
            );
        }
        Ok(())
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
        let identity = if provider == CatalogProvider::Surplus {
            MemoIdentity::Anonymous
        } else {
            MemoIdentity::Credential(binding)
        };
        self.refresh_discovery(
            store,
            host,
            Discovery {
                provider,
                identity,
                publication: Some(publication),
                force,
                coalesce: !force || provider == CatalogProvider::ClaudeCode,
            },
        )
        .await
    }
    /// Source requireApiKey:false: same cache, independent request semantics,
    /// no spend/configured identity and no credential publication requirement.
    pub async fn refresh_anonymous_surplus<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        force: bool,
    ) -> Result<Option<ProviderCatalog>, GatewayError> {
        self.refresh_discovery(
            store,
            host,
            Discovery {
                provider: CatalogProvider::Surplus,
                identity: MemoIdentity::Anonymous,
                publication: None,
                force,
                coalesce: false,
            },
        )
        .await
    }
    async fn refresh_discovery<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        discovery: Discovery,
    ) -> Result<Option<ProviderCatalog>, GatewayError> {
        let Discovery {
            provider,
            identity,
            publication,
            force,
            coalesce,
        } = discovery;
        let now = host.now_ms();
        for _ in 0..401 {
            let pending = {
                let mut memo = self.memo.borrow_mut();
                let entry = memo.entries.entry(provider).or_insert_with(|| MemoEntry {
                    identity: identity.clone(),
                    snapshot: None,
                    expires_ms: 0,
                    retry_ms: 0,
                    published_generation: 0,
                    shared_request: None,
                });
                if entry.identity != identity {
                    *entry = MemoEntry {
                        identity: identity.clone(),
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
                if coalesce { entry.shared_request } else { None }
            };
            if pending.is_none() {
                break;
            }
            host.wait(25).await?;
            if let MemoIdentity::Credential(binding) = &identity
                && host.publication().await?.binding(provider).as_ref() != Some(binding)
            {
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
            if coalesce
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
            if coalesce && let Some(entry) = memo.entries.get_mut(&provider) {
                entry.shared_request = Some(request);
            }
            request
        };
        let _guard = PendingGuard {
            memo: self.memo.clone(),
            provider,
            request,
        };
        let result = self.discover(host, provider, &identity).await;
        if let MemoIdentity::Credential(binding) = &identity {
            let latest = host.publication().await?;
            if latest.binding(provider).as_ref() != Some(binding)
                || !state::checks_current(
                    store,
                    &publication
                        .as_ref()
                        .ok_or_else(|| unavailable("Catalog custody is absent"))?
                        .source_checks,
                )
                .await?
            {
                return Ok(None);
            }
        }
        if let Err(error) = &result
            && error.status == 499
        {
            return Err(error.clone());
        }
        let discovered = result.is_ok();
        let snapshot = {
            let mut memo = self.memo.borrow_mut();
            let Some(entry) = memo
                .entries
                .get_mut(&provider)
                .filter(|e| e.identity == identity)
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
                        configured: publication
                            .as_ref()
                            .is_some_and(|p| p.providers.contains_key(&provider)),
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
            entry.snapshot.clone()
        };
        if discovered
            && let Some(snapshot) = &snapshot
            && let Some(generation) = state::auth_generation(store).await?
        {
            let binding = match &identity {
                MemoIdentity::Credential(binding) => Some(binding),
                MemoIdentity::Anonymous => None,
            };
            state::persist_provider_observation(
                store,
                &generation,
                provider,
                binding,
                snapshot,
                &host.unique_id(),
                host.now_ms(),
            )
            .await?;
        }
        Ok(snapshot)
    }
    async fn discover<H: CatalogHost>(
        &self,
        host: &H,
        provider: CatalogProvider,
        identity: &MemoIdentity,
    ) -> Result<Vec<SourceJson>, GatewayError> {
        let started = host.now_ms();
        let mut all = Vec::<SourceJson>::new();
        let mut cursors = BTreeSet::new();
        let mut cursor = None;
        for _ in 0..if provider == CatalogProvider::ClaudeCode {
            20
        } else {
            1
        } {
            let request = match identity {
                MemoIdentity::Anonymous if provider == CatalogProvider::Surplus => {
                    CatalogFetch::AnonymousSurplus
                }
                MemoIdentity::Anonymous => {
                    return Err(unavailable("Unsupported anonymous catalog target"));
                }
                MemoIdentity::Credential(binding) => CatalogFetch::Provider {
                    provider,
                    binding: binding.clone(),
                    after_id: cursor,
                    deadline_ms: (provider == CatalogProvider::ClaudeCode)
                        .then_some(started.saturating_add(8_000)),
                },
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
            let parsed = SourceJson::parse(&response.body)
                .map_err(|_| unavailable("Provider model discovery did not return JSON"))?;
            let (rows, next) = providers::parse_page(provider, &parsed)?;
            for row in rows {
                if let Some(old) = all.iter_mut().find(|old| {
                    source::member(old, "id").as_ref().and_then(source::string)
                        == source::member(&row, "id").as_ref().and_then(source::string)
                }) {
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
    /// Publish completed credential-validation metadata into the one Claude memo.
    pub async fn cache_validated_claude<S: QueryStore, H: CatalogHost>(
        &self,
        store: &S,
        host: &H,
        binding: &ProviderBinding,
        models: Vec<SourceJson>,
        fetched_at_ms: i64,
    ) -> Result<bool, GatewayError> {
        let publication = host.publication().await?;
        publication.validate()?;
        if publication.binding(CatalogProvider::ClaudeCode).as_ref() != Some(binding)
            || !state::checks_current(store, &publication.source_checks).await?
        {
            return Ok(false);
        }
        if host
            .publication()
            .await?
            .binding(CatalogProvider::ClaudeCode)
            .as_ref()
            != Some(binding)
        {
            return Ok(false);
        }
        if fetched_at_ms <= 0 || fetched_at_ms > host.now_ms() {
            return Err(unavailable("Validated Claude catalog time is invalid"));
        }
        let snapshot = {
            let mut memo = self.memo.borrow_mut();
            memo.next_request = memo
                .next_request
                .checked_add(1)
                .ok_or_else(|| unavailable("Provider catalog request generation overflowed"))?;
            let request = memo.next_request;
            let snapshot = ProviderCatalog {
                models,
                updated_at_ms: Some(fetched_at_ms),
                configured: true,
                available: true,
                stale: false,
            };
            memo.entries.insert(
                CatalogProvider::ClaudeCode,
                MemoEntry {
                    identity: MemoIdentity::Credential(binding.clone()),
                    snapshot: Some(snapshot.clone()),
                    expires_ms: fetched_at_ms.saturating_add(PROVIDER_FRESH_MS),
                    retry_ms: 0,
                    published_generation: request,
                    shared_request: None,
                },
            );
            snapshot
        };
        if let Some(generation) = state::auth_generation(store).await? {
            state::persist_provider_observation(
                store,
                &generation,
                CatalogProvider::ClaudeCode,
                Some(binding),
                &snapshot,
                &host.unique_id(),
                host.now_ms(),
            )
            .await?;
        }
        Ok(true)
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
