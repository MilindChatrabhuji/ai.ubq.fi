//! Safe actor response DATA; all strings retain their source domains.
use super::{invalid, nullable};
use crate::GatewayError;
use gateway_core::js_string::JsString16;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCompletionModelsData {
    pub count: u64,
    pub source: JsString16,
    pub updated_at_ms: i64,
    #[serde(deserialize_with = "nullable")]
    pub client_version: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportCompletionData {
    pub account_count: u64,
    pub account_ids: Vec<String>,
    pub updated_at_ms: f64,
    pub models: ImportCompletionModelsData,
}
impl ImportCompletionData {
    pub fn validate(&self) -> Result<(), GatewayError> {
        // The existing source-pool parser enforces one or two distinct accounts.
        if !(1..=2).contains(&self.account_count)
            || self.account_count != self.account_ids.len() as u64
            || self.account_ids.iter().any(|id| id.trim().is_empty())
            || self.account_ids.len() == 2 && self.account_ids[0] == self.account_ids[1]
            || !self.updated_at_ms.is_finite()
        {
            return Err(invalid());
        }
        Ok(())
    }
}
/// Existing Worker storage.rs:20,190-214 bounds each persisted row, including
/// JSON or ProfileV2 encoding. At most six JSON bytes represent a single source
/// byte/unit; both rows are checked by the real completion projection helper.
pub(super) fn completion_envelope_max_bytes() -> usize {
    const CANONICAL_STORED_ROW_BYTES: usize = 2_000_000;
    const JSON_ESCAPE_EXPANSION: usize = 6;
    let fixed = ImportCompletionData {
        account_count: 2,
        account_ids: vec![String::new(), String::new()],
        updated_at_ms: 0.0,
        models: ImportCompletionModelsData {
            count: u64::MAX,
            source: JsString16::from_utf8(""),
            updated_at_ms: i64::MIN,
            client_version: None,
        },
    };
    // Value text/numbers are charged to the row budgets; this fixed frame also
    // covers missing/default scalar values and both count/nullable encodings.
    serde_json::to_vec(&fixed)
        .expect("Finite completion frame")
        .len()
        + 2 * CANONICAL_STORED_ROW_BYTES * JSON_ESCAPE_EXPANSION
}
