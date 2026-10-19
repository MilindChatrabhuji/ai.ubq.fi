//! One original admission before local work; no provider plan or attempt is invented.
use crate::{
    journal::{self, Journal},
    policy::RoutePlan,
    session::{RoutingSession, reserve_original},
    types::{RecoveredSession, RevisionCheckWire, RoutingHost, RoutingResult},
};
use gateway_auth::{AuthPrincipal, crypto::sha256_hex};
use gateway_authority::{
    Authority, AuthorityClock, TokenSource, keys,
    quota::{ApiReservation, ApiUsageRequest, ApiUsageState, KernelReservation, KernelTerminal},
};
use gateway_core::{
    GatewayError,
    identity::{MAX_SAFE_INTEGER, RequestContext},
    lifecycle::TransportObservation,
    local_work::{
        LocalSemanticOutcome, LocalTerminalObservation, LocalWorkKind, LocalWorkPhase,
        LocalWorkRecord, SOURCE_REQUEST_BINDING_DOMAIN, SOURCE_REQUEST_BINDING_VERSION,
    },
    query::QueryStore,
    source_json::SourceJson,
    state::{AuthorityStore, StoredRecord},
};
use gateway_schema::{catalog::CatalogInput, source_request::SourceRequestDocument};

#[path = "local_completion_runtime.rs"]
mod completion;
#[path = "local_coordination.rs"]
mod coordination;
pub use completion::{
    BuiltLocalResponse, LocalAccountingProgress, LocalCompletionAdvance, LocalCompletionChoice,
    LocalCompletionRefusal, LocalObservationSink, LocalSelectedResponse, LocalWireDecision,
    LocalWireKind, PendingLocalCompletion,
};

/// Existing request metadata only. No caller supplies a replacement normalized body.
pub struct LocalRequestMetadata {
    pub context: RequestContext,
    pub principal: AuthPrincipal,
    pub catalog: CatalogInput,
    pub runtime: Option<SourceJson>,
    pub client_version: String,
    pub native_session_id: Option<String>,
    pub retry_prohibited: bool,
}
pub struct LocalAdmissionInput {
    pub metadata: LocalRequestMetadata,
    pub original: SourceRequestDocument,
}

pub struct LocalWorkHandle<S, I, C, H> {
    pub(crate) store: S,
    pub(crate) tokens: I,
    pub(crate) clock: C,
    pub(crate) host: H,
    pub(crate) input: LocalAdmissionInput,
    pub(crate) digest: String,
    pub(crate) nonce: String,
    api: Option<ApiReservation>,
    kernel: Option<KernelReservation>,
}
/// Only a future source-aware RoutingSession factory can consume this admission.
/// Planning grants no provider, paid or dispatch permission.
pub struct LocalProviderAdmission<S, I, C, H> {
    pub(crate) original: LocalWorkHandle<S, I, C, H>,
}
/// Sealed owned inputs for the genuine source-aware session constructor only.
/// These are not a public plan, body replacement or another admission.
pub(crate) struct LocalProviderParts<S, I, C, H> {
    pub(crate) admission: crate::currentness::OriginalRoutingAdmission,
    pub(crate) store: S,
    pub(crate) tokens: I,
    pub(crate) clock: C,
    pub(crate) host: H,
    pub(crate) input: LocalAdmissionInput,
    pub(crate) plan: RoutePlan,
}
pub struct LocalDeliveryHandle<S, I, C, H> {
    completed: bool,
    original: Box<LocalWorkHandle<S, I, C, H>>,
}
pub struct LocalWorkCurrentness<'a, S, I, C, H> {
    original: &'a LocalWorkHandle<S, I, C, H>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LocalWorkLease {
    observed_at_ms: i64,
    // Request-journal coordination only; never a caller or API/kernel deadline.
    request_expires_at_ms: i64,
    kernel_expires_at_ms: Option<i64>,
}
impl LocalWorkLease {
    pub fn observed_at_ms(&self) -> i64 {
        self.observed_at_ms
    }
    /// Actual journal coordination expiry, not a source client-abort deadline.
    pub fn request_expires_at_ms(&self) -> i64 {
        self.request_expires_at_ms
    }
    pub fn kernel_expires_at_ms(&self) -> Option<i64> {
        self.kernel_expires_at_ms
    }
}
pub const KERNEL_RENEWAL_INTERVAL_MS: i64 = 60_000;

/// Binding v2 deliberately does not change any legacy ordinary v1 digest.
pub fn original_source_digest(original: &SourceJson) -> Result<String, GatewayError> {
    let canonical = gateway_core::source_serialization::canonical(original)?;
    let mut bytes = SOURCE_REQUEST_BINDING_DOMAIN.to_vec();
    bytes.extend_from_slice(canonical.as_bytes());
    Ok(sha256_hex(&bytes))
}
fn invalid() -> GatewayError {
    journal::unavailable("Local original admission is no longer current.")
}
fn same_kernel(left: &KernelReservation, right: &KernelReservation) -> bool {
    let mut observed = left.clone();
    observed.lease_expires_at_ms = right.lease_expires_at_ms;
    observed == *right
}
fn row_value<T: serde::de::DeserializeOwned>(row: &StoredRecord) -> Result<T, GatewayError> {
    serde_json::from_value(row.json_value()?.clone()).map_err(|_| invalid())
}

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> RoutingSession<S, I, C, H>
{
    pub async fn begin_local_compaction(
        input: LocalAdmissionInput,
        store: S,
        host: H,
        clock: C,
        tokens: I,
    ) -> RoutingResult<LocalWorkHandle<S, I, C, H>> {
        if host.cancelled() {
            return Err(host.cancellation_error().into());
        }
        let now = clock.now_ms()?;
        let context = &input.metadata.context;
        let expected_key = match &input.metadata.principal.method {
            gateway_auth::AuthMethod::KvApiKey { key_id, .. } => Some(key_id.as_str()),
            _ => None,
        };
        if !(0..=MAX_SAFE_INTEGER).contains(&now)
            || context.started_at_ms < 0
            || now < context.started_at_ms
            || context.request_id.0.trim().is_empty()
            || context.principal.0.trim().is_empty()
            || context.route.trim().is_empty()
            || context.key_id.as_ref().map(|v| v.0.as_str()) != expected_key
        {
            return Err(invalid().into());
        }
        let digest = original_source_digest(input.original.original_source())?;
        let nonce = tokens.next_token()?;
        let local = LocalWorkRecord {
            kind: LocalWorkKind::CodexResponsesCompaction,
            owner_nonce: nonce.clone(),
            binding_version: SOURCE_REQUEST_BINDING_VERSION,
            phase: LocalWorkPhase::Admitting,
            terminal: None,
        };
        let mut row = Journal {
            v: 2,
            context: context.clone(),
            input_digest: digest.clone(),
            api: None,
            kernel: None,
            cursor: 0,
            attempts: vec![],
            active: None,
            model_sibling_retries: 0,
            refreshed_versions: vec![],
            recovery_attempted: false,
            claude_unavailable: false,
            semantic_committed: false,
            terminal_intent: None,
            finished: false,
            recovering: false,
            lease_expires_at_ms: now
                .checked_add(gateway_authority::REQUEST_LEASE_MS)
                .ok_or_else(invalid)?,
            updated_at_ms: now,
            extras_family: None,
            extras_child_count: None,
            extras_dispatch: None,
            children: vec![],
            kernel_override: None,
            local_work: Some(local),
        };
        journal::create(&store, &tokens, &row).await?;
        let admitted = reserve_original(
            &input.metadata.principal,
            context,
            &mut row,
            &store,
            &tokens,
            &clock,
        )
        .await;
        if let Err(error) = admitted {
            // A reservation may succeed before its journal binding write fails.
            // Settle the actual returned ownership as well as the durable prefix.
            let authority = Authority::with_clock(store.clone(), tokens.clone(), clock.clone());
            if let Some(api) = &row.api {
                authority
                    .release_api_key(api, true, "local_admission_failed", clock.now_ms()?)
                    .await?;
            }
            if let Some(kernel) = &row.kernel {
                authority
                    .settle_kernel(
                        kernel,
                        KernelTerminal::Released,
                        "local_admission_failed",
                        clock.now_ms()?,
                    )
                    .await?;
            }
            finish_local_record(
                &store,
                &tokens,
                &clock,
                &context.request_id.0,
                LocalTerminalObservation {
                    semantic: LocalSemanticOutcome::Incomplete,
                    reader_termination: None,
                    body: None,
                    delivery: gateway_core::lifecycle::DeliveryOutcome::Unobserved,
                },
                Some(completion::OriginalBinding {
                    context,
                    nonce: &nonce,
                    digest: &digest,
                    api: &row.api,
                    kernel: &row.kernel,
                    allow_unbound_admission: true,
                    api_release_done: false,
                }),
            )
            .await?;
            return Err(error.into());
        }
        let handle = LocalWorkHandle {
            store,
            tokens,
            clock,
            host,
            input,
            digest,
            nonce,
            api: row.api,
            kernel: row.kernel,
        };
        handle
            .transition(LocalWorkPhase::Admitting, LocalWorkPhase::Running)
            .await?;
        if let Err(error) = handle.checkpoint().await {
            finish_local_record(
                &handle.store,
                &handle.tokens,
                &handle.clock,
                handle.id(),
                LocalTerminalObservation {
                    semantic: LocalSemanticOutcome::Cancelled,
                    reader_termination: None,
                    body: None,
                    delivery: gateway_core::lifecycle::DeliveryOutcome::Unobserved,
                },
                Some(completion::binding(&handle)),
            )
            .await?;
            return Err(error);
        }
        Ok(handle)
    }
}

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalWorkHandle<S, I, C, H>
{
    fn id(&self) -> &str {
        &self.input.metadata.context.request_id.0
    }
    fn now(&self) -> Result<i64, GatewayError> {
        let now = self.clock.now_ms()?;
        if now < self.input.metadata.context.started_at_ms || now > MAX_SAFE_INTEGER {
            return Err(invalid());
        }
        Ok(now)
    }
    fn owned(&self, row: &Journal) -> Result<(), GatewayError> {
        if row.v != 2
            || row.context != self.input.metadata.context
            || row.input_digest != self.digest
            || row.finished
            || row.recovering
            || row.terminal_intent.is_some()
            || row.api != self.api
            || match (&row.kernel, &self.kernel) {
                (Some(a), Some(b)) => !same_kernel(a, b),
                (None, None) => false,
                _ => true,
            }
            || row
                .local_work
                .as_ref()
                .is_none_or(|local| local.owner_nonce != self.nonce)
        {
            return Err(invalid());
        }
        Ok(())
    }
    async fn transition(&self, from: LocalWorkPhase, to: LocalWorkPhase) -> RoutingResult<()> {
        let now = self.now()?;
        journal::change(&self.store, &self.tokens, self.id(), now, &[], |row| {
            self.owned(row)?;
            if row.lease_expires_at_ms <= now {
                return Err(invalid());
            }
            let local = row.local_work.as_mut().ok_or_else(invalid)?;
            if local.phase != from {
                return Err(invalid());
            }
            local.phase = to;
            Ok(())
        })
        .await?;
        Ok(())
    }
    pub fn original_source(&self) -> &SourceJson {
        self.input.original.original_source()
    }
    pub fn original_context(&self) -> &RequestContext {
        &self.input.metadata.context
    }
    pub fn currentness(&self) -> LocalWorkCurrentness<'_, S, I, C, H> {
        LocalWorkCurrentness { original: self }
    }

    pub async fn checkpoint(&self) -> RoutingResult<LocalWorkLease> {
        self.checkpoint_phase(
            &[LocalWorkPhase::Running, LocalWorkPhase::ResponsePending],
            None,
            false,
        )
        .await
    }
    async fn checkpoint_phase(
        &self,
        phases: &[LocalWorkPhase],
        next: Option<LocalWorkPhase>,
        refresh_coordination: bool,
    ) -> RoutingResult<LocalWorkLease> {
        if refresh_coordination && self.kernel.is_some() {
            return Err(invalid().into());
        }
        if self.host.cancelled() {
            return Err(self.host.cancellation_error().into());
        }
        let now = self.now()?;
        let (record, row) = journal::load(&self.store, self.id()).await?;
        self.owned(&row)?;
        if row.lease_expires_at_ms <= now
            || row
                .local_work
                .as_ref()
                .is_none_or(|local| !phases.contains(&local.phase))
        {
            return Err(invalid().into());
        }
        let mut checks = vec![RevisionCheckWire {
            key: journal::key(self.id()),
            expected_revision: Some(record.revision),
        }];
        let mut api_expires = None;
        if let Some(api) = &self.api {
            let key = keys::api_request(
                &api.key_id.0,
                &api.policy_version,
                api.window_start_ms,
                &api.request_id.0,
            );
            let record = self.store.read(&key).await?;
            if let Some(record) = &record {
                let actual: ApiUsageRequest = row_value(record)?;
                if actual.validate().is_err()
                    || actual.key_id != api.key_id
                    || actual.request_id != api.request_id
                    || actual.route != api.route
                    || actual.state != ApiUsageState::Reserved
                    || actual.transport_started
                    || actual.lease_expires_at_ms <= now
                {
                    return Err(invalid().into());
                }
                api_expires = Some(actual.lease_expires_at_ms);
            } else if !api.deferred {
                return Err(invalid().into());
            }
            checks.push(RevisionCheckWire {
                key,
                expected_revision: record.map(|r| r.revision),
            });
        }
        let mut kernel_expires = None;
        if let Some(kernel) = &self.kernel {
            let key = keys::kernel_request(
                &kernel.owner,
                kernel.repo.as_deref(),
                kernel.window_created_at_ms,
                &kernel.request_id.0,
            );
            let record = self.store.read(&key).await?.ok_or_else(invalid)?;
            let actual: KernelReservation = row_value(&record)?;
            if actual.validate().is_err()
                || !same_kernel(&actual, kernel)
                || actual.state.is_some()
                || actual.terminal_intent.is_some()
                || actual.lease_expires_at_ms <= now
            {
                return Err(invalid().into());
            }
            kernel_expires = Some(actual.lease_expires_at_ms);
            checks.push(RevisionCheckWire {
                key,
                expected_revision: Some(record.revision),
            });
        }
        let at = self.now()?;
        if api_expires.is_some_and(|expiry| expiry <= at)
            || kernel_expires.is_some_and(|expiry| expiry <= at)
        {
            return Err(invalid().into());
        }
        let current = journal::change(
            &self.store,
            &self.tokens,
            self.id(),
            at,
            &checks,
            |current| {
                self.owned(current)?;
                if current.local_work.as_ref().map(|v| v.phase)
                    != row.local_work.as_ref().map(|v| v.phase)
                    || current.lease_expires_at_ms <= at
                {
                    return Err(invalid());
                }
                if refresh_coordination {
                    current.lease_expires_at_ms = at
                        .checked_add(gateway_authority::REQUEST_LEASE_MS)
                        .ok_or_else(invalid)?;
                }
                if let Some(next) = next {
                    current.local_work.as_mut().ok_or_else(invalid)?.phase = next;
                }
                Ok(())
            },
        )
        .await?;
        if self.host.cancelled() {
            return Err(self.host.cancellation_error().into());
        }
        let finished_at = self.now()?;
        if current.lease_expires_at_ms <= finished_at
            || api_expires.is_some_and(|expiry| expiry <= finished_at)
            || kernel_expires.is_some_and(|expiry| expiry <= finished_at)
        {
            return Err(invalid().into());
        }
        Ok(LocalWorkLease {
            observed_at_ms: finished_at,
            request_expires_at_ms: current.lease_expires_at_ms,
            kernel_expires_at_ms: kernel_expires,
        })
    }
    pub async fn resume_original(self) -> RoutingResult<LocalProviderAdmission<S, I, C, H>> {
        if let Err(error) = self
            .checkpoint_phase(
                &[LocalWorkPhase::Running],
                Some(LocalWorkPhase::Planning),
                false,
            )
            .await
        {
            finish_local_record(
                &self.store,
                &self.tokens,
                &self.clock,
                self.id(),
                LocalTerminalObservation {
                    semantic: LocalSemanticOutcome::Cancelled,
                    reader_termination: None,
                    body: None,
                    delivery: gateway_core::lifecycle::DeliveryOutcome::Unobserved,
                },
                Some(completion::binding(&self)),
            )
            .await?;
            return Err(error);
        }
        Ok(LocalProviderAdmission { original: self })
    }
    pub async fn begin_local_response(self) -> RoutingResult<LocalDeliveryHandle<S, I, C, H>> {
        if let Err(error) = self
            .checkpoint_phase(
                &[LocalWorkPhase::Running],
                Some(LocalWorkPhase::ResponsePending),
                false,
            )
            .await
        {
            finish_local_record(
                &self.store,
                &self.tokens,
                &self.clock,
                self.id(),
                LocalTerminalObservation {
                    semantic: LocalSemanticOutcome::Cancelled,
                    reader_termination: None,
                    body: None,
                    delivery: gateway_core::lifecycle::DeliveryOutcome::Unobserved,
                },
                Some(completion::binding(&self)),
            )
            .await?;
            return Err(error);
        }
        Ok(LocalDeliveryHandle {
            original: Box::new(self),
            completed: false,
        })
    }
}

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalWorkCurrentness<'_, S, I, C, H>
{
    pub async fn checkpoint(&self) -> RoutingResult<LocalWorkLease> {
        self.original.checkpoint().await
    }
    pub async fn renew_kernel(&self) -> RoutingResult<LocalWorkLease> {
        self.original.renew_kernel().await
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalProviderAdmission<S, I, C, H>
{
    pub fn original_source(&self) -> &SourceJson {
        self.original.original_source()
    }
    pub fn original_context(&self) -> &RequestContext {
        self.original.original_context()
    }
    pub(crate) fn original_metadata(&self) -> &LocalRequestMetadata {
        &self.original.input.metadata
    }
    /// Only M05's real source factory may pass its actual source-derived plan.
    pub(crate) async fn attest_plan(
        self,
        plan: RoutePlan,
    ) -> RoutingResult<LocalProviderParts<S, I, C, H>> {
        self.original
            .checkpoint_phase(
                &[LocalWorkPhase::Planning],
                Some(LocalWorkPhase::ProviderPlanned),
                false,
            )
            .await?;
        let LocalWorkHandle {
            store,
            tokens,
            clock,
            host,
            input,
            digest,
            nonce,
            api,
            kernel,
        } = self.original;
        Ok(LocalProviderParts {
            admission: crate::currentness::OriginalRoutingAdmission::capture(
                2,
                digest,
                api,
                kernel,
                Some(nonce),
            ),
            store,
            tokens,
            clock,
            host,
            input,
            plan,
        })
    }
    pub(crate) async fn fail_planning(self) -> RoutingResult<RecoveredSession> {
        let original = self.original;
        let observed = LocalTerminalObservation {
            semantic: LocalSemanticOutcome::Incomplete,
            reader_termination: None,
            body: None,
            delivery: gateway_core::lifecycle::DeliveryOutcome::Unobserved,
        };
        journal::change(
            &original.store,
            &original.tokens,
            original.id(),
            original.now()?,
            &[],
            |row| {
                original.owned(row)?;
                let local = row.local_work.as_mut().ok_or_else(invalid)?;
                if local.phase != LocalWorkPhase::Planning {
                    return Err(invalid());
                }
                local.phase = LocalWorkPhase::TerminalPending;
                local.terminal = Some(observed);
                Ok(())
            },
        )
        .await?;
        Ok(finish_local_record(
            &original.store,
            &original.tokens,
            &original.clock,
            original.id(),
            observed,
            Some(completion::binding(&original)),
        )
        .await?)
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalDeliveryHandle<S, I, C, H>
{
    pub fn currentness(&self) -> LocalWorkCurrentness<'_, S, I, C, H> {
        self.original.currentness()
    }
    pub async fn finish(
        mut self,
        observation: LocalTerminalObservation,
    ) -> RoutingResult<RecoveredSession> {
        if self.completed {
            if observation.semantic != LocalSemanticOutcome::Completed {
                return Err(invalid().into());
            }
            return self
                .finish_delivery(
                    observation.reader_termination,
                    observation.body,
                    observation.delivery,
                )
                .await;
        }
        if observation.semantic == LocalSemanticOutcome::Completed {
            return Err(invalid().into());
        }
        let now = self.original.now()?;
        journal::change(
            &self.original.store,
            &self.original.tokens,
            self.original.id(),
            now,
            &[],
            |row| {
                self.original.owned(row)?;
                if row.local_work.as_ref().map(|v| v.phase) != Some(LocalWorkPhase::ResponsePending)
                {
                    return Err(invalid());
                }
                Ok(())
            },
        )
        .await?;
        Ok(finish_local_record(
            &self.original.store,
            &self.original.tokens,
            &self.original.clock,
            self.original.id(),
            observation,
            Some(completion::binding(&self.original)),
        )
        .await?)
    }
}

/// Data-only event recovery/finalization; never reconstructs source, handles or I/O.
pub(crate) async fn finish_local_record<
    S: AuthorityStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
>(
    store: &S,
    tokens: &I,
    clock: &C,
    id: &str,
    observation: LocalTerminalObservation,
    expected: Option<completion::OriginalBinding<'_>>,
) -> Result<RecoveredSession, GatewayError> {
    let (_, old) = journal::load(store, id).await?;
    let local = old.local_work.as_ref().ok_or_else(invalid)?;
    if expected
        .as_ref()
        .is_some_and(|binding| !binding.matches(&old))
    {
        return Err(invalid());
    }
    let context = old.context.clone();
    let digest = old.input_digest.clone();
    let nonce = local.owner_nonce.clone();
    if local.phase == LocalWorkPhase::ProviderPlanned {
        return Err(invalid());
    }
    let observation = completion::merge_observation(local.terminal, observation)?;
    if old.finished {
        return completion::refine_finished_record(store, tokens, clock, id, &old, observation)
            .await;
    }
    let intent = journal::change(store, tokens, id, clock.now_ms()?, &[], |row| {
        if expected
            .as_ref()
            .is_some_and(|binding| !binding.matches(row))
            || row.context != context
            || row.input_digest != digest
            || row
                .local_work
                .as_ref()
                .is_none_or(|v| v.owner_nonce != nonce)
            || row.api != old.api
            || match (&row.kernel, &old.kernel) {
                (Some(a), Some(b)) => !same_kernel(a, b),
                (None, None) => false,
                _ => true,
            }
        {
            return Err(invalid());
        }
        let local = row.local_work.as_mut().ok_or_else(invalid)?;
        if local.phase == LocalWorkPhase::ProviderPlanned {
            return Err(invalid());
        }
        local.terminal = Some(completion::merge_observation(local.terminal, observation)?);
        local.phase = LocalWorkPhase::TerminalPending;
        Ok(())
    })
    .await?;
    let observation = intent
        .local_work
        .as_ref()
        .and_then(|local| local.terminal)
        .ok_or_else(invalid)?;
    if intent.finished {
        return completion::refine_finished_record(store, tokens, clock, id, &intent, observation)
            .await;
    }
    let authority = Authority::with_clock(store.clone(), tokens.clone(), clock.clone());
    if let Some(api) = &intent.api
        && expected
            .as_ref()
            .is_none_or(|binding| !binding.api_release_done)
    {
        authority
            .release_api_key(
                api,
                false,
                "local_work_without_provider_dispatch",
                clock.now_ms()?,
            )
            .await?;
    }
    if let Some(kernel) = &intent.kernel {
        let terminal = if observation.semantic == LocalSemanticOutcome::Completed {
            KernelTerminal::Committed
        } else {
            KernelTerminal::Released
        };
        authority
            .record_kernel_terminal_intent(kernel, terminal, clock.now_ms()?)
            .await?;
        authority
            .settle_kernel(kernel, terminal, "local_work_terminal", clock.now_ms()?)
            .await?;
    }
    journal::change(store, tokens, id, clock.now_ms()?, &[], |row| {
        let local = row.local_work.as_mut().ok_or_else(invalid)?;
        if row.context != context
            || row.input_digest != digest
            || local.owner_nonce != nonce
            || !matches!(
                local.phase,
                LocalWorkPhase::TerminalPending | LocalWorkPhase::Terminal
            )
            || local.terminal != Some(observation)
        {
            return Err(invalid());
        }
        local.phase = LocalWorkPhase::Terminal;
        row.finished = true;
        Ok(())
    })
    .await?;
    Ok(RecoveredSession {
        request_id: id.into(),
        observation: local_transport(observation),
        settled: true,
    })
}
fn local_transport(observation: LocalTerminalObservation) -> TransportObservation {
    TransportObservation {
        semantic_terminal: None,
        reader_termination: observation.reader_termination,
        body: observation.body,
        delivery: observation.delivery,
    }
}

#[cfg(test)]
mod factory_tests {
    mod support {
        use crate as gateway_routing_runtime;
        include!("../tests/support/mod.rs");
    }
    use super::*;
    use std::sync::{Arc, Mutex};
    use support::*;

    fn admission<I: TokenSource + Clone>(
        store: &Store,
        tokens: I,
    ) -> (LocalProviderAdmission<Store, I, Store, Host>, RoutePlan) {
        seed_key(store);
        seed_pool(store);
        let fixture = input("factory-owner", "gpt-test", &[]);
        // This matching scalar source fixture exercises the real existing planner;
        // it is not a product Value adapter or acceptance of the pending M05 factory.
        let source = SourceJson::parse(&serde_json::to_string(&fixture.raw).unwrap()).unwrap();
        let collator = Host::new(store).source_string_collator();
        let plan = crate::policy::plan(&fixture, NOW, collator.as_ref()).unwrap();
        let local = run(RoutingSession::begin_local_compaction(
            LocalAdmissionInput {
                metadata: LocalRequestMetadata {
                    context: fixture.context,
                    principal: fixture.principal,
                    catalog: fixture.catalog,
                    runtime: fixture.runtime,
                    client_version: fixture.client_version,
                    native_session_id: fixture.native_session_id,
                    retry_prohibited: fixture.retry_prohibited,
                },
                original: SourceRequestDocument::new(source).unwrap(),
            },
            store.clone(),
            Host::new(store),
            store.clone(),
            tokens,
        ))
        .unwrap();
        (run(local.resume_original()).unwrap(), plan)
    }

    #[test]
    fn attest_retains_original_constructor_inputs_and_one_admission() {
        let store = Store::new();
        let (admission, plan) = admission(&store, store.clone());
        let before = store.value(journal::key("factory-owner"));
        let pool = store.value(source_key());
        let original = admission.original_source().clone();
        assert_eq!(
            admission.original_metadata().context,
            admission.original_context().clone()
        );
        let parts = run(admission.attest_plan(plan)).unwrap();
        assert_eq!(parts.input.original.original_source(), &original);
        assert!(parts.plan.model.matches_scalar("gpt-test"));
        let after = parts.store.value(journal::key("factory-owner"));
        assert_eq!(after["local_work"]["phase"], "provider_planned");
        for field in ["context", "input_digest", "api", "kernel", "attempts"] {
            assert_eq!(before[field], after[field], "{field}");
        }
        assert_eq!(window(&store)["reserved_requests"], 1);
        assert_eq!(store.value(source_key()), pool);
    }

    #[test]
    fn failed_planning_cleans_expired_original_without_provider_terminal_or_new_admission() {
        let store = Store::new();
        let (admission, _) = admission(&store, store.clone());
        store.advance(gateway_authority::REQUEST_LEASE_MS + 1);
        let result = run(admission.fail_planning()).unwrap();
        assert!(result.settled);
        assert!(result.observation.semantic_terminal.is_none());
        let row = store.value(journal::key("factory-owner"));
        assert_eq!(row["local_work"]["terminal"]["semantic"], "incomplete");
        assert_eq!(row["attempts"], serde_json::json!([]));
        assert_eq!(row["finished"], true);
        assert_eq!(window(&store)["reserved_requests"], 0);
        assert_eq!(window(&store)["committed_requests"], 0);
    }

    #[derive(Clone)]
    struct RacingTokens {
        store: Store,
        release: Arc<Mutex<Option<ApiReservation>>>,
    }
    impl TokenSource for RacingTokens {
        fn next_token(&self) -> Result<String, GatewayError> {
            if let Some(api) = self.release.lock().unwrap().take() {
                run(Authority::with_clock(
                    self.store.clone(),
                    self.store.clone(),
                    self.store.clone(),
                )
                .release_api_key(
                    &api,
                    true,
                    "fixture-final-phase-race",
                    self.store.now_ms()?,
                ))?;
            }
            self.store.next_token()
        }
    }

    #[test]
    fn attest_phase_cas_cannot_ignore_a_reservation_released_after_observation() {
        let store = Store::new();
        let tokens = RacingTokens {
            store: store.clone(),
            release: Arc::new(Mutex::new(None)),
        };
        let (admission, plan) = admission(&store, tokens.clone());
        *tokens.release.lock().unwrap() = admission.original.api.clone();
        assert!(run(admission.attest_plan(plan)).is_err());
        let row = store.value(journal::key("factory-owner"));
        assert_eq!(row["local_work"]["phase"], "planning");
        assert_eq!(row["attempts"], serde_json::json!([]));
        assert_eq!(window(&store)["reserved_requests"], 0);
        assert_eq!(window(&store)["committed_requests"], 0);
    }
}
