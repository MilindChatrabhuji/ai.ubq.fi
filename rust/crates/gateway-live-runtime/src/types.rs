use std::{collections::BTreeMap, future::Future};

use gateway_core::{GatewayError, js_string::JsString16, source_json::SourceJson};

pub const LIVE_CALL_MAX_BODY_BYTES: usize = 1_048_576;
pub const LIVE_CALL_BODY_TIMEOUT_MS: u64 = 5_000;
pub const LIVE_CALL_CAPTURED_ERROR_MAX_BYTES: usize = 8_192;
pub const LIVE_CALL_CAPTURE_TIMEOUT_MS: u64 = 1_000;
pub const LIVE_CALL_HEADERS_TIMEOUT_MS: u64 = 1_800_000;
pub const LIVE_CALL_ACCOUNT_TTL_MS: i64 = 3_600_000;
pub const LIVE_RETIRE_RETRY_MS: u64 = 250;
pub const LIVE_SIDEBAND_MAX_PAYLOAD_BYTES: usize = 4 * 1_048_576;
pub const LIVE_SIDEBAND_MAX_BUFFERED_BYTES: usize = 8 * 1_048_576;
pub const LIVE_SIDEBAND_PREOPEN_MAX_FRAMES: usize = 32;
pub const LIVE_SIDEBAND_HANDSHAKE_TIMEOUT_MS: u64 = 10_000;
pub const LIVE_OPENAI_ALPHA_DEFAULT: &str = "quicksilver=v2";
pub const LIVE_CALLS_PATH: &str = "/realtime/calls?intent=quicksilver&architecture=avas";

/// These are already-decoded FIRST multipart parts, not a caller-selected JSON endpoint.
pub struct LiveCreateInput {
    pub content_type: String,
    pub sdp: Option<String>,
    pub session: Option<String>,
    /// Lowercase header names from the actual HTTP adapter.
    pub headers: BTreeMap<String, String>,
}

/// The trusted host adds its current Account credentials and configured Codex origin.
pub struct LiveCreateRequest {
    pub body: SourceJson,
    pub headers: BTreeMap<String, String>,
}

#[derive(Debug)]
pub struct LiveResponse<B> {
    pub status: u16,
    pub status_text: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub body: B,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveDispatchAttempt {
    NotStarted,
    /// Actual transport invocation: a cancellation/error cannot prove no upstream call exists.
    Started,
}

pub struct LiveDispatchFailure<B> {
    pub response: LiveResponse<B>,
    pub attempt: LiveDispatchAttempt,
}

/// Implemented by the host's CURRENT account/credential-owner handle, never request JSON.
pub trait LiveAccount {
    fn account_id(&self) -> &str;
}

pub trait LiveHost {
    type Account: LiveAccount;
    type Body;
    type Cancellation;

    fn now_ms(&self) -> i64;
    fn user_agent(&self) -> String;
    fn body_from_bytes(&self, body: Vec<u8>) -> Self::Body;
    /// Reuse the existing strong global serial selector, then current-owner renewal/reconciliation.
    /// It must never add terminal inference admission, a paid fallback or a second authority.
    fn select_account(
        &self,
        model: Option<&JsString16>,
        attempted: &[String],
        cancel: &Self::Cancellation,
    ) -> impl Future<Output = Result<Self::Account, LiveResponse<Self::Body>>>;
    /// Missing mapped account is404, unreadable pool503. Resolve the same account's current token
    /// through its existing credential owner on EVERY reconnect; not the creation generation.
    fn current_account(
        &self,
        account_id: &str,
    ) -> impl Future<Output = Result<Self::Account, LiveResponse<Self::Body>>>;
    /// Fixed configured Codex base + LIVE_CALLS_PATH, manual redirects, caller cancellation and
    /// LIVE_CALL_HEADERS_TIMEOUT_MS. Enforce current account/owner fences before actual dispatch.
    /// No request URL/bearer is accepted. The returned Body retains real upstream stream ownership.
    fn dispatch_create(
        &self,
        account: &Self::Account,
        request: LiveCreateRequest,
        cancel: &Self::Cancellation,
    ) -> impl Future<Output = Result<LiveResponse<Self::Body>, LiveDispatchFailure<Self::Body>>>;
    fn invalidate_credential(
        &self,
        account: &Self::Account,
    ) -> impl Future<Output = Result<(), GatewayError>>;
    fn response_health(
        &self,
        account: &Self::Account,
        response: &LiveResponse<Self::Body>,
    ) -> impl Future<Output = ()>;
    fn transport_health(
        &self,
        account: &Self::Account,
        failure: &LiveDispatchFailure<Self::Body>,
    ) -> impl Future<Output = ()>;
    fn await_routing_transition(&self) -> impl Future<Output = ()>;
    /// Consume/cancel the actual failed response with the exported8192byte/1000ms bounds and
    /// caller cancellation, preserving status/statusText and only Content-Type (source behavior).
    fn capture_retry(
        &self,
        response: LiveResponse<Self::Body>,
        cancel: &Self::Cancellation,
    ) -> impl Future<Output = LiveResponse<Self::Body>>;
}

pub(crate) fn response_error<H: LiveHost>(host: &H, error: GatewayError) -> LiveResponse<H::Body> {
    LiveResponse {
        status: error.status,
        status_text: None,
        headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
        body: host.body_from_bytes(
            serde_json::to_vec(&error.envelope).expect("fixed error envelope serializes"),
        ),
    }
}

pub(crate) fn invalid(status: u16, message: &str) -> GatewayError {
    GatewayError::new(status, message, Some("invalid_request_error"))
}
