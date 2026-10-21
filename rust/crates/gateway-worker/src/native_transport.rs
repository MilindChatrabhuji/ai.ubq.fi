//! Constructor-only native transport. Service bindings use a synthetic origin;
//! HTTPS carriers pin their origin before any request-owned input is available.
use std::rc::Rc;

use gateway_auth::{
    GatewayError,
    crypto::base64url,
    native::*,
    native_auth::NativeTransportIdentity,
    native_control::{NATIVE_CONTROL_MAX_BYTES, unverified},
};
use worker::js_sys::Uint8Array;
use worker::worker_sys::ext::ResponseExt;
use worker::{Fetcher, Headers, Method, RequestInit, RequestRedirect, Response, Url};

use crate::{
    host::PlatformHost,
    transport::{
        outbound::{Cancellation, Deadline},
        random,
    },
};

#[derive(Clone)]
pub(super) struct NativeTransport {
    pub identity: NativeTransportIdentity,
    carrier: NativeCarrier,
}

#[derive(Clone)]
enum NativeCarrier {
    Service(Fetcher),
    FixedHttps(NativeOrigin),
}

#[derive(Clone)]
struct NativeOrigin(String);

impl NativeOrigin {
    fn new(origin: &str) -> Result<Self, GatewayError> {
        let (_, address) = origin.split_once("://").ok_or_else(unavailable)?;
        let url = Url::parse(origin).map_err(|_| unavailable())?;
        if origin.chars().any(|c| c.is_whitespace() || c.is_control())
            || origin.contains(['\\', '@'])
            || url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some_and(|port| port != 443)
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || address
                .split_once('/')
                .is_some_and(|(_, path)| !path.is_empty())
        {
            return Err(unavailable());
        }
        Ok(Self(url.origin().ascii_serialization()))
    }
}

pub(super) struct Exchange {
    pub response: Response,
    pub nonce: String,
    pub request: Vec<u8>,
    pub cancellation: Rc<Cancellation>,
    pub deadline: Deadline,
}

impl NativeTransport {
    pub fn configured(carrier: Fetcher, identity: NativeTransportIdentity) -> Self {
        Self {
            identity,
            carrier: NativeCarrier::Service(carrier),
        }
    }

    pub fn configured_https(
        origin: &str,
        identity: NativeTransportIdentity,
    ) -> Result<Self, GatewayError> {
        Ok(Self {
            identity,
            carrier: NativeCarrier::FixedHttps(NativeOrigin::new(origin)?),
        })
    }

    fn origin(&self) -> &str {
        match &self.carrier {
            NativeCarrier::Service(_) => "https://uos-native.internal",
            NativeCarrier::FixedHttps(origin) => &origin.0,
        }
    }

    async fn fetch_raw(
        &self,
        request: &worker::web_sys::Request,
    ) -> Result<worker::web_sys::Response, GatewayError> {
        use worker::wasm_bindgen::JsCast;
        use worker::wasm_bindgen_futures::JsFuture;
        let promise = match &self.carrier {
            NativeCarrier::Service(carrier) => {
                let carrier: worker::worker_sys::Fetcher = carrier.clone().into_rpc();
                carrier.fetch(request).map_err(|_| unavailable())?
            }
            NativeCarrier::FixedHttps(_) => {
                let global: worker::web_sys::WorkerGlobalScope =
                    worker::js_sys::global().unchecked_into();
                global.fetch_with_request(request)
            }
        };
        JsFuture::from(promise)
            .await
            .map_err(|_| unavailable())?
            .dyn_into()
            .map_err(|_| unavailable())
    }

    pub(crate) async fn live_upgrade(
        &self,
        action_ref: &str,
        platform: &PlatformHost,
    ) -> Result<crate::GatewayResponse, GatewayError> {
        use gateway_auth::native_live::{NATIVE_LIVE_ACTION_HEADER, NATIVE_LIVE_PATH};
        let now = crate::storage::now_ms()?;
        let nonce = base64url(&random::random_bytes(32)?);
        let mac = self.identity.sign_live_request(now, &nonce, action_ref)?;
        let headers = Headers::new();
        for (name, value) in [
            ("upgrade", "websocket".to_owned()),
            (NATIVE_LIVE_ACTION_HEADER, action_ref.to_owned()),
            (NATIVE_VERSION_HEADER, "1".to_owned()),
            (NATIVE_KEY_HEADER, self.identity.key_id().to_owned()),
            (NATIVE_TIME_HEADER, now.to_string()),
            (NATIVE_NONCE_HEADER, nonce),
            (NATIVE_MAC_HEADER, mac),
        ] {
            headers.set(name, &value).map_err(|_| unavailable())?;
        }
        let cancellation = platform.cancellation.child()?;
        let init = worker::web_sys::RequestInit::new();
        init.set_method("GET");
        init.set_redirect(worker::web_sys::RequestRedirect::Manual);
        init.set_headers(headers.as_ref());
        init.set_signal(Some(&cancellation.signal()));
        let request = worker::web_sys::Request::new_with_str_and_init(
            &format!("{}{NATIVE_LIVE_PATH}", self.origin()),
            &init,
        )
        .map_err(|_| unavailable())?;
        if cancellation.signal().aborted() {
            return Err(unavailable());
        }
        // Both platform carriers keep the original raw Response object;
        // workers-rs conversion would reconstruct its upgrade and status text.
        let raw = self.fetch_raw(&request).await?;
        if raw.status() != 101 || raw.websocket().is_none() {
            return Err(unavailable());
        }
        Ok(crate::GatewayResponse::Raw(raw))
    }

    pub async fn send(
        &self,
        path: &'static str,
        body: Vec<u8>,
        platform: &PlatformHost,
        timeout_ms: i32,
    ) -> Result<Exchange, GatewayError> {
        if !matches!(
            path,
            NATIVE_RPC_PATH | NATIVE_FOLLOW_PATH | NATIVE_CONTROL_PATH
        ) || body.len() > NATIVE_MAX_BODY_BYTES
            || path == NATIVE_CONTROL_PATH && body.len() > NATIVE_CONTROL_MAX_BYTES
        {
            return Err(unavailable());
        }
        let cancellation = Rc::new(platform.cancellation.child()?);
        if cancellation.signal().aborted() {
            return Err(unavailable());
        }
        let deadline = cancellation.set_timeout_ms(timeout_ms)?;
        let now = crate::storage::now_ms()?;
        let nonce = base64url(&random::random_bytes(32)?);
        let mac = self.identity.sign(path, now, &nonce, &body)?;
        let headers = Headers::new();
        for (name, value) in [
            ("content-type", "application/json".to_owned()),
            (
                "accept",
                if path == NATIVE_FOLLOW_PATH {
                    "text/event-stream"
                } else {
                    "application/json"
                }
                .to_owned(),
            ),
            (NATIVE_VERSION_HEADER, "1".to_owned()),
            (NATIVE_KEY_HEADER, self.identity.key_id().to_owned()),
            (NATIVE_TIME_HEADER, now.to_string()),
            (NATIVE_NONCE_HEADER, nonce.clone()),
            (NATIVE_MAC_HEADER, mac),
        ] {
            headers.set(name, &value).map_err(|_| unavailable())?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_redirect(RequestRedirect::Manual)
            .with_headers(headers)
            .with_body(Some(Uint8Array::from(body.as_slice()).into()));
        let init: worker::web_sys::RequestInit = (&init).into();
        init.set_signal(Some(&cancellation.signal()));
        let request = worker::web_sys::Request::new_with_str_and_init(
            &format!("{}{path}", self.origin()),
            &init,
        )
        .map_err(|_| unavailable())?;
        if cancellation.signal().aborted() {
            return Err(unavailable());
        }
        // A rejected fetch is unknown after this point. The caller must keep
        // its original action reference and must not request another renewal.
        let response = self
            .fetch_raw(&request)
            .await
            .map(Response::from)
            .map_err(|_| {
                if path == NATIVE_CONTROL_PATH {
                    unverified()
                } else {
                    unavailable()
                }
            })?;
        Ok(Exchange {
            response,
            nonce,
            request: body,
            cancellation,
            deadline,
        })
    }
}

pub(super) fn unavailable() -> GatewayError {
    GatewayError::unavailable(
        "The trusted native carrier is not configured or available",
        "native_carrier_unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::NativeOrigin;

    #[test]
    fn https_origin_is_fixed_and_normalized_before_requests() {
        for origin in [
            "https://native.example",
            "https://native.example/",
            "https://native.example:443/",
        ] {
            assert_eq!(
                NativeOrigin::new(origin).unwrap().0,
                "https://native.example"
            );
        }
    }

    #[test]
    fn https_origin_rejects_alternate_authorities_and_nonroot_input() {
        for origin in [
            "http://native.example",
            "https:native.example",
            "https:///native.example",
            "https://native.example:8443",
            "https://user@native.example",
            "https://@native.example",
            "https://user:password@native.example",
            "https://native.example/path",
            "https://native.example/../",
            "https://native.example/%2e/",
            "https://native.example//",
            "https://native.example?target=elsewhere",
            "https://native.example?",
            "https://native.example#fragment",
            "https://native.example#",
            "https://native.example\\elsewhere",
            "https://native.example\n",
            " https://native.example",
            "",
        ] {
            assert!(NativeOrigin::new(origin).is_err(), "accepted {origin:?}");
        }
    }
}
