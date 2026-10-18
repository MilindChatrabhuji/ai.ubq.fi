//! Durable transport intent/outcome, separate from API, kernel and paid ledgers.
use std::rc::Rc;

use gateway_auth::{AuthMethod, AuthPrincipal};
use gateway_authority::{
    Authority,
    quota::{ApiReservation, KernelReservation, KernelTerminal},
};
use gateway_core::{
    GatewayError,
    identity::{ApiKeyId, PrincipalId, RequestContext, RequestId},
    lifecycle::{SemanticTerminal, TransportObservation},
    provider::UpstreamProvider,
    state::{
        AtomicTransition, AuthorityStore, CommitOutcome, RecordMutation, RevisionCheck,
        StoredRecord,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    authority::RemoteAuthorityStore,
    catalog::key,
    host::{PlatformClock, PlatformTokens},
    storage::now_ms,
    transport::random,
};

const RETENTION_MS: i64 = 7 * 86_400_000;

#[derive(Clone, Deserialize, Serialize)]
pub struct RequestLifecycle {
    pub v: u32,
    pub context: RequestContext,
    pub api: Option<ApiReservation>,
    pub kernel: Option<KernelReservation>,
    pub dispatch_intent: Option<UpstreamProvider>,
    pub transport_started: bool,
    pub upstream_status: Option<u16>,
    pub terminal_intent: Option<TransportObservation>,
    pub usage: Option<Value>,
    pub settled: bool,
}

pub struct Lifecycle {
    pub store: RemoteAuthorityStore,
    pub request_id: RequestId,
    pub api: Option<ApiReservation>,
    pub kernel: Option<KernelReservation>,
}

pub fn principal_id(principal: &AuthPrincipal) -> String {
    match &principal.method {
        AuthMethod::KvApiKey { key_id, .. } => format!("api-key:{key_id}"),
        AuthMethod::GithubToken { owner, repo, .. } => format!(
            "github-repo:{}/{}",
            owner.to_lowercase(),
            repo.to_lowercase()
        ),
        AuthMethod::PasskeySession { user_id, .. } => format!("passkey-user:{user_id}"),
        AuthMethod::AuthTokensAllowlist => "auth-method:auth_tokens_allowlist".into(),
        AuthMethod::AdminAllowlist => "auth-method:admin_allowlist".into(),
        AuthMethod::DenoDeployToken => "auth-method:deno_deploy_token".into(),
        AuthMethod::Disabled => principal
            .token
            .as_ref()
            .map(|token| {
                format!(
                    "bearer-sha256:{}",
                    gateway_auth::crypto::sha256_hex(token.expose().as_bytes())
                )
            })
            .unwrap_or_else(|| "local-auth-disabled".into()),
    }
}

impl Lifecycle {
    pub async fn admit(
        store: RemoteAuthorityStore,
        principal: &AuthPrincipal,
        request_id: RequestId,
        route: &str,
    ) -> Result<Rc<Self>, GatewayError> {
        let now = now_ms()?;
        let authority = Authority::with_clock(store.clone(), PlatformTokens, PlatformClock);
        let key_id = if let AuthMethod::KvApiKey { key_id, .. } = &principal.method {
            Some(ApiKeyId(key_id.clone()))
        } else {
            None
        };
        let api = if let Some(key_id) = &key_id {
            Some(
                authority
                    .reserve_api_key(key_id, &request_id, route, now)
                    .await?,
            )
        } else {
            None
        };
        let kernel = if let AuthMethod::GithubToken { owner, repo, .. } = &principal.method {
            Some(
                authority
                    .reserve_kernel(owner, repo, &request_id, route, now)
                    .await?,
            )
        } else {
            None
        };
        let row = RequestLifecycle {
            v: 1,
            context: RequestContext {
                request_id: request_id.clone(),
                principal: PrincipalId(principal_id(principal)),
                key_id,
                route: route.into(),
                started_at_ms: now,
            },
            api: api.clone(),
            kernel: kernel.clone(),
            dispatch_intent: None,
            transport_started: false,
            upstream_status: None,
            terminal_intent: None,
            usage: None,
            settled: false,
        };
        let instance = Rc::new(Self {
            store,
            request_id,
            api,
            kernel,
        });
        if let Err(error) = instance.create(&row).await {
            if let Some(api) = &instance.api {
                authority
                    .release_api_key(api, true, "lifecycle_admission_failed", now_ms()?)
                    .await?;
            }
            if let Some(kernel) = &instance.kernel {
                authority
                    .settle_kernel(
                        kernel,
                        KernelTerminal::Released,
                        "lifecycle_admission_failed",
                        now_ms()?,
                    )
                    .await?;
            }
            return Err(error);
        }
        Ok(instance)
    }

    fn record_key(&self) -> gateway_core::state::RecordKey {
        key(&[
            "uos_ai",
            "authority",
            "v1",
            "request_lifecycle",
            &self.request_id.0,
        ])
    }
    fn pending_key(&self) -> gateway_core::state::RecordKey {
        key(&[
            "uos_ai",
            "authority",
            "v1",
            "request_lifecycle_pending",
            &self.request_id.0,
        ])
    }

    async fn create(&self, row: &RequestLifecycle) -> Result<(), GatewayError> {
        let revision = random::opaque_token()?;
        let record_key = self.record_key();
        let pending_key = self.pending_key();
        let outcome = self
            .store
            .commit(AtomicTransition {
                checks: vec![
                    RevisionCheck {
                        key: record_key.clone(),
                        expected_revision: None,
                    },
                    RevisionCheck {
                        key: pending_key.clone(),
                        expected_revision: None,
                    },
                ],
                mutations: vec![
                    RecordMutation::Put {
                        key: record_key,
                        record: StoredRecord::json(
                            &revision,
                            serde_json::to_value(row).map_err(|_| unavailable())?,
                            None,
                        ),
                    },
                    RecordMutation::Put {
                        key: pending_key,
                        record: StoredRecord::json(
                            format!("{revision}:pending"),
                            json!({"request_id":self.request_id.0}),
                            None,
                        ),
                    },
                ],
            })
            .await?;
        if outcome != CommitOutcome::Committed {
            return Err(unavailable());
        }
        Ok(())
    }

    async fn update(&self, change: impl Fn(&mut RequestLifecycle)) -> Result<(), GatewayError> {
        for _ in 0..5 {
            let key = self.record_key();
            let old = self.store.read(&key).await?.ok_or_else(unavailable)?;
            let mut row: RequestLifecycle =
                serde_json::from_value(old.json_value()?.clone()).map_err(|_| unavailable())?;
            if row.v != 1 || row.context.request_id != self.request_id {
                return Err(unavailable());
            }
            change(&mut row);
            let revision = random::opaque_token()?;
            let mut checks = vec![RevisionCheck {
                key: key.clone(),
                expected_revision: Some(old.revision),
            }];
            let mut mutations = vec![RecordMutation::Put {
                key,
                record: StoredRecord::json(
                    revision,
                    serde_json::to_value(&row).map_err(|_| unavailable())?,
                    row.settled
                        .then(|| now_ms().map(|now| now + RETENTION_MS))
                        .transpose()?,
                ),
            }];
            if row.settled {
                let pending_key = self.pending_key();
                let old = self.store.read(&pending_key).await?;
                checks.push(RevisionCheck {
                    key: pending_key.clone(),
                    expected_revision: old.map(|row| row.revision),
                });
                mutations.push(RecordMutation::Delete { key: pending_key });
            }
            if self
                .store
                .commit(AtomicTransition { checks, mutations })
                .await?
                == CommitOutcome::Committed
            {
                return Ok(());
            }
        }
        Err(unavailable())
    }

    pub async fn dispatch_intent(&self, provider: UpstreamProvider) -> Result<(), GatewayError> {
        self.update(|row| row.dispatch_intent = Some(provider))
            .await?;
        if let Some(api) = &self.api {
            Authority::with_clock(self.store.clone(), PlatformTokens, PlatformClock)
                .dispatch_api_key(api, provider, now_ms()?)
                .await?;
        }
        Ok(())
    }

    pub async fn started(&self, status: Option<u16>) -> Result<(), GatewayError> {
        if let Some(api) = &self.api {
            Authority::with_clock(self.store.clone(), PlatformTokens, PlatformClock)
                .mark_api_transport_started(api, now_ms()?)
                .await?;
        }
        self.update(|row| {
            row.transport_started = true;
            row.upstream_status = status;
        })
        .await
    }

    pub async fn before_transport_failure(&self) -> Result<(), GatewayError> {
        if let Some(api) = &self.api {
            Authority::with_clock(self.store.clone(), PlatformTokens, PlatformClock)
                .release_api_key(api, true, "known_before_transport", now_ms()?)
                .await?;
        }
        self.finish(TransportObservation::default(), None).await
    }

    pub async fn observe_terminal(
        &self,
        observation: TransportObservation,
    ) -> Result<(), GatewayError> {
        self.update(|row| {
            if !row.settled {
                row.terminal_intent = Some(observation);
            }
        })
        .await?;
        if let Some(kernel) = &self.kernel {
            let terminal = if observation.semantic_terminal == Some(SemanticTerminal::Completed) {
                KernelTerminal::Committed
            } else {
                KernelTerminal::Released
            };
            Authority::with_clock(self.store.clone(), PlatformTokens, PlatformClock)
                .record_kernel_terminal_intent(kernel, terminal, now_ms()?)
                .await?;
        }
        Ok(())
    }

    pub async fn finish(
        &self,
        observation: TransportObservation,
        usage: Option<Value>,
    ) -> Result<(), GatewayError> {
        // Journal intent before quota mutation. An interrupted waitUntil leaves
        // this pending row and the idempotent domain reservation recoverable.
        self.update(|row| {
            if !row.settled {
                row.terminal_intent = Some(observation);
                row.usage = usage.clone();
            }
        })
        .await?;
        if let Some(kernel) = &self.kernel {
            let terminal = if observation.semantic_terminal == Some(SemanticTerminal::Completed) {
                KernelTerminal::Committed
            } else {
                KernelTerminal::Released
            };
            Authority::with_clock(self.store.clone(), PlatformTokens, PlatformClock)
                .settle_kernel(kernel, terminal, "observed_semantic_terminal", now_ms()?)
                .await?;
        }
        self.update(|row| row.settled = true).await
    }
}

fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The durable request lifecycle is unavailable.",
        "request_lifecycle_unavailable",
    )
}
