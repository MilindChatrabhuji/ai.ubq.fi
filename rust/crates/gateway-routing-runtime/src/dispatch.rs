use crate::{
    classify,
    journal::{self, AttemptRecord, BillingUsage, Journal, Phase},
    session::RoutingSession,
    settlement,
    types::*,
};
use gateway_authority::{AuthorityClock, TokenSource, quota::KernelTerminal};
use gateway_core::{
    GatewayError,
    lifecycle::{PaidTerminalState, SemanticTerminal, TransportObservation},
    provider::UpstreamProvider,
    query::QueryStore,
};
use gateway_providers::policy::{HopDecision, HopFailure};

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> RoutingSession<S, I, C, H>
{
    pub(crate) async fn observed_attempt(
        &self,
        attempt: &PreparedAttempt,
    ) -> Result<(Journal, AttemptRecord), GatewayError> {
        let (_, row) = journal::load(&self.store, self.id()).await?;
        settlement::ensure_active(&row)?;
        let record = row
            .attempts
            .iter()
            .find(|a| {
                a.id == attempt.id
                    && a.provider == attempt.request.provider()
                    && a.fence == attempt.credential
                    && a.paid == attempt.paid
            })
            .cloned()
            .ok_or_else(|| journal::unavailable("Provider attempt identity mismatch."))?;
        if row.active.as_ref() != Some(&attempt.id) || attempt.original_request_id != self.id() {
            return Err(journal::unavailable("Provider attempt is not current."));
        }
        Ok((row, record))
    }
    pub async fn before_dispatch(&self, attempt: &PreparedAttempt) -> RoutingResult<()> {
        if self.host.cancelled() {
            return Err(self.host.cancellation_error().into());
        }
        let (row, record) = self.observed_attempt(attempt).await?;
        if record.phase != Phase::Prepared {
            return Err(journal::unavailable(
                "This attempt's dispatch intent is already consumed.",
            )
            .into());
        }
        self.host
            .ensure_credential_current(&record.fence, &self.input.principal, &record.model)
            .await?;
        if let CredentialFence::Codex { admission, .. } = &record.fence {
            self.authority()
                .ensure_admission_current(admission, self.now()?)
                .await?;
        }
        if let Some(reservation) = &record.paid {
            let synthetic = match self.plan.hops.get(record.cursor) {
                Some(crate::policy::RouteHop::Paid {
                    provider,
                    model,
                    synthetic,
                }) if provider == &reservation.provider && model == &record.model => *synthetic,
                _ => {
                    return Err(journal::unavailable(
                        "Paid dispatch no longer matches the original pinned hop.",
                    )
                    .into());
                }
            };
            let input = gateway_authority::paid::PaidRequest {
                key_id: reservation.key_id.clone(),
                request_id: reservation.request_id.clone(),
                attempt_id: reservation.attempt_id.clone(),
                provider: reservation.provider,
                model: record.model.clone(),
                route: self.input.context.route.clone(),
                path: if self.input.surface == gateway_providers::ClientSurface::Chat {
                    "/v1/chat/completions"
                } else {
                    "/v1/responses"
                }
                .into(),
                stream: self.input.streamed(),
                reasoning: self.input.requested_reasoning(),
                created_at_ms: self.input.context.started_at_ms,
            };
            let context = self.paid_context(reservation.provider, synthetic)?;
            let receipt = self
                .authority()
                .authorize_paid_route(&input, &context, self.now()?)
                .await?;
            let receipt = self
                .authority()
                .bind_paid_original_dispatch(
                    &receipt,
                    &self.input.context,
                    reservation,
                    self.now()?,
                )
                .await?;
            Self::check_paid_credential(&record.fence, &receipt)?;
            let authorization = if synthetic {
                gateway_authority::paid::PaidAuthorization::DirectPaidModel
            } else {
                self.paid_authorization(&row).await?
            };
            match self
                .authority()
                .reserve_paid(&input, &authorization, &receipt, self.now()?)
                .await?
            {
                gateway_authority::paid::PaidAdmission::Existing(current)
                    if current == *reservation => {}
                _ => {
                    return Err(journal::unavailable(
                        "The paid reservation changed before dispatch.",
                    )
                    .into());
                }
            }
        }
        let mut api = row.api.clone();
        if let Some(reservation) = &api {
            api = Some(
                self.authority()
                    .resolve_deferred_api(reservation, self.now()?)
                    .await?,
            );
        }
        if let Some(reservation) = &api {
            self.authority()
                .dispatch_api_key(reservation, record.provider, self.now()?)
                .await?;
        }
        self.admission.capture_resolved_api(api.as_ref())?;
        let checks = match &record.fence {
            CredentialFence::Codex {
                source_key,
                source_revision,
                ..
            } => vec![RevisionCheckWire {
                key: source_key.clone(),
                expected_revision: Some(source_revision.clone()),
            }],
            CredentialFence::Claude { checks, .. } => checks.clone(),
            _ => vec![],
        };
        journal::change(
            &self.store,
            &self.tokens,
            self.id(),
            self.now()?,
            &checks,
            |j| {
                settlement::ensure_active(j)?;
                let current = j
                    .attempts
                    .iter_mut()
                    .find(|a| a.id == attempt.id)
                    .ok_or_else(|| journal::unavailable("Attempt disappeared."))?;
                if current.phase != Phase::Prepared {
                    return Err(journal::unavailable("Duplicate attempt dispatch."));
                }
                current.phase = Phase::Intent;
                j.api = api.clone();
                Ok(())
            },
        )
        .await?;
        self.host
            .ensure_credential_current(&record.fence, &self.input.principal, &record.model)
            .await?;
        if let CredentialFence::Codex { admission, .. } = &record.fence {
            self.authority()
                .ensure_admission_current(admission, self.now()?)
                .await?;
        }
        if self.host.cancelled() {
            return Err(self.host.cancellation_error().into());
        }
        Ok(())
    }
    pub async fn transport_started(&self, attempt: &PreparedAttempt) -> RoutingResult<()> {
        let (row, record) = self.observed_attempt(attempt).await?;
        if record.phase != Phase::Intent {
            return Err(journal::unavailable("Transport lacks a current dispatch intent.").into());
        }
        // This method records an actual invocation, not a new authorization.
        // Credential/current-admission guards ran immediately before transport;
        // a later rotation cannot erase the fact that the old attempt started.
        if let Some(api) = &row.api {
            self.authority()
                .mark_api_transport_started(api, self.now()?)
                .await?;
        }
        if let Some(paid) = &record.paid {
            self.authority()
                .mark_paid_transport_started(paid, self.now()?)
                .await?;
        }
        self.change(|j| {
            let current = j
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt.id)
                .ok_or_else(|| journal::unavailable("Attempt disappeared."))?;
            current.transport_started = true;
            current.phase = Phase::Started;
            Ok(())
        })
        .await?;
        Ok(())
    }
    pub async fn renew(&self) -> RoutingResult<()> {
        self.currentness().renew_kernel().await?;
        Ok(())
    }
    pub async fn observe_terminal(
        &self,
        attempt: &PreparedAttempt,
        observation: TransportObservation,
        usage: AttemptUsage,
    ) -> RoutingResult<()> {
        let (row, record) = self.observed_attempt(attempt).await?;
        if record
            .observation
            .and_then(|o| o.semantic_terminal)
            .is_some_and(|t| Some(t) != observation.semantic_terminal)
        {
            return Err(journal::unavailable(
                "Provider semantic terminal conflicts with its durable intent.",
            )
            .into());
        }
        self.change(|j| {
            let current = j
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt.id)
                .ok_or_else(|| journal::unavailable("Attempt disappeared."))?;
            current.observation = Some(observation);
            current.phase = Phase::Terminal;
            current.provider_request_id = usage
                .provider_request_id
                .clone()
                .or_else(|| current.provider_request_id.clone());
            if let Some(paid) = &usage.paid {
                current.billing = Some(BillingUsage::from_usage(paid));
            }
            j.semantic_committed |= observation.semantic_terminal.is_some();
            Ok(())
        })
        .await?;
        if let Some(paid) = &record.paid {
            self.authority()
                .record_paid_lifecycle(
                    paid,
                    usage.provider_request_id.as_deref(),
                    observation.semantic_terminal.map(paid_terminal),
                    self.now()?,
                )
                .await?;
            if let Some(usage) = &usage.paid {
                self.authority()
                    .settle_paid(paid, usage, self.now()?)
                    .await?;
            }
        }
        if let Some(kernel) = &row.kernel
            && let Some(terminal) = observation.semantic_terminal
        {
            self.authority()
                .record_kernel_terminal_intent(
                    kernel,
                    if terminal == SemanticTerminal::Completed {
                        KernelTerminal::Committed
                    } else {
                        KernelTerminal::Released
                    },
                    self.now()?,
                )
                .await?;
        }
        Ok(())
    }
    pub async fn refusal(
        &self,
        attempt: &PreparedAttempt,
        failure: AttemptFailure,
    ) -> RoutingResult<RefusalDecision> {
        let (row, record) = self.observed_attempt(attempt).await?;
        if matches!(record.fence, CredentialFence::Claude { .. })
            && failure.origin == FailureOrigin::Provider
        {
            return Err(journal::unavailable(
                "Claude refusals require the consumed actual response-head capability.",
            )
            .into());
        }
        if failure.transport == TransportState::NotStarted && record.transport_started {
            return Err(journal::unavailable(
                "NotStarted report conflicts with durable transport intent.",
            )
            .into());
        }
        if failure.transport == TransportState::NotStarted {
            self.change(|j| {
                let current = j
                    .attempts
                    .iter_mut()
                    .find(|a| a.id == attempt.id)
                    .ok_or_else(|| journal::unavailable("Attempt disappeared."))?;
                current.known_not_started = true;
                Ok(())
            })
            .await?;
        } else if !record.transport_started {
            self.transport_started(attempt).await?;
        }
        if failure.cancelled || self.host.cancelled() || failure.failure == HopFailure::Cancelled {
            return Ok(
                if failure.origin == FailureOrigin::Provider && failure.status.is_some() {
                    RefusalDecision::Return
                } else {
                    RefusalDecision::Abort
                },
            );
        }
        if failure.origin == FailureOrigin::Gateway
            || failure.origin == FailureOrigin::GatewayDeadline
            || (failure.origin != FailureOrigin::Provider
                && failure.failure == HopFailure::Deadline)
        {
            return Ok(RefusalDecision::Abort);
        }
        if row.semantic_committed || failure.semantic_committed {
            return Ok(RefusalDecision::Return);
        }
        let mut decision = RefusalDecision::Return;
        let mut cursor = record.cursor;
        if self.plan.synthetic {
            decision = match gateway_providers::policy::deepseek_decision(failure.failure, false) {
                HopDecision::Advance => {
                    cursor += 1;
                    RefusalDecision::Continue
                }
                HopDecision::Abort => RefusalDecision::Abort,
                HopDecision::Deliver => RefusalDecision::Return,
            };
        } else if let CredentialFence::Codex { admission, .. } = &record.fence
            && failure.origin == FailureOrigin::Provider
        {
            if let Some(block) = classify::codex_quota(
                failure.status,
                &failure.headers,
                &failure.body,
                failure.body_complete,
                self.now()?,
            ) {
                if self
                    .authority()
                    .record_quota_block(admission, block, self.now()?)
                    .await?
                {
                    decision = RefusalDecision::Continue;
                }
            } else if failure.status == Some(401) {
                let version = admission.binding.credential_version.0.clone();
                let refreshed = row.refreshed_versions.contains(&version);
                if !refreshed {
                    self.change(|j| {
                        j.refreshed_versions.push(version.clone());
                        Ok(())
                    })
                    .await?;
                    let published =
                        self.host.refresh_codex(&record.fence).await? == RefreshOutcome::Published;
                    if published
                        || self
                            .authority()
                            .mark_credential_invalid(admission, self.now()?)
                            .await?
                    {
                        decision = RefusalDecision::Continue;
                    }
                } else if self
                    .authority()
                    .mark_credential_invalid(admission, self.now()?)
                    .await?
                {
                    decision = RefusalDecision::Continue;
                }
            } else if let Some(detail) = classify::unsupported_model(
                failure.status,
                &failure.body,
                failure.body_complete,
                &record.model,
            ) && self
                .authority()
                .learn_model_unavailable(admission, &detail, self.now()?)
                .await?
            {
                if row.model_sibling_retries < 1 {
                    self.change(|j| {
                        j.model_sibling_retries += 1;
                        Ok(())
                    })
                    .await?;
                    decision = RefusalDecision::Continue;
                } else {
                    return Err(classify::model_unavailable_error(&record.model).into());
                }
            }
        } else if record.paid.is_some() && failure.origin == FailureOrigin::Provider {
            if gateway_providers::policy::paid_should_advance(
                failure.status,
                self.plan.hops.get(cursor + 1).is_some(),
            ) {
                cursor += 1;
                decision = RefusalDecision::Continue;
            }
        } else if record.provider == UpstreamProvider::Lithos
            && failure.origin == FailureOrigin::Provider
            && failure.status == Some(429)
        {
            let now = self.now()?;
            let response_prohibited = gateway_providers::lithos::retry_prohibited(&failure.headers);
            let wait = lithos_wait_ms(&failure.headers, now);
            let rung = gateway_providers::policy::lithos_canonical(&record.model);
            self.lithos_attempted.borrow_mut().insert(rung.clone());
            if response_prohibited {
                self.lithos_no_retry.borrow_mut().insert(rung);
            }
            if !self.input.retry_prohibited {
                let next = {
                    let no_retry = self.lithos_no_retry.borrow();
                    let attempted = self.lithos_attempted.borrow();
                    self.lithos
                        .borrow()
                        .eligible(&record.model, now, &no_retry, &attempted)
                };
                if let Some(next) = next
                    && next != record.model
                {
                    if !response_prohibited && let Some(wait) = wait {
                        self.lithos.borrow_mut().refuse(&record.model, now, wait);
                    }
                    decision = RefusalDecision::Continue;
                } else if !response_prohibited && let Some(wait) = wait {
                    let retry_target = {
                        let no_retry = self.lithos_no_retry.borrow();
                        self.lithos
                            .borrow()
                            .retry_eligible(&record.model, &no_retry)
                    };
                    if retry_target.is_some() && self.waits.borrow_mut().claim(wait, false) {
                        self.lithos_attempted.borrow_mut().clear();
                        self.renew().await?;
                        let outcome = self.host.wait(wait).await;
                        if !(0..=9_007_199_254_740_991).contains(&outcome.elapsed_ms) {
                            return Err(
                                journal::unavailable("The host wait duration is invalid.").into()
                            );
                        }
                        self.elapsed_wait_ms.set(
                            self.elapsed_wait_ms
                                .get()
                                .saturating_add(outcome.elapsed_ms),
                        );
                        outcome.result?;
                        if self.host.cancelled() {
                            return Ok(RefusalDecision::Abort);
                        }
                        decision = RefusalDecision::Continue;
                    }
                }
            }
        }
        if decision == RefusalDecision::Continue {
            self.change(|j| {
                let current = j
                    .attempts
                    .iter_mut()
                    .find(|a| a.id == attempt.id)
                    .ok_or_else(|| journal::unavailable("Attempt disappeared."))?;
                current.phase = Phase::Refused;
                j.active = None;
                j.cursor = cursor;
                Ok(())
            })
            .await?;
            if failure.transport == TransportState::NotStarted {
                if let Some(paid) = &record.paid {
                    self.authority()
                        .release_paid_before_transport(paid, self.now()?)
                        .await?;
                }
            } else if let Some(paid) = &record.paid {
                self.authority()
                    .record_paid_lifecycle(paid, None, Some(PaidTerminalState::Failed), self.now()?)
                    .await?;
                self.authority().defer_paid(paid, self.now()?).await?;
            }
        }
        Ok(decision)
    }
    pub async fn finish(
        &self,
        observation: TransportObservation,
    ) -> RoutingResult<RecoveredSession> {
        if journal::load(&self.store, self.id())
            .await?
            .1
            .extras_family
            .is_some()
        {
            return Err(journal::unavailable(
                "Finalize extras through their aggregate admission handle.",
            )
            .into());
        }
        Ok(settlement::finish_record(
            &self.store,
            &self.tokens,
            &self.clock,
            &self.host,
            self.id(),
            observation,
        )
        .await?)
    }
}
fn paid_terminal(terminal: SemanticTerminal) -> PaidTerminalState {
    match terminal {
        SemanticTerminal::Completed => PaidTerminalState::Completed,
        SemanticTerminal::Incomplete => PaidTerminalState::Incomplete,
        SemanticTerminal::Failed | SemanticTerminal::Error => PaidTerminalState::Failed,
    }
}
fn lithos_wait_ms(headers: &gateway_providers::Headers, now: i64) -> Option<i64> {
    let wait = gateway_providers::lithos::rate_limit_wait(headers, now as f64, |raw| {
        chrono::DateTime::parse_from_rfc2822(raw)
            .ok()
            .map(|date| date.timestamp_millis() as f64)
    })?;
    (wait.wait_ms.is_finite() && wait.wait_ms > 0.0 && wait.wait_ms <= 9_007_199_254_740_991.0)
        .then_some(wait.wait_ms.round() as i64)
}
