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
use gateway_core::{
    GatewayError,
    provider::{PaidProvider, UpstreamProvider},
    state::{AuthorityStore, RecordKey},
};
use gateway_providers::{AuthMaterial, PrepareOptions};
use gateway_routing_runtime::types::{
    ClaudeSelection, CodexRecovery, CredentialFence, CredentialRequest, PublishedCredential,
    RefreshOutcome, RoutingHost, direct_credential,
};
use worker::Env;

use crate::{authority::RemoteAuthorityStore, host::PlatformHost, storage::now_ms};

#[derive(Clone)]
pub struct Host {
    pub store: RemoteAuthorityStore,
    pub env: Env,
    pub platform: PlatformHost,
    context: std::rc::Rc<worker::Context>,
    claude: crate::claude_host::Binding,
    original: gateway_core::identity::RequestContext,
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
    type ClaudeHead = crate::claude_host::Head;
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        crate::source_collator::shared()
    }
    fn cancelled(&self) -> bool {
        self.platform.cancellation.signal().aborted()
    }
    fn cancellation_error(&self) -> GatewayError {
        if self.platform.cancellation.client_aborted() {
            gateway_admission::cancellation_error()
        } else {
            GatewayError::new(
                504,
                "The gateway request deadline expired.",
                Some("gateway_timeout"),
            )
            .with_type("server_error")
        }
    }
    async fn wait(&self, milliseconds: i64) -> gateway_routing_runtime::types::WaitOutcome {
        let started = crate::admission::monotonic()
            .expect("Routing requires the validated platform monotonic clock");
        let result = self.wait_result(milliseconds).await;
        let ended = crate::admission::monotonic()
            .expect("Routing requires the validated platform monotonic clock");
        let elapsed_ms = (ended.saturating_sub(started).as_secs_f64() * 1000.0)
            .round()
            .min(i64::MAX as f64) as i64;
        gateway_routing_runtime::types::WaitOutcome { elapsed_ms, result }
    }
    async fn credential(
        &self,
        input: CredentialRequest,
    ) -> Result<PublishedCredential, GatewayError> {
        prepare_credential_catalog(
            input.provider,
            &self.store,
            &crate::catalog_host::Host {
                store: self.store.clone(),
                env: self.env.clone(),
                platform: self.platform.clone(),
                context: self.context.clone(),
            },
        )
        .await?;
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
        if matches!(
            input.provider,
            UpstreamProvider::Surplus | UpstreamProvider::Metered
        ) {
            return self.paid_credential(input.provider).await;
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
            return Ok(PublishedCredential::Scalar {
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
                options: Box::new(PrepareOptions::default()),
            });
        }
        Err(unavailable(
            "The owner-fenced paid credential capability is not yet configured.",
        ))
    }
    async fn ensure_credential_current(
        &self,
        fence: &CredentialFence,
        principal: &AuthPrincipal,
        model: &gateway_core::model::ModelId,
    ) -> Result<(), GatewayError> {
        match fence {
            CredentialFence::Claude { .. } => {
                self.claude.ensure_current(fence, principal, model).await
            }
            CredentialFence::Direct { provider } if provider_name(*provider).is_some() => {
                self.credential(CredentialRequest {
                    provider: *provider,
                    model: model.clone(),
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
            CredentialFence::Paid {
                provider,
                owner_id,
                owner_epoch,
                configuration_generation,
                credential_binding,
            } => {
                let current = self.paid_credential(*provider).await?;
                match current.into_fence() {
                    CredentialFence::Paid {
                        owner_id: actual_owner,
                        owner_epoch: actual_epoch,
                        configuration_generation: actual_generation,
                        credential_binding: actual_binding,
                        ..
                    } if actual_owner == *owner_id
                        && actual_epoch == *owner_epoch
                        && actual_generation == *configuration_generation
                        && actual_binding == *credential_binding =>
                    {
                        Ok(())
                    }
                    _ => Err(unavailable(
                        "Paid credential publication changed before dispatch.",
                    )),
                }
            }
            _ => Err(unavailable(
                "The selected credential owner is not configured.",
            )),
        }
    }
    async fn refresh_codex(&self, fence: &CredentialFence) -> Result<RefreshOutcome, GatewayError> {
        self.platform
            .native
            .refresh_routing(fence, &self.platform, &self.original)
            .await
    }
    async fn select_claude(
        &self,
        principal: &AuthPrincipal,
        model: &gateway_core::model::ModelId,
        raw: &gateway_core::source_json::SourceJson,
        effective_effort: Option<&gateway_core::js_string::JsString16>,
    ) -> Result<ClaudeSelection, GatewayError> {
        self.claude
            .select(principal, model, raw, effective_effort)
            .await
    }
    async fn observe_claude_response(
        &self,
        fence: &CredentialFence,
        model: &gateway_core::model::ModelId,
        response: gateway_routing_runtime::types::ResponseHead,
    ) -> Result<Self::ClaudeHead, GatewayError> {
        self.claude.observe(fence, model, response).await
    }
    async fn finish_claude_response(
        &self,
        head: Self::ClaudeHead,
        evidence: gateway_core::claude::ClaudeErrorEvidence,
    ) -> Result<gateway_routing_runtime::types::ClaudeOutcome, GatewayError> {
        self.claude.finish(head, evidence).await
    }
    async fn recover_codex(
        &self,
        proof: &CohortProof,
        model: &gateway_core::model::ModelId,
    ) -> Result<CodexRecovery, GatewayError> {
        let config = crate::host::auth_config(&self.platform.env);
        let check_original = || async {
            if self.cancelled() {
                return Err(self.cancellation_error());
            }
            crate::codex_admin_host::check_client(
                &self.store,
                &self.platform,
                &self.platform.original,
                &config,
                &self.original,
            )
            .await
        };
        let authority = gateway_authority::Authority::with_clock(
            self.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        let observations = crate::observability_host::bind(
            &self.original.request_id,
            &[],
            self.store.clone(),
            &self.platform,
            self.context.clone(),
        );
        let selection = crate::codex_capacity_recovery::observe(
            &self.store,
            &authority,
            observations.host(),
            proof,
            model,
            check_original,
        )
        .await?;
        let current_proof = match selection {
            Some(gateway_authority::routing::RouteSelection::QuotaBlocked { proof, .. }) => proof,
            Some(_) => return Ok(CodexRecovery::Reselect),
            None => proof.clone(),
        };
        crate::codex_admin_host::recover_full_pool(
            &self.store,
            &self.platform,
            &self.platform.original,
            &config,
            &self.original,
            &current_proof,
            model,
        )
        .await
    }
    async fn lookup_paid(
        &self,
        reservation: &PaidReservation,
    ) -> Result<Option<PaidUsage>, GatewayError> {
        crate::paid_lookup::lookup(&self.store, &self.env, reservation).await
    }
}

impl Host {
    pub(crate) fn physical_claude(
        &self,
        attempt: &gateway_routing_runtime::types::PreparedAttempt,
    ) -> Result<
        crate::transport::outbound::ConstructedRequest,
        gateway_routing_runtime::types::RoutingError,
    > {
        if attempt.original_request_id != self.original.request_id.0 {
            return Err(GatewayError::new(
                400,
                "Claude request belongs to another original lifetime.",
                Some("claude_code_request_invalid"),
            )
            .into());
        }
        let gateway_routing_runtime::types::PreparedWireRequest::Claude(body) = &attempt.request
        else {
            return Err(GatewayError::new(
                400,
                "Claude request has another prepared kind.",
                Some("claude_code_request_invalid"),
            )
            .into());
        };
        self.claude
            .physical_request(&attempt.credential, &body.decode().model, body)
    }

    pub fn new(
        store: RemoteAuthorityStore,
        platform: PlatformHost,
        context: std::rc::Rc<worker::Context>,
        original: gateway_core::identity::RequestContext,
    ) -> Self {
        let claude =
            crate::claude_host::Binding::new(store.clone(), platform.clone(), context.clone());
        Self {
            store,
            env: platform.env.clone(),
            platform,
            context,
            claude,
            original,
        }
    }
    async fn wait_result(&self, milliseconds: i64) -> Result<(), GatewayError> {
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

    async fn paid_credential(
        &self,
        provider: UpstreamProvider,
    ) -> Result<PublishedCredential, GatewayError> {
        let paid = match provider {
            UpstreamProvider::Surplus => PaidProvider::Surplus,
            UpstreamProvider::Metered => PaidProvider::Metered,
            _ => {
                return Err(unavailable(
                    "The requested credential is not a paid provider.",
                ));
            }
        };
        let secret = if paid == PaidProvider::Metered {
            crate::host::provider_secret(&self.env, "METERED_API_KEY")
                .or_else(|| crate::host::provider_secret(&self.env, "OPENLUX_API_KEY"))
        } else {
            crate::host::provider_secret(&self.env, "SURPLUS_API_KEY")
        }
        .ok_or_else(|| unavailable("The paid provider credential is not configured."))?;
        let owner = self
            .store
            .read(&gateway_authority::keys::paid_control_owner())
            .await?
            .ok_or_else(|| unavailable("The paid control owner is not configured."))?;
        let configuration = self
            .store
            .read(&gateway_authority::keys::paid_control_config())
            .await?
            .ok_or_else(|| unavailable("The paid control configuration is not published."))?;
        let owner: gateway_authority::paid_control::PaidControlOwner =
            serde_json::from_value(owner.json_value()?.clone())
                .map_err(|_| unavailable("The paid control owner is invalid."))?;
        let configuration: gateway_authority::paid_control::PaidControlConfig =
            serde_json::from_value(configuration.json_value()?.clone())
                .map_err(|_| unavailable("The paid control configuration is invalid."))?;
        let binding = gateway_publication::control_publication::configured_paid_binding(
            paid,
            &Secret::new(secret.clone()),
        );
        let expected = if paid == PaidProvider::Surplus {
            configuration.surplus_binding.as_ref()
        } else {
            configuration.openlux_binding.as_ref()
        };
        if owner.v != 1
            || configuration.v != gateway_authority::paid_control::PAID_CONTROL_CONFIG_VERSION
            || owner.owner_id != configuration.owner_id
            || owner.owner_epoch != configuration.owner_epoch
            || expected != Some(&binding)
        {
            return Err(unavailable(
                "The configured paid credential does not match its current owner publication.",
            ));
        }
        for check in &configuration.source_checks {
            if self
                .store
                .read(&RecordKey(check.key.clone()))
                .await?
                .as_ref()
                .map(|record| &record.revision)
                != check.expected_revision.as_ref()
            {
                return Err(unavailable(
                    "The paid control configuration source changed.",
                ));
            }
        }
        Ok(PublishedCredential::Scalar {
            material: AuthMaterial {
                secret,
                ..Default::default()
            },
            fence: CredentialFence::Paid {
                provider,
                owner_id: owner.owner_id,
                owner_epoch: owner.owner_epoch,
                configuration_generation: configuration.generation,
                credential_binding: binding,
            },
            options: Box::new(PrepareOptions::default()),
        })
    }
}

fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "provider_routing_unavailable")
}

// Source paid-fallback/health.ts prepares real catalogs at the selected paid hop.
// Never call this from paid_credential: receipt/currentness rechecks are read-only.
async fn prepare_credential_catalog<
    S: gateway_core::query::QueryStore,
    H: gateway_catalog_runtime::CatalogHost,
>(
    provider: UpstreamProvider,
    store: &S,
    host: &H,
) -> Result<(), GatewayError> {
    if matches!(
        provider,
        UpstreamProvider::Surplus | UpstreamProvider::Metered
    ) {
        crate::catalog::service()
            .publish_paid_routing(store, host)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "routing_paid_catalog_tests.rs"]
mod paid_catalog_tests;
