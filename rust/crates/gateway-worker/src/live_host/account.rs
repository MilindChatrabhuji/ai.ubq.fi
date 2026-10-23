//! Nonserializable current credential handle. The real host alone constructs it after selection
//! or a mapped-account owner operation; clients cannot supply these source and routing fences.
use gateway_auth::provider_credentials::{CodexSourceAccount, read_codex_source_pool};
use gateway_authority::{Authority, routing::LiveAccountSelection};
use gateway_core::GatewayError;
use gateway_live_runtime::types::LiveAccount;

use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformTokens},
    storage::now_ms,
};

pub struct CurrentLiveAccount {
    pub(super) source: CodexSourceAccount,
    pub(super) source_revision: String,
    pub(super) selected: Option<LiveAccountSelection>,
    pub(super) store: RemoteAuthorityStore,
}

impl LiveAccount for CurrentLiveAccount {
    fn account_id(&self) -> &str {
        &self.source.account_id
    }
}

impl CurrentLiveAccount {
    /// Current-source equality is checked again immediately before fixed HTTP/native dispatch.
    /// A newer same-account credential is adopted by the OWNER operation before this handle is
    /// constructed, never by silently sending a token from an older generation.
    pub(super) async fn ensure_current(&self) -> Result<(), GatewayError> {
        let now = now_ms()?;
        let current = read_codex_source_pool(&self.store, now)
            .await?
            .ok_or_else(missing)?;
        if current.revision != self.source_revision
            || !current
                .pool
                .accounts
                .iter()
                .any(|account| account == &self.source)
        {
            return Err(missing());
        }
        if let Some(selected) = &self.selected {
            Authority::with_clock(self.store.clone(), PlatformTokens, PlatformClock)
                .ensure_live_account_current(selected, now)
                .await?;
        }
        Ok(())
    }
}

pub(super) fn missing() -> GatewayError {
    GatewayError::unavailable(
        "Codex current account or credential ownership changed; retry the request.",
        "codex_auth_missing",
    )
}
