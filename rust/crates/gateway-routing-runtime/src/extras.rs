//! One original admission across source image children, Voyage chunks and SystemOne.
use crate::{
    journal::{self, Phase},
    session::RoutingSession,
    settlement,
    types::*,
};
use futures_util::lock::Mutex;
use gateway_authority::{Authority, AuthorityClock, TokenSource, quota::KernelTerminal};
use gateway_core::{
    GatewayError, lifecycle::TransportObservation, model::ModelId, provider::UpstreamProvider,
    query::QueryStore, source_json::SourceJson, source_serialization as source,
};
use serde::{Deserialize, Serialize};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ExtrasFamily {
    ImageGenerations,
    ImageEdits,
    Embeddings,
    EmbeddingJobCreate,
    EmbeddingJobPoll,
    SystemOne,
}
impl ExtrasFamily {
    fn provider(self) -> UpstreamProvider {
        match self {
            Self::ImageGenerations | Self::ImageEdits => UpstreamProvider::ChatgptCodex,
            Self::SystemOne => UpstreamProvider::Openrouter,
            _ => UpstreamProvider::Voyage,
        }
    }
    fn child_id(self, parent: &str, index: u32) -> String {
        match self {
            Self::ImageGenerations | Self::ImageEdits if index > 0 => format!(
                "{parent}:image:{}:{}",
                if self == Self::ImageGenerations {
                    "generations"
                } else {
                    "edits"
                },
                index + 1
            ),
            _ => parent.into(),
        }
    }
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ChildRecord {
    pub nonce: String,
    pub request_id: String,
    pub phase: Phase,
    pub transport_started: bool,
    pub known_not_started: bool,
    pub settled: bool,
    pub model_sibling_retries: u8,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ExtraDispatch {
    pub nonce: String,
    pub provider: UpstreamProvider,
    pub transport_started: bool,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct KernelIntent {
    pub terminal: KernelTerminal,
    pub reason: String,
}
#[derive(Clone, Debug)]
pub struct ChildScope {
    parent: String,
    nonce: String,
    request_id: String,
    index: u32,
    family: ExtrasFamily,
}
impl ChildScope {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn original_request_id(&self) -> &str {
        &self.parent
    }
    pub fn index(&self) -> u32 {
        self.index
    }
}
#[derive(Clone, Debug)]
pub struct DispatchTicket {
    parent: String,
    nonce: String,
    provider: UpstreamProvider,
}
#[derive(Clone, Debug)]
pub struct ImageChildAttempt {
    scope: ChildScope,
    pub request: gateway_providers::PreparedRequest,
    pub credential: CredentialFence,
}
impl ImageChildAttempt {
    pub fn child_scope(&self) -> &ChildScope {
        &self.scope
    }
}
#[derive(Clone)]
pub struct AdmissionHandle<S, I, C, H> {
    store: S,
    tokens: I,
    clock: C,
    host: H,
    parent: String,
    lock: Rc<Mutex<()>>,
    input: RoutingInput,
    source_collator: std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator>,
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost + Clone,
> RoutingSession<S, I, C, H>
{
    /// The router supplies the typed family after source request validation.
    pub async fn begin_extras(
        input: RoutingInput,
        store: S,
        host: H,
        clock: C,
        tokens: I,
        family: ExtrasFamily,
    ) -> RoutingResult<Self> {
        Self::initialize(input, store, host, clock, tokens, Some(family)).await
    }
    pub fn admission_handle(&self) -> AdmissionHandle<S, I, C, H> {
        AdmissionHandle {
            store: self.store.clone(),
            tokens: self.tokens.clone(),
            clock: self.clock.clone(),
            host: self.host.clone(),
            parent: self.id().into(),
            lock: self.extra_lock.clone(),
            input: self.input.clone(),
            source_collator: self.source_collator.clone(),
        }
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost + Clone,
> AdmissionHandle<S, I, C, H>
{
    fn authority(&self) -> Authority<S, I> {
        Authority::with_clock(self.store.clone(), self.tokens.clone(), self.clock.clone())
            .with_source_string_collator(self.source_collator.clone())
    }
    /// Source image child transport is Codex-only. It never obtains a paid
    /// authorization, performs admission again, or settles the outer kernel.
    pub async fn prepare_image_child(
        &self,
        child: &ChildScope,
        body: SourceJson,
    ) -> RoutingResult<ImageChildAttempt> {
        let (_, row) = journal::load(&self.store, &self.parent).await?;
        settlement::ensure_active(&row)?;
        let current = self.check(child, &row)?;
        if !matches!(
            child.family,
            ExtrasFamily::ImageGenerations | ExtrasFamily::ImageEdits
        ) || current.settled
        {
            return Err(
                journal::unavailable("This scope cannot prepare a Codex image child.").into(),
            );
        }
        let model = ModelId::from_source(gateway_schema::source_request::resolve_model(
            source::member(&body, "model").as_ref(),
            None,
        )?);
        crate::policy::validate_model(&self.input, &model, self.clock.now_ms()?)?;
        for _ in 0..3 {
            if self.host.cancelled() {
                return Err(self.host.cancellation_error().into());
            }
            let selection = self
                .authority()
                .select_account(&model, crate::policy::class(&model), self.clock.now_ms()?)
                .await?;
            let mut account = match selection {
                gateway_authority::routing::RouteSelection::Eligible(account) => account,
                gateway_authority::routing::RouteSelection::QuotaBlocked { proof, .. } => {
                    let recovery = if proof.full_cohort_exhausted() {
                        self.host.recover_codex(&proof, &model).await?
                    } else {
                        CodexRecovery::Declined
                    };
                    match recovery {
                        CodexRecovery::Recovered(account) => {
                            if account.requested_model != model
                                || account.quota_class != crate::policy::class(&model)
                                || account.probe_required
                                || account.probe.is_none()
                            {
                                return Err(journal::unavailable("The elected image recovery admission does not match this child.").into());
                            }
                            self.authority()
                                .ensure_admission_current(&account, self.clock.now_ms()?)
                                .await?;
                            account
                        }
                        CodexRecovery::Reselect => continue,
                        CodexRecovery::Declined => return Err(GatewayError::new(
                            429,
                            "Codex subscriptions have no applicable capacity for this image child.",
                            Some("codex_quota_blocked"),
                        )
                        .into()),
                    }
                }
                gateway_authority::routing::RouteSelection::CredentialsInvalid { .. } => {
                    return Err(GatewayError::new(
                        401,
                        "Codex subscription credentials are unavailable.",
                        Some("codex_subscriptions_unavailable"),
                    )
                    .into());
                }
                gateway_authority::routing::RouteSelection::ModelUnavailable { .. } => {
                    return Err(GatewayError::new(
                        404,
                        "The image child model is unavailable.",
                        Some("model_not_found"),
                    )
                    .into());
                }
                _ => {
                    return Err(
                        journal::unavailable("Codex image-child routing is unavailable.").into(),
                    );
                }
            };
            if account.probe_required {
                account = self
                    .authority()
                    .claim_probe(&account, None, self.clock.now_ms()?)
                    .await?
                    .ok_or_else(|| journal::unavailable("Image child probe is leased."))?;
            }
            let credential = self
                .host
                .credential(CredentialRequest {
                    provider: UpstreamProvider::ChatgptCodex,
                    model: model.clone(),
                    codex: Some(account.clone()),
                })
                .await?;
            if !matches!(credential.fence(),CredentialFence::Codex{admission,..}if admission==&account)
            {
                return Err(journal::unavailable(
                    "Image child credential does not match its admission.",
                )
                .into());
            }
            self.host
                .ensure_credential_current(credential.fence(), &self.input.principal, &model)
                .await?;
            let mut input = self.input.clone();
            input.raw = body.clone();
            input.surface = gateway_providers::ClientSurface::Responses;
            let request = crate::wire::prepare(
                &input,
                &child.nonce,
                self.clock.now_ms()?,
                UpstreamProvider::ChatgptCodex,
                &model,
                &credential,
                &child.nonce,
            )?;
            let crate::types::PreparedWireRequest::Ready(request) = request else {
                return Err(journal::unavailable(
                    "Image child credential does not match its admission.",
                )
                .into());
            };
            return Ok(ImageChildAttempt {
                scope: child.clone(),
                request,
                credential: credential.into_fence(),
            });
        }
        Err(journal::unavailable("Image child selection did not settle.").into())
    }
    pub async fn before_image_dispatch(
        &self,
        attempt: &ImageChildAttempt,
    ) -> RoutingResult<DispatchTicket> {
        let model = &attempt.request.decode.model;
        self.host
            .ensure_credential_current(&attempt.credential, &self.input.principal, model)
            .await?;
        let CredentialFence::Codex {
            admission,
            source_key,
            source_revision,
            ..
        } = &attempt.credential
        else {
            return Err(journal::unavailable("An image child cannot use another provider.").into());
        };
        self.authority()
            .ensure_admission_current(admission, self.clock.now_ms()?)
            .await?;
        let ticket = self.before_dispatch(&attempt.scope).await?;
        journal::change(
            &self.store,
            &self.tokens,
            &self.parent,
            self.clock.now_ms()?,
            &[RevisionCheckWire {
                key: source_key.clone(),
                expected_revision: Some(source_revision.clone()),
            }],
            |_| Ok(()),
        )
        .await?;
        self.host
            .ensure_credential_current(&attempt.credential, &self.input.principal, model)
            .await?;
        self.authority()
            .ensure_admission_current(admission, self.clock.now_ms()?)
            .await?;
        Ok(ticket)
    }
    pub async fn image_refusal(
        &self,
        attempt: &ImageChildAttempt,
        failure: AttemptFailure,
    ) -> RoutingResult<RefusalDecision> {
        let (_, row) = journal::load(&self.store, &self.parent).await?;
        settlement::ensure_active(&row)?;
        let current = self.check(&attempt.scope, &row)?;
        if current.settled
            || (current.transport_started && failure.transport == TransportState::NotStarted)
        {
            return Err(journal::unavailable(
                "Image refusal conflicts with its child transport state.",
            )
            .into());
        }
        if failure.cancelled
            || self.host.cancelled()
            || matches!(
                failure.failure,
                gateway_providers::policy::HopFailure::Cancelled
                    | gateway_providers::policy::HopFailure::Deadline
            )
        {
            return Ok(RefusalDecision::Abort);
        }
        if failure.semantic_committed {
            return Ok(RefusalDecision::Return);
        }
        let CredentialFence::Codex { admission, .. } = &attempt.credential else {
            return Err(
                journal::unavailable("Image refusal lacks a current Codex binding.").into(),
            );
        };
        let model = &attempt.request.decode.model;
        let mut retry = false;
        if let Some(block) = crate::classify::codex_quota(
            failure.status,
            &failure.headers,
            &failure.body,
            failure.body_complete,
            self.clock.now_ms()?,
        ) {
            retry = self
                .authority()
                .record_quota_block(admission, block, self.clock.now_ms()?)
                .await?;
        } else if failure.status == Some(401) {
            let version = admission.binding.credential_version.0.clone();
            let claimed = std::cell::Cell::new(false);
            journal::change(
                &self.store,
                &self.tokens,
                &self.parent,
                self.clock.now_ms()?,
                &[],
                |j| {
                    claimed.set(!j.refreshed_versions.contains(&version));
                    if claimed.get() {
                        j.refreshed_versions.push(version.clone());
                    }
                    Ok(())
                },
            )
            .await?;
            let published = claimed.get()
                && self.host.refresh_codex(&attempt.credential).await? == RefreshOutcome::Published;
            retry = published
                || self
                    .authority()
                    .mark_credential_invalid(admission, self.clock.now_ms()?)
                    .await?;
        } else if let Some(detail) = crate::classify::unsupported_model(
            failure.status,
            &failure.body,
            failure.body_complete,
            model,
        ) && self
            .authority()
            .learn_model_unavailable(admission, &detail, self.clock.now_ms()?)
            .await?
        {
            if current.model_sibling_retries >= 1 {
                return Err(crate::classify::model_unavailable_error(model).into());
            }
            journal::change(
                &self.store,
                &self.tokens,
                &self.parent,
                self.clock.now_ms()?,
                &[],
                |j| {
                    let child = j
                        .children
                        .get_mut(attempt.scope.index as usize)
                        .ok_or_else(|| journal::unavailable("Image child disappeared."))?;
                    child.model_sibling_retries += 1;
                    Ok(())
                },
            )
            .await?;
            retry = true;
        }
        Ok(if retry {
            RefusalDecision::Continue
        } else {
            RefusalDecision::Return
        })
    }
    async fn family(&self) -> Result<ExtrasFamily, GatewayError> {
        let (_, row) = journal::load(&self.store, &self.parent).await?;
        settlement::ensure_active(&row)?;
        row.extras_family.ok_or_else(|| {
            journal::unavailable("An extras scope requires the original typed route admission.")
        })
    }
    /// Register every logical image child before spawning, including children
    /// that a sibling cancellation may prevent from reaching transport.
    pub async fn children(&self, count: u32) -> RoutingResult<Vec<ChildScope>> {
        let _guard = self.lock.lock().await;
        let family = self.family().await?;
        if matches!(
            family,
            ExtrasFamily::ImageGenerations | ExtrasFamily::ImageEdits
        ) && count > 10
        {
            return Err(GatewayError::new(
                400,
                "Image child count must be1..10.",
                Some("invalid_request_error"),
            )
            .into());
        }
        if family == ExtrasFamily::SystemOne && count != 1 {
            return Err(journal::unavailable("SystemOne has one logical dispatch child.").into());
        }
        let (_, prior) = journal::load(&self.store, &self.parent).await?;
        let children = if let Some(existing) = prior.extras_child_count {
            if existing != count {
                return Err(journal::unavailable(
                    "The original extras plan already has another child count.",
                )
                .into());
            }
            prior.children
        } else {
            let children = (0..count)
                .map(|index| {
                    Ok(ChildRecord {
                        nonce: self.tokens.next_token()?,
                        request_id: family.child_id(&self.parent, index),
                        phase: Phase::Prepared,
                        transport_started: false,
                        known_not_started: false,
                        settled: false,
                        model_sibling_retries: 0,
                    })
                })
                .collect::<Result<Vec<_>, GatewayError>>()?;
            journal::change(
                &self.store,
                &self.tokens,
                &self.parent,
                self.clock.now_ms()?,
                &[],
                |j| {
                    settlement::ensure_active(j)?;
                    if j.extras_child_count.is_some() {
                        return Err(journal::unavailable("Another child plan was published."));
                    }
                    j.extras_child_count = Some(count);
                    j.children = children.clone();
                    Ok(())
                },
            )
            .await?;
            children
        };
        Ok(children
            .into_iter()
            .enumerate()
            .map(|(index, child)| ChildScope {
                parent: self.parent.clone(),
                nonce: child.nonce,
                request_id: child.request_id,
                index: index as u32,
                family,
            })
            .collect())
    }
    fn check<'a>(
        &self,
        child: &ChildScope,
        row: &'a journal::Journal,
    ) -> Result<&'a ChildRecord, GatewayError> {
        if child.parent != self.parent || row.extras_family != Some(child.family) {
            return Err(journal::unavailable(
                "Extras child belongs to another original admission.",
            ));
        }
        row.children
            .get(child.index as usize)
            .filter(|r| r.nonce == child.nonce && r.request_id == child.request_id)
            .ok_or_else(|| journal::unavailable("Extras child identity is not registered."))
    }
    /// Single-flight local request guard; it never spans provider I/O. Every
    /// child receives the one original source provider-dispatch capability.
    pub async fn before_dispatch(&self, child: &ChildScope) -> RoutingResult<DispatchTicket> {
        let _guard = self.lock.lock().await;
        if self.host.cancelled() {
            return Err(self.host.cancellation_error().into());
        }
        let (_, row) = journal::load(&self.store, &self.parent).await?;
        settlement::ensure_active(&row)?;
        let current = self.check(child, &row)?;
        if current.settled {
            return Err(journal::unavailable("A settled child cannot dispatch again.").into());
        }
        let dispatch = if let Some(dispatch) = row.extras_dispatch {
            dispatch
        } else {
            let mut api = row.api.clone();
            if let Some(reservation) = &api {
                api = Some(
                    self.authority()
                        .resolve_deferred_api(reservation, self.clock.now_ms()?)
                        .await?,
                );
            }
            if let Some(api) = &api {
                self.authority()
                    .dispatch_api_key(api, child.family.provider(), self.clock.now_ms()?)
                    .await?;
            }
            let dispatch = ExtraDispatch {
                nonce: self.tokens.next_token()?,
                provider: child.family.provider(),
                transport_started: false,
            };
            journal::change(
                &self.store,
                &self.tokens,
                &self.parent,
                self.clock.now_ms()?,
                &[],
                |j| {
                    settlement::ensure_active(j)?;
                    if j.extras_dispatch.is_some() {
                        return Err(journal::unavailable("The original dispatch guard changed."));
                    }
                    j.api = api.clone();
                    j.extras_dispatch = Some(dispatch.clone());
                    Ok(())
                },
            )
            .await?;
            dispatch
        };
        journal::change(
            &self.store,
            &self.tokens,
            &self.parent,
            self.clock.now_ms()?,
            &[],
            |j| {
                let target = j
                    .children
                    .get_mut(child.index as usize)
                    .filter(|c| c.nonce == child.nonce && !c.settled)
                    .ok_or_else(|| {
                        journal::unavailable("Extras child is no longer dispatchable.")
                    })?;
                target.phase = Phase::Intent;
                Ok(())
            },
        )
        .await?;
        Ok(DispatchTicket {
            parent: self.parent.clone(),
            nonce: dispatch.nonce,
            provider: dispatch.provider,
        })
    }
    pub async fn transport_started(
        &self,
        child: &ChildScope,
        ticket: &DispatchTicket,
    ) -> RoutingResult<()> {
        let _guard = self.lock.lock().await;
        let (_, row) = journal::load(&self.store, &self.parent).await?;
        settlement::ensure_active(&row)?;
        let current = self.check(child, &row)?;
        if current.settled
            || !matches!(current.phase, Phase::Intent | Phase::Started)
            || ticket.parent != self.parent
            || row
                .extras_dispatch
                .as_ref()
                .is_none_or(|d| d.nonce != ticket.nonce || d.provider != ticket.provider)
        {
            return Err(journal::unavailable(
                "Child transport has no matching original dispatch capability.",
            )
            .into());
        }
        if let Some(api) = &row.api {
            self.authority()
                .mark_api_transport_started(api, self.clock.now_ms()?)
                .await?;
        }
        journal::change(
            &self.store,
            &self.tokens,
            &self.parent,
            self.clock.now_ms()?,
            &[],
            |j| {
                let target = j
                    .children
                    .get_mut(child.index as usize)
                    .filter(|c| c.nonce == child.nonce && !c.settled)
                    .ok_or_else(|| journal::unavailable("Child transport identity changed."))?;
                target.phase = Phase::Started;
                target.transport_started = true;
                if let Some(dispatch) = j.extras_dispatch.as_mut() {
                    dispatch.transport_started = true;
                }
                Ok(())
            },
        )
        .await?;
        Ok(())
    }
    /// A child terminal never settles the original kernel or refunds a sibling.
    pub async fn child_finished(
        &self,
        child: &ChildScope,
        transport: TransportState,
    ) -> RoutingResult<()> {
        let _guard = self.lock.lock().await;
        let (_, row) = journal::load(&self.store, &self.parent).await?;
        let current = self.check(child, &row)?;
        if current.transport_started && transport == TransportState::NotStarted {
            return Err(journal::unavailable("A started sibling cannot become NotStarted.").into());
        }
        if transport == TransportState::Started && !current.transport_started {
            return Err(journal::unavailable(
                "Real child transport must publish its original dispatch ticket first.",
            )
            .into());
        }
        journal::change(
            &self.store,
            &self.tokens,
            &self.parent,
            self.clock.now_ms()?,
            &[],
            |j| {
                let target = j
                    .children
                    .get_mut(child.index as usize)
                    .filter(|c| c.nonce == child.nonce)
                    .ok_or_else(|| journal::unavailable("Child identity changed."))?;
                target.settled = true;
                target.known_not_started = transport == TransportState::NotStarted;
                target.phase = Phase::Terminal;
                Ok(())
            },
        )
        .await?;
        Ok(())
    }
    pub async fn finish(
        &self,
        observation: TransportObservation,
        kernel: KernelTerminal,
        reason: &str,
    ) -> RoutingResult<RecoveredSession> {
        let _guard = self.lock.lock().await;
        if reason.trim().is_empty() {
            return Err(journal::unavailable(
                "An extras kernel disposition needs its source reason.",
            )
            .into());
        }
        let (_, row) = journal::load(&self.store, &self.parent).await?;
        if !row.finished
            && (row.extras_child_count.is_none() || row.children.iter().any(|c| !c.settled))
        {
            return Err(journal::unavailable(
                "All logical children must settle before original finalization.",
            )
            .into());
        }
        if row.extras_family == Some(ExtrasFamily::EmbeddingJobPoll)
            && kernel != KernelTerminal::Released
        {
            return Err(journal::unavailable(
                "Embedding job reads never count as a completed kernel request.",
            )
            .into());
        }
        if row.extras_child_count == Some(0) && kernel != KernelTerminal::Released {
            return Err(journal::unavailable(
                "An empty source child plan cannot commit kernel usage.",
            )
            .into());
        }
        let intent = KernelIntent {
            terminal: kernel,
            reason: reason.into(),
        };
        journal::change(
            &self.store,
            &self.tokens,
            &self.parent,
            self.clock.now_ms()?,
            &[],
            |j| {
                if j.kernel_override
                    .as_ref()
                    .is_some_and(|prior| prior != &intent)
                {
                    return Err(journal::unavailable(
                        "Extras kernel intent conflicts with its original outcome.",
                    ));
                }
                j.kernel_override = Some(intent.clone());
                Ok(())
            },
        )
        .await?;
        Ok(settlement::finish_record(
            &self.store,
            &self.tokens,
            &self.clock,
            &self.host,
            &self.parent,
            observation,
        )
        .await?)
    }
}
