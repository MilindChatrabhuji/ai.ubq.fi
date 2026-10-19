//! Raw source metadata and effective normalized views are distinct contracts.
//! Owner parse-None/default behavior does not authorize rewriting captured data.
use crate::*;
use gateway_core::{source_control::decode_source_control_record, value::ValueEncoding};

pub(crate) fn named_key(parts: &[Value]) -> bool {
    (parts.len() == 2
        && (starts(parts, &["ubq_ai", "codex_models"])
            || starts(parts, &["uos_ai", "codex_models_whitelist"])))
        || (parts.len() == 3
            && (starts(parts, &["uos_ai", "codex_account_models", "v1"])
                || starts(parts, &["uos_ai", "runtime_config", "v2"])))
}
pub(crate) fn retain_raw(row: &Row) -> Result<bool, GatewayError> {
    if !named_key(&row.parts)
        || !matches!(
            row.record.value_encoding,
            ValueEncoding::Json | ValueEncoding::ProfileV2
        )
    {
        return Ok(false);
    }
    // No owner normalizer is called here: account/whitelist/runtime/snapshot
    // invalid-or-missing views retain their original raw source data. Explicit
    // model-snapshot migration audit failures ran before this projection.
    decode_source_control_record(&row.record)?;
    Ok(true)
}
