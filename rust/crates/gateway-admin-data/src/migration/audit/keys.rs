use super::{
    Audit, AuditInventory, SliceInventory, api_id, reference, source_fields as source, under,
};
use crate::migration::ObservedRow;
use gateway_core::{
    GatewayError, js_string::JsString16, source_control::decode_source_control_record,
    source_json::SourceJson,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn hash(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}
fn paid_policy(v: &SourceJson, key: bool) -> bool {
    if !source::finite(v, "paid_fallback_enabled").is_some_and(|value| value.is_boolean())
        || !(source::equals(v, "paid_fallback_limit_microcredits", &json!(-1))
            || source::safe(v, "paid_fallback_limit_microcredits"))
        || ![
            "paid_fallback_spent_microcredits",
            "paid_fallback_reserved_microcredits",
        ]
        .iter()
        .all(|f| source::safe(v, f))
        || !source::nullable_string(v, "paid_fallback_reservation_request_id", false)
    {
        return false;
    }
    let enabled = source::equals(v, "paid_fallback_enabled", &json!(true));
    if enabled
        && !source::equals(v, "paid_fallback_limit_microcredits", &json!(-1))
        && !source::positive(v, "paid_fallback_limit_microcredits")
    {
        return false;
    }
    if !key {
        return true;
    }
    let models =
        source::member(v, "paid_fallback_model_ids").and_then(|value| value.array_items().ok());
    if models.as_ref().is_none_or(|models| {
        models.iter().any(|m| {
            m.deserialize::<JsString16>()
                .ok()
                .is_none_or(|s| s.sanitize_js_whitespace_prefix(usize::MAX).is_none())
        })
    }) || !source::safe(v, "paid_fallback_quota_per_credit")
        || !source::nullable_safe(v, "paid_fallback_pricing_checked_at_ms", true)
    {
        return false;
    }
    !enabled
        || (models.is_some_and(|m| !m.is_empty())
            && source::positive(v, "paid_fallback_quota_per_credit")
            && source::positive(v, "paid_fallback_pricing_checked_at_ms"))
}
pub fn valid_key_policy(v: &Value, key: bool) -> bool {
    SourceJson::from_serializable(v).is_ok_and(|source| valid_source_key_policy(&source, key))
}
/// Source-family validation only; no policy/credential/authority is reconstructed.
pub fn valid_source_key_policy(v: &SourceJson, key: bool) -> bool {
    if !paid_policy(v, key)
        || !api_id(source::finite(v, "id").as_ref())
        || !(source::equals(v, "expires_at_ms", &json!(-1)) || source::safe(v, "expires_at_ms"))
        || !source::nullable_safe(v, "revoked_at_ms", false)
        || !(source::equals(v, "usage_limit_requests", &json!(-1))
            || source::safe(v, "usage_limit_requests"))
        || !source::safe(v, "usage_requests")
        || !source::positive(v, "usage_reset_at_ms")
        || !source::positive(v, "window_ms")
    {
        return false;
    }
    !key || (hash(source::finite(v, "hash").as_ref())
        && source::text(v, "prefix").is_some_and(|p| {
            p.len() == 12
                && p.starts_with("u_")
                && p[2..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }))
}
/// Complete source policy pair plus finite facts needed by the other audits.
/// Raw model/map units stay in the source documents, not a Value shadow.
pub struct AuditedKeyPair {
    pub id: SourceJson,
    pub hash: SourceJson,
    pub key_id: String,
    pub unlimited_paid: bool,
}
pub fn inspect_key_pairs(
    rows: &[ObservedRow],
) -> Result<(Vec<AuditedKeyPair>, Audit), GatewayError> {
    let mut pairs = Vec::new();
    let audit = visit_key_pairs(&SliceInventory(rows), &mut |pair| {
        pairs.push(pair);
        Ok(())
    })?;
    Ok((pairs, audit))
}
pub(super) fn visit_key_pairs(
    rows: &dyn AuditInventory,
    emit: &mut dyn FnMut(AuditedKeyPair) -> Result<(), GatewayError>,
) -> Result<Audit, GatewayError> {
    visit_key_pairs_with(rows, emit, &mut |_| {})
}
pub(super) fn visit_key_pairs_with(
    rows: &dyn AuditInventory,
    emit: &mut dyn FnMut(AuditedKeyPair) -> Result<(), GatewayError>,
    observe: &mut dyn FnMut(&ObservedRow),
) -> Result<Audit, GatewayError> {
    let mut audit = Audit::default();
    let mut hashes = BTreeMap::new();
    let mut refs: BTreeMap<String, usize> = BTreeMap::new();
    let mut ordinal = 0usize;
    let mut baselines = Audit::default();
    let mut baseline_error = None;
    let mut bounded_counters = 0;
    rows.visit(&mut |row| {
        observe(row);
        let current = ordinal;
        ordinal += 1;
        if under(&row.parts, &["uos_ai", "api_key_usage", "v2"]) {
            bounded_counters += 1;
        }
        if under(
            &row.parts,
            &[
                "uos_ai",
                "migrations",
                "kv_read_incident_v2",
                "api_key_usage_baseline",
            ],
        ) && baseline_error.is_none()
        {
            baselines.count("api_key_bounded_counter_baselines_v2");
            match row.value() {
                Ok(value) => {
                    if super::super::counter::valid_baseline(value)
                        && !value["reconciled_at_ms"].is_null()
                    {
                        baselines.count("api_key_bounded_counter_reconciled_baselines_v2");
                    }
                }
                Err(error) => baseline_error = Some(error),
            }
        }
        if !under(&row.parts, &["ubq_ai", "api_keys", "hash"]) {
            return Ok(());
        }
        audit.count("api_key_hashes");
        let p = &row.parts;
        let value = decode_source_control_record(&row.record)?;
        if p.len() != 4 || !hash(p.get(3)) {
            audit.errors.push(
                format!("api key hash entry has an invalid key: {}", reference(p))
                    .as_str()
                    .into(),
            );
            return Ok(());
        }
        let hash = p[3].as_str().unwrap_or("");
        if !valid_source_key_policy(&value, false) {
            audit.errors.push(
                format!("api key hash policy has invalid core fields: {hash}")
                    .as_str()
                    .into(),
            );
            return Ok(());
        }
        hashes.insert(hash.to_owned(), current);
        Ok(())
    })?;
    rows.visit(&mut |row| {
        if !under(&row.parts, &["ubq_ai", "api_keys", "id"]) {
            return Ok(());
        }
        audit.count("api_key_ids");
        let p = &row.parts;
        let v = decode_source_control_record(&row.record)?;
        if p.len() != 4 || !api_id(p.get(3)) {
            audit.errors.push(
                format!("api key id entry has an invalid key: {}", reference(p))
                    .as_str()
                    .into(),
            );
            return Ok(());
        }
        let id = p[3].as_str().unwrap_or("");
        if !valid_source_key_policy(&v, true) {
            audit.errors.push(
                format!("api key has invalid v2 policy: {id}")
                    .as_str()
                    .into(),
            );
            return Ok(());
        }
        if source::text(&v, "id").as_deref() != Some(id) {
            audit.errors.push(
                format!(
                    "api key id key suffix does not match record id: key={id} record={}",
                    source::text(&v, "id").unwrap_or_default()
                )
                .as_str()
                .into(),
            );
            return Ok(());
        }
        let hash = source::text(&v, "hash").unwrap_or_default();
        let mut paired = None;
        if let Some(expected) = hashes.get(&hash) {
            let mut ordinal = 0usize;
            rows.visit(&mut |candidate| {
                if ordinal == *expected {
                    paired = Some(decode_source_control_record(&candidate.record)?);
                }
                ordinal += 1;
                Ok(())
            })?;
        }
        let fields = [
            "id",
            "expires_at_ms",
            "revoked_at_ms",
            "usage_limit_requests",
            "usage_requests",
            "usage_reset_at_ms",
            "window_ms",
            "usage_quota_version",
            "paid_fallback_enabled",
            "paid_fallback_limit_microcredits",
            "paid_fallback_spent_microcredits",
            "paid_fallback_reserved_microcredits",
            "paid_fallback_reservation_request_id",
        ];
        if paired
            .as_ref()
            .is_none_or(|h| fields.iter().any(|f| !source::same(&v, h, f)))
        {
            audit.errors.push(
                format!("api key hash policy is missing or inconsistent: {id}")
                    .as_str()
                    .into(),
            );
            return Ok(());
        }
        *refs.entry(hash.to_owned()).or_default() += 1;
        emit(AuditedKeyPair {
            key_id: id.to_owned(),
            unlimited_paid: source::equals(&v, "paid_fallback_limit_microcredits", &json!(-1)),
            id: v,
            hash: paired.expect("validated paired source policy"),
        })?;
        Ok(())
    })?;
    for hash in hashes.keys() {
        match refs.get(hash).copied().unwrap_or(0) {
            0 => audit.errors.push(
                format!("api key hash policy is orphaned: {hash}")
                    .as_str()
                    .into(),
            ),
            n if n > 1 => audit.errors.push(
                format!("api key hash policy has multiple id records: {hash}")
                    .as_str()
                    .into(),
            ),
            _ => {}
        }
    }
    let ids = audit.counts.get("api_key_ids").copied().unwrap_or(0);
    let hash_count = audit.counts.get("api_key_hashes").copied().unwrap_or(0);
    if ids != hash_count {
        audit.errors.insert(
            0,
            format!("api key id/hash count mismatch: ids={ids} hashes={hash_count}")
                .as_str()
                .into(),
        );
    }
    if let Some(error) = baseline_error {
        return Err(error);
    }
    audit.merge(baselines);
    audit
        .counts
        .insert("api_key_bounded_counters_v2".into(), bounded_counters);
    Ok(audit)
}
