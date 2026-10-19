//! Authoritative source-wire errors; diagnostics never replace the original body.
use std::rc::Rc;

use gateway_core::GatewayError;
use gateway_routing_runtime::{RoutingError, SourceRefusalBody};
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

/// Only the existing numeric billing fragment enters the scalar cost helper.
/// The authoritative catalog row and opaque model identifier never become Value.
pub(crate) fn pricing_metadata(
    rows: &[gateway_core::source_json::SourceJson],
    model: &gateway_core::model::ModelId,
    require_provider_cost: bool,
) -> Option<serde_json::Value> {
    use gateway_core::source_serialization as source;
    let row = rows.iter().find(|row| {
        source::member(row, "id")
            .and_then(|id| source::string(&id))
            .is_some_and(|id| id == *model.as_js_string())
    });
    let Some(row) = row else {
        return require_provider_cost.then(|| serde_json::json!({"require_provider_cost":true}));
    };
    let mut fields = serde_json::Map::new();
    for name in [
        "input_price_per_token",
        "output_price_per_token",
        "cache_read_price_per_token",
        "cache_write_price_per_token",
        "require_provider_cost",
    ] {
        if let Some(value) = source::member(row, name)
            .and_then(|value| value.deserialize::<serde_json::Value>().ok())
        {
            fields.insert(name.into(), value);
        }
    }
    if require_provider_cost {
        fields.insert(
            "require_provider_cost".into(),
            serde_json::Value::Bool(true),
        );
    }
    Some(serde_json::Value::Object(fields))
}
