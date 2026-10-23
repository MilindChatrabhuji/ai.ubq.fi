//! Paid ledger v3: exposure, terminal evidence and correlated billing are independent.
use gateway_core::GatewayError;
use gateway_core::identity::{ApiKeyId, MicrocreditLimit, PaidAttemptId};
use gateway_core::lifecycle::{BillingState, DispatchState, PaidTerminalState};
use gateway_core::provider::PaidProvider;
use gateway_core::state::AuthorityStore;

use crate::paid_control::PaidRoutingReceipt;
use crate::quota::ApiKeyPolicy;
use crate::routing::validate_cohort;
use crate::store::Transaction;
use crate::{
    Authority, DAY_MS, PAID_RETENTION_MS, TokenSource, add, invalid, keys, nonnegative, positive,
    quota_error, retention, text, unavailable,
};

pub use crate::paid_types::*;
mod source_usage;
pub use source_usage::surplus_usage_from_source;
mod source_records;
pub use source_records::{decode_paid_attempt_record, decode_paid_rollup_record};

fn pending_id(key: &ApiKeyId, attempt: &PaidAttemptId) -> String {
    serde_json::json!([key.0, attempt.0]).to_string()
}

fn validate_attempt(row: &PaidAttempt, expected: &PaidReservation) -> Result<(), GatewayError> {
    if row.v != 3 || row.reservation != *expected {
        return Err(invalid("Paid attempt identity conflicts."));
    }
    nonnegative(row.reservation.reserved_microcredits)?;
    positive(row.quota_per_credit)?;
    nonnegative(row.reconciliation_attempts)?;
    if let Some(spend) = row.spend_microcredits {
        nonnegative(spend)?;
    }
    Ok(())
}

fn validate_paid_window(row: &PaidWindow, key: &ApiKeyId, reset: i64) -> Result<(), GatewayError> {
    if row.v != 3 || &row.key_id != key || row.window_reset_at_ms != reset {
        return Err(invalid("Paid window identity conflicts."));
    }
    nonnegative(row.settled_microcredits)?;
    nonnegative(row.reserved_microcredits)?;
    nonnegative(row.pending_count)?;
    MicrocreditLimit::try_from(row.limit_microcredits)
        .map_err(|_| invalid("Invalid paid window limit."))?;
    Ok(())
}

async fn read_gate<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
) -> Result<ReconciliationGate, GatewayError> {
    Ok(tx.read(&keys::paid_gate()).await?.unwrap_or_default())
}

fn arm_gate(gate: &mut ReconciliationGate) {
    gate.next_due_at_ms = gate
        .pending
        .values()
        .map(|row| row.next_reconciliation_at_ms)
        .min();
}

async fn clear_nonbillable_marker<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    key_id: &ApiKeyId,
    attempt_id: &PaidAttemptId,
) -> Result<(), GatewayError> {
    let pending_key = keys::paid_pending(&key_id.0, &attempt_id.0);
    let pending: Option<PendingPaid> = tx.read(&pending_key).await?;
    let mut gate = read_gate(tx).await?;
    let indexed = gate
        .pending
        .remove(&pending_id(key_id, attempt_id))
        .is_some();
    if pending.is_some() {
        tx.delete(&pending_key)?;
    }
    if pending.is_some() || indexed {
        arm_gate(&mut gate);
        tx.put(&keys::paid_gate(), &gate, None)?;
    }
    Ok(())
}

fn provider_label(provider: PaidProvider) -> &'static str {
    match provider {
        PaidProvider::Surplus => "surplus",
        PaidProvider::Metered => "metered",
    }
}

/// Source FNV-1a uses UTF-16 code units; preserve that mapping for historical rollup joins.
pub fn rollup_shard(request: &str) -> u8 {
    let mut hash: u32 = 2_166_136_261;
    for code in request.encode_utf16() {
        hash = (hash ^ u32::from(code)).wrapping_mul(16_777_619);
    }
    (hash % 16) as u8
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn reserve_paid(
        &self,
        input: &PaidRequest,
        authorization: &PaidAuthorization,
        receipt: &PaidRoutingReceipt,
        now: i64,
    ) -> Result<PaidAdmission, GatewayError> {
        if receipt.original_request.is_none() {
            return Err(unavailable(
                "paid_control_unavailable",
                "Original request ownership is required before paid reservation.",
            ));
        }
        text(&input.key_id.0)?;
        text(&input.request_id.0)?;
        text(&input.attempt_id.0)?;
        if gateway_schema::reasoning::js_trim_source(input.model.as_js_string())
            .as_units()
            .is_empty()
        {
            return Err(invalid("Paid model is missing."));
        }
        text(&input.route)?;
        text(&input.path)?;
        nonnegative(input.created_at_ms)?;
        if input.created_at_ms > now {
            return Err(invalid("Paid request creation time is in the future."));
        }
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let policy: ApiKeyPolicy = tx
                .read_source_control(&keys::api_policy(&input.key_id.0))
                .await?
                .ok_or_else(|| {
                    unavailable("paid_fallback_unavailable", "Paid policy is missing.")
                })?;
            policy.validate(&input.key_id, now)?;
            if !policy.paid_fallback_enabled
                || !policy
                    .paid_fallback_models
                    .iter()
                    .any(|model| model == &input.model)
            {
                return Err(unavailable(
                    "paid_fallback_unavailable",
                    "Paid fallback is disabled or this model is not allowed.",
                ));
            }
            let routing = self
                .require_paid_route(&mut tx, input, receipt, now)
                .await?;
            match authorization {
                PaidAuthorization::DirectPaidModel => {
                    if routing.codex_enabled && routing.codex_models.contains(&input.model) {
                        return Err(unavailable(
                            "codex_routing_unavailable",
                            "A Codex model requires current full-pool proof before paid fallback.",
                        ));
                    }
                }
                PaidAuthorization::SubscriptionUnavailable(proof) => {
                    if !proof.unavailable
                        || proof.bindings.is_empty()
                        || proof.model() != &input.model
                    {
                        return Err(unavailable(
                            "codex_routing_unavailable",
                            "Full subscription-pool proof is missing.",
                        ));
                    }
                    if !validate_cohort(&mut tx, proof, false).await? {
                        return Err(unavailable(
                            "codex_routing_unavailable",
                            "Subscription-pool proof is stale or expired.",
                        ));
                    }
                }
                PaidAuthorization::ClaudeSubscriptionUnavailable(proof) => {
                    if routing.codex_enabled && routing.codex_models.contains(&input.model) {
                        return Err(unavailable(
                            "codex_routing_unavailable",
                            "Claude evidence cannot replace current Codex full-pool proof.",
                        ));
                    }
                    self.require_claude_proof(&mut tx, proof, &input.model, now)
                        .await?;
                }
            }
            let deletion: Option<serde_json::Value> =
                tx.read(&keys::paid_deletion(&input.key_id.0)).await?;
            if deletion.is_some() {
                return Err(unavailable(
                    "paid_fallback_unavailable",
                    "Paid history deletion is in progress.",
                ));
            }
            let key = keys::paid_attempt(&input.key_id.0, &input.attempt_id.0);
            if let Some(existing) = tx.read_source_control::<PaidAttempt>(&key).await? {
                if receipt
                    .existing_paid
                    .as_ref()
                    .is_some_and(|expected| expected != &existing.reservation)
                {
                    return Err(invalid("Existing-only paid reservation changed."));
                }
                if existing.reservation.request_id != input.request_id
                    || existing.reservation.provider != input.provider
                    || existing.model != input.model
                    || existing.route != input.route
                    || matches!(
                        existing.billing_state,
                        BillingState::Settled | BillingState::NotBilled
                    )
                {
                    return Err(invalid("Paid attempt identity is consumed or conflicts."));
                }
                validate_attempt(&existing, &existing.reservation)?;
                if let PaidAuthorization::ClaudeSubscriptionUnavailable(proof) = authorization {
                    self.require_claude_proof(&mut tx, proof, &input.model, now)
                        .await?;
                }
                tx.now = self.fresh_time(tx.now.max(now))?;
                if let PaidAuthorization::SubscriptionUnavailable(proof) = authorization
                    && !validate_cohort(&mut tx, proof, false).await?
                {
                    return Err(unavailable(
                        "codex_routing_unavailable",
                        "Subscription-pool proof expired before paid reservation.",
                    ));
                }
                self.require_paid_route(&mut tx, input, receipt, now)
                    .await?;
                if tx.commit().await? {
                    return Ok(PaidAdmission::Existing(existing.reservation));
                } else {
                    continue;
                }
            }
            if receipt.existing_paid.is_some() {
                return Err(unavailable(
                    "paid_control_unavailable",
                    "Existing paid history is missing or expired; dispatch cannot create exposure.",
                ));
            }
            let limit = MicrocreditLimit::try_from(policy.paid_fallback_limit_microcredits)
                .map_err(|_| invalid("Paid limit is invalid."))?;
            positive(policy.paid_fallback_quota_per_credit)?;
            let (_, reset) = policy.current_window(input.created_at_ms)?;
            let version = format!(
                "{}:{}",
                policy.window_ms, policy.paid_fallback_pricing_checked_at_ms
            );
            let window_key = keys::paid_window(&input.key_id.0, reset);
            let mut window: Option<PaidWindow> = tx.read(&window_key).await?;
            let exposure = match limit {
                MicrocreditLimit::Unlimited => 0,
                MicrocreditLimit::Bounded(_) => {
                    let maximum = *policy
                        .paid_fallback_max_exposure_microcredits
                        .get(&input.model)
                        .ok_or_else(|| invalid("Paid model exposure is missing."))?;
                    positive(maximum)?;
                    let row = window.get_or_insert(PaidWindow {
                        v: 3,
                        key_id: input.key_id.clone(),
                        policy_version: version.clone(),
                        window_reset_at_ms: reset,
                        limit_microcredits: policy.paid_fallback_limit_microcredits,
                        settled_microcredits: 0,
                        reserved_microcredits: 0,
                        pending_count: 0,
                        updated_at_ms: now,
                    });
                    validate_paid_window(row, &input.key_id, reset)?;
                    row.policy_version = version.clone();
                    row.limit_microcredits = policy.paid_fallback_limit_microcredits;
                    let used = add(row.settled_microcredits, row.reserved_microcredits)?;
                    if used >= row.limit_microcredits {
                        return Err(quota_error(
                            "Paid fallback limit exceeded.",
                            "paid_fallback_limit_exceeded",
                        ));
                    }
                    maximum.min(row.limit_microcredits - used)
                }
            };
            let reservation = PaidReservation {
                key_id: input.key_id.clone(),
                request_id: input.request_id.clone(),
                attempt_id: input.attempt_id.clone(),
                provider: input.provider,
                window_reset_at_ms: reset,
                created_at_ms: input.created_at_ms,
                reserved_microcredits: exposure,
            };
            let row = PaidAttempt {
                v: 3,
                reservation: reservation.clone(),
                policy_version: version,
                model: input.model.clone(),
                route: input.route.clone(),
                path: input.path.clone(),
                stream: input.stream,
                reasoning: input.reasoning.clone(),
                quota_per_credit: policy.paid_fallback_quota_per_credit,
                provider_request_id: None,
                dispatch_state: DispatchState::Dispatched,
                terminal_state: PaidTerminalState::Pending,
                billing_state: BillingState::Pending,
                provider_quota: None,
                input_tokens: None,
                cached_input_tokens: None,
                output_tokens: None,
                spend_microcredits: None,
                transport_started: false,
                reconciliation_attempts: 0,
                last_reconciliation_at_ms: None,
                dispatched_at_ms: Some(now),
                terminal_at_ms: None,
                settled_at_ms: None,
                updated_at_ms: now,
                usage_rollup_at_ms: None,
            };
            let pending = PendingPaid {
                key_id: input.key_id.clone(),
                attempt_id: input.attempt_id.clone(),
                created_at_ms: now,
                next_reconciliation_at_ms: now,
            };
            let pending_key = keys::paid_pending(&input.key_id.0, &input.attempt_id.0);
            let _: Option<PendingPaid> = tx.read(&pending_key).await?;
            let mut gate = read_gate(&mut tx).await?;
            gate.pending.insert(
                pending_id(&input.key_id, &input.attempt_id),
                pending.clone(),
            );
            arm_gate(&mut gate);
            tx.put_source_control(
                &key,
                &row,
                Some(retention(input.created_at_ms, PAID_RETENTION_MS)?),
            )?;
            tx.put(&pending_key, &pending, None)?;
            tx.put(&keys::paid_gate(), &gate, None)?;
            if let MicrocreditLimit::Bounded(_) = limit {
                let mut window = window.ok_or_else(|| invalid("Paid window is missing."))?;
                window.reserved_microcredits = add(window.reserved_microcredits, exposure)?;
                window.pending_count = add(window.pending_count, 1)?;
                window.updated_at_ms = now;
                tx.put(
                    &window_key,
                    &window,
                    Some(retention(reset, PAID_RETENTION_MS)?),
                )?;
            }
            if let PaidAuthorization::ClaudeSubscriptionUnavailable(proof) = authorization {
                self.require_claude_proof(&mut tx, proof, &input.model, now)
                    .await?;
            }
            tx.now = self.fresh_time(tx.now.max(now))?;
            if let PaidAuthorization::SubscriptionUnavailable(proof) = authorization
                && !validate_cohort(&mut tx, proof, false).await?
            {
                return Err(unavailable(
                    "codex_routing_unavailable",
                    "Subscription-pool proof expired before paid reservation.",
                ));
            }
            self.require_paid_route(&mut tx, input, receipt, now)
                .await?;
            if tx.commit().await? {
                return Ok(PaidAdmission::Reserved(reservation));
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Paid admission changed concurrently.",
        ))
    }

    pub async fn mark_paid_transport_started(
        &self,
        reservation: &PaidReservation,
        now: i64,
    ) -> Result<(), GatewayError> {
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let key = keys::paid_attempt(&reservation.key_id.0, &reservation.attempt_id.0);
            let mut row: PaidAttempt = tx
                .read_source_control(&key)
                .await?
                .ok_or_else(|| invalid("Paid reservation is missing."))?;
            validate_attempt(&row, reservation)?;
            if row.dispatch_state != DispatchState::Dispatched
                || row.billing_state == BillingState::NotBilled
            {
                return Err(invalid("Paid attempt cannot dispatch."));
            }
            row.transport_started = true;
            tx.put_source_control(
                &key,
                &row,
                Some(retention(reservation.created_at_ms, PAID_RETENTION_MS)?),
            )?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Paid dispatch changed concurrently.",
        ))
    }

    pub async fn record_paid_lifecycle(
        &self,
        reservation: &PaidReservation,
        provider_request_id: Option<&str>,
        terminal: Option<PaidTerminalState>,
        now: i64,
    ) -> Result<(), GatewayError> {
        if let Some(id) = provider_request_id {
            text(id)?;
        }
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let key = keys::paid_attempt(&reservation.key_id.0, &reservation.attempt_id.0);
            let mut row: PaidAttempt = tx
                .read_source_control(&key)
                .await?
                .ok_or_else(|| invalid("Paid attempt is missing."))?;
            validate_attempt(&row, reservation)?;
            if let Some(id) = provider_request_id
                && row.provider_request_id.is_none()
            {
                row.provider_request_id = Some(id.to_owned());
            }
            if row.terminal_state == PaidTerminalState::Pending
                && let Some(terminal) = terminal
            {
                row.terminal_state = terminal;
                if terminal != PaidTerminalState::Pending {
                    row.terminal_at_ms = Some(now);
                }
            }
            row.updated_at_ms = now;
            let pending_key = keys::paid_pending(&reservation.key_id.0, &reservation.attempt_id.0);
            if let Some(mut pending) = tx.read::<PendingPaid>(&pending_key).await? {
                pending.next_reconciliation_at_ms = now;
                let mut gate = read_gate(&mut tx).await?;
                gate.pending.insert(
                    pending_id(&reservation.key_id, &reservation.attempt_id),
                    pending.clone(),
                );
                arm_gate(&mut gate);
                tx.put(&pending_key, &pending, None)?;
                tx.put(&keys::paid_gate(), &gate, None)?;
            }
            tx.put_source_control(
                &key,
                &row,
                Some(retention(reservation.created_at_ms, PAID_RETENTION_MS)?),
            )?;
            if tx.commit().await? {
                return Ok(());
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Paid lifecycle changed concurrently.",
        ))
    }

    pub async fn release_paid_before_transport(
        &self,
        reservation: &PaidReservation,
        now: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let key = keys::paid_attempt(&reservation.key_id.0, &reservation.attempt_id.0);
            let mut row: PaidAttempt = tx
                .read_source_control(&key)
                .await?
                .ok_or_else(|| invalid("Paid attempt is missing."))?;
            validate_attempt(&row, reservation)?;
            if row.billing_state != BillingState::Pending
                || row.provider_request_id.is_some()
                || row.transport_started
                || row.dispatch_state == DispatchState::NotDispatched
            {
                return Ok(false);
            }
            let pending_key = keys::paid_pending(&reservation.key_id.0, &reservation.attempt_id.0);
            let _: Option<PendingPaid> = tx.read(&pending_key).await?;
            let window_key =
                keys::paid_window(&reservation.key_id.0, reservation.window_reset_at_ms);
            let window: Option<PaidWindow> = tx.read(&window_key).await?;
            let mut gate = read_gate(&mut tx).await?;
            gate.pending
                .remove(&pending_id(&reservation.key_id, &reservation.attempt_id));
            arm_gate(&mut gate);
            row.dispatch_state = DispatchState::NotDispatched;
            row.terminal_state = PaidTerminalState::Cancelled;
            row.billing_state = BillingState::NotBilled;
            row.spend_microcredits = Some(0);
            row.terminal_at_ms.get_or_insert(now);
            row.updated_at_ms = now;
            tx.put_source_control(
                &key,
                &row,
                Some(retention(reservation.created_at_ms, PAID_RETENTION_MS)?),
            )?;
            tx.delete(&pending_key)?;
            tx.put(&keys::paid_gate(), &gate, None)?;
            if let Some(mut window) = window {
                validate_paid_window(&window, &reservation.key_id, reservation.window_reset_at_ms)?;
                window.reserved_microcredits =
                    (window.reserved_microcredits - reservation.reserved_microcredits).max(0);
                window.pending_count = (window.pending_count - 1).max(0);
                window.updated_at_ms = now;
                tx.put(
                    &window_key,
                    &window,
                    Some(retention(window.window_reset_at_ms, PAID_RETENTION_MS)?),
                )?;
            }
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Paid release changed concurrently.",
        ))
    }

    pub async fn settle_paid(
        &self,
        reservation: &PaidReservation,
        usage: &PaidUsage,
        now: i64,
    ) -> Result<bool, GatewayError> {
        if !usage.provider_quota.is_finite() || usage.provider_quota < 0.0 {
            return Err(invalid("Provider usage is invalid."));
        }
        nonnegative(usage.input_tokens)?;
        nonnegative(usage.output_tokens)?;
        if let Some(cached) = usage.cached_input_tokens {
            nonnegative(cached)?;
        }
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let key = keys::paid_attempt(&reservation.key_id.0, &reservation.attempt_id.0);
            let Some(mut row) = tx.read_source_control::<PaidAttempt>(&key).await? else {
                clear_nonbillable_marker(&mut tx, &reservation.key_id, &reservation.attempt_id)
                    .await?;
                if tx.commit().await? {
                    return Ok(false);
                }
                continue;
            };
            validate_attempt(&row, reservation)?;
            let pending_key = keys::paid_pending(&reservation.key_id.0, &reservation.attempt_id.0);
            let pending: Option<PendingPaid> = tx.read(&pending_key).await?;
            let mut gate = read_gate(&mut tx).await?;
            if matches!(
                row.billing_state,
                BillingState::Settled | BillingState::NotBilled
            ) {
                if pending.is_some() {
                    tx.delete(&pending_key)?;
                    gate.pending
                        .remove(&pending_id(&reservation.key_id, &reservation.attempt_id));
                    arm_gate(&mut gate);
                    tx.put(&keys::paid_gate(), &gate, None)?;
                }
                if tx.commit().await? {
                    return Ok(false);
                } else {
                    continue;
                }
            }
            if pending.is_none() {
                return Ok(false);
            }
            let exact = match &usage.correlation {
                PaidCorrelation::ProviderRequestId(id)
                    if row.reservation.provider == PaidProvider::Metered =>
                {
                    if row.provider_request_id.as_ref() != Some(id) {
                        return Ok(false);
                    }
                    None
                }
                PaidCorrelation::SurplusReservation {
                    attempt_id,
                    buyer_cost_micro,
                } if row.reservation.provider == PaidProvider::Surplus
                    && attempt_id == &row.reservation.attempt_id =>
                {
                    *buyer_cost_micro
                }
                _ => return Ok(false),
            };
            let spend = if let Some(exact) = exact {
                nonnegative(exact)?
            } else {
                let value =
                    (usage.provider_quota * 1_000_000.0 / row.quota_per_credit as f64).round();
                if !value.is_finite()
                    || value < 0.0
                    || value > gateway_core::identity::MAX_SAFE_INTEGER as f64
                {
                    return Err(invalid("Provider spend is outside the safe integer range."));
                }
                value as i64
            };
            let window_key =
                keys::paid_window(&reservation.key_id.0, reservation.window_reset_at_ms);
            let window: Option<PaidWindow> = tx.read(&window_key).await?;
            let bucket = reservation.created_at_ms / 3_600_000 * 3_600_000;
            let model = gateway_core::model::ModelId::from_source(
                gateway_schema::reasoning::js_trim_source(row.model.as_js_string()),
            );
            let rollup_key = keys::paid_rollup_model(
                bucket,
                &model,
                provider_label(reservation.provider),
                rollup_shard(&reservation.attempt_id.0),
            );
            let mut rollup: PaidRollup =
                tx.read_source_control(&rollup_key)
                    .await?
                    .unwrap_or(PaidRollup {
                        v: 1,
                        bucket_start_at_ms: bucket,
                        model: model.clone(),
                        provider: reservation.provider,
                        request_count: 0,
                        provider_quota: 0.0,
                        input_tokens: 0,
                        cached_input_tokens: 0,
                        output_tokens: 0,
                        spend_microcredits: 0.0,
                        first_request_at_ms: reservation.created_at_ms,
                        last_request_at_ms: reservation.created_at_ms,
                        updated_at_ms: now,
                    });
            source_records::validate_rollup_identity(&rollup, &rollup_key)?;
            rollup.request_count = add(rollup.request_count, 1)?;
            rollup.input_tokens = add(rollup.input_tokens, usage.input_tokens)?;
            rollup.cached_input_tokens = add(
                rollup.cached_input_tokens,
                usage.cached_input_tokens.unwrap_or(0),
            )?;
            rollup.output_tokens = add(rollup.output_tokens, usage.output_tokens)?;
            rollup.spend_microcredits += spend as f64;
            if !rollup.spend_microcredits.is_finite() || rollup.spend_microcredits < 0.0 {
                return Err(invalid("Paid rollup spend overflow."));
            }
            rollup.provider_quota += usage.provider_quota;
            if !rollup.provider_quota.is_finite() {
                return Err(invalid("Paid rollup quota overflow."));
            }
            rollup.first_request_at_ms = rollup.first_request_at_ms.min(reservation.created_at_ms);
            rollup.last_request_at_ms = rollup.last_request_at_ms.max(reservation.created_at_ms);
            rollup.updated_at_ms = now;
            row.billing_state = BillingState::Settled;
            row.provider_quota = Some(usage.provider_quota);
            row.input_tokens = Some(usage.input_tokens);
            row.cached_input_tokens = usage.cached_input_tokens;
            row.output_tokens = Some(usage.output_tokens);
            row.spend_microcredits = Some(spend);
            row.settled_at_ms.get_or_insert(now);
            row.last_reconciliation_at_ms = Some(now);
            row.updated_at_ms = now;
            row.usage_rollup_at_ms = Some(now);
            gate.pending
                .remove(&pending_id(&reservation.key_id, &reservation.attempt_id));
            arm_gate(&mut gate);
            tx.put_source_control(
                &key,
                &row,
                Some(retention(reservation.created_at_ms, PAID_RETENTION_MS)?),
            )?;
            tx.delete(&pending_key)?;
            tx.put(&keys::paid_gate(), &gate, None)?;
            tx.put_source_control(&rollup_key, &rollup, None)?;
            if let Some(mut window) = window {
                validate_paid_window(&window, &reservation.key_id, reservation.window_reset_at_ms)?;
                window.settled_microcredits = add(window.settled_microcredits, spend)?;
                window.reserved_microcredits =
                    (window.reserved_microcredits - reservation.reserved_microcredits).max(0);
                window.pending_count = (window.pending_count - 1).max(0);
                window.updated_at_ms = now;
                tx.put(
                    &window_key,
                    &window,
                    Some(retention(window.window_reset_at_ms, PAID_RETENTION_MS)?),
                )?;
            }
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Paid settlement changed concurrently.",
        ))
    }

    /// Event-owned recovery only. No timer/alarm is introduced by this module.
    pub async fn due_paid(&self, now: i64, limit: usize) -> Result<Vec<PendingPaid>, GatewayError> {
        let mut tx = self.transaction(now)?;
        let gate = read_gate(&mut tx).await?;
        let mut due: Vec<_> = gate
            .pending
            .into_values()
            .filter(|row| row.next_reconciliation_at_ms <= now)
            .collect();
        due.sort_by_key(|row| row.next_reconciliation_at_ms);
        due.truncate(limit);
        Ok(due)
    }

    pub async fn defer_paid(
        &self,
        reservation: &PaidReservation,
        now: i64,
    ) -> Result<Option<i64>, GatewayError> {
        const DELAYS: [i64; 6] = [5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000];
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let key = keys::paid_attempt(&reservation.key_id.0, &reservation.attempt_id.0);
            let Some(mut row) = tx.read_source_control::<PaidAttempt>(&key).await? else {
                clear_nonbillable_marker(&mut tx, &reservation.key_id, &reservation.attempt_id)
                    .await?;
                if tx.commit().await? {
                    return Ok(None);
                }
                continue;
            };
            validate_attempt(&row, reservation)?;
            let pending_key = keys::paid_pending(&reservation.key_id.0, &reservation.attempt_id.0);
            let Some(mut pending) = tx.read::<PendingPaid>(&pending_key).await? else {
                return Ok(None);
            };
            if matches!(
                row.billing_state,
                BillingState::Settled | BillingState::NotBilled
            ) {
                return Ok(None);
            }
            row.reconciliation_attempts = add(row.reconciliation_attempts, 1)?;
            let delay = DELAYS[((row.reconciliation_attempts - 1).min(5)) as usize];
            if now - reservation.created_at_ms >= DAY_MS {
                row.billing_state = BillingState::Unresolved;
            }
            row.last_reconciliation_at_ms = Some(now);
            row.updated_at_ms = now;
            pending.next_reconciliation_at_ms = add(now, delay)?;
            let mut gate = read_gate(&mut tx).await?;
            gate.pending.insert(
                pending_id(&reservation.key_id, &reservation.attempt_id),
                pending.clone(),
            );
            arm_gate(&mut gate);
            tx.put_source_control(
                &key,
                &row,
                Some(retention(reservation.created_at_ms, PAID_RETENTION_MS)?),
            )?;
            tx.put(&pending_key, &pending, None)?;
            tx.put(&keys::paid_gate(), &gate, None)?;
            if tx.commit().await? {
                return Ok(Some(delay));
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Paid reconciliation changed concurrently.",
        ))
    }

    /// Expired raw evidence may leave a durable marker. Remove only that stale wake-up;
    /// never infer zero billing or refund an old window's reserved exposure.
    pub async fn reconcile_paid_marker(
        &self,
        key_id: &ApiKeyId,
        attempt_id: &PaidAttemptId,
        now: i64,
    ) -> Result<bool, GatewayError> {
        text(&key_id.0)?;
        text(&attempt_id.0)?;
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let row: Option<PaidAttempt> = tx
                .read(&keys::paid_attempt(&key_id.0, &attempt_id.0))
                .await?;
            if row.is_some_and(|row| {
                !matches!(
                    row.billing_state,
                    BillingState::Settled | BillingState::NotBilled
                )
            }) {
                return Ok(false);
            }
            clear_nonbillable_marker(&mut tx, key_id, attempt_id).await?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Paid marker reconciliation changed concurrently.",
        ))
    }

    pub async fn claim_paid_reconciliation(
        &self,
        key_id: &ApiKeyId,
        now: i64,
    ) -> Result<Option<ReconciliationLease>, GatewayError> {
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let key = keys::paid_lease(&key_id.0);
            if tx
                .read::<ReconciliationLease>(&key)
                .await?
                .is_some_and(|lease| lease.expires_at_ms > now)
            {
                return Ok(None);
            }
            let lease = ReconciliationLease {
                token: self.tokens.next_token()?,
                expires_at_ms: add(now, 60_000)?,
            };
            text(&lease.token)?;
            tx.put(&key, &lease, Some(lease.expires_at_ms))?;
            if tx.commit().await? {
                return Ok(Some(lease));
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Reconciliation lease changed concurrently.",
        ))
    }

    pub async fn release_paid_reconciliation(
        &self,
        key_id: &ApiKeyId,
        expected: &ReconciliationLease,
        now: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..128 {
            let mut tx = self.transaction(now)?;
            let key = keys::paid_lease(&key_id.0);
            if tx.read::<ReconciliationLease>(&key).await?.as_ref() != Some(expected) {
                return Ok(false);
            }
            tx.delete(&key)?;
            if tx.commit().await? {
                return Ok(true);
            }
        }
        Err(unavailable(
            "paid_fallback_unavailable",
            "Reconciliation lease release changed concurrently.",
        ))
    }
}
