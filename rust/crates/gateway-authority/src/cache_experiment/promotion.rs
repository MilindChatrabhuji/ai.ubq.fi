//! Source catalog and compact runtime publication is one fenced atomic transition.
use super::{
    model::*,
    state::{CyclePermit, record_key},
    target::{catalog_key, json as source_json, runtime_key, set_member},
};
use crate::{Authority, TokenSource};
use gateway_auth::provider_credentials::codex_source_pool_key;
use gateway_core::{GatewayError, model::ModelId, source_json::SourceJson, state::AuthorityStore};
use gateway_schema::{
    runtime_config::{
        build_runtime_config, default_model, default_reasoning_effort, normalize_runtime_config,
    },
    snapshot::ModelSnapshot,
};
use serde_json::{Value, json};
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub(super) async fn promote_cache_scope(
        &self,
        permit: &CyclePermit,
        target: &TargetBinding,
        promoted: &mut bool,
        now: i64,
    ) -> Result<Value, GatewayError> {
        let Some(scope) = &permit.state.pending_scope else {
            return self
                .finalize_cache_cycle(
                    permit,
                    Outcome::Inconclusive,
                    None,
                    Some(Reason::CycleDisagreement),
                    now,
                )
                .await;
        };
        for _ in 0..3 {
            let mut tx = self.transaction(now)?;
            let catalog_key = catalog_key();
            let runtime_key = runtime_key();
            let lease_key = record_key("cycle_lease", target);
            let raw = tx.read_source_control::<SourceJson>(&catalog_key).await?;
            let runtime = tx.read_source_control::<SourceJson>(&runtime_key).await?;
            let lease = tx.read::<Value>(&lease_key).await?;
            let _: Option<Value> = tx.read(&codex_source_pool_key()).await?;
            let current = self.fresh_time(now)?;
            let snapshot = raw
                .as_ref()
                .and_then(|v| v.deserialize::<ModelSnapshot>().ok());
            let normalized = runtime.as_ref().and_then(normalize_runtime_config);
            let reason = if !super::state::owns(&lease, &permit.cycle_owner, current) {
                Some(Reason::PromotionConflict)
            } else if tx.revision(&codex_source_pool_key()).as_deref()
                != Some(target.auth_pool_versionstamp.as_str())
            {
                Some(Reason::AuthPoolDrift)
            } else if snapshot.as_ref().is_none_or(|s| {
                gateway_schema::reasoning::js_trim_source(&s.source)
                    .as_units()
                    .is_empty()
                    || s.updated_at_ms <= 0
            }) {
                Some(Reason::PromotionConflict)
            } else if tx.revision(&catalog_key).as_deref()
                != Some(target.catalog_versionstamp.as_str())
                || snapshot.as_ref().is_none_or(|s| {
                    s.unique(&ModelId::from_scalar(&target.model)).is_none()
                        || !s.scope_experiment_eligible(&ModelId::from_scalar(&target.model))
                })
            {
                Some(Reason::TargetCatalogDrift)
            } else if normalized.is_none() {
                Some(Reason::PromotionConflict)
            } else if tx.revision(&runtime_key).as_deref()
                != Some(target.runtime_versionstamp.as_str())
            {
                Some(Reason::RuntimeDrift)
            } else {
                None
            };
            if let Some(reason) = reason {
                return self
                    .finalize_cache_cycle(
                        permit,
                        Outcome::Inconclusive,
                        None,
                        Some(reason),
                        current,
                    )
                    .await;
            }
            let snapshot = snapshot
                .ok_or_else(|| failed("Prompt-cache scope experiment snapshot is unavailable."))?;
            let normalized = normalized
                .ok_or_else(|| failed("Prompt-cache scope experiment runtime is unavailable."))?;
            let default = snapshot.preserve_default(default_model(&normalized).as_ref());
            let mut published = serde_json::to_value(scope)
                .map_err(|_| failed("Prompt-cache scope experiment scope is invalid."))?;
            published["reproducible_cycles"] = json!(3);
            published["source"] = json!("live_probe");
            published["verified_at_ms"] = json!(current);
            let next_snapshot = snapshot.with_prompt_cache_scope(
                &ModelId::from_scalar(&target.model),
                PROVIDER,
                &source_json(&published),
            );
            let next_runtime =
                default
                    .as_ref()
                    .zip(next_snapshot.as_ref())
                    .and_then(|(default, snapshot)| {
                        build_runtime_config(
                            snapshot,
                            Some(default),
                            default_reasoning_effort(&normalized).as_ref(),
                            current,
                        )
                        .ok()
                    });
            let (Some(next_snapshot), Some(next_runtime)) = (next_snapshot, next_runtime) else {
                return self
                    .finalize_cache_cycle(
                        permit,
                        Outcome::Inconclusive,
                        None,
                        Some(Reason::PromotionConflict),
                        current,
                    )
                    .await;
            };
            let mut next_raw = raw
                .ok_or_else(|| failed("Prompt-cache scope experiment snapshot is unavailable."))?;
            set_member(&mut next_raw, "models", source_json(&next_snapshot.models))?;
            tx.put_source_control(&catalog_key, &next_raw, None)?;
            tx.put_source_control(&runtime_key, &next_runtime, None)?;
            tx.put(
                &lease_key,
                &json!({"owner":permit.cycle_owner,"lease_until_ms":crate::add(current,LEASE_MS)?}),
                Some(crate::add(current, LEASE_MS * 2)?),
            )?;
            if tx.commit().await? {
                *promoted = true;
                return self
                    .finalize_cache_cycle(
                        permit,
                        Outcome::Completed,
                        None,
                        None,
                        self.fresh_time(now)?,
                    )
                    .await;
            }
        }
        self.finalize_cache_cycle(
            permit,
            Outcome::Inconclusive,
            None,
            Some(Reason::PromotionConflict),
            self.fresh_time(now)?,
        )
        .await
    }
}
