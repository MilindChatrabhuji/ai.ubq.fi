//! Observed ordinary-request leases, never an imported or reusable I/O grant.
use crate::{
    journal::{self, AttemptRecord, Journal, Phase},
    session::RoutingSession,
    types::{RoutingHost, RoutingResult},
};
use gateway_authority::{
    AuthorityClock, TokenSource, keys,
    quota::{ApiReservation, ApiUsageRequest, ApiUsageState, KernelReservation, KernelTerminal},
};
use gateway_core::{
    GatewayError,
    lifecycle::SemanticTerminal,
    local_work::LocalWorkPhase,
    query::QueryStore,
    state::{AtomicTransition, CommitOutcome, RevisionCheck, StoredRecord},
};
use std::cell::RefCell;

/// Captured only by the two genuine constructors, never loaded from stored rows.
/// Deferred API resolution and attempt identities come from their actual owners.
pub(crate) struct OriginalRoutingAdmission {
    version: u32,
    digest: String,
    api: Option<ApiReservation>,
    kernel: Option<KernelReservation>,
    local_nonce: Option<String>,
    resolved_api: RefCell<Option<ApiReservation>>,
    attempts: RefCell<Vec<AttemptRecord>>,
}
impl OriginalRoutingAdmission {
    pub(crate) fn capture(
        version: u32,
        digest: String,
        api: Option<ApiReservation>,
        kernel: Option<KernelReservation>,
        local_nonce: Option<String>,
    ) -> Self {
        Self {
            version,
            digest,
            api,
            kernel,
            local_nonce,
            resolved_api: RefCell::new(None),
            attempts: RefCell::new(Vec::new()),
        }
    }
    pub(crate) fn capture_attempt(&self, attempt: AttemptRecord) {
        self.attempts.borrow_mut().push(attempt);
    }
    pub(crate) fn capture_resolved_api(
        &self,
        resolved: Option<&ApiReservation>,
    ) -> Result<(), GatewayError> {
        match (&self.api, resolved) {
            (None, None) => Ok(()),
            (Some(original), Some(actual)) if original == actual => Ok(()),
            (Some(original), Some(actual))
                if original.deferred
                    && !actual.deferred
                    && original.key_id == actual.key_id
                    && original.request_id == actual.request_id
                    && original.route == actual.route =>
            {
                let mut prior = self.resolved_api.borrow_mut();
                if prior.as_ref().is_some_and(|value| value != actual) {
                    return Err(invalid());
                }
                *prior = Some(actual.clone());
                Ok(())
            }
            _ => Err(invalid()),
        }
    }
    fn matches(&self, row: &Journal) -> bool {
        let api_matches = row.api == self.api
            || self
                .resolved_api
                .borrow()
                .as_ref()
                .is_some_and(|resolved| row.api.as_ref() == Some(resolved));
        let local_matches = match (&self.local_nonce, &row.local_work) {
            (None, None) => true,
            (Some(nonce), Some(local)) => {
                local.owner_nonce == *nonce
                    && local.phase == LocalWorkPhase::ProviderPlanned
                    && local.terminal.is_none()
            }
            _ => false,
        };
        let attempts = self.attempts.borrow();
        row.v == self.version
            && row.input_digest == self.digest
            && api_matches
            && local_matches
            && match (&row.kernel, &self.kernel) {
                (Some(actual), Some(original)) => {
                    let mut expected = original.clone();
                    expected.lease_expires_at_ms = actual.lease_expires_at_ms;
                    expected == *actual
                }
                (None, None) => true,
                _ => false,
            }
            && row.attempts.len() == attempts.len()
            && row
                .attempts
                .iter()
                .zip(attempts.iter())
                .all(|(actual, original)| {
                    actual.id == original.id
                        && actual.provider == original.provider
                        && actual.model == original.model
                        && actual.cursor == original.cursor
                        && actual.fence == original.fence
                        && actual.paid == original.paid
                })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RoutingLeaseState {
    Live,
    TerminalSettlement,
    Settled,
}

/// Data at one strong observed revision set; it does not authorize later work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObservedRoutingLease {
    observed_at_ms: i64,
    request_expires_at_ms: i64,
    kernel_expires_at_ms: Option<i64>,
    state: RoutingLeaseState,
}
impl ObservedRoutingLease {
    pub fn observed_at_ms(&self) -> i64 {
        self.observed_at_ms
    }
    pub fn request_expires_at_ms(&self) -> i64 {
        self.request_expires_at_ms
    }
    pub fn kernel_expires_at_ms(&self) -> Option<i64> {
        self.kernel_expires_at_ms
    }
    pub fn state(&self) -> RoutingLeaseState {
        self.state
    }
}

/// Borrowed from the original session; no public constructor, clone or deserializer.
pub struct RoutingCurrentness<'a, S, I, C, H> {
    session: &'a RoutingSession<S, I, C, H>,
}
fn invalid() -> GatewayError {
    journal::unavailable("The original routing admission is no longer current.")
}
fn decode<T: serde::de::DeserializeOwned>(record: &StoredRecord) -> Result<T, GatewayError> {
    record.validate_version()?;
    if record.revision.trim().is_empty() {
        return Err(invalid());
    }
    serde_json::from_value(record.json_value()?.clone()).map_err(|_| invalid())
}
fn same_kernel_identity(actual: &KernelReservation, original: &KernelReservation) -> bool {
    actual.validate().is_ok()
        && actual.v == original.v
        && actual.owner == original.owner
        && actual.repo == original.repo
        && actual.request_id == original.request_id
        && actual.route == original.route
        && actual.window_created_at_ms == original.window_created_at_ms
        && actual.window_reset_at_ms == original.window_reset_at_ms
        && actual.reserved_at_ms == original.reserved_at_ms
}
fn classification(row: &Journal) -> Result<(RoutingLeaseState, KernelTerminal), GatewayError> {
    let active = row
        .active
        .as_ref()
        .map(|id| {
            let mut matching = row.attempts.iter().filter(|attempt| &attempt.id == id);
            let attempt = matching.next().ok_or_else(invalid)?;
            if matching.next().is_some() {
                return Err(invalid());
            }
            Ok(attempt)
        })
        .transpose()?;
    let provider_semantic = active
        .and_then(|attempt| attempt.observation)
        .and_then(|observation| observation.semantic_terminal);
    let terminal_semantic = row
        .terminal_intent
        .and_then(|observation| observation.semantic_terminal);
    if provider_semantic
        .zip(terminal_semantic)
        .is_some_and(|(a, b)| a != b)
        || row.semantic_committed && provider_semantic.or(terminal_semantic).is_none()
    {
        return Err(invalid());
    }
    let state = if row.finished {
        RoutingLeaseState::Settled
    } else if row.recovering || row.terminal_intent.is_some() || row.semantic_committed {
        RoutingLeaseState::TerminalSettlement
    } else {
        RoutingLeaseState::Live
    };
    let terminal = row
        .kernel_override
        .as_ref()
        .map(|intent| intent.terminal)
        .unwrap_or(
            if provider_semantic.or(terminal_semantic) == Some(SemanticTerminal::Completed) {
                KernelTerminal::Committed
            } else {
                KernelTerminal::Released
            },
        );
    Ok((state, terminal))
}

impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> RoutingSession<S, I, C, H>
{
    pub fn currentness(&self) -> RoutingCurrentness<'_, S, I, C, H> {
        RoutingCurrentness { session: self }
    }
}
impl<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
> RoutingCurrentness<'_, S, I, C, H>
{
    pub async fn checkpoint(&self) -> RoutingResult<ObservedRoutingLease> {
        let session = self.session;
        let (record, row) = journal::load(&session.store, session.id()).await?;
        if row.context != session.input.context
            || !session.admission.matches(&row)
            || row.extras_family.is_some()
        {
            return Err(invalid().into());
        }
        let (state, terminal) = classification(&row)?;
        let live = state == RoutingLeaseState::Live;
        let mut checks = vec![RevisionCheck {
            key: journal::key(session.id()),
            expected_revision: Some(record.revision),
        }];
        let mut api_expiry = None;
        if let Some(api) = &row.api {
            let key = keys::api_request(
                &api.key_id.0,
                &api.policy_version,
                api.window_start_ms,
                &api.request_id.0,
            );
            let record = session.store.read(&key).await?;
            if let Some(record) = &record {
                let actual: ApiUsageRequest = decode(record)?;
                if actual.validate().is_err()
                    || actual.key_id != api.key_id
                    || actual.request_id != api.request_id
                    || actual.route != api.route
                    || live && actual.state == ApiUsageState::Released
                    || actual.state == ApiUsageState::Released
                        && row.attempts.iter().any(|attempt| {
                            attempt.transport_started
                                || (attempt.phase != Phase::Prepared && !attempt.known_not_started)
                        })
                {
                    return Err(invalid().into());
                }
                if actual.state == ApiUsageState::Reserved {
                    api_expiry = Some(actual.lease_expires_at_ms);
                }
                if actual.state == ApiUsageState::Dispatched
                    && !row
                        .attempts
                        .iter()
                        .any(|attempt| Some(attempt.provider) == actual.provider)
                {
                    return Err(invalid().into());
                }
            } else if !api.deferred
                || row
                    .attempts
                    .iter()
                    .any(|attempt| attempt.phase != Phase::Prepared)
            {
                return Err(invalid().into());
            }
            checks.push(RevisionCheck {
                key,
                expected_revision: record.map(|record| record.revision),
            });
        }
        let mut kernel_expiry = None;
        if let Some(original) = &session.admission.kernel {
            let key = keys::kernel_request(
                &original.owner,
                original.repo.as_deref(),
                original.window_created_at_ms,
                &original.request_id.0,
            );
            let record = session.store.read(&key).await?.ok_or_else(invalid)?;
            let actual: KernelReservation = decode(&record)?;
            if !same_kernel_identity(&actual, original)
                || live && (actual.state.is_some() || actual.terminal_intent.is_some())
                || !live
                    && (actual.state.is_some_and(|value| value != terminal)
                        || actual
                            .terminal_intent
                            .is_some_and(|value| value != terminal))
                || state == RoutingLeaseState::Settled && actual.state != Some(terminal)
            {
                return Err(invalid().into());
            }
            kernel_expiry = Some(actual.lease_expires_at_ms);
            checks.push(RevisionCheck {
                key,
                expected_revision: Some(record.revision),
            });
        }
        // Empty mutation CAS observes one real revision set without extending any lease.
        if session
            .store
            .commit(AtomicTransition {
                checks,
                mutations: Vec::new(),
            })
            .await?
            != CommitOutcome::Committed
        {
            return Err(invalid().into());
        }
        let now = session.now()?;
        if live {
            if session.host.cancelled() {
                return Err(session.host.cancellation_error().into());
            }
            if row.lease_expires_at_ms <= now
                || kernel_expiry.is_some_and(|expiry| expiry <= now)
                || api_expiry.is_some_and(|expiry| expiry <= now)
            {
                return Err(invalid().into());
            }
        }
        Ok(ObservedRoutingLease {
            observed_at_ms: now,
            request_expires_at_ms: row.lease_expires_at_ms,
            kernel_expires_at_ms: kernel_expiry,
            state,
        })
    }
}
