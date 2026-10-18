//! Real platform primitives for request-owned observational reads and writes.
use gateway_core::GatewayError;
use gateway_core::identity::RequestId;
use gateway_observability::{ObservabilityHost, host_types::BuildIdentity};
use gateway_observability::{ObservabilityRuntime, ObservabilityState, replay_crypto::ReplayBody};
use std::rc::Rc;
#[path = "observability_inventory.rs"]
mod inventory;
#[path = "observability_probe.rs"]
mod probe;

thread_local! {static STATE:ObservabilityState=ObservabilityState::default();}
pub fn shared_state() -> ObservabilityState {
    STATE.with(Clone::clone)
}
pub type Runtime = ObservabilityRuntime<crate::authority::RemoteAuthorityStore, RequestHost>;
pub struct RequestHost {
    store: crate::authority::RemoteAuthorityStore,
    platform: crate::host::PlatformHost,
    request_id: String,
    original_body: ReplayBody,
}
pub fn bind(
    request_id: &RequestId,
    original_body: &[u8],
    store: crate::authority::RemoteAuthorityStore,
    platform: &crate::host::PlatformHost,
    _context: Rc<worker::Context>,
) -> Runtime {
    let host = RequestHost {
        store: store.clone(),
        platform: platform.clone(),
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
        if self.platform.cancellation.signal().aborted() {
            return Err(GatewayError::unavailable(
                "Observational request cancelled.",
                "observability_request_cancelled",
            ));
        }
        Host.wait_ms(milliseconds).await?;
        if self.platform.cancellation.signal().aborted() {
            return Err(GatewayError::unavailable(
                "Observational request cancelled.",
                "observability_request_cancelled",
            ));
        }
        Ok(())
    }
    fn build_identity(&self) -> Result<BuildIdentity, GatewayError> {
        Host.build_identity()
    }
    async fn provider_inventory(
        &self,
        context: &gateway_observability::Context,
    ) -> Result<gateway_observability::host_types::ProviderInventory, GatewayError> {
        self.inventory(context).await
    }
    async fn metered_balance_fingerprint(&self) -> Result<Option<String>, GatewayError> {
        Ok(inventory::monitoring_key(&self.platform.env)
            .map(|key| gateway_auth::crypto::sha256_hex(key.as_bytes())[..16].to_owned()))
    }
    async fn metered_quota_snapshot(
        &self,
        force: bool,
        deadline: i64,
    ) -> Result<Option<serde_json::Value>, GatewayError> {
        if inventory::monitoring_key(&self.platform.env).is_none() {
            return Ok(None);
        }
        gateway_observability::metered::quota_snapshot(&self.store, self, force, deadline).await
    }
    async fn fetch_metered_quota(&self, deadline: i64) -> Result<serde_json::Value, GatewayError> {
        self.monitoring_get(deadline).await
    }
    async fn probe_upstream_health(
        &self,
        deadline: i64,
    ) -> Result<gateway_observability::host_types::UpstreamHealthEvidence, GatewayError> {
        self.upstream_health(deadline).await
    }
    async fn codex_capacity_accounts(
        &self,
    ) -> Result<Vec<gateway_observability::host_types::CapacityAccountRef>, GatewayError> {
        self.capacity_accounts().await
    }
    async fn begin_codex_capacity_observation(
        &self,
        accounts: &[gateway_observability::host_types::CapacityAccountRef],
    ) -> Result<gateway_authority::capacity::CodexCapacityObservationFence, GatewayError> {
        let authority = gateway_authority::Authority::with_clock(
            self.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        );
        authority
            .begin_codex_capacity_observation(
                &accounts
                    .iter()
                    .map(|a| gateway_authority::capacity::CodexCapacityAccountRef {
                        source_slot: a.slot,
                        account_id: a.account_id.clone(),
                    })
                    .collect::<Vec<_>>(),
            )
            .await
    }
    async fn probe_codex_capacity(
        &self,
        account: &gateway_observability::host_types::CapacityAccountRef,
        fence: &gateway_authority::capacity::CodexCapacityObservationFence,
        deadline: i64,
    ) -> Result<gateway_observability::host_types::CapacityProbe, GatewayError> {
        self.capacity_probe(account, fence, deadline).await
    }
    async fn accept_capacity_observations(
        &self,
        fence: &gateway_authority::capacity::CodexCapacityObservationFence,
        observations: &[gateway_authority::capacity::CodexCapacitySample],
    ) -> Result<gateway_authority::capacity::AcceptedCodexCapacityObservations, GatewayError> {
        gateway_authority::Authority::with_clock(
            self.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        )
        .record_codex_capacity_observations(fence, observations)
        .await
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

fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "observability_host_unavailable")
}
