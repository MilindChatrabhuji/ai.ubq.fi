//! Fixed catalog reads bound to credential-owner publications and source revisions.
use std::{collections::BTreeMap, rc::Rc};

use gateway_auth::provider_credentials::{codex_source_pool_key, read_codex_source_pool};
use gateway_catalog_runtime::{
    CatalogFetch, CatalogFetchResponse, CatalogHost, CatalogProvider, CodexAccount,
    CredentialPublication, ProviderBinding,
};
use gateway_core::{
    GatewayError,
    state::{AuthorityStore, RevisionCheck},
};
use worker::{Env, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Url};

use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformHost, provider_secret, response_bytes, setting},
    storage::now_ms,
    transport::{
        outbound::{PinnedDestination, send_http},
        random,
    },
};

#[derive(Clone)]
pub struct Host {
    pub store: RemoteAuthorityStore,
    pub env: Env,
    pub platform: PlatformHost,
    pub context: Rc<worker::Context>,
}

fn provider(id: &str) -> Option<CatalogProvider> {
    Some(match id {
        "deepseek" => CatalogProvider::Deepseek,
        "cerebras" => CatalogProvider::Cerebras,
        "lithos" => CatalogProvider::Lithos,
        "openrouter" => CatalogProvider::Openrouter,
        "surplus" => CatalogProvider::Surplus,
        "openlux" => CatalogProvider::Openlux,
        _ => return None,
    })
}

pub fn secrets(env: &Env) -> BTreeMap<String, String> {
    crate::catalog::DIRECT_PROVIDERS
        .iter()
        .filter_map(|(provider, name)| {
            if *provider == "openlux" {
                provider_secret(env, "OPENLUX_API_KEY")
                    .or_else(|| provider_secret(env, "METERED_API_KEY"))
            } else {
                provider_secret(env, name)
            }
            .map(|secret| ((*provider).to_owned(), secret))
        })
        .collect()
}

fn binding(provider: &str, secret: &str) -> ProviderBinding {
    if let Some(provider) = match provider {
        "surplus" => Some(gateway_core::provider::PaidProvider::Surplus),
        "openlux" => Some(gateway_core::provider::PaidProvider::Metered),
        _ => None,
    } {
        return ProviderBinding {
            identity: gateway_publication::control_publication::configured_paid_binding(
                provider,
                &gateway_auth::crypto::Secret::new(secret.to_owned()),
            ),
        };
    }
    // This private memo identity preserves source cache invalidation when a
    // configured key changes. It is never a Codex routing/credential fingerprint.
    ProviderBinding {
        identity: gateway_auth::crypto::sha256_hex(format!("{provider}\0{secret}").as_bytes()),
    }
}

impl gateway_catalog_runtime::admin::AdminCatalogHost for Host {
    fn warm_openrouter(&self) {
        let service = crate::catalog::service();
        let mut host = self.clone();
        self.context.wait_until(async move {
            let cancellation = match crate::transport::outbound::Cancellation::background() {
                Ok(cancellation) => cancellation,
                Err(error) => {
                    worker::console_error!(
                        "OpenRouter catalog warm remains unavailable: {}",
                        error.envelope.error.message
                    );
                    return;
                }
            };
            // The source warm has its own fixed discovery deadline and does
            // not inherit the downstream caller's disconnect signal.
            host.platform.cancellation = Rc::new(cancellation);
            if let Err(error) = service
                .refresh_provider(&host.store, &host, CatalogProvider::Openrouter, false)
                .await
            {
                worker::console_error!(
                    "OpenRouter catalog warm remains unavailable: {}",
                    error.envelope.error.message
                );
            }
        });
    }
}

impl CatalogHost for Host {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        crate::source_collator::shared()
    }
    fn now_ms(&self) -> i64 {
        now_ms().unwrap_or(i64::MAX)
    }
    fn unique_id(&self) -> String {
        // Clock and platform RNG are validated by the enclosing public request.
        random::opaque_token().expect("A catalog lease requires actual platform randomness")
    }
    async fn wait(&self, milliseconds: u32) -> Result<(), GatewayError> {
        if self.platform.cancellation.signal().aborted() {
            return Err(unavailable("Catalog request was cancelled."));
        }
        worker::Delay::from(std::time::Duration::from_millis(u64::from(milliseconds))).await;
        if self.platform.cancellation.signal().aborted() {
            return Err(unavailable("Catalog request was cancelled."));
        }
        Ok(())
    }
    async fn publication(&self) -> Result<CredentialPublication, GatewayError> {
        let snapshot = read_codex_source_pool(&self.store, now_ms()?).await?;
        let normalized = self.store.read(&gateway_authority::keys::pool()).await?;
        let mut publication = CredentialPublication {
            source_checks: vec![
                RevisionCheck {
                    key: codex_source_pool_key(),
                    expected_revision: snapshot.as_ref().map(|row| row.revision.clone()),
                },
                RevisionCheck {
                    key: gateway_authority::keys::pool(),
                    expected_revision: normalized.as_ref().map(|row| row.revision.clone()),
                },
            ],
            ..Default::default()
        };
        if let Some(normalized) = normalized.as_ref() {
            let pool: gateway_authority::routing::SubscriptionPool =
                serde_json::from_value(normalized.json_value()?.clone())
                    .map_err(|_| unavailable("Codex routing pool is invalid."))?;
            let source = snapshot
                .as_ref()
                .ok_or_else(|| unavailable("Codex routing pool has no source credentials."))?;
            if pool.v != 1
                || pool.pool_versionstamp.0 != source.revision
                || pool.accounts.len() != source.pool.accounts.len()
                || pool
                    .accounts
                    .iter()
                    .zip(&source.pool.accounts)
                    .any(|(projection, account)| {
                        let identity = account.identity();
                        projection.account_id_hash != identity.routing_account_hash
                            || projection.admin_account_hash != identity.administrative_account_hash
                            || projection.credential_version != identity.credential_version
                    })
            {
                return Err(unavailable(
                    "Codex catalog publication does not match its current routing pool.",
                ));
            }
        }
        if let Some(source) = snapshot {
            publication.codex_accounts = source
                .pool
                .accounts
                .into_iter()
                .map(|account| CodexAccount {
                    credential_fingerprint: account.identity().credential_version.0,
                    account_id: account.account_id,
                })
                .collect();
        }
        for (name, secret) in secrets(&self.env) {
            if let Some(provider) = provider(&name) {
                publication
                    .providers
                    .insert(provider, binding(&name, &secret));
            }
        }
        if let Some(claude) = crate::claude_host::publication(&self.store, &self.platform).await? {
            publication
                .providers
                .insert(CatalogProvider::ClaudeCode, claude.binding);
            publication.source_checks.extend(claude.checks);
        }
        publication.validate()?;
        Ok(publication)
    }
    async fn fetch(&self, request: CatalogFetch) -> Result<CatalogFetchResponse, GatewayError> {
        if matches!(
            &request,
            CatalogFetch::Provider {
                provider: CatalogProvider::ClaudeCode,
                ..
            }
        ) {
            return crate::claude_host::fetch_catalog(&self.store, &self.platform, request).await;
        }
        let timeout = request.remaining_timeout_ms(now_ms()?)?;
        let body_limit = request.max_body_bytes();
        let mut headers = BTreeMap::from([("Accept".into(), "application/json".into())]);
        let (url, manual_redirects) = match request {
            CatalogFetch::AnonymousSurplus => (
                "https://api.surplusintelligence.ai/v1/models".to_owned(),
                true,
            ),
            CatalogFetch::Codex {
                account,
                client_version,
                if_none_match,
            } => {
                let source = read_codex_source_pool(&self.store, now_ms()?)
                    .await?
                    .ok_or_else(|| unavailable("Codex source credentials are unavailable."))?;
                let current = source
                    .pool
                    .accounts
                    .into_iter()
                    .find(|row| {
                        row.account_id == account.account_id
                            && row.identity().credential_version.0 == account.credential_fingerprint
                    })
                    .ok_or_else(|| unavailable("Codex credential publication changed."))?;
                headers.insert(
                    "Authorization".into(),
                    format!("Bearer {}", current.access_token.expose()),
                );
                headers.insert("ChatGPT-Account-ID".into(), current.account_id);
                headers.insert("originator".into(), "codex_cli_rs".into());
                headers.insert(
                    "user-agent".into(),
                    format!("codex_cli_rs/{client_version} (ai.ubq.fi)"),
                );
                if let Some(etag) = if_none_match {
                    headers.insert("If-None-Match".into(), etag);
                }
                let base = setting(&self.env, "CODEX_BASE_URL")
                    .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
                let base = base.trim().trim_end_matches('/');
                let mut target = Url::parse(&format!("{base}/models"))
                    .map_err(|_| unavailable("Codex model URL is invalid."))?;
                if base.ends_with("/codex") {
                    target
                        .query_pairs_mut()
                        .append_pair("client_version", &client_version);
                }
                (target.to_string(), true)
            }
            CatalogFetch::Provider {
                provider,
                binding: expected,
                after_id,
                ..
            } => {
                if provider == CatalogProvider::ClaudeCode {
                    return Err(unavailable(
                        "The source Claude publication adapter is not yet integrated.",
                    ));
                }
                if after_id.is_some() {
                    return Err(unavailable(
                        "Only Claude catalog pagination accepts a cursor.",
                    ));
                }
                let publication = self.publication().await?;
                if publication.binding(provider).as_ref() != Some(&expected) {
                    return Err(unavailable("Provider catalog credentials changed."));
                }
                if matches!(provider, CatalogProvider::Lithos | CatalogProvider::Openlux) {
                    let secret = secrets(&self.env).remove(provider.id()).ok_or_else(|| {
                        unavailable("Provider discovery credentials are unavailable.")
                    })?;
                    headers.insert("Authorization".into(), format!("Bearer {secret}"));
                }
                (
                    provider
                        .models_url()
                        .ok_or_else(|| unavailable("This provider has no discovery endpoint."))?
                        .to_owned(),
                    provider == CatalogProvider::Surplus,
                )
            }
        };
        let cancellation = self.platform.cancellation.child()?;
        let _deadline = timeout
            .map(|milliseconds| cancellation.set_timeout_ms(milliseconds as i32))
            .transpose()?;
        let target = PinnedDestination::new(&url)?;
        let mut response = if manual_redirects {
            send_http(
                &target,
                Method::Get,
                &headers,
                &[],
                &cancellation,
                || async { Ok(()) },
            )
            .await
            .map_err(|failure| failure.error)?
        } else {
            let wire_headers = Headers::new();
            for (name, value) in &headers {
                wire_headers
                    .set(name, value)
                    .map_err(|_| unavailable("Invalid catalog request headers."))?;
            }
            let mut init = RequestInit::new();
            init.with_headers(wire_headers)
                .with_redirect(RequestRedirect::Follow);
            let request = Request::new_with_init(&url, &init)
                .map_err(|_| unavailable("Invalid catalog request URL."))?;
            Fetch::Request(request)
                .send_with_signal(&cancellation.signal())
                .await
                .map_err(|_| unavailable("Provider catalog transport failed."))?
        };
        let status = response.status_code();
        let content_type = response
            .headers()
            .get("content-type")
            .map_err(|_| unavailable("Invalid catalog response headers."))?;
        let etag = response
            .headers()
            .get("etag")
            .map_err(|_| unavailable("Invalid catalog response headers."))?;
        let bytes = match body_limit {
            Some(limit) => response_bytes(&mut response, limit).await?,
            None => response
                .bytes()
                .await
                .map_err(|_| unavailable("Catalog response read failed."))?,
        };
        let mut observed =
            CatalogFetchResponse::json(status, String::from_utf8_lossy(&bytes).into_owned());
        observed.content_type = content_type;
        observed.etag = etag;
        // Bounded cloned eligibility observation is separate from the main body.
        observed.single_account_observation_complete = false;
        Ok(observed)
    }
}

fn unavailable(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("codex_catalog_unavailable"))
}
