//! Finite JSON-tree conversion for explicitly selected control record families.
//! This data codec never reads storage, validates a family, renews expiry or grants authority.
use crate::{
    GatewayError,
    js_string::JsString16,
    source_json::SourceJson,
    source_serialization as source,
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use serde_json::Value;

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "Source control record is not a finite JSON tree.",
        "source_control_record_invalid",
    )
}

/// Parse only through the existing SourceJson/JsString16 grammar. Object identity
/// follows source JSON values: last duplicate value, original property position.
/// Numbers use the source Number domain; no JSON.stringify/canonical/digest step occurs.
pub fn source_json_tree(value: &SourceJson) -> Result<PortableValue, GatewayError> {
    match value.as_str().as_bytes().first() {
        Some(b'"') => Ok(PortableValue::StringUtf16(
            value.deserialize::<JsString16>()?,
        )),
        Some(b'[') => Ok(PortableValue::Array(
            value
                .array_items()?
                .iter()
                .map(source_json_tree)
                .collect::<Result<_, _>>()?,
        )),
        Some(b'{') => Ok(PortableValue::ObjectUtf16(
            source::entries(value)
                .ok_or_else(invalid)?
                .into_iter()
                .map(|(key, value)| Ok((key, source_json_tree(&value)?)))
                .collect::<Result<_, GatewayError>>()?,
        )),
        _ => match value.as_str() {
            "null" => Ok(PortableValue::Null),
            "true" => Ok(PortableValue::Boolean(true)),
            "false" => Ok(PortableValue::Boolean(false)),
            _ => source::number(value)
                .filter(|number| number.is_finite())
                .map(PortableValue::number)
                .ok_or_else(invalid),
        },
    }
}

/// Keep the existing ordinary Json representation whenever Value can retain the
/// document. A lone string/key unit requires the existing explicit ProfileV2,
/// never a literal escape string or a new private encoding. Numeric family
/// constraints and complete DTO/key/version validation remain caller-owned.
pub fn encode_source_control_record(
    revision: impl Into<String>,
    document: &SourceJson,
    absolute_expiry: Option<i64>,
) -> Result<StoredRecord, GatewayError> {
    let revision = revision.into();
    let tree = source_json_tree(document)?;
    match document.deserialize::<Value>() {
        Ok(value) => Ok(StoredRecord::json(revision, value, absolute_expiry)),
        Err(_) => StoredRecord::profile_v2(revision, tree, absolute_expiry),
    }
}

/// This finite writer deliberately handles -0 through existing serde/SourceJson
/// instead of JSON.stringify (which turns it into 0) or changing NumberBits.
fn tree_source(value: &PortableValue) -> Result<SourceJson, GatewayError> {
    match value {
        PortableValue::Null => SourceJson::parse("null"),
        PortableValue::Boolean(value) => SourceJson::from_serializable(value),
        PortableValue::String(value) => SourceJson::from_serializable(value),
        PortableValue::StringUtf16(value) => value.to_source_json(),
        PortableValue::NumberBits(_) => {
            let number = value
                .number_value()
                .filter(|value| value.is_finite())
                .ok_or_else(invalid)?;
            if number == 0.0 && number.is_sign_negative() {
                SourceJson::from_serializable(&number)
            } else {
                SourceJson::from_serializable(&value.to_json_lossless().ok_or_else(invalid)?)
            }
        }
        PortableValue::Array(values) => source::json_array(
            &values
                .iter()
                .map(tree_source)
                .collect::<Result<Vec<_>, _>>()?,
        ),
        PortableValue::Object(values) => source::object_keys(
            values
                .iter()
                .map(|(key, value)| Ok((JsString16::from_utf8(key), tree_source(value)?)))
                .collect::<Result<_, GatewayError>>()?,
        ),
        PortableValue::ObjectUtf16(values) => source::object_keys(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), tree_source(value)?)))
                .collect::<Result<_, GatewayError>>()?,
        ),
        _ => Err(invalid()),
    }
}

/// Decode data only. No automatic ProfileV1/graph conversion or permissive
/// json_value change; consumers must still validate their exact family schema.
pub fn decode_source_control_record(record: &StoredRecord) -> Result<SourceJson, GatewayError> {
    record.validate_version()?;
    match record.value_encoding {
        ValueEncoding::Json => SourceJson::from_serializable(record.json_value()?),
        ValueEncoding::ProfileV2 => tree_source(&record.profile_v2_value()?),
        ValueEncoding::ProfileV1 | ValueEncoding::SourceGraphV1 => Err(invalid()),
    }
}
