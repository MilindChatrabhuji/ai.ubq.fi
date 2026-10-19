use super::{FullPoolFence, FullPoolShadowDecision, invalid};
use gateway_core::{
    GatewayError,
    identity::MAX_SAFE_INTEGER,
    js_string::JsString16,
    source_json::SourceJson,
    state::{RecordKey, StoredRecord},
    value::ValueEncoding,
};
use serde_json::Value;
use std::collections::BTreeSet;

fn field(value: &SourceJson, name: &str) -> Result<SourceJson, GatewayError> {
    value
        .object_entries()?
        .into_iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, value)| value)
        .ok_or_else(invalid)
}
fn safe(value: &SourceJson) -> Result<i64, GatewayError> {
    value
        .deserialize::<f64>()
        .ok()
        .filter(|number| {
            number.is_finite()
                && number.fract() == 0.0
                && (0.0..=MAX_SAFE_INTEGER as f64).contains(number)
        })
        .map(|number| number as i64)
        .ok_or_else(invalid)
}
fn text(value: &SourceJson, max: usize) -> Result<String, GatewayError> {
    let text: JsString16 = value.deserialize().map_err(|_| invalid())?;
    if text.as_units().is_empty() || text.as_units().len() > max {
        return Err(invalid());
    }
    text.try_utf8().map_err(|_| invalid())
}
fn nullable_text(value: &SourceJson) -> Result<Option<String>, GatewayError> {
    if value.as_str() == "null" {
        Ok(None)
    } else {
        text(value, 512).map(Some)
    }
}
fn nullable_time(value: &SourceJson) -> Result<Option<i64>, GatewayError> {
    if value.as_str() == "null" {
        Ok(None)
    } else {
        safe(value).map(Some)
    }
}
impl FullPoolShadowDecision {
    pub fn parse_value(value: &Value) -> Result<Self, GatewayError> {
        Self::parse_source_json(&SourceJson::from_serializable(value)?)
    }
    pub fn parse_source_json(value: &SourceJson) -> Result<Self, GatewayError> {
        if safe(&field(value, "v")?)? != 1 {
            return Err(invalid());
        }
        let created = safe(&field(value, "created_at_ms")?)?;
        let expires = safe(&field(value, "expires_at_ms")?)?;
        if expires < created {
            return Err(invalid());
        }
        let account = nullable_text(&field(value, "selected_account_id_hash")?)?;
        let credit = nullable_text(&field(value, "selected_credit_id_hash")?)?;
        let credit_expiry = nullable_time(&field(value, "selected_credit_expires_at_ms")?)?;
        if account.is_some() != credit.is_some() {
            return Err(invalid());
        }
        let mut slots = BTreeSet::new();
        let mut fences = Vec::new();
        for row in field(value, "fences")?.array_items()? {
            let slot = safe(&field(&row, "slot")?)? as u64;
            if !slots.insert(slot) {
                return Err(invalid());
            }
            fences.push(FullPoolFence {
                slot,
                account_id_hash: text(&field(&row, "account_id_hash")?, 512)?,
                quota_generation: text(&field(&row, "quota_generation")?, 512)?,
                routing_generation: safe(&field(&row, "routing_generation")?)? as u64,
                quota_reset_at_ms: safe(&field(&row, "quota_reset_at_ms")?)?,
            });
        }
        if fences.is_empty() {
            return Err(invalid());
        }
        Ok(Self {
            v: 1,
            episode_hash: text(&field(value, "episode_hash")?, 512)?,
            created_at_ms: created,
            expires_at_ms: expires,
            decision_reason: text(&field(value, "decision_reason")?, 128)?,
            selected_account_id_hash: account,
            selected_credit_id_hash: credit,
            selected_credit_expires_at_ms: credit_expiry,
            fences,
        })
    }
    pub fn validate_record(key: &RecordKey, row: &StoredRecord) -> Result<Self, GatewayError> {
        row.validate_version()?;
        if row.expires_at_ms.is_some() {
            return Err(invalid());
        }
        let decision = match row.value_encoding {
            ValueEncoding::Json => Self::parse_value(row.json_value()?)?,
            ValueEncoding::ProfileV2 => {
                Self::parse_source_json(&SourceJson::from_portable_json(&row.profile_v2_value()?)?)?
            }
            _ => return Err(invalid()),
        };
        if *key != crate::keys::reset_shadow(&decision.episode_hash) {
            return Err(invalid());
        }
        Ok(decision)
    }
}

pub(super) fn episode_hash(settings: &str, fences: &[FullPoolFence]) -> String {
    let rows = fences
        .iter()
        .map(|fence| {
            format!(
                "{}\0{}\0{}\0{}\0{}",
                fence.slot,
                fence.account_id_hash,
                fence.quota_generation,
                fence.routing_generation,
                fence.quota_reset_at_ms
            )
        })
        .collect::<Vec<_>>()
        .join("\u{1}");
    crate::reset::hash(&format!(
        "uos_ai\0codex_reset_shadow_episode\0{settings}\0{rows}"
    ))
}
pub(super) fn credit_hash(credit: &JsString16) -> String {
    // This is exactly TextEncoder's specified hash input. The original ID stays
    // UTF16 in memory/wire; it is never replaced by this temporary byte encoding.
    let mut text = String::from("uos_ai\0codex_reset_credit\0");
    for scalar in char::decode_utf16(credit.as_units().iter().copied()) {
        text.push(scalar.unwrap_or(char::REPLACEMENT_CHARACTER));
    }
    crate::reset::hash(&text)
}
