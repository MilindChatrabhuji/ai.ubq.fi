//! Banked-reset owner fencing and spend-once boundaries. No provider call occurs here.
use gateway_core::GatewayError;
use gateway_core::state::AuthorityStore;
use sha2::{Digest, Sha256};

use crate::routing::{class_name, read_view, validate_cohort};
use crate::store::Transaction;
use crate::{
    Authority, DAY_MS, PROBE_LEASE_MS, TokenSource, add, invalid, keys, next_generation,
    nonnegative, text, unavailable,
};

pub(crate) fn hash(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in Sha256::digest(value.as_bytes()).iter().copied() {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 15) as usize] as char);
    }
    encoded
}

pub use crate::reset_types::*;

pub fn utc_day(now: i64) -> Result<String, GatewayError> {
    nonnegative(now)?;
    // Gregorian civil date from days since Unix epoch, with no locale/time-zone dependency.
    let shifted = now / DAY_MS + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

pub(crate) async fn reset_fences<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    candidate: &ResetCandidate,
) -> Result<ResetInvocation, GatewayError> {
    if !candidate.proof.exhausted
        || candidate.proof.bindings.is_empty()
        || !candidate.proof.bindings.contains(&candidate.binding)
    {
        return Err(unavailable(
            "routing_fence_stale",
            "Every selected account must prove quota exhaustion before a reset.",
        ));
    }
    if !validate_cohort(tx, &candidate.proof, true).await? {
        return Err(unavailable(
            "routing_fence_stale",
            "Reset cohort changed or its quota window recovered.",
        ));
    }
    let view = read_view(tx).await?;
    let slot =
        usize::try_from(candidate.binding.slot).map_err(|_| invalid("Reset slot is invalid."))?;
    if slot >= view.state.slots.len()
        || view.binding(slot) != candidate.binding
        || !view.pool.accounts[slot].enabled
        || view.state.legacy_identity_unresolved
    {
        return Err(unavailable(
            "routing_fence_stale",
            "Reset account binding changed.",
        ));
    }
    let block = view.state.slots[slot]
        .quota_blocks
        .get(class_name(candidate.proof.quota_class))
        .ok_or_else(|| {
            unavailable(
                "routing_fence_missing",
                "Reset requires a persisted class quota fence.",
            )
        })?;
    if block.blocked_until_ms != candidate.quota_reset_at_ms
        || block.reset_at_ms != Some(candidate.quota_reset_at_ms)
        || !block.reset_is_stable
        || block.reset_ambiguous
        || view.state.slots[slot].reset_identity_ambiguous
    {
        return Err(unavailable(
            "routing_fence_stale",
            "Reset quota generation is not stable.",
        ));
    }
    let setting: Option<serde_json::Value> = tx
        .read(&keys::reset_usage(
            &view.pool.accounts[slot].admin_account_hash.0,
        ))
        .await?;
    if setting.as_ref().is_some_and(|setting| {
        setting.get("enabled").and_then(serde_json::Value::as_bool) != Some(true)
    }) {
        return Err(unavailable(
            "usage_disabled",
            "Reset usage is disabled for this subscription.",
        ));
    }
    reset_invocation(
        &view.pool.accounts[slot].admin_account_hash.0,
        &candidate.binding.credential_version.0,
        candidate.quota_reset_at_ms,
    )
}

pub(crate) fn check_record(
    record: &ResetRecord,
    expected: &ResetRecord,
) -> Result<(), GatewayError> {
    if record.v != 1
        || record.identity != expected.identity
        || record.owner_token != expected.owner_token
        || record.fence != expected.fence
    {
        return Err(unavailable("stale_owner", "Reset ownership changed."));
    }
    text(&record.owner_token)?;
    nonnegative(record.lease_expires_at_ms)?;
    Ok(())
}

fn live_clock(
    record: &ResetRecord,
    candidate: &ResetCandidate,
    now: i64,
) -> Result<(), GatewayError> {
    if candidate.quota_reset_at_ms <= now {
        return Err(unavailable(
            "quota_window_expired",
            "The quota window has already recovered.",
        ));
    }
    if record.lease_expires_at_ms <= now {
        return Err(unavailable("stale_owner", "Reset ownership lease expired."));
    }
    if utc_day(record.created_at_ms)? != utc_day(now)? {
        return Err(unavailable(
            "claim_day_elapsed",
            "Reset claim crossed its UTC day.",
        ));
    }
    Ok(())
}

fn shadow_episode(candidate: &ResetCandidate) -> String {
    let value = serde_json::json!({"model":candidate.proof.model,"class":class_name(candidate.proof.quota_class),"bindings":candidate.proof.bindings,"reset":candidate.quota_reset_at_ms});
    hash(&value.to_string())
}

#[derive(Clone, Copy)]
pub(crate) enum ResetAuthorization<'a> {
    Legacy(&'a ResetCandidate),
    FullPool(&'a crate::full_pool_reset::AutomaticResetPermit),
    ExistingLedger(
        &'a ResetCandidate,
        &'a gateway_core::identity::RequestContext,
    ),
}
impl<'a> ResetAuthorization<'a> {
    pub(crate) fn candidate(self) -> &'a ResetCandidate {
        match self {
            Self::Legacy(candidate) => candidate,
            Self::FullPool(permit) => permit.candidate(),
            Self::ExistingLedger(candidate, _) => candidate,
        }
    }
    pub(crate) async fn validate_full<S: AuthorityStore, I: TokenSource>(
        self,
        tx: &mut Transaction<'_, S, I>,
    ) -> Result<(), GatewayError> {
        if let Self::FullPool(permit) = self {
            let now = tx.now;
            crate::full_pool_reset::validate_automatic_permit(tx, permit, now).await?;
        }
        if let Self::ExistingLedger(candidate, original) = self {
            let current = crate::full_pool_reset::capture_reconciliation_candidates(
                tx,
                &candidate.proof,
                original,
            )
            .await?;
            if !current.iter().any(|current| {
                current.binding == candidate.binding
                    && current.quota_reset_at_ms == candidate.quota_reset_at_ms
            }) {
                return Err(unavailable(
                    "routing_fence_stale",
                    "Existing reset recovery context changed.",
                ));
            }
        }
        Ok(())
    }
}
pub(crate) async fn authorization_fences<S: AuthorityStore, I: TokenSource>(
    tx: &mut Transaction<'_, S, I>,
    authorization: ResetAuthorization<'_>,
) -> Result<ResetInvocation, GatewayError> {
    authorization.validate_full(tx).await?;
    match authorization {
        ResetAuthorization::Legacy(candidate) => reset_fences(tx, candidate).await,
        ResetAuthorization::FullPool(permit) => permit.invocation(),
        ResetAuthorization::ExistingLedger(candidate, _) => {
            let view = read_view(tx).await?;
            reset_invocation(
                &view.pool.accounts[candidate.binding.slot as usize]
                    .admin_account_hash
                    .0,
                &candidate.binding.credential_version.0,
                candidate.quota_reset_at_ms,
            )
        }
    }
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub(crate) fn check_reset_authorization_deadline(
        &self,
        authorization: ResetAuthorization<'_>,
        anchor: i64,
    ) -> Result<(), GatewayError> {
        if let ResetAuthorization::FullPool(permit) = authorization {
            permit.check_deadline(self.fresh_time(anchor)?)?;
        }
        Ok(())
    }

    /// Preserve the original audit (including expiry) so inspection cannot revive or arm it.
    pub async fn read_reset_shadow(
        &self,
        candidate: &ResetCandidate,
    ) -> Result<Option<ResetShadow>, GatewayError> {
        for _ in 0..3 {
            let now = self.fresh_time(0)?;
            let mut tx = self.transaction(now)?;
            reset_fences(&mut tx, candidate).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if !config.enabled || config.mode == ResetMode::Disabled {
                return Err(unavailable(
                    "feature_disabled",
                    "Reset policy forbids observations.",
                ));
            }
            let row: Option<ResetShadow> = tx
                .read(&keys::reset_shadow(&shadow_episode(candidate)))
                .await?;
            if row.as_ref().is_some_and(|r| r.v != 1) {
                return Err(invalid("Malformed reset shadow audit."));
            }
            self.fresh_time(now)?;
            if tx.commit().await? {
                return Ok(row);
            }
        }
        Err(unavailable(
            "routing_fence_stale",
            "Reset audit changed concurrently.",
        ))
    }

    /// Finite pre-inventory projection; the fixed host rechecks again before every effect.
    pub async fn reset_candidates(
        &self,
        proof: &crate::routing::CohortProof,
    ) -> Result<Vec<ResetCandidate>, GatewayError> {
        for _ in 0..3 {
            let now = self.fresh_time(0)?;
            let mut tx = self.transaction(now)?;
            if !proof.exhausted || !validate_cohort(&mut tx, proof, true).await? {
                return Err(unavailable(
                    "routing_fence_stale",
                    "Current full quota cohort is required.",
                ));
            }
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if !config.enabled
                || config.mode == ResetMode::Disabled
                || config.max_per_account_per_day <= 0
                || config.max_per_account_per_window != 1
            {
                return Ok(Vec::new());
            }
            let view = read_view(&mut tx).await?;
            let mut candidates = Vec::new();
            for binding in &proof.bindings {
                let Some(slot) = view.state.slots.get(binding.slot as usize) else {
                    continue;
                };
                let Some(block) = slot.quota_block_for(proof.quota_class) else {
                    continue;
                };
                if block.blocked_until_ms <= now
                    || block.reset_at_ms != Some(block.blocked_until_ms)
                    || !block.reset_is_stable
                    || block.reset_ambiguous
                    || slot.reset_identity_ambiguous
                {
                    continue;
                }
                let candidate = ResetCandidate {
                    binding: binding.clone(),
                    quota_reset_at_ms: block.blocked_until_ms,
                    request_started_at_ms: now,
                    proof: proof.clone(),
                };
                let index = binding.slot as usize;
                let setting: Option<serde_json::Value> = tx
                    .read(&keys::reset_usage(
                        &view.pool.accounts[index].admin_account_hash.0,
                    ))
                    .await?;
                if setting.as_ref().is_some_and(|v| {
                    v.get("enabled").and_then(serde_json::Value::as_bool) != Some(true)
                }) {
                    continue;
                }
                reset_fences(&mut tx, &candidate).await?;
                candidates.push(candidate);
            }
            if self.fresh_time(now)?
                >= candidates
                    .iter()
                    .map(|c| c.quota_reset_at_ms)
                    .min()
                    .unwrap_or(i64::MAX)
            {
                continue;
            }
            if tx.commit().await? {
                return Ok(candidates);
            }
        }
        Err(unavailable(
            "routing_fence_stale",
            "Reset inventory cohort changed concurrently.",
        ))
    }

    /// Persist the complete observed shadow selection before a later live request may consume.
    pub async fn record_reset_shadow(
        &self,
        candidate: &ResetCandidate,
        credit: &ResetCredit,
        now: i64,
    ) -> Result<ResetShadow, GatewayError> {
        text(&credit.credit_id)?;
        if !credit.eligible
            || credit.observed_at_ms > now
            || now - credit.observed_at_ms > 30_000
            || credit.expires_at_ms.is_some_and(|expiry| expiry <= now)
        {
            return Err(unavailable(
                "inventory_response_invalid_or_expired",
                "Reset credit inventory is not current.",
            ));
        }
        for _ in 0..4 {
            let mut tx = self.transaction(now)?;
            let invocation = reset_fences(&mut tx, candidate).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if !config.enabled || config.mode == ResetMode::Disabled {
                return Err(unavailable(
                    "feature_disabled",
                    "Reset feature is disabled.",
                ));
            }
            let episode_hash = shadow_episode(candidate);
            let key = keys::reset_shadow(&episode_hash);
            let prior: Option<ResetShadow> = tx.read(&key).await?;
            let credit_hash = hash(&format!("uos_ai\0codex_reset_credit\0{}", credit.credit_id));
            let same = prior.as_ref().filter(|row| {
                row.expires_at_ms > now
                    && row.selected_credit_id_hash == credit_hash
                    && row.account_id_hash == invocation.identity.account_id_hash
            });
            let row = ResetShadow {
                v: 1,
                episode_hash,
                account_id_hash: invocation.identity.account_id_hash,
                quota_generation: invocation.identity.quota_generation,
                selected_credit_id_hash: credit_hash,
                credit_expires_at_ms: credit.expires_at_ms,
                observed_at_ms: credit.observed_at_ms,
                created_at_ms: same.map_or(now, |row| row.created_at_ms),
                expires_at_ms: add(now, 30_000)?.min(credit.expires_at_ms.unwrap_or(i64::MAX)),
                armed_at_ms: same.and_then(|row| row.armed_at_ms),
            };
            tx.put(&key, &row, None)?;
            if tx.commit().await? {
                return Ok(row);
            }
        }
        Err(unavailable(
            "routing_fence_stale",
            "Shadow selection changed concurrently.",
        ))
    }

    pub async fn arm_reset_live(
        &self,
        candidate: &ResetCandidate,
        now: i64,
    ) -> Result<bool, GatewayError> {
        for _ in 0..4 {
            let mut tx = self.transaction(now)?;
            let invocation = reset_fences(&mut tx, candidate).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if let Some(reason) = config.live_reason() {
                return Err(unavailable(reason, "Reset live policy is not authorized."));
            }
            let key = keys::reset_shadow(&shadow_episode(candidate));
            let mut row: ResetShadow = tx.read(&key).await?.ok_or_else(|| {
                unavailable(
                    "shadow_decision_missing",
                    "A prior shadow decision is required.",
                )
            })?;
            if row.account_id_hash != invocation.identity.account_id_hash
                || row.quota_generation != invocation.identity.quota_generation
            {
                return Err(unavailable(
                    "shadow_decision_stale",
                    "Shadow decision selected a different reset account/window.",
                ));
            }
            if row.expires_at_ms <= now
                || row.credit_expires_at_ms.is_some_and(|expiry| expiry <= now)
            {
                return Err(unavailable(
                    "shadow_decision_stale",
                    "Reset shadow decision expired.",
                ));
            }
            let newly_armed = row.armed_at_ms.is_none();
            row.armed_at_ms.get_or_insert(now);
            tx.put(&key, &row, None)?;
            if tx.commit().await? {
                return Ok(newly_armed);
            }
        }
        Err(unavailable(
            "routing_fence_stale",
            "Live arming changed concurrently.",
        ))
    }

    pub async fn claim_reset(
        &self,
        candidate: &ResetCandidate,
        now: i64,
    ) -> Result<ResetClaim, GatewayError> {
        self.claim_reset_guarded(ResetAuthorization::Legacy(candidate), now)
            .await
    }

    /// Complete source audit permission, validated inside the existing shared spend transaction.
    pub async fn claim_full_pool_reset(
        &self,
        permit: &crate::full_pool_reset::AutomaticResetPermit,
    ) -> Result<ResetClaim, GatewayError> {
        let now = self.fresh_time(0)?;
        self.claim_reset_guarded(ResetAuthorization::FullPool(permit), now)
            .await
    }

    async fn claim_reset_guarded(
        &self,
        authorization: ResetAuthorization<'_>,
        now: i64,
    ) -> Result<ResetClaim, GatewayError> {
        let candidate = authorization.candidate();
        for _ in 0..4 {
            let mut tx = self.transaction(now)?;
            authorization.validate_full(&mut tx).await?;
            let view = read_view(&mut tx).await?;
            let slot = usize::try_from(candidate.binding.slot)
                .map_err(|_| invalid("Reset slot is invalid."))?;
            let account = view
                .pool
                .accounts
                .get(slot)
                .filter(|account| account.account_id_hash == candidate.binding.account_id_hash)
                .ok_or_else(|| unavailable("routing_fence_stale", "Reset account was removed."))?;
            let invocation = reset_invocation(
                &account.admin_account_hash.0,
                &candidate.binding.credential_version.0,
                candidate.quota_reset_at_ms,
            )?;
            let key = keys::reset_redemption(
                &invocation.identity.account_id_hash,
                &invocation.identity.quota_generation,
            );
            let existing: Option<ResetRecord> = tx.read(&key).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if let Some(record) = &existing {
                if record.v != 1 || record.identity != invocation.identity {
                    return Err(unavailable(
                        "redemption_record_context_mismatch",
                        "Reset record context does not match this credential/window.",
                    ));
                }
                if record.state == ResetState::Verified {
                    return Ok(ResetClaim::Verified(record.clone()));
                }
                if record.state == ResetState::Rejected {
                    return Ok(ResetClaim::Rejected(record.clone()));
                }
                if record.lease_expires_at_ms > now {
                    return Ok(ResetClaim::InProgress(record.clone()));
                }
                if matches!(record.state, ResetState::Submitted | ResetState::Unknown) {
                    let mut takeover = record.clone();
                    takeover.owner_token = self.tokens.next_token()?;
                    text(&takeover.owner_token)?;
                    takeover.fence = next_generation(record.fence)?;
                    takeover.lease_expires_at_ms = add(now, PROBE_LEASE_MS)?;
                    takeover.updated_at_ms = now;
                    tx.put(&key, &takeover, None)?;
                    self.check_reset_authorization_deadline(authorization, now)?;
                    if tx.commit().await? {
                        return Ok(ResetClaim::Reconcile {
                            record: takeover,
                            invocation,
                        });
                    } else {
                        continue;
                    }
                }
            }
            if let Some(reason) = config.live_reason() {
                return Ok(ResetClaim::Disabled(reason));
            }
            let invocation = authorization_fences(&mut tx, authorization).await?;
            if candidate.quota_reset_at_ms <= now {
                return Err(unavailable(
                    "quota_window_expired",
                    "Reset quota window expired.",
                ));
            }
            if let ResetAuthorization::Legacy(_) = authorization {
                let shadow: ResetShadow = tx
                    .read(&keys::reset_shadow(&shadow_episode(candidate)))
                    .await?
                    .ok_or_else(|| {
                        unavailable(
                            "shadow_decision_missing",
                            "Reset requires a prior live-armed decision.",
                        )
                    })?;
                if shadow.account_id_hash != invocation.identity.account_id_hash
                    || shadow.quota_generation != invocation.identity.quota_generation
                {
                    return Err(unavailable(
                        "shadow_decision_stale",
                        "Shadow decision selected a different reset account/window.",
                    ));
                }
                if shadow.expires_at_ms <= now
                    || shadow
                        .armed_at_ms
                        .is_none_or(|armed| armed >= candidate.request_started_at_ms)
                {
                    return Ok(ResetClaim::Disabled("live_armed"));
                }
            }
            let row = if let Some(mut row) = existing {
                if row.routing_generation != candidate.binding.routing_generation {
                    return Err(unavailable(
                        "routing_fence_stale",
                        "Claimed reset generation changed.",
                    ));
                }
                row.owner_token = self.tokens.next_token()?;
                row.fence = next_generation(row.fence)?;
                row.lease_expires_at_ms = add(now, PROBE_LEASE_MS)?;
                row.updated_at_ms = now;
                row
            } else {
                ResetRecord {
                    v: 1,
                    identity: invocation.identity.clone(),
                    routing_generation: candidate.binding.routing_generation,
                    state: ResetState::Claimed,
                    owner_token: self.tokens.next_token()?,
                    fence: 1,
                    lease_expires_at_ms: add(now, PROBE_LEASE_MS)?,
                    provider_receipt_id: None,
                    created_at_ms: now,
                    updated_at_ms: now,
                    submitted_at_ms: None,
                    verified_at_ms: None,
                    last_error_code: None,
                }
            };
            text(&row.owner_token)?;
            let before_claim = self.fresh_time(now)?;
            if before_claim >= candidate.quota_reset_at_ms {
                return Err(unavailable(
                    "quota_window_expired",
                    "Reset quota window expired during fence reads.",
                ));
            }
            if row.lease_expires_at_ms <= before_claim {
                return Err(unavailable(
                    "stale_owner",
                    "Reset claim lease elapsed during fence reads.",
                ));
            }
            tx.put(&key, &row, None)?;
            self.check_reset_authorization_deadline(authorization, now)?;
            if tx.commit().await? {
                return Ok(ResetClaim::Submit {
                    record: row,
                    invocation,
                });
            }
        }
        Err(unavailable(
            "stale_owner",
            "Reset claim changed concurrently.",
        ))
    }

    /// Durable claimed->submitted boundary consumes one account/day slot atomically.
    pub async fn prepare_reset_submission(
        &self,
        candidate: &ResetCandidate,
        expected: &ResetRecord,
        now: i64,
    ) -> Result<ResetRecord, GatewayError> {
        self.prepare_reset_submission_guarded(ResetAuthorization::Legacy(candidate), expected, now)
            .await
    }

    /// Complete source audit permission, validated inside the existing shared spend transaction.
    pub async fn prepare_full_pool_reset_submission(
        &self,
        permit: &crate::full_pool_reset::AutomaticResetPermit,
        expected: &ResetRecord,
    ) -> Result<ResetRecord, GatewayError> {
        let now = self.fresh_time(0)?;
        self.prepare_reset_submission_guarded(ResetAuthorization::FullPool(permit), expected, now)
            .await
    }

    async fn prepare_reset_submission_guarded(
        &self,
        authorization: ResetAuthorization<'_>,
        expected: &ResetRecord,
        now: i64,
    ) -> Result<ResetRecord, GatewayError> {
        let candidate = authorization.candidate();
        for _ in 0..4 {
            let mut tx = self.transaction(now)?;
            let invocation = authorization_fences(&mut tx, authorization).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if let Some(reason) = config.live_reason() {
                return Err(unavailable(reason, "Reset live policy changed."));
            }
            let key = keys::reset_redemption(
                &invocation.identity.account_id_hash,
                &invocation.identity.quota_generation,
            );
            let mut row: ResetRecord = tx
                .read(&key)
                .await?
                .ok_or_else(|| unavailable("stale_owner", "Reset claim is missing."))?;
            check_record(&row, expected)?;
            live_clock(&row, candidate, now)?;
            if row.state != ResetState::Claimed
                || row.routing_generation != candidate.binding.routing_generation
            {
                return Err(unavailable(
                    "stale_owner",
                    "Reset claim is no longer submit-capable.",
                ));
            }
            let day = utc_day(now)?;
            let day_key = keys::reset_day(&row.identity.account_id_hash, &day);
            let mut budget: AccountDayBudget =
                tx.read(&day_key).await?.unwrap_or(AccountDayBudget {
                    v: 1,
                    day: day.clone(),
                    submission_count: 0,
                    updated_at_ms: now,
                });
            if budget.v != 1 || budget.day != day {
                return Err(invalid("Reset account/day record is malformed."));
            }
            nonnegative(budget.submission_count)?;
            if budget.submission_count >= 1 {
                return Err(unavailable(
                    "account_day_limit_reached",
                    "This account already submitted a reset today.",
                ));
            }
            live_clock(&row, candidate, self.fresh_time(now)?)?;
            budget.submission_count = add(budget.submission_count, 1)?;
            budget.updated_at_ms = now;
            row.state = ResetState::Submitted;
            row.submitted_at_ms = Some(now);
            row.updated_at_ms = now;
            row.lease_expires_at_ms = add(now, PROBE_LEASE_MS)?;
            tx.put(&key, &row, None)?;
            tx.put(&day_key, &budget, None)?;
            self.check_reset_authorization_deadline(authorization, now)?;
            if tx.commit().await? {
                return Ok(row);
            }
        }
        Err(unavailable(
            "stale_owner",
            "Reset submission changed concurrently.",
        ))
    }

    /// Native owner calls immediately before redeem, then rechecks its local kill switch/clock.
    /// The returned lease is not a provider success receipt or permission to retry a lost consume.
    pub async fn renew_reset_before_redeem(
        &self,
        candidate: &ResetCandidate,
        expected: &ResetRecord,
        now: i64,
    ) -> Result<ResetRecord, GatewayError> {
        self.renew_reset_before_redeem_guarded(ResetAuthorization::Legacy(candidate), expected, now)
            .await
    }

    /// Complete source audit permission, validated inside the existing shared spend transaction.
    pub async fn renew_full_pool_reset_before_redeem(
        &self,
        permit: &crate::full_pool_reset::AutomaticResetPermit,
        expected: &ResetRecord,
    ) -> Result<ResetRecord, GatewayError> {
        let now = self.fresh_time(0)?;
        self.renew_reset_before_redeem_guarded(ResetAuthorization::FullPool(permit), expected, now)
            .await
    }

    async fn renew_reset_before_redeem_guarded(
        &self,
        authorization: ResetAuthorization<'_>,
        expected: &ResetRecord,
        now: i64,
    ) -> Result<ResetRecord, GatewayError> {
        let candidate = authorization.candidate();
        for _ in 0..4 {
            let mut tx = self.transaction(now)?;
            let invocation = authorization_fences(&mut tx, authorization).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if let Some(reason) = config.live_reason() {
                return Err(unavailable(reason, "Reset live policy changed."));
            }
            let key = keys::reset_redemption(
                &invocation.identity.account_id_hash,
                &invocation.identity.quota_generation,
            );
            let mut row: ResetRecord = tx
                .read(&key)
                .await?
                .ok_or_else(|| unavailable("stale_owner", "Reset submission is missing."))?;
            check_record(&row, expected)?;
            live_clock(&row, candidate, now)?;
            if row.state != ResetState::Submitted {
                return Err(unavailable("stale_owner", "Reset is not submitted."));
            }
            live_clock(&row, candidate, self.fresh_time(now)?)?;
            row.lease_expires_at_ms = add(now, PROBE_LEASE_MS)?;
            row.updated_at_ms = now;
            tx.put(&key, &row, None)?;
            self.check_reset_authorization_deadline(authorization, now)?;
            if tx.commit().await? {
                return Ok(row);
            }
        }
        Err(unavailable(
            "stale_owner",
            "Reset renewal changed concurrently.",
        ))
    }
}
