//! Provider-outcome reconciliation and verified-reset recovery, with no provider I/O.
use gateway_core::GatewayError;
use gateway_core::identity::{ActiveSelection,ActiveTransitionReason};
use gateway_core::state::AuthorityStore;
use crate::reset::{ResetCandidate,ResetRecord,ResetState,check_record,reset_fences};
use crate::routing::{AdmittedAccount,ProbeLease,class_name,read_view};
use crate::{Authority,TokenSource,PROBE_LEASE_MS,add,invalid,keys,next_generation,text,unavailable};

impl<S:AuthorityStore,I:TokenSource> Authority<S,I>{
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
