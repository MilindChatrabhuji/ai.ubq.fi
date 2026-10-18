//! Real platform primitives for request-owned observational reads and writes.
use gateway_core::GatewayError;
use gateway_core::identity::RequestId;
use gateway_observability::{ObservabilityHost, host_types::BuildIdentity};
use gateway_observability::{ObservabilityRuntime, ObservabilityState, replay_crypto::ReplayBody};
use std::rc::Rc;

thread_local! {static STATE:ObservabilityState=ObservabilityState::default();}
pub fn shared_state() -> ObservabilityState {
    STATE.with(Clone::clone)
}
pub type Runtime = ObservabilityRuntime<crate::authority::RemoteAuthorityStore, RequestHost>;
pub struct RequestHost {
    request_id: String,
    original_body: ReplayBody,
}
pub fn bind(
    request_id: &RequestId,
    original_body: &[u8],
    store: crate::authority::RemoteAuthorityStore,
    _platform: &crate::host::PlatformHost,
    _context: Rc<worker::Context>,
) -> Runtime {
    let host = RequestHost {
        request_id: request_id.0.clone(),
        original_body: ReplayBody::from_vec(original_body.to_vec()),
    };
    ObservabilityRuntime::with_state(store, host, shared_state())
}
/// Source /health is release liveness and does no provider or authority I/O.
pub fn health_response() -> Result<gateway_auth::AuthResponse, GatewayError> {
    let identity = Host.build_identity()?;
    let mut response = gateway_auth::AuthResponse::json(
        200,
        serde_json::json!({"status":"available","release":{"git_sha":identity.git_sha,"deployment_id":identity.deployment_id}}),
    );
    response
        .headers
        .insert("Cache-Control".into(), "no-store".into());
    response
        .headers
        .insert("x-uos-git-sha".into(), identity.git_sha);
    response
        .headers
        .insert("x-uos-deployment-id".into(), identity.deployment_id);
    Ok(response)
}

#[derive(Clone, Copy)]
pub struct Host;

impl ObservabilityHost for Host {
    fn now_ms(&self) -> i64 {
        crate::storage::now_ms().unwrap_or(i64::MAX)
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        crate::transport::random::random_bytes(length)
    }
    fn compare_labels(&self, left: &str, right: &str) -> Result<std::cmp::Ordering, GatewayError> {
        crate::admin_host::compare_labels(left, right)
    }
    async fn wait_ms(&self, milliseconds: u32) -> Result<(), GatewayError> {
        worker::Delay::from(std::time::Duration::from_millis(u64::from(milliseconds))).await;
        Ok(())
    }
    fn build_identity(&self) -> Result<BuildIdentity, GatewayError> {
        let identity = BuildIdentity {
            git_sha: env!("UOS_RUST_BUILD_GIT_SHA").into(),
            deployment_id: env!("UOS_RUST_BUILD_DEPLOYMENT_ID").into(),
        };
        identity.validate()?;
        Ok(identity)
    }
}

impl ObservabilityHost for RequestHost {
    fn now_ms(&self) -> i64 {
        Host.now_ms()
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        Host.random_bytes(length)
    }
    fn compare_labels(&self, left: &str, right: &str) -> Result<std::cmp::Ordering, GatewayError> {
        Host.compare_labels(left, right)
    }
    async fn wait_ms(&self, milliseconds: u32) -> Result<(), GatewayError> {
        Host.wait_ms(milliseconds).await
    }
    fn build_identity(&self) -> Result<BuildIdentity, GatewayError> {
        Host.build_identity()
    }
    async fn capacity_observation_body(
        &self,
        context: &gateway_observability::Context,
    ) -> Result<Vec<u8>, GatewayError> {
        if context.request_id != self.request_id {
            return Err(GatewayError::unavailable(
                "The administrative body receipt does not match this request.",
                "admin_body_receipt_mismatch",
            ));
        }
        Ok(self.original_body.as_bytes().to_vec())
    }
}
