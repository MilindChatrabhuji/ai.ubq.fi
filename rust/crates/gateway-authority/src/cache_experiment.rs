//! The source-owned cache campaign shares the existing transactional authority.
//! A campaign is not inference admission, account election or another paid ledger.
pub mod model;
mod promotion;
mod run;
mod state;
mod target;
mod transport;
pub use model::{Cycle, Evidence, Reason, Sample, Scope, State, TargetBinding, Usage};
pub use run::{ExperimentIo, ReadSample, request_body};
use serde::{Deserialize, Serialize};
pub use transport::CacheDispatch;

/// Prepared immediately before the immutable-release telemetry gate. Never caller JSON.
pub struct PreparedTarget {
    target: TargetBinding,
    release_git_sha: String,
}
impl PreparedTarget {
    pub fn binding(&self) -> &TargetBinding {
        &self.target
    }
    pub fn telemetry_provider(&self) -> &str {
        &self.target.telemetry_provider
    }
    pub fn model(&self) -> &str {
        &self.target.model
    }
    pub fn release_git_sha(&self) -> &str {
        &self.release_git_sha
    }
}

/// Closed private renewal context; only the source fifth-row transition mints its permit.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshContext {
    pub v: u8,
    pub release_git_sha: String,
    pub target: TargetBinding,
    pub campaign_owner: String,
    pub cycle_owner: String,
    pub cycle: u8,
    pub source_pool_revision: String,
    pub slot: u8,
    pub state_revision: String,
    pub cycle_lease_revision: String,
    pub campaign_lease_revision: String,
    pub prefix: [Sample; 5],
}
/// Deserializing a stored context cannot manufacture an operation permit.
/// ```compile_fail
/// use gateway_authority::cache_experiment::RefreshPermit;
/// let forged: RefreshPermit = serde_json::from_str("{}").unwrap();
/// ```
pub struct RefreshPermit {
    context: RefreshContext,
    binding: gateway_core::identity::AccountBinding,
}
impl RefreshPermit {
    pub fn context(&self) -> &RefreshContext {
        &self.context
    }
    pub fn binding(&self) -> &gateway_core::identity::AccountBinding {
        &self.binding
    }
}

/// Source/normalized credential publication fences are checked separately by
/// native_control in each phase. Its own proven publication may advance the
/// source revision, while these immutable campaign and account-membership facts remain.
pub(crate) async fn validate_refresh_context<
    S: gateway_core::state::AuthorityStore,
    I: crate::TokenSource,
>(
    tx: &mut crate::store::Transaction<'_, S, I>,
    context: &RefreshContext,
    now: i64,
) -> Result<(), gateway_core::GatewayError> {
    use model::{failed, sample_signal};
    context.target.validate()?;
    if context.v != 1
        || !release_valid(&context.release_git_sha)
        || context.slot != 1
        || !(1..=3).contains(&context.cycle)
        || context.source_pool_revision != context.target.auth_pool_versionstamp
    {
        return Err(failed(
            "Prompt-cache scope experiment refresh context is invalid.",
        ));
    }
    for (index, sample) in context.prefix.iter().enumerate() {
        if !sample.valid(index) || sample_signal(&context.prefix[..index], sample, index).is_err() {
            return Err(failed(
                "Prompt-cache scope experiment refresh prefix is invalid.",
            ));
        }
    }
    let (state, _) = state::records(tx, &context.target).await?;
    let state = state.ok_or_else(|| failed("Prompt-cache scope experiment lost its lease."))?;
    if state.next_cycle != context.cycle
        || state.campaign_owner != context.campaign_owner
        || state.auth_pool_versionstamp != context.source_pool_revision
        || !state.target.same_definition(&context.target)
        || state.expires_at_ms <= now
    {
        return Err(failed(
            "Prompt-cache scope experiment refresh campaign changed.",
        ));
    }
    let state_key = state::record_key("state", &context.target);
    let cycle_key = state::record_key("cycle_lease", &context.target);
    let campaign_key = state::record_key("campaign", &context.target);
    let cycle = tx.read::<serde_json::Value>(&cycle_key).await?;
    let campaign = tx.read::<serde_json::Value>(&campaign_key).await?;
    if tx.revision(&state_key).as_deref() != Some(context.state_revision.as_str())
        || tx.revision(&cycle_key).as_deref() != Some(context.cycle_lease_revision.as_str())
        || tx.revision(&campaign_key).as_deref() != Some(context.campaign_lease_revision.as_str())
        || !state::owns(&cycle, &context.cycle_owner, now)
        || !state::campaign_owned(&campaign, &state, now)
    {
        return Err(failed("Prompt-cache scope experiment lost its lease."));
    }
    let inventory = target::inventory(tx).await?;
    if !inventory.targets.iter().any(|t| {
        t.same_core(&context.target)
            && t.inventory_fingerprint == context.target.inventory_fingerprint
    }) {
        return Err(failed(
            "Prompt-cache scope experiment target changed during refresh.",
        ));
    }
    Ok(())
}

pub(crate) fn release_valid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
