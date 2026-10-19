//! Fixed OpenLux billing transport over the shared source-derived lookup plan.
use gateway_authority::paid::{PaidAttempt, PaidCorrelation, PaidReservation, PaidUsage};
use gateway_core::{GatewayError, provider::PaidProvider, state::AuthorityStore};
use gateway_providers::paid_lookup::{
    LookupPlan, LookupStep, OVERALL_TIMEOUT_MS, TokenLog, plan_lookup,
};
use serde_json::Value;
use worker::Method;

use crate::{
    authority::RemoteAuthorityStore,
    host::provider_secret,
    storage::now_ms,
    transport::outbound::{Cancellation, PinnedDestination, send_http},
};

fn usage(row: TokenLog) -> PaidUsage {
    PaidUsage {
        provider_quota: row.quota,
        input_tokens: row.prompt_tokens,
        cached_input_tokens: row.cached_prompt_tokens,
        output_tokens: row.completion_tokens,
        correlation: PaidCorrelation::ProviderRequestId(row.request_id),
    }
}

pub(crate) async fn stored_attempt(
    store: &RemoteAuthorityStore,
    reservation: &PaidReservation,
) -> Result<PaidAttempt, GatewayError> {
    let key =
        gateway_authority::keys::paid_attempt(&reservation.key_id.0, &reservation.attempt_id.0);
    let row = store
        .read(&key)
        .await?
        .ok_or_else(|| unavailable("The paid attempt is unavailable."))?;
    let attempt = gateway_authority::paid::decode_paid_attempt_record(&key, &row)?;
    if attempt.v != 3 || attempt.reservation != *reservation {
        return Err(unavailable(
            "The billing lookup does not match its admitted attempt.",
        ));
    }
    Ok(attempt)
}

pub(crate) async fn terminal_usage(
    store: &RemoteAuthorityStore,
    reservation: &PaidReservation,
    usage: Option<&gateway_core::source_usage::UsageTokens>,
    pricing: Option<&gateway_core::source_json::SourceJson>,
) -> Result<Option<PaidUsage>, GatewayError> {
    if reservation.provider != PaidProvider::Surplus {
        return Ok(None);
    }
    let attempt = stored_attempt(store, reservation).await?;
    Ok(gateway_authority::paid::surplus_usage_from_source(
        &attempt, usage, pricing,
    ))
}

pub async fn lookup(
    store: &RemoteAuthorityStore,
    env: &worker::Env,
    reservation: &PaidReservation,
) -> Result<Option<PaidUsage>, GatewayError> {
    if reservation.provider == PaidProvider::Surplus {
        return Ok(None);
    }
    let attempt = stored_attempt(store, reservation).await?;
    let LookupPlan::Openlux(mut plan) = plan_lookup(
        reservation.provider,
        attempt.provider_request_id.as_deref(),
        reservation.created_at_ms,
        now_ms()?,
    )?
    else {
        return Ok(None);
    };
    let key = provider_secret(env, "METERED_API_KEY")
        .or_else(|| provider_secret(env, "OPENLUX_API_KEY"))
        .ok_or_else(|| unavailable("The owned OpenLux billing credential is unavailable."))?;
    let cancellation = Cancellation::background()?;
    let timeout = i32::try_from(OVERALL_TIMEOUT_MS)
        .map_err(|_| unavailable("The shared billing deadline is invalid."))?;
    let _deadline = cancellation.set_timeout_ms(timeout)?;
    while let Some(page) = plan.next_request(&key)? {
        let destination = PinnedDestination::new(page.url())?;
        let mut response = send_http(
            &destination,
            Method::Get,
            page.headers(),
            &[],
            &cancellation,
            || async { Ok(()) },
        )
        .await
        .map_err(|failure| failure.error)?;
        let status = response.status_code();
        let body = if (200..300).contains(&status) {
            // Source has no additional body ceiling. The same overall signal
            // owns every fetch and complete body read across all pages.
            let bytes = response
                .bytes()
                .await
                .map_err(|_| unavailable("The billing log response could not be read."))?;
            let text = String::from_utf8_lossy(&bytes);
            serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
        } else {
            crate::transport::body::discard_response(&mut response);
            None
        };
        match plan.accept_page(&page, status, body.as_ref())? {
            LookupStep::Continue => {}
            LookupStep::Complete(found) => return Ok(found.map(usage)),
        }
    }
    Ok(None)
}

fn unavailable(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("metered_logs_unavailable"))
}
