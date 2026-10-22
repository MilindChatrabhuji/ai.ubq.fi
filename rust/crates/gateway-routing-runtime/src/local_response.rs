//! Provisional built response, earlier API selection and independent accounting.
use super::*;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocalWireKind {
    OriginalSuccess,
    OriginalCancellation,
    QuotaReplacement,
}
pub struct LocalWireDecision {
    kind: LocalWireKind,
    quota_error: Option<RoutingError>,
}
impl LocalWireDecision {
    pub fn kind(&self) -> LocalWireKind {
        self.kind
    }
    pub fn quota_error(&self) -> Option<&RoutingError> {
        self.quota_error.as_ref()
    }
    pub fn into_quota_error(self) -> Option<RoutingError> {
        self.quota_error
    }
}
pub struct BuiltLocalResponse<S, I, C, H> {
    original: Option<Box<LocalWorkHandle<S, I, C, H>>>,
    original_kind: LocalWireKind,
    selection: Option<LocalWireDecision>,
    early_cleanup_done: bool,
    early_cleanup_error: Option<RoutingError>,
}
pub struct LocalCompletionRefusal<S, I, C, H> {
    capture: Box<BuiltLocalResponse<S, I, C, H>>,
    error: RoutingError,
}
impl<S, I, C, H> std::fmt::Debug for LocalCompletionRefusal<S, I, C, H> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("LocalCompletionRefusal")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Copy, Default)]
struct Facts {
    reader: Option<ReaderTermination>,
    body: Option<BodyOutcome>,
    delivery: DeliveryOutcome,
}
impl Facts {
    fn observation(self, semantic: LocalSemanticOutcome) -> LocalTerminalObservation {
        LocalTerminalObservation {
            semantic,
            reader_termination: self.reader,
            body: self.body,
            delivery: self.delivery,
        }
    }
}
/// Bounded DATA only. Cloning it never clones an original or grants I/O.
#[derive(Clone)]
pub struct LocalObservationSink {
    facts: Rc<RefCell<Facts>>,
}
impl LocalObservationSink {
    pub fn observe(
        &self,
        reader: Option<ReaderTermination>,
        body: Option<BodyOutcome>,
        delivery: DeliveryOutcome,
    ) -> Result<(), GatewayError> {
        let mut facts = self.facts.borrow_mut();
        let merged = merge_observation(
            Some(facts.observation(LocalSemanticOutcome::Completed)),
            LocalTerminalObservation {
                semantic: LocalSemanticOutcome::Completed,
                reader_termination: reader,
                body,
                delivery,
            },
        )?;
        *facts = Facts {
            reader: merged.reader_termination,
            body: merged.body,
            delivery: merged.delivery,
        };
        Ok(())
    }
}
pub struct LocalSelectedResponse<S, I, C, H> {
    original: Option<Box<LocalWorkHandle<S, I, C, H>>>,
    kind: LocalWireKind,
    wire: Option<LocalWireDecision>,
    sink: LocalObservationSink,
    pending: Option<Box<PendingLocalCompletion<S, I, C, H>>>,
    confirmed: Option<LocalDeliveryHandle<S, I, C, H>>,
    terminal: Option<LocalSemanticOutcome>,
    wrapper_failed: bool,
    early_cleanup_error: Option<RoutingError>,
}
pub enum LocalAccountingProgress {
    Confirmed(RecoveredSession),
    Unconfirmed(GatewayError),
    Conflict,
    Error(RoutingError),
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalWorkHandle<S, I, C, H>
{
    /// The actual successful builder and final observed abort check precede this
    /// synchronous ownership capture. No Completed kernel choice is made here.
    pub fn retain_built_response(self) -> LocalCompletionChoice<S, I, C, H> {
        let error = if self.host.cancelled() {
            Some(self.host.cancellation_error())
        } else {
            self.now().err()
        };
        let kind = if error.is_some() {
            LocalWireKind::OriginalCancellation
        } else {
            LocalWireKind::OriginalSuccess
        };
        let capture = BuiltLocalResponse {
            original: Some(Box::new(self)),
            original_kind: kind,
            selection: None,
            early_cleanup_done: false,
            early_cleanup_error: None,
        };
        match error {
            Some(error) => Err(LocalCompletionRefusal {
                capture: Box::new(capture),
                error: error.into(),
            }),
            None => Ok(capture),
        }
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> BuiltLocalResponse<S, I, C, H>
{
    /// Release errors select a new source quota response once, even on an
    /// uncertain mutation acknowledgement. Dropped awaits retain this owner.
    pub async fn select_response(&mut self) -> RoutingResult<LocalSelectedResponse<S, I, C, H>> {
        let original = self.original.as_ref().ok_or_else(invalid)?;
        if self.selection.is_none() {
            let error = if let Some(api) = &original.api {
                Authority::with_clock(
                    original.store.clone(),
                    original.tokens.clone(),
                    original.clock.clone(),
                )
                .release_local_response_api(api, original.now()?)
                .await
                .err()
                .map(|error| RoutingError::from(error.as_gateway_error()))
            } else {
                None
            };
            self.selection = Some(LocalWireDecision {
                kind: if error.is_some() {
                    LocalWireKind::QuotaReplacement
                } else {
                    self.original_kind
                },
                quota_error: error,
            });
        }
        if self
            .selection
            .as_ref()
            .is_some_and(|selection| selection.kind == LocalWireKind::QuotaReplacement)
            && !self.early_cleanup_done
        {
            if let Some(kernel) = &original.kernel {
                let result = match original.now() {
                    Ok(now) => Authority::with_clock(
                        original.store.clone(),
                        original.tokens.clone(),
                        original.clock.clone(),
                    )
                    .settle_kernel(
                        kernel,
                        KernelTerminal::Released,
                        "api_key_quota_accounting_error",
                        now,
                    )
                    .await
                    .map(|_| ()),
                    Err(error) => Err(error),
                };
                self.early_cleanup_error = result.err().map(RoutingError::from);
            }
            self.early_cleanup_done = true;
        }
        let wire = self.selection.take().ok_or_else(invalid)?;
        Ok(LocalSelectedResponse {
            original: self.original.take(),
            kind: wire.kind,
            wire: Some(wire),
            sink: LocalObservationSink {
                facts: Rc::new(RefCell::new(Facts::default())),
            },
            pending: None,
            confirmed: None,
            terminal: None,
            wrapper_failed: false,
            early_cleanup_error: self.early_cleanup_error.take(),
        })
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalCompletionRefusal<S, I, C, H>
{
    pub fn error(&self) -> &RoutingError {
        &self.error
    }
    pub async fn select_cancelled_response(
        &mut self,
    ) -> RoutingResult<LocalSelectedResponse<S, I, C, H>> {
        self.capture.select_response().await
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalSelectedResponse<S, I, C, H>
{
    /// Exactly one source-selected wire decision; never a durability receipt.
    pub fn take_wire_decision(&mut self) -> Option<LocalWireDecision> {
        self.wire.take()
    }
    pub fn observation_sink(&self) -> LocalObservationSink {
        self.sink.clone()
    }
    pub fn take_early_accounting_error(&mut self) -> Option<RoutingError> {
        self.early_cleanup_error.take()
    }
    /// Actual wrapper construction failure only, not a late body/caller event.
    pub fn note_wrapper_failure(&mut self) -> RoutingResult<()> {
        if self.terminal.is_some() {
            return Err(invalid().into());
        }
        self.wrapper_failed = true;
        Ok(())
    }
    /// One callback attempt; M05 owns source3-attempt chains and wire ordering.
    pub async fn attempt_terminal(&mut self) -> LocalAccountingProgress {
        match self.attempt_step().await {
            Ok(progress) => progress,
            Err(error) => LocalAccountingProgress::Error(error),
        }
    }
    async fn attempt_step(&mut self) -> RoutingResult<LocalAccountingProgress> {
        let semantic = *self.terminal.get_or_insert(if self.wrapper_failed {
            LocalSemanticOutcome::Incomplete
        } else {
            match self.kind {
                LocalWireKind::OriginalSuccess => LocalSemanticOutcome::Completed,
                LocalWireKind::OriginalCancellation => LocalSemanticOutcome::Cancelled,
                LocalWireKind::QuotaReplacement => LocalSemanticOutcome::Incomplete,
            }
        });
        if semantic == LocalSemanticOutcome::Completed {
            if self.pending.is_none() && self.confirmed.is_none() {
                let chosen_at_ms = self.original.as_ref().ok_or_else(invalid)?.now()?;
                self.pending = Some(Box::new(PendingLocalCompletion {
                    original: Some(*self.original.take().ok_or_else(invalid)?),
                    chosen_at_ms,
                    plan: None,
                }));
            }
            if self.confirmed.is_none() {
                match self.pending.as_mut().ok_or_else(invalid)?.advance().await? {
                    LocalCompletionAdvance::Ready(handle) => self.confirmed = Some(handle),
                    LocalCompletionAdvance::Conflict => {
                        return Ok(LocalAccountingProgress::Conflict);
                    }
                    LocalCompletionAdvance::Unconfirmed(error) => {
                        return Ok(LocalAccountingProgress::Unconfirmed(error));
                    }
                }
            }
            let facts = *self.sink.facts.borrow();
            let result = self
                .confirmed
                .as_mut()
                .ok_or_else(invalid)?
                .finish_delivery(facts.reader, facts.body, facts.delivery)
                .await?;
            return Ok(LocalAccountingProgress::Confirmed(result));
        }
        let original = self.original.as_ref().ok_or_else(invalid)?;
        if let Some(kernel) = &original.kernel {
            let reason = if self.wrapper_failed {
                "terminal_wrapper_error"
            } else if self.kind == LocalWireKind::QuotaReplacement {
                "api_key_quota_accounting_error"
            } else {
                "request_incomplete"
            };
            Authority::with_clock(
                original.store.clone(),
                original.tokens.clone(),
                original.clock.clone(),
            )
            .settle_kernel(kernel, KernelTerminal::Released, reason, original.now()?)
            .await?;
        }
        let facts = *self.sink.facts.borrow();
        let result = finish_local_record(
            &original.store,
            &original.tokens,
            &original.clock,
            original.id(),
            facts.observation(semantic),
            Some(selected_binding(original)),
        )
        .await?;
        Ok(LocalAccountingProgress::Confirmed(result))
    }
}
