//! Source replay-model/read/observation schemas. Export manifests have a frozen eleven-field shape.
use crate::{
    replay_crypto::{CHUNK_BYTES, MAX_CIPHERTEXT_BYTES},
    replay_values::SourceObject,
    store,
};
use base64::{
    Engine, alphabet,
    engine::{
        DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::URL_SAFE_NO_PAD,
    },
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_json::SourceJson,
    state::RecordKey,
    tuple_key::{KeyPart, TupleKey},
};
use serde::{Deserialize, Deserializer, Serialize};

pub const PAYLOAD_TTL: i64 = 48 * 60 * 60 * 1000;
pub const STATUS_TTL: i64 = 2 * PAYLOAD_TTL;
pub const STATUS_FIELDS: &[&str] = &[
    "version",
    "request_id",
    "status",
    "reason",
    "captured_at_ms",
    "manifest_key",
    "fingerprint",
    "expires_at_ms",
];
pub fn counter(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)
}
pub fn safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}
pub fn digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn request_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
pub fn reason(s: &str) -> bool {
    request_id(s)
}
pub fn capture_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub fn cursor_shape(s: &str) -> bool {
    let text = s.trim_end_matches('=');
    !text.is_empty()
        && s.len() <= 2048
        && s.len() - text.len() <= 2
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
pub(crate) fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
pub(crate) fn optional_nonnull<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
pub(crate) fn url_decode(s: &str) -> Result<Vec<u8>, GatewayError> {
    GeneralPurpose::new(
        &alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(s)
    .map_err(|_| store::error("Invalid replay base64url"))
}
pub fn key(kind: &str) -> RecordKey {
    store::key(serde_json::json!(["uos_ai", "sentinel_replay", "v1", kind]))
}
pub fn request_key(id: &str) -> RecordKey {
    store::key(serde_json::json!([
        "uos_ai",
        "sentinel_replay",
        "v1",
        "request",
        id
    ]))
}
pub fn tombstone_key(fingerprint: &str) -> RecordKey {
    store::key(serde_json::json!([
        "uos_ai",
        "sentinel_replay",
        "v1",
        "evicted",
        fingerprint
    ]))
}
pub fn chunk_key(id: &str, index: usize) -> RecordKey {
    store::key(serde_json::json!([
        "uos_ai",
        "sentinel_replay",
        "v1",
        "chunk",
        id,
        index
    ]))
}
pub fn manifest_key(at: f64, fingerprint: &str, id: &str) -> Result<RecordKey, GatewayError> {
    TupleKey::from_parts(&[
        KeyPart::String("uos_ai".into()),
        KeyPart::String("sentinel_replay".into()),
        KeyPart::String("v1".into()),
        KeyPart::String("manifest".into()),
        KeyPart::Number(at),
        KeyPart::String(fingerprint.into()),
        KeyPart::String(id.into()),
    ])
    .map(|k| k.to_record_key())
}
pub(crate) fn tuple_from_source(parts: &[SourceJson]) -> Result<RecordKey, GatewayError> {
    let mut key = Vec::new();
    for value in parts {
        let text = value.as_str();
        if text.starts_with('"') {
            key.push(KeyPart::source_string_utf16(
                value.deserialize::<JsString16>()?.as_units(),
            ))
        } else if let Ok(value) = value.deserialize::<bool>() {
            key.push(KeyPart::Boolean(value))
        } else {
            let value = value.deserialize::<f64>()?;
            key.push(KeyPart::Number(value))
        }
    }
    TupleKey::from_parts(&key).map(|k| k.to_record_key())
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Manifest {
    pub version: f64,
    pub capture_id: String,
    pub fingerprint: String,
    pub case_group_digest: String,
    pub captured_at_ms: f64,
    pub expires_at_ms: f64,
    pub algorithm: String,
    pub compression: String,
    pub iv: String,
    pub chunk_count: f64,
    pub ciphertext_bytes: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_nonnull"
    )]
    pub stored_bytes: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_nonnull"
    )]
    pub request_id: Option<String>,
}
impl Manifest {
    pub fn validate(&self) -> bool {
        let max_chunks = MAX_CIPHERTEXT_BYTES.div_ceil(CHUNK_BYTES) as f64;
        self.version == 1.0
            && capture_id(&self.capture_id)
            && digest(&self.fingerprint)
            && digest(&self.case_group_digest)
            && counter(self.captured_at_ms)
            && counter(self.expires_at_ms)
            && self.expires_at_ms == self.captured_at_ms + PAYLOAD_TTL as f64
            && self.algorithm == "AES-256-GCM"
            && self.compression == "gzip"
            && (16..=24).contains(&self.iv.len())
            && self
                .iv
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            && url_decode(&self.iv).is_ok_and(|v| v.len() == 12)
            && counter(self.chunk_count)
            && self.chunk_count >= 1.0
            && self.chunk_count <= max_chunks
            && counter(self.ciphertext_bytes)
            && self.ciphertext_bytes >= 16.0
            && self.ciphertext_bytes <= MAX_CIPHERTEXT_BYTES as f64
            && self.ciphertext_bytes >= (self.chunk_count - 1.0) * CHUNK_BYTES as f64 + 1.0
            && self.ciphertext_bytes <= self.chunk_count * CHUNK_BYTES as f64
            && self.stored_bytes.is_none_or(|v| counter(v) && v > 0.0)
            && self.request_id.as_ref().is_none_or(|v| request_id(v))
    }
    pub fn from_source(value: &SourceJson) -> Result<Self, GatewayError> {
        let value: Self = value.deserialize()?;
        if value.validate() {
            Ok(value)
        } else {
            Err(store::error("Invalid replay manifest"))
        }
    }
    pub fn matches_key(&self, key: &RecordKey) -> Result<bool, GatewayError> {
        let p = store::parts(key)?;
        Ok(p.len() == 7
            && p[..4]
                == serde_json::json!(["uos_ai", "sentinel_replay", "v1", "manifest"])
                    .as_array()
                    .expect("source prefix")[..]
            && p[4].as_f64() == Some(self.captured_at_ms)
            && p[5].as_str() == Some(self.fingerprint.as_str())
            && p[6].as_str() == Some(self.capture_id.as_str()))
    }
    pub fn wire(&self) -> Result<SourceJson, GatewayError> {
        SourceObject::parse(&SourceJson::from_serializable(self)?)?.select(&[
            "version",
            "capture_id",
            "fingerprint",
            "case_group_digest",
            "captured_at_ms",
            "expires_at_ms",
            "algorithm",
            "compression",
            "iv",
            "chunk_count",
            "ciphertext_bytes",
        ])
    }
    pub fn expected_chunk_bytes(&self, index: usize) -> usize {
        if index + 1 < self.chunk_count as usize {
            CHUNK_BYTES
        } else {
            self.ciphertext_bytes as usize - (self.chunk_count as usize - 1) * CHUNK_BYTES
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Ready,
    Incomplete,
    Disabled,
    Failed,
    Evicted,
    Expired,
    Unknown,
    StatusNotRetained,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Status {
    pub version: f64,
    pub request_id: String,
    pub status: CaptureState,
    #[serde(deserialize_with = "nullable")]
    pub reason: Option<String>,
    pub captured_at_ms: f64,
    #[serde(deserialize_with = "nullable")]
    pub manifest_key: Option<Vec<SourceJson>>,
    #[serde(deserialize_with = "nullable")]
    pub fingerprint: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub expires_at_ms: Option<f64>,
}
impl Status {
    pub fn valid_stored(&self) -> bool {
        let common = self.version == 1.0
            && request_id(&self.request_id)
            && !matches!(
                self.status,
                CaptureState::Unknown | CaptureState::StatusNotRetained
            )
            && self.reason.as_deref().is_none_or(reason)
            && counter(self.captured_at_ms)
            && self.manifest_key.as_ref().is_none_or(|v| v.len() == 7)
            && self.fingerprint.as_deref().is_none_or(digest)
            && self.expires_at_ms.is_none_or(safe_integer);
        common
            && if matches!(self.status, CaptureState::Ready | CaptureState::Incomplete) {
                self.manifest_key.is_some()
                    && self.fingerprint.is_some()
                    && self.expires_at_ms.is_some()
            } else {
                self.manifest_key.is_none() && self.expires_at_ms.is_none()
            }
    }
}
#[derive(Clone)]
pub(crate) struct StatusDocument {
    pub(crate) data: Status,
    original: SourceObject,
}
impl StatusDocument {
    pub(crate) fn parse(value: &SourceJson) -> Result<Self, GatewayError> {
        let original = SourceObject::parse(value)?;
        let data: Status = original.select(STATUS_FIELDS)?.deserialize()?;
        if !data.valid_stored() {
            return Err(store::error("Invalid replay capture status"));
        }
        Ok(Self { data, original })
    }
    pub(crate) fn new(data: Status) -> Result<Self, GatewayError> {
        let original = SourceObject::parse(&SourceJson::from_serializable(&data)?)?;
        Ok(Self { data, original })
    }
    pub(crate) fn source_json(&self) -> Result<SourceJson, GatewayError> {
        let mut out = self.original.clone();
        for (key, value) in SourceObject::parse(&SourceJson::from_serializable(&self.data)?)?
            .source_json()?
            .object_entries()?
        {
            out.set(&key.try_utf8()?, &value)?;
        }
        out.source_json()
    }
}
/// Public base64url contains the unchanged core query payload, not its internal hexadecimal wrapper.
pub(crate) fn wire_cursor(core: &str) -> Result<String, GatewayError> {
    let bytes = core
        .strip_prefix("query-v1:")
        .ok_or_else(|| store::error("Unsupported replay query cursor version"))?;
    if !bytes.len().is_multiple_of(2) {
        return Err(store::error("Invalid replay query cursor"));
    }
    let decoded = bytes
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let hex =
                std::str::from_utf8(pair).map_err(|_| store::error("Invalid query cursor"))?;
            u8::from_str_radix(hex, 16).map_err(|_| store::error("Invalid query cursor"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let token = URL_SAFE_NO_PAD.encode(decoded);
    if !cursor_shape(&token) {
        return Err(store::error("Replay query cursor exceeds its source bound"));
    }
    Ok(token)
}
pub(crate) fn core_cursor(wire: &str) -> Result<String, GatewayError> {
    if !cursor_shape(wire) {
        return Err(store::invalid("Invalid replay export cursor"));
    }
    let bytes = url_decode(wire)?;
    let mut core = String::from("query-v1:");
    use std::fmt::Write;
    for byte in bytes {
        write!(core, "{byte:02x}").expect("String formatting cannot fail");
    }
    Ok(core)
}
