//! Source Claude quota truth. Health/history remain optional post-acceptance subscribers.
use gateway_admin_runtime::claude::AccountBinding;
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    model::ModelId,
    source_control::{encode_source_control_record, source_json_tree},
    source_json::SourceJson,
    source_serialization as source,
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use gateway_schema::util::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const WINDOWS: [&str; 2] = ["5h", "7d"];
pub const STANDARD_FAMILIES: [&str; 3] = ["requests", "input-tokens", "output-tokens"];
pub const RESET_MARGIN_MS: i64 = 300_000;
pub const MIN_BLOCK_MS: i64 = 300_000;
pub const TRANSIENT_COOLDOWN_MS: i64 = 60_000;
pub const CONFIG_COOLDOWN_MS: i64 = 600_000;
pub const AUTH_INVALID_PROOF_TTL_MS: i64 = 300_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuotaWindow {
    pub status: Option<String>,
    pub utilization: Option<f64>,
    pub reset_at_ms: Option<f64>,
    pub observed_at_ms: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StandardWindow {
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub reset_at_ms: Option<f64>,
    pub observed_at_ms: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuotaObservation {
    pub windows: BTreeMap<String, QuotaWindow>,
    pub standard: BTreeMap<String, StandardWindow>,
    pub representative_claim: Option<String>,
    pub observed_at_ms: f64,
}
impl QuotaObservation {
    pub fn empty(now: i64) -> Self {
        Self {
            windows: BTreeMap::new(),
            standard: BTreeMap::new(),
            representative_claim: None,
            observed_at_ms: now as f64,
        }
    }
    pub fn is_empty(&self) -> bool {
        self.windows.is_empty() && self.standard.is_empty() && self.representative_claim.is_none()
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuotaError {
    pub kind: String,
    pub status: Option<f64>,
    pub message: Option<JsString16>,
    pub at_ms: f64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PoolProof {
    pub kind: String,
    pub model_id: Option<ModelId>,
    pub observed_at_ms: f64,
    pub expires_at_ms: f64,
    pub evidence_generation: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuotaState {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default, with = "proof_map")]
    pub pool_proofs: Option<BTreeMap<JsString16, PoolProof>>,
    pub windows: BTreeMap<String, QuotaWindow>,
    pub standard: BTreeMap<String, StandardWindow>,
    pub representative_claim: Option<String>,
    pub blocked_until_ms: Option<f64>,
    pub block_window: Option<String>,
    pub cooldown_until_ms: Option<f64>,
    pub last_error: Option<QuotaError>,
    pub updated_at_ms: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Exhaustion {
    pub window: String,
    pub reset_at_ms: Option<f64>,
}
pub(crate) struct Outcome<'a> {
    pub model: &'a ModelId,
    pub observed_at_ms: i64,
    pub observation: Option<&'a QuotaObservation>,
    pub exhaustion: Option<&'a Exhaustion>,
    pub auth_invalid: bool,
    pub transient_retry_ms: Option<Option<i64>>,
    pub config_error: Option<QuotaError>,
    pub config_retry_ms: Option<i64>,
    pub served: bool,
}

fn number(value: Option<&Value>) -> Option<f64> {
    value?.as_f64().filter(|n| n.is_finite())
}
fn safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= gateway_core::identity::MAX_SAFE_INTEGER as f64
}
fn optional_nonnegative(value: Option<&Value>) -> Option<Option<f64>> {
    match value {
        None | Some(Value::Null) => Some(None),
        other => number(other).filter(|n| *n >= 0.0).map(Some),
    }
}
fn reset(value: Option<&Value>) -> Option<Option<f64>> {
    match value {
        None | Some(Value::Null) => Some(None),
        other => number(other)
            .filter(|n| *n > 0.0 && safe_integer(*n))
            .map(Some),
    }
}
fn window(value: &Value) -> Option<QuotaWindow> {
    value.as_object()?;
    Some(QuotaWindow {
        status: value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
        utilization: optional_nonnegative(value.get("utilization"))?,
        reset_at_ms: reset(value.get("reset_at_ms"))?,
        observed_at_ms: number(value.get("observed_at_ms"))
            .filter(|n| *n > 0.0)?
            .trunc(),
    })
}
fn standard(value: &Value) -> Option<StandardWindow> {
    value.as_object()?;
    Some(StandardWindow {
        limit: optional_nonnegative(value.get("limit"))?,
        remaining: optional_nonnegative(value.get("remaining"))?,
        reset_at_ms: reset(value.get("reset_at_ms"))?,
        observed_at_ms: number(value.get("observed_at_ms"))
            .filter(|n| *n > 0.0)?
            .trunc(),
    })
}
pub fn sanitize_error(raw: Option<&str>) -> Option<JsString16> {
    JsString16::from(raw?).sanitize_js_whitespace_prefix(240)
}
fn error(value: &Value) -> Option<QuotaError> {
    let kind = js_trim(value.get("kind")?.as_str()?);
    if kind.is_empty() {
        return None;
    }
    Some(QuotaError {
        kind: kind.into(),
        status: number(value.get("status")),
        message: sanitize_error(value.get("message").and_then(Value::as_str)),
        at_ms: number(value.get("at_ms")).filter(|n| *n > 0.0)?.trunc(),
    })
}
fn proof_with_model(value: &Value, model_id: Option<ModelId>) -> Option<PoolProof> {
    let kind = value.get("kind")?.as_str()?;
    let observed = number(value.get("observed_at_ms"))?;
    let expires = number(value.get("expires_at_ms"))?;
    if !safe_integer(observed) || observed <= 0.0 || !safe_integer(expires) || expires <= observed {
        return None;
    }
    if (kind == "auth_invalid" && model_id.is_some())
        || (kind == "quota_exhausted"
            && model_id
                .as_ref()
                .is_none_or(|id| id.as_js_string().as_units().is_empty()))
        || !["auth_invalid", "quota_exhausted"].contains(&kind)
    {
        return None;
    }
    Some(PoolProof {
        kind: kind.into(),
        model_id,
        observed_at_ms: observed,
        expires_at_ms: expires,
        evidence_generation: value.get("evidence_generation")?.as_str()?.into(),
    })
}
fn proof(value: &Value) -> Option<PoolProof> {
    let model = match value.get("model_id")? {
        Value::Null => None,
        Value::String(model) => Some(ModelId::from_scalar(model)),
        _ => return None,
    };
    proof_with_model(value, model)
}
// Ordinary object keys, not serde's Unicode-scalar map-key serializer.
mod proof_map {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Option<BTreeMap<JsString16, PoolProof>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let Some(rows) = value else {
            return serializer.serialize_none();
        };
        source::object_keys(
            rows.iter()
                .map(|(key, value)| {
                    SourceJson::from_serializable(value).map(|value| (key.clone(), value))
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(serde::ser::Error::custom)?,
        )
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<BTreeMap<JsString16, PoolProof>>, D::Error> {
        let value = <SourceJson as Deserialize>::deserialize(deserializer)?;
        if value.as_str() == "null" {
            return Ok(None);
        }
        source::entries(&value)
            .ok_or_else(|| serde::de::Error::custom("quota proofs require an object"))?
            .into_iter()
            .map(|(key, value)| {
                value
                    .deserialize()
                    .map(|value| (key, value))
                    .map_err(serde::de::Error::custom)
            })
            .collect::<Result<_, _>>()
            .map(Some)
    }
}
/// Malformed optional observations are skipped exactly as the source reader does.
pub fn parse_state(value: &Value) -> Option<QuotaState> {
    value.as_object()?;
    Some(QuotaState {
        pool_proofs: value.get("pool_proofs").map(|raw| {
            raw.as_object()
                .into_iter()
                .flatten()
                .filter_map(|(k, v)| proof(v).map(|v| (JsString16::from_utf8(k), v)))
                .collect()
        }),
        windows: WINDOWS
            .into_iter()
            .filter_map(|id| window(&value["windows"][id]).map(|row| (id.into(), row)))
            .collect(),
        standard: STANDARD_FAMILIES
            .into_iter()
            .filter_map(|id| standard(&value["standard"][id]).map(|row| (id.into(), row)))
            .collect(),
        representative_claim: value
            .get("representative_claim")
            .and_then(Value::as_str)
            .map(str::to_owned),
        blocked_until_ms: number(value.get("blocked_until_ms")),
        block_window: value
            .get("block_window")
            .and_then(Value::as_str)
            .filter(|id| WINDOWS.contains(id))
            .map(str::to_owned),
        cooldown_until_ms: number(value.get("cooldown_until_ms")),
        last_error: value.get("last_error").and_then(error),
        updated_at_ms: number(value.get("updated_at_ms"))
            .filter(|n| *n > 0.0)?
            .trunc(),
    })
}
// Fixed quota-schema access. Unrelated source -0 remains a real IEEE number,
// and an operator string never has to pass through a scalar JSON value.
fn profile_member<'a>(value: &'a PortableValue, name: &str) -> Option<&'a PortableValue> {
    match value {
        PortableValue::Object(fields) => fields
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value),
        PortableValue::ObjectUtf16(fields) => fields
            .iter()
            .rev()
            .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
            .map(|(_, value)| value),
        _ => None,
    }
}
fn profile_scalar(value: &PortableValue) -> Value {
    match value {
        PortableValue::Null => Value::Null,
        PortableValue::Boolean(value) => Value::Bool(*value),
        PortableValue::String(value) => Value::String(value.clone()),
        PortableValue::StringUtf16(value) => value
            .try_utf8()
            .map(Value::String)
            .unwrap_or(Value::Bool(false)),
        PortableValue::NumberBits(_) => value
            .number_value()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Bool(false)),
        _ => Value::Bool(false),
    }
}
fn profile_fields(value: &PortableValue, names: &[&str]) -> Value {
    Value::Object(
        names
            .iter()
            .filter_map(|name| {
                profile_member(value, name).map(|value| ((*name).into(), profile_scalar(value)))
            })
            .collect(),
    )
}
fn parse_profile_state(value: &PortableValue) -> Option<QuotaState> {
    let mut root = profile_fields(
        value,
        &[
            "representative_claim",
            "blocked_until_ms",
            "block_window",
            "cooldown_until_ms",
            "updated_at_ms",
        ],
    );
    for (field, ids, columns) in [
        (
            "windows",
            WINDOWS.as_slice(),
            ["status", "utilization", "reset_at_ms", "observed_at_ms"].as_slice(),
        ),
        (
            "standard",
            STANDARD_FAMILIES.as_slice(),
            ["limit", "remaining", "reset_at_ms", "observed_at_ms"].as_slice(),
        ),
    ] {
        let rows = ids
            .iter()
            .filter_map(|id| {
                profile_member(value, field)
                    .and_then(|rows| profile_member(rows, id))
                    .map(|row| ((*id).into(), profile_fields(row, columns)))
            })
            .collect();
        root[field] = Value::Object(rows);
    }
    let error = profile_member(value, "last_error");
    let mut message = None;
    if let Some(error) = error {
        root["last_error"] = profile_fields(error, &["kind", "status", "at_ms"]);
        message = match profile_member(error, "message") {
            Some(PortableValue::StringUtf16(message)) => message.sanitize_js_whitespace_prefix(240),
            Some(PortableValue::String(message)) => sanitize_error(Some(message)),
            _ => None,
        };
    }
    let mut state = parse_state(&root)?;
    state.pool_proofs = profile_member(value, "pool_proofs").map(|proofs| {
        let rows: Vec<(JsString16, &PortableValue)> = match proofs {
            PortableValue::Object(rows) => rows
                .iter()
                .map(|(key, value)| (JsString16::from_utf8(key), value))
                .collect(),
            PortableValue::ObjectUtf16(rows) => rows
                .iter()
                .map(|(key, value)| (key.clone(), value))
                .collect(),
            _ => vec![],
        };
        rows.into_iter()
            .filter_map(|(key, row)| {
                let model = match profile_member(row, "model_id")? {
                    PortableValue::Null => None,
                    PortableValue::String(value) => Some(ModelId::from_scalar(value)),
                    PortableValue::StringUtf16(value) => Some(ModelId::from_source(value.clone())),
                    _ => return None,
                };
                proof_with_model(
                    &profile_fields(
                        row,
                        &[
                            "kind",
                            "observed_at_ms",
                            "expires_at_ms",
                            "evidence_generation",
                        ],
                    ),
                    model,
                )
                .map(|proof| (key, proof))
            })
            .collect()
    });
    if let Some(error) = &mut state.last_error {
        error.message = message;
    }
    Some(state)
}
pub fn parse_record(record: &StoredRecord, now: i64) -> Result<Option<QuotaState>, GatewayError> {
    record.validate_version()?;
    if record.expires_at_ms.is_some_and(|at| at <= now) {
        return Ok(None);
    }
    match record.value_encoding {
        ValueEncoding::Json => Ok(parse_state(record.json_value()?)),
        ValueEncoding::ProfileV2 => Ok(parse_profile_state(&record.profile_v2_value()?)),
        ValueEncoding::ProfileV1 | ValueEncoding::SourceGraphV1 => Err(GatewayError::unavailable(
            "Claude quota requires JSON or explicit ProfileV2.",
            "incompatible_value_encoding",
        )),
    }
}
pub(crate) fn stored_state(
    state: &QuotaState,
    revision: String,
) -> Result<StoredRecord, GatewayError> {
    encode_source_control_record(revision, &SourceJson::from_serializable(state)?, None)
}
/// Source JSON adapter for the same quota schema, not a new authority constructor.
pub fn parse_source_state(value: &SourceJson) -> Option<QuotaState> {
    parse_profile_state(&source_json_tree(value).ok()?)
}

pub fn applicable_proof<'a>(
    state: Option<&'a QuotaState>,
    binding: &AccountBinding,
    model: &ModelId,
    now: i64,
) -> Option<&'a PoolProof> {
    state?.pool_proofs.as_ref()?.values().find(|p| {
        p.evidence_generation == binding.evidence_generation
            && safe_integer(p.observed_at_ms)
            && p.observed_at_ms > 0.0
            && p.observed_at_ms <= now as f64
            && safe_integer(p.expires_at_ms)
            && p.expires_at_ms > p.observed_at_ms
            && p.expires_at_ms > now as f64
            && (p.kind == "auth_invalid"
                || (p.kind == "quota_exhausted" && p.model_id.as_ref() == Some(model)))
    })
}
pub fn blocked(state: Option<&QuotaState>, now: i64) -> bool {
    state
        .and_then(|s| s.blocked_until_ms)
        .is_some_and(|at| at > now as f64)
}
pub fn cooling_down(state: Option<&QuotaState>, now: i64) -> bool {
    state
        .and_then(|s| s.cooldown_until_ms)
        .is_some_and(|at| at > now as f64)
}
pub(crate) fn merge(
    previous: Option<&QuotaState>,
    binding: &AccountBinding,
    input: &Outcome<'_>,
    now: i64,
) -> QuotaState {
    let empty = QuotaObservation::empty(now);
    let observation = input.observation.unwrap_or(&empty);
    let mut next = previous.cloned().unwrap_or(QuotaState {
        pool_proofs: None,
        windows: BTreeMap::new(),
        standard: BTreeMap::new(),
        representative_claim: None,
        blocked_until_ms: None,
        block_window: None,
        cooldown_until_ms: None,
        last_error: None,
        updated_at_ms: now as f64,
    });
    for (id, window) in &observation.windows {
        if next
            .windows
            .get(id)
            .is_none_or(|old| old.observed_at_ms <= window.observed_at_ms)
        {
            next.windows.insert(id.clone(), window.clone());
        }
    }
    for (id, window) in &observation.standard {
        if next
            .standard
            .get(id)
            .is_none_or(|old| old.observed_at_ms <= window.observed_at_ms)
        {
            next.standard.insert(id.clone(), window.clone());
        }
    }
    if observation.representative_claim.is_some() {
        next.representative_claim = observation.representative_claim.clone();
    }
    if next.blocked_until_ms.is_some_and(|at| at <= now as f64) {
        next.blocked_until_ms = None;
        next.block_window = None;
    }
    if let Some(exhaustion) = input.exhaustion {
        let candidate = exhaustion
            .reset_at_ms
            .map_or((now + MIN_BLOCK_MS) as f64, |at| {
                at + RESET_MARGIN_MS as f64
            })
            .max((now + MIN_BLOCK_MS) as f64);
        if next.blocked_until_ms.is_none_or(|at| candidate > at) {
            next.blocked_until_ms = Some(candidate);
            next.block_window = Some(exhaustion.window.clone());
        }
    }
    if let Some(retry) = input.transient_retry_ms {
        next.cooldown_until_ms =
            Some((now + retry.filter(|v| *v > 0).unwrap_or(TRANSIENT_COOLDOWN_MS)) as f64);
    }
    if let Some(error) = &input.config_error {
        next.cooldown_until_ms = Some(
            (now + input
                .config_retry_ms
                .filter(|v| *v > 0)
                .unwrap_or(CONFIG_COOLDOWN_MS)) as f64,
        );
        next.last_error = Some(error.clone());
    } else if input.served {
        next.last_error = None;
    }
    let mut proofs = previous
        .and_then(|s| s.pool_proofs.clone())
        .unwrap_or_default();
    proofs.retain(|_, p| {
        p.expires_at_ms > now as f64
            && !(input.served
                && p.observed_at_ms <= input.observed_at_ms as f64
                && (p.kind == "auth_invalid" || p.model_id.as_ref() == Some(input.model)))
    });
    let expiry = if input.auth_invalid {
        Some((input.observed_at_ms + AUTH_INVALID_PROOF_TTL_MS) as f64)
    } else {
        input
            .exhaustion
            .and_then(|e| e.reset_at_ms)
            .filter(|at| *at > input.observed_at_ms as f64)
            .map(|at| at + RESET_MARGIN_MS as f64)
    };
    if !input.model.as_js_string().as_units().is_empty()
        && let Some(expires) = expiry.filter(|at| *at > now as f64)
    {
        let key = if input.auth_invalid {
            JsString16::from_utf8("credential")
        } else {
            JsString16::from_units(
                "model:"
                    .encode_utf16()
                    .chain(input.model.as_js_string().as_units().iter().copied())
                    .collect(),
            )
        };
        if proofs
            .get(&key)
            .is_none_or(|p| p.observed_at_ms <= input.observed_at_ms as f64)
        {
            proofs.insert(
                key,
                PoolProof {
                    kind: if input.auth_invalid {
                        "auth_invalid"
                    } else {
                        "quota_exhausted"
                    }
                    .into(),
                    model_id: (!input.auth_invalid).then(|| input.model.clone()),
                    observed_at_ms: input.observed_at_ms as f64,
                    expires_at_ms: expires,
                    evidence_generation: binding.evidence_generation.clone(),
                },
            );
        }
    }
    next.pool_proofs = Some(proofs);
    next.updated_at_ms = now as f64;
    next
}
pub(crate) fn clear(previous: Option<&QuotaState>, now: i64) -> QuotaState {
    let mut next = previous.cloned().unwrap_or(QuotaState {
        pool_proofs: None,
        windows: BTreeMap::new(),
        standard: BTreeMap::new(),
        representative_claim: None,
        blocked_until_ms: None,
        block_window: None,
        cooldown_until_ms: None,
        last_error: None,
        updated_at_ms: now as f64,
    });
    next.pool_proofs = Some(BTreeMap::new());
    next.blocked_until_ms = None;
    next.block_window = None;
    next.cooldown_until_ms = None;
    next.last_error = None;
    next.updated_at_ms = now as f64;
    next
}

#[cfg(test)]
mod source_control_tests {
    use super::*;
    #[test]
    fn real_quota_writer_and_reader_retain_model_keys_and_reject_escape_text_identity() {
        let source = SourceJson::parse(r#"{"updated_at_ms":1000,"pool_proofs":{"model:\ud800":{"kind":"quota_exhausted","model_id":"\ud800","observed_at_ms":1000,"expires_at_ms":3000,"evidence_generation":"fixture-generation"}},"last_error":{"kind":"forbidden","message":"credit \udc00","status":403,"at_ms":1000}}"#).unwrap();
        let state = parse_source_state(&source).unwrap();
        let model = ModelId::from_source(JsString16::from_units(vec![0xd800]));
        let (key, proof) = state
            .pool_proofs
            .as_ref()
            .unwrap()
            .first_key_value()
            .unwrap();
        assert_eq!(key.as_units(), &[109, 111, 100, 101, 108, 58, 0xd800]);
        assert_eq!(proof.model_id.as_ref(), Some(&model));
        assert_ne!(
            proof.model_id.as_ref(),
            Some(&ModelId::from_scalar(r"\ud800"))
        );
        let record = stored_state(&state, "writer-fixture-revision".into()).unwrap();
        assert_eq!(record.value_encoding, ValueEncoding::ProfileV2);
        assert_eq!(record.revision, "writer-fixture-revision");
        assert_eq!(record.expires_at_ms, None);
        assert_eq!(parse_record(&record, 1001).unwrap(), Some(state));
        let encoded = gateway_core::source_control::decode_source_control_record(&record).unwrap();
        assert!(encoded.as_str().contains(r"\ud800"));
        assert!(encoded.as_str().contains(r"\udc00"));
        assert!(encoded.deserialize::<Value>().is_err());
        println!(
            "M35_CLAUDE_WRITER_FIXTURE={}",
            serde_json::to_string(&record).unwrap()
        );
        let mut expired = record.clone();
        expired.expires_at_ms = Some(1001);
        assert!(parse_record(&expired, 1001).unwrap().is_none());
    }
    #[test]
    fn scalar_quota_writer_remains_json_and_malformed_optional_proofs_stay_absent() {
        let source = SourceJson::parse(r#"{"updated_at_ms":1000,"pool_proofs":{"bad":{"kind":"quota_exhausted","model_id":null,"observed_at_ms":1000,"expires_at_ms":3000,"evidence_generation":"fixture"},"good":{"kind":"auth_invalid","model_id":null,"observed_at_ms":1000,"expires_at_ms":3000,"evidence_generation":"fixture"}}}"#).unwrap();
        let state = parse_source_state(&source).unwrap();
        assert_eq!(state.pool_proofs.as_ref().unwrap().len(), 1);
        let record = stored_state(&state, "scalar-fixture".into()).unwrap();
        assert_eq!(record.value_encoding, ValueEncoding::Json);
        assert_eq!(parse_record(&record, 1000).unwrap(), Some(state));
    }
}
