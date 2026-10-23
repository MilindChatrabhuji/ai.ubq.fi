//! Owned local semantic choice, separate from durable acknowledgement and transport.
use super::*;
use crate::types::RoutingError;
use gateway_authority::local_completion::LocalCompletedIntentOutcome;
use gateway_core::{
    lifecycle::{BodyOutcome, DeliveryOutcome, ReaderTermination},
    local_completion::LocalCompletedJournalPlan,
    state::{AtomicTransition, CommitOutcome, RevisionCheck},
};

pub struct PendingLocalCompletion<S, I, C, H> {
    original: Option<LocalWorkHandle<S, I, C, H>>,
    chosen_at_ms: i64,
    plan: Option<LocalCompletedJournalPlan>,
}
pub mod response;
pub type LocalCompletionChoice<S, I, C, H> =
    Result<response::BuiltLocalResponse<S, I, C, H>, response::LocalCompletionRefusal<S, I, C, H>>;

pub enum LocalCompletionAdvance<S, I, C, H> {
    Ready(LocalDeliveryHandle<S, I, C, H>),
    Conflict,
    Unconfirmed(GatewayError),
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> PendingLocalCompletion<S, I, C, H>
{
    /// An error, conflict, dropped await or unknown acknowledgement never consumes
    /// the original or changes the chosen semantic result into cancellation.
    pub async fn advance(&mut self) -> RoutingResult<LocalCompletionAdvance<S, I, C, H>> {
        let original = self.original.as_ref().ok_or_else(invalid)?;
        if let Some(plan) = &self.plan {
            if confirmed_continuation(original, plan).await? {
                return Ok(LocalCompletionAdvance::Ready(LocalDeliveryHandle {
                    original: Box::new(self.original.take().ok_or_else(invalid)?),
                    completed: true,
                }));
            }
        } else {
            let (record, row) = journal::load(&original.store, original.id()).await?;
            original.owned(&row)?;
            self.plan = Some(LocalCompletedJournalPlan::prepare(
                &record,
                original.original_context(),
                &original.digest,
                &original.nonce,
                self.chosen_at_ms,
            )?);
        }
        let outcome = Authority::with_clock(
            original.store.clone(),
            original.tokens.clone(),
            original.clock.clone(),
        )
        .record_local_completed_intent(
            self.plan.as_ref().ok_or_else(invalid)?,
            original.api.as_ref(),
            original.kernel.as_ref(),
            original.now()?,
        )
        .await?;
        Ok(match outcome {
            LocalCompletedIntentOutcome::Applied | LocalCompletedIntentOutcome::AlreadyApplied => {
                LocalCompletionAdvance::Ready(LocalDeliveryHandle {
                    original: Box::new(self.original.take().ok_or_else(invalid)?),
                    completed: true,
                })
            }
            LocalCompletedIntentOutcome::Conflict => {
                if confirmed_continuation(original, self.plan.as_ref().ok_or_else(invalid)?).await?
                {
                    LocalCompletionAdvance::Ready(LocalDeliveryHandle {
                        original: Box::new(self.original.take().ok_or_else(invalid)?),
                        completed: true,
                    })
                } else {
                    LocalCompletionAdvance::Conflict
                }
            }
            LocalCompletedIntentOutcome::Unconfirmed(error) => {
                LocalCompletionAdvance::Unconfirmed(error)
            }
        })
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> LocalDeliveryHandle<S, I, C, H>
{
    pub async fn finish_delivery(
        &mut self,
        reader: Option<ReaderTermination>,
        body: Option<BodyOutcome>,
        delivery: DeliveryOutcome,
    ) -> RoutingResult<RecoveredSession> {
        if !self.completed {
            return Err(invalid().into());
        }
        let original = &self.original;
        let (_, row) = journal::load(&original.store, original.id()).await?;
        if !same_original(
            &row,
            original.original_context(),
            &original.nonce,
            &original.digest,
            &original.api,
            &original.kernel,
        ) || row.local_work.as_ref().is_none_or(|local| {
            !matches!(
                local.phase,
                LocalWorkPhase::TerminalPending | LocalWorkPhase::Terminal
            ) || local
                .terminal
                .is_none_or(|terminal| terminal.semantic != LocalSemanticOutcome::Completed)
        }) {
            return Err(invalid().into());
        }
        terminal_checks(
            &original.store,
            &row,
            LocalSemanticOutcome::Completed,
            false,
        )
        .await?;
        Ok(finish_local_record(
            &original.store,
            &original.tokens,
            &original.clock,
            original.id(),
            LocalTerminalObservation {
                semantic: LocalSemanticOutcome::Completed,
                reader_termination: reader,
                body,
                delivery,
            },
            Some(selected_binding(original)),
        )
        .await?)
    }
}
fn same_original(
    row: &Journal,
    context: &RequestContext,
    nonce: &str,
    digest: &str,
    api: &Option<ApiReservation>,
    kernel: &Option<KernelReservation>,
) -> bool {
    row.v == 2
        && row.context == *context
        && row.input_digest == digest
        && row.api == *api
        && row
            .local_work
            .as_ref()
            .is_some_and(|local| local.owner_nonce == nonce)
        && match (&row.kernel, kernel) {
            (Some(a), Some(b)) => same_kernel(a, b),
            (None, None) => true,
            _ => false,
        }
}
pub(super) fn merge_observation(
    prior: Option<LocalTerminalObservation>,
    incoming: LocalTerminalObservation,
) -> Result<LocalTerminalObservation, GatewayError> {
    let Some(prior) = prior else {
        return Ok(incoming);
    };
    if prior.semantic != incoming.semantic {
        return Err(invalid());
    }
    fn fact<T: Copy + Eq>(
        prior: Option<T>,
        incoming: Option<T>,
    ) -> Result<Option<T>, GatewayError> {
        if prior.zip(incoming).is_some_and(|(a, b)| a != b) {
            return Err(invalid());
        }
        Ok(prior.or(incoming))
    }
    let delivery = if prior.delivery == DeliveryOutcome::Unobserved {
        incoming.delivery
    } else if incoming.delivery == DeliveryOutcome::Unobserved
        || incoming.delivery == prior.delivery
    {
        prior.delivery
    } else {
        return Err(invalid());
    };
    Ok(LocalTerminalObservation {
        semantic: prior.semantic,
        reader_termination: fact(prior.reader_termination, incoming.reader_termination)?,
        body: fact(prior.body, incoming.body)?,
        delivery,
    })
}
async fn terminal_checks<S: AuthorityStore>(
    store: &S,
    row: &Journal,
    semantic: LocalSemanticOutcome,
    settled: bool,
) -> Result<Vec<RevisionCheckWire>, GatewayError> {
    let mut checks = Vec::new();
    if let Some(api) = &row.api {
        let key = keys::api_request(
            &api.key_id.0,
            &api.policy_version,
            api.window_start_ms,
            &api.request_id.0,
        );
        let record = store.read(&key).await?;
        if let Some(record) = &record {
            let actual: ApiUsageRequest = row_value(record)?;
            if actual.validate().is_err()
                || actual.key_id != api.key_id
                || actual.request_id != api.request_id
                || actual.route != api.route
            {
                return Err(invalid());
            }
        }
        checks.push(RevisionCheckWire {
            key,
            expected_revision: record.map(|record| record.revision),
        });
    }
    if let Some(kernel) = &row.kernel {
        let key = keys::kernel_request(
            &kernel.owner,
            kernel.repo.as_deref(),
            kernel.window_created_at_ms,
            &kernel.request_id.0,
        );
        let record = store.read(&key).await?.ok_or_else(invalid)?;
        let actual: KernelReservation = row_value(&record)?;
        let terminal = if semantic == LocalSemanticOutcome::Completed {
            KernelTerminal::Committed
        } else {
            KernelTerminal::Released
        };
        let mut identity = actual.clone();
        identity.lease_expires_at_ms = kernel.lease_expires_at_ms;
        identity.terminal_intent = kernel.terminal_intent;
        identity.state = kernel.state;
        identity.terminal_at_ms = kernel.terminal_at_ms;
        identity.release_reason = kernel.release_reason.clone();
        if actual.validate().is_err()
            || identity != *kernel
            || actual.terminal_intent != Some(terminal)
            || actual.state.is_some_and(|value| value != terminal)
            || settled && actual.state != Some(terminal)
        {
            return Err(invalid());
        }
        checks.push(RevisionCheckWire {
            key,
            expected_revision: Some(record.revision),
        });
    }
    Ok(checks)
}
pub(super) async fn refine_finished_record<
    S: AuthorityStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
>(
    store: &S,
    tokens: &I,
    clock: &C,
    id: &str,
    expected: &Journal,
    observation: LocalTerminalObservation,
) -> Result<RecoveredSession, GatewayError> {
    let (record, row) = journal::load(store, id).await?;
    let local = expected.local_work.as_ref().ok_or_else(invalid)?;
    if !same_original(
        &row,
        &expected.context,
        &local.owner_nonce,
        &expected.input_digest,
        &expected.api,
        &expected.kernel,
    ) || !row.finished
        || row.local_work.as_ref().map(|local| local.phase) != Some(LocalWorkPhase::Terminal)
    {
        return Err(invalid());
    }
    let merged = merge_observation(
        row.local_work.as_ref().and_then(|local| local.terminal),
        observation,
    )?;
    let mut checks = terminal_checks(store, &row, merged.semantic, true).await?;
    checks.push(RevisionCheckWire {
        key: journal::key(id),
        expected_revision: Some(record.revision),
    });
    if row.local_work.as_ref().and_then(|local| local.terminal) == Some(merged) {
        let outcome = store
            .commit(AtomicTransition {
                checks: checks
                    .iter()
                    .map(|check| RevisionCheck {
                        key: check.key.clone(),
                        expected_revision: check.expected_revision.clone(),
                    })
                    .collect(),
                mutations: Vec::new(),
            })
            .await?;
        if outcome != CommitOutcome::Committed {
            return Err(invalid());
        }
    } else {
        journal::change(store, tokens, id, clock.now_ms()?, &checks, |current| {
            if !same_original(
                current,
                &expected.context,
                &local.owner_nonce,
                &expected.input_digest,
                &expected.api,
                &expected.kernel,
            ) || !current.finished
            {
                return Err(invalid());
            }
            let local = current.local_work.as_mut().ok_or_else(invalid)?;
            if local.phase != LocalWorkPhase::Terminal {
                return Err(invalid());
            }
            local.terminal = Some(merge_observation(local.terminal, merged)?);
            Ok(())
        })
        .await?;
    }
    Ok(RecoveredSession {
        request_id: id.into(),
        observation: local_transport(merged),
        settled: true,
    })
}

async fn confirmed_continuation<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
>(
    original: &LocalWorkHandle<S, I, C, H>,
    plan: &LocalCompletedJournalPlan,
) -> Result<bool, GatewayError> {
    let (record, row) = journal::load(&original.store, original.id()).await?;
    if !same_original(
        &row,
        original.original_context(),
        &original.nonce,
        &original.digest,
        &original.api,
        &original.kernel,
    ) || row.local_work.as_ref().is_none_or(|local| {
        !matches!(
            local.phase,
            LocalWorkPhase::TerminalPending | LocalWorkPhase::Terminal
        ) || local
            .terminal
            .is_none_or(|terminal| terminal.semantic != LocalSemanticOutcome::Completed)
    }) {
        return Ok(false);
    }
    // Full runtime decoder and exact original comparison: only this continuation's
    // transport/terminal/recovery fields may differ from the genuine chosen plan.
    let mut expected = Journal::decode(plan.original_document())?;
    expected.local_work = row.local_work.clone();
    expected.finished = row.finished;
    expected.recovering = row.recovering;
    expected.updated_at_ms = row.updated_at_ms;
    if expected != row {
        return Ok(false);
    }
    let mut checks = terminal_checks(
        &original.store,
        &row,
        LocalSemanticOutcome::Completed,
        row.finished,
    )
    .await?;
    checks.push(RevisionCheckWire {
        key: journal::key(original.id()),
        expected_revision: Some(record.revision),
    });
    Ok(original
        .store
        .commit(AtomicTransition {
            checks: checks
                .iter()
                .map(|check| RevisionCheck {
                    key: check.key.clone(),
                    expected_revision: check.expected_revision.clone(),
                })
                .collect(),
            mutations: Vec::new(),
        })
        .await?
        == CommitOutcome::Committed)
}

/// Private borrowed original identities, not a reconstructible runtime capability.
pub(crate) struct OriginalBinding<'a> {
    pub(super) context: &'a RequestContext,
    pub(super) nonce: &'a str,
    pub(super) digest: &'a str,
    pub(super) api: &'a Option<ApiReservation>,
    pub(super) kernel: &'a Option<KernelReservation>,
    pub(super) allow_unbound_admission: bool,
    pub(super) api_release_done: bool,
}
impl OriginalBinding<'_> {
    pub(super) fn matches(&self, row: &Journal) -> bool {
        same_original(
            row,
            self.context,
            self.nonce,
            self.digest,
            self.api,
            self.kernel,
        ) || self.allow_unbound_admission
            && row.v == 2
            && row.context == *self.context
            && row.input_digest == self.digest
            && row.local_work.as_ref().is_some_and(|local| {
                local.owner_nonce == self.nonce && local.phase == LocalWorkPhase::Admitting
            })
            && (row.api.is_none() || row.api == *self.api)
            && match (&row.kernel, self.kernel) {
                (None, _) => true,
                (Some(a), Some(b)) => same_kernel(a, b),
                _ => false,
            }
    }
}
pub(super) fn binding<S, I, C, H>(original: &LocalWorkHandle<S, I, C, H>) -> OriginalBinding<'_> {
    OriginalBinding {
        context: &original.input.metadata.context,
        nonce: &original.nonce,
        digest: &original.digest,
        api: &original.api,
        kernel: &original.kernel,
        allow_unbound_admission: false,
        api_release_done: false,
    }
}

fn selected_binding<S, I, C, H>(original: &LocalWorkHandle<S, I, C, H>) -> OriginalBinding<'_> {
    let mut expected = binding(original);
    expected.api_release_done = true;
    expected
}
