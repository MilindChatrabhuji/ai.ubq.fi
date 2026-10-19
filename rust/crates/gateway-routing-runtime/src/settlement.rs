use crate::{
    journal::{self, Journal, Phase},
    types::{RecoveredSession, RevisionCheckWire, RoutingHost},
};
use gateway_authority::{Authority, AuthorityClock, TokenSource, quota::KernelTerminal};
use gateway_core::{
    GatewayError,
    lifecycle::{SemanticTerminal, TransportObservation},
    query::{QueryRequest, QuerySelector, QueryStore},
    state::{AuthorityStore, RevisionCheck},
};

pub(crate) async fn finish_record<
    S: AuthorityStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
>(
    store: &S,
    tokens: &I,
    clock: &C,
    host: &H,
    id: &str,
    mut observed: TransportObservation,
) -> Result<RecoveredSession, GatewayError> {
    let now = clock.now_ms()?;
    let (_, old) = journal::load(store, id).await?;
    if let Some(local) = old
        .local_work
        .as_ref()
        .filter(|local| local.phase != gateway_core::local_work::LocalWorkPhase::ProviderPlanned)
    {
        let local_observation =
            local
                .terminal
                .unwrap_or(gateway_core::local_work::LocalTerminalObservation {
                    semantic: gateway_core::local_work::LocalSemanticOutcome::Incomplete,
                    reader_termination: observed.reader_termination,
                    body: observed.body,
                    delivery: observed.delivery,
                });
        return crate::local_work::finish_local_record(
            store,
            tokens,
            clock,
            id,
            local_observation,
            None,
        )
        .await;
    }
    if old.finished {
        return Ok(RecoveredSession {
            request_id: id.into(),
            observation: old.terminal_intent.unwrap_or_default(),
            settled: true,
        });
    }
    if let Some(active) = &old.active {
        let prior = old
            .attempts
            .iter()
            .find(|a| &a.id == active)
            .and_then(|a| a.observation)
            .and_then(|o| o.semantic_terminal);
        if observed.semantic_terminal.is_some()
            && prior.is_some()
            && observed.semantic_terminal != prior
        {
            return Err(journal::unavailable(
                "Final semantic outcome conflicts with durable provider intent.",
            ));
        }
        observed.semantic_terminal = prior.or(observed.semantic_terminal);
    }
    let intent = journal::change(store, tokens, id, now, &[], |row| {
        if row.terminal_intent.is_none() {
            row.terminal_intent = Some(observed);
        }
        Ok(())
    })
    .await?;
    let observed = intent.terminal_intent.unwrap_or(observed);
    let authority = Authority::with_clock(store.clone(), tokens.clone(), clock.clone());
    // A prepared attempt has never passed its final before-dispatch hook.
    // Intent/Started without explicit NotStarted proof remains ambiguous.
    if intent
        .attempts
        .iter()
        .all(|a| !a.transport_started && (a.phase == Phase::Prepared || a.known_not_started))
        && intent.children.iter().all(|child| {
            !child.transport_started && (child.known_not_started || child.phase == Phase::Prepared)
        })
        && intent
            .extras_dispatch
            .as_ref()
            .is_none_or(|dispatch| !dispatch.transport_started)
        && let Some(api) = &intent.api
    {
        authority
            .release_api_key(api, true, "routing_known_before_transport", clock.now_ms()?)
            .await?;
    }
    if let Some(kernel) = &intent.kernel {
        let derived = if observed.semantic_terminal == Some(SemanticTerminal::Completed) {
            KernelTerminal::Committed
        } else {
            KernelTerminal::Released
        };
        let (terminal, reason) = intent
            .kernel_override
            .as_ref()
            .map(|intent| (intent.terminal, intent.reason.as_str()))
            .unwrap_or((derived, "routing_semantic_terminal"));
        authority
            .record_kernel_terminal_intent(kernel, terminal, clock.now_ms()?)
            .await?;
        authority
            .settle_kernel(kernel, terminal, reason, clock.now_ms()?)
            .await?;
    }
    for attempt in &intent.attempts {
        let Some(reservation) = &attempt.paid else {
            continue;
        };
        if (attempt.phase == Phase::Prepared || attempt.known_not_started)
            && !attempt.transport_started
        {
            authority
                .release_paid_before_transport(reservation, clock.now_ms()?)
                .await?;
            continue;
        }
        let recorded = attempt.billing.as_ref().map(|u| u.to_usage()).transpose()?;
        let usage = match recorded {
            Some(u) => Some(u),
            None => host.lookup_paid(reservation).await.unwrap_or(None),
        };
        if let Some(usage) = usage {
            authority
                .settle_paid(reservation, &usage, clock.now_ms()?)
                .await?;
        } else {
            authority.defer_paid(reservation, clock.now_ms()?).await?;
        }
    }
    journal::change(store, tokens, id, clock.now_ms()?, &[], |row| {
        row.finished = true;
        Ok(())
    })
    .await?;
    Ok(RecoveredSession {
        request_id: id.into(),
        observation: observed,
        settled: true,
    })
}

/// Called by the existing request/admin/admission event owner, never a new alarm.
/// Incomplete active leases are left alone; expired/finishing rows only settle,
/// and never redispatch an ambiguous provider attempt.
pub async fn recover_pending<
    S: QueryStore + Clone,
    I: TokenSource + Clone,
    C: AuthorityClock + Clone + 'static,
    H: RoutingHost,
>(
    store: S,
    host: H,
    clock: C,
    tokens: I,
    limit: u32,
) -> Result<Vec<RecoveredSession>, GatewayError> {
    let now = clock.now_ms()?;
    let page = store
        .query(QueryRequest {
            selector: QuerySelector::Prefix {
                prefix: journal::pending_prefix(),
                start: None,
                end: None,
            },
            reverse: false,
            limit,
            cursor: None,
            now_ms: now,
        })
        .await?;
    let mut result = vec![];
    for entry in page.entries {
        let id = entry
            .record
            .json_value()?
            .get("request_id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| journal::unavailable("Pending session identity is malformed."))?;
        if entry.key != journal::pending_key(id) {
            return Err(journal::unavailable(
                "Pending session key identity mismatch.",
            ));
        }
        let (old, row) = journal::load(&store, id).await?;
        let local_pending = row.local_work.as_ref().is_some_and(|local| {
            local.phase == gateway_core::local_work::LocalWorkPhase::TerminalPending
        });
        if !row.finished
            && row.terminal_intent.is_none()
            && !local_pending
            && row.lease_expires_at_ms > now
        {
            continue;
        }
        let fence = RevisionCheck {
            key: journal::key(id),
            expected_revision: Some(old.revision),
        };
        // CAS claims only the exact expired snapshot. Live renewals race safely.
        let claim = journal::change(
            &store,
            &tokens,
            id,
            now,
            &[RevisionCheckWire::from(&fence)],
            |j| {
                if j.terminal_intent.is_none()
                    && !j.local_work.as_ref().is_some_and(|local| {
                        local.phase == gateway_core::local_work::LocalWorkPhase::TerminalPending
                    })
                    && j.lease_expires_at_ms > now
                {
                    return Err(journal::unavailable("Routing lease is still active."));
                }
                j.recovering = true;
                Ok(())
            },
        )
        .await;
        if claim.is_err() {
            continue;
        }
        result.push(
            finish_record(
                &store,
                &tokens,
                &clock,
                &host,
                id,
                row.terminal_intent.unwrap_or_default(),
            )
            .await?,
        );
    }
    Ok(result)
}

pub(crate) fn ensure_active(row: &Journal) -> Result<(), GatewayError> {
    if row.finished || row.recovering || row.terminal_intent.is_some() {
        Err(journal::unavailable(
            "Routing session is already finalizing.",
        ))
    } else {
        Ok(())
    }
}
