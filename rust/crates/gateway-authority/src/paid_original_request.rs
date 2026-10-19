//! Read-only projection of the existing routing journal ownership fields.
//! No second Journal DTO, stored format, lease extension or routing dependency.
use super::{PaidRoutingReceipt, control_error, source_key};
use crate::{
    Authority, TokenSource, keys,
    paid::PaidRequest,
    quota::{ApiReservation, ApiUsageRequest, ApiUsageState, KernelReservation},
    store::Transaction,
};
use gateway_core::{GatewayError, identity::RequestContext, state::AuthorityStore};
use serde_json::Value;

pub(super) async fn require_current<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    request: &PaidRequest,
    original: &RequestContext,
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
    let journal = tx.read::<Value>(&key).await?.ok_or_else(error)?;
    let context: RequestContext =
        serde_json::from_value(journal["context"].clone()).map_err(|_| error())?;
    if journal["v"].as_u64() != Some(1)
        || &context != original
        || journal["finished"].as_bool() != Some(false)
        || journal["recovering"].as_bool() != Some(false)
        || journal["semantic_committed"].as_bool() != Some(false)
        || !journal.get("terminal_intent").is_none_or(Value::is_null)
        || !journal.get("active").is_none_or(Value::is_null)
        || !journal["lease_expires_at_ms"]
            .as_i64()
            .is_some_and(|lease| lease > tx.now)
    {
        return Err(error());
    }
    let api: Option<ApiReservation> =
        serde_json::from_value(journal.get("api").cloned().unwrap_or(Value::Null))
            .map_err(|_| error())?;
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
    let kernel: Option<KernelReservation> =
        serde_json::from_value(journal.get("kernel").cloned().unwrap_or(Value::Null))
            .map_err(|_| error())?;
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
        for _ in 0..128 {
            let mut tx = self.transaction(self.fresh_time(now)?)?;
            self.require_paid_route(&mut tx, &receipt.request, receipt, now)
                .await?;
            require_current(&mut tx, &receipt.request, original).await?;
            tx.now = self.fresh_time(tx.now)?;
            require_current(&mut tx, &receipt.request, original).await?;
            let mut bound = receipt.clone();
            bound.original_request = Some(original.clone());
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
