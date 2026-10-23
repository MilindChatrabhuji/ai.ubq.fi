//! Real platform primitives for request-owned observational reads and writes.
use gateway_admin_runtime::capabilities::Context;
use gateway_core::GatewayError;
use gateway_core::identity::RequestId;
use gateway_observability::{
    ObservabilityRuntime, ObservabilityState, host_types::BuildIdentity, replay_crypto::ReplayBody,
    types::ObservabilityHost,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
#[path = "observability_admin.rs"]
mod admin;
#[path = "observability_diagnostics.rs"]
mod diagnostics;
#[path = "observability_inventory.rs"]
mod inventory;
#[path = "observability_probe.rs"]
mod probe;

thread_local! {static STATE:ObservabilityState=ObservabilityState::default();}
pub fn shared_state() -> ObservabilityState {
    STATE.with(Clone::clone)
}
pub type Runtime = ObservabilityRuntime<crate::authority::RemoteAuthorityStore, RequestHost>;
pub enum CaptureInput {
    Ready(gateway_observability::replay_producer::ReplayInput),
    Omitted(&'static str),
}
/// The original accepted body receipt and actual request headers supply capture input.
pub fn capture_input(
    runtime: &Runtime,
    request: &worker::Request,
    upstream: gateway_observability::replay_trace::UpstreamTrace,
) -> Result<CaptureInput, GatewayError> {
    if request.method() != worker::Method::Post {
        return Ok(CaptureInput::Omitted("non_post"));
    }
    let host = runtime.host();
    if host.original_body.as_bytes().len() > gateway_observability::replay_crypto::MAX_REQUEST_BYTES
    {
        return Ok(CaptureInput::Omitted("body_over_limit"));
    }
    let url = request
        .url()
        .map_err(|_| unavailable("Capture request URL is invalid."))?;
    let endpoint = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    let headers = request.headers().entries().collect();
    let request = gateway_observability::replay_producer::ReplayRequest {
        endpoint,
        method: "POST".into(),
        body: ReplayBody::from_vec(host.original_body.as_bytes().to_vec()),
        content_type: request
            .headers()
            .get("content-type")
            .map_err(|_| unavailable("Capture request headers are invalid."))?,
        headers,
        request_id: host.request_id.clone(),
        upstream,
    };
    Ok(CaptureInput::Ready(
        gateway_observability::replay_producer::ReplayInput::new(host, request)?,
    ))
}
/// Await from the same request/terminal event owner; no capture task is left floating.
pub async fn persist_failure(
    runtime: &Runtime,
    input: gateway_observability::replay_producer::ReplayInput,
    observation: gateway_observability::replay_producer::FailureObservation,
    client: gateway_observability::replay_producer::ClientFailureObservation,
) -> Result<gateway_observability::replay_producer::PersistResult, GatewayError> {
    let key =
        crate::host::setting(&runtime.host().platform.env, "SENTINEL_REPLAY_KEY").and_then(|raw| {
            gateway_observability::replay_crypto::ReplayKey::decode(
                raw.trim_matches(gateway_schema::util::js_whitespace),
            )
            .ok()
        });
    runtime
        .persist_failure(input, observation, client, key.as_ref())
        .await
}
pub struct RequestHost {
    store: crate::authority::RemoteAuthorityStore,
    platform: crate::host::PlatformHost,
    request_id: String,
    original_body: ReplayBody,
    admin_actor: Option<Rc<gateway_authority::native_control::actor::NativeRenewalActor>>,
    prepared_cache_target: RefCell<Option<gateway_authority::cache_experiment::PreparedTarget>>,
    cache_target_prepared: Cell<bool>,
}
pub fn bind(
    request_id: &RequestId,
    original_body: &[u8],
    store: crate::authority::RemoteAuthorityStore,
    platform: &crate::host::PlatformHost,
    _context: Rc<worker::Context>,
) -> Runtime {
    bind_request(request_id, original_body, store, platform, None)
}
/// Bind only the original authenticated actor; a normalized administrative Context cannot mint it.
pub fn bind_admin(
    request_id: &RequestId,
    original_body: &[u8],
    store: crate::authority::RemoteAuthorityStore,
    platform: &crate::host::PlatformHost,
    _context: Rc<worker::Context>,
    actor: Rc<gateway_authority::native_control::actor::NativeRenewalActor>,
) -> Result<Runtime, GatewayError> {
    if actor.scope() != gateway_authority::native_control::actor::NativeActorScope::Admin
        || actor.context().request_id != *request_id
    {
        return Err(admin::auth_required());
    }
    Ok(bind_request(
        request_id,
        original_body,
        store,
        platform,
        Some(actor),
    ))
}
fn bind_request(
    request_id: &RequestId,
    original_body: &[u8],
    store: crate::authority::RemoteAuthorityStore,
    platform: &crate::host::PlatformHost,
    admin_actor: Option<Rc<gateway_authority::native_control::actor::NativeRenewalActor>>,
) -> Runtime {
    let host = RequestHost {
        store: store.clone(),
        platform: platform.clone(),
        request_id: request_id.0.clone(),
        original_body: ReplayBody::from_vec(original_body.to_vec()),
        admin_actor,
        prepared_cache_target: RefCell::new(None),
        cache_target_prepared: Cell::new(false),
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

/// Source /admin/defaults diagnostics use the same configured monitoring identity and cache.
pub async fn metered_diagnostics(runtime: &Runtime) -> Result<serde_json::Value, GatewayError> {
    let host = runtime.host();
    let configured = inventory::monitoring_key(&host.platform.env).is_some();
    let snapshot = if configured {
        let deadline = crate::storage::now_ms()?
            .checked_add(10_000)
            .ok_or_else(|| unavailable("Metered diagnostics deadline is invalid."))?;
        host.metered_quota_snapshot(false, deadline).await?
    } else {
        None
    };
    Ok(gateway_observability::metered::diagnostics(
        configured,
        snapshot.as_ref(),
    ))
}
/// Retention maintenance and host-log diagnostics belong to this same administrative request.
pub async fn error_diagnostics(
    runtime: &Runtime,
    context: &Context,
) -> Result<gateway_admin_runtime::capabilities::ErrorDiagnostics, GatewayError> {
    if context.request_id != runtime.host().request_id {
        return Err(GatewayError::unavailable(
            "The administrative diagnostic receipt does not match this request.",
            "admin_body_receipt_mismatch",
        ));
    }
    Ok(gateway_admin_runtime::capabilities::ErrorDiagnostics {
        retention: runtime.error_retention_diagnostics().await,
        // Source leaves unmeasured host text logs unknown, including platforms without paths.
        log_files: serde_json::json!({
            "scope":"host_text_logs", "platform":"cloudflare-workers", "files":[],
            "total_bytes":null, "warning":false,
        }),
    })
}

#[derive(Clone, Copy)]
pub struct Host;

impl ObservabilityHost for Host {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        crate::source_collator::shared()
    }

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
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        crate::source_collator::shared()
    }

    async fn backfill_paid_usage(
        &self,
        limit: u32,
    ) -> Result<gateway_observability::host_types::PaidBackfillReceipt, GatewayError> {
        self.paid_backfill(limit).await
    }
    async fn recheck_codex_slot(&self, slot: u8) -> Result<bool, GatewayError> {
        self.recheck_slot(slot).await
    }
    async fn cache_experiment_target(
        &self,
    ) -> Result<gateway_observability::host_types::CacheExperimentTarget, GatewayError> {
        self.prepare_cache_target().await
    }
    async fn run_fixed_cache_experiment(
        &self,
        _baseline: &serde_json::Value,
    ) -> Result<serde_json::Value, GatewayError> {
        self.run_cache_experiment().await
    }
    async fn codex_reset_available_count(
        &self,
        account: &gateway_observability::host_types::CapacityAccountRef,
        deadline: i64,
    ) -> Result<Option<i64>, GatewayError> {
        self.reset_count(account, deadline).await
    }
    async fn codex_reset_credits(
        &self,
        account: &gateway_observability::host_types::CapacityAccountRef,
        deadline: i64,
    ) -> Result<Option<Vec<gateway_observability::host_types::ResetCreditDiagnostic>>, GatewayError>
    {
        self.reset_credits(account, deadline).await
    }
    async fn codex_overage_diagnostics(
        &self,
        account: &gateway_observability::host_types::CapacityAccountRef,
        deadline: i64,
    ) -> Result<Option<serde_json::Value>, GatewayError> {
        self.overage(account, deadline).await
    }
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
        context: &Context,
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
    async fn capacity_observation_body(&self, context: &Context) -> Result<Vec<u8>, GatewayError> {
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
