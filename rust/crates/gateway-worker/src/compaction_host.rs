//! Finite compaction I/O inside the original request lifetime; never a child admission.
mod protocol;

use crate::{
    host::{PlatformHost, provider_secret},
    transport::{
        body,
        outbound::{Cancellation, PinnedDestination, send_http},
        random,
    },
};
use gateway_compaction::types::{CompactionFailure, CompactionHost, FailureKind};
use gateway_core::{GatewayError, source_json::SourceJson};
use protocol::{Call, RequestPlan};
use worker::Method;

pub struct PlatformCompactionHost {
    platform: PlatformHost,
    openrouter_key: String,
}

impl PlatformCompactionHost {
    /// Called only after recognized-route strict stream validation, before algorithm validation.
    pub fn new(platform: PlatformHost) -> Result<Self, CompactionFailure> {
        if platform.cancellation.signal().aborted() {
            return Err(CompactionFailure::new(FailureKind::Cancelled, "cancelled"));
        }
        let openrouter_key = provider_secret(&platform.env, "OPENROUTER_API_KEY")
            .ok_or_else(|| CompactionFailure::new(FailureKind::MissingKey, "missing-key"))?;
        Ok(Self {
            platform,
            openrouter_key,
        })
    }

    fn interruption(
        &self,
        child: &Cancellation,
        call: Call,
        timeout_ms: u32,
    ) -> Option<GatewayError> {
        protocol::interruption(self.cancelled(), child.signal().aborted(), call, timeout_ms)
    }

    async fn request(
        &self,
        call: Call,
        plan: RequestPlan,
        timeout_ms: u32,
    ) -> Result<SourceJson, GatewayError> {
        if self.cancelled() {
            return Err(protocol::cancelled());
        }
        let child = self.platform.cancellation.child()?;
        let milliseconds = i32::try_from(timeout_ms).map_err(|_| protocol::invalid_request())?;
        // Both remain owned until the response body has ended, including late abort/EOF.
        let _deadline = child.set_timeout_ms(milliseconds)?;
        let destination = PinnedDestination::new(plan.url)?;
        let result = send_http(
            &destination,
            Method::Post,
            &plan.headers,
            &plan.body,
            &child,
            || async { Ok(()) },
        )
        .await;
        let mut response = match result {
            Ok(response) => response,
            Err(_) => {
                return Err(self
                    .interruption(&child, call, timeout_ms)
                    .unwrap_or_else(|| protocol::transport_error(call)));
            }
        };
        if let Some(error) = self.interruption(&child, call, timeout_ms) {
            child.abort();
            body::discard_response(&mut response);
            return Err(error);
        }
        let status = response.status_code();
        // The source Jev client reads text before status validation. Residue rejects status first.
        if call == Call::Residue && !(200..300).contains(&status) {
            child.abort();
            body::discard_response(&mut response);
            return Err(protocol::http_error(call, status));
        }
        let bytes = body::response_bytes(
            &mut response,
            body::INFERENCE_JSON_MAX_BYTES,
            &child.signal(),
        )
        .await;
        let interruption = self.interruption(&child, call, timeout_ms);
        let bytes = match bytes {
            Ok(bytes) => bytes,
            Err(_) => {
                child.abort();
                body::discard_response(&mut response);
                return Err(interruption.unwrap_or_else(|| protocol::body_error(call)));
            }
        };
        if let Some(error) = interruption {
            return Err(error);
        }
        protocol::parse_response(call, status, &bytes)
    }
}

impl CompactionHost for PlatformCompactionHost {
    fn now_ms(&self) -> Result<i64, GatewayError> {
        crate::storage::now_ms()
    }
    fn random_uuid(&self) -> Result<String, GatewayError> {
        random::random_uuid()
    }
    fn cancelled(&self) -> bool {
        self.platform.cancellation.signal().aborted()
    }
    async fn ask_jev(
        &self,
        state: &SourceJson,
        questions: &SourceJson,
        timeout_ms: u32,
    ) -> Result<SourceJson, GatewayError> {
        self.request(
            Call::Jev,
            protocol::jev_request(state, questions, &self.openrouter_key)?,
            timeout_ms,
        )
        .await
    }
    async fn rewrite_residue(
        &self,
        source: &SourceJson,
        timeout_ms: u32,
    ) -> Result<SourceJson, GatewayError> {
        if self.cancelled() {
            return Err(protocol::cancelled());
        }
        let key = provider_secret(&self.platform.env, "CEREBRAS_API_KEY").ok_or_else(|| {
            GatewayError::unavailable(
                "The requested model is not configured.",
                "cerebras_api_key_missing",
            )
        })?;
        self.request(
            Call::Residue,
            protocol::residue_request(source, &key)?,
            timeout_ms,
        )
        .await
    }
}
