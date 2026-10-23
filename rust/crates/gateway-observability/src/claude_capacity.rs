//! Post-acceptance source Claude history/rollups. Never a quota writer.
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use crate::{
    capacity_shapes::{BUCKET_MS, HOUR_MS, RETENTION_MS, STALE_MS},
    host_types::{ClaudeAcceptedObservation, ClaudeObservationState, CredentialKind},
    replay_values::SourceObject,
    store,
};
use gateway_auth::crypto::sha256_hex;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    query::{QuerySelector, QueryStore},
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
    source_serialization as source,
    state::{RecordKey, RecordMutation, StoredRecord},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
const WINDOWS: [&str; 2] = ["five_hour", "seven_day"];
const LIMIT: usize = 20_000;
fn safe(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)
}
fn optional_time(n: Option<f64>) -> bool {
    n.is_none_or(safe)
}
fn identity(s: &str) -> bool {
    !s.is_empty() && s.encode_utf16().count() <= 200
}
fn workspace(s: &Option<JsString16>) -> bool {
    s.as_ref()
        .is_none_or(|s| !s.as_units().is_empty() && s.as_units().len() <= 200)
}
fn percent(n: Option<f64>) -> bool {
    n.is_none_or(|n| n.is_finite() && (0.0..=100.0).contains(&n))
}
pub fn used_percent(value: Option<f64>) -> Option<f64> {
    value
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| (n * 100.0).min(100.0))
}
#[derive(Clone, Deserialize, Serialize)]
struct Window {
    status: Option<JsString16>,
    used_percent: Option<f64>,
    reset_at_ms: Option<f64>,
    observed_at_ms: Option<f64>,
}
impl Window {
    fn valid(&self, sampled: f64) -> bool {
        percent(self.used_percent)
            && optional_time(self.reset_at_ms)
            && optional_time(self.observed_at_ms)
            && self.observed_at_ms.is_none_or(|t| t <= sampled)
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct Standard {
    family: String,
    limit: Option<f64>,
    remaining: Option<f64>,
    reset_at_ms: Option<f64>,
    observed_at_ms: Option<f64>,
}
impl Standard {
    fn valid(&self, sampled: f64) -> bool {
        ["requests", "input-tokens", "output-tokens"].contains(&self.family.as_str())
            && [self.limit, self.remaining]
                .iter()
                .all(|n| n.is_none_or(|n| n.is_finite() && n >= 0.0))
            && optional_time(self.reset_at_ms)
            && optional_time(self.observed_at_ms)
            && self.observed_at_ms.is_none_or(|t| t <= sampled)
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct Windows {
    five_hour: Option<Window>,
    seven_day: Option<Window>,
}
impl Windows {
    fn get(&self, name: &str) -> Option<&Window> {
        match name {
            "five_hour" => self.five_hour.as_ref(),
            "seven_day" => self.seven_day.as_ref(),
            _ => None,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct Point {
    v: f64,
    point_id: String,
    bucket_start_at_ms: f64,
    sampled_at_ms: f64,
    source_observed_at_ms: Option<f64>,
    account_id: String,
    account_cohort_id: String,
    credential_kind: CredentialKind,
    workspace_id: Option<JsString16>,
    state: ClaudeObservationState,
    response_status: Option<f64>,
    windows: Windows,
    standard: Vec<Standard>,
}
impl Point {
    fn clock(&self) -> f64 {
        self.source_observed_at_ms.unwrap_or(self.sampled_at_ms)
    }
    fn valid(&self) -> bool {
        self.v == 1.0
            && identity(&self.point_id)
            && identity(&self.account_id)
            && identity(&self.account_cohort_id)
            && workspace(&self.workspace_id)
            && safe(self.bucket_start_at_ms)
            && safe(self.sampled_at_ms)
            && optional_time(self.source_observed_at_ms)
            && self
                .source_observed_at_ms
                .is_none_or(|t| t <= self.sampled_at_ms)
            && (self.clock() / BUCKET_MS as f64).floor() * BUCKET_MS as f64
                == self.bucket_start_at_ms
            && WINDOWS.iter().all(|n| {
                self.windows
                    .get(n)
                    .is_none_or(|w| w.valid(self.sampled_at_ms))
            })
            && self.standard.len() <= 3
            && self.standard.iter().all(|w| w.valid(self.sampled_at_ms))
            && self
                .response_status
                .is_none_or(|n| safe(n) && (100.0..=599.0).contains(&n))
    }
    fn history_key(&self) -> RecordKey {
        history_key(
            self.bucket_start_at_ms,
            &self.account_id,
            &self.account_cohort_id,
        )
    }
    fn rollup_bucket(&self, window: &Window) -> f64 {
        (window
            .observed_at_ms
            .or(self.source_observed_at_ms)
            .unwrap_or(self.sampled_at_ms)
            / HOUR_MS as f64)
            .floor()
            * HOUR_MS as f64
    }
    fn rollup_key(&self, name: &str) -> RecordKey {
        let w = self.windows.get(name).expect("validated window");
        rollup_key_parts(
            self.rollup_bucket(w),
            &self.account_id,
            &self.account_cohort_id,
            name,
            w.reset_at_ms,
        )
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct Flags {
    normal: f64,
    unavailable: bool,
    recovery: bool,
    five_hour: bool,
    seven_day: bool,
}
impl Default for Flags {
    fn default() -> Self {
        Self {
            normal: 0.0,
            unavailable: false,
            recovery: false,
            five_hour: false,
            seven_day: false,
        }
    }
}
#[derive(Deserialize, Serialize)]
struct Bucket {
    v: f64,
    bucket_start_at_ms: f64,
    account_id: String,
    account_cohort_id: String,
    points: Vec<SourceJson>,
    flags: Flags,
}
impl Bucket {
    fn key(&self) -> RecordKey {
        history_key(
            self.bucket_start_at_ms,
            &self.account_id,
            &self.account_cohort_id,
        )
    }
    fn valid(&self) -> bool {
        if self.v != 1.0
            || !safe(self.bucket_start_at_ms)
            || !identity(&self.account_id)
            || !identity(&self.account_cohort_id)
            || !safe(self.flags.normal)
            || self.flags.normal > 2.0
            || self.points.len() > 6
        {
            return false;
        }
        let mut ids = BTreeSet::new();
        self.points.iter().all(|v| {
            v.deserialize::<Point>().is_ok_and(|p| {
                p.valid()
                    && p.bucket_start_at_ms == self.bucket_start_at_ms
                    && p.account_id == self.account_id
                    && p.account_cohort_id == self.account_cohort_id
                    && ids.insert(p.point_id)
            })
        })
    }
}
#[derive(Deserialize, Serialize)]
struct Rollup {
    v: f64,
    bucket_start_at_ms: f64,
    account_id: String,
    account_cohort_id: String,
    credential_kind: CredentialKind,
    workspace_id: Option<JsString16>,
    window: String,
    reset_at_ms: Option<f64>,
    samples: f64,
    available_sample_count: f64,
    unavailable_sample_count: f64,
    first_source_observed_at_ms: Option<f64>,
    last_source_observed_at_ms: Option<f64>,
    first_sampled_at_ms: f64,
    last_sampled_at_ms: f64,
    min_used_percent: Option<f64>,
    max_used_percent: Option<f64>,
    last_used_percent: Option<f64>,
    last_status: Option<JsString16>,
}
impl Rollup {
    fn key(&self) -> RecordKey {
        rollup_key_parts(
            self.bucket_start_at_ms,
            &self.account_id,
            &self.account_cohort_id,
            &self.window,
            self.reset_at_ms,
        )
    }
    fn valid(&self) -> bool {
        if self.v != 1.0
            || !safe(self.bucket_start_at_ms)
            || self.bucket_start_at_ms % HOUR_MS as f64 != 0.0
            || !identity(&self.account_id)
            || !identity(&self.account_cohort_id)
            || !workspace(&self.workspace_id)
            || !WINDOWS.contains(&self.window.as_str())
            || !optional_time(self.reset_at_ms)
            || ![
                self.samples,
                self.available_sample_count,
                self.unavailable_sample_count,
                self.first_sampled_at_ms,
                self.last_sampled_at_ms,
            ]
            .into_iter()
            .all(safe)
            || self.samples == 0.0
            || self.available_sample_count + self.unavailable_sample_count != self.samples
            || self.first_sampled_at_ms > self.last_sampled_at_ms
            || !optional_time(self.first_source_observed_at_ms)
            || !optional_time(self.last_source_observed_at_ms)
            || ![
                self.min_used_percent,
                self.max_used_percent,
                self.last_used_percent,
            ]
            .into_iter()
            .all(percent)
        {
            return false;
        }
        let (first, last) = (
            self.first_source_observed_at_ms,
            self.last_source_observed_at_ms,
        );
        if first.is_some() != last.is_some()
            || first.zip(last).is_some_and(|(f, l)| {
                f > l
                    || l > self.last_sampled_at_ms
                    || f < self.bucket_start_at_ms
                    || l >= self.bucket_start_at_ms + HOUR_MS as f64
            })
        {
            return false;
        }
        let (min, max) = (self.min_used_percent, self.max_used_percent);
        min.is_some() == max.is_some()
            && min.zip(max).is_none_or(|(a, b)| a <= b)
            && self
                .last_used_percent
                .is_none_or(|v| min.zip(max).is_some_and(|(a, b)| v >= a && v <= b))
    }
}
fn history_key(bucket: f64, account: &str, cohort: &str) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "provider_capacity",
        "claude",
        "v1",
        "history",
        bucket,
        account,
        cohort
    ]))
}
fn rollup_key_parts(
    bucket: f64,
    account: &str,
    cohort: &str,
    window: &str,
    reset: Option<f64>,
) -> RecordKey {
    store::key(json!([
        "uos_ai",
        "provider_capacity",
        "claude",
        "v1",
        "rollup",
        bucket,
        account,
        cohort,
        window,
        reset.map_or_else(|| json!("unknown"), |n| json!(n))
    ]))
}
pub fn valid_history_point_source(v: &SourceJson) -> bool {
    v.deserialize::<Point>().is_ok_and(|p| p.valid())
}
pub fn valid_bucket_source(v: &SourceJson) -> bool {
    v.deserialize::<Bucket>().is_ok_and(|p| p.valid())
}
pub fn valid_rollup_source(v: &SourceJson) -> bool {
    v.deserialize::<Rollup>().is_ok_and(|p| p.valid())
}
// Existing scalar custody readers opt into the same finite named validation only.
pub fn valid_history_point(v: &Value) -> bool {
    SourceJson::from_serializable(v).is_ok_and(|v| valid_history_point_source(&v))
}
pub fn valid_bucket(v: &Value) -> bool {
    SourceJson::from_serializable(v).is_ok_and(|v| valid_bucket_source(&v))
}
pub fn valid_rollup(v: &Value) -> bool {
    SourceJson::from_serializable(v).is_ok_and(|v| valid_rollup_source(&v))
}
pub fn claude_history_bucket_record_source(
    key: &RecordKey,
    row: &StoredRecord,
) -> Result<SourceJson, GatewayError> {
    let value = decode_source_control_record(row)?;
    let bucket: Bucket = value.deserialize()?;
    if !bucket.valid() || bucket.key() != *key {
        return Err(store::error("Claude history evidence is corrupt"));
    }
    Ok(value)
}
pub fn claude_rollup_record_source(
    key: &RecordKey,
    row: &StoredRecord,
) -> Result<SourceJson, GatewayError> {
    let value = decode_source_control_record(row)?;
    let rollup: Rollup = value.deserialize()?;
    if !rollup.valid() || rollup.key() != *key {
        return Err(store::error("Claude rollup evidence is corrupt"));
    }
    Ok(value)
}
#[derive(Deserialize)]
struct InputWindow {
    status: Option<JsString16>,
    utilization: Option<f64>,
    reset_at_ms: Option<f64>,
    observed_at_ms: f64,
}
#[derive(Deserialize)]
struct InputStandard {
    limit: Option<f64>,
    remaining: Option<f64>,
    reset_at_ms: Option<f64>,
    observed_at_ms: f64,
}
#[derive(Deserialize)]
struct Observation {
    windows: BTreeMap<String, InputWindow>,
    standard: BTreeMap<String, InputStandard>,
    #[serde(rename = "representative_claim")]
    _representative_claim: Option<JsString16>,
    #[serde(rename = "observed_at_ms")]
    _observed_at_ms: f64,
}
/// Only the actual accepted event's safe fields enter the source digest. Raw
/// quota/identity/credential documents and unknown event metadata are not telemetry.
fn safe_observation(event: &ClaudeAcceptedObservation) -> Result<SourceJson, GatewayError> {
    let mut observation = SourceObject::parse(&event.observation)?;
    for (field, names, leaves) in [
        (
            "windows",
            &["5h", "7d"][..],
            &["status", "utilization", "reset_at_ms", "observed_at_ms"][..],
        ),
        (
            "standard",
            &["requests", "input-tokens", "output-tokens"][..],
            &["limit", "remaining", "reset_at_ms", "observed_at_ms"][..],
        ),
    ] {
        let input = observation
            .get(field)
            .ok_or_else(|| store::error("Accepted Claude observation field is missing"))?;
        let mut output = SourceObject::parse(&SourceObject::parse(input)?.select(names)?)?;
        for name in names {
            if let Some(value) = output.get(name).cloned() {
                output.set(name, &SourceObject::parse(&value)?.select(leaves)?)?;
            }
        }
        observation.set(field, &output.source_json()?)?;
    }
    source::canonical(&observation.select(&[
        "windows",
        "standard",
        "representative_claim",
        "observed_at_ms",
    ])?)
}
pub fn point_for_observation(
    event: &ClaudeAcceptedObservation,
) -> Result<Option<SourceJson>, GatewayError> {
    let observation = safe_observation(event)?;
    let parsed: Observation = observation.deserialize()?;
    if parsed.windows.is_empty() && parsed.standard.is_empty() {
        return Ok(None);
    }
    let standard_order = source::entries(
        &source::member(&observation, "standard")
            .ok_or_else(|| store::error("Accepted Claude standard metadata is missing"))?,
    )
    .ok_or_else(|| store::error("Accepted Claude standard metadata is invalid"))?
    .into_iter()
    .map(|(name, _)| name.try_utf8())
    .collect::<Result<Vec<_>, _>>()?;
    let digest = source::object(vec![
        ("account", SourceJson::from_serializable(&event.account_id)?),
        (
            "cohort",
            SourceJson::from_serializable(&event.account_cohort_id)?,
        ),
        (
            "kind",
            SourceJson::from_serializable(&event.credential_kind)?,
        ),
        (
            "workspace",
            SourceJson::from_serializable(&event.workspace_id)?,
        ),
        ("state", SourceJson::from_serializable(&event.state)?),
        (
            "response_status",
            SourceJson::from_serializable(&event.response_status)?,
        ),
        ("observation", observation),
    ])?;
    let window = |name: &str| {
        parsed.windows.get(name).map(|w| Window {
            status: w.status.clone(),
            used_percent: used_percent(w.utilization),
            reset_at_ms: w.reset_at_ms,
            observed_at_ms: safe(w.observed_at_ms).then_some(w.observed_at_ms),
        })
    };
    let source_time = event
        .source_observed_at_ms
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .map(|n| n as f64);
    let point = Point {
        v: 1.0,
        point_id: sha256_hex(source::canonical(&digest)?.as_bytes()),
        bucket_start_at_ms: (source_time.unwrap_or(event.sampled_at_ms as f64) / BUCKET_MS as f64)
            .floor()
            * BUCKET_MS as f64,
        sampled_at_ms: event.sampled_at_ms as f64,
        source_observed_at_ms: source_time,
        account_id: event.account_id.clone(),
        account_cohort_id: event.account_cohort_id.clone(),
        credential_kind: event.credential_kind,
        workspace_id: event.workspace_id.clone(),
        state: event.state,
        response_status: event.response_status.map(f64::from),
        windows: Windows {
            five_hour: window("5h"),
            seven_day: window("7d"),
        },
        standard: standard_order
            .iter()
            .map(String::as_str)
            .filter_map(|name| {
                parsed.standard.get(name).map(|w| Standard {
                    family: name.into(),
                    limit: w.limit,
                    remaining: w.remaining,
                    reset_at_ms: w.reset_at_ms,
                    observed_at_ms: Some(w.observed_at_ms),
                })
            })
            .collect(),
    };
    if !point.valid() {
        return Ok(None);
    }
    Ok(Some(source::canonical(&SourceJson::from_serializable(
        &point,
    )?)?))
}
fn retain_source(
    previous: Option<&SourceJson>,
    point: &SourceJson,
) -> Result<Option<SourceJson>, GatewayError> {
    let p: Point = point.deserialize()?;
    let old = previous
        .map(SourceJson::deserialize::<Bucket>)
        .transpose()?;
    let points = old
        .as_ref()
        .map(|b| b.points.as_slice())
        .unwrap_or_default();
    let parsed = points
        .iter()
        .map(SourceJson::deserialize::<Point>)
        .collect::<Result<Vec<_>, _>>()?;
    if points.len() >= 6 || parsed.iter().any(|v| v.point_id == p.point_id) {
        return Ok(None);
    }
    let mut flags = old.as_ref().map(|b| b.flags.clone()).unwrap_or_default();
    let mut retain = flags.normal < 2.0;
    if retain {
        flags.normal += 1.0;
    }
    if parsed.last().is_some_and(|v| v.state != p.state) {
        let flag = if p.state == ClaudeObservationState::Unavailable {
            &mut flags.unavailable
        } else {
            &mut flags.recovery
        };
        if !*flag {
            *flag = true;
            retain = true;
        }
    }
    for name in WINDOWS {
        let before = parsed.iter().rev().find_map(|p| p.windows.get(name));
        let after = p.windows.get(name);
        let flag = if name == "five_hour" {
            &mut flags.five_hour
        } else {
            &mut flags.seven_day
        };
        if let Some(after) = after
            && before.is_none_or(|b| b.reset_at_ms != after.reset_at_ms)
            && !*flag
            && !retain
        {
            *flag = true;
            retain = true;
        }
    }
    if !retain {
        return Ok(None);
    }
    let mut timed: Vec<_> = points
        .iter()
        .cloned()
        .zip(
            parsed
                .iter()
                .map(|p| (p.clock() as i64, p.sampled_at_ms as i64)),
        )
        .collect();
    timed.push((point.clone(), (p.clock() as i64, p.sampled_at_ms as i64)));
    timed.sort_by_key(|(_, t)| *t);
    Ok(Some(source::canonical(&SourceJson::from_serializable(
        &Bucket {
            v: 1.0,
            bucket_start_at_ms: p.bucket_start_at_ms,
            account_id: p.account_id,
            account_cohort_id: p.account_cohort_id,
            points: timed.into_iter().map(|(v, _)| v).collect(),
            flags,
        },
    )?)?))
}
fn merge_source(
    previous: Option<&SourceJson>,
    point: &SourceJson,
    name: &str,
) -> Result<SourceJson, GatewayError> {
    let p: Point = point.deserialize()?;
    let w = p
        .windows
        .get(name)
        .ok_or_else(|| store::error("Claude rollup window is missing"))?;
    let bucket = p.rollup_bucket(w);
    let old = previous
        .map(SourceJson::deserialize::<Rollup>)
        .transpose()?;
    if old.as_ref().is_some_and(|v| {
        v.bucket_start_at_ms != bucket
            || v.account_id != p.account_id
            || v.account_cohort_id != p.account_cohort_id
            || v.credential_kind != p.credential_kind
            || v.workspace_id != p.workspace_id
            || v.window != name
            || v.reset_at_ms != w.reset_at_ms
    }) {
        return Err(store::error("Claude rollup binding mismatch"));
    }
    let source_at = w.observed_at_ms.or(p.source_observed_at_ms);
    let sampled = p.sampled_at_ms;
    let newer = old.as_ref().is_none_or(|v| {
        source_at.unwrap_or(sampled) >= v.last_source_observed_at_ms.unwrap_or(v.last_sampled_at_ms)
    });
    let mut values = Vec::new();
    let mut times = Vec::new();
    if let Some(v) = &old {
        values.extend(
            [v.min_used_percent, v.max_used_percent]
                .into_iter()
                .flatten(),
        );
        times.extend(
            [v.first_source_observed_at_ms, v.last_source_observed_at_ms]
                .into_iter()
                .flatten(),
        );
    }
    values.extend(w.used_percent);
    times.extend(source_at);
    let rollup = Rollup {
        v: 1.0,
        bucket_start_at_ms: bucket,
        account_id: p.account_id,
        account_cohort_id: p.account_cohort_id,
        credential_kind: p.credential_kind,
        workspace_id: p.workspace_id,
        window: name.into(),
        reset_at_ms: w.reset_at_ms,
        samples: old.as_ref().map_or(0.0, |v| v.samples) + 1.0,
        available_sample_count: old.as_ref().map_or(0.0, |v| v.available_sample_count)
            + f64::from(u8::from(p.state == ClaudeObservationState::Available)),
        unavailable_sample_count: old.as_ref().map_or(0.0, |v| v.unavailable_sample_count)
            + f64::from(u8::from(p.state == ClaudeObservationState::Unavailable)),
        first_source_observed_at_ms: times.iter().copied().reduce(f64::min),
        last_source_observed_at_ms: times.iter().copied().reduce(f64::max),
        first_sampled_at_ms: old
            .as_ref()
            .map_or(sampled, |v| v.first_sampled_at_ms.min(sampled)),
        last_sampled_at_ms: old
            .as_ref()
            .map_or(sampled, |v| v.last_sampled_at_ms.max(sampled)),
        min_used_percent: values.iter().copied().reduce(f64::min),
        max_used_percent: values.iter().copied().reduce(f64::max),
        last_used_percent: if newer {
            w.used_percent
        } else {
            old.as_ref()
                .expect("previous observation")
                .last_used_percent
        },
        last_status: if newer {
            w.status.clone()
        } else {
            old.as_ref()
                .expect("previous observation")
                .last_status
                .clone()
        },
    };
    source::canonical(&SourceJson::from_serializable(&rollup)?)
}
fn put<H: ObservabilityHost>(
    host: &H,
    key: RecordKey,
    value: &SourceJson,
    expiry: Option<i64>,
) -> Result<RecordMutation, GatewayError> {
    Ok(RecordMutation::Put {
        key,
        record: encode_source_control_record(store::uuid(host)?, value, expiry)?,
    })
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub async fn record_claude_capacity_observation(
        &self,
        event: &ClaudeAcceptedObservation,
    ) -> Result<bool, GatewayError> {
        let Some(point) = point_for_observation(event)? else {
            return Ok(false);
        };
        let p: Point = point.deserialize()?;
        let key = p.history_key();
        let at = store::now(self.host.as_ref())?;
        for _ in 0..4 {
            let row = self.store.read(&key).await?;
            let previous = row
                .as_ref()
                .filter(|r| !r.expires_at_ms.is_some_and(|t| t <= at))
                .map(|r| claude_history_bucket_record_source(&key, r))
                .transpose()?;
            let Some(next) = retain_source(previous.as_ref(), &point)? else {
                return Ok(false);
            };
            let mut checks = vec![store::check(&key, row.as_ref())];
            let expiry = (p.bucket_start_at_ms as i64 + BUCKET_MS + RETENTION_MS).max(at + 1);
            let mut writes = vec![put(self.host.as_ref(), key.clone(), &next, Some(expiry))?];
            for window in WINDOWS {
                if p.windows.get(window).is_none() {
                    continue;
                }
                let key = p.rollup_key(window);
                let row = self.store.read(&key).await?;
                let previous = row
                    .as_ref()
                    .filter(|r| !r.expires_at_ms.is_some_and(|t| t <= at))
                    .map(|r| claude_rollup_record_source(&key, r))
                    .transpose()?;
                let merged = merge_source(previous.as_ref(), &point, window)?;
                checks.push(store::check(&key, row.as_ref()));
                writes.push(put(self.host.as_ref(), key, &merged, None)?);
            }
            if store::commit(self.store.as_ref(), checks, writes).await? {
                return Ok(true);
            }
        }
        Err(store::error(
            "Claude history contention exceeded four attempts",
        ))
    }
    pub async fn claude_capacity_history(&self, at: i64) -> SourceJson {
        let base=source::canonical(&SourceJson::from_serializable(&json!({"v":1,"scan":"unavailable","truncated":false,"bucket_ms":BUCKET_MS,"retention_ms":RETENTION_MS,"stale_after_ms":STALE_MS,"points":[]})).expect("finite history base")).expect("finite history base");
        let read: Result<SourceJson, GatewayError> = async {
            let cutoff = (at - RETENTION_MS).max(0);
            let first = cutoff / BUCKET_MS * BUCKET_MS;
            let end = at / BUCKET_MS * BUCKET_MS + BUCKET_MS;
            let selector = QuerySelector::Range {
                start: store::key(json!([
                    "uos_ai",
                    "provider_capacity",
                    "claude",
                    "v1",
                    "history",
                    first
                ])),
                end: store::key(json!([
                    "uos_ai",
                    "provider_capacity",
                    "claude",
                    "v1",
                    "history",
                    end
                ])),
            };
            let rows =
                store::scan_selector(self.store.as_ref(), selector, true, at, LIMIT + 1).await?;
            let mut points = Vec::new();
            let mut truncated = rows.len() > LIMIT;
            for entry in rows.into_iter().take(LIMIT) {
                let value = claude_history_bucket_record_source(&entry.key, &entry.record)?;
                let bucket: Bucket = value.deserialize()?;
                for point in bucket.points.into_iter().rev() {
                    let p: Point = point.deserialize()?;
                    if p.sampled_at_ms > at as f64 || p.clock() < cutoff as f64 {
                        continue;
                    }
                    if points.len() >= LIMIT {
                        truncated = true;
                        break;
                    }
                    points.push((point, p.clock() as i64));
                }
                if points.len() >= LIMIT && truncated {
                    break;
                }
            }
            points.sort_by_key(|(_, at)| *at);
            let mut out = SourceObject::parse(&base)?;
            out.set("scan", "ok")?;
            out.set("truncated", &truncated)?;
            out.set(
                "points",
                &points.into_iter().map(|(p, _)| p).collect::<Vec<_>>(),
            )?;
            out.source_json()
        }
        .await;
        read.unwrap_or(base)
    }
    pub async fn claude_capacity_rollups(&self, since: i64, at: i64) -> SourceJson {
        let base = SourceJson::parse(r#"{"scan":"unavailable","truncated":false,"points":[]}"#)
            .expect("finite rollup base");
        let read: Result<SourceJson, GatewayError> = async {
            let first = since / HOUR_MS * HOUR_MS;
            let last = at / HOUR_MS * HOUR_MS;
            let selector = QuerySelector::Range {
                start: store::key(json!([
                    "uos_ai",
                    "provider_capacity",
                    "claude",
                    "v1",
                    "rollup",
                    first
                ])),
                end: store::key(json!([
                    "uos_ai",
                    "provider_capacity",
                    "claude",
                    "v1",
                    "rollup",
                    last + HOUR_MS
                ])),
            };
            let rows =
                store::scan_selector(self.store.as_ref(), selector, true, at, LIMIT + 1).await?;
            let truncated = rows.len() > LIMIT;
            let mut points = Vec::new();
            for entry in rows.into_iter().take(LIMIT) {
                let value = claude_rollup_record_source(&entry.key, &entry.record)?;
                let p: Rollup = value.deserialize()?;
                if p.last_sampled_at_ms > at as f64 {
                    return Err(store::error("Claude rollup evidence is corrupt"));
                }
                points.push((value, p.bucket_start_at_ms as i64));
            }
            points.sort_by_key(|(_, at)| *at);
            let mut out = SourceObject::parse(&base)?;
            out.set("scan", "ok")?;
            out.set("truncated", &truncated)?;
            out.set(
                "points",
                &points.into_iter().map(|(p, _)| p).collect::<Vec<_>>(),
            )?;
            out.source_json()
        }
        .await;
        read.unwrap_or(base)
    }
}
