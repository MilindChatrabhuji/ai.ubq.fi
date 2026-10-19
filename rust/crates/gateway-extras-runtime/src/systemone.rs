use crate::{store::*, types::*};
use gateway_core::source_json::SourceJson;
use gateway_core::{GatewayError, lifecycle::SemanticTerminal, query::QueryStore};
use gateway_providers::extras;
use gateway_schema::selection::ProviderSelection;
use serde_json::{Value, json};
fn health(status: Option<u16>, kind: HealthKind) -> HealthObservation {
    HealthObservation {
        provider: ExtrasProvider::SystemOne,
        kind,
        upstream_status: status,
    }
}
fn observed(status: u16) -> HealthObservation {
    health(
        Some(status),
        match status {
            401 | 403 => HealthKind::AuthInvalid,
            402 | 429 => HealthKind::QuotaExhausted,
            500.. => HealthKind::UpstreamError,
            400.. => HealthKind::Reachable,
            _ => HealthKind::Success,
        },
    )
}
pub(crate) async fn systemone<S: QueryStore, H: ExtrasHost>(
    store: &S,
    host: &H,
    request: &ExtrasRequest<'_>,
) -> Result<ExtrasResponse, GatewayError> {
    if request.raw_body_bytes > 262_144 {
        return Ok(ExtrasResponse::error(GatewayError::new(
            400,
            "Invalid JSON body",
            Some("invalid_request_error"),
        )));
    }
    // Validation precedes provider control/credential checks in the source handler.
    let preliminary = extras::prepare_source_systemone(
        &request.body,
        &gateway_providers::types::PrepareOptions::default(),
    );
    if let Err(e) = preliminary {
        return Ok(ExtrasResponse::source_error(e));
    }
    let row = store
        .read(&key(json!(["uos_ai", "provider_selection", "v1"])))
        .await?;
    let value: Option<Value> = decoded(row.as_ref(), now(host)?)?;
    let selection = value.as_ref().and_then(ProviderSelection::normalize);
    if !ProviderSelection::enabled(selection.as_ref(), "openrouter") {
        return Ok(ExtrasResponse::error(GatewayError::new(
            503,
            "System One provider is disabled by the provider selection",
            Some("systemone_provider_disabled"),
        )));
    }
    let Some(options) = host.provider_options(ExtrasProvider::SystemOne).await? else {
        return Ok(ExtrasResponse::error(GatewayError::new(
            503,
            "System One upstream is not configured",
            Some("openrouter_api_key_missing"),
        )));
    };
    let prepared = match extras::prepare_source_systemone(&request.body, &options) {
        Ok(prepared) => prepared,
        Err(error) => return Ok(ExtrasResponse::source_error(error)),
    };
    let result = host
        .dispatch(ExtrasDispatch::SystemOne(PreparedCall {
            prepared,
            deadline_ms: now(host)? + 20_000,
        }))
        .await;
    match result {
        Err(failure) => {
            if failure.origin == DispatchFailureOrigin::Gateway {
                let mut r = ExtrasResponse::error(failure.error.as_ref().clone());
                r.headers.extend(failure.headers.clone());
                r.upstream_errors.push(failure);
                return Ok(r);
            }
            let mut r = ExtrasResponse::error(GatewayError::new(
                502,
                "System One upstream unreachable",
                Some("openrouter_upstream_unreachable"),
            ));
            if !failure.before_transport {
                r.health.push(health(None, HealthKind::UpstreamError));
            }
            r.upstream_errors.push(failure);
            Ok(r)
        }
        Ok(result) => {
            if !(200..300).contains(&result.status) {
                let status = if matches!(result.status, 400 | 429) {
                    result.status
                } else {
                    502
                };
                let mut r = ExtrasResponse::error(GatewayError::new(
                    status,
                    "System One upstream error",
                    Some("openrouter_upstream_error"),
                ));
                r.health.push(observed(result.status));
                r.upstream_errors.push(DispatchFailure {
                    origin: DispatchFailureOrigin::Upstream,
                    error: Box::new(GatewayError::new(
                        status,
                        "System One upstream error",
                        Some("openrouter_upstream_error"),
                    )),
                    headers: result.headers,
                    quota_refusal: false,
                    upstream_status: Some(result.status),
                    retry_after_ms: None,
                    before_transport: false,
                    raw_error_body: Some(result.body),
                });
                return Ok(r);
            }
            let payload = SourceJson::parse_bytes(&result.body).ok();
            let decoded = payload
                .as_ref()
                .ok_or_else(|| {
                    GatewayError::new(
                        502,
                        "System One upstream invalid response",
                        Some("openrouter_upstream_invalid_response"),
                    )
                })
                .and_then(extras::decode_source_systemone);
            match decoded {
                Err(e) => {
                    let mut r = ExtrasResponse::error(e);
                    r.health.push(health(None, HealthKind::UpstreamError));
                    Ok(r)
                }
                Ok(payload) => {
                    let usage = gateway_core::source_serialization::member(&payload, "usage")
                        .as_ref()
                        .and_then(extras::source_systemone_usage);
                    let mut r = ExtrasResponse::source_json(200, payload);
                    r.semantic_terminal = Some(SemanticTerminal::Completed);
                    r.usage = usage;
                    r.health.push(observed(200));
                    Ok(r)
                }
            }
        }
    }
}
