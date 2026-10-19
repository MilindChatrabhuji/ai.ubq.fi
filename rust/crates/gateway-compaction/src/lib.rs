//! Source-compatible Jev compaction. The host owns fixed I/O and request lifecycle.
pub mod types;
pub use types::*;
use gateway_core::{js_string::JsString16, source_json::SourceJson};

fn member(value: &SourceJson, name: &str) -> Option<SourceJson> {
    value.object_entries().ok()?.into_iter().rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, value)| value)
}
fn is_string(value: Option<SourceJson>, expected: &str) -> bool {
    value.and_then(|value| JsString16::from_json_token(value.as_raw()).ok())
        .is_some_and(|value| value.as_units().iter().copied().eq(expected.encode_utf16()))
}
/// Pure exact parsed-header predicate. Existing disable control remains caller-owned.
pub fn is_responses_compaction(header: Option<&str>) -> bool {
    let Some(value) = header.and_then(|value| SourceJson::parse(value).ok()) else { return false };
    is_string(member(&value, "request_kind"), "compaction")
        && member(&value, "compaction").is_some_and(|value| is_string(member(&value, "implementation"), "responses"))
}

/// Provisional signature freeze only; no fabricated summary or success is emitted.
pub async fn build_compaction_response<H: CompactionHost>(
    _body: &SourceJson,
    _host: &H,
    _options: ResponseOptions,
) -> Result<CompactionOutcome, CompactionFailure> {
    Err(CompactionFailure::new(FailureKind::JevFailed, "algorithm implementation pending"))
}
