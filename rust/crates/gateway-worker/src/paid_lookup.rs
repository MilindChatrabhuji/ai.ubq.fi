//! Fixed OpenLux billing lookup; missing evidence remains unresolved spend.
use std::collections::BTreeMap;

use gateway_authority::paid::{PaidAttempt, PaidCorrelation, PaidReservation, PaidUsage};
use gateway_core::{GatewayError, provider::PaidProvider, state::AuthorityStore};
use gateway_schema::util::{js_trim, safe_integer};
use serde_json::Value;
use worker::{Method, Url};

use crate::{
    authority::RemoteAuthorityStore,
    host::setting,
    storage::now_ms,
    transport::outbound::{Cancellation, PinnedDestination, send_http},
};

fn number(value: Option<&Value>) -> Option<i64> {
    value.and_then(safe_integer).filter(|number| *number >= 0)
}
fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|value| !value.is_empty())
}

fn usage(row: &Value, wanted: &str) -> Option<PaidUsage> {
    let other = match row.get("other") {
        Some(Value::String(value)) => serde_json::from_str::<Value>(value).ok(),
        value => value.cloned(),
    };
    let id = text(row.get("request_id"))
        .or_else(|| text(other.as_ref().and_then(|value| value.get("request_id"))))?;
    if id != wanted {
        return None;
    }
    let model = text(row.get("model_name"))?;
    let quota = number(row.get("quota"))?;
    let mut input = number(row.get("prompt_tokens"))?;
    let output = number(row.get("completion_tokens"))?;
    number(row.get("created_at"))?;
    let mut cached = number(row.get("cached_prompt_tokens"));
    if gateway_providers::anthropic::is_claude(model)
        && other
            .as_ref()
            .and_then(|value| value.get("claude"))
            .and_then(Value::as_bool)
            == Some(true)
    {
        if let Some(read) = number(other.as_ref().and_then(|value| value.get("cache_tokens"))) {
            let write = match other
                .as_ref()
                .and_then(|value| value.get("cache_creation_tokens"))
            {
                None => Some(0),
                value => number(value),
            };
            if let Some(total) = write
                .and_then(|write| input.checked_add(read)?.checked_add(write))
                .filter(|value| *value <= gateway_core::identity::MAX_SAFE_INTEGER)
            {
                input = total;
                cached = Some(read);
            }
        }
    }
    Some(PaidUsage {
        provider_quota: quota as f64,
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        correlation: PaidCorrelation::ProviderRequestId(id.to_owned()),
    })
}

pub async fn lookup(
    store: &RemoteAuthorityStore,
    env: &worker::Env,
    reservation: &PaidReservation,
) -> Result<Option<PaidUsage>, GatewayError> {
    if reservation.provider == PaidProvider::Surplus {
        return Ok(None);
    }
    let row = store
        .read(&gateway_authority::keys::paid_attempt(
            &reservation.key_id.0,
            &reservation.attempt_id.0,
        ))
        .await?
        .ok_or_else(|| unavailable("The paid attempt is unavailable."))?;
    let attempt: PaidAttempt = serde_json::from_value(row.json_value()?.clone())
        .map_err(|_| unavailable("The paid attempt is invalid."))?;
    if attempt.v != 1 || attempt.reservation != *reservation {
        return Err(unavailable(
            "The billing lookup does not match its admitted attempt.",
        ));
    }
    let Some(wanted) = attempt
        .provider_request_id
        .as_deref()
        .map(js_trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    else {
        return Ok(None);
    };
    let key = setting(env, "METERED_API_KEY")
        .or_else(|| setting(env, "OPENLUX_API_KEY"))
        .filter(|value| !js_trim(value).is_empty())
        .ok_or_else(|| unavailable("The owned OpenLux billing credential is unavailable."))?;
    let cancellation = Cancellation::background()?;
    let _deadline = cancellation.set_timeout_ms(10_000)?;
    let start = reservation.created_at_ms.saturating_sub(60_000).max(0) / 1000;
    let end = now_ms()?.saturating_add(60_000).max(0).saturating_add(999) / 1000;
    for page in 1..=100 {
        let mut url = Url::parse("https://api.openlux.ai/api/log/token")
            .map_err(|_| unavailable("The fixed billing URL is invalid."))?;
        url.query_pairs_mut()
            .append_pair("key", &key)
            .append_pair("page", &page.to_string())
            .append_pair("page_size", "100")
            .append_pair("start_timestamp", &start.to_string())
            .append_pair("end_timestamp", &end.to_string());
        let destination = PinnedDestination::new(url.as_str())?;
        let mut response = send_http(
            &destination,
            Method::Get,
            &BTreeMap::from([("Accept".into(), "application/json".into())]),
            &[],
            &cancellation,
            || async { Ok(()) },
        )
        .await
        .map_err(|failure| failure.error)?;
        if !(200..300).contains(&response.status_code()) {
            return Err(unavailable(
                "The billing log endpoint returned an unsuccessful response.",
            ));
        }
        // The source helper has no additional body ceiling; its overall ten-second
        // signal and real platform memory limits still apply through this read.
        let bytes = response
            .bytes()
            .await
            .map_err(|_| unavailable("The billing log response could not be read."))?;
        let text = String::from_utf8_lossy(&bytes);
        let envelope: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text))
            .map_err(|_| unavailable("The billing log response is invalid JSON."))?;
        if envelope.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(unavailable("The billing log response envelope is invalid."));
        }
        let data = envelope
            .get("data")
            .ok_or_else(|| unavailable("The billing log response is missing its data."))?;
        let items = data
            .as_array()
            .or_else(|| data.get("items").and_then(Value::as_array))
            .ok_or_else(|| unavailable("The billing log response items are invalid."))?;
        for item in items {
            if let Some(usage) = usage(item, &wanted) {
                return Ok(Some(usage));
            }
        }
        let total = number(data.get("total")).unwrap_or(items.len() as i64);
        if page * 100 >= total || items.is_empty() {
            break;
        }
    }
    Ok(None)
}

fn unavailable(message: &str) -> GatewayError {
    GatewayError::new(502, message, Some("metered_logs_unavailable"))
}
