use crate::engine::{Manifest, manifest_key, mapping_key};
use crate::*;
use gateway_admin_data::profile::{encode_base64, to_source_profile as to_profile};
use gateway_core::{
    query::{QueryRequest, QuerySelector, QueryStore},
    tuple_key::DecodedKeyPart,
    value::PortableValue,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

fn source_profile_key(key: &RecordKey) -> Result<Vec<SourceJson>, GatewayError> {
    TupleKey::from_record_key(key)?.decoded_parts()?.into_iter().map(|part| match part {
        DecodedKeyPart::String(bytes) => {
            let text=String::from_utf8(bytes).map_err(|_|unavailable("New non-UTF8 source key needs exact typed encoding"))?;
            to_profile(&PortableValue::String(text))
        }
        DecodedKeyPart::Number(number)=>to_profile(&PortableValue::number(number)),
        DecodedKeyPart::Boolean(value)=>to_profile(&PortableValue::Boolean(value)),
        DecodedKeyPart::Bytes(bytes)=>SourceJson::from_serializable(&json!({"type":"Uint8Array","value":encode_base64(&bytes)})),
        DecodedKeyPart::BigInt{negative,magnitude}=>to_profile(&PortableValue::BigInt(decimal_key(negative,&magnitude))),
    }).collect()
}

pub(crate) fn decimal_key(negative: bool, magnitude: &[u8]) -> String {
    let mut digits = vec![0_u32];
    for byte in magnitude {
        let mut carry = u32::from(*byte);
        for digit in &mut digits {
            let value = *digit * 256 + carry;
            *digit = value % 10;
            carry = value / 10;
        }
        while carry > 0 {
            digits.push(carry % 10);
            carry /= 10;
        }
    }
    let mut decimal = digits
        .into_iter()
        .rev()
        .map(|d| char::from_digit(d, 10).expect("decimal digit"))
        .collect::<String>();
    if negative && decimal != "0" {
        decimal.insert(0, '-');
    }
    decimal
}
fn overlay(original: &Value, current: &Value) -> Result<Value, GatewayError> {
    let mut out = original.as_object().cloned().unwrap_or_default();
    for (k, v) in current
        .as_object()
        .ok_or_else(|| invalid("Transformed runtime record is not an object"))?
    {
        out.insert(k.clone(), v.clone());
    }
    Ok(Value::Object(out))
}
fn remove(value: &mut Value, fields: &[&str]) {
    if let Some(object) = value.as_object_mut() {
        for field in fields {
            object.remove(*field);
        }
    }
}
fn inverse_value(
    transform: Transform,
    record: &StoredRecord,
    source: Option<&SourceEntry>,
) -> Result<PortableValue, GatewayError> {
    if transform == Transform::Identity {
        return record.portable_value();
    }
    if transform == Transform::CatalogBytes {
        let bytes: Vec<u8> = decode(record.json_value()?)?;
        let len = bytes.len() as u64;
        return Ok(PortableValue::Binary {
            kind: "Uint8Array".into(),
            bytes,
            byte_offset: 0,
            byte_length: len,
        });
    }
    let current = record.json_value()?;
    let original = source
        .map(|s| gateway_admin_data::profile::from_source_profile(&s.value))
        .transpose()?
        .and_then(|v| v.to_json_lossless())
        .unwrap_or(json!({}));
    let mut out = overlay(&original, current)?;
    match transform {
        Transform::ApiWindow | Transform::KernelWindow => remove(&mut out, &["reservations"]),
        Transform::ApiRequest => remove(&mut out, &["transport_started"]),
        Transform::KernelRequest => {
            let state = current["state"].as_str().unwrap_or("reserved");
            out["state"] = json!(state);
            out["committed_at_ms"] = if state == "committed" {
                current["terminal_at_ms"].clone()
            } else {
                Value::Null
            };
            out["released_at_ms"] = if state == "released" {
                current["terminal_at_ms"].clone()
            } else {
                Value::Null
            };
            remove(&mut out, &["terminal_at_ms"]);
        }
        Transform::PaidRequest => {
            let reservation = current
                .get("reservation")
                .ok_or_else(|| invalid("Paid reservation missing in inverse"))?;
            for field in [
                "key_id",
                "window_reset_at_ms",
                "created_at_ms",
                "reserved_microcredits",
                "provider",
            ] {
                out[field] = reservation[field].clone();
            }
            out["request_id"] = reservation["attempt_id"].clone();
            if reservation["request_id"] != reservation["attempt_id"] {
                out["original_request_id"] = reservation["request_id"].clone();
            }
            remove(&mut out, &["reservation", "transport_started"]);
        }
        Transform::PaidPending => remove(&mut out, &["key_id", "attempt_id"]),
        Transform::PaidGate => remove(&mut out, &["pending"]),
        Transform::Identity | Transform::CatalogBytes => {}
    }
    if matches!(
        transform,
        Transform::KernelWindow | Transform::KernelRequest
    ) {
        out["scope"] = json!(if out.get("repo").is_some_and(Value::is_string) {
            "repo"
        } else {
            "org"
        });
    }
    if matches!(
        transform,
        Transform::KernelWindow | Transform::KernelRequest
    ) && out["repo"].is_null()
    {
        remove(&mut out, &["repo"]);
    }
    Ok(PortableValue::from_json(&out))
}
fn transform_for_new(parts: &[Value]) -> Transform {
    if starts(parts, &["uos_ai", "api_key_usage", "v3", "window"]) {
        Transform::ApiWindow
    } else if starts(parts, &["uos_ai", "api_key_usage", "v3", "request"]) {
        Transform::ApiRequest
    } else if starts(parts, &["uos_ai", "paid_fallback", "v3", "request"]) {
        Transform::PaidRequest
    } else if starts(parts, &["uos_ai", "paid_fallback", "v3", "pending"]) {
        Transform::PaidPending
    } else if starts(
        parts,
        &["uos_ai", "paid_fallback", "v3", "reconciliation_gate"],
    ) {
        Transform::PaidGate
    } else if starts(parts, &["uos_ai", "kernel_quota", "v2"])
        && parts
            .get(3)
            .and_then(Value::as_str)
            .is_some_and(|s| s.ends_with("_window"))
    {
        Transform::KernelWindow
    } else if starts(parts, &["uos_ai", "kernel_quota", "v2"])
        && parts
            .get(3)
            .and_then(Value::as_str)
            .is_some_and(|s| s.ends_with("_reservation"))
    {
        Transform::KernelRequest
    } else {
        Transform::Identity
    }
}
/// Export only after the current target owner has actually stopped its writers.
/// QueryStore pages are not a cross-page snapshot; no stale backup is read or restored.
async fn export_internal<S: QueryStore>(
    store: &S,
    now_ms: i64,
) -> Result<(PrivateCapture, Vec<CustodyRecord>), GatewayError> {
    let manifest = store
        .read(&manifest_key())
        .await?
        .ok_or_else(|| invalid("No adopted capture manifest"))?;
    let manifest: Manifest = decode(manifest.json_value()?)?;
    if manifest.v != 3 || now_ms < manifest.captured_at_ms {
        return Err(invalid("Inverse capture clock/version invalid"));
    }
    let mut all = BTreeMap::new();
    let mut cursor = None;
    let mut seen = BTreeSet::new();
    loop {
        let page = store
            .query(QueryRequest {
                selector: QuerySelector::Prefix {
                    prefix: TupleKey::from_parts(&[])?.to_record_key(),
                    start: None,
                    end: None,
                },
                reverse: false,
                limit: 256,
                cursor: cursor.clone(),
                now_ms,
            })
            .await?;
        for entry in page.entries {
            if all.insert(entry.key.0.clone(), entry.record).is_some() {
                return Err(invalid("Inverse query repeated a source key"));
            }
        }
        cursor = page.next_cursor;
        if let Some(c) = &cursor {
            if !seen.insert(c.clone()) {
                return Err(invalid("Inverse query cursor loop"));
            }
        } else {
            break;
        }
    }
    let mapping_prefix = key(json!([
        "uos_ai",
        "migration",
        "v3",
        "row",
        manifest.capture_id
    ]));
    let prefix = TupleKey::from_record_key(&mapping_prefix)?;
    let mappings = all
        .iter()
        .filter_map(|(key, record)| {
            let tuple = TupleKey::from_record_key(&RecordKey(key.clone())).ok()?;
            tuple
                .is_strict_descendant_of(&prefix)
                .then_some((key.clone(), record.clone()))
        })
        .collect::<Vec<_>>();
    if mappings.len() != manifest.source_rows
        || crate::engine::mapping_checksum(mappings)? != manifest.mapping_checksum
    {
        return Err(invalid("Inverse mapping inventory is missing or modified"));
    }
    let mut entries = Vec::new();
    let mut controls = Vec::new();
    for (k, record) in &all {
        let key = RecordKey(k.clone());
        if let Some(mapping) = all.get(&mapping_key(&manifest.capture_id, k).0) {
            let mapping: Mapping = decode(mapping.json_value()?)?;
            let mut source = mapping.source.clone();
            if mapping.transform == Transform::Identity {
                source.key = source_profile_key(&key)?;
            }
            if mapping.transform != Transform::Identity
                && digest(record)? == mapping.baseline_digest
            {
                // Exact untouched non-secret source transform retains all source-only fields.
            } else {
                source.value =
                    to_profile(&inverse_value(mapping.transform, record, Some(&source))?)?;
            }
            source.versionstamp = record.revision.clone();
            source.expires_at_ms = record.expires_at_ms;
            entries.push(source);
            continue;
        }
        let p = parts(&key)?;
        if starts(&p, &["uos_ai", "migration"]) {
            continue;
        }
        if key == gateway_auth::native_replay::native_nonce_key() {
            record.validate_version()?;
            controls.push(CustodyRecord {
                key: k.clone(),
                record: record.clone(),
            });
            continue;
        }
        if starts(&p, &["uos_ai", "authority"]) {
            if key == gateway_authority::keys::kernel_defaults() {
                let mut expected = gateway_authority::quota::KernelDefaults::default();
                if let Some(source) =
                    all.get(&crate::key(json!(["default", "kernel_policy_limit_requests"])).0)
                {
                    expected.usage_limit_requests =
                        gateway_admin_runtime::parse::limit(source.json_value()?).unwrap_or(-1);
                }
                if let Some(source) =
                    all.get(&crate::key(json!(["default", "kernel_policy_window_ms"])).0)
                {
                    expected.window_ms =
                        gateway_admin_runtime::parse::positive(source.json_value()?)
                            .unwrap_or(604800000);
                }
                let actual: gateway_authority::quota::KernelDefaults =
                    decode(record.json_value()?)?;
                if actual != expected {
                    return Err(invalid(
                        "Latest derived Kernel defaults differ from source defaults; inverse would lose policy",
                    ));
                }
            }
            if p.get(3).and_then(Value::as_str) == Some("api_policy") {
                let id = p
                    .get(4)
                    .and_then(Value::as_str)
                    .ok_or_else(|| invalid("Derived API policy ID is missing"))?;
                let source = all
                    .get(&gateway_auth::api_keys::id_key(id).0)
                    .ok_or_else(|| invalid("Derived API policy has no source ID"))?;
                let source: gateway_admin::keys::ApiKeyRecord = decode(source.json_value()?)?;
                let mut expected = gateway_admin::keys::authority_policy(&source, now_ms);
                let actual: gateway_authority::quota::ApiKeyPolicy = decode(record.json_value()?)?;
                if source.policy.revoked_at_ms.is_some() && actual.expires_at_ms <= now_ms {
                    expected.expires_at_ms = actual.expires_at_ms;
                }
                if actual != expected {
                    return Err(invalid(
                        "Latest derived API policy differs from the source ID; inverse would lose policy",
                    ));
                }
            }
            if p.get(3).and_then(Value::as_str).is_some_and(|s| {
                [
                    "codex_pool",
                    "paid_routing",
                    "paid_control_owner",
                    "paid_control_config",
                    "paid_control_observation",
                    "codex_reset_config",
                ]
                .contains(&s)
            }) {
                record.validate_version()?;
                controls.push(CustodyRecord {
                    key: k.clone(),
                    record: record.clone(),
                });
                continue;
            }
            if p.get(3).and_then(Value::as_str).is_some_and(|s| {
                [
                    "api_policy",
                    "codex_pool",
                    "kernel_defaults",
                    "paid_routing",
                    "paid_control_owner",
                    "paid_control_config",
                    "paid_control_observation",
                    "codex_reset_config",
                ]
                .contains(&s)
            }) {
                continue;
            }
            return Err(unavailable(
                "Unknown normalized authority state cannot be silently omitted from inverse",
            ));
        }
        if let Some(expected) = manifest.derived.get(k) {
            if digest(record)? == *expected {
                continue;
            }
        }
        if !crate::projection::known(&p) {
            return Err(unavailable(
                "Latest target includes an unmapped source key family",
            ));
        }
        let transform = transform_for_new(&p);
        entries.push(SourceEntry {
            key: source_profile_key(&key)?,
            value: to_profile(&inverse_value(transform, record, None)?)?,
            versionstamp: record.revision.clone(),
            expires_at_ms: record.expires_at_ms,
        });
    }
    let result = PrivateCapture {
        v: 1,
        source_git_sha: manifest.source_git_sha,
        captured_at_ms: now_ms,
        entries,
    };
    // A private export is not a successful rollback until every latest source/index
    // invariant can be re-adopted. This reads no old database or backup.
    crate::prepare(&result, &CanonicalDates)?;
    Ok((result, controls))
}

/// Source data alone is insufficient once a Rust transport/control owner exists.
pub async fn export_latest<S: QueryStore>(
    store: &S,
    now_ms: i64,
) -> Result<PrivateCapture, GatewayError> {
    let (source, controls) = export_internal(store, now_ms).await?;
    if !controls.is_empty() {
        return Err(GatewayError::unavailable(
            "Rust-only control/replay custody requires export_rollback_bundle; source-only export would omit it",
            "migration_control_custody_required",
        ));
    }
    Ok(source)
}

/// Private current operational evidence; this type has no restore/authorization constructor.
#[derive(Clone, serde::Serialize)]
pub struct CustodyRecord {
    pub key: String,
    pub record: StoredRecord,
}
#[derive(Clone, serde::Serialize)]
pub struct ArtifactContext {
    pub rust_git_sha: String,
    pub rust_git_tree: String,
    pub wasm_sha256: String,
    pub native_sha256: String,
    /// Separately retained stopped native nonce SQLite+WAL/SHM custody, never opened here.
    pub native_nonce_capture_sha256: Option<String>,
}
#[derive(Clone, serde::Serialize)]
pub struct PrivateRollbackBundle {
    pub v: u32,
    pub source: PrivateCapture,
    pub rust_controls: Vec<CustodyRecord>,
    pub artifacts: ArtifactContext,
}
pub async fn export_rollback_bundle<S: QueryStore>(
    store: &S,
    now_ms: i64,
    artifacts: ArtifactContext,
) -> Result<PrivateRollbackBundle, GatewayError> {
    let hash = |value: &str, len: usize| {
        value.len() == len
            && value
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    };
    if !hash(&artifacts.rust_git_sha, 40)
        || !hash(&artifacts.rust_git_tree, 40)
        || !hash(&artifacts.wasm_sha256, 64)
        || !hash(&artifacts.native_sha256, 64)
        || artifacts
            .native_nonce_capture_sha256
            .as_deref()
            .is_some_and(|s| !hash(s, 64))
    {
        return Err(invalid("Rollback artifact identity is malformed"));
    }
    let (source, rust_controls) = export_internal(store, now_ms).await?;
    Ok(PrivateRollbackBundle {
        v: 1,
        source,
        rust_controls,
        artifacts,
    })
}
