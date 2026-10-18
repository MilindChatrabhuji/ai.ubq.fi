use crate::engine::{Manifest, manifest_key, mapping_key};
use crate::*;
use gateway_admin_data::profile::{encode_base64, to_profile};
use gateway_core::{
    query::{QueryRequest, QuerySelector, QueryStore},
    tuple_key::DecodedKeyPart,
    value::PortableValue,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

fn source_profile_key(key: &RecordKey) -> Result<Vec<Value>, GatewayError> {
    TupleKey::from_record_key(key)?
        .decoded_parts()?
        .into_iter()
        .map(|p| match p {
            DecodedKeyPart::String(s) => String::from_utf8(s)
                .map(|v| json!({"type":"string","value":v}))
                .map_err(|_| unavailable("New non-UTF8 source key needs exact typed encoding")),
            DecodedKeyPart::Number(n) => to_profile(&PortableValue::number(n)),
            DecodedKeyPart::Boolean(v) => Ok(json!({"type":"boolean","value":v})),
            DecodedKeyPart::Bytes(v) => Ok(json!({"type":"Uint8Array","value":encode_base64(&v)})),
            DecodedKeyPart::BigInt { .. } => Err(unavailable(
                "New bigint application key needs its source profile mapping",
            )),
        })
        .collect()
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
        .map(|s| gateway_admin_data::profile::from_profile(&s.value))
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
        Transform::Routing => out = crate::routing::inverse_routing(current, &original)?,
        Transform::Capacity => out = crate::routing::inverse_capacity(current, &original)?,
        Transform::Identity | Transform::CatalogBytes => {}
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
pub async fn export_latest<S: QueryStore>(
    store: &S,
    now_ms: i64,
) -> Result<PrivateCapture, GatewayError> {
    let manifest = store
        .read(&manifest_key())
        .await?
        .ok_or_else(|| invalid("No adopted capture manifest"))?;
    let manifest: Manifest = decode(manifest.json_value()?)?;
    if manifest.v != 1 || now_ms < manifest.captured_at_ms {
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
    let mut entries = Vec::new();
    let source_keys: BTreeSet<_> = manifest.source_keys.iter().cloned().collect();
    for (k, record) in &all {
        let key = RecordKey(k.clone());
        if source_keys.contains(k) {
            let mapping = all
                .get(&mapping_key(&manifest.capture_id, k).0)
                .ok_or_else(|| invalid("Inverse mapping missing"))?;
            let mapping: Mapping = decode(mapping.json_value()?)?;
            let mut source = mapping.source.clone();
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
        if starts(&p, &["uos_ai", "authority"]) {
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
    Ok(PrivateCapture {
        v: 1,
        source_git_sha: manifest.source_git_sha,
        captured_at_ms: now_ms,
        entries,
    })
}
