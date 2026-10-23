//! Authoritative source-wire errors; diagnostics never replace the original body.
use std::rc::Rc;

use gateway_core::GatewayError;
use gateway_routing_runtime::types::{RoutingError, SourceRefusalBody};
use worker::Response;

use crate::inference_capture::Capture;

pub(crate) async fn error_response(
    error: RoutingError,
    capture: &Rc<Capture>,
) -> Result<Response, GatewayError> {
    let Some(body) = error.source_body else {
        return Err(*error.error);
    };
    let content_type = match &body {
        SourceRefusalBody::Json(_) => "application/json",
        SourceRefusalBody::InternalServerError => "text/plain; charset=utf-8",
    };
    let mut response = Response::from_bytes(body.as_bytes().to_vec())
        .map_err(|_| unavailable())?
        .with_status(error.error.status);
    response
        .headers_mut()
        .set("content-type", content_type)
        .map_err(|_| unavailable())?;
    response
        .headers_mut()
        .set("cache-control", "no-store")
        .map_err(|_| unavailable())?;
    for (name, value) in error.headers {
        response
            .headers_mut()
            .set(&name, &value)
            .map_err(|_| unavailable())?;
    }
    capture.immediate(error.error.status, body.as_bytes()).await;
    Ok(response)
}
fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The source refusal could not be rendered.",
        "source_refusal_unavailable",
    )
}

/// Retain actual plan pricing data and the existing Messages cost requirement.
pub(crate) fn pricing_metadata(
    pricing: Option<&gateway_core::source_json::SourceJson>,
    require_provider_cost: bool,
) -> Result<Option<gateway_core::source_json::SourceJson>, GatewayError> {
    use gateway_core::{
        js_string::JsString16, source_json::SourceJson, source_serialization as source,
    };
    if !require_provider_cost {
        return Ok(pricing.cloned());
    }
    let key = JsString16::from_utf8("require_provider_cost");
    let mut fields = match pricing {
        Some(pricing) => pricing.object_entries()?,
        None => Vec::new(),
    };
    fields.retain(|(name, _)| name != &key);
    fields.push((key, SourceJson::from_serializable(&true)?));
    Ok(Some(source::object_keys(fields)?))
}
