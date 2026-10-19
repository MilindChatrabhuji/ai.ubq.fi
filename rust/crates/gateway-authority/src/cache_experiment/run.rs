//! One awaited source cycle per invocation; actual network/native I/O is a finite host capability.
use super::{
    PreparedTarget, RefreshPermit, model::*, state::CyclePermit, transport::CacheDispatch,
};
use crate::{Authority, TokenSource};
use gateway_core::{GatewayError, identity::PoolVersionstamp, state::AuthorityStore};
use serde_json::{Value, json};
use std::future::Future;

pub struct ReadSample {
    pub value: Result<Sample, Reason>,
    pub completed: bool,
}
pub trait ExperimentIo {
    type Response;
    fn release_git_sha(&self) -> &str;
    fn uuid(&self) -> Result<String, GatewayError>;
    fn begin_cycle(&self, deadline_ms: i64) -> Result<(), GatewayError>;
    fn fetch(
        &self,
        dispatch: &CacheDispatch,
        body: &str,
        conversation: &str,
        client_version: Option<&str>,
        deadline_ms: i64,
    ) -> impl Future<Output = Result<Self::Response, GatewayError>>;
    fn observed_response(
        &self,
        dispatch: &CacheDispatch,
        response: &mut Self::Response,
    ) -> impl Future<Output = Result<(), GatewayError>>;
    fn discard(&self, response: Self::Response);
    fn read(
        &self,
        response: Self::Response,
        slot: u8,
        model: &str,
        index: usize,
        deadline_ms: i64,
    ) -> impl Future<Output = Result<ReadSample, GatewayError>>;
    fn refresh(
        &self,
        permit: RefreshPermit,
    ) -> impl Future<Output = Result<PoolVersionstamp, GatewayError>>;
}
pub fn request_body(model: &str, cycle: &str, key: &str) -> String {
    let prefix = std::iter::repeat_n("cache", 2_560)
        .collect::<Vec<_>>()
        .join(" ");
    gateway_schema::util::json_stringify(
        &json!({"model":model,"input":[{"type":"message","role":"developer","content":[{"type":"input_text","text":format!("cache-scope-cycle:{cycle}\n\n{prefix}")}]},{"type":"message","role":"user","content":[{"type":"input_text","text":"Reply with exactly: cache scope experiment."}]}],"store":false,"stream":true,"reasoning":{"effort":"none"},"prompt_cache_key":key}),
    )
}
impl<S: AuthorityStore, I: TokenSource> Authority<S, I> {
    pub async fn run_cache_experiment<H: ExperimentIo>(
        &self,
        prepared: PreparedTarget,
        io: &H,
        now: i64,
    ) -> Result<Value, GatewayError> {
        if prepared.release_git_sha != io.release_git_sha() {
            return Err(unavailable(
                "Prompt-cache scope experiment requires a current-release Stage 0 telemetry baseline.",
            ));
        }
        let target=self.current_cache_target(&prepared.target,self.fresh_time(now)?).await?.map_err(|_|unavailable("Prompt-cache scope experiment target changed after its Stage 0 telemetry baseline."))?;
        let session = self.cache_session(self.fresh_time(now)?).await?;
        let permit = self
            .acquire_cache_cycle(&target, &session.revision, self.fresh_time(now)?)
            .await?;
        let mut promoted = false;
        let result = self
            .run_cache_cycle(&permit, target, session, io, &mut promoted, now)
            .await;
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                if !promoted
                    && !matches!(
                        error.envelope.error.code.as_deref(),
                        Some(
                            "prompt_cache_scope_experiment_busy"
                                | "prompt_cache_scope_experiment_unavailable"
                        )
                    )
                {
                    let _ = self
                        .finalize_cache_cycle(
                            &permit,
                            Outcome::Failed,
                            None,
                            None,
                            self.fresh_time(now)?,
                        )
                        .await;
                }
                if matches!(
                    error.envelope.error.code.as_deref(),
                    Some(
                        "prompt_cache_scope_experiment_busy"
                            | "prompt_cache_scope_experiment_unavailable"
                    )
                ) {
                    Err(error)
                } else {
                    Err(failed(&error.envelope.error.message))
                }
            }
        }
    }
    async fn run_cache_cycle<H: ExperimentIo>(
        &self,
        permit: &CyclePermit,
        mut target: TargetBinding,
        mut session: super::transport::Session,
        io: &H,
        promoted: &mut bool,
        now: i64,
    ) -> Result<Value, GatewayError> {
        let state = &permit.state;
        let guard = if state.expires_at_ms <= self.fresh_time(now)? {
            Some(Reason::SessionExpired)
        } else if state.auth_pool_versionstamp != session.revision {
            Some(Reason::AuthPoolDrift)
        } else if !state.target.same_core(&target) {
            Some(Reason::TargetCatalogDrift)
        } else {
            None
        };
        if let Some(reason) = guard {
            return self
                .finalize_cache_cycle(
                    permit,
                    Outcome::Inconclusive,
                    None,
                    Some(reason),
                    self.fresh_time(now)?,
                )
                .await;
        }
        if state.next_cycle == 4 {
            return self
                .promote_cache_scope(permit, &target, promoted, self.fresh_time(now)?)
                .await;
        }
        let deadline = crate::add(self.fresh_time(now)?, CYCLE_MS)?;
        io.begin_cycle(deadline)?;
        let cycle_nonce = io.uuid()?;
        let cache_key = format!("uos-cache-scope-v5-{}", io.uuid()?);
        let body = request_body(&target.model, &cycle_nonce, &cache_key);
        let conversation_a = io.uuid()?;
        let conversation_b = io.uuid()?;
        let mut cycle = Cycle {
            cycle: state.next_cycle,
            samples: vec![],
            classification: None,
            inconclusive_reason: None,
        };
        for (index, &slot) in SLOTS.iter().enumerate() {
            let current = self.fresh_time(now)?;
            if current >= deadline {
                return Err(failed("Prompt-cache scope experiment cycle failed."));
            }
            if index == 5 {
                match self.current_cache_target(&target, current).await? {
                    Ok(current) => target = current,
                    Err(reason) => {
                        cycle.inconclusive_reason = Some(reason);
                        break;
                    }
                }
                self.renew_cache_cycle(permit, self.fresh_time(now)?)
                    .await?;
                let prefix: [Sample; 5] = cycle.samples.clone().try_into().map_err(|_| {
                    failed("Prompt-cache scope experiment refresh prefix is invalid.")
                })?;
                let refresh = self
                    .cache_refresh_permit(
                        permit,
                        &target,
                        prefix,
                        io.release_git_sha(),
                        self.fresh_time(now)?,
                    )
                    .await?;
                let publication = match io.refresh(refresh).await {
                    Ok(publication) => publication,
                    Err(error) => {
                        if self
                            .cache_pool_changed_after_refresh_error(&session, self.fresh_time(now)?)
                            .await
                            .unwrap_or(false)
                        {
                            cycle.inconclusive_reason = Some(Reason::AuthPoolDrift);
                            break;
                        }
                        return Err(error);
                    }
                };
                match self
                    .cache_session_after_refresh(&session, &publication, self.fresh_time(now)?)
                    .await?
                {
                    Ok(next) => {
                        session = next;
                        target.auth_pool_versionstamp.clone_from(&session.revision);
                    }
                    Err(reason) => {
                        cycle.inconclusive_reason = Some(reason);
                        break;
                    }
                }
            }
            self.renew_cache_cycle(permit, self.fresh_time(now)?)
                .await?;
            match self
                .current_cache_target(&target, self.fresh_time(now)?)
                .await?
            {
                Ok(current) => target = current,
                Err(reason) => {
                    cycle.inconclusive_reason = Some(reason);
                    break;
                }
            }
            let sample_deadline = deadline.min(crate::add(self.fresh_time(now)?, SAMPLE_MS)?);
            let dispatch = self
                .cache_dispatch(&session, &target, slot, self.fresh_time(now)?)
                .await?;
            let conversation = if index == 7 || index == 8 {
                &conversation_b
            } else {
                &conversation_a
            };
            let fetched = io
                .fetch(
                    &dispatch,
                    &body,
                    conversation,
                    target.catalog_client_version.as_deref(),
                    sample_deadline,
                )
                .await;
            let mut response = match fetched {
                Ok(value) => value,
                Err(error) => {
                    let _ = self
                        .finish_cache_dispatch(&dispatch, false, self.fresh_time(now)?)
                        .await;
                    return Err(error);
                }
            };
            let observed = io.observed_response(&dispatch, &mut response).await;
            if let Err(error) = observed.and(
                self.cache_session_current(&session, self.fresh_time(now)?)
                    .await,
            ) {
                io.discard(response);
                let _ = self
                    .finish_cache_dispatch(&dispatch, false, self.fresh_time(now)?)
                    .await;
                return Err(error);
            }
            let read = io
                .read(response, slot, &target.model, index, sample_deadline)
                .await;
            let completed = read.as_ref().is_ok_and(|r| r.completed);
            let _ = self
                .finish_cache_dispatch(&dispatch, completed, self.fresh_time(now)?)
                .await;
            match read?.value {
                Err(reason) => {
                    cycle.inconclusive_reason = Some(reason);
                    break;
                }
                Ok(sample) => {
                    if !sample.valid(index) {
                        cycle.inconclusive_reason = Some(Reason::SlotDrift);
                        break;
                    }
                    if let Err(reason) = sample_signal(&cycle.samples, &sample, index) {
                        cycle.inconclusive_reason = Some(reason);
                        break;
                    }
                    cycle.samples.push(sample);
                }
            }
        }
        cycle.classification = if cycle.inconclusive_reason.is_none() {
            classify(&target.model, &cycle.samples)
        } else {
            None
        };
        let Some(scope) = &cycle.classification else {
            let reason = cycle.inconclusive_reason.unwrap_or(Reason::SlotDrift);
            cycle.inconclusive_reason = Some(reason);
            return self
                .finalize_cache_cycle(
                    permit,
                    Outcome::Inconclusive,
                    Some(&cycle),
                    Some(reason),
                    self.fresh_time(now)?,
                )
                .await;
        };
        let mut next = state.clone();
        next.target = target;
        next.auth_pool_versionstamp = session.revision;
        next.next_cycle += 1;
        next.classifications.push(scope.clone());
        if next.next_cycle == 4 {
            if !next.classifications.iter().all(|s| s == scope) {
                return self
                    .finalize_cache_cycle(
                        permit,
                        Outcome::Inconclusive,
                        Some(&cycle),
                        Some(Reason::CycleDisagreement),
                        self.fresh_time(now)?,
                    )
                    .await;
            }
            next.pending_scope = Some(scope.clone());
        }
        let intermediate = self
            .persist_cache_cycle(permit, &next, &cycle, self.fresh_time(now)?)
            .await?;
        if next.next_cycle <= 3 {
            return Ok(intermediate);
        }
        let target = next.target.clone();
        let pending = CyclePermit {
            state: next,
            cycle_owner: permit.cycle_owner.clone(),
        };
        self.promote_cache_scope(&pending, &target, promoted, self.fresh_time(now)?)
            .await
    }
}
