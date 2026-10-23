//! Finite admin delegation; the actor and prepared target belong to this original request only.
use super::RequestHost;
use gateway_authority::native_control::actor::{NativeActorScope, NativeRenewalActor};
use gateway_core::GatewayError;
use gateway_observability::{
    host_types::{
        CacheExperimentTarget, PaidBackfillReceipt, PaidRequestBackfill, PaidWindowBackfill,
    },
    types::ObservabilityHost,
};

pub(super) fn auth_required() -> GatewayError {
    GatewayError::unavailable(
        "Original administrative authentication is required.",
        "admin_auth_required",
    )
}
impl RequestHost {
    fn admin_actor(&self) -> Result<&NativeRenewalActor, GatewayError> {
        self.admin_actor
            .as_deref()
            .filter(|actor| {
                actor.scope() == NativeActorScope::Admin
                    && actor.context().request_id.0 == self.request_id
            })
            .ok_or_else(auth_required)
    }
    pub(super) async fn paid_backfill(
        &self,
        limit: u32,
    ) -> Result<PaidBackfillReceipt, GatewayError> {
        self.admin_actor()?;
        let receipt = gateway_authority::Authority::with_clock(
            self.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        )
        .backfill_paid_usage(limit, self.now_ms())
        .await?;
        Ok(PaidBackfillReceipt {
            requests: PaidRequestBackfill {
                scanned: receipt.requests.scanned,
                processed: receipt.requests.processed,
                rollups_written: receipt.requests.rollups_written,
                failed: receipt.requests.failed,
                truncated: receipt.requests.truncated,
            },
            windows: PaidWindowBackfill {
                scanned: receipt.windows.scanned,
                rewritten: receipt.windows.rewritten,
                truncated: receipt.windows.truncated,
            },
        })
    }
    pub(super) async fn recheck_slot(&self, slot: u8) -> Result<bool, GatewayError> {
        let actor = self.admin_actor()?;
        gateway_authority::Authority::with_clock(
            self.store.clone(),
            crate::host::PlatformTokens,
            crate::host::PlatformClock,
        )
        .recheck_codex_slot(actor, &crate::host::auth_config(&self.platform.env), slot)
        .await
    }
    pub(super) async fn prepare_cache_target(&self) -> Result<CacheExperimentTarget, GatewayError> {
        self.admin_actor()?;
        if self.cache_target_prepared.replace(true) {
            return Err(cache_target_used());
        }
        let identity = self.build_identity()?;
        identity.validate()?;
        let prepared =
            crate::cache_experiment_host::prepare(self.store.clone(), &identity.git_sha).await?;
        let target = CacheExperimentTarget {
            provider: prepared.telemetry_provider().into(),
            model: prepared.model().into(),
        };
        *self.prepared_cache_target.borrow_mut() = Some(prepared);
        Ok(target)
    }
    pub(super) async fn run_cache_experiment(&self) -> Result<serde_json::Value, GatewayError> {
        let actor = self.admin_actor()?;
        let target = self.take_cache_target()?;
        crate::cache_experiment_host::run(target, &self.platform, actor).await
    }
    /// Take once after Stage 0; the authority still rechecks target, cohort, release and leases.
    pub(crate) fn take_cache_target(
        &self,
    ) -> Result<gateway_authority::cache_experiment::PreparedTarget, GatewayError> {
        self.admin_actor()?;
        self.prepared_cache_target
            .borrow_mut()
            .take()
            .ok_or_else(cache_target_used)
    }
}
fn cache_target_used() -> GatewayError {
    GatewayError::unavailable(
        "This request has no unconsumed cache experiment target.",
        "prompt_cache_scope_experiment_unavailable",
    )
}
