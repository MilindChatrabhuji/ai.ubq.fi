//! Request-owned fixed Codex control experiment. No generic inference or paid fallback.
mod sample;
use crate::{
    authority::RemoteAuthorityStore,
    host::{PlatformClock, PlatformHost, PlatformTokens},
    storage::now_ms,
    transport::{
        outbound::{Cancellation, Deadline, PinnedDestination, send_http},
        random,
    },
};
use futures_util::StreamExt;
use gateway_authority::{
    Authority,
    cache_experiment::{
        CacheDispatch, ExperimentIo, PreparedTarget, ReadSample, RefreshPermit,
        model::{failed, unavailable},
    },
    native_control::actor::{NativeActorScope, NativeRenewalActor},
};
use gateway_core::{GatewayError, identity::PoolVersionstamp, source_json::SourceJson};
use gateway_observability::{
    ObservabilityRuntime,
    types::{HealthEvent, HealthTarget, ObservabilityHost},
};
use gateway_providers::sse::{MAX_RESPONSES_EVENT_BYTES, SseParser};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc, time::Duration};
use worker::{Method, Response};

fn authority(store: RemoteAuthorityStore) -> Authority<RemoteAuthorityStore, PlatformTokens> {
    Authority::with_clock(store, PlatformTokens, PlatformClock)
}
pub async fn prepare(
    store: RemoteAuthorityStore,
    release: &str,
) -> Result<PreparedTarget, GatewayError> {
    if release != env!("UOS_RUST_BUILD_GIT_SHA") {
        return Err(unavailable(
            "Prompt-cache scope experiment requires current-release telemetry.",
        ));
    }
    authority(store)
        .prepare_cache_experiment(release, now_ms()?)
        .await
}
pub async fn run(
    prepared: PreparedTarget,
    platform: &PlatformHost,
    actor: &NativeRenewalActor,
) -> Result<serde_json::Value, GatewayError> {
    if actor.scope() != NativeActorScope::Admin {
        return Err(GatewayError::new(
            403,
            "Admin access is required",
            Some("forbidden"),
        ));
    }
    let io = Host {
        platform,
        actor,
        cycle: RefCell::new(None),
    };
    authority(platform.store.clone())
        .run_cache_experiment(prepared, &io, now_ms()?)
        .await
}
struct CycleTimer {
    cancellation: Rc<Cancellation>,
    _deadline: Deadline,
}
struct Host<'a> {
    platform: &'a PlatformHost,
    actor: &'a NativeRenewalActor,
    cycle: RefCell<Option<CycleTimer>>,
}
impl Host<'_> {
    fn cancellation(&self) -> Result<Rc<Cancellation>, GatewayError> {
        self.cycle
            .borrow()
            .as_ref()
            .map(|c| c.cancellation.clone())
            .ok_or_else(|| failed("Prompt-cache scope experiment cycle is not started."))
    }
    async fn health(
        &self,
        account: &str,
        event: HealthEvent,
        status: Option<u16>,
        request_id: Option<&str>,
    ) {
        let runtime = ObservabilityRuntime::with_state(
            self.platform.store.clone(),
            ClockHost,
            crate::observability_host::shared_state(),
        );
        let _ = runtime
            .observe_provider(HealthTarget::codex(account), event, status, request_id)
            .await;
    }
}
impl Drop for Host<'_> {
    fn drop(&mut self) {
        if let Some(cycle) = self.cycle.get_mut().take() {
            cycle.cancellation.abort();
        }
    }
}
struct ClockHost;
impl ObservabilityHost for ClockHost {
    fn source_string_collator(
        &self,
    ) -> std::sync::Arc<dyn gateway_schema::aliases::SourceStringCollator> {
        crate::source_collator::shared()
    }

    fn now_ms(&self) -> i64 {
        now_ms().unwrap_or(i64::MAX)
    }
    fn random_bytes(&self, length: usize) -> Result<Vec<u8>, GatewayError> {
        random::random_bytes(length)
    }
    async fn wait_ms(&self, milliseconds: u32) -> Result<(), GatewayError> {
        worker::Delay::from(Duration::from_millis(u64::from(milliseconds))).await;
        Ok(())
    }
}
pub struct SampleResponse {
    response: Option<Response>,
    cancellation: Rc<Cancellation>,
    _deadline: Deadline,
    started: Duration,
    slot: u8,
    account_id: String,
}
impl Drop for SampleResponse {
    fn drop(&mut self) {
        self.cancellation.abort();
    }
}
fn request_id(response: &Response) -> Option<String> {
    ["x-request-id", "x-api-request-id", "x-oneapi-request-id"]
        .into_iter()
        .find_map(|name| response.headers().get(name).ok().flatten())
}
fn client_version(value: Option<&str>) -> &str {
    let version = value
        .map(gateway_schema::util::js_trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("0.100.0");
    let parts = version
        .split('.')
        .map(|part| {
            part.parse::<worker::js_sys::Number>()
                .expect("JavaScript Number parsing is infallible")
                .value_of()
        })
        .collect::<Vec<_>>();
    if (2..=3).contains(&parts.len())
        && parts.iter().all(|value| value.is_finite() && *value >= 0.0)
        && [
            parts[0].trunc(),
            parts[1].trunc(),
            parts.get(2).copied().unwrap_or(0.0).trunc(),
        ] < [0.0, 100.0, 0.0]
    {
        "0.100.0"
    } else {
        version
    }
}
impl ExperimentIo for Host<'_> {
    type Response = SampleResponse;
    fn release_git_sha(&self) -> &str {
        env!("UOS_RUST_BUILD_GIT_SHA")
    }
    fn uuid(&self) -> Result<String, GatewayError> {
        random::random_uuid()
    }
    fn begin_cycle(&self, deadline: i64) -> Result<(), GatewayError> {
        let cancellation = Rc::new(Cancellation::background()?);
        let timeout = i32::try_from(deadline.saturating_sub(now_ms()?))
            .map_err(|_| failed("Prompt-cache scope experiment deadline is invalid."))?;
        let timer = cancellation.set_timeout_ms(timeout)?;
        *self.cycle.borrow_mut() = Some(CycleTimer {
            cancellation,
            _deadline: timer,
        });
        Ok(())
    }
    async fn fetch(
        &self,
        dispatch: &CacheDispatch,
        body: &str,
        conversation: &str,
        client: Option<&str>,
        deadline: i64,
    ) -> Result<SampleResponse, GatewayError> {
        let started = crate::admission::monotonic()?;
        let cancellation = Rc::new(self.cancellation()?.child()?);
        let timeout = i32::try_from(deadline.saturating_sub(now_ms()?))
            .map_err(|_| failed("Prompt-cache scope experiment deadline is invalid."))?;
        let timer = cancellation.set_timeout_ms(timeout)?;
        let base = crate::host::setting(&self.platform.env, "CODEX_BASE_URL")
            .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into());
        let target =
            PinnedDestination::new(&format!("{}/responses", base.trim().trim_end_matches('/')))?;
        let headers = BTreeMap::from([
            (
                "Authorization".into(),
                format!("Bearer {}", dispatch.access_token().expose()),
            ),
            ("ChatGPT-Account-ID".into(), dispatch.account_id().into()),
            ("originator".into(), "codex_cli_rs".into()),
            (
                "user-agent".into(),
                format!("codex_cli_rs/{} (ai.ubq.fi)", client_version(client)),
            ),
            ("Content-Type".into(), "application/json".into()),
            ("Accept".into(), "text/event-stream".into()),
            ("conversation_id".into(), conversation.into()),
        ]);
        let response = match send_http(
            &target,
            Method::Post,
            &headers,
            body.as_bytes(),
            &cancellation,
            || async {
                authority(self.platform.store.clone())
                    .ensure_cache_dispatch_current(dispatch, now_ms()?)
                    .await
            },
        )
        .await
        {
            Ok(response) => response,
            Err(_) => {
                self.health(
                    dispatch.account_id(),
                    HealthEvent::UpstreamError,
                    None,
                    None,
                )
                .await;
                return Err(failed(
                    "Codex upstream request failed: upstream unreachable.",
                ));
            }
        };
        Ok(SampleResponse {
            response: Some(response),
            cancellation,
            _deadline: timer,
            started,
            slot: dispatch.slot(),
            account_id: dispatch.account_id().into(),
        })
    }
    async fn observed_response(
        &self,
        dispatch: &CacheDispatch,
        response: &mut SampleResponse,
    ) -> Result<(), GatewayError> {
        let raw = response
            .response
            .as_mut()
            .ok_or_else(|| failed("Prompt-cache scope experiment response is missing."))?;
        let status = raw.status_code();
        let id = request_id(raw);
        let observed_at = now_ms()?;
        let expired =
            gateway_auth::provider_credentials::codex_access_expiry_ms(dispatch.access_token())
                .is_some_and(|exp| exp <= observed_at as f64);
        let event = if status == 401 || (status == 403 && expired) {
            Some(HealthEvent::AuthInvalid)
        } else if status == 429 {
            Some(HealthEvent::QuotaExhausted)
        } else if status >= 500 {
            Some(HealthEvent::UpstreamError)
        } else if !(200..300).contains(&status) {
            Some(HealthEvent::Reachable)
        } else {
            None
        };
        if let Some(event) = event {
            self.health(dispatch.account_id(), event, Some(status), id.as_deref())
                .await;
        }
        if status == 429 {
            let body =
                crate::transport::body::refusal_probe(raw, &response.cancellation, 1_000).await;
            let headers = raw.headers().entries().collect();
            if let Some(block) = gateway_routing_runtime::classify::codex_quota(
                Some(status),
                &headers,
                &body.bytes,
                body.complete,
                now_ms()?,
            ) {
                authority(self.platform.store.clone())
                    .record_cache_quota_block(dispatch, block, now_ms()?)
                    .await?;
            }
        }
        Ok(())
    }
    fn discard(&self, response: SampleResponse) {
        drop(response);
    }
    async fn read(
        &self,
        mut head: SampleResponse,
        slot: u8,
        model: &str,
        index: usize,
        _deadline: i64,
    ) -> Result<ReadSample, GatewayError> {
        let mut response = head
            .response
            .take()
            .ok_or_else(|| failed("Prompt-cache scope experiment response is missing."))?;
        if !(200..300).contains(&response.status_code()) {
            crate::transport::body::discard_response(&mut response);
            return Err(failed(
                "Prompt-cache scope experiment did not receive a readable upstream response.",
            ));
        }
        if head.slot != slot {
            return Ok(ReadSample {
                value: Err(gateway_authority::cache_experiment::Reason::SlotDrift),
                completed: false,
            });
        }
        let id = request_id(&response);
        let status = response.status_code();
        let mut stream = response.stream().map_err(|_| {
            failed("Prompt-cache scope experiment did not receive a readable upstream response.")
        })?;
        let mut parser = SseParser::new(MAX_RESPONSES_EVENT_BYTES);
        loop {
            let next = std::future::poll_fn(|cx| {
                head.cancellation.register_waker(cx.waker());
                if head.cancellation.signal().aborted() {
                    std::task::Poll::Ready(None)
                } else {
                    stream.poll_next_unpin(cx)
                }
            })
            .await;
            if head.cancellation.signal().aborted() {
                return Err(failed("Prompt-cache scope experiment stream failed."));
            }
            let eof = next.is_none();
            let frames = match next {
                Some(Ok(bytes)) => parser.push(&bytes),
                Some(Err(_)) => return Err(failed("Prompt-cache scope experiment stream failed.")),
                None => parser.finish(),
            }
            .map_err(|e| {
                failed(&format!(
                    "Prompt-cache scope experiment stream failed: {}",
                    e.envelope.error.message
                ))
            })?;
            for frame in frames {
                let event=SourceJson::parse(&frame.data).map_err(|_|failed("Prompt-cache scope experiment stream failed: Upstream emitted malformed Responses SSE JSON."))?;
                let kind = sample::event_type(&event)?;
                if kind.as_deref() == Some("response.completed") {
                    let result=sample::member(&event,"response")?.filter(|r|r.as_str().starts_with('{')).ok_or_else(||failed("Prompt-cache scope experiment stream failed: Upstream emitted a Responses terminal event with an invalid payload."))?;
                    let elapsed = (crate::admission::monotonic()?
                        .saturating_sub(head.started)
                        .as_secs_f64()
                        * 1_000.0)
                        .round() as u64;
                    self.health(
                        &head.account_id,
                        HealthEvent::Success,
                        Some(status),
                        id.as_deref(),
                    )
                    .await;
                    return sample::completed(&result, slot, model, index, elapsed);
                }
                if matches!(
                    kind.as_deref(),
                    Some("error" | "response.failed" | "response.incomplete")
                ) {
                    return Err(failed(
                        "Prompt-cache scope experiment did not receive a completed terminal response.",
                    ));
                }
            }
            if eof {
                return Err(failed(
                    "Prompt-cache scope experiment did not receive a completed terminal response.",
                ));
            }
        }
    }
    async fn refresh(&self, permit: RefreshPermit) -> Result<PoolVersionstamp, GatewayError> {
        let mut platform = self.platform.clone();
        platform.cancellation = self.cancellation()?;
        let config = crate::host::auth_config(&platform.env);
        platform
            .native
            .renew_cache_experiment(self.actor, &permit, &platform, &config)
            .await
    }
}
