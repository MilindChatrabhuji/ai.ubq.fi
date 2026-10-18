use futures_util::StreamExt;
use gateway_core::GatewayError;
use worker::{AbortSignal, Request, Response, ResponseBody};

use super::outbound::Cancellation;

pub const INFERENCE_JSON_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const PASSKEY_BODY_MAX_BYTES: usize = 64 * 1024;
pub const LIVE_CALL_BODY_MAX_BYTES: usize = 1024 * 1024;
pub const SYSTEM_ONE_BODY_MAX_BYTES: usize = 262_144;
pub const REFUSAL_PROBE_MAX_BYTES: usize = 64 * 1024;
pub const REFUSAL_PROBE_TIMEOUT_MS: i32 = 1_000;

#[derive(Default)]
pub struct ResponseCapture {
    pub bytes: Vec<u8>,
    pub complete: bool,
}

/// Inspect only a clone. Cancelling this reader must never cancel the original
/// response or wait for the other tee branch to finish.
pub async fn refusal_probe(
    response: &mut Response,
    cancellation: &Cancellation,
    timeout_ms: i32,
) -> ResponseCapture {
    let Ok(mut cloned) = response.cloned() else {
        return ResponseCapture::default();
    };
    if matches!(cloned.body(), ResponseBody::Empty) {
        return ResponseCapture {
            bytes: Vec::new(),
            complete: true,
        };
    }
    let Ok(child) = cancellation.child() else {
        return ResponseCapture::default();
    };
    let Ok(_deadline) = child.set_timeout_ms(timeout_ms) else {
        return ResponseCapture::default();
    };
    let Ok(mut source) = cloned.stream() else {
        return ResponseCapture::default();
    };
    let mut captured = ResponseCapture::default();
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
                captured.complete = !child.signal().aborted();
                break;
            }
            Some(Err(_)) => break,
            Some(Ok(chunk)) => {
                let remaining = REFUSAL_PROBE_MAX_BYTES - captured.bytes.len();
                let length = chunk.len().min(remaining);
                captured.bytes.extend_from_slice(&chunk[..length]);
                if length != chunk.len() {
                    break;
                }
            }
        }
    }
    // The pinned worker/wasm-streams reader cancels without awaiting on Drop.
    drop(source);
    captured
}

pub fn discard_response(response: &mut Response) {
    drop(response.stream());
}

/// The actual reader is bounded even when Content-Length is absent or false.
pub async fn request_bytes(
    request: &mut Request,
    max_bytes: usize,
) -> Result<Vec<u8>, GatewayError> {
    let raw_body = request.inner().body();
    if let Some(length) = request
        .headers()
        .get("content-length")
        .map_err(|_| invalid_json())?
    {
        let canonical = !length.is_empty()
            && length.bytes().all(|byte| byte.is_ascii_digit())
            && (length == "0" || !length.starts_with('0'));
        let length = length
            .parse::<u64>()
            .ok()
            .filter(|length| *length <= gateway_core::identity::MAX_SAFE_INTEGER as u64);
        if !canonical || length.is_none_or(|length| length > max_bytes as u64) {
            cancel_body(raw_body).await;
            return Err(invalid_json());
        }
    }
    if request.inner().body().is_none() {
        return Ok(Vec::new());
    }
    let mut source = request.stream().map_err(|_| invalid_json())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = source.next().await {
        let mut chunk = match chunk {
            Ok(chunk) => chunk,
            Err(_) => {
                bytes.fill(0);
                drop(source);
                cancel_body(raw_body).await;
                return Err(invalid_json());
            }
        };
        if append_bounded(&mut bytes, &chunk, max_bytes).is_err() {
            chunk.fill(0);
            bytes.fill(0);
            drop(source);
            cancel_body(raw_body).await;
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

pub async fn response_bytes(
    response: &mut Response,
    max_bytes: usize,
    signal: &AbortSignal,
) -> Result<Vec<u8>, GatewayError> {
    if matches!(response.body(), ResponseBody::Empty) {
        return Ok(Vec::new());
    }
    let mut source = response.stream().map_err(|_| {
        super::platform_error(
            "The upstream body is unavailable.",
            "upstream_body_unavailable",
        )
    })?;
    let mut bytes = Vec::new();
    while let Some(chunk) = source.next().await {
        if signal.aborted() {
            return Err(super::platform_error(
                "The upstream request was interrupted.",
                "upstream_request_interrupted",
            ));
        }
        let chunk = chunk.map_err(|_| {
            super::platform_error(
                "The upstream body could not be read.",
                "upstream_body_read_error",
            )
        })?;
        append_bounded(&mut bytes, &chunk, max_bytes).map_err(|_| {
            super::platform_error(
                "The upstream body exceeds its configured limit.",
                "upstream_body_too_large",
            )
        })?;
    }
    Ok(bytes)
}

fn append_bounded(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> Result<(), ()> {
    if bytes
        .len()
        .checked_add(chunk.len())
        .is_none_or(|size| size > limit)
    {
        return Err(());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn invalid_json() -> GatewayError {
    GatewayError::new(400, "Invalid JSON body", None)
}

async fn cancel_body(body: Option<worker::web_sys::ReadableStream>) {
    if let Some(body) = body {
        let _ = worker::wasm_bindgen_futures::JsFuture::from(body.cancel()).await;
    }
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
