use crate::{CatalogRuntime, host::*, state};
use gateway_core::{
    GatewayError, model::ModelId, query::QueryStore, source_json::SourceJson,
    source_serialization as source,
};
use gateway_schema::{
    catalog_cache::{self, CacheState, CatalogResponse, LoadedCatalog},
    catalog_store,
    reasoning::js_trim_source,
    snapshot::union_account_catalogs,
};
use std::{
    future::{Future, poll_fn},
    task::Poll,
};

struct Lease<'a> {
    version: &'a str,
    owner: &'a str,
    generation: &'a str,
}
struct Fetched {
    response: CatalogFetchResponse,
    evidence: Vec<(String, Vec<ModelId>)>,
    publication: CredentialPublication,
    degraded: bool,
}
async fn fetch_account<H: CatalogHost>(
    host: &H,
    account: &CodexAccount,
    version: &str,
    etag: Option<String>,
) -> Result<(CatalogFetchResponse, CodexAccount), GatewayError> {
    let mut account = account.clone();
    let mut request = CatalogFetch::Codex {
        account: account.clone(),
        client_version: version.into(),
        if_none_match: etag.clone(),
    };
    let mut response = observed_fetch(host, request.clone(), &account).await?;
    if response.status == 401 {
        account = host.refresh_codex(&account).await?;
        let latest = host.publication().await?;
        if !latest.codex_accounts.iter().any(|a| a == &account) {
            return Err(unavailable(
                "The credential owner did not durably publish its refreshed identity",
            ));
        }
        request = CatalogFetch::Codex {
            account: account.clone(),
            client_version: version.into(),
            if_none_match: etag,
        };
        response = observed_fetch(host, request.clone(), &account).await?;
    }
    if request
        .max_body_bytes()
        .is_some_and(|limit| response.body.len() > limit)
    {
        return Err(unavailable(
            "Codex model catalog exceeded its response bound",
        ));
    }
    Ok((response, account))
}
async fn observed_fetch<H: CatalogHost>(
    host: &H,
    request: CatalogFetch,
    account: &CodexAccount,
) -> Result<CatalogFetchResponse, GatewayError> {
    match host.fetch(request).await {
        Ok(response) => {
            let _ = host
                .observe(CatalogObservation::CodexResponse {
                    account: account.clone(),
                    status: response.status,
                    provider_request_id: response
                        .provider_request_id
                        .as_deref()
                        .and_then(normalized_request_id),
                    access_token_expired: response.access_token_expired,
                    observed_at_ms: response.observed_at_ms,
                })
                .await;
            Ok(response)
        }
        Err(error) => {
            let _ = host
                .observe(CatalogObservation::CodexTransportFailure {
                    account: account.clone(),
                    code: error.envelope.error.code.clone(),
                })
                .await;
            Err(error)
        }
    }
}
fn normalized_request_id(raw: &str) -> Option<String> {
    let value = gateway_schema::util::js_trim(raw);
    (!value.is_empty()
        && value.encode_utf16().count() <= 256
        && !value.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}'))
    .then(|| value.to_owned())
}
fn degraded(error: &GatewayError) -> bool {
    matches!(
        error.envelope.error.code.as_deref(),
        Some("gateway_timeout" | "codex_upstream_unreachable")
    )
}
fn evidence(account: &str, parsed: &SourceJson) -> Vec<(String, Vec<ModelId>)> {
    let Some(rows) = source::member(parsed, "models")
        .as_ref()
        .and_then(source::array)
    else {
        return Vec::new();
    };
    let mut slugs = Vec::new();
    for row in rows {
        let slug = ["slug", "id", "model", "name"]
            .iter()
            .find_map(|key| source::member(&row, key).as_ref().and_then(source::string));
        if let Some(slug) = slug
            .map(|s| js_trim_source(&s))
            .filter(|s| !s.as_units().is_empty())
        {
            let slug = ModelId::from_source(slug);
            if !slugs.contains(&slug) {
                slugs.push(slug);
            }
        }
    }
    vec![(account.into(), slugs)]
}

async fn fetch_codex<H: CatalogHost>(
    host: &H,
    initial: &CredentialPublication,
    version: &str,
    etag: Option<String>,
) -> Result<Fetched, GatewayError> {
    if initial.codex_accounts.is_empty() {
        return Err(unavailable("Codex authentication is unavailable"));
    }
    let union = initial.codex_accounts.len() > 1;
    let mut catalogs = Vec::new();
    let mut fallback = None;
    let mut last_error = None;
    let mut accepted = initial.clone();
    let mut degraded = false;
    for account in &initial.codex_accounts {
        let (response, used) = match fetch_account(
            host,
            account,
            version,
            if union { None } else { etag.clone() },
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                degraded |= self::degraded(&error);
                last_error = Some(error);
                continue;
            }
        };
        degraded |= (500..600).contains(&response.status);
        // An owned renewal can change the exact pool revision; no uncommitted return is accepted.
        let latest = host.publication().await?;
        let expected_accounts = accepted
            .codex_accounts
            .iter_mut()
            .find(|a| a.account_id == used.account_id);
        if let Some(expected) = expected_accounts {
            *expected = used.clone();
        }
        if latest.codex_accounts != accepted.codex_accounts {
            return Err(catalog_cache::rotation_unavailable());
        }
        accepted = latest;
        if !union {
            let evidence = if (200..300).contains(&response.status)
                && response.single_account_observation_complete
                && response.body.len() <= 4 * 1024 * 1024
            {
                SourceJson::parse(&response.body)
                    .ok()
                    .map(|p| evidence(&used.account_id, &p))
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            return Ok(Fetched {
                response,
                evidence,
                publication: accepted,
                degraded,
            });
        }
        if (200..300).contains(&response.status)
            && let Ok(parsed) = SourceJson::parse(&response.body)
            && source::entries(&parsed).is_some()
            && source::member(&parsed, "models")
                .as_ref()
                .and_then(source::array)
                .is_some()
        {
            catalogs.push((used.account_id, parsed));
            continue;
        }
        fallback = Some(response);
    }
    if let Some((parsed, evidence)) = union_account_catalogs(&catalogs) {
        return Ok(Fetched {
            response: CatalogFetchResponse::json(
                200,
                source::canonical(&parsed)?.as_str().to_owned(),
            ),
            evidence,
            publication: accepted,
            degraded,
        });
    }
    if let Some(response) = fallback {
        return Ok(Fetched {
            response,
            evidence: Vec::new(),
            publication: accepted,
            degraded,
        });
    }
    Err(last_error.unwrap_or_else(|| unavailable("Codex model discovery is unavailable")))
}
/// The request-owned heartbeat exists only while the one fetch future is live.
async fn with_lease<
    S: QueryStore,
    H: CatalogHost,
    F: Future<Output = Result<Fetched, GatewayError>>,
>(
    store: &S,
    host: &H,
    lease: &Lease<'_>,
    fetch: F,
) -> Result<Fetched, GatewayError> {
    enum Step<T> {
        Fetch(T),
        Tick(Result<(), GatewayError>),
    }
    let mut fetch = std::pin::pin!(fetch);
    loop {
        let mut wait = std::pin::pin!(host.wait(state::HEARTBEAT_MS));
        let step = poll_fn(|cx| {
            if let Poll::Ready(response) = fetch.as_mut().poll(cx) {
                return Poll::Ready(Step::Fetch(response));
            }
            if let Poll::Ready(tick) = wait.as_mut().poll(cx) {
                return Poll::Ready(Step::Tick(tick));
            }
            Poll::Pending
        })
        .await;
        match step {
            Step::Fetch(result) => return result,
            Step::Tick(tick) => {
                tick?;
                if !state::generation_current(store, lease.generation).await?
                    || !catalog_store::renew_refresh_lease(
                        store,
                        lease.version,
                        lease.owner,
                        host.now_ms(),
                    )
                    .await?
                {
                    return Err(catalog_cache::rotation_unavailable());
                }
            }
        }
    }
}
async fn response<S: QueryStore, H: CatalogHost>(
    runtime: &CatalogRuntime,
    store: &S,
    host: &H,
    cached: &LoadedCatalog,
    conditional: Option<&str>,
    cache_state: CacheState,
) -> Result<CatalogResponse, GatewayError> {
    let publication = host.publication().await?;
    let state = runtime
        .load_state(store, &publication, host.now_ms())
        .await?;
    Ok(catalog_cache::catalog_response(
        cached,
        conditional,
        cache_state,
        &state.input,
    ))
}
async fn fallback<S: QueryStore, H: CatalogHost>(
    runtime: &CatalogRuntime,
    store: &S,
    host: &H,
    message: &str,
) -> Result<CatalogResponse, GatewayError> {
    let publication = host.publication().await?;
    let state = runtime
        .load_state(store, &publication, host.now_ms())
        .await?;
    for provider in [
        CatalogProvider::Openlux,
        CatalogProvider::Surplus,
        CatalogProvider::ClaudeCode,
    ] {
        if state.input.enabled(provider.id()) {
            runtime
                .refresh_provider(
                    store,
                    host,
                    provider,
                    provider != CatalogProvider::ClaudeCode,
                )
                .await?;
        }
    }
    let publication = host.publication().await?;
    let state = runtime
        .load_state(store, &publication, host.now_ms())
        .await?;
    catalog_cache::fallback_response(&state.input).ok_or_else(|| unavailable(message))
}
async fn current<S: QueryStore, H: CatalogHost>(
    store: &S,
    host: &H,
    version: &str,
) -> Result<Option<LoadedCatalog>, GatewayError> {
    let Some(generation) = state::read_json(store, &catalog_store::auth_generation_key())
        .await?
        .and_then(|r| r.value.as_str().map(str::to_owned))
    else {
        return Ok(None);
    };
    state::load_exact_catalog(store, version, &generation, host.now_ms()).await
}
async fn recover<S: QueryStore, H: CatalogHost>(
    runtime: &CatalogRuntime,
    store: &S,
    host: &H,
    lease: &Lease<'_>,
    cached: Option<&LoadedCatalog>,
    conditional: Option<&str>,
    strict_rotation: bool,
) -> Result<CatalogResponse, GatewayError> {
    let current_generation = state::generation_current(store, lease.generation)
        .await
        .unwrap_or(false);
    if current_generation && let Some(cached) = cached {
        return response(runtime, store, host, cached, conditional, CacheState::Stale).await;
    }
    if let Some(replacement) = current(store, host, lease.version).await? {
        return response(
            runtime,
            store,
            host,
            &replacement,
            conditional,
            if current_generation {
                CacheState::Miss
            } else {
                CacheState::Rotated
            },
        )
        .await;
    }
    if strict_rotation {
        return Err(catalog_cache::rotation_unavailable());
    }
    fallback(
        runtime,
        store,
        host,
        "Codex upstream model catalog is unavailable",
    )
    .await
}
pub(crate) async fn serve<S: QueryStore, H: CatalogHost>(
    runtime: &CatalogRuntime,
    store: &S,
    host: &H,
    raw_version: &str,
    conditional: Option<&str>,
) -> Result<CatalogResponse, GatewayError> {
    let version = catalog_cache::validate_client_version(raw_version)?;
    let publication = host.publication().await?;
    publication.validate()?;
    let state = runtime
        .load_state(store, &publication, host.now_ms())
        .await?;
    // Stale paid catalogs return immediately; cold paid catalogs and Claude retain source request ownership.
    for provider in [
        CatalogProvider::Openlux,
        CatalogProvider::Surplus,
        CatalogProvider::ClaudeCode,
    ] {
        if state.input.enabled(provider.id())
            && (provider == CatalogProvider::ClaudeCode
                || runtime.cached_provider(&publication, provider).is_none())
        {
            runtime
                .refresh_provider(store, host, provider, false)
                .await?;
        }
    }
    let generation = match catalog_store::get_auth_generation(store, &host.unique_id()).await {
        Ok(generation) => generation,
        Err(_) => {
            return fallback(
                runtime,
                store,
                host,
                "Codex model catalog cache is unavailable",
            )
            .await;
        }
    };
    let now = host.now_ms();
    let cached = state::load_exact_catalog(store, &version, &generation, now).await?;
    if let Some(cached) = &cached
        && cached.metadata.fresh(now)
    {
        return response(runtime, store, host, cached, conditional, CacheState::Hit).await;
    }
    let owner = host.unique_id();
    if !catalog_store::acquire_refresh_lease(store, &version, &owner, now).await? {
        if let Some(cached) = cached {
            return response(
                runtime,
                store,
                host,
                &cached,
                conditional,
                CacheState::Stale,
            )
            .await;
        }
        let deadline = now.saturating_add(catalog_cache::COLD_WAIT_MS);
        for _ in 0..51 {
            if let Some(catalog) = current(store, host, &version).await? {
                return response(
                    runtime,
                    store,
                    host,
                    &catalog,
                    conditional,
                    CacheState::Wait,
                )
                .await;
            }
            if host.now_ms() >= deadline {
                break;
            }
            host.wait(100).await?;
        }
        return fallback(
            runtime,
            store,
            host,
            "Codex model catalog refresh is already in progress",
        )
        .await;
    }
    let lease = Lease {
        version: &version,
        owner: &owner,
        generation: &generation,
    };
    let result = refresh(
        runtime,
        store,
        host,
        &lease,
        cached.as_ref(),
        conditional,
        now,
    )
    .await;
    // A failed release never deletes a successor's lease; publication and response are already settled.
    let released = catalog_store::release_refresh_lease(store, &version, &owner).await;
    if let Err(error) = released
        && result.is_err()
    {
        return Err(error);
    }
    result
}
async fn refresh<S: QueryStore, H: CatalogHost>(
    runtime: &CatalogRuntime,
    store: &S,
    host: &H,
    lease: &Lease<'_>,
    cached: Option<&LoadedCatalog>,
    conditional: Option<&str>,
    started: i64,
) -> Result<CatalogResponse, GatewayError> {
    let publication = host.publication().await?;
    if !state::checks_current(store, &publication.source_checks).await? {
        return recover(runtime, store, host, lease, cached, conditional, true).await;
    }
    let etag = cached
        .filter(|c| c.source_body.is_some())
        .and_then(|c| c.metadata.etag.clone());
    let fetched = match with_lease(
        store,
        host,
        lease,
        fetch_codex(host, &publication, lease.version, etag),
    )
    .await
    {
        Ok(fetched) => fetched,
        Err(error) => {
            if degraded(&error) {
                let _ = host
                    .observe(CatalogObservation::ProviderDegradation {
                        client_version: lease.version.into(),
                    })
                    .await;
            }
            if error.status == 499 {
                return Err(error);
            }
            return recover(runtime, store, host, lease, cached, conditional, false).await;
        }
    };
    if fetched.degraded {
        let _ = host
            .observe(CatalogObservation::ProviderDegradation {
                client_version: lease.version.into(),
            })
            .await;
    }
    if !state::generation_current(store, lease.generation).await?
        || !state::checks_current(store, &fetched.publication.source_checks).await?
    {
        return recover(runtime, store, host, lease, None, conditional, true).await;
    }
    let context = state::PublicationContext {
        version: lease.version,
        generation: lease.generation,
        publication: &fetched.publication,
        revision: &host.unique_id(),
        now: host.now_ms(),
    };
    state::publish_account_models(store, &fetched.evidence, &context).await?;
    let revalidated = fetched.response.status == 304 && cached.is_some();
    let body = if revalidated {
        let Some(body) = cached.and_then(|c| c.source_body.as_ref()) else {
            return recover(runtime, store, host, lease, cached, conditional, false).await;
        };
        body.clone()
    } else {
        if !(200..300).contains(&fetched.response.status)
            || !fetched.response.is_json()
            || catalog_cache::parse_catalog(&fetched.response.body).is_none()
        {
            return recover(runtime, store, host, lease, cached, conditional, false).await;
        }
        fetched.response.body.clone()
    };
    let state = runtime
        .load_state(store, &fetched.publication, host.now_ms())
        .await?;
    let revision = host.unique_id();
    let (etag, content_type) = if revalidated {
        cached
            .map(|c| {
                (
                    c.metadata.etag.as_deref(),
                    Some(c.metadata.content_type.as_str()),
                )
            })
            .unwrap_or((None, None))
    } else {
        (
            fetched.response.etag.as_deref(),
            fetched.response.content_type.as_deref(),
        )
    };
    let prepared = catalog_cache::prepare_catalog(
        lease.version,
        lease.generation,
        &revision,
        &body,
        etag,
        content_type,
        started,
        &state.input.enrichment,
    )?;
    if !state::publish_fenced(
        store,
        &prepared,
        lease.owner,
        &fetched.publication.source_checks,
        host,
    )
    .await?
    {
        return recover(runtime, store, host, lease, None, conditional, true).await;
    }
    if !revalidated {
        let context = state::PublicationContext {
            version: lease.version,
            generation: lease.generation,
            publication: &fetched.publication,
            revision: &revision,
            now: started,
        };
        // The optional full snapshot cannot turn a successfully cached exact-version answer into a guessed schema.
        if let Err(error) = state::publish_snapshot(
            store,
            &SourceJson::parse(&body).map_err(|_| unavailable("Catalog parsing failed"))?,
            &context,
        )
        .await
        {
            let _ = host
                .observe(CatalogObservation::MaintenanceFailure {
                    operation: CatalogMaintenance::SnapshotPublication,
                    code: error.envelope.error.code,
                })
                .await;
        }
    }
    if let Err(error) =
        catalog_store::prune_stored_catalog_versions(store, lease.version, host.now_ms()).await
    {
        let _ = host
            .observe(CatalogObservation::MaintenanceFailure {
                operation: CatalogMaintenance::VersionPruning,
                code: error.envelope.error.code,
            })
            .await;
    }
    if !state::generation_current(store, lease.generation).await? {
        return recover(runtime, store, host, lease, None, conditional, true).await;
    }
    let catalog = state::load_exact_catalog(store, lease.version, lease.generation, host.now_ms())
        .await?
        .ok_or_else(|| unavailable("Codex model catalog could not be read after caching"))?;
    response(
        runtime,
        store,
        host,
        &catalog,
        conditional,
        if revalidated {
            CacheState::Revalidated
        } else {
            CacheState::Miss
        },
    )
    .await
}

#[cfg(test)]
mod source_evidence_tests {
    use super::*;
    #[test]
    fn single_account_evidence_retains_trimmed_units_and_distinguishes_escape_text() {
        let document = SourceJson::parse(r#"{"models":[{"slug":" \ud800 "},{"slug":"\ud800"},{"slug":"\\ud800"},{"id":"\udc00"},{"slug":" "}]}"#).unwrap();
        let result = evidence("source-account", &document);
        assert_eq!(result[0].0, "source-account");
        assert_eq!(result[0].1.len(), 3);
        assert_eq!(result[0].1[0].as_js_string().as_units(), &[0xd800]);
        assert!(result[0].1[1].matches_scalar(r"\ud800"));
        assert_eq!(result[0].1[2].as_js_string().as_units(), &[0xdc00]);
    }
}
