use crate::*;
use gateway_admin_data::profile::{SourceDateHost, normalize_source_import_line_with_host};
use std::collections::BTreeSet;

/// Private logical capture, distinct from ordinary NDJSON which omits KV expiry.
/// Producing it from a real database requires the separately verified stopped-source owner.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PrivateCapture {
    pub v: u32,
    pub source_git_sha: String,
    pub captured_at_ms: i64,
    pub entries: Vec<SourceEntry>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceEntry {
    pub key: Vec<SourceJson>,
    pub value: SourceJson,
    pub versionstamp: String,
    /// Explicit absolute source expiry; never reconstructed as now + TTL.
    #[serde(deserialize_with = "required_expiry")]
    pub expires_at_ms: Option<i64>,
}
fn required_expiry<'de, D: serde::Deserializer<'de>>(input: D) -> Result<Option<i64>, D::Error> {
    Option::<i64>::deserialize(input)
}
impl std::fmt::Debug for PrivateCapture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrivateCapture")
            .field("entries", &self.entries.len())
            .field("values", &"[private]")
            .finish()
    }
}
impl PrivateCapture {
    pub(crate) fn validate(&self, host: &dyn SourceDateHost) -> Result<Vec<Row>, GatewayError> {
        if self.v != 1
            || self.source_git_sha.len() != 40
            || !self
                .source_git_sha
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&self.captured_at_ms)
        {
            return Err(invalid("Capture identity/version/clock is invalid"));
        }
        let mut keys = BTreeSet::new();
        self.entries
            .iter()
            .map(|entry| {
                if entry.versionstamp.is_empty()
                    || entry.expires_at_ms.is_some_and(|n| {
                        !(0..=gateway_core::identity::MAX_SAFE_INTEGER).contains(&n)
                    })
                {
                    return Err(invalid("Source revision or absolute expiry is invalid"));
                }
                let text = serde_json::to_string(entry)
                    .map_err(|_| invalid("Source profile row cannot be encoded"))?;
                let decoded = normalize_source_import_line_with_host(&text, host)?
                    .ok_or_else(|| invalid("Empty source row"))?;
                if !keys.insert(decoded.key.0.clone()) {
                    return Err(invalid("Duplicate logical source key"));
                }
                if starts(&decoded.parts, &["uos_ai", "migration"])
                    || starts(&decoded.parts, &["uos_ai", "authority"])
                {
                    return Err(invalid(
                        "Source capture cannot mint Rust authority or adoption metadata",
                    ));
                }
                let record = if let Some(value) = decoded.value.to_json_lossless() {
                    StoredRecord::json(&entry.versionstamp, value, entry.expires_at_ms)
                } else if decoded.value.validate_for_storage().is_ok() {
                    StoredRecord::profile(&entry.versionstamp, decoded.value, entry.expires_at_ms)?
                } else {
                    StoredRecord::profile_v2(&entry.versionstamp, decoded.value, entry.expires_at_ms)?
                };
                Ok(Row {
                    key: decoded.key,
                    parts: decoded.parts,
                    record,
                    mapping: Mapping {
                        source: entry.clone(),
                        transform: Transform::Identity,
                        baseline_digest: String::new(),
                    },
                })
            })
            .collect()
    }
}
