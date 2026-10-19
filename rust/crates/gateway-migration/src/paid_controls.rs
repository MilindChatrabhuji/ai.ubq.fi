//! Only the actual paid source/runtime families opt into this finite codec.
//! Complete runtime DTO/key validation remains owned by gateway-authority.
use crate::*;
use gateway_core::{
    js_string::JsString16,
    source_control::{
        decode_source_control_record, encode_source_control_record, source_json_tree,
    },
    source_serialization as source,
    value::PortableValue,
};

fn required(value: &SourceJson, field: &str) -> Result<SourceJson, GatewayError> {
    source::member(value, field)
        .ok_or_else(|| invalid(format!("Paid source field is missing: {field}")))
}
fn put(fields: &mut Vec<(JsString16, SourceJson)>, name: &str, value: SourceJson) {
    let name = JsString16::from_utf8(name);
    if let Some((_, old)) = fields.iter_mut().find(|(key, _)| *key == name) {
        *old = value;
    } else {
        fields.push((name, value));
    }
}
pub(crate) fn forward(row: &mut Row) -> Result<bool, GatewayError> {
    if starts(
        &row.parts,
        &["uos_ai", "paid_fallback", "v3", "usage_rollup"],
    ) {
        crate::rollup_source::validate(&row.key, &row.record)?;
        return Ok(true);
    }
    if !starts(&row.parts, &["uos_ai", "paid_fallback", "v3", "request"]) {
        return Ok(false);
    }
    let document = decode_source_control_record(&row.record)?;
    if row.parts.len() != 6
        || required(&document, "key_id")?.deserialize::<Value>()? != row.parts[4]
        || required(&document, "request_id")?.deserialize::<Value>()? != row.parts[5]
    {
        return Err(invalid("Paid source request identity conflicts"));
    }
    let mut fields = source::entries(&document)
        .ok_or_else(|| invalid("Paid source request is not an object"))?;
    let request = required(&document, "request_id")?;
    let provider =
        source::member(&document, "provider").unwrap_or(SourceJson::from_serializable("metered")?);
    let reservation = source::object(vec![
        ("key_id", required(&document, "key_id")?),
        (
            "request_id",
            source::member(&document, "original_request_id").unwrap_or(request.clone()),
        ),
        ("attempt_id", request),
        ("provider", provider),
        (
            "window_reset_at_ms",
            required(&document, "window_reset_at_ms")?,
        ),
        ("created_at_ms", required(&document, "created_at_ms")?),
        (
            "reserved_microcredits",
            required(&document, "reserved_microcredits")?,
        ),
    ])?;
    put(&mut fields, "reservation", reservation);
    put(
        &mut fields,
        "transport_started",
        SourceJson::parse("false")?,
    );
    for field in ["cached_input_tokens", "usage_rollup_at_ms"] {
        put(
            &mut fields,
            field,
            source::member(&document, field).unwrap_or(SourceJson::parse("null")?),
        );
    }
    let record = encode_source_control_record(
        &row.record.revision,
        &source::object_keys(fields)?,
        row.record.expires_at_ms,
    )?;
    gateway_authority::paid::decode_paid_attempt_record(&row.key, &record)?;
    row.record = record;
    row.mapping.transform = Transform::PaidRequest;
    Ok(true)
}

pub(crate) fn inverse(
    key: &RecordKey,
    record: &StoredRecord,
    original: Option<&SourceEntry>,
) -> Result<PortableValue, GatewayError> {
    gateway_authority::paid::decode_paid_attempt_record(key, record)?;
    let current = decode_source_control_record(record)?;
    let mut fields = match original {
        Some(original) => {
            let tree = gateway_admin_data::profile::from_source_profile(&original.value)?;
            source::entries(&tree.to_source_json()?)
                .ok_or_else(|| invalid("Paid source sidecar is not an object"))?
        }
        None => Vec::new(),
    };
    for (name, value) in
        source::entries(&current).ok_or_else(|| invalid("Paid runtime request is not an object"))?
    {
        if let Some((_, old)) = fields.iter_mut().find(|(key, _)| *key == name) {
            *old = value;
        } else {
            fields.push((name, value));
        }
    }
    let reservation = required(&current, "reservation")?;
    for field in [
        "key_id",
        "window_reset_at_ms",
        "created_at_ms",
        "reserved_microcredits",
        "provider",
    ] {
        put(&mut fields, field, required(&reservation, field)?);
    }
    let request = required(&reservation, "request_id")?;
    let attempt = required(&reservation, "attempt_id")?;
    put(&mut fields, "request_id", attempt.clone());
    if request.deserialize::<String>()? != attempt.deserialize::<String>()? {
        put(&mut fields, "original_request_id", request);
    }
    fields.retain(|(key, _)| {
        !["reservation", "transport_started"]
            .iter()
            .any(|name| key.as_units().iter().copied().eq(name.encode_utf16()))
    });
    source_json_tree(&source::object_keys(fields)?)
}
