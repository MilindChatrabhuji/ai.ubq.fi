//! Exact source v5 campaign vocabulary; these records contain no credentials.
use gateway_core::GatewayError;
use serde::{Deserialize, Deserializer, Serialize};

pub const PROVIDER: &str = "codex_chatgpt";
pub const TELEMETRY_PROVIDER: &str = "chatgpt_codex";
pub const PROFILE: &str = "responses_implicit_input_text_keyed_cycle_isolated_v5";
pub const SESSION_MS: i64 = 900_000;
pub const LEASE_MS: i64 = 120_000;
pub const CYCLE_MS: i64 = 100_000;
pub const SAMPLE_MS: i64 = 7_000;
pub const SLOTS: [u8; 10] = [1, 1, 2, 2, 1, 1, 1, 1, 1, 1];
pub const STEPS: [&str; 10] = [
    "slot_1_warm",
    "slot_1_repeat",
    "slot_2_first",
    "slot_2_repeat",
    "slot_1_after_slot_2",
    "slot_1_after_refresh",
    "slot_1_post_refresh_repeat",
    "slot_1_conversation_changed",
    "slot_1_conversation_changed_repeat",
    "slot_1_original_conversation_recheck",
];
const MAX_SAFE: u64 = 9_007_199_254_740_991;

pub fn unavailable(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "prompt_cache_scope_experiment_unavailable")
}
pub fn failed(message: &str) -> GatewayError {
    GatewayError::unavailable(message, "prompt_cache_scope_experiment_failed")
}
pub fn busy() -> GatewayError {
    GatewayError::new(
        409,
        "A prompt-cache scope experiment campaign is already running for the active provider.",
        Some("prompt_cache_scope_experiment_busy"),
    )
}
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
fn nullable<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d).map(|s| {
        s.map(|s| {
            s.trim_matches(gateway_schema::util::js_whitespace)
                .to_owned()
        })
    })
}
fn trimmed<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    String::deserialize(d).map(|s| {
        s.trim_matches(gateway_schema::util::js_whitespace)
            .to_owned()
    })
}
fn nonnegative<'de, D: Deserializer<'de>, T: TryFrom<u64>>(d: D) -> Result<T, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    let number = value
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v <= MAX_SAFE as f64)
        .ok_or_else(|| serde::de::Error::custom("Expected a nonnegative safe integer."))?;
    T::try_from(number as u64)
        .map_err(|_| serde::de::Error::custom("Integer does not fit its source field."))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetBinding {
    #[serde(deserialize_with = "trimmed")]
    pub id: String,
    pub provider: String,
    pub telemetry_provider: String,
    pub topology_kind: String,
    #[serde(deserialize_with = "trimmed")]
    pub model: String,
    pub probe_profile: String,
    #[serde(deserialize_with = "trimmed")]
    pub capability_fingerprint: String,
    #[serde(deserialize_with = "trimmed")]
    pub inventory_fingerprint: String,
    #[serde(deserialize_with = "trimmed")]
    pub catalog_versionstamp: String,
    #[serde(deserialize_with = "trimmed")]
    pub runtime_versionstamp: String,
    #[serde(deserialize_with = "trimmed")]
    pub auth_pool_versionstamp: String,
    #[serde(deserialize_with = "trimmed")]
    pub auth_pool_identity_fingerprint: String,
    #[serde(deserialize_with = "nullable")]
    pub catalog_client_version: Option<String>,
}
impl TargetBinding {
    pub fn validate(&self) -> Result<(), GatewayError> {
        let fields = [
            &self.id,
            &self.model,
            &self.capability_fingerprint,
            &self.inventory_fingerprint,
            &self.catalog_versionstamp,
            &self.runtime_versionstamp,
            &self.auth_pool_versionstamp,
            &self.auth_pool_identity_fingerprint,
        ];
        if self.provider != PROVIDER
            || self.telemetry_provider != TELEMETRY_PROVIDER
            || self.topology_kind != "codex_account_pool"
            || self.probe_profile != PROFILE
            || fields.iter().any(|s| {
                s.trim_matches(gateway_schema::util::js_whitespace)
                    .is_empty()
            })
            || self.catalog_client_version.as_ref().is_some_and(|s| {
                s.trim_matches(gateway_schema::util::js_whitespace)
                    .is_empty()
            })
        {
            return Err(unavailable(
                "Prompt-cache scope experiment target binding is malformed.",
            ));
        }
        Ok(())
    }
    pub fn same_core(&self, other: &Self) -> bool {
        self.id == other.id
            && self.provider == other.provider
            && self.telemetry_provider == other.telemetry_provider
            && self.topology_kind == other.topology_kind
            && self.model == other.model
            && self.probe_profile == other.probe_profile
            && self.capability_fingerprint == other.capability_fingerprint
            && self.auth_pool_identity_fingerprint == other.auth_pool_identity_fingerprint
            && self.catalog_client_version == other.catalog_client_version
    }
    pub fn same_definition(&self, other: &Self) -> bool {
        self.id == other.id
            && self.provider == other.provider
            && self.telemetry_provider == other.telemetry_provider
            && self.topology_kind == other.topology_kind
            && self.model == other.model
            && self.probe_profile == other.probe_profile
            && self.capability_fingerprint == other.capability_fingerprint
            && self.inventory_fingerprint == other.inventory_fingerprint
            && self.auth_pool_identity_fingerprint == other.auth_pool_identity_fingerprint
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    AuthPoolDrift,
    CapabilityChanged,
    CycleDisagreement,
    EffectiveModelDrift,
    IncompleteTelemetry,
    InvalidCacheSignal,
    InvalidInputSize,
    InventoryDrift,
    LeaseLost,
    ModelDrift,
    PromotionConflict,
    RefreshUnchanged,
    RuntimeDrift,
    SessionExpired,
    SlotDrift,
    TargetCatalogDrift,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Signal {
    Read,
    Write,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountSlots {
    Shared,
    AccountScoped,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenRefresh {
    Preserved,
    Changed,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Conversation {
    Independent,
    Scoped,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub probe_profile: String,
    pub account_slots: AccountSlots,
    pub token_refresh: TokenRefresh,
    pub conversation_id: Conversation,
    pub effective_model: String,
}
impl Scope {
    pub fn valid_for(&self, model: &str) -> bool {
        self.probe_profile == PROFILE && self.effective_model == model
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    #[serde(deserialize_with = "nonnegative")]
    pub input_tokens: u64,
    #[serde(deserialize_with = "nonnegative")]
    pub cached_tokens: u64,
    #[serde(deserialize_with = "nonnegative")]
    pub cache_write_tokens: u64,
    #[serde(deserialize_with = "nonnegative")]
    pub output_tokens: u64,
    #[serde(deserialize_with = "nonnegative")]
    pub total_tokens: u64,
}
impl Usage {
    pub fn valid(&self) -> bool {
        [
            self.input_tokens,
            self.cached_tokens,
            self.cache_write_tokens,
            self.output_tokens,
            self.total_tokens,
        ]
        .into_iter()
        .all(|v| v <= MAX_SAFE)
    }
    pub fn signal(&self) -> Option<Signal> {
        let prefix = |v| v == 0 || (v >= 2_000 && v <= self.input_tokens);
        if !prefix(self.cached_tokens) || !prefix(self.cache_write_tokens) {
            return None;
        }
        if self.cached_tokens > 0 {
            Some(Signal::Read)
        } else if self.cache_write_tokens > 0 {
            Some(Signal::Write)
        } else {
            None
        }
    }
    pub fn matches_reusable(&self, reusable: u64) -> bool {
        [self.cached_tokens, self.cache_write_tokens]
            .into_iter()
            .all(|v| v == 0 || v == reusable)
    }
    pub fn mixed(&self) -> bool {
        self.signal().is_some() && self.cached_tokens > 0 && self.cache_write_tokens > 0
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub step: String,
    #[serde(deserialize_with = "nonnegative")]
    pub slot: u8,
    pub raw_usage: Usage,
    pub usage: Usage,
    #[serde(deserialize_with = "nonnegative")]
    pub elapsed_ms: u64,
}
impl Sample {
    pub fn valid(&self, index: usize) -> bool {
        STEPS.get(index).is_some_and(|name| self.step == *name)
            && SLOTS.get(index) == Some(&self.slot)
            && self.raw_usage.valid()
            && self.usage == self.raw_usage
            && self.elapsed_ms <= MAX_SAFE
    }
}
pub fn sample_signal(samples: &[Sample], sample: &Sample, index: usize) -> Result<Signal, Reason> {
    if !(2_000..=4_000).contains(&sample.usage.input_tokens) {
        return Err(Reason::InvalidInputSize);
    }
    if !sample.raw_usage.valid() || sample.raw_usage != sample.usage {
        return Err(Reason::IncompleteTelemetry);
    }
    let signal = sample.usage.signal().ok_or(Reason::InvalidCacheSignal)?;
    let expected = match index {
        0 => Some(Signal::Write),
        2 | 5 | 7 => None,
        _ => Some(Signal::Read),
    };
    if expected.is_some_and(|value| value != signal) {
        return Err(Reason::InvalidCacheSignal);
    }
    if index > 0
        && !samples.first().is_some_and(|first| {
            sample
                .usage
                .matches_reusable(first.usage.cache_write_tokens)
        })
    {
        return Err(Reason::InvalidCacheSignal);
    }
    if [2, 5, 7].contains(&index) && sample.usage.mixed() {
        return Err(Reason::InvalidCacheSignal);
    }
    Ok(signal)
}
pub fn classify(model: &str, samples: &[Sample]) -> Option<Scope> {
    if samples.len() != 10 || samples.iter().enumerate().any(|(i, s)| !s.valid(i)) {
        return None;
    }
    let first = samples.first()?;
    if first.usage.cache_write_tokens == 0
        || samples
            .iter()
            .any(|s| s.usage.input_tokens != first.usage.input_tokens)
    {
        return None;
    }
    let signals = samples
        .iter()
        .map(|s| s.usage.signal())
        .collect::<Option<Vec<_>>>()?;
    if samples.iter().enumerate().any(|(i, s)| {
        !s.usage.matches_reusable(first.usage.cache_write_tokens)
            || ([2, 5, 7].contains(&i) && s.usage.mixed())
            || (if i == 0 {
                signals[i] != Signal::Write
            } else {
                ![2, 5, 7].contains(&i) && signals[i] != Signal::Read
            })
    }) {
        return None;
    }
    Some(Scope {
        probe_profile: PROFILE.into(),
        effective_model: model.into(),
        account_slots: if signals[2] == Signal::Read {
            AccountSlots::Shared
        } else {
            AccountSlots::AccountScoped
        },
        token_refresh: if signals[5] == Signal::Read {
            TokenRefresh::Preserved
        } else {
            TokenRefresh::Changed
        },
        conversation_id: if signals[7] == Signal::Read {
            Conversation::Independent
        } else {
            Conversation::Scoped
        },
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cycle {
    #[serde(deserialize_with = "nonnegative")]
    pub cycle: u8,
    pub samples: Vec<Sample>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub classification: Option<Scope>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub inconclusive_reason: Option<Reason>,
}
impl Cycle {
    pub fn valid(&self, model: &str) -> bool {
        if !(1..=3).contains(&self.cycle)
            || self.samples.len() > 10
            || self.samples.iter().enumerate().any(|(i, s)| !s.valid(i))
        {
            return false;
        }
        match (&self.classification, self.inconclusive_reason) {
            (Some(scope), None) => {
                scope.valid_for(model) && classify(model, &self.samples).as_ref() == Some(scope)
            }
            (None, Some(_)) => true,
            _ => false,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    #[serde(deserialize_with = "nonnegative")]
    pub v: u8,
    pub target: TargetBinding,
    #[serde(deserialize_with = "trimmed")]
    pub campaign_owner: String,
    #[serde(deserialize_with = "nonnegative")]
    pub started_at_ms: i64,
    #[serde(deserialize_with = "nonnegative")]
    pub expires_at_ms: i64,
    #[serde(deserialize_with = "trimmed")]
    pub auth_pool_versionstamp: String,
    #[serde(deserialize_with = "nonnegative")]
    pub next_cycle: u8,
    pub classifications: Vec<Scope>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_scope: Option<Scope>,
}
impl State {
    pub fn valid(&self, now: i64) -> bool {
        self.v == 3
            && self.target.validate().is_ok()
            && !self.campaign_owner.trim().is_empty()
            && self.auth_pool_versionstamp == self.target.auth_pool_versionstamp
            && self.started_at_ms > 0
            && self.started_at_ms <= now
            && self.expires_at_ms > self.started_at_ms
            && self.expires_at_ms <= MAX_SAFE as i64
            && (1..=4).contains(&self.next_cycle)
            && self.classifications.len() == usize::from(self.next_cycle.saturating_sub(1))
            && self
                .classifications
                .iter()
                .all(|s| s.valid_for(&self.target.model))
            && if self.next_cycle == 4 {
                self.pending_scope
                    .as_ref()
                    .is_some_and(|p| self.classifications.iter().all(|s| s == p))
            } else {
                self.pending_scope.is_none()
            }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    InProgress,
    ReadyToPromote,
    Completed,
    Inconclusive,
    Failed,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    #[serde(deserialize_with = "nonnegative")]
    pub v: u8,
    pub target: TargetBinding,
    pub outcome: Outcome,
    #[serde(deserialize_with = "nonnegative")]
    pub started_at_ms: i64,
    #[serde(deserialize_with = "nonnegative")]
    pub verified_at_ms: i64,
    pub cycles: Vec<Cycle>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub inconclusive_reason: Option<Reason>,
}
impl Evidence {
    pub fn valid(&self, now: i64) -> bool {
        if self.v != 3
            || self.target.validate().is_err()
            || self.started_at_ms <= 0
            || self.verified_at_ms < self.started_at_ms
            || self.verified_at_ms > now
            || self.cycles.len() > 3
            || self
                .cycles
                .iter()
                .enumerate()
                .any(|(i, c)| usize::from(c.cycle) != i + 1 || !c.valid(&self.target.model))
        {
            return false;
        }
        let all = self.cycles.iter().all(|c| c.classification.is_some());
        let agree = self
            .cycles
            .first()
            .and_then(|c| c.classification.as_ref())
            .is_some_and(|first| {
                self.cycles
                    .iter()
                    .all(|c| c.classification.as_ref() == Some(first))
            });
        match self.outcome {
            Outcome::InProgress => {
                self.inconclusive_reason.is_none() && all && self.cycles.len() < 3
            }
            Outcome::ReadyToPromote | Outcome::Completed => {
                self.inconclusive_reason.is_none() && self.cycles.len() == 3 && agree
            }
            Outcome::Failed => self.inconclusive_reason.is_none() && all,
            Outcome::Inconclusive => {
                self.inconclusive_reason.is_some()
                    && self.cycles.split_last().is_none_or(|(last, prior)| {
                        prior.iter().all(|c| c.classification.is_some())
                            && (last.classification.is_some()
                                || last.inconclusive_reason == self.inconclusive_reason)
                    })
            }
        }
    }
    pub fn consistent_with(&self, state: &State) -> bool {
        self.target.same_definition(&state.target)
            && self.started_at_ms == state.started_at_ms
            && self.cycles.len() == state.classifications.len()
            && self
                .cycles
                .iter()
                .zip(&state.classifications)
                .all(|(c, s)| c.classification.as_ref() == Some(s))
            && self.outcome
                == if state.next_cycle == 4 {
                    Outcome::ReadyToPromote
                } else {
                    Outcome::InProgress
                }
    }
}
