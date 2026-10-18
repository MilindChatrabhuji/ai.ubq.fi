use futures_util::StreamExt;
use gateway_core::GatewayError;
use worker::{AbortSignal, Request, Response};

pub const INFERENCE_JSON_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const PASSKEY_BODY_MAX_BYTES: usize = 64 * 1024;
pub const LIVE_CALL_BODY_MAX_BYTES: usize = 1024 * 1024;
pub const SYSTEM_ONE_BODY_MAX_BYTES: usize = 262_144;

/// The actual reader is bounded even when Content-Length is absent or false.
pub async fn request_bytes(request: &mut Request, max_bytes: usize) -> Result<Vec<u8>, GatewayError> {
    let raw_body = request.inner().body();
    if let Some(length) = request.headers().get("content-length").map_err(|_| invalid_json())? {
        let canonical = !length.is_empty() && length.bytes().all(|byte| byte.is_ascii_digit()) && (length == "0" || !length.starts_with('0'));
        let length = length.parse::<u64>().ok().filter(|length| *length <= gateway_core::identity::MAX_SAFE_INTEGER as u64);
        if !canonical || length.is_none_or(|length| length > max_bytes as u64) {
            cancel_body(raw_body).await;
            return Err(invalid_json());
        }
    }
    if request.inner().body().is_none() { return Ok(Vec::new()); }
    let mut source = request.stream().map_err(|_| invalid_json())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = source.next().await {
        let mut chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => { bytes.fill(0); drop(source); cancel_body(raw_body).await; return Err(invalid_json()); }
        };
        if append_bounded(&mut bytes, &chunk, max_bytes).is_err() {
            chunk.fill(0); bytes.fill(0); drop(source); cancel_body(raw_body).await;
            return Err(invalid_json());
        }
        chunk.fill(0);
    }
    Ok(bytes)
}

/// The schema crate owns parsing, including JS UTF-8/BOM/number semantics. Raw
/// bytes remain available to the request-capture owner before explicit scrubbing.
pub async fn inference_bytes(request: &mut Request) -> Result<Vec<u8>, GatewayError> {
    request_bytes(request, INFERENCE_JSON_MAX_BYTES).await
}

pub async fn response_bytes(response: &mut Response, max_bytes: usize, signal: &AbortSignal) -> Result<Vec<u8>, GatewayError> {
    let mut source = response.stream().map_err(|_| super::platform_error("The upstream body is unavailable.", "upstream_body_unavailable"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = source.next().await {
        if signal.aborted() {
            return Err(super::platform_error("The upstream request was interrupted.", "upstream_request_interrupted"));
        }
        let chunk = chunk.map_err(|_| super::platform_error("The upstream body could not be read.", "upstream_body_read_error"))?;
        append_bounded(&mut bytes, &chunk, max_bytes).map_err(|_| super::platform_error("The upstream body exceeds its configured limit.", "upstream_body_too_large"))?;
    }
    Ok(bytes)
}

fn append_bounded(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), ()> {
    if bytes.len().checked_add(chunk.len()).is_none_or(|size| size > limit) { return Err(()); }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn invalid_json() -> GatewayError { GatewayError::new(400, "Invalid JSON body", None) }

async fn cancel_body(body: Option<worker::web_sys::ReadableStream>) {
    if let Some(body) = body { let _ = worker::wasm_bindgen_futures::JsFuture::from(body.cancel()).await; }
}

#[cfg(test)]
mod tests {
    use super::append_bounded;

    #[test]
    fn rejected_chunk_does_not_enter_the_buffer() {
        let mut bytes = vec![1, 2];
        assert!(append_bounded(&mut bytes, &[3, 4], 3).is_err());
        assert_eq!(bytes, vec![1, 2]);
        assert!(append_bounded(&mut bytes, &[3], 3).is_ok());
        assert_eq!(bytes, vec![1, 2, 3]);
    }
}
