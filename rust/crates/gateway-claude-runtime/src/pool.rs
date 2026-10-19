use crate::{
    host::*,
    persistence, quota,
    response::{self, ErrorEvidence, ResponseKind},
};
use gateway_admin_runtime::{
    claude::{self, AccountBinding, CredentialKind},
    claude_access,
    claude_generation::StateSnapshot,
};
use gateway_catalog_runtime::{ProviderBinding, state::checks_current};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    model::ModelId,
    source_json::SourceJson,
    source_serialization as source,
    state::{AuthorityStore, RevisionCheck},
};
use gateway_providers::Headers;
use gateway_schema::selection::ProviderSelection;
use serde::Serialize;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
};

pub struct ClaudePoolSession {
    pub(crate) config: PoolConfig,
    turns: Cell<u8>,
    attempted: RefCell<BTreeSet<String>>,
}
impl ClaudePoolSession {
    pub fn new(config: PoolConfig) -> Self {
        Self {
            config,
            turns: Cell::new(0),
            attempted: RefCell::new(BTreeSet::new()),
        }
    }
    fn turn(&self) -> Result<(), GatewayError> {
        if self.turns.get() >= 34 {
            return Err(GatewayError::new(
                409,
                "Claude account selection did not settle.",
                Some("claude_code_upstream_unreachable"),
            ));
        }
        self.turns.set(self.turns.get() + 1);
        Ok(())
    }
    pub(crate) async fn access<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        key: &str,
    ) -> Result<Option<RevisionCheck>, GatewayError> {
        let access =
            claude_access::load_policy(store, host, &self.config.allowed_key_ids, &|a, b| {
                host.compare_principals(a, b)
            })
            .await?;
        Ok(access.policy.allows_scalar(key).then_some(access.check))
    }
    pub async fn select<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        input: SelectionInput<'_>,
    ) -> Result<PoolSelection, GatewayError> {
        if !gateway_providers::anthropic::is_claude_model(input.model)
            || !ProviderSelection::enabled(input.selection, "claude_code")
        {
            return Ok(PoolSelection::NotApplicable);
        }
        if self.access(store, host, input.key_id).await?.is_none() {
            return Ok(PoolSelection::NotApplicable);
        }
        if gateway_schema::util::js_trim(&self.config.replay_scope).is_empty() {
            return Err(crate::unavailable(
                "The existing Claude principal replay scope is unavailable.",
            ));
        }
        loop {
            self.turn()?;
            let generation = self.config.generation.snapshot();
            let view = persistence::view(store, host, &self.config).await?;
            if !view.fresh || !generation.is_current() {
                continue;
            }
            let Some((active, quota)) = view.accounts.iter().find(|(a, _)| {
                Some(&a.account_id) == view.roster.roster.active_account_id.as_ref()
            }) else {
                return Ok(PoolSelection::NotApplicable);
            };
            let now = persistence::now(host)?;
            if quota::applicable_proof(quota.as_ref(), active, input.model, now).is_some() {
                let next = view.accounts.iter().find(|(a, q)| {
                    quota::applicable_proof(q.as_ref(), a, input.model, host.now_ms()).is_none()
                });
                let Some((next, _)) = next else {
                    return Ok(PoolSelection::Unavailable);
                };
                persistence::rotate(store, host, &view, active, &next.account_id, input.model)
                    .await?;
                continue;
            }
            if self.attempted.borrow().contains(&active.account_id) {
                return Err(GatewayError::new(
                    409,
                    "Claude account selection changed during the request.",
                    Some("claude_code_upstream_unreachable"),
                ));
            }
            self.attempted
                .borrow_mut()
                .insert(active.account_id.clone());
            if quota::cooling_down(quota.as_ref(), now) {
                let error = quota.as_ref().and_then(|q| q.last_error.as_ref());
                let status = error.and_then(|e| e.status).unwrap_or(429.0).trunc();
                if !(200.0..=599.0).contains(&status) {
                    return Ok(PoolSelection::InternalServerError);
                }
                let status = status as u16;
                let message = error.and_then(|e| e.message.clone()).unwrap_or_else(|| {
                    JsString16::from(
                        "The Claude subscription is cooling down after an upstream rejection.",
                    )
                });
                return Ok(PoolSelection::Refused {
                    status,
                    headers: Headers::from([("Content-Type".into(), "application/json".into())]),
                    body: cooldown_body(&message)?,
                });
            }
            let selected = self
                .prepare(store, host, active.clone(), generation, &input, None)
                .await?;
            return Ok(PoolSelection::Eligible(Box::new(selected)));
        }
    }
    pub(crate) async fn prepare<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        binding: AccountBinding,
        generation: StateSnapshot,
        input: &SelectionInput<'_>,
        retained: Option<&SelectedAccount>,
    ) -> Result<SelectedAccount, GatewayError> {
        if claude::fingerprint(&binding.credential, binding.workspace.as_ref())
            != binding.credential_fingerprint
        {
            return Err(crate::invalid(
                "Claude credential/workspace fingerprint is invalid.",
            ));
        }
        let identity = self
            .config
            .generation
            .catalog_identity(
                &generation,
                Some(&binding),
                &binding.credential,
                binding.workspace.as_ref().map(|w| &w.id),
            )
            .ok_or_else(|| crate::invalid("Claude catalog generation changed."))?;
        let mut options = retained.map(|s| s.options.clone()).unwrap_or_default();
        let effort = input.effective_effort.as_ref();
        if retained.is_some_and(|selected| selected.effective_effort.as_ref() != effort) {
            return Err(crate::invalid(
                "Claude effective reasoning changed within the request.",
            ));
        }
        if retained.is_none() {
            options.native_reasoning_efforts = Some(Vec::new());
            options.supports_native_effort = false;
            options.supports_disabled_thinking = false;
            if effort.is_some() {
                let catalog = host
                    .catalog(
                        &binding,
                        &ProviderBinding {
                            identity: identity.clone(),
                        },
                    )
                    .await?;
                if !catalog.stale
                    && let Some(row) = catalog.models.iter().find(|r| {
                        source::member(r, "id")
                            .and_then(|value| source::string(&value))
                            .is_some_and(|id| &ModelId::from_source(id) == input.model)
                    })
                {
                    options.supports_disabled_thinking =
                        source::member(row, "supports_disabled_thinking")
                            .is_some_and(|value| value.as_str() == "true");
                    options.native_reasoning_efforts = Some(
                        source::member(row, "supported_reasoning_levels")
                            .as_ref()
                            .and_then(source::array)
                            .map(|a| a.iter().filter_map(source::string).collect())
                            .unwrap_or_default(),
                    );
                    options.supports_native_effort = options
                        .native_reasoning_efforts
                        .as_ref()
                        .is_some_and(|a| !a.is_empty());
                }
                if !(effort.is_some_and(|effort| {
                    effort.as_units().iter().copied().eq("none".encode_utf16())
                }) && options.supports_disabled_thinking
                    || effort.is_some_and(|e| {
                        !e.as_units().iter().copied().eq("none".encode_utf16())
                            && options
                                .native_reasoning_efforts
                                .as_ref()
                                .is_some_and(|a| a.iter().any(|v| v == e))
                    }))
                {
                    return Err(crate::invalid(
                        "Claude credential/workspace capability proof changed before dispatch.",
                    ));
                }
            }
        }
        if !generation.is_current() {
            return Err(crate::invalid("Claude catalog generation changed."));
        }
        let roster = claude::current_binding(store, &binding, persistence::now(host)?)
            .await?
            .ok_or_else(|| crate::invalid("Claude account binding changed."))?;
        let access = self
            .access(store, host, input.key_id)
            .await?
            .ok_or_else(|| {
                GatewayError::new(
                    403,
                    "The principal is no longer allowed to use the Claude subscription.",
                    Some("claude_code_request_invalid"),
                )
            })?;
        let native_checks = host.credential_checks(&binding).await?;
        let mut checks = native_checks.clone();
        checks.extend([roster, access]);
        let checks = deduplicate(checks)?;
        if !generation.is_current() || !checks_current(store, &checks).await? {
            return Err(crate::invalid(
                "Claude account/native/access binding changed before dispatch.",
            ));
        }
        Ok(SelectedAccount {
            replay_scope: format!(
                "{}:{}:{}",
                self.config.replay_scope, binding.account_id, binding.account_cohort_id
            ),
            binding,
            checks,
            catalog_identity: identity,
            generation,
            options,
            key_id: input.key_id.into(),
            model: input.model.clone(),
            raw: input.raw.clone(),
            effective_effort: input.effective_effort.clone(),
            disabled: effort
                .is_some_and(|value| value.as_units().iter().copied().eq("none".encode_utf16())),
            native_checks,
            workspace_continuation: retained.is_some(),
        })
    }
    pub async fn ensure_current<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        selected: &SelectedAccount,
        key_id: &str,
        model: &ModelId,
        raw: &SourceJson,
    ) -> Result<(), GatewayError> {
        if selected.key_id != key_id
            || &selected.model != model
            || &selected.raw != raw
            || !selected.generation.is_current()
        {
            return Err(crate::invalid("Claude request or catalog binding changed."));
        }
        let input = SelectionInput {
            key_id,
            model,
            raw,
            effective_effort: selected.effective_effort.clone(),
            selection: None,
        };
        let current = self
            .prepare(
                store,
                host,
                selected.binding.clone(),
                self.config.generation.snapshot(),
                &input,
                selected.workspace_continuation.then_some(selected),
            )
            .await?;
        if current.catalog_identity != selected.catalog_identity
            || !checks_current(store, &selected.checks).await?
        {
            return Err(crate::invalid(
                "Claude account/native/access binding changed before dispatch.",
            ));
        }
        Ok(())
    }
    pub async fn observe_response<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        selected: &SelectedAccount,
        response: ResponseObservation,
    ) -> Result<AcceptedHead, GatewayError> {
        if !(100..=599).contains(&response.status)
            || !(1..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&response.observed_at_ms)
        {
            return Err(crate::invalid("Claude actual response receipt is invalid."));
        }
        let classification = response::classify_headers(
            response.status,
            &response.headers,
            response.observed_at_ms,
            &|text| host.parse_retry_after_date(text),
        );
        let observation = response::observe_headers(&response.headers, response.observed_at_ms);
        let success = classification.kind == ResponseKind::Ok;
        let mut head = AcceptedHead {
            selected: selected.clone(),
            model: selected.model.clone(),
            response,
            classification,
            observation,
            success_recorded: success,
        };
        if success {
            self.record(store, host, &head).await;
            head.success_recorded = true;
        }
        Ok(head)
    }
    pub async fn after_outcome<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        mut head: AcceptedHead,
        evidence: ErrorEvidence,
    ) -> Result<OutcomeDecision, GatewayError> {
        if head.success_recorded {
            return Ok(OutcomeDecision::Preserve);
        }
        head.classification = response::refine_error(head.classification, &evidence)?;
        if head.classification.kind == ResponseKind::WorkspaceRequired
            && head.selected.binding.workspace.is_none()
            && !head.selected.disabled
            && let Some(selected) =
                crate::workspace::discover(self, store, host, &head.selected).await?
        {
            return Ok(OutcomeDecision::WorkspaceContinuation(Box::new(selected)));
        }
        self.record(store, host, &head).await;
        if claude::current_binding(store, &head.selected.binding, persistence::now(host)?)
            .await?
            .is_none()
        {
            return Ok(OutcomeDecision::Preserve);
        }
        let (state, _) =
            persistence::load_quota(store, &head.selected.binding, persistence::now(host)?).await?;
        if quota::applicable_proof(
            state.as_ref(),
            &head.selected.binding,
            &head.model,
            host.now_ms(),
        )
        .is_none()
        {
            return Ok(OutcomeDecision::Preserve);
        }
        let view = persistence::view(store, host, &self.config).await?;
        if !view.fresh {
            return Ok(OutcomeDecision::Preserve);
        }
        if !view.accounts.is_empty()
            && view.roster.roster.active_account_id.is_some()
            && view.accounts.iter().all(|(a, q)| {
                quota::applicable_proof(q.as_ref(), a, &head.model, host.now_ms()).is_some()
            })
        {
            return Ok(OutcomeDecision::Paid);
        }
        if let Some((next, _)) = view.accounts.iter().find(|(a, q)| {
            quota::applicable_proof(q.as_ref(), a, &head.model, host.now_ms()).is_none()
        }) && persistence::rotate(
            store,
            host,
            &view,
            &head.selected.binding,
            &next.account_id,
            &head.model,
        )
        .await?
        {
            return Ok(OutcomeDecision::Retry);
        }
        Ok(OutcomeDecision::Preserve)
    }
    async fn record<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        head: &AcceptedHead,
    ) {
        let committed = persistence::persist(
            store,
            host,
            &head.selected.binding,
            &head.model,
            &head.response,
            &head.classification,
            head.observation.as_ref(),
        )
        .await
        .ok()
        .flatten();
        if let Some(committed) = committed
            && let Some(observation) = &head.observation
            && !observation.is_empty()
            && let Ok(observation_id) = persistence::revision(host)
        {
            let now = host.now_ms();
            let binding = &head.selected.binding;
            let event = AcceptedObservation {
                v: 1,
                observation_id,
                account_id: binding.account_id.clone(),
                account_cohort_id: binding.account_cohort_id.clone(),
                credential_kind: match binding.credential.kind {
                    CredentialKind::ApiKey => "api_key",
                    CredentialKind::Oauth => "oauth",
                }
                .into(),
                workspace_id: binding.workspace.as_ref().map(|w| w.id.clone()),
                source_observed_at_ms: Some(head.response.observed_at_ms),
                sampled_at_ms: now,
                response_status: Some(head.response.status),
                state: if head.classification.kind == ResponseKind::AuthInvalid
                    || quota::blocked(Some(&committed.state), now)
                    || quota::cooling_down(Some(&committed.state), now)
                {
                    "unavailable"
                } else {
                    "available"
                }
                .into(),
                observation: observation.clone(),
            };
            let _ = host.accepted_observation(&event).await;
        }
        self.health(
            store,
            host,
            &head.selected.binding,
            head.classification.kind.health(),
            Some(head.response.status),
            head.response.provider_request_id.clone(),
        )
        .await;
    }
    pub async fn observe_transport_failure<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        selected: &SelectedAccount,
    ) -> Result<(), GatewayError> {
        self.health(store, host, &selected.binding, "upstream_error", None, None)
            .await;
        Ok(())
    }
    async fn health<S: AuthorityStore, H: ClaudePoolHost>(
        &self,
        store: &S,
        host: &H,
        binding: &AccountBinding,
        event: &str,
        status: Option<u16>,
        provider_request_id: Option<String>,
    ) {
        if let Ok(Some(check)) = claude::current_binding(store, binding, host.now_ms()).await {
            let id = provider_request_id
                .map(|id| gateway_schema::util::js_trim(&id).to_owned())
                .filter(|id| {
                    !id.is_empty()
                        && id.encode_utf16().count() <= 256
                        && !id.chars().any(|c| (c as u32) < 0x20 || c == '\x7f')
                });
            let _ = host
                .health_observation(&HealthObservation {
                    identity: format!(
                        "{}:{}:{}",
                        binding.account_id, binding.account_cohort_id, binding.evidence_generation
                    ),
                    event: event.into(),
                    status,
                    provider_request_id: id,
                    checks: vec![check],
                })
                .await;
        }
    }
}
fn cooldown_body(message: &JsString16) -> Result<SourceJson, GatewayError> {
    #[derive(Serialize)]
    struct Error<'a> {
        message: &'a JsString16,
        r#type: &'static str,
        code: &'static str,
    }
    #[derive(Serialize)]
    struct Envelope<'a> {
        error: Error<'a>,
    }
    SourceJson::from_serializable(&Envelope {
        error: Error {
            message,
            r#type: "invalid_request_error",
            code: "claude_code_cooling_down",
        },
    })
}
fn deduplicate(checks: Vec<RevisionCheck>) -> Result<Vec<RevisionCheck>, GatewayError> {
    let mut map = BTreeMap::new();
    for check in checks {
        if let Some(old) = map.insert(check.key.0, check.expected_revision.clone())
            && old != check.expected_revision
        {
            return Err(crate::invalid("Claude source checks disagree."));
        }
    }
    Ok(map
        .into_iter()
        .map(|(key, expected_revision)| RevisionCheck {
            key: gateway_core::state::RecordKey(key),
            expected_revision,
        })
        .collect())
}
