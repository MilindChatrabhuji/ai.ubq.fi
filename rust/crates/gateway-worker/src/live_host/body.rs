//! Streaming call answers and bounded replacement errors. No extra SDP-answer limit is invented.
use std::{collections::BTreeMap, rc::Rc, task::Poll};

use futures_util::StreamExt;
use gateway_auth::provider_credentials::CodexSourceAccount;
use gateway_core::GatewayError;
use gateway_live_runtime::types::{
    LIVE_CALL_CAPTURE_TIMEOUT_MS, LIVE_CALL_CAPTURED_ERROR_MAX_BYTES, LIVE_CALL_HEADERS_TIMEOUT_MS,
    LIVE_CALLS_PATH, LiveCreateRequest, LiveDispatchAttempt, LiveDispatchFailure, LiveResponse,
};
use worker::js_sys::Uint8Array;
use worker::wasm_bindgen::JsCast;
use worker::wasm_bindgen_futures::JsFuture;
use worker::{Context, Headers, Response, ResponseBody};

use crate::{
    host::{PlatformHost, setting},
    transport::{
        outbound::{Cancellation, PinnedDestination},
        stream::{ObservationHandle, ObservedStream},
    },
};

pub enum Body {
    Bytes(Vec<u8>),
    Upstream {
        response: Response,
        cancellation: Rc<Cancellation>,
    },
}

pub(super) fn error(error: GatewayError) -> LiveResponse<Body> {
    LiveResponse {
        status: error.status,
        status_text: None,
        headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
        body: Body::Bytes(serde_json::to_vec(&error.envelope).expect("fixed error serializes")),
    }
}

fn unreachable() -> GatewayError {
    GatewayError::new(
        502,
        "Codex upstream request failed: upstream unreachable.",
        Some("codex_upstream_unreachable"),
    )
}

pub(super) async fn send<F, Fut>(
    platform: &PlatformHost,
    account: &CodexSourceAccount,
    request: LiveCreateRequest,
    before_dispatch: F,
) -> Result<LiveResponse<Body>, LiveDispatchFailure<Body>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), GatewayError>>,
{
    let prepare = || -> Result<_, GatewayError> {
        let cancellation = Rc::new(platform.cancellation.child()?);
        let deadline = cancellation.set_timeout_ms(LIVE_CALL_HEADERS_TIMEOUT_MS as i32)?;
        let base = setting(&platform.env, "CODEX_BASE_URL")
            .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
        let url = format!(
            "{}{LIVE_CALLS_PATH}",
            gateway_schema::util::js_trim(&base).trim_end_matches('/')
        );
        PinnedDestination::new(&url)?;
        let headers = Headers::new();
        for (name, value) in request.headers {
            headers.set(&name, &value).map_err(|_| unreachable())?;
        }
        headers
            .set(
                "authorization",
                &format!("Bearer {}", account.access_token.expose()),
            )
            .map_err(|_| unreachable())?;
        headers
            .set("chatgpt-account-id", &account.account_id)
            .map_err(|_| unreachable())?;
        let init = worker::web_sys::RequestInit::new();
        init.set_method("POST");
        init.set_redirect(worker::web_sys::RequestRedirect::Manual);
        init.set_headers(headers.as_ref());
        init.set_body(&Uint8Array::from(request.body.as_bytes()).into());
        init.set_signal(Some(&cancellation.signal()));
        let request = worker::web_sys::Request::new_with_str_and_init(&url, &init)
            .map_err(|_| unreachable())?;
        Ok((request, cancellation, deadline))
    };
    let failure = |error, attempt| LiveDispatchFailure {
        response: self::error(error),
        attempt,
    };
    let (request, cancellation, deadline) =
        prepare().map_err(|e| failure(e, LiveDispatchAttempt::NotStarted))?;
    before_dispatch()
        .await
        .map_err(|e| failure(e, LiveDispatchAttempt::NotStarted))?;
    if cancellation.signal().aborted() {
        return Err(failure(unreachable(), LiveDispatchAttempt::NotStarted));
    }
    let scope: worker::web_sys::WorkerGlobalScope = worker::js_sys::global().unchecked_into();
    // No await occurs between the current-owner fence and this actual fetch invocation.
    let result = JsFuture::from(scope.fetch_with_request(&request)).await;
    drop(deadline);
    let result = result.map_err(|_| {
        let error = if cancellation.signal().aborted() && !cancellation.client_aborted() {
            GatewayError::new(504, "Codex upstream exceeded the gateway deadline before response headers were received.", Some("gateway_timeout"))
        } else { unreachable() };
        failure(error, LiveDispatchAttempt::Started)
    })?;
    let raw: worker::web_sys::Response = result
        .dyn_into()
        .map_err(|_| failure(unreachable(), LiveDispatchAttempt::Started))?;
    let status_text = Some(raw.status_text());
    let response = Response::from(raw);
    Ok(LiveResponse {
        status: response.status_code(),
        status_text,
        headers: response.headers().entries().collect(),
        body: Body::Upstream {
            response,
            cancellation,
        },
    })
}

pub(super) async fn capture(
    mut response: LiveResponse<Body>,
    parent: &Cancellation,
) -> LiveResponse<Body> {
    response.headers.retain(|name, _| name == "content-type");
    let mut bytes = Vec::new();
    match response.body {
        Body::Bytes(mut body) => {
            body.truncate(LIVE_CALL_CAPTURED_ERROR_MAX_BYTES);
            bytes = body;
        }
        Body::Upstream {
            mut response,
            cancellation: _cancellation,
        } => {
            if let Ok(child) = parent.child()
                && let Ok(_deadline) = child.set_timeout_ms(LIVE_CALL_CAPTURE_TIMEOUT_MS as i32)
                && let Ok(mut source) = response.stream()
            {
                loop {
                    let next = std::future::poll_fn(|cx| {
                        child.register_waker(cx.waker());
                        if child.signal().aborted() {
                            Poll::Ready(None)
                        } else {
                            source.poll_next_unpin(cx)
                        }
                    })
                    .await;
                    match next {
                        Some(Ok(chunk)) => {
                            let length = chunk
                                .len()
                                .min(LIVE_CALL_CAPTURED_ERROR_MAX_BYTES - bytes.len());
                            bytes.extend_from_slice(&chunk[..length]);
                            if length < chunk.len()
                                || bytes.len() == LIVE_CALL_CAPTURED_ERROR_MAX_BYTES
                            {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
                // Pinned stream cancellation on Drop releases the original replaced response.
                drop(source);
            }
        }
    }
    response.body = Body::Bytes(bytes);
    response
}

pub fn into_response(
    response: LiveResponse<Body>,
    context: Rc<Context>,
) -> Result<crate::GatewayResponse, GatewayError> {
    let headers = Headers::new();
    for (name, value) in response.headers {
        headers.set(&name, &value).map_err(|_| unreachable())?;
    }
    let output = match response.body {
        Body::Bytes(bytes) => Response::from_bytes(bytes).map_err(|_| unreachable())?,
        Body::Upstream {
            mut response,
            cancellation,
        } => {
            if matches!(response.body(), ResponseBody::Empty) {
                Response::empty().map_err(|_| unreachable())?
            } else {
                let stream = response.stream().map_err(|_| unreachable())?;
                ObservedStream::new(
                    stream,
                    ObservationHandle::default(),
                    context,
                    cancellation,
                    None,
                    Box::new(|_| Box::pin(async {})),
                )
                .into_response()
                .map_err(|_| unreachable())?
            }
        }
    };
    let raw: worker::web_sys::Response = output.into();
    let init = worker::web_sys::ResponseInit::new();
    init.set_status(response.status);
    if let Some(status_text) = response.status_text {
        init.set_status_text(&status_text);
    }
    init.set_headers(headers.as_ref());
    let raw = worker::web_sys::Response::new_with_opt_readable_stream_and_init(
        raw.body().as_ref(),
        &init,
    )
    .map_err(|_| unreachable())?;
    Ok(crate::GatewayResponse::Raw(raw))
}
