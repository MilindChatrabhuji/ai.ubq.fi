//! Source live-call multipart boundary. No account selection or inference admission.
use std::collections::BTreeMap;

use futures_util::StreamExt;
use gateway_core::GatewayError;
use gateway_live_runtime::{
    protocol::{validate_body_read, validate_declared_length},
    types::{LIVE_CALL_BODY_TIMEOUT_MS, LIVE_CALL_MAX_BODY_BYTES, LiveCreateInput},
};
use worker::js_sys::Uint8Array;
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{Method, Request, RequestInit};

use crate::transport::outbound::Cancellation;

pub async fn parse_create(
    request: &mut Request,
    cancellation: &Cancellation,
    headers: BTreeMap<String, String>,
) -> Result<LiveCreateInput, GatewayError> {
    let content_type = request
        .headers()
        .get("content-type")
        .map_err(|_| malformed())?
        .unwrap_or_default();
    let media = content_type.split(';').next().unwrap_or("").trim();
    if !media.eq_ignore_ascii_case("multipart/form-data")
        || !content_type.to_ascii_lowercase().contains("boundary=")
    {
        return Err(invalid(
            "Live call creation requires multipart/form-data with a declared boundary.",
        ));
    }
    let bytes = read_body(request, cancellation).await?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(request.headers().clone())
        .with_body(Some(Uint8Array::from(bytes.as_slice()).into()));
    let mut recreated =
        Request::new_with_init(request.url().map_err(|_| malformed())?.as_str(), &init)
            .map_err(|_| malformed())?;
    let form: JsValue = recreated.form_data().await.map_err(|_| malformed())?.into();
    let form = form
        .dyn_into::<worker::web_sys::FormData>()
        .map_err(|_| malformed())?;
    // Native FormData.get returns the first part, including File-valued text.
    let sdp = part_text(form.get("sdp")).await?;
    if sdp.as_ref().is_none_or(|text| text.is_empty()) {
        return Err(
            invalid("Live call creation requires a non-empty `sdp` part.").with_param(Some("sdp")),
        );
    }
    let session = part_text(form.get("session")).await?;
    if session.is_none() {
        return Err(
            invalid("Live call creation requires a `session` part.").with_param(Some("session"))
        );
    }
    Ok(LiveCreateInput {
        content_type,
        sdp,
        session,
        headers,
    })
}

async fn part_text(value: JsValue) -> Result<Option<String>, GatewayError> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    if let Some(text) = value.as_string() {
        return Ok(Some(text));
    }
    let file = value
        .dyn_into::<worker::web_sys::File>()
        .map_err(|_| malformed())?;
    worker::wasm_bindgen_futures::JsFuture::from(file.text())
        .await
        .map_err(|_| malformed())?
        .as_string()
        .map(Some)
        .ok_or_else(malformed)
}

async fn read_body(
    request: &mut Request,
    cancellation: &Cancellation,
) -> Result<Vec<u8>, GatewayError> {
    let declared = request
        .headers()
        .get("content-length")
        .map_err(|_| malformed())?;
    if let Err(error) = validate_declared_length(declared.as_deref()) {
        // Dropping the pinned actual reader cancels without awaiting a stalled
        // caller's cancellation promise, matching the source bounded reader.
        if error.status == 413
            && let Ok(source) = request.stream()
        {
            drop(source);
        }
        return Err(error);
    }
    if request.inner().body().is_none() {
        return Ok(Vec::new());
    }
    let child = cancellation.child()?;
    let _deadline = child.set_timeout_ms(LIVE_CALL_BODY_TIMEOUT_MS as i32)?;
    let mut source = request.stream().map_err(|_| incomplete())?;
    let mut bytes = Vec::new();
    let mut complete = false;
    loop {
        let next = std::future::poll_fn(|context| {
            child.register_waker(context.waker());
            if child.signal().aborted() {
                std::task::Poll::Ready(None)
            } else {
                source.poll_next_unpin(context)
            }
        })
        .await;
        match next {
            None => {
                complete = !child.signal().aborted();
                break;
            }
            Some(Err(_)) => break,
            Some(Ok(chunk)) => {
                let remaining = LIVE_CALL_MAX_BODY_BYTES + 1 - bytes.len();
                let length = remaining.min(chunk.len());
                bytes.extend_from_slice(&chunk[..length]);
                if length != chunk.len() || bytes.len() > LIVE_CALL_MAX_BODY_BYTES {
                    break;
                }
            }
        }
    }
    drop(source);
    validate_body_read(bytes.len(), complete)?;
    Ok(bytes)
}

fn invalid(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_request_error"))
}
fn malformed() -> GatewayError {
    invalid("Live call creation multipart body could not be parsed.")
}
fn incomplete() -> GatewayError {
    invalid("Live call creation body could not be read completely.")
}
