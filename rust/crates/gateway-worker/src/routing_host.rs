//! Routing credentials use the owner-derived current source and routing fences.
use gateway_auth::{
    AuthPrincipal,
    crypto::Secret,
    provider_credentials::{codex_source_pool_key, read_codex_source_pool},
};
use gateway_authority::{
    paid::{PaidReservation, PaidUsage},
    routing::CohortProof,
};
use gateway_core::{GatewayError, provider::UpstreamProvider};
use gateway_providers::{AuthMaterial, PrepareOptions};
use gateway_routing_runtime::{
    AttemptFailure, ClaudeSelection, CodexRecovery, CredentialFence, CredentialRequest,
    PublishedCredential, RefreshOutcome, RoutingHost, direct_credential,
};
use serde_json::Value;
use worker::Env;

use crate::{authority::RemoteAuthorityStore, host::PlatformHost, storage::now_ms};

#[derive(Clone)]
pub struct Host {
    pub store: RemoteAuthorityStore,
    pub env: Env,
    pub platform: PlatformHost,
}

fn provider_name(provider: UpstreamProvider) -> Option<&'static str> {
    match provider {
        UpstreamProvider::Deepseek => Some("deepseek"),
        UpstreamProvider::Lithos => Some("lithos"),
        UpstreamProvider::Cerebras => Some("cerebras"),
        UpstreamProvider::Openrouter => Some("openrouter"),
        _ => None,
    }
}

impl RoutingHost for Host {
    fn cancelled(&self) -> bool {
        self.platform.cancellation.signal().aborted()
    }
    fn cancellation_error(&self) -> GatewayError {
        gateway_admission::cancellation_error()
    }
    async fn wait(&self, milliseconds: i64) -> Result<(), GatewayError> {
        let child = self.platform.cancellation.child()?;
        let wait =
            u64::try_from(milliseconds).map_err(|_| unavailable("Routing wait is invalid."))?;
        let mut delay = std::pin::pin!(worker::Delay::from(std::time::Duration::from_millis(wait)));
        std::future::poll_fn(|context| {
            child.register_waker(context.waker());
            if child.signal().aborted() {
                std::task::Poll::Ready(())
            } else {
                std::future::Future::poll(delay.as_mut(), context)
            }
        })
        .await;
        if self.cancelled() {
            return Err(self.cancellation_error());
        }
        Ok(())
    }
    async fn credential(
        &self,
        input: CredentialRequest,
    ) -> Result<PublishedCredential, GatewayError> {
        if let Some(provider) = provider_name(input.provider) {
            let secret = crate::catalog_host::secrets(&self.env)
                .remove(provider)
                .ok_or_else(|| {
                    GatewayError::unavailable(
                        "The requested provider is not configured.",
                        &format!("{provider}_api_key_missing"),
                    )
                })?;
            return Ok(direct_credential(input.provider, &Secret::new(secret)));
        }
        if input.provider == UpstreamProvider::ChatgptCodex {
            let admission = input.codex.ok_or_else(|| {
                unavailable("A Codex credential requires its actual account admission.")
            })?;
            let snapshot = read_codex_source_pool(&self.store, now_ms()?)
                .await?
                .ok_or_else(|| unavailable("Current source Codex credentials are unavailable."))?;
            if admission.binding.pool_versionstamp.0 != snapshot.revision {
                return Err(unavailable("Codex admission refers to an old source pool."));
            }
            let current = snapshot
                .pool
                .accounts
                .into_iter()
                .find(|account| {
                    let identity = account.identity();
                    identity.routing_account_hash == admission.binding.account_id_hash
                        && identity.credential_version == admission.binding.credential_version
                })
                .ok_or_else(|| unavailable("The admitted Codex credential was replaced."))?;
            let native_generation = current.identity().native_generation_hash;
            return Ok(PublishedCredential {
                material: AuthMaterial {
                    secret: current.access_token.expose().to_owned(),
                    account_id: Some(current.account_id),
                    ..Default::default()
                },
                fence: CredentialFence::Codex {
                    admission,
                    source_key: codex_source_pool_key(),
                    source_revision: snapshot.revision,
                    native_generation,
                },
                options: PrepareOptions::default(),
            });
        }
        Err(unavailable(
            "The owner-fenced paid credential capability is not yet configured.",
        ))
    }
    async fn ensure_credential_current(
        &self,
        fence: &CredentialFence,
        _principal: &AuthPrincipal,
        _model: &str,
    ) -> Result<(), GatewayError> {
        match fence {
            CredentialFence::Direct { provider } if provider_name(*provider).is_some() => {
                self.credential(CredentialRequest {
                    provider: *provider,
                    model: String::new(),
                    codex: None,
                })
                .await?;
                Ok(())
            }
            CredentialFence::Codex {
                admission,
                source_key,
                source_revision,
                native_generation,
            } => {
                if *source_key != codex_source_pool_key() {
                    return Err(unavailable("Codex source credential key is invalid."));
                }
                let source = read_codex_source_pool(&self.store, now_ms()?)
                    .await?
                    .ok_or_else(|| unavailable("Codex source credentials were removed."))?;
                if source.revision != *source_revision
                    || source.revision != admission.binding.pool_versionstamp.0
                    || !source.pool.accounts.iter().any(|account| {
                        let identity = account.identity();
                        identity.routing_account_hash == admission.binding.account_id_hash
                            && identity.credential_version == admission.binding.credential_version
                            && identity.native_generation_hash == *native_generation
                    })
                {
                    return Err(unavailable(
                        "Codex source credentials changed before dispatch.",
                    ));
                }
                Ok(())
            }
            _ => Err(unavailable(
                "The selected credential owner is not configured.",
            )),
        }
    }
    async fn refresh_codex(
        &self,
        _fence: &CredentialFence,
    ) -> Result<RefreshOutcome, GatewayError> {
        Err(unavailable(
            "The current native credential owner cannot refresh through this Worker.",
        ))
    }
    async fn select_claude(
        &self,
        _principal: &AuthPrincipal,
        _model: &str,
        _raw: &Value,
    ) -> Result<ClaudeSelection, GatewayError> {
        Err(unavailable(
            "The source Claude account selector capability is not yet integrated.",
        ))
    }
    async fn record_claude_refusal(
        &self,
        _fence: &CredentialFence,
        _model: &str,
        _failure: &AttemptFailure,
    ) -> Result<bool, GatewayError> {
        Err(unavailable(
            "The source Claude refusal observer is not yet integrated.",
        ))
    }
    async fn recover_codex(
        &self,
        _proof: &CohortProof,
        _model: &str,
    ) -> Result<CodexRecovery, GatewayError> {
        Err(unavailable(
            "The native reset/redemption capability is not yet configured.",
        ))
    }
    async fn lookup_paid(
        &self,
        _reservation: &PaidReservation,
    ) -> Result<Option<PaidUsage>, GatewayError> {
        Err(unavailable(
            "The exact paid accounting lookup capability is not yet integrated.",
        ))
    }
}

fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "provider_routing_unavailable")
}
