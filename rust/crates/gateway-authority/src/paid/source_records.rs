//! Data-only complete-row readers for the actual paid writer DTOs. No capability,
//! clock/currentness reconstruction, expiry renewal or storage operation occurs here.
use super::{PaidAttempt, PaidRollup, provider_label, validate_attempt};
use crate::{invalid, keys, text, validate_time};
use gateway_core::{
    GatewayError,
    source_control::decode_source_control_record,
    state::{RecordKey, StoredRecord},
    tuple_key::{DecodedKeyPart, TupleKey},
};

fn metadata(record: &StoredRecord) -> Result<(), GatewayError> {
    record.validate_version()?;
    text(&record.revision)?;
    if let Some(expiry) = record.expires_at_ms {
        validate_time(expiry)?;
    }
    Ok(())
}
/// Validate the exact stored logical row against its physical source key. An
/// expired retained row remains data; this never creates a live reservation.
pub fn decode_paid_attempt_record(
    key: &RecordKey,
    record: &StoredRecord,
) -> Result<PaidAttempt, GatewayError> {
    metadata(record)?;
    let row: PaidAttempt = decode_source_control_record(record)?
        .deserialize()
        .map_err(|_| invalid("Malformed paid attempt record."))?;
    validate_attempt(&row, &row.reservation)?;
    if keys::paid_attempt(&row.reservation.key_id.0, &row.reservation.attempt_id.0) != *key {
        return Err(invalid("Paid attempt key conflicts."));
    }
    Ok(row)
}

pub(super) fn validate_rollup_identity(
    row: &PaidRollup,
    key: &RecordKey,
) -> Result<(), GatewayError> {
    validate_time(row.bucket_start_at_ms)?;
    let parts = TupleKey::from_record_key(key)?.decoded_parts()?;
    let shard = match parts.last() {
        Some(DecodedKeyPart::Number(value))
            if parts.len() == 8 && value.fract() == 0.0 && (0.0..16.0).contains(value) =>
        {
            *value as u8
        }
        _ => return Err(invalid("Paid rollup key is invalid.")),
    };
    if row.v != 1
        || keys::paid_rollup_model(
            row.bucket_start_at_ms,
            &row.model,
            provider_label(row.provider),
            shard,
        ) != *key
    {
        return Err(invalid("Paid rollup identity is invalid."));
    }
    Ok(())
}
/// Decode the complete Json/ProfileV2 row using the same live identity guard.
/// The first stored logical model may differ from a later colliding request.
pub fn decode_paid_rollup_record(
    key: &RecordKey,
    record: &StoredRecord,
) -> Result<PaidRollup, GatewayError> {
    metadata(record)?;
    let row: PaidRollup = decode_source_control_record(record)?
        .deserialize()
        .map_err(|_| invalid("Malformed paid rollup record."))?;
    validate_rollup_identity(&row, key)?;
    Ok(row)
}
