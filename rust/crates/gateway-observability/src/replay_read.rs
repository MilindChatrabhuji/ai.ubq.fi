//! Source replay-read.ts. Reads preserve expiry/status truth and export only frozen manifest fields.
use crate::replay_model::{self as model, CaptureState, Manifest, Status, StatusDocument};
use crate::replay_values::{SourceObject, read_json_record};
use crate::store;
use crate::{ObservabilityRuntime, types::ObservabilityHost};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use gateway_auth::AuthResponse;
use gateway_core::{
    GatewayError,
    query::{QueryRequest, QuerySelector, QueryStore},
    source_json::SourceJson,
    state::{RecordKey, RecordMutation, StoredRecord},
    value::{PortableValue, ValueEncoding},
};
use serde::Serialize;
const MANIFEST_FIELDS: &[&str] = &[
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
    "stored_bytes",
    "request_id",
];
const INVALID_EXPORT: &str = "after_ms and before_ms must define a valid interval, limit must be one, cursor must be valid, and at most one of incident_id or request_id may be selected";
fn invalid() -> GatewayError {
    store::invalid(INVALID_EXPORT)
}
fn failed() -> GatewayError {
    GatewayError::unavailable(
        "Sentinel replay export failed",
        "sentinel_replay_export_failed",
    )
}
fn manifest_from_row(row: &StoredRecord) -> Result<Option<Manifest>, GatewayError> {
    let value = row.portable_value()?;
    let entries = match value {
        PortableValue::Object(entries) => entries
            .into_iter()
            .filter(|(key, _)| MANIFEST_FIELDS.contains(&key.as_str()))
            .map(|(key, value)| (gateway_core::js_string::JsString16::from_utf8(&key), value))
            .collect(),
        PortableValue::ObjectUtf16(entries) => entries
            .into_iter()
            .filter(|(key, _)| {
                MANIFEST_FIELDS
                    .iter()
                    .any(|name| key.as_units().iter().copied().eq(name.encode_utf16()))
            })
            .collect(),
        _ => return Ok(None),
    };
    Ok(PortableValue::ObjectUtf16(entries)
        .to_source_json()
        .ok()
        .and_then(|v| Manifest::from_source(&v).ok()))
}
fn valid_ledger(value: &SourceJson) -> bool {
    let Ok(row) = SourceObject::parse(value) else {
        return false;
    };
    if row.get("version").and_then(|v| v.deserialize::<f64>().ok()) != Some(1.0) {
        return false;
    }
    for field in [
        "budget_bytes",
        "stored_bytes",
        "reserved_bytes",
        "records",
        "status_records",
        "metadata_bytes",
        "evicted_bytes",
        "evicted_records",
        "expired_bytes",
        "expired_records",
        "status_pruned_records",
    ] {
        if !row
            .get(field)
            .and_then(|v| v.deserialize::<f64>().ok())
            .is_some_and(model::counter)
        {
            return false;
        }
    }
    for field in ["bootstrap_complete", "over_budget"] {
        if !row
            .get(field)
            .is_some_and(|v| v.deserialize::<bool>().is_ok())
        {
            return false;
        }
    }
    for field in [
        "last_eviction_at_ms",
        "last_warning_at_ms",
        "last_full_at_ms",
    ] {
        if !row.get(field).is_some_and(|v| {
            v.deserialize::<Option<f64>>()
                .is_ok_and(|n| n.is_none_or(model::counter))
        }) {
            return false;
        }
    }
    for field in ["last_skip_reason", "bootstrap_cursor", "accounting_error"] {
        if !row.get(field).is_some_and(|v| {
            v.deserialize::<Option<gateway_core::js_string::JsString16>>()
                .is_ok()
        }) {
            return false;
        }
    }
    row.get("bootstrap_sweep").is_none_or(|v| {
        v.deserialize::<Option<gateway_core::js_string::JsString16>>()
            .is_ok()
    })
}
#[derive(Serialize)]
pub struct ExportedCapture {
    pub manifest: SourceJson,
    pub chunks: Vec<String>,
}
#[derive(Serialize)]
struct CapturePage {
    data: Vec<ExportedCapture>,
    cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    capture_status: Option<SourceJson>,
}
fn response(
    data: Vec<ExportedCapture>,
    cursor: Option<String>,
    status: Option<SourceJson>,
) -> Result<AuthResponse, GatewayError> {
    Ok(AuthResponse::source_json(
        200,
        SourceJson::from_serializable(&CapturePage {
            data,
            cursor,
            capture_status: status,
        })?,
    ))
}
pub fn valid_incident_id(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("provider-") else {
        return false;
    };
    let bytes = uuid.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
        && bytes[14] == b'4'
        && b"89ab".contains(&bytes[19])
}
impl<S: QueryStore, H: ObservabilityHost> ObservabilityRuntime<S, H> {
    pub(crate) async fn replay_row(
        &self,
        key: &RecordKey,
    ) -> Result<Option<StoredRecord>, GatewayError> {
        let row = self.store.read(key).await?;
        let at = store::now(self.host.as_ref())?;
        Ok(row.filter(|r| r.expires_at_ms.is_none_or(|t| t > at)))
    }
    pub(crate) async fn export_manifest(
        &self,
        manifest: &Manifest,
    ) -> Result<ExportedCapture, GatewayError> {
        let mut chunks = Vec::new();
        for index in 0..manifest.chunk_count as usize {
            let row = self
                .replay_row(&model::chunk_key(&manifest.capture_id, index))
                .await?
                .ok_or_else(failed)?;
            if !matches!(
                row.value_encoding,
                ValueEncoding::ProfileV1 | ValueEncoding::ProfileV2
            ) {
                return Err(failed());
            }
            let PortableValue::Binary {
                kind,
                bytes,
                byte_offset,
                byte_length,
            } = row.portable_value()?
            else {
                return Err(failed());
            };
            if kind != "Uint8Array" || byte_length as usize != manifest.expected_chunk_bytes(index)
            {
                return Err(failed());
            }
            let start = byte_offset as usize;
            let end = start.checked_add(byte_length as usize).ok_or_else(failed)?;
            let bytes = bytes.get(start..end).ok_or_else(failed)?;
            chunks.push(URL_SAFE_NO_PAD.encode(bytes));
        }
        Ok(ExportedCapture {
            manifest: manifest.wire()?,
            chunks,
        })
    }
    async fn capture_status(&self, id: &str, at: i64) -> Result<StatusDocument, GatewayError> {
        if let Some(row) = self.replay_row(&model::request_key(id)).await? {
            let mut status = StatusDocument::parse(&read_json_record(&row)?)?;
            if status.data.expires_at_ms.is_some_and(|t| t <= at as f64) {
                status.data.status = CaptureState::Expired
            }
            return Ok(status);
        }
        let pruned: Result<bool, GatewayError> = async {
            let Some(row) = self.replay_row(&model::key("budget")).await? else {
                return Ok(false);
            };
            let value = read_json_record(&row)?;
            if !valid_ledger(&value) {
                return Ok(false);
            }
            Ok(SourceObject::parse(&value)?
                .get("status_pruned_records")
                .and_then(|v| v.deserialize::<f64>().ok())
                .is_some_and(|n| n > 0.0))
        }
        .await;
        let pruned = pruned.unwrap_or(false);
        StatusDocument::new(Status {
            version: 1.0,
            request_id: id.into(),
            status: if pruned {
                CaptureState::StatusNotRetained
            } else {
                CaptureState::Unknown
            },
            reason: Some(
                if pruned {
                    "status_not_retained"
                } else {
                    "no_capture_record"
                }
                .into(),
            ),
            captured_at_ms: at as f64,
            manifest_key: None,
            fingerprint: None,
            expires_at_ms: None,
        })
    }
    pub async fn export_capture_request(&self, id: &str) -> Result<AuthResponse, GatewayError> {
        if !model::request_id(id) {
            return Err(invalid());
        }
        let at = store::now(self.host.as_ref())?;
        let result = async {
            let mut status = self.capture_status(id, at).await?;
            let Some(parts) = status.data.manifest_key.as_ref() else {
                return response(Vec::new(), None, Some(status.source_json()?));
            };
            let Some(fingerprint) = status.data.fingerprint.as_ref() else {
                return response(Vec::new(), None, Some(status.source_json()?));
            };
            let key = model::tuple_from_source(parts)?;
            let row = self.replay_row(&key).await?;
            let manifest = match row.as_ref() {
                Some(row) => manifest_from_row(row)?,
                None => None,
            };
            if let Some(manifest) = manifest.filter(|m| m.fingerprint == *fingerprint)
                && manifest.matches_key(&key)?
            {
                let capture = self.export_manifest(&manifest).await?;
                return response(vec![capture], None, Some(status.source_json()?));
            }
            let tombstone = self.replay_row(&model::tombstone_key(fingerprint)).await?;
            let reason = tombstone
                .as_ref()
                .map(read_json_record)
                .transpose()?
                .and_then(|v| SourceObject::parse(&v).ok())
                .and_then(|v| v.get("reason").and_then(|v| v.deserialize::<String>().ok()));
            status.data.status = if reason.as_deref() == Some("storage_budget") {
                CaptureState::Evicted
            } else {
                CaptureState::Expired
            };
            status.data.reason = Some(
                match reason.as_deref() {
                    Some("storage_budget") => "storage_budget",
                    Some("payload_expired") => "payload_expired",
                    _ => "manifest_unavailable",
                }
                .into(),
            );
            response(Vec::new(), None, Some(status.source_json()?))
        }
        .await;
        result.map_err(|_| failed())
    }
    pub async fn export_capture_interval(
        &self,
        after: i64,
        before: i64,
        cursor: Option<&str>,
    ) -> Result<AuthResponse, GatewayError> {
        let cursor = cursor.filter(|s| !s.is_empty());
        if after < 0 || before < after || cursor.is_some_and(|s| !model::cursor_shape(s)) {
            return Err(invalid());
        }
        if before >= gateway_core::identity::MAX_SAFE_INTEGER {
            return Err(failed());
        }
        let result = async {
            let prefix = model::key("manifest");
            let start = store::key(serde_json::json!([
                "uos_ai",
                "sentinel_replay",
                "v1",
                "manifest",
                after
            ]));
            let query = QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix,
                    start: Some(start),
                    end: None,
                },
                reverse: false,
                limit: 1,
                cursor: cursor.map(model::core_cursor).transpose()?,
                now_ms: store::now(self.host.as_ref())?,
            };
            let validated = query.validate()?;
            let page = self.store.query(query).await?;
            let Some(entry) = page.entries.first() else {
                return response(Vec::new(), None, None);
            };
            let manifest = manifest_from_row(&entry.record)?.ok_or_else(failed)?;
            if !manifest.matches_key(&entry.key)? || manifest.captured_at_ms < after as f64 {
                return Err(failed());
            }
            if manifest.captured_at_ms > before as f64 {
                return response(Vec::new(), None, None);
            }
            let cursor = model::wire_cursor(&validated.cursor_after(&entry.key)?)?;
            response(
                vec![self.export_manifest(&manifest).await?],
                Some(cursor),
                None,
            )
        }
        .await;
        result.map_err(|_| failed())
    }
    pub async fn export_incident_captures(
        &self,
        id: &str,
        cursor: Option<&str>,
    ) -> Result<AuthResponse, GatewayError> {
        let cursor = cursor.filter(|s| !s.is_empty());
        if !valid_incident_id(id) || cursor.is_some_and(|c| !model::cursor_shape(c)) {
            return Err(invalid());
        }
        let result = async {
            let mut cursor = cursor.map(model::core_cursor).transpose()?;
            loop {
                let query = QueryRequest {
                    selector: QuerySelector::Prefix {
                        prefix: store::key(serde_json::json!([
                            "uos_ai",
                            "sentinel_incident",
                            "v1",
                            "capture_ref",
                            id
                        ])),
                        start: None,
                        end: None,
                    },
                    reverse: false,
                    limit: 1,
                    cursor: cursor.clone(),
                    now_ms: store::now(self.host.as_ref())?,
                };
                let validated = query.validate()?;
                let page = self.store.query(query).await?;
                let Some(reference) = page.entries.first() else {
                    return response(Vec::new(), None, None);
                };
                let next = validated.cursor_after(&reference.key)?;
                let parts = store::parts(&reference.key)?;
                let fingerprint = parts
                    .last()
                    .and_then(serde_json::Value::as_str)
                    .filter(|s| model::digest(s))
                    .ok_or_else(failed)?;
                if parts.len() != 6 {
                    return Err(failed());
                }
                let row = SourceObject::parse(&read_json_record(&reference.record)?)?;
                if row.get("version").and_then(|v| v.deserialize::<f64>().ok()) != Some(1.0) {
                    return Err(failed());
                }
                let manifest_parts = row.get("manifest_key").ok_or_else(failed)?.array_items()?;
                if manifest_parts.len() != 7 {
                    return Err(failed());
                }
                let key = model::tuple_from_source(&manifest_parts)?;
                let Some(row) = self.replay_row(&key).await? else {
                    let _ = store::commit(
                        self.store.as_ref(),
                        vec![store::check(&reference.key, Some(&reference.record))],
                        vec![RecordMutation::Delete {
                            key: reference.key.clone(),
                        }],
                    )
                    .await;
                    cursor = Some(next);
                    continue;
                };
                let manifest = manifest_from_row(&row)?.ok_or_else(failed)?;
                if manifest.fingerprint != fingerprint || !manifest.matches_key(&key)? {
                    return Err(failed());
                }
                return response(
                    vec![self.export_manifest(&manifest).await?],
                    Some(model::wire_cursor(&next)?),
                    None,
                );
            }
        }
        .await;
        result.map_err(|_| failed())
    }
}
