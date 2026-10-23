//! One finite same-original local-success intent. Data plans never mint I/O rights.
use crate::kernel::{kernel_identity, stage_kernel_terminal_intent};
use crate::quota::{
    ApiReservation, ApiUsageRequest, ApiUsageState, KernelReservation, KernelTerminal,
};
use crate::store::Transaction;
use crate::{Authority, TokenSource, invalid, keys};
use gateway_core::source_json::SourceJson;
use gateway_core::source_serialization as source;
use gateway_core::state::AuthorityStore;
use gateway_core::{
    GatewayError,
    local_completion::{LocalCompletedJournalPlan, LocalCompletedJournalState},
};

#[derive(Debug)]
pub enum LocalCompletedIntentOutcome {
    Applied,
    AlreadyApplied,
    Conflict,
    /// A commit error does not prove rollback, including a lost durable-sync ack.
    Unconfirmed(GatewayError),
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    /// The runtime must already own a genuine synchronous local-success choice.
    /// This borrows its finite plan, so errors never consume the actual handle.
    /// Old inference-lease expiry is not a new terminal-settlement predicate.
    pub async fn record_local_completed_intent(
        &self,
        plan: &LocalCompletedJournalPlan,
        expected_api: Option<&ApiReservation>,
        expected_kernel: Option<&KernelReservation>,
        now: i64,
    ) -> Result<LocalCompletedIntentOutcome, GatewayError> {
        let mut tx = self.transaction(now)?;
        let journal_key = plan.journal_key();
        let Some(current) = tx.read_source_control::<SourceJson>(&journal_key).await? else {
            return Ok(LocalCompletedIntentOutcome::Conflict);
        };
        if tx.expiry(&journal_key).is_some() {
            return Err(invalid("Unfinished local journal has retention expiry."));
        }
        let state = plan.classify(&current)?;
        if state == LocalCompletedJournalState::Conflict
            || (state == LocalCompletedJournalState::Prepared
                && !tx.expect(&journal_key, &Some(plan.expected_revision().to_owned())))
        {
            return Ok(LocalCompletedIntentOutcome::Conflict);
        }
        let pending_key = plan.pending_key();
        let Some(pending) = tx.read::<serde_json::Value>(&pending_key).await? else {
            return Ok(LocalCompletedIntentOutcome::Conflict);
        };
        if pending != serde_json::json!({"request_id": plan.context().request_id.0})
            || tx.expiry(&pending_key).is_some()
            || tx.revision(&pending_key)
                != tx
                    .revision(&journal_key)
                    .map(|revision| format!("{revision}:pending"))
        {
            return Err(invalid("Local journal pending custody conflicts."));
        }
        if !api_matches(&mut tx, plan, expected_api).await?
            || !kernel_snapshot_matches(plan, expected_kernel)?
        {
            return Ok(LocalCompletedIntentOutcome::Conflict);
        }
        if let Some(kernel) = expected_kernel {
            let key = keys::kernel_request(
                &kernel.owner,
                kernel.repo.as_deref(),
                kernel.window_created_at_ms,
                &kernel.request_id.0,
            );
            let Some(actual) = tx.read::<KernelReservation>(&key).await? else {
                return Ok(LocalCompletedIntentOutcome::Conflict);
            };
            if !kernel_identity(&actual, kernel)
                || actual
                    .state
                    .is_some_and(|value| value != KernelTerminal::Committed)
                || actual
                    .terminal_intent
                    .is_some_and(|value| value != KernelTerminal::Committed)
            {
                return Ok(LocalCompletedIntentOutcome::Conflict);
            }
            let was_chosen = actual.state == Some(KernelTerminal::Committed)
                || actual.terminal_intent == Some(KernelTerminal::Committed);
            if was_chosen != (state == LocalCompletedJournalState::Applied) {
                return Ok(LocalCompletedIntentOutcome::Conflict);
            }
            if state == LocalCompletedJournalState::Prepared {
                stage_kernel_terminal_intent(&mut tx, kernel, KernelTerminal::Committed, now)
                    .await?;
            }
        }
        if state == LocalCompletedJournalState::Prepared {
            tx.put_local_completed_journal(plan, now)?;
        }
        match tx.commit().await {
            Ok(true) if state == LocalCompletedJournalState::Applied => {
                Ok(LocalCompletedIntentOutcome::AlreadyApplied)
            }
            Ok(true) => Ok(LocalCompletedIntentOutcome::Applied),
            Ok(false) => Ok(LocalCompletedIntentOutcome::Conflict),
            Err(error) => Ok(LocalCompletedIntentOutcome::Unconfirmed(error)),
        }
    }
}

async fn api_matches<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    plan: &LocalCompletedJournalPlan,
    expected: Option<&ApiReservation>,
) -> Result<bool, GatewayError> {
    let snapshot: Option<ApiReservation> = source::member(plan.original_document(), "api")
        .ok_or_else(|| invalid("Local journal API binding is missing."))?
        .deserialize()?;
    if snapshot.as_ref() != expected {
        return Ok(false);
    }
    let Some(expected) = expected else {
        return Ok(true);
    };
    if expected.request_id != plan.context().request_id
        || expected.route != plan.context().route
        || plan.context().key_id.as_ref() != Some(&expected.key_id)
    {
        return Ok(false);
    }
    let key = keys::api_request(
        &expected.key_id.0,
        &expected.policy_version,
        expected.window_start_ms,
        &expected.request_id.0,
    );
    let actual: Option<ApiUsageRequest> = tx.read(&key).await?;
    let Some(actual) = actual else {
        // Source unused release treats a missing original row as a no-op.
        // Transaction::read retains the actual absence check through the joint CAS.
        return Ok(true);
    };
    actual.validate()?;
    Ok(actual.key_id == expected.key_id
        && actual.request_id == expected.request_id
        && actual.route == expected.route
        && match actual.state {
            // The earlier dispatch-aware release never compensates dispatched use.
            // Its validated request revision is fenced; no API window is mutated.
            ApiUsageState::Dispatched => true,
            ApiUsageState::Reserved | ApiUsageState::Released => !actual.transport_started,
        })
}

fn kernel_snapshot_matches(
    plan: &LocalCompletedJournalPlan,
    expected: Option<&KernelReservation>,
) -> Result<bool, GatewayError> {
    let snapshot: Option<KernelReservation> = source::member(plan.original_document(), "kernel")
        .ok_or_else(|| invalid("Local journal kernel binding is missing."))?
        .deserialize()?;
    Ok(match (snapshot.as_ref(), expected) {
        (Some(actual), Some(expected)) => {
            expected.request_id == plan.context().request_id
                && expected.route == plan.context().route
                && kernel_identity(actual, expected)
        }
        (None, None) => true,
        _ => false,
    })
}

#[cfg(test)]
mod tests;
