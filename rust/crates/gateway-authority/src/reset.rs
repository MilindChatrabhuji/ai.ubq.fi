//! Banked-reset owner fencing and spend-once boundaries. No provider call occurs here.
use gateway_core::GatewayError;
use gateway_core::identity::{AccountBinding, ActiveSelection, ActiveTransitionReason};
use gateway_core::state::AuthorityStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::routing::{AdmittedAccount, CohortProof, ProbeLease, class_name, read_view, validate_cohort};
use crate::store::Transaction;
use crate::{Authority, TokenSource, DAY_MS, PROBE_LEASE_MS, add, invalid, keys, next_generation, nonnegative, text, unavailable};

fn hash(value: &str) -> String {
    const HEX: &[u8;16]=b"0123456789abcdef";
    let mut encoded=String::with_capacity(64);
    for byte in Sha256::digest(value.as_bytes()).iter().copied(){encoded.push(HEX[(byte>>4)as usize]as char);encoded.push(HEX[(byte&15)as usize]as char);}
    encoded
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode { Disabled, Shadow, Live }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetConfig {
    pub enabled: bool, pub mode: ResetMode, pub max_per_account_per_day: i64, pub max_per_account_per_window: i64,
    pub provider_approved: bool, pub supports_idempotent_lookup: bool, pub redeem_outcome_is_final: bool,
}

impl Default for ResetConfig {
    fn default() -> Self { Self { enabled: true, mode: ResetMode::Shadow, max_per_account_per_day: 0, max_per_account_per_window: 1, provider_approved: false, supports_idempotent_lookup: false, redeem_outcome_is_final: false } }
}

impl ResetConfig {
    fn live_reason(&self) -> Option<&'static str> {
        if !self.enabled { Some("feature_disabled") } else if self.mode != ResetMode::Live { Some("mode_not_live") }
        else if self.max_per_account_per_day != 1 { Some("per_account_day_limit_invalid") }
        else if self.max_per_account_per_window != 1 { Some("per_account_window_limit_invalid") }
        else if !self.provider_approved || !(self.supports_idempotent_lookup || self.redeem_outcome_is_final) { Some("provider_contract_unproven") }
        else { None }
    }
}

#[derive(Clone, Debug)]
pub struct ResetCandidate {
    pub binding: AccountBinding,
    pub quota_reset_at_ms: i64,
    pub request_started_at_ms: i64,
    pub proof: CohortProof,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetIdentity {
    pub account_id_hash: String, pub credential_version: String, pub quota_generation: String, pub idempotency_key_hash: String,
}

/// The raw provider idempotency key is returned only to the approved native provider boundary.
/// It is never included in a stored redemption record.
#[derive(Clone, Debug)]
pub struct ResetInvocation { pub identity: ResetIdentity, pub idempotency_key: String }

pub fn reset_invocation(admin_account_hash: &str, credential_version: &str, reset: i64) -> Result<ResetInvocation, GatewayError> {
    text(admin_account_hash)?; text(credential_version)?; nonnegative(reset)?;
    let credential_version = format!("v1:{}", hash(&format!("uos_ai\0codex_reset_credential_version\0{credential_version}")));
    let quota_generation = format!("v1:{}", hash(&format!("uos_ai\0codex_reset_generation\0{admin_account_hash}\0{reset}")));
    let idempotency_key = format!("uos_ai_codex_reset_v1_{}", hash(&format!("uos_ai\0codex_reset_idempotency\0{admin_account_hash}\0{quota_generation}")));
    let identity = ResetIdentity { account_id_hash: admin_account_hash.to_owned(), credential_version, quota_generation, idempotency_key_hash: hash(&idempotency_key) };
    Ok(ResetInvocation { identity, idempotency_key })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetState { Claimed, Submitted, Unknown, Verified, Rejected }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetRecord {
    pub v: u32, #[serde(flatten)] pub identity: ResetIdentity, pub routing_generation: u64, pub state: ResetState,
    pub owner_token: String, pub fence: u64, pub lease_expires_at_ms: i64, pub provider_receipt_id: Option<String>,
    pub created_at_ms: i64, pub updated_at_ms: i64, pub submitted_at_ms: Option<i64>, pub verified_at_ms: Option<i64>, pub last_error_code: Option<String>,
}

#[derive(Clone, Debug)]
pub enum ResetClaim { Submit { record: ResetRecord, invocation: ResetInvocation }, Reconcile { record: ResetRecord, invocation: ResetInvocation }, InProgress(ResetRecord), Verified(ResetRecord), Rejected(ResetRecord), Disabled(&'static str) }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AccountDayBudget { pub v: u32, pub day: String, pub submission_count: i64, pub updated_at_ms: i64 }

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetCredit { pub credit_id: String, pub expires_at_ms: Option<i64>, pub observed_at_ms: i64, pub eligible: bool }

#[derive(Clone,Debug)]
pub struct AccountResetInventory{pub binding:AccountBinding,pub observed_at_ms:i64,pub credits:Vec<ResetCredit>}

#[derive(Clone,Debug)]
pub struct SelectedResetCredit{pub binding:AccountBinding,pub credit:ResetCredit}

/// Complete typed inventory observations come from the approved native provider boundary.
/// Any malformed/stale observation invalidates this pool decision; no credit is fabricated.
pub fn select_reset_credit(inventories:&[AccountResetInventory],now:i64)->Result<Option<SelectedResetCredit>,GatewayError>{
    nonnegative(now)?;let mut candidates=Vec::new();
    for inventory in inventories{
        if inventory.observed_at_ms<0||inventory.observed_at_ms>now||now-inventory.observed_at_ms>30_000{return Err(unavailable("inventory_response_invalid_or_expired","Reset pool inventory is stale."));}
        for credit in &inventory.credits{
            text(&credit.credit_id)?;
            if credit.eligible&&credit.observed_at_ms<=now&&now-credit.observed_at_ms<=30_000&&credit.expires_at_ms.is_none_or(|expiry|expiry>now){candidates.push(SelectedResetCredit{binding:inventory.binding.clone(),credit:credit.clone()});}
        }
    }
    candidates.sort_by(|left,right|left.credit.expires_at_ms.unwrap_or(i64::MAX).cmp(&right.credit.expires_at_ms.unwrap_or(i64::MAX)).then_with(||left.binding.slot.cmp(&right.binding.slot)).then_with(||left.credit.credit_id.cmp(&right.credit.credit_id)));
    Ok(candidates.into_iter().next())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResetShadow {
    pub v: u32, pub episode_hash: String, pub account_id_hash: String, pub quota_generation: String,
    pub selected_credit_id_hash: String, pub credit_expires_at_ms: Option<i64>, pub observed_at_ms: i64,
    pub created_at_ms: i64, pub expires_at_ms: i64, pub armed_at_ms: Option<i64>,
}

pub fn utc_day(now: i64) -> Result<String, GatewayError> {
    nonnegative(now)?;
    // Gregorian civil date from days since Unix epoch, with no locale/time-zone dependency.
    let shifted = now / DAY_MS + 719_468;
    let era = shifted / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

async fn reset_fences<S: AuthorityStore, I: TokenSource>(tx: &mut Transaction<'_, S, I>, candidate: &ResetCandidate) -> Result<ResetInvocation, GatewayError> {
    if !candidate.proof.exhausted || candidate.proof.bindings.is_empty() || !candidate.proof.bindings.contains(&candidate.binding) { return Err(unavailable("routing_fence_stale", "Every selected account must prove quota exhaustion before a reset.")); }
    if !validate_cohort(tx,&candidate.proof,true).await? { return Err(unavailable("routing_fence_stale", "Reset cohort changed or its quota window recovered.")); }
    let view = read_view(tx).await?;
    let slot = usize::try_from(candidate.binding.slot).map_err(|_| invalid("Reset slot is invalid."))?;
    if slot >= view.state.slots.len() || view.binding(slot) != candidate.binding || !view.pool.accounts[slot].enabled || view.state.legacy_identity_unresolved { return Err(unavailable("routing_fence_stale", "Reset account binding changed.")); }
    let block = view.state.slots[slot].quota_blocks.get(class_name(candidate.proof.quota_class)).ok_or_else(|| unavailable("routing_fence_missing", "Reset requires a persisted class quota fence."))?;
    if block.blocked_until_ms != candidate.quota_reset_at_ms || block.reset_at_ms != Some(candidate.quota_reset_at_ms) || !block.reset_is_stable || block.reset_ambiguous || view.state.slots[slot].reset_identity_ambiguous { return Err(unavailable("routing_fence_stale", "Reset quota generation is not stable.")); }
    let setting: Option<serde_json::Value> = tx.read(&keys::reset_usage(&view.pool.accounts[slot].admin_account_hash.0)).await?;
    if setting.as_ref().is_some_and(|setting| setting.get("enabled").and_then(serde_json::Value::as_bool) != Some(true)) { return Err(unavailable("usage_disabled", "Reset usage is disabled for this subscription.")); }
    reset_invocation(&view.pool.accounts[slot].admin_account_hash.0, &candidate.binding.credential_version.0, candidate.quota_reset_at_ms)
}

fn check_record(record: &ResetRecord, expected: &ResetRecord) -> Result<(), GatewayError> {
    if record.v != 1 || record.identity != expected.identity || record.owner_token != expected.owner_token || record.fence != expected.fence { return Err(unavailable("stale_owner", "Reset ownership changed.")); }
    text(&record.owner_token)?; nonnegative(record.lease_expires_at_ms)?;
    Ok(())
}

fn live_clock(record: &ResetRecord, candidate: &ResetCandidate, now: i64) -> Result<(), GatewayError> {
    if candidate.quota_reset_at_ms <= now { return Err(unavailable("quota_window_expired", "The quota window has already recovered.")); }
    if record.lease_expires_at_ms <= now { return Err(unavailable("stale_owner", "Reset ownership lease expired.")); }
    if utc_day(record.created_at_ms)? != utc_day(now)? { return Err(unavailable("claim_day_elapsed", "Reset claim crossed its UTC day.")); }
    Ok(())
}

fn shadow_episode(candidate: &ResetCandidate) -> String {
    let value = serde_json::json!({"model":candidate.proof.model,"class":class_name(candidate.proof.quota_class),"bindings":candidate.proof.bindings,"reset":candidate.quota_reset_at_ms});
    hash(&value.to_string())
}

impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    /// Persist the complete observed shadow selection before a later live request may consume.
    pub async fn record_reset_shadow(&self, candidate: &ResetCandidate, credit: &ResetCredit, now: i64) -> Result<ResetShadow, GatewayError> {
        text(&credit.credit_id)?;
        if !credit.eligible || credit.observed_at_ms > now || now - credit.observed_at_ms > 30_000 || credit.expires_at_ms.is_some_and(|expiry|expiry<=now) { return Err(unavailable("inventory_response_invalid_or_expired", "Reset credit inventory is not current.")); }
        for _ in 0..4 {
            let mut tx = self.transaction(now)?; let invocation = reset_fences(&mut tx, candidate).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if !config.enabled || config.mode == ResetMode::Disabled { return Err(unavailable("feature_disabled", "Reset feature is disabled.")); }
            let episode_hash = shadow_episode(candidate); let key = keys::reset_shadow(&episode_hash);
            let prior: Option<ResetShadow> = tx.read(&key).await?;
            let credit_hash=hash(&format!("uos_ai\0codex_reset_credit\0{}",credit.credit_id));
            let same = prior.as_ref().filter(|row| row.expires_at_ms > now && row.selected_credit_id_hash == credit_hash && row.account_id_hash == invocation.identity.account_id_hash);
            let row = ResetShadow { v: 1, episode_hash, account_id_hash: invocation.identity.account_id_hash, quota_generation: invocation.identity.quota_generation, selected_credit_id_hash: credit_hash, credit_expires_at_ms: credit.expires_at_ms, observed_at_ms: credit.observed_at_ms, created_at_ms: same.map_or(now, |row| row.created_at_ms), expires_at_ms: add(now,30_000)?.min(credit.expires_at_ms.unwrap_or(i64::MAX)), armed_at_ms: same.and_then(|row| row.armed_at_ms) };
            tx.put(&key, &row, None)?; if tx.commit().await? { return Ok(row); }
        }
        Err(unavailable("routing_fence_stale", "Shadow selection changed concurrently."))
    }

    pub async fn arm_reset_live(&self, candidate: &ResetCandidate, now: i64) -> Result<bool, GatewayError> {
        for _ in 0..4 {
            let mut tx = self.transaction(now)?; let _ = reset_fences(&mut tx,candidate).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default(); if let Some(reason) = config.live_reason() { return Err(unavailable(reason, "Reset live policy is not authorized.")); }
            let key = keys::reset_shadow(&shadow_episode(candidate)); let mut row: ResetShadow = tx.read(&key).await?.ok_or_else(|| unavailable("shadow_decision_missing", "A prior shadow decision is required."))?;
            if row.expires_at_ms <= now || row.credit_expires_at_ms.is_some_and(|expiry|expiry<=now) { return Err(unavailable("shadow_decision_stale", "Reset shadow decision expired.")); }
            let newly_armed = row.armed_at_ms.is_none(); row.armed_at_ms.get_or_insert(now); tx.put(&key,&row,None)?;
            if tx.commit().await? { return Ok(newly_armed); }
        }
        Err(unavailable("routing_fence_stale", "Live arming changed concurrently."))
    }

    pub async fn claim_reset(&self, candidate: &ResetCandidate, now: i64) -> Result<ResetClaim, GatewayError> {
        for _ in 0..4 {
            let mut tx = self.transaction(now)?;
            let view = read_view(&mut tx).await?; let slot = usize::try_from(candidate.binding.slot).map_err(|_| invalid("Reset slot is invalid."))?;
            let account = view.pool.accounts.get(slot).filter(|account| account.account_id_hash == candidate.binding.account_id_hash).ok_or_else(|| unavailable("routing_fence_stale", "Reset account was removed."))?;
            let invocation = reset_invocation(&account.admin_account_hash.0, &candidate.binding.credential_version.0, candidate.quota_reset_at_ms)?;
            let key = keys::reset_redemption(&invocation.identity.account_id_hash,&invocation.identity.quota_generation);
            let existing: Option<ResetRecord> = tx.read(&key).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default();
            if let Some(record) = &existing {
                if record.v != 1 || record.identity != invocation.identity { return Err(unavailable("redemption_record_context_mismatch", "Reset record context does not match this credential/window.")); }
                if record.state == ResetState::Verified { return Ok(ResetClaim::Verified(record.clone())); }
                if record.state == ResetState::Rejected { return Ok(ResetClaim::Rejected(record.clone())); }
                if record.lease_expires_at_ms > now { return Ok(ResetClaim::InProgress(record.clone())); }
                if matches!(record.state,ResetState::Submitted | ResetState::Unknown) {
                    let mut takeover = record.clone(); takeover.owner_token = self.tokens.next_token()?; text(&takeover.owner_token)?; takeover.fence = next_generation(record.fence)?; takeover.lease_expires_at_ms = add(now,PROBE_LEASE_MS)?; takeover.updated_at_ms = now;
                    tx.put(&key,&takeover,None)?;
                    if tx.commit().await? { return Ok(ResetClaim::Reconcile {record: takeover,invocation}); } else { continue; }
                }
            }
            if let Some(reason) = config.live_reason() { return Ok(ResetClaim::Disabled(reason)); }
            let invocation = reset_fences(&mut tx,candidate).await?;
            if candidate.quota_reset_at_ms <= now { return Err(unavailable("quota_window_expired", "Reset quota window expired.")); }
            let shadow: ResetShadow = tx.read(&keys::reset_shadow(&shadow_episode(candidate))).await?.ok_or_else(|| unavailable("shadow_decision_missing", "Reset requires a prior live-armed decision."))?;
            if shadow.expires_at_ms <= now || shadow.armed_at_ms.is_none_or(|armed| armed >= candidate.request_started_at_ms) { return Ok(ResetClaim::Disabled("live_armed")); }
            let row = if let Some(mut row) = existing { if row.routing_generation != candidate.binding.routing_generation { return Err(unavailable("routing_fence_stale", "Claimed reset generation changed.")); } row.owner_token = self.tokens.next_token()?; row.fence = next_generation(row.fence)?; row.lease_expires_at_ms = add(now,PROBE_LEASE_MS)?; row.updated_at_ms = now; row } else {
                ResetRecord { v: 1,identity:invocation.identity.clone(),routing_generation:candidate.binding.routing_generation,state:ResetState::Claimed,owner_token:self.tokens.next_token()?,fence:1,lease_expires_at_ms:add(now,PROBE_LEASE_MS)?,provider_receipt_id:None,created_at_ms:now,updated_at_ms:now,submitted_at_ms:None,verified_at_ms:None,last_error_code:None }
            };
            text(&row.owner_token)?; tx.put(&key,&row,None)?;
            if tx.commit().await? { return Ok(ResetClaim::Submit {record:row,invocation}); }
        }
        Err(unavailable("stale_owner", "Reset claim changed concurrently."))
    }

    /// Durable claimed->submitted boundary consumes one account/day slot atomically.
    pub async fn prepare_reset_submission(&self, candidate: &ResetCandidate, expected: &ResetRecord, now: i64) -> Result<ResetRecord, GatewayError> {
        for _ in 0..4 {
            let mut tx = self.transaction(now)?; let invocation = reset_fences(&mut tx,candidate).await?;
            let config: ResetConfig = tx.read(&keys::reset_config()).await?.unwrap_or_default(); if let Some(reason)=config.live_reason(){ return Err(unavailable(reason,"Reset live policy changed.")); }
            let key=keys::reset_redemption(&invocation.identity.account_id_hash,&invocation.identity.quota_generation); let mut row:ResetRecord=tx.read(&key).await?.ok_or_else(|| unavailable("stale_owner","Reset claim is missing."))?;
            check_record(&row,expected)?; live_clock(&row,candidate,now)?;
            if row.state!=ResetState::Claimed || row.routing_generation!=candidate.binding.routing_generation { return Err(unavailable("stale_owner","Reset claim is no longer submit-capable.")); }
            let day=utc_day(now)?; let day_key=keys::reset_day(&row.identity.account_id_hash,&day); let mut budget:AccountDayBudget=tx.read(&day_key).await?.unwrap_or(AccountDayBudget{v:1,day:day.clone(),submission_count:0,updated_at_ms:now});
            if budget.v!=1 || budget.day!=day {return Err(invalid("Reset account/day record is malformed."));} nonnegative(budget.submission_count)?;
            if budget.submission_count>=1 { return Err(unavailable("account_day_limit_reached","This account already submitted a reset today.")); }
            budget.submission_count=add(budget.submission_count,1)?; budget.updated_at_ms=now;
            row.state=ResetState::Submitted; row.submitted_at_ms=Some(now); row.updated_at_ms=now; row.lease_expires_at_ms=add(now,PROBE_LEASE_MS)?;
            tx.put(&key,&row,None)?; tx.put(&day_key,&budget,None)?;
            if tx.commit().await? {return Ok(row);}
        }
        Err(unavailable("stale_owner","Reset submission changed concurrently."))
    }

    /// Native owner calls immediately before redeem, then rechecks its local kill switch/clock.
    /// The returned lease is not a provider success receipt or permission to retry a lost consume.
    pub async fn renew_reset_before_redeem(&self,candidate:&ResetCandidate,expected:&ResetRecord,now:i64)->Result<ResetRecord,GatewayError>{
        for _ in 0..4{
            let mut tx=self.transaction(now)?; let invocation=reset_fences(&mut tx,candidate).await?;
            let config:ResetConfig=tx.read(&keys::reset_config()).await?.unwrap_or_default(); if let Some(reason)=config.live_reason(){return Err(unavailable(reason,"Reset live policy changed."));}
            let key=keys::reset_redemption(&invocation.identity.account_id_hash,&invocation.identity.quota_generation);let mut row:ResetRecord=tx.read(&key).await?.ok_or_else(|| unavailable("stale_owner","Reset submission is missing."))?;
            check_record(&row,expected)?;live_clock(&row,candidate,now)?;if row.state!=ResetState::Submitted{return Err(unavailable("stale_owner","Reset is not submitted."));}
            row.lease_expires_at_ms=add(now,PROBE_LEASE_MS)?;row.updated_at_ms=now;tx.put(&key,&row,None)?;if tx.commit().await?{return Ok(row);}
        }
        Err(unavailable("stale_owner","Reset renewal changed concurrently."))
    }

    /// Only the authenticated approved native provider boundary may supply observed outcomes.
    pub async fn record_reset_outcome(&self,expected:&ResetRecord,state:ResetState,receipt:Option<&str>,error:Option<&str>,now:i64)->Result<ResetRecord,GatewayError>{
        if !matches!(state,ResetState::Unknown|ResetState::Verified|ResetState::Rejected){return Err(invalid("Invalid reset provider outcome."));}
        if let Some(receipt)=receipt {text(receipt)?;if receipt.len()>512{return Err(invalid("Reset receipt is too large."));}}
        for _ in 0..4{
            let mut tx=self.transaction(now)?;let key=keys::reset_redemption(&expected.identity.account_id_hash,&expected.identity.quota_generation);let mut row:ResetRecord=tx.read(&key).await?.ok_or_else(|| unavailable("stale_owner","Reset record is missing."))?;
            check_record(&row,expected)?;
            if matches!(row.state,ResetState::Verified|ResetState::Rejected){if row.state==state{return Ok(row);}return Err(invalid("Reset provider terminal is already immutable."));}
            if !matches!(row.state,ResetState::Submitted|ResetState::Unknown){return Err(unavailable("stale_owner","Reset has not crossed submission."));}
            if row.lease_expires_at_ms<=now{return Err(unavailable("stale_owner","Reset owner lease expired."));}
            row.state=state;row.updated_at_ms=now;if state==ResetState::Verified{row.verified_at_ms=Some(now);}if row.provider_receipt_id.is_none(){row.provider_receipt_id=receipt.map(str::to_owned);}row.last_error_code=error.map(|error|error.chars().take(120).collect());
            tx.put(&key,&row,None)?;if tx.commit().await?{return Ok(row);}
        }
        Err(unavailable("stale_owner","Reset outcome changed concurrently."))
    }

    pub async fn elect_verified_reset(&self,candidate:&ResetCandidate,expected:&ResetRecord,now:i64)->Result<Option<AdmittedAccount>,GatewayError>{
        for _ in 0..4{
            let mut tx=self.transaction(now)?;let invocation=reset_fences(&mut tx,candidate).await?;
            let key=keys::reset_redemption(&invocation.identity.account_id_hash,&invocation.identity.quota_generation);let row:ResetRecord=tx.read(&key).await?.ok_or_else(|| invalid("Verified reset record is missing."))?;check_record(&row,expected)?;
            if row.state!=ResetState::Verified||row.verified_at_ms.is_none()||row.routing_generation!=candidate.binding.routing_generation{return Ok(None);}
            let mut view=read_view(&mut tx).await?;let slot_index=candidate.binding.slot as usize;let slot=&mut view.state.slots[slot_index];
            slot.quota_blocks.remove(class_name(candidate.proof.quota_class));slot.generation=next_generation(slot.generation)?;
            let lease=ProbeLease{token:self.tokens.next_token()?,generation:slot.generation,quota_class:candidate.proof.quota_class,expires_at_ms:add(now,PROBE_LEASE_MS)?};text(&lease.token)?;slot.probe_lease=Some(lease.clone());
            let binding=view.binding(slot_index);let (active_generation,reason)=view.active.as_ref().map_or((1,None),|active|(active.generation,active.transition_reason));
            let changed=view.active.as_ref().is_some_and(|active|active.binding.account_id_hash!=binding.account_id_hash);let active_generation=if changed{next_generation(active_generation)?}else{active_generation};
            let active=ActiveSelection{v:1,binding:binding.clone(),generation:active_generation,transition_reason:if changed{Some(ActiveTransitionReason::QuotaExhausted)}else{reason},updated_at_ms:now};
            tx.put(&keys::routing(),&view.state,None)?;tx.put(&keys::active(),&active,None)?;
            let admitted=AdmittedAccount{binding,active_generation,requested_model:candidate.proof.model.clone(),quota_class:candidate.proof.quota_class,probe_required:false,probe:Some(lease)};
            if tx.commit().await?{return Ok(Some(admitted));}
        }
        Err(unavailable("routing_fence_stale","Verified reset election changed concurrently."))
    }

    /// A stale verified ledger permits one current-generation recovery probe, never another spend.
    /// It retains the reset identity as ambiguous and releases only this class's deadline.
    pub async fn claim_verified_reset_recovery(&self,candidate:&ResetCandidate,expected:&ResetRecord,now:i64)->Result<Option<AdmittedAccount>,GatewayError>{
        for _ in 0..4{
            let mut tx=self.transaction(now)?;let invocation=reset_fences(&mut tx,candidate).await?;
            let key=keys::reset_redemption(&invocation.identity.account_id_hash,&invocation.identity.quota_generation);let record:ResetRecord=tx.read(&key).await?.ok_or_else(|| invalid("Verified reset ledger is missing."))?;
            if record.identity!=expected.identity||record.state!=ResetState::Verified||record.verified_at_ms.is_none(){return Ok(None);}
            let mut view=read_view(&mut tx).await?;let slot_index=candidate.binding.slot as usize;let slot=&mut view.state.slots[slot_index];
            if slot.probe_lease.as_ref().is_some_and(|lease|lease.expires_at_ms>now){return Ok(None);}
            let block=slot.quota_blocks.get_mut(class_name(candidate.proof.quota_class)).ok_or_else(|| unavailable("routing_fence_stale","Reset quota class changed."))?;
            block.blocked_until_ms=now;block.recovery_pending=true;block.reset_ambiguous=true;slot.reset_identity_ambiguous=true;slot.generation=next_generation(slot.generation)?;
            let lease=ProbeLease{token:self.tokens.next_token()?,generation:slot.generation,quota_class:candidate.proof.quota_class,expires_at_ms:add(now,PROBE_LEASE_MS)?};text(&lease.token)?;slot.probe_lease=Some(lease.clone());
            let binding=view.binding(slot_index);let changed=view.active.as_ref().is_some_and(|active|active.binding.account_id_hash!=binding.account_id_hash);let previous=view.active.as_ref().map_or(0,|active|active.generation);let active_generation=if changed||previous==0{next_generation(previous)?}else{previous};
            let active=ActiveSelection{v:1,binding:binding.clone(),generation:active_generation,transition_reason:view.active.as_ref().and_then(|active|active.transition_reason),updated_at_ms:now};
            tx.put(&keys::routing(),&view.state,None)?;tx.put(&keys::active(),&active,None)?;
            let admitted=AdmittedAccount{binding,active_generation,requested_model:candidate.proof.model.clone(),quota_class:candidate.proof.quota_class,probe_required:false,probe:Some(lease)};if tx.commit().await?{return Ok(Some(admitted));}
        }
        Err(unavailable("routing_fence_stale","Verified reset recovery changed concurrently."))
    }
}
