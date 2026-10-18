use super::platform::{self, Host};
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformHost, response_bytes},
    transport::outbound::{PinnedDestination, send_http},
};
use gateway_admin_runtime::{
    claude::{self, AccountBinding},
    claude_generation::StateSnapshot,
};
use gateway_auth::AuthHost;
use gateway_catalog_runtime::{
    CatalogFetch, CatalogFetchResponse, CatalogHost, CatalogProvider, CredentialPublication,
    ProviderBinding,
};
use gateway_claude_runtime::ClaudePoolHost;
use gateway_core::{GatewayError, state::RevisionCheck};
use gateway_schema::catalog::ProviderCatalog;
use std::collections::BTreeMap;

pub struct Publication {
    pub binding: ProviderBinding,
    pub checks: Vec<RevisionCheck>,
    account: AccountBinding,
    generation: StateSnapshot,
}

/// Current active source publication for ordinary catalog discovery; never a bearer token DTO.
pub async fn publication(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
) -> Result<Option<Publication>, GatewayError> {
    let generation = super::generation();
    let snapshot = generation.snapshot();
    let seed = platform::bootstrap_for_source(store, platform).await?;
    let roster = claude::load_roster(store, platform, &seed).await?;
    let Some(account) = claude::active_binding(&roster.roster).cloned() else {
        return Ok(None);
    };
    let check = claude::current_binding(store, &account, platform.now_ms())
        .await?
        .ok_or_else(|| super::invalid("Claude catalog source changed."))?;
    let identity = generation
        .catalog_identity(
            &snapshot,
            Some(&account),
            &account.credential,
            account
                .workspace
                .as_ref()
                .map(|workspace| workspace.id.as_str()),
        )
        .ok_or_else(|| super::invalid("Claude catalog generation changed."))?;
    Ok(Some(Publication {
        binding: ProviderBinding { identity },
        checks: vec![check],
        account,
        generation: snapshot,
    }))
}

pub async fn fetch_catalog(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    request: CatalogFetch,
) -> Result<CatalogFetchResponse, GatewayError> {
    let current = publication(store, platform)
        .await?
        .ok_or_else(|| super::invalid("Claude catalog credentials are unavailable."))?;
    page(
        store,
        platform,
        &current.account,
        &current.generation,
        &current.binding,
        request,
    )
    .await
}

struct AccountCatalog<'a> {
    host: &'a Host,
    account: &'a AccountBinding,
    identity: &'a ProviderBinding,
    generation: StateSnapshot,
}
impl CatalogHost for AccountCatalog<'_> {
    fn now_ms(&self) -> i64 {
        self.host.platform.now_ms()
    }
    fn unique_id(&self) -> String {
        crate::transport::random::opaque_token().expect("Validated platform randomness")
    }
    async fn wait(&self, milliseconds: u32) -> Result<(), GatewayError> {
        worker::Delay::from(std::time::Duration::from_millis(u64::from(milliseconds))).await;
        if self.host.platform.cancellation.signal().aborted() {
            return Err(cancelled());
        }
        Ok(())
    }
    async fn publication(&self) -> Result<CredentialPublication, GatewayError> {
        current(
            &self.host.store,
            &self.host.platform,
            self.account,
            &self.generation,
        )
        .await?;
        let checks = self.host.credential_checks(self.account).await?;
        Ok(CredentialPublication {
            source_checks: checks,
            providers: BTreeMap::from([(CatalogProvider::ClaudeCode, self.identity.clone())]),
            ..Default::default()
        })
    }
    async fn fetch(&self, request: CatalogFetch) -> Result<CatalogFetchResponse, GatewayError> {
        page(
            &self.host.store,
            &self.host.platform,
            self.account,
            &self.generation,
            self.identity,
            request,
        )
        .await
    }
}

pub(super) async fn for_account(
    host: &Host,
    account: &AccountBinding,
    identity: &ProviderBinding,
) -> Result<ProviderCatalog, GatewayError> {
    let generation = super::generation();
    let snapshot = generation.snapshot();
    if generation
        .catalog_identity(
            &snapshot,
            Some(account),
            &account.credential,
            account
                .workspace
                .as_ref()
                .map(|workspace| workspace.id.as_str()),
        )
        .as_deref()
        != Some(identity.identity.as_str())
    {
        return Err(super::invalid("Claude catalog binding is stale."));
    }
    let adapter = AccountCatalog {
        host,
        account,
        identity,
        generation: snapshot,
    };
    crate::catalog::service()
        .refresh_provider(&host.store, &adapter, CatalogProvider::ClaudeCode, false)
        .await?
        .ok_or_else(|| {
            GatewayError::new(
                502,
                "Claude model discovery is unavailable.",
                Some("claude_code_models_unavailable"),
            )
        })
}

async fn current(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    account: &AccountBinding,
    generation: &StateSnapshot,
) -> Result<(), GatewayError> {
    if platform.cancellation.signal().aborted() {
        return Err(cancelled());
    }
    if !generation.is_current()
        || claude::current_binding(store, account, platform.now_ms())
            .await?
            .is_none()
        || !generation.is_current()
    {
        return Err(super::invalid(
            "Claude source publication changed before metadata dispatch.",
        ));
    }
    Ok(())
}

async fn page(
    store: &RemoteAuthorityStore,
    platform: &PlatformHost,
    account: &AccountBinding,
    generation: &StateSnapshot,
    identity: &ProviderBinding,
    request: CatalogFetch,
) -> Result<CatalogFetchResponse, GatewayError> {
    let remaining = request.remaining_timeout_ms(platform.now_ms())?;
    let CatalogFetch::Provider {
        provider: CatalogProvider::ClaudeCode,
        binding,
        after_id,
        ..
    } = request
    else {
        return Err(super::invalid(
            "This fixed fetch supports only Claude model discovery.",
        ));
    };
    if &binding != identity {
        return Err(super::invalid("Claude discovery identity changed."));
    }
    let mut url = worker::Url::parse("https://api.anthropic.com/v1/models")
        .map_err(|_| super::invalid("Claude catalog URL is invalid."))?;
    url.query_pairs_mut().append_pair("limit", "100");
    if let Some(cursor) = after_id {
        url.query_pairs_mut().append_pair("after_id", &cursor);
    }
    current(store, platform, account, generation).await?;
    let cancellation = platform.cancellation.child()?;
    let _deadline = remaining
        .map(|milliseconds| cancellation.set_timeout_ms(milliseconds as i32))
        .transpose()?;
    let target = PinnedDestination::new(url.as_str())?;
    let mut response = send_http(
        &target,
        worker::Method::Get,
        &platform::headers(account, true),
        &[],
        &cancellation,
        || current(store, platform, account, generation),
    )
    .await
    .map_err(|failure| failure.error)?;
    let status = response.status_code();
    let content_type = response
        .headers()
        .get("content-type")
        .map_err(|_| super::invalid("Claude metadata headers are invalid."))?;
    let bytes = response_bytes(&mut response, 2 * 1024 * 1024).await?;
    current(store, platform, account, generation).await?;
    let mut result =
        CatalogFetchResponse::json(status, String::from_utf8_lossy(&bytes).into_owned());
    result.content_type = content_type;
    Ok(result)
}

pub(super) async fn workspace_list(
    host: &Host,
    account: &AccountBinding,
) -> Result<CatalogFetchResponse, GatewayError> {
    let snapshot = super::generation().snapshot();
    current(&host.store, &host.platform, account, &snapshot).await?;
    let target = PinnedDestination::new("https://api.anthropic.com/v1/organizations/workspaces")?;
    let mut response = send_http(
        &target,
        worker::Method::Get,
        &platform::headers(account, false),
        &[],
        &host.platform.cancellation,
        || current(&host.store, &host.platform, account, &snapshot),
    )
    .await
    .map_err(|failure| failure.error)?;
    let status = response.status_code();
    let body = response.bytes().await.map_err(|_| {
        GatewayError::new(
            502,
            "Claude workspace response could not be read.",
            Some("claude_code_upstream_unreachable"),
        )
    })?;
    current(&host.store, &host.platform, account, &snapshot).await?;
    Ok(CatalogFetchResponse::json(
        status,
        String::from_utf8_lossy(&body).into_owned(),
    ))
}

fn cancelled() -> GatewayError {
    GatewayError::new(
        499,
        "Claude metadata request was cancelled.",
        Some("client_cancelled"),
    )
}
