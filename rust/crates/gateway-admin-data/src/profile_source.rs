//! Source-profile JSON leaves preserve JavaScript UTF16 without passing through Value.
use crate::{error, profile::*};
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, value::PortableValue,
};
use serde_json::Value;

type Fields = Vec<(JsString16, SourceJson)>;
fn field<'a>(fields: &'a Fields, name: &str) -> Option<&'a SourceJson> {
    fields
        .iter()
        .rev()
        .find(|(key, _)| key.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, value)| value)
}
fn text(value: &SourceJson) -> Result<JsString16, GatewayError> {
    value.deserialize()
}
fn string(value: JsString16) -> PortableValue {
    match value.try_utf8() {
        Ok(value) => PortableValue::String(value),
        Err(_) => PortableValue::StringUtf16(value),
    }
}
fn array(values: Vec<SourceJson>) -> Result<SourceJson, GatewayError> {
    SourceJson::parse(&format!(
        "[{}]",
        values
            .iter()
            .map(SourceJson::as_str)
            .collect::<Vec<_>>()
            .join(",")
    ))
}
fn object(values: Vec<(JsString16, SourceJson)>) -> Result<SourceJson, GatewayError> {
    let values = values
        .into_iter()
        .map(|(key, value)| {
            Ok(format!(
                "{}:{}",
                key.to_source_json()?.as_str(),
                value.as_str()
            ))
        })
        .collect::<Result<Vec<_>, GatewayError>>()?;
    SourceJson::parse(&format!("{{{}}}", values.join(",")))
}
fn tag(kind: &str, value: Option<SourceJson>) -> Result<SourceJson, GatewayError> {
    let mut fields = vec![(
        JsString16::from_utf8("type"),
        SourceJson::from_serializable(kind)?,
    )];
    if let Some(value) = value {
        fields.push((JsString16::from_utf8("value"), value));
    }
    object(fields)
}
fn index(key: &JsString16) -> Option<u32> {
    let key = key.try_utf8().ok()?;
    let index = key.parse::<u32>().ok().filter(|n| *n < u32::MAX)?;
    (index.to_string() == key).then_some(index)
}
// JSON.parse overwrites duplicate properties in their original position. Object.entries
// enumerates array-index names first, then other names in insertion order.
fn own_entries(input: Fields) -> Fields {
    let mut fields: Fields = vec![];
    for (key, value) in input {
        if let Some((_, old)) = fields.iter_mut().find(|(old, _)| old == &key) {
            *old = value;
        } else {
            fields.push((key, value));
        }
    }
    fields.sort_by(|(left, _), (right, _)| match (index(left), index(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    fields
}
fn object_value(fields: Vec<(JsString16, PortableValue)>) -> PortableValue {
    if fields.iter().all(|(key, _)| key.try_utf8().is_ok()) {
        PortableValue::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.try_utf8().expect("checked scalar key"), value))
                .collect(),
        )
    } else {
        PortableValue::ObjectUtf16(fields)
    }
}
fn raw_json(value: &SourceJson) -> Result<PortableValue, GatewayError> {
    let raw = value.as_str().trim();
    Ok(match raw.as_bytes().first() {
        Some(b'"') => string(text(value)?),
        Some(b'{') => object_value(
            own_entries(value.object_entries()?)
                .into_iter()
                .map(|(key, value)| Ok((key, raw_json(&value)?)))
                .collect::<Result<_, GatewayError>>()?,
        ),
        Some(b'[') => PortableValue::Array(
            value
                .array_items()?
                .iter()
                .map(raw_json)
                .collect::<Result<_, _>>()?,
        ),
        _ if raw == "null" => PortableValue::Null,
        _ if raw == "true" || raw == "false" => PortableValue::Boolean(raw == "true"),
        _ => PortableValue::number(
            raw.parse::<f64>()
                .map_err(|_| error("Invalid source JSON number."))?,
        ),
    })
}
fn js_text(value: Option<&SourceJson>) -> Result<JsString16, GatewayError> {
    let Some(value) = value else {
        return Ok(JsString16::from_utf8("undefined"));
    };
    let raw = value.as_str().trim();
    match raw.as_bytes().first() {
        Some(b'"') => text(value),
        Some(b'{') => Ok(JsString16::from_utf8("[object Object]")),
        Some(b'[') => {
            let mut units = Vec::new();
            for (at, item) in value.array_items()?.iter().enumerate() {
                if at != 0 {
                    units.push(44);
                }
                if item.as_str() != "null" {
                    units.extend_from_slice(js_text(Some(item))?.as_units());
                }
            }
            Ok(JsString16::from_units(units))
        }
        _ => {
            let value = raw_json(value)?;
            if let Some(number) = value.number_value() {
                return Ok(JsString16::from_utf8(ryu_js::Buffer::new().format(number)));
            }
            Ok(JsString16::from_utf8(raw))
        }
    }
}
fn number(value: Option<&SourceJson>) -> Result<f64, GatewayError> {
    let Some(value) = value else {
        return Ok(f64::NAN);
    };
    match value.as_str().trim() {
        "null" => return Ok(0.0),
        "true" => return Ok(1.0),
        "false" => return Ok(0.0),
        _ => {}
    }
    if !matches!(
        value.as_str().trim().as_bytes().first(),
        Some(b'"' | b'[' | b'{')
    ) {
        return value
            .as_str()
            .trim()
            .parse::<f64>()
            .map_err(|_| error("Invalid source number."));
    }
    Ok(js_text(Some(value))?
        .try_utf8()
        .map(|text| js_number(&Value::String(text)))
        .unwrap_or(f64::NAN))
}
fn truthy(value: &SourceJson) -> Result<bool, GatewayError> {
    Ok(match raw_json(value)? {
        PortableValue::Null | PortableValue::Undefined => false,
        PortableValue::Boolean(value) => value,
        PortableValue::String(value) => !value.is_empty(),
        PortableValue::StringUtf16(value) => !value.as_units().is_empty(),
        PortableValue::NumberBits(_) => {
            let number = number(Some(value))?;
            number != 0.0 && !number.is_nan()
        }
        _ => true,
    })
}
fn same(a: &PortableValue, b: &PortableValue) -> bool {
    let string = |value: &PortableValue| match value {
        PortableValue::String(value) => Some(JsString16::from_utf8(value)),
        PortableValue::StringUtf16(value) => Some(value.clone()),
        _ => None,
    };
    string(a).zip(string(b)).is_some_and(|(a, b)| a == b) || same_primitive(a, b)
}
fn entries(value: &SourceJson) -> Result<Fields, GatewayError> {
    match value.as_str().trim().as_bytes().first() {
        Some(b'{') => Ok(own_entries(value.object_entries()?)),
        Some(b'[') => Ok(value
            .array_items()?
            .into_iter()
            .enumerate()
            .map(|(i, v)| (JsString16::from_utf8(&i.to_string()), v))
            .collect()),
        Some(b'"') => text(value)?
            .as_units()
            .iter()
            .enumerate()
            .map(|(i, v)| {
                Ok((
                    JsString16::from_utf8(&i.to_string()),
                    JsString16::from_units(vec![*v]).to_source_json()?,
                ))
            })
            .collect(),
        _ if value.as_str().trim() == "null" => Err(error("Malformed profile object.")),
        _ => Ok(vec![]),
    }
}
fn regexp_source(value: &JsString16) -> Result<PortableValue, GatewayError> {
    let units = value.as_units();
    let split = units.iter().rposition(|v| *v == 47);
    let (pattern, flags) = if let Some(split) = split {
        (
            &units[units.len().min(1)..split.max(1)],
            &units[split + 1..],
        )
    } else {
        (
            &units[units.len().min(1)..units.len().saturating_sub(1).max(units.len().min(1))],
            units,
        )
    };
    let flags = JsString16::from_units(flags.to_vec()).try_utf8()?;
    // Escape only for the Rust syntax validator; the stored source keeps the original units.
    let mut syntax = String::new();
    for scalar in std::char::decode_utf16(pattern.iter().copied()) {
        match scalar {
            Ok(c) => syntax.push(c),
            Err(error) => syntax.push_str(&format!("\\u{:04x}", error.unpaired_surrogate())),
        }
    }
    let (_, flags) = regexp(&format!("/{syntax}/{flags}"))?;
    let mut out = Vec::new();
    let mut escaped = false;
    for &unit in pattern {
        let escape = match unit {
            47 if !escaped => Some("\\/"),
            10 => Some("\\n"),
            13 => Some("\\r"),
            0x2028 => Some("\\u2028"),
            0x2029 => Some("\\u2029"),
            _ => None,
        };
        if let Some(value) = escape {
            out.extend(value.encode_utf16())
        } else {
            out.push(unit)
        }
        escaped = unit == 92 && !escaped;
    }
    if out.is_empty() {
        out.extend("(?:)".encode_utf16());
    }
    let source = JsString16::from_units(out);
    Ok(match source.try_utf8() {
        Ok(source) => PortableValue::RegExp { source, flags },
        Err(_) => PortableValue::RegExpUtf16 { source, flags },
    })
}

pub fn from_source_profile(input: &SourceJson) -> Result<PortableValue, GatewayError> {
    from_source_profile_with_host(input, &CanonicalDates)
}
pub fn from_source_profile_with_host(
    input: &SourceJson,
    host: &dyn SourceDateHost,
) -> Result<PortableValue, GatewayError> {
    let fields = input.object_entries()?;
    let kind = field(&fields, "type")
        .ok_or_else(|| error("Malformed profile value."))?
        .deserialize::<String>()?;
    let value = field(&fields, "value");
    let parsed = match kind.as_str() {
        "undefined" => PortableValue::Undefined,
        "null" => PortableValue::Null,
        "boolean" | "string" => value
            .map(raw_json)
            .transpose()?
            .unwrap_or(PortableValue::Undefined),
        "number" => PortableValue::number(number(value)?),
        "bigint" | "KvU64" => {
            let (_, decimal, _) = normalize_bigint(&js_text(value)?.try_utf8()?)?;
            if kind == "KvU64" {
                decimal
                    .parse::<u64>()
                    .map_err(|_| error("KvU64 is outside its unsigned 64-bit range."))?;
                PortableValue::KvU64(decimal)
            } else {
                PortableValue::BigInt(decimal)
            }
        }
        "Date" => PortableValue::Date {
            epoch_ms: host.source_date_value(value)?,
        },
        "RegExp" => regexp_source(&js_text(value)?)?,
        "Array" => PortableValue::Array(
            value
                .ok_or_else(|| error("Malformed profile Array."))?
                .array_items()?
                .iter()
                .map(|value| from_source_profile_with_host(value, host))
                .collect::<Result<_, _>>()?,
        ),
        "object" => object_value(
            entries(value.ok_or_else(|| error("Malformed profile object."))?)?
                .into_iter()
                .map(|(key, value)| Ok((key, from_source_profile_with_host(&value, host)?)))
                .collect::<Result<_, GatewayError>>()?,
        ),
        "Map" => {
            let mut out = Vec::new();
            for pair in value
                .ok_or_else(|| error("Malformed profile Map."))?
                .array_items()?
            {
                let pair = pair.array_items()?;
                if pair.len() < 2 {
                    return Err(error("Malformed profile Map entry."));
                }
                let key = collection_key(from_source_profile_with_host(&pair[0], host)?);
                let item = from_source_profile_with_host(&pair[1], host)?;
                if let Some((_, old)) = out.iter_mut().find(|(old, _)| same(old, &key)) {
                    *old = item
                } else {
                    out.push((key, item));
                }
            }
            PortableValue::Map(out)
        }
        "Set" => {
            let mut out = Vec::new();
            for item in value
                .ok_or_else(|| error("Malformed profile Set."))?
                .array_items()?
            {
                let item = collection_key(from_source_profile_with_host(&item, host)?);
                if !out.iter().any(|old| same(old, &item)) {
                    out.push(item);
                }
            }
            PortableValue::Set(out)
        }
        "Error" | "EvalError" | "RangeError" | "ReferenceError" | "SyntaxError" | "TypeError"
        | "URIError" => {
            let detail = value
                .ok_or_else(|| error("Malformed profile Error detail."))?
                .object_entries()?;
            let message = field(&detail, "message")
                .map(|value| js_text(Some(value)))
                .transpose()?
                .unwrap_or_default();
            let stack = field(&detail, "stack")
                .map(|value| truthy(value).map(|yes| yes.then_some(value)))
                .transpose()?
                .flatten()
                .map(text)
                .transpose()?;
            let cause = field(&detail, "cause")
                .map(|value| truthy(value).map(|yes| yes.then_some(value)))
                .transpose()?
                .flatten()
                .map(|value| from_source_profile_with_host(value, host))
                .transpose()?
                .map(Box::new);
            match (
                message.try_utf8(),
                stack.as_ref().map(JsString16::try_utf8).transpose(),
            ) {
                (Ok(message), Ok(stack)) => PortableValue::Error {
                    kind,
                    message,
                    stack,
                    cause,
                },
                _ => PortableValue::ErrorUtf16 {
                    kind,
                    message,
                    stack,
                    cause,
                },
            }
        }
        kind if binary_alignment(kind).is_some() => {
            let ascii = js_text(value)?
                .as_units()
                .iter()
                .filter_map(|&unit| u8::try_from(unit).ok().map(char::from))
                .collect::<String>();
            let bytes = decode_base64(&ascii);
            let alignment = binary_alignment(kind).unwrap_or(1);
            if !bytes.len().is_multiple_of(alignment) {
                return Err(error("Profile typed-array backing buffer is misaligned."));
            }
            let byte_length = bytes.len() as u64;
            PortableValue::Binary {
                kind: kind.into(),
                bytes,
                byte_offset: 0,
                byte_length,
            }
        }
        _ => return Err(error(format!("Unsupported profile value type: {kind}"))),
    };
    parsed.validate()?;
    Ok(parsed)
}

/// Full private captures retain negative-zero bits via the source-accepted string form.
/// Ordinary profile APIs keep their existing JSON.stringify-compatible writer unchanged.
pub fn to_source_profile(value: &PortableValue) -> Result<SourceJson, GatewayError> {
    value.validate()?;
    let (kind, data) = match value {
        PortableValue::StringUtf16(value) => ("string", value.to_source_json()?),
        PortableValue::Date { epoch_ms: None } => return tag("Date", None),
        PortableValue::NumberBits(_)
            if value
                .number_value()
                .is_some_and(|n| n == 0.0 && n.is_sign_negative()) =>
        {
            ("number", SourceJson::from_serializable("-0")?)
        }
        PortableValue::Array(values) | PortableValue::Set(values) => (
            if matches!(value, PortableValue::Array(_)) {
                "Array"
            } else {
                "Set"
            },
            array(
                values
                    .iter()
                    .map(to_source_profile)
                    .collect::<Result<_, _>>()?,
            )?,
        ),
        PortableValue::Object(values) => (
            "object",
            object(
                values
                    .iter()
                    .map(|(key, value)| Ok((JsString16::from_utf8(key), to_source_profile(value)?)))
                    .collect::<Result<_, GatewayError>>()?,
            )?,
        ),
        PortableValue::ObjectUtf16(values) => (
            "object",
            object(
                values
                    .iter()
                    .map(|(key, value)| Ok((key.clone(), to_source_profile(value)?)))
                    .collect::<Result<_, GatewayError>>()?,
            )?,
        ),
        PortableValue::Map(values) => (
            "Map",
            array(
                values
                    .iter()
                    .map(|(key, value)| {
                        array(vec![to_source_profile(key)?, to_source_profile(value)?])
                    })
                    .collect::<Result<_, _>>()?,
            )?,
        ),
        PortableValue::RegExpUtf16 { source, flags } => {
            let mut units = vec![47];
            units.extend_from_slice(source.as_units());
            units.push(47);
            units.extend(flags.encode_utf16());
            ("RegExp", JsString16::from_units(units).to_source_json()?)
        }
        PortableValue::Error {
            kind,
            message,
            stack,
            cause,
        } => {
            let mut detail = vec![(
                JsString16::from_utf8("message"),
                SourceJson::from_serializable(message)?,
            )];
            if let Some(stack) = stack {
                detail.push((
                    JsString16::from_utf8("stack"),
                    SourceJson::from_serializable(stack)?,
                ));
            }
            if let Some(cause) = cause {
                detail.push((JsString16::from_utf8("cause"), to_source_profile(cause)?));
            }
            return tag(kind, Some(object(detail)?));
        }
        PortableValue::ErrorUtf16 {
            kind,
            message,
            stack,
            cause,
        } => {
            let mut detail = vec![(JsString16::from_utf8("message"), message.to_source_json()?)];
            if let Some(stack) = stack {
                detail.push((JsString16::from_utf8("stack"), stack.to_source_json()?));
            }
            if let Some(cause) = cause {
                detail.push((JsString16::from_utf8("cause"), to_source_profile(cause)?));
            }
            return tag(kind, Some(object(detail)?));
        }
        _ => return SourceJson::from_serializable(&to_profile(value)?),
    };
    tag(kind, Some(data))
}

pub struct SourceNormalizedEntry {
    pub key: gateway_core::state::RecordKey,
    pub parts: Vec<Value>,
    pub value: PortableValue,
}
pub fn normalize_source_import_line_with_host(
    line: &str,
    host: &dyn SourceDateHost,
) -> Result<Option<SourceNormalizedEntry>, GatewayError> {
    use gateway_core::tuple_key::{BigIntKey, KeyPart, TupleKey};
    if line.trim().is_empty() {
        return Ok(None);
    }
    let input = SourceJson::parse(line)?;
    let fields = input.object_entries()?;
    let input = field(&fields, "key")
        .ok_or_else(|| error("Malformed profile key."))?
        .array_items()?;
    let mut keys = Vec::new();
    let mut parts = Vec::new();
    for part in input {
        let fields = part.object_entries()?;
        let kind = field(&fields, "type")
            .ok_or_else(|| error("Unsupported profile key type."))?
            .deserialize::<String>()?;
        if !["bigint", "boolean", "number", "string", "Uint8Array"].contains(&kind.as_str()) {
            return Err(error("Unsupported profile key type."));
        }
        let value = from_source_profile_with_host(&part, host)?;
        let key = match value {
            PortableValue::String(value) => {
                parts.push(serde_json::json!(value));
                KeyPart::String(value)
            }
            PortableValue::StringUtf16(value) => {
                let key = KeyPart::source_string_utf16(value.as_units());
                let KeyPart::String(ref value) = key else {
                    return Err(error("Unexpected source key TextEncoder representation."));
                };
                parts.push(serde_json::json!(value));
                key
            }
            PortableValue::Boolean(value) => {
                parts.push(serde_json::json!(value));
                KeyPart::Boolean(value)
            }
            PortableValue::NumberBits(_) => {
                let value = value
                    .number_value()
                    .ok_or_else(|| error("Invalid key number."))?;
                parts.push(if value.is_finite(){serde_json::json!(value)}else{serde_json::json!({"type":"number","value":if value.is_nan(){"NaN"}else if value.is_sign_negative(){"-Infinity"}else{"Infinity"}})});
                KeyPart::Number(value)
            }
            PortableValue::BigInt(value) => {
                let (negative, _, magnitude) = normalize_bigint(&value)?;
                parts.push(serde_json::json!({"type":"bigint","value":value}));
                KeyPart::BigInt(BigIntKey::from_signed_magnitude(negative, magnitude)?)
            }
            PortableValue::Binary { kind, bytes, .. } if kind == "Uint8Array" => {
                parts.push(serde_json::json!({"type":"Uint8Array","value":encode_base64(&bytes)}));
                KeyPart::Bytes(bytes)
            }
            _ => return Err(error("Unsupported decoded profile key type.")),
        };
        keys.push(key);
    }
    let key = TupleKey::from_parts(&keys)?;
    key.validate_stored_key()?;
    let value = from_source_profile_with_host(
        field(&fields, "value").ok_or_else(|| error("Missing profile value."))?,
        host,
    )?;
    Ok(Some(SourceNormalizedEntry {
        key: key.to_record_key(),
        parts,
        value,
    }))
}
