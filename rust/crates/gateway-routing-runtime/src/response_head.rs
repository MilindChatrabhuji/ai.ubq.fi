//! Actual response-head ownership and one source workspace continuation.
use crate::{
    journal::{self, Phase},
    session::RoutingSession,
    types::*,
};
use gateway_authority::{AuthorityClock, TokenSource};
use gateway_core::{GatewayError, claude::ClaudeErrorEvidence, query::QueryStore};

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> RoutingSession<S, I, C, H>
{
    pub async fn observe_response(
        &self,
        attempt: &PreparedAttempt,
        response: ResponseHead,
    ) -> RoutingResult<ObservedResponse<H::ClaudeHead>> {
        let (_, record) = self.observed_attempt(attempt).await?;
        if record.phase != Phase::Started
            || !record.transport_started
            || !(100..=599).contains(&response.status)
            || response.observed_at_ms < self.input.context.started_at_ms
            || response.observed_at_ms > self.now()?
        {
            return Err(journal::unavailable(
                "Response headers have no matching started transport.",
            )
            .into());
        }
        let nonce = self.tokens.next_token()?;
        self.change(|row| {
            let current = row
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt.id)
                .ok_or_else(|| journal::unavailable("Response attempt disappeared."))?;
            if row.active.as_ref() != Some(&attempt.id)
                || current.phase != Phase::Started
                || current.response_nonce.is_some()
                || current.workspace_nonce.is_some()
                || current.response_count != current.workspace_continuations
            {
                return Err(journal::unavailable(
                    "Duplicate or out-of-phase response headers.",
                ));
            }
            current.response_count = current
                .response_count
                .checked_add(1)
                .ok_or_else(|| journal::unavailable("Response counter overflow."))?;
            current.response_nonce = Some(nonce.clone());
            Ok(())
        })
        .await?;
        let head = if matches!(record.fence, CredentialFence::Claude { .. }) {
            Some(
                self.host
                    .observe_claude_response(&record.fence, &record.model, response.clone())
                    .await?,
            )
        } else {
            None
        };
        Ok(ObservedResponse {
            original_request_id: self.id().to_owned(),
            attempt_id: attempt.id.clone(),
            nonce,
            response,
            head,
        })
    }

    pub async fn resolve_response(
        &self,
        attempt: &PreparedAttempt,
        response: ObservedResponse<H::ClaudeHead>,
        evidence: ClaudeErrorEvidence,
        failure: Option<AttemptFailure>,
    ) -> RoutingResult<ResponseDecision> {
        let (_, record) = self.observed_attempt(attempt).await?;
        if response.original_request_id != self.id()
            || response.attempt_id != attempt.id
            || record.phase != Phase::Started
            || record.response_nonce.as_ref() != Some(&response.nonce)
            || (response.response.status >= 400) != failure.is_some()
        {
            return Err(journal::unavailable(
                "Response-head capability is stale or has the wrong outcome phase.",
            )
            .into());
        }
        if let Some(failure) = &failure
            && (failure.origin != FailureOrigin::Provider
                || failure.status != Some(response.response.status)
                || failure.headers != response.response.headers
                || failure.transport != TransportState::Started)
        {
            return Err(journal::unavailable(
                "Refusal does not match its actual response headers.",
            )
            .into());
        }
        self.change(|row| {
            let current = row
                .attempts
                .iter_mut()
                .find(|a| a.id == attempt.id)
                .ok_or_else(|| journal::unavailable("Response attempt disappeared."))?;
            if row.active.as_ref() != Some(&attempt.id)
                || current.phase != Phase::Started
                || current.response_nonce.as_ref() != Some(&response.nonce)
            {
                return Err(journal::unavailable(
                    "Response-head capability was already consumed.",
                ));
            }
            current.response_nonce = None;
            Ok(())
        })
        .await?;
        let Some(head) = response.head else {
            if matches!(record.fence, CredentialFence::Claude { .. }) {
                return Err(
                    journal::unavailable("Claude response lacks its actual opaque head.").into(),
                );
            }
            return match failure {
                None => Ok(ResponseDecision::Return),
                Some(failure) => match self.refusal(attempt, failure).await? {
                    RefusalDecision::Continue => Ok(ResponseDecision::Continue),
                    RefusalDecision::Return => Ok(ResponseDecision::Return),
                    RefusalDecision::Abort => Err(self.host.cancellation_error().into()),
                },
            };
        };
        if !matches!(record.fence, CredentialFence::Claude { .. }) {
            return Err(
                journal::unavailable("Opaque Claude head belongs to another provider.").into(),
            );
        }
        let outcome = self.host.finish_claude_response(head, evidence).await?;
        if failure.is_none() {
            return if matches!(outcome, ClaudeOutcome::Preserve) {
                Ok(ResponseDecision::Return)
            } else {
                Err(journal::unavailable(
                    "A successful response cannot authorize provider continuation.",
                )
                .into())
            };
        }
        if self.host.cancelled() {
            return Ok(ResponseDecision::Return);
        }
        match outcome {
            ClaudeOutcome::Preserve => Ok(ResponseDecision::Return),
            ClaudeOutcome::WorkspaceContinuation(publication) => {
                // Disabled thinking preserves the original refusal without any
                // re-encoding, dropped flag, or follow-up transport.
                if gateway_core::source_serialization::member(attempt.request.body(), "thinking")
                    .and_then(|thinking| {
                        gateway_core::source_serialization::member(&thinking, "type")
                    })
                    .and_then(|kind| gateway_core::source_serialization::string(&kind))
                    .is_some_and(|kind| {
                        kind == gateway_core::js_string::JsString16::from_utf8("disabled")
                    })
                    || record.workspace_continuations != 0
                {
                    return Ok(ResponseDecision::Return);
                }
                let updated = workspace_attempt(attempt, *publication)?;
                self.host
                    .ensure_credential_current(
                        &updated.credential,
                        &self.input.principal,
                        &record.model,
                    )
                    .await?;
                let nonce = self.tokens.next_token()?;
                let checks = claude_checks(&updated.credential)?;
                journal::change(
                    &self.store,
                    &self.tokens,
                    self.id(),
                    self.now()?,
                    &checks,
                    |row| {
                        let current = row
                            .attempts
                            .iter_mut()
                            .find(|a| a.id == attempt.id)
                            .ok_or_else(|| {
                                journal::unavailable("Workspace attempt disappeared.")
                            })?;
                        if row.active.as_ref() != Some(&attempt.id)
                            || current.phase != Phase::Started
                            || current.workspace_continuations != 0
                            || current.response_nonce.is_some()
                        {
                            return Err(journal::unavailable(
                                "Workspace continuation is stale or already adopted.",
                            ));
                        }
                        current.fence = updated.credential.clone();
                        current.workspace_nonce = Some(nonce.clone());
                        current.workspace_continuations = 1;
                        Ok(())
                    },
                )
                .await?;
                Ok(ResponseDecision::WorkspaceContinuation(Box::new(
                    WorkspaceContinuation {
                        attempt: updated,
                        nonce,
                    },
                )))
            }
            ClaudeOutcome::Retry | ClaudeOutcome::Paid => {
                let paid = matches!(outcome, ClaudeOutcome::Paid);
                self.change(|row| {
                    let current = row
                        .attempts
                        .iter_mut()
                        .find(|a| a.id == attempt.id)
                        .ok_or_else(|| journal::unavailable("Claude attempt disappeared."))?;
                    if row.active.as_ref() != Some(&attempt.id) || current.phase != Phase::Started {
                        return Err(journal::unavailable("Claude outcome is no longer current."));
                    }
                    current.phase = Phase::Refused;
                    row.active = None;
                    if paid {
                        // This is only a selection cursor. m03 still requires
                        // the real current full-cohort proof before any paid hop.
                        row.claude_unavailable = true;
                        row.cursor += 1;
                    }
                    Ok(())
                })
                .await?;
                Ok(ResponseDecision::Continue)
            }
        }
    }

    pub async fn before_workspace_dispatch(
        &self,
        continuation: WorkspaceContinuation,
    ) -> RoutingResult<()> {
        if self.host.cancelled() {
            return Err(self.host.cancellation_error().into());
        }
        let (_, record) = self.observed_attempt(&continuation.attempt).await?;
        if record.phase != Phase::Started
            || !record.transport_started
            || record.workspace_nonce.as_ref() != Some(&continuation.nonce)
        {
            return Err(journal::unavailable(
                "Workspace transport lacks its original started admission.",
            )
            .into());
        }
        self.host
            .ensure_credential_current(&record.fence, &self.input.principal, &record.model)
            .await?;
        let checks = claude_checks(&record.fence)?;
        journal::change(
            &self.store,
            &self.tokens,
            self.id(),
            self.now()?,
            &checks,
            |row| {
                let current = row
                    .attempts
                    .iter_mut()
                    .find(|a| a.id == continuation.attempt.id)
                    .ok_or_else(|| journal::unavailable("Workspace transport disappeared."))?;
                if row.active.as_ref() != Some(&continuation.attempt.id)
                    || current.phase != Phase::Started
                    || current.workspace_nonce.as_ref() != Some(&continuation.nonce)
                {
                    return Err(journal::unavailable(
                        "Workspace transport capability was already consumed.",
                    ));
                }
                current.workspace_nonce = None;
                Ok(())
            },
        )
        .await?;
        // No second reserve, API dispatch claim, paid reservation, or kernel admission.
        Ok(())
    }
}

fn claude_checks(fence: &CredentialFence) -> Result<Vec<RevisionCheckWire>, GatewayError> {
    match fence {
        CredentialFence::Claude { checks, .. } => Ok(checks.clone()),
        _ => Err(journal::unavailable(
            "Workspace continuation requires a Claude owner fence.",
        )),
    }
}

fn workspace_attempt(
    attempt: &PreparedAttempt,
    publication: PublishedCredential,
) -> Result<PreparedAttempt, GatewayError> {
    let (
        PreparedWireRequest::Claude(body),
        PublishedCredential::Claude {
            fence,
            body_options,
        },
    ) = (&attempt.request, &publication)
    else {
        return Err(journal::unavailable(
            "Workspace continuation has no current owner binding.",
        ));
    };
    let (old_id, new_id, workspace) = match (&attempt.credential, fence) {
        (
            CredentialFence::Claude {
                account_id: old, ..
            },
            CredentialFence::Claude {
                account_id: new,
                workspace_id: Some(workspace),
                ..
            },
        ) => (old, new, workspace),
        _ => {
            return Err(journal::unavailable(
                "Workspace continuation has no current owner binding.",
            ));
        }
    };
    if old_id != new_id || body.kind() != body_options.kind || workspace.as_units().is_empty() {
        return Err(journal::unavailable(
            "Workspace continuation changed account or mismatched its owner.",
        ));
    }
    // The selected physical binding remains in the host. Keep the existing
    // prepared body and kind; host currentness and atomic revision checks bind
    // the new workspace. Never fabricate headers or replay body preparation.
    let mut updated = attempt.clone();
    updated.credential = publication.into_fence();
    Ok(updated)
}
