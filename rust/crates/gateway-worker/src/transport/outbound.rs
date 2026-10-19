use std::collections::BTreeMap;
use std::rc::Rc;
use std::task::Waker;

use futures_util::task::AtomicWaker;

use gateway_core::GatewayError;
use worker::js_sys::{Reflect, Uint8Array};
use worker::wasm_bindgen::closure::Closure;
use worker::wasm_bindgen::{JsCast, JsValue};
use worker::{
    AbortSignal, Fetch, Headers, Method, Request, RequestInit, RequestRedirect, Response, Url,
};

/// Constructed by trusted provider/native-host configuration, not request JSON.
pub struct PinnedDestination {
    url: Url,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchAttempt {
    NotStarted,
    /// The actual fetch API was invoked; transport failure does not prove no spend.
    Started,
}

pub struct DispatchFailure {
    pub error: GatewayError,
    pub attempt: DispatchAttempt,
    pub origin: DispatchOrigin,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchOrigin {
    Gateway,
    Transport,
}

impl From<GatewayError> for DispatchFailure {
    fn from(error: GatewayError) -> Self {
        Self {
            error,
            attempt: DispatchAttempt::NotStarted,
            origin: DispatchOrigin::Gateway,
        }
    }
}

impl PinnedDestination {
    pub fn new(url: &str) -> Result<Self, GatewayError> {
        let url = Url::parse(url).map_err(|_| configuration_error())?;
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(configuration_error());
        }
        Ok(Self { url })
    }
}

/// Owns event listeners until the whole upstream body/stream finishes, not only
/// until response headers arrive. Drop removes the listener without leaking it.
pub struct Cancellation {
    controller: worker::web_sys::AbortController,
    incoming: worker::web_sys::AbortSignal,
    listener: Closure<dyn FnMut()>,
    waker: Rc<AtomicWaker>,
}

impl Cancellation {
    pub fn from_request(request: &Request) -> Result<Self, GatewayError> {
        Self::from_signal(request.inner().signal())
    }

    pub fn child(&self) -> Result<Self, GatewayError> {
        Self::from_signal(self.controller.signal())
    }

    /// Event-owned billing is independent of a caller's delivery cancellation.
    pub fn background() -> Result<Self, GatewayError> {
        let incoming =
            worker::web_sys::AbortController::new().map_err(|_| configuration_error())?;
        Self::from_signal(incoming.signal())
    }

    fn from_signal(incoming: worker::web_sys::AbortSignal) -> Result<Self, GatewayError> {
        let controller =
            worker::web_sys::AbortController::new().map_err(|_| configuration_error())?;
        let forwarded = controller.clone();
        let waker = Rc::new(AtomicWaker::new());
        let wake = waker.clone();
        let listener = Closure::wrap(Box::new(move || {
            forwarded.abort();
            wake.wake();
        }) as Box<dyn FnMut()>);
        incoming
            .add_event_listener_with_callback("abort", listener.as_ref().unchecked_ref())
            .map_err(|_| configuration_error())?;
        if incoming.aborted() {
            controller.abort();
        }
        Ok(Self {
            controller,
            incoming,
            listener,
            waker,
        })
    }

    pub fn signal(&self) -> AbortSignal {
        self.controller.signal().into()
    }

    pub fn abort(&self) {
        self.controller.abort();
        self.waker.wake();
    }

    /// A quiet upstream may never produce another chunk after caller abort.
    /// Wake the outgoing Rust stream directly from the actual platform signal.
    pub fn register_waker(&self, waker: &Waker) {
        self.waker.register(waker);
    }

    pub fn client_aborted(&self) -> bool {
        self.incoming.aborted()
    }

    /// Remaining time computed from the route's absolute host-policy deadline.
    pub fn set_timeout_ms(&self, milliseconds: i32) -> Result<Deadline, GatewayError> {
        if milliseconds < 0 {
            return Err(configuration_error());
        }
        let controller = self.controller.clone();
        let wake = self.waker.clone();
        let callback = Closure::wrap(Box::new(move || {
            controller.abort();
            wake.wake();
        }) as Box<dyn FnMut()>);
        let global = worker::js_sys::global();
        let set_timeout = Reflect::get(&global, &JsValue::from_str("setTimeout"))
            .map_err(|_| configuration_error())?
            .dyn_into::<worker::js_sys::Function>()
            .map_err(|_| configuration_error())?;
        let handle = set_timeout
            .call2(&global, callback.as_ref(), &JsValue::from(milliseconds))
            .map_err(|_| configuration_error())?;
        Ok(Deadline { handle, callback })
    }
}

impl Drop for Cancellation {
    fn drop(&mut self) {
        let _ = self
            .incoming
            .remove_event_listener_with_callback("abort", self.listener.as_ref().unchecked_ref());
    }
}

pub struct Deadline {
    handle: JsValue,
    callback: Closure<dyn FnMut()>,
}

impl Drop for Deadline {
    fn drop(&mut self) {
        let global = worker::js_sys::global();
        if let Ok(clear) = Reflect::get(&global, &JsValue::from_str("clearTimeout"))
            && let Some(clear) = clear.dyn_ref::<worker::js_sys::Function>()
        {
            let _ = clear.call1(&global, &self.handle);
        }
        // Keep the closure alive until its timer has been cleared.
        let _ = &self.callback;
    }
}

pub async fn send_http<F, Fut>(
    destination: &PinnedDestination,
    method: Method,
    headers: &BTreeMap<String, String>,
    body: &[u8],
    cancellation: &Cancellation,
    before_dispatch: F,
) -> Result<Response, DispatchFailure>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), GatewayError>>,
{
    if cancellation.signal().aborted() {
        return Err(interrupted().into());
    }
    let wire_headers = Headers::new();
    for (name, value) in headers {
        wire_headers
            .set(name, value)
            .map_err(|_| configuration_error())?;
    }
    let request = construct_request(destination, method, wire_headers, body)
        .map_err(|_| configuration_error())?;
    send_constructed(request, cancellation, before_dispatch).await
}

/// Actual native Request already constructed at the original fixed physical target.
/// Private fields prevent a caller from manufacturing or serializing this value.
pub(crate) struct ConstructedRequest(Request);

pub(crate) fn construct_request(
    destination: &PinnedDestination,
    method: Method,
    headers: Headers,
    body: &[u8],
) -> worker::Result<ConstructedRequest> {
    let mut init = RequestInit::new();
    init.with_method(method)
        .with_headers(headers)
        .with_redirect(RequestRedirect::Manual);
    if !body.is_empty() {
        init.with_body(Some(Uint8Array::from(body).into()));
    }
    Request::new_with_init(destination.url.as_str(), &init).map(ConstructedRequest)
}

pub(crate) async fn send_constructed<F, Fut>(
    request: ConstructedRequest,
    cancellation: &Cancellation,
    before_dispatch: F,
) -> Result<Response, DispatchFailure>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), GatewayError>>,
{
    let ConstructedRequest(request) = request;
    // Validate/build the request before recording dispatch. No await, retry,
    // fallback or destination change occurs between this hook and actual fetch.
    before_dispatch().await?;
    if cancellation.signal().aborted() {
        return Err(interrupted().into());
    }
    Fetch::Request(request)
        .send_with_signal(&cancellation.signal())
        .await
        .map_err(|_| DispatchFailure {
            error: if cancellation.signal().aborted() {
                interrupted()
            } else {
                super::platform_error("The upstream transport failed.", "upstream_transport_error")
            },
            attempt: DispatchAttempt::Started,
            origin: DispatchOrigin::Transport,
        })
}

fn configuration_error() -> GatewayError {
    GatewayError::unavailable(
        "The upstream transport configuration is invalid.",
        "upstream_transport_configuration_invalid",
    )
}

fn interrupted() -> GatewayError {
    super::platform_error(
        "The upstream request was interrupted.",
        "upstream_request_interrupted",
    )
}
