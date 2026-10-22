use crate::{
    journal::{self, AttemptRecord, Phase},
    policy::RouteHop,
    session::RoutingSession,
    settlement,
    types::*,
};
use gateway_authority::{
    AuthorityClock, TokenSource,
    paid::{PaidAdmission, PaidAuthorization, PaidRequest},
    routing::RouteSelection,
};
use gateway_core::{
    GatewayError,
    identity::PaidAttemptId,
    provider::{PaidProvider, UpstreamProvider},
    query::QueryStore,
};
use gateway_providers::ClientSurface;

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> RoutingSession<S, I, C, H>
{
    pub async fn next_attempt(&self) -> RoutingResult<Option<PreparedAttempt>> {
        for _ in 0..34 {
            if self.host.cancelled() {
                return Err(self.host.cancellation_error().into());
            }
            let (_, row) = journal::load(&self.store, self.id()).await?;
            settlement::ensure_active(&row)?;
            if row.extras_family.is_some() {
                return Err(journal::unavailable(
                    "Extras dispatch requires an opaque child scope.",
                )
                .into());
            }
            if row.semantic_committed {
                return Ok(None);
            }
            if row.active.is_some() {
                return Err(journal::unavailable(
                    "The previous attempt has not been refused or finalized.",
                )
                .into());
            }
            let Some(hop) = self.plan.hops.get(row.cursor).cloned() else {
                return Ok(None);
            };
            let (provider, model, publication, paid) = match hop {
                RouteHop::Direct { provider, model } => {
                    let model = if provider == UpstreamProvider::Lithos {
                        let no_retry = self.lithos_no_retry.borrow();
                        let attempted = self.lithos_attempted.borrow();
                        self.lithos
                            .borrow()
                            .eligible(&model, self.now()?, &no_retry, &attempted)
                            .unwrap_or(model)
                    } else {
                        model
                    };
                    let credential = self.credential(provider, &model, None).await?;
                    (provider, model, credential, None)
                }
                RouteHop::Claude => {
                    if !self.input.catalog.enabled("claude_code") {
                        self.cursor(row.cursor + 1).await?;
                        continue;
                    }
                    let ordinary = self.claude_ordinary(&self.plan.model)?;
                    match self
                        .host
                        .select_claude(
                            &self.input.principal,
                            &self.plan.model,
                            &self.input.raw,
                            ordinary.effective_effort(),
                        )
                        .await?
                    {
                        ClaudeSelection::NotApplicable => {
                            self.cursor(row.cursor + 1).await?;
                            continue;
                        }
                        ClaudeSelection::Refused {
                            status,
                            headers,
                            body,
                        } => {
                            return Err(RoutingError {
                                error: Box::new(GatewayError::new(
                                    status,
                                    "Claude subscription request was refused.",
                                    Some("claude_code_refused"),
                                )),
                                headers,
                                source_body: Some(SourceRefusalBody::Json(body)),
                            });
                        }
                        ClaudeSelection::InternalServerError => {
                            return Err(RoutingError {
                                error: Box::new(GatewayError::new(
                                    500,
                                    "Internal Server Error",
                                    None,
                                )),
                                headers: gateway_providers::Headers::from([(
                                    "Content-Type".into(),
                                    "text/plain; charset=utf-8".into(),
                                )]),
                                source_body: Some(SourceRefusalBody::InternalServerError),
                            });
                        }
                        ClaudeSelection::Unavailable => {
                            self.change(|j| {
                                j.claude_unavailable = true;
                                j.cursor += 1;
                                Ok(())
                            })
                            .await?;
                            continue;
                        }
                        ClaudeSelection::Eligible(credential) => {
                            if !matches!(
                                credential.as_ref(),
                                PublishedCredential::Claude {
                                    fence: CredentialFence::Claude { .. },
                                    ..
                                }
                            ) {
                                return Err(journal::unavailable(
                                    "Claude credential binding is invalid.",
                                )
                                .into());
                            }
                            (
                                UpstreamProvider::ClaudeCode,
                                self.plan.model.clone(),
                                *credential,
                                None,
                            )
                        }
                    }
                }
                RouteHop::Codex => {
                    let mut account = match self
                        .authority()
                        .select_account(&self.plan.model, self.plan.quota_class, self.now()?)
                        .await?
                    {
                        RouteSelection::Eligible(account) => account,
                        RouteSelection::QuotaBlocked { proof, .. } => {
                            let recovery =
                                if proof.full_cohort_exhausted() && !row.recovery_attempted {
                                    self.change(|journal| {
                                        journal.recovery_attempted = true;
                                        Ok(())
                                    })
                                    .await?;
                                    self.host.recover_codex(&proof, &self.plan.model).await?
                                } else {
                                    CodexRecovery::Declined
                                };
                            match recovery {
                                CodexRecovery::Recovered(account) => {
                                    if account.requested_model != self.plan.model
                                        || account.quota_class != self.plan.quota_class
                                        || account.probe_required
                                        || account.probe.is_none()
                                    {
                                        return Err(journal::unavailable("The elected recovery admission does not match this request.").into());
                                    }
                                    self.authority()
                                        .ensure_admission_current(&account, self.now()?)
                                        .await?;
                                    account
                                }
                                CodexRecovery::Reselect => continue,
                                CodexRecovery::Declined => {
                                    if !proof.full_cohort_unavailable() {
                                        return Err(journal::unavailable(
                                            "Subscription pool is not authoritatively unavailable.",
                                        )
                                        .into());
                                    }
                                    self.cursor(row.cursor + 1).await?;
                                    continue;
                                }
                            }
                        }
                        RouteSelection::CredentialsInvalid { proof } => {
                            if !proof.full_cohort_unavailable() {
                                return Err(journal::unavailable(
                                    "Credential failure does not cover the current pool.",
                                )
                                .into());
                            }
                            self.cursor(row.cursor + 1).await?;
                            continue;
                        }
                        RouteSelection::ModelUnavailable { model, detail } => {
                            let detail = detail.unwrap_or_else(|| {
                                let mut units = "The model '".encode_utf16().collect::<Vec<_>>();
                                units.extend_from_slice(model.as_js_string().as_units());
                                units.extend(
                                    "' is not available for these subscriptions.".encode_utf16(),
                                );
                                gateway_core::js_string::JsString16::from_units(units)
                            });
                            return Err(gateway_schema::source_request::SourceRequestError::new(
                                404,
                                detail,
                                "invalid_request_error",
                                Some("model_not_found"),
                                None,
                            )
                            .into());
                        }
                        RouteSelection::RoutingUnavailable => {
                            return Err(journal::unavailable(
                                "The current subscription routing state is unavailable.",
                            )
                            .into());
                        }
                    };
                    if account.probe_required {
                        account = self
                            .authority()
                            .claim_probe(&account, None, self.now()?)
                            .await?
                            .ok_or_else(|| {
                                journal::unavailable("The current account probe is leased.")
                            })?;
                    }
                    let credential = self
                        .credential(
                            UpstreamProvider::ChatgptCodex,
                            &self.plan.model,
                            Some(account),
                        )
                        .await?;
                    (
                        UpstreamProvider::ChatgptCodex,
                        self.plan.model.clone(),
                        credential,
                        None,
                    )
                }
                RouteHop::Paid {
                    provider,
                    model,
                    synthetic,
                } => {
                    let upstream = if provider == PaidProvider::Surplus {
                        UpstreamProvider::Surplus
                    } else {
                        UpstreamProvider::Metered
                    };
                    let credential = self.credential(upstream, &model, None).await?;
                    // Local schema/credential failure cannot create paid exposure.
                    self.prepare(upstream, &model, &credential, "validation")?;
                    let key = self.input.context.key_id.clone().ok_or_else(|| {
                        GatewayError::new(
                            403,
                            "Paid inference requires an eligible stored API key.",
                            Some("paid_fallback_unavailable"),
                        )
                    })?;
                    let attempt_id = if synthetic {
                        gateway_providers::policy::paid_hop_identity(self.id(), provider)
                    } else {
                        format!(
                            "{}:paid:{}:{}",
                            self.id(),
                            if provider == PaidProvider::Surplus {
                                "surplus"
                            } else {
                                "metered"
                            },
                            self.tokens.next_token()?
                        )
                    };
                    let authorization = if synthetic {
                        PaidAuthorization::DirectPaidModel
                    } else {
                        self.paid_authorization(&row).await?
                    };
                    let input = PaidRequest {
                        key_id: key,
                        request_id: self.input.context.request_id.clone(),
                        attempt_id: PaidAttemptId(attempt_id),
                        provider,
                        model: model.clone(),
                        route: self.input.context.route.clone(),
                        path: if self.input.surface == ClientSurface::Chat {
                            "/v1/chat/completions"
                        } else {
                            "/v1/responses"
                        }
                        .into(),
                        stream: self.input.streamed(),
                        reasoning: self.input.requested_reasoning(),
                        created_at_ms: self.input.context.started_at_ms,
                    };
                    let context = self.paid_context(provider, synthetic)?;
                    let receipt = self
                        .authority()
                        .authorize_paid_route(&input, &context, self.now()?)
                        .await?;
                    let receipt = self
                        .authority()
                        .bind_paid_original_request(&receipt, &self.input.context, self.now()?)
                        .await?;
                    Self::check_paid_credential(credential.fence(), &receipt)?;
                    let reservation=match self.authority().reserve_paid(&input,&authorization,&receipt,self.now()?).await?{PaidAdmission::Reserved(r)=>r,PaidAdmission::Existing(_)=>return Err(journal::unavailable("A retained paid attempt cannot be redispatched without reconciliation.").into())};
                    (upstream, model, credential, Some(reservation))
                }
            };
            let id = self.tokens.next_token()?;
            let request = match self.prepare(provider, &model, &publication, &id) {
                Ok(request) => request,
                Err(error) => {
                    if let Some(paid) = &paid {
                        self.authority()
                            .release_paid_before_transport(paid, self.now()?)
                            .await?;
                    }
                    return Err(error);
                }
            };
            let attempt = AttemptRecord {
                id: id.clone(),
                provider,
                model,
                cursor: row.cursor,
                fence: publication.fence().clone(),
                paid: paid.clone(),
                phase: Phase::Prepared,
                transport_started: false,
                response_nonce: None,
                response_count: 0,
                workspace_nonce: None,
                workspace_continuations: 0,
                known_not_started: false,
                observation: None,
                provider_request_id: None,
                billing: None,
            };
            let changed = self
                .change(|j| {
                    settlement::ensure_active(j)?;
                    if j.cursor != row.cursor || j.active.is_some() {
                        return Err(journal::unavailable(
                            "Another provider attempt won admission.",
                        ));
                    }
                    j.active = Some(id.clone());
                    j.attempts.push(attempt.clone());
                    Ok(())
                })
                .await;
            if let Err(error) = changed {
                if let Some(paid) = &paid {
                    self.authority()
                        .release_paid_before_transport(paid, self.now()?)
                        .await?;
                }
                return Err(error.into());
            }
            self.admission.capture_attempt(attempt);
            return Ok(Some(PreparedAttempt {
                id,
                request,
                credential: publication.into_fence(),
                paid,
                original_request_id: self.id().into(),
            }));
        }
        Err(journal::unavailable("Provider/account selection did not settle.").into())
    }
}
