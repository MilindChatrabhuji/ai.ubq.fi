//! Constructor-only service transport. The synthetic URL supplies a fixed path
//! to an injected Fetcher; it never selects a public network destination.
use std::rc::Rc;

use gateway_auth::{
    GatewayError,
    crypto::base64url,
    native::*,
    native_auth::NativeTransportIdentity,
    native_control::{NATIVE_CONTROL_MAX_BYTES, unverified},
};
use worker::js_sys::Uint8Array;
use worker::{Fetcher, Headers, Method, Request, RequestInit, RequestRedirect, Response};

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
    carrier: Fetcher,
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
        Self { identity, carrier }
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
            &format!("https://uos-native.internal{path}"),
            &init,
        )
        .map_err(|_| unavailable())?;
        if cancellation.signal().aborted() {
            return Err(unavailable());
        }
        // A rejected fetch is unknown after this point. The caller must keep
        // its original action reference and must not request another renewal.
        let response = self
            .carrier
            .fetch_request(Request::from(request))
            .await
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
