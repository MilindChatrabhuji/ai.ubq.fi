//! Fixed M15 HTTP/AEAD capabilities over the original M14 dispatch reservation.
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformHost, PlatformTokens},
    routing_host,
    storage::now_ms,
    transport::{
        aead, body,
        outbound::{self, DispatchAttempt, PinnedDestination},
    },
};
use gateway_core::{GatewayError, state::AuthorityStore, tuple_key::TupleKey};
use gateway_extras_runtime::{
    DispatchFailure, DispatchFailureOrigin, ExtrasDispatch, ExtrasHost, ExtrasProvider, ImageKind,
    PreparedCall, UpstreamResponse,
};
use gateway_providers::{AuthMaterial, PrepareOptions};
use gateway_routing_runtime::{AdmissionHandle, ChildScope, DispatchTicket, TransportState};
use serde_json::json;
use std::{
    cell::{Cell, RefCell},
    task::Poll,
};
use worker::Method;

pub type Handle =
    AdmissionHandle<RemoteAuthorityStore, PlatformTokens, PlatformClock, routing_host::Host>;

pub struct Host {
    pub platform: PlatformHost,
    pub admission: Handle,
    pub child: ChildScope,
    transport: Cell<TransportState>,
}

impl Host {
    pub async fn new(platform: PlatformHost, admission: Handle) -> Result<Self, GatewayError> {
        let child = admission
            .children(1)
            .await
            .map_err(|error| *error.error)?
            .pop()
            .ok_or_else(invalid)?;
        Ok(Self {
            platform,
            admission,
            child,
            transport: Cell::new(TransportState::NotStarted),
        })
    }
    pub async fn settle_child(&self) -> Result<(), GatewayError> {
        self.admission
            .child_finished(&self.child, self.transport.get())
            .await
            .map_err(|error| *error.error)
    }
    async fn mark_started(&self, ticket: Option<DispatchTicket>) -> Result<(), DispatchFailure> {
        // Invoked only after Fetch was actually called. A failed ledger write
        // leaves unknown durable spend; it cannot retroactively mean NotStarted.
        self.transport.set(TransportState::Unknown);
        let ticket = ticket.ok_or_else(|| DispatchFailure::gateway(invalid(), false))?;
        self.admission
            .transport_started(&self.child, &ticket)
            .await
            .map_err(|error| DispatchFailure::gateway(*error.error, false))?;
        self.transport.set(TransportState::Started);
        Ok(())
    }
    async fn http(&self, call: PreparedCall) -> Result<UpstreamResponse, DispatchFailure> {
        let prepared = call.prepared();
        let target = PinnedDestination::new(&prepared.url)
            .map_err(|error| DispatchFailure::gateway(error, true))?;
        let bytes = serde_json::to_vec(&prepared.body)
            .map_err(|_| DispatchFailure::gateway(invalid(), true))?;
        let cancellation = self
            .platform
            .cancellation
            .child()
            .map_err(|error| DispatchFailure::gateway(error, true))?;
        let remaining = call
            .deadline_ms()
            .saturating_sub(now_ms().map_err(|error| DispatchFailure::gateway(error, true))?);
        let remaining = i32::try_from(remaining.max(0))
            .map_err(|_| DispatchFailure::gateway(invalid(), true))?;
        let _deadline = cancellation
            .set_timeout_ms(remaining)
            .map_err(|error| DispatchFailure::gateway(error, true))?;
        let ticket = RefCell::new(None);
        let result = outbound::send_http(
            &target,
            Method::Post,
            &prepared.headers,
            &bytes,
            &cancellation,
            || async {
                let actual = self
                    .admission
                    .before_dispatch(&self.child)
                    .await
                    .map_err(|error| *error.error)?;
                ticket.replace(Some(actual));
                Ok(())
            },
        )
        .await;
        let ticket = ticket.into_inner();
        let mut response = match result {
            Ok(response) => response,
            Err(failure) => {
                if failure.attempt == DispatchAttempt::Started {
                    self.mark_started(ticket).await?;
                }
                let before_transport = failure.attempt == DispatchAttempt::NotStarted;
                let quota_refusal = before_transport && failure.error.status == 429;
                return Err(DispatchFailure {
                    origin: match failure.origin {
                        outbound::DispatchOrigin::Gateway => DispatchFailureOrigin::Gateway,
                        outbound::DispatchOrigin::Transport => DispatchFailureOrigin::Transport,
                    },
                    error: Box::new(failure.error),
                    headers: Default::default(),
                    quota_refusal,
                    upstream_status: None,
                    retry_after_ms: None,
                    before_transport,
                    raw_error_body: None,
                });
            }
        };
        let status = response.status_code();
        let headers = response.headers().entries().collect();
        if let Err(mut failure) = self.mark_started(ticket).await {
            failure.headers = headers;
            failure.upstream_status = Some(status);
            body::discard_response(&mut response);
            return Err(failure);
        }
        let bytes = body::response_bytes(
            &mut response,
            body::INFERENCE_JSON_MAX_BYTES,
            &cancellation.signal(),
        )
        .await
        .map_err(DispatchFailure::transport)?;
        Ok(UpstreamResponse {
            status,
            headers,
            body: bytes,
            semantic_terminal: None,
            usage: None,
        })
    }
    async fn voyage_key(&self) -> Result<Option<String>, GatewayError> {
        if let Some(value) = configured(&self.platform, "VOYAGEAI_API_KEY") {
            return Ok(Some(value));
        }
        let key =
            TupleKey::from_json_parts(&[json!("uos_ai"), json!("voyage_api_key")])?.to_record_key();
        let Some(row) = self.platform.store.read(&key).await? else {
            return Ok(None);
        };
        if row
            .expires_at_ms
            .is_some_and(|expiry| expiry <= self.now_ms())
        {
            return Ok(None);
        }
        Ok(row
            .json_value()?
            .as_str()
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .map(str::to_owned))
    }
}

impl ExtrasHost for Host {
    fn now_ms(&self) -> i64 {
        now_ms().unwrap_or(i64::MAX)
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        crate::transport::random::random_bytes(length)
    }
    fn cancelled(&self) -> bool {
        self.platform.cancellation.signal().aborted()
    }
    async fn sleep_ms(&self, millis: u64) -> Result<(), GatewayError> {
        let mut delay = std::pin::pin!(worker::Delay::from(std::time::Duration::from_millis(
            millis
        )));
        std::future::poll_fn(|context| {
            self.platform.cancellation.register_waker(context.waker());
            if self.cancelled() {
                Poll::Ready(())
            } else {
                std::future::Future::poll(delay.as_mut(), context)
            }
        })
        .await;
        if self.cancelled() {
            Err(gateway_admission::cancellation_error())
        } else {
            Ok(())
        }
    }
    async fn provider_options(
        &self,
        provider: ExtrasProvider,
    ) -> Result<Option<PrepareOptions>, GatewayError> {
        let secret = match provider {
            ExtrasProvider::Voyage => self.voyage_key().await?,
            ExtrasProvider::SystemOne => configured(&self.platform, "OPENROUTER_API_KEY"),
        };
        Ok(secret.map(|secret| PrepareOptions {
            auth: AuthMaterial {
                secret,
                ..Default::default()
            },
            ..Default::default()
        }))
    }
    async fn image_base_model(&self) -> Result<Option<String>, GatewayError> {
        Err(image_unavailable())
    }
    async fn dispatch(
        &self,
        operation: ExtrasDispatch,
    ) -> Result<UpstreamResponse, DispatchFailure> {
        match operation {
            ExtrasDispatch::Voyage(call) | ExtrasDispatch::SystemOne(call) => self.http(call).await,
            ExtrasDispatch::ImageChild { .. } => {
                Err(DispatchFailure::gateway(image_unavailable(), true))
            }
        }
    }
    async fn begin_image_fanout(
        &self,
        _kind: ImageKind,
        _count: usize,
    ) -> Result<(), GatewayError> {
        Err(image_unavailable())
    }
    fn abort_image_siblings(&self) {}
    async fn image_child_finished(&self, _index: usize) -> Result<(), GatewayError> {
        Err(image_unavailable())
    }
    async fn finish_image_fanout(&self) -> Result<(), GatewayError> {
        Err(image_unavailable())
    }
    async fn aes_gcm_encrypt(
        &self,
        key: &[u8; 32],
        iv: &[u8; 12],
        plaintext: &[u8],
    ) -> Result<Vec<u8>, GatewayError> {
        aead::encrypt(key, iv, plaintext).await
    }
    async fn aes_gcm_decrypt(
        &self,
        key: &[u8; 32],
        iv: &[u8],
        ciphertext_and_tag: &[u8],
    ) -> Result<Vec<u8>, GatewayError> {
        aead::decrypt(key, iv, ciphertext_and_tag).await
    }
}

fn configured(platform: &PlatformHost, name: &str) -> Option<String> {
    platform
        .env
        .secret(name)
        .map(|value| value.to_string())
        .or_else(|_| platform.env.var(name).map(|value| value.to_string()))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
fn image_unavailable() -> GatewayError {
    GatewayError::unavailable(
        "Image fanout is not yet integrated with this HTTP adapter.",
        "rust_port_route_unavailable",
    )
}
fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "The source extras dispatch capability is unavailable.",
        "extras_dispatch_unavailable",
    )
}
