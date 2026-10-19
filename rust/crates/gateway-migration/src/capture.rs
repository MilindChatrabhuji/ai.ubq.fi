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
                let source_parts = parts(&decoded.key)?;
                validate_complete_binary_views(&entry.value)?;
                if !keys.insert(decoded.key.0.clone()) {
                    return Err(invalid("Duplicate logical source key"));
                }
                if private_source_key(&source_parts) {
                    return Err(invalid(
                        "Source capture cannot mint Rust authority or adoption metadata",
                    ));
                }
                let record = if let Some(value) = decoded.value.to_json_lossless() {
                    StoredRecord::json(&entry.versionstamp, value, entry.expires_at_ms)
                } else if !crate::projection::quota_family(&source_parts)
                    && decoded.value.validate_for_storage().is_ok()
                {
                    StoredRecord::profile(&entry.versionstamp, decoded.value, entry.expires_at_ms)?
                } else {
                    StoredRecord::profile_v2(
                        &entry.versionstamp,
                        decoded.value,
                        entry.expires_at_ms,
                    )?
                };
                Ok(Row {
                    key: decoded.key,
                    parts: source_parts,
                    record,
                    mapping: Mapping {
                        source: entry.clone(),
                        transform: Transform::Identity,
                        baseline_digest: String::new(),
                        native_origin: None,
                    },
                })
            })
            .collect()
    }
}

fn validate_complete_binary_views(input: &SourceJson) -> Result<(), GatewayError> {
    let fields = input.object_entries()?;
    let get = |name: &str| {
        fields
            .iter()
            .rev()
            .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
            .map(|(_, value)| value)
    };
    let kind = get("type")
        .ok_or_else(|| invalid("Capture profile type is missing"))?
        .deserialize::<String>()?;
    let empty = SourceJson::parse("null")?;
    let value = get("value").unwrap_or(&empty);
    match kind.as_str() {
        "ArrayBuffer" | "DataView" | "Int8Array" | "Uint8Array" | "Uint8ClampedArray"
        | "Int16Array" | "Uint16Array" | "Int32Array" | "Uint32Array" | "Float32Array"
        | "Float64Array" | "BigInt64Array" | "BigUint64Array" => {
            let length = get("byteLength")
                .ok_or_else(|| invalid("Full capture binary view requires explicit byteLength"))?
                .deserialize::<f64>()?;
            let gateway_core::value::PortableValue::Binary { bytes, .. } =
                gateway_admin_data::profile::from_source_profile(input)?
            else {
                return Err(invalid("Capture binary value is malformed"));
            };
            if length != bytes.len() as f64 {
                return Err(invalid(
                    "Source profile omitted a partial binary view's offset; full capture cannot preserve it",
                ));
            }
        }
        "Array" | "Set" => {
            for child in value.array_items()? {
                validate_complete_binary_views(&child)?;
            }
        }
        "Map" => {
            for pair in value.array_items()? {
                for child in pair.array_items()?.iter().take(2) {
                    validate_complete_binary_views(child)?;
                }
            }
        }
        "object" if value.as_str().trim().starts_with('{') => {
            let fields: std::collections::BTreeMap<_, _> =
                value.object_entries()?.into_iter().collect();
            for child in fields.values() {
                validate_complete_binary_views(child)?;
            }
        }
        "object" if value.as_str().trim().starts_with('[') => {
            for child in value.array_items()? {
                validate_complete_binary_views(&child)?;
            }
        }
        _ => {}
    }
    Ok(())
}
