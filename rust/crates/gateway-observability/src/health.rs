//! Source ba5ef05e provider/health.ts and paid-fallback/health.ts.
use crate::{ObservabilityRuntime, completion::Completion, store, types::*};
use gateway_core::{
    GatewayError,
    query::QueryStore,
    state::{AuthorityStore, RecordKey},
};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

pub const HEARTBEAT_MS: i64 = 60_000;
pub const STALE_AFTER_MS: i64 = 30 * 60_000;
const RECORDS: [&str; 7] = [
    "current",
    "success",
    "reachable",
    "auth_invalid",
    "quota_exhausted",
    "upstream_error",
    "refresh",
];
#[derive(Clone)]
struct Pending {
    observation: HealthObservation,
    tail: Completion<HealthWrite>,
    sequence: u64,
}
#[derive(Default)]
struct WriterState {
    last: BTreeMap<String, HealthObservation>,
    pending: BTreeMap<String, Pending>,
    sequence: u64,
}
#[derive(Clone, Default)]
pub(crate) struct HealthWriter(Rc<RefCell<WriterState>>);

struct HealthCompletion {
    writer: HealthWriter,
    key: String,
    sequence: u64,
    tail: Completion<HealthWrite>,
    finished: bool,
}
impl HealthCompletion {
    fn complete(&self, result: HealthWrite) {
        {
            let mut state = self.writer.0.borrow_mut();
            if state
                .pending
                .get(&self.key)
                .is_some_and(|p| p.sequence == self.sequence)
            {
                state.pending.remove(&self.key);
            }
        }
        self.tail.finish(result);
    }
    fn finish(mut self, result: HealthWrite) -> HealthWrite {
        self.complete(result);
        self.finished = true;
        result
    }
}
impl Drop for HealthCompletion {
    fn drop(&mut self) {
        if !self.finished {
            self.complete(HealthWrite::Unavailable)
        }
    }
}

pub fn normalize_provider_request_id(value: Option<&str>) -> Option<String> {
    value
        .map(store::trim)
        .filter(|s| {
            !s.is_empty()
                && s.encode_utf16().count() <= 256
                && !s.chars().any(|c| c < '\u{20}' || c == '\u{7f}')
        })
        .map(str::to_owned)
}
pub fn health_key(target: &HealthTarget, record: &str) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "provider_health",
        "v1",
        target.provider.id(),
        target.identity,
        record
    ]))
}
pub fn parse_observation(value: &Value) -> Option<HealthObservation> {
    if !store::is_record(value)
        || !value
            .get("status")
            .is_some_and(|v| v.is_null() || v.as_f64().is_some_and(f64::is_finite))
    {
        return None;
    }
    let time = value.get("observed_at_ms")?.as_f64()?;
    if !time.is_finite() || time < 0.0 {
        return None;
    }
    if value
        .get("provider_request_id")
        .is_some_and(|v| !v.is_null() && normalize_provider_request_id(v.as_str()).is_none())
    {
        return None;
    }
    serde_json::from_value(value.clone()).ok()
}
pub fn unknown_health() -> Value {
    json!({"state":"unknown","stale":null,"last_event":null,"last_status":null,"last_observed_at_ms":null,"last_provider_request_id":null,"last_provider_request_id_at_ms":null,"last_success_at_ms":null,"last_401_at_ms":null,"last_429_at_ms":null,"last_error_at_ms":null,"last_refresh_at_ms":null,"last_refresh_succeeded":null})
}
fn latest(
    observations: &[HealthObservation],
    allowed: impl Fn(&HealthObservation) -> bool,
) -> Option<&HealthObservation> {
    observations
        .iter()
        .filter(|o| allowed(o))
        .fold(None, |previous, current| {
            if previous
                .is_none_or(|p: &HealthObservation| current.observed_at_ms > p.observed_at_ms)
            {
                Some(current)
            } else {
                previous
            }
        })
}
pub fn project_health(observations: &[HealthObservation], now_ms: i64) -> Value {
    let Some(current) = latest(observations, |_| true) else {
        return unknown_health();
    };
    let state = match current.event {
        HealthEvent::Success => "healthy",
        HealthEvent::AuthInvalid => "invalid",
        HealthEvent::QuotaExhausted => "exhausted",
        HealthEvent::RefreshFailed if matches!(current.status, Some(400.0 | 401.0 | 403.0)) => {
            "invalid"
        }
        _ => "degraded",
    };
    let time = |events: &[HealthEvent]| {
        latest(observations, |o| events.contains(&o.event)).map(|o| o.observed_at_ms)
    };
    let correlation = latest(observations, |o| {
        normalize_provider_request_id(o.provider_request_id.as_deref()).is_some()
    });
    let refresh = latest(observations, |o| {
        matches!(
            o.event,
            HealthEvent::RefreshSuccess | HealthEvent::RefreshFailed
        )
    });
    json!({"state":state,"stale":now_ms as f64-current.observed_at_ms>STALE_AFTER_MS as f64,"last_event":current.event,"last_status":current.status,"last_observed_at_ms":current.observed_at_ms,"last_provider_request_id":correlation.and_then(|o|normalize_provider_request_id(o.provider_request_id.as_deref())),"last_provider_request_id_at_ms":correlation.map(|o|o.observed_at_ms),"last_success_at_ms":time(&[HealthEvent::Success]),"last_401_at_ms":time(&[HealthEvent::AuthInvalid]),"last_429_at_ms":time(&[HealthEvent::QuotaExhausted]),"last_error_at_ms":time(&[HealthEvent::UpstreamError,HealthEvent::RefreshFailed]),"last_refresh_at_ms":refresh.map(|o|o.observed_at_ms),"last_refresh_succeeded":refresh.map(|o|o.event==HealthEvent::RefreshSuccess)})
}
pub fn aggregate_states(states: &[&str]) -> &'static str {
    if states.is_empty() || states.iter().all(|s| *s == "unknown") {
        "unknown"
    } else if states.contains(&"healthy") {
        "healthy"
    } else if states.iter().all(|s| *s == "invalid") {
        "invalid"
    } else if states.iter().all(|s| *s == "exhausted") {
        "exhausted"
    } else {
        "degraded"
    }
}
/// The body is borrowed clone evidence. Incomplete/oversized bodies cannot prove exhaustion.
pub fn paid_health(
    provider: HealthProvider,
    status: Option<u16>,
    body: &[u8],
    complete: bool,
) -> Option<HealthEvent> {
    let is_surplus = provider == HealthProvider::Surplus;
    if !is_surplus && provider != HealthProvider::Metered {
        return None;
    }
    let payload = if complete && body.len() <= 64 * 1024 {
        serde_json::from_slice::<Value>(body)
            .ok()
            .filter(store::is_record)
    } else {
        None
    };
    let exhausted = payload.as_ref().is_some_and(|v| {
        if is_surplus {
            let error = v.get("error").filter(|v| store::is_record(v)).unwrap_or(v);
            ["code", "type"].iter().any(|field| {
                error[*field]
                    .as_str()
                    .is_some_and(|s| store::trim(s).eq_ignore_ascii_case("insufficient_credit"))
            })
        } else {
            let error = v.get("error").filter(|v| store::is_record(v));
            error.is_some_and(|e| {
                e["code"].as_str().is_some_and(|s| {
                    store::trim(s).eq_ignore_ascii_case("local:insufficient_quota")
                }) || e["message"]
                    .as_str()
                    .is_some_and(|s| s.to_lowercase().contains("quota is not enough"))
            })
        }
    });
    match status {
        Some(401 | 403)
            if provider == HealthProvider::Metered && status == Some(403) && exhausted =>
        {
            Some(HealthEvent::QuotaExhausted)
        }
        Some(401 | 403) => Some(HealthEvent::AuthInvalid),
        Some(402) if is_surplus && !exhausted => Some(HealthEvent::UpstreamError),
        Some(402 | 429) => Some(HealthEvent::QuotaExhausted),
        None | Some(500..) => Some(HealthEvent::UpstreamError),
        Some(100..) => Some(HealthEvent::Reachable),
        _ => None,
    }
}
pub(crate) async fn binding_current<S: AuthorityStore>(
    store: &S,
    target: &HealthTarget,
) -> Result<bool, GatewayError> {
    if target.provider == HealthProvider::ClaudeCode
        && target.identity != "default"
        && target.source_checks.is_empty()
    {
        return Ok(false);
    }
    for fence in &target.source_checks {
        if store.read(&fence.key).await?.as_ref().map(|r| &r.revision)
            != fence.expected_revision.as_ref()
        {
            return Ok(false);
        }
    }
    Ok(true)
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn provider_health(
        &self,
        target: &HealthTarget,
        at_ms: i64,
    ) -> Result<Value, GatewayError> {
        let mut observations = Vec::new();
        for record in RECORDS {
            if let Some(row) = self.store.read(&health_key(target, record)).await?
                && let Some(v) = store::value(Some(&row), at_ms)?.and_then(parse_observation)
            {
                observations.push(v)
            }
        }
        if target.provider == HealthProvider::ClaudeCode
            && !binding_current(self.store.as_ref(), target).await?
        {
            return Ok(unknown_health());
        }
        Ok(project_health(&observations, at_ms))
    }
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    /// Arrival-ordered isolate queue; clones share this state. Optional writes never error to routing.
    pub async fn observe_provider(
        &self,
        target: HealthTarget,
        event: HealthEvent,
        status: Option<u16>,
        provider_request_id: Option<&str>,
    ) -> HealthWrite {
        let Ok(at) = store::now(self.host.as_ref()) else {
            return HealthWrite::Unavailable;
        };
        let observation = HealthObservation {
            event,
            status: status.map(f64::from),
            observed_at_ms: at as f64,
            provider_request_id: normalize_provider_request_id(provider_request_id),
        };
        let queue_key = format!("{}:{}", target.provider.id(), target.identity);
        let previous = { self.health.0.borrow().pending.get(&queue_key).cloned() };
        if let Some(ref pending) = previous
            && pending.observation.event == event
            && pending.observation.status == observation.status
            && (pending.observation.provider_request_id.is_some()
                || observation.provider_request_id.is_none())
        {
            return match pending.tail.clone().await {
                HealthWrite::Stored | HealthWrite::Throttled | HealthWrite::Coalesced => {
                    HealthWrite::Coalesced
                }
                outcome => outcome,
            };
        }
        let sequence = {
            let mut state = self.health.0.borrow_mut();
            state.sequence = state.sequence.wrapping_add(1);
            state.sequence
        };
        let tail = Completion::new();
        let completion = HealthCompletion {
            writer: self.health.clone(),
            key: queue_key.clone(),
            sequence,
            tail: tail.clone(),
            finished: false,
        };
        self.health.0.borrow_mut().pending.insert(
            queue_key,
            Pending {
                observation: observation.clone(),
                tail: tail.clone(),
                sequence,
            },
        );
        if let Some(pending) = previous {
            pending.tail.await;
        }
        let result = self
            .persist_health(&target, observation, &completion.key)
            .await;
        completion.finish(result)
    }
    async fn persist_health(
        &self,
        target: &HealthTarget,
        observation: HealthObservation,
        queue_key: &str,
    ) -> HealthWrite {
        if target.identity.is_empty() {
            return HealthWrite::Unavailable;
        }
        let throttle = self
            .health
            .0
            .borrow()
            .last
            .get(queue_key)
            .is_some_and(|previous| {
                previous.event == observation.event
                    && previous.status == observation.status
                    && !(normalize_provider_request_id(previous.provider_request_id.as_deref())
                        .is_none()
                        && observation.provider_request_id.is_some())
                    && observation.observed_at_ms - previous.observed_at_ms < HEARTBEAT_MS as f64
            });
        if throttle {
            return HealthWrite::Throttled;
        }
        let result: Result<HealthWrite, GatewayError> = async {
            if !binding_current(self.store.as_ref(), target).await? {
                return Ok(HealthWrite::BindingChanged);
            }
            let value = serde_json::to_value(&observation)
                .map_err(|_| store::error("Invalid health observation"))?;
            let writes = vec![
                store::put(
                    self.host.as_ref(),
                    health_key(target, "current"),
                    value.clone(),
                    None,
                )?,
                store::put(
                    self.host.as_ref(),
                    health_key(target, observation.event.record()),
                    value,
                    None,
                )?,
            ];
            Ok(
                if store::commit(self.store.as_ref(), target.source_checks.clone(), writes).await? {
                    HealthWrite::Stored
                } else {
                    HealthWrite::BindingChanged
                },
            )
        }
        .await;
        match result {
            Ok(HealthWrite::Stored) => {
                self.health
                    .0
                    .borrow_mut()
                    .last
                    .insert(queue_key.into(), observation);
                HealthWrite::Stored
            }
            Ok(v) => v,
            Err(_) => HealthWrite::Unavailable,
        }
    }
}
