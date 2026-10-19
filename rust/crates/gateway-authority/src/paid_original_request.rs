//! Read-only projection of the existing routing journal ownership fields.
//! No second Journal DTO, stored format, lease extension or routing dependency.
use super::{PaidRoutingReceipt, control_error, source_key};
use crate::{
    Authority, TokenSource, keys,
    paid::{PaidAttempt, PaidRequest, PaidReservation},
    quota::{ApiReservation, ApiUsageRequest, ApiUsageState, KernelReservation},
    store::Transaction,
};
use gateway_core::{
    GatewayError,
    identity::RequestContext,
    local_work::{LocalWorkPhase, journal_local_work},
    source_json::SourceJson,
    source_serialization as source,
    state::AuthorityStore,
};
use serde::de::DeserializeOwned;

fn field<T: DeserializeOwned>(value: &SourceJson, name: &str) -> Option<T> {
    source::member(value, name)?.deserialize().ok()
}
fn absent_or_null(value: &SourceJson, name: &str) -> bool {
    source::member(value, name).is_none_or(|value| value.as_str() == "null")
}

pub(super) async fn require_current<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    request: &PaidRequest,
    original: &RequestContext,
    existing: Option<&PaidReservation>,
) -> Result<(), GatewayError> {
    let error =
        || control_error("Original request ownership is missing, expired, finalizing or changed.");
    if original.request_id != request.request_id
        || original.route != request.route
        || original.started_at_ms != request.created_at_ms
        || original
            .key_id
            .as_ref()
            .is_some_and(|key| key != &request.key_id)
        || original.principal.0.trim().is_empty()
    {
        return Err(error());
    }
    let key = source_key(&[
        "uos_ai",
        "routing_runtime",
        "v1",
        "session",
        &original.request_id.0,
    ]);
    let journal = tx
        .read_source_control::<SourceJson>(&key)
        .await?
        .ok_or_else(error)?;
    // This shared data-only parser is not ownership permission; all checks below still apply.
    if journal_local_work(&journal)
        .map_err(|_| error())?
        .is_some_and(|local| local.phase != LocalWorkPhase::ProviderPlanned)
    {
        return Err(error());
    }
    let context: RequestContext = field(&journal, "context").ok_or_else(error)?;
    if &context != original
        || field::<bool>(&journal, "finished") != Some(false)
        || field::<bool>(&journal, "recovering") != Some(false)
        || field::<bool>(&journal, "semantic_committed") != Some(false)
        || !absent_or_null(&journal, "terminal_intent")
        || !field::<i64>(&journal, "lease_expires_at_ms").is_some_and(|lease| lease > tx.now)
    {
        return Err(error());
    }
    if let Some(expected) = existing {
        if expected.key_id != request.key_id
            || expected.request_id != request.request_id
            || expected.attempt_id != request.attempt_id
            || expected.provider != request.provider
            || expected.created_at_ms != request.created_at_ms
        {
            return Err(error());
        }
        let active: String = field(&journal, "active").ok_or_else(error)?;
        let attempt = source::member(&journal, "attempts")
            .and_then(|value| source::array(&value))
            .and_then(|attempts| {
                attempts
                    .into_iter()
                    .find(|attempt| field::<String>(attempt, "id").as_ref() == Some(&active))
            })
            .ok_or_else(error)?;
        let paid: PaidReservation = field(&attempt, "paid").ok_or_else(error)?;
        if &paid != expected {
            return Err(error());
        }
    } else if !absent_or_null(&journal, "active") {
        return Err(error());
    }
    let api: Option<ApiReservation> = if source::member(&journal, "api").is_none() {
        None
    } else {
        field(&journal, "api").ok_or_else(error)?
    };
    if original.key_id.is_some() && api.is_none() {
        return Err(error());
    }
    if let Some(api) = api {
        if original.key_id.as_ref() != Some(&api.key_id)
            || api.key_id != request.key_id
            || api.request_id != original.request_id
            || api.route != original.route
        {
            return Err(error());
        }
        let key = keys::api_request(
            &api.key_id.0,
            &api.policy_version,
            api.window_start_ms,
            &api.request_id.0,
        );
        let row: Option<ApiUsageRequest> = tx.read(&key).await?;
        match row {
            None if api.deferred => {}
            Some(row)
                if row.validate().is_ok()
                    && row.key_id == api.key_id
                    && row.request_id == api.request_id
                    && row.route == api.route
                    && (row.state == ApiUsageState::Dispatched
                        || (row.state == ApiUsageState::Reserved
                            && row.lease_expires_at_ms > tx.now)) => {}
            _ => return Err(error()),
        }
    }
    let kernel: Option<KernelReservation> = if source::member(&journal, "kernel").is_none() {
        None
    } else {
        field(&journal, "kernel").ok_or_else(error)?
    };
    if let Some(expected) = kernel {
        let key = keys::kernel_request(
            &expected.owner,
            expected.repo.as_deref(),
            expected.window_created_at_ms,
            &expected.request_id.0,
        );
        let row: KernelReservation = tx.read(&key).await?.ok_or_else(error)?;
        if row.validate().is_err()
            || row.request_id != original.request_id
            || row.route != original.route
            || row.owner != expected.owner
            || row.repo != expected.repo
            || row.window_created_at_ms != expected.window_created_at_ms
            || row.window_reset_at_ms != expected.window_reset_at_ms
            || row.reserved_at_ms != expected.reserved_at_ms
            || row.state.is_some()
            || row.terminal_intent.is_some()
            || row.lease_expires_at_ms <= tx.now
        {
            return Err(error());
        }
    }
    Ok(())
}
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    /// Bind the exact authenticated original context to existing same-store ownership.
    /// Input data or a route-only receipt cannot authorize paid exposure by themselves.
    pub async fn bind_paid_original_request(
        &self,
        receipt: &PaidRoutingReceipt,
        original: &RequestContext,
        now: i64,
    ) -> Result<PaidRoutingReceipt, GatewayError> {
        self.bind_original(receipt, original, None, now).await
    }
    /// Recheck only the exact already-active paid reservation; this never grants fresh exposure.
    pub async fn bind_paid_original_dispatch(
        &self,
        receipt: &PaidRoutingReceipt,
        original: &RequestContext,
        existing: &PaidReservation,
        now: i64,
    ) -> Result<PaidRoutingReceipt, GatewayError> {
        self.bind_original(receipt, original, Some(existing), now)
            .await
    }
    async fn bind_original(
        &self,
        receipt: &PaidRoutingReceipt,
        original: &RequestContext,
        existing: Option<&PaidReservation>,
        now: i64,
    ) -> Result<PaidRoutingReceipt, GatewayError> {
        for _ in 0..128 {
            let mut tx = self.transaction(self.fresh_time(now)?)?;
            self.require_paid_route(&mut tx, &receipt.request, receipt, now)
                .await?;
            require_current(&mut tx, &receipt.request, original, existing).await?;
            if let Some(expected) = existing {
                let key = keys::paid_attempt(&expected.key_id.0, &expected.attempt_id.0);
                let row: PaidAttempt = tx
                    .read_source_control(&key)
                    .await?
                    .ok_or_else(|| control_error("Existing paid history is missing or expired."))?;
                if &row.reservation != expected {
                    return Err(control_error("Active paid reservation changed."));
                }
            }
            // Recheck time against this same cached snapshot, then CAS its exact revisions.
            tx.now = self.fresh_time(tx.now)?;
            require_current(&mut tx, &receipt.request, original, existing).await?;
            let mut bound = receipt.clone();
            bound.original_request = Some(original.clone());
            bound.existing_paid = existing.cloned();
            bound.checks = tx.checks();
            if tx.commit().await? {
                return Ok(bound);
            }
        }
        Err(control_error(
            "Original request ownership changed repeatedly.",
        ))
    }
}
