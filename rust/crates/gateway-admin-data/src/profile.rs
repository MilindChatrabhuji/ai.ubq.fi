//! Profile NDJSON conversion; never loads a VM-specific value codec or executes JavaScript.
use crate::migration::NormalizedEntry;
pub use crate::profile_source::{
    SourceNormalizedEntry, from_source_profile, from_source_profile_with_host,
    normalize_source_import_line_with_host, to_source_profile,
};
use crate::{error, json_number};
use chrono::{DateTime, NaiveDate};
use gateway_core::{
    GatewayError,
    tuple_key::{BigIntKey, KeyPart, TupleKey},
    value::PortableValue,
};
use serde_json::{Value, json};

pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::String(s) => s.clone(),
        Value::Number(v) => v
            .as_f64()
            .map(|n| ryu_js::Buffer::new().format(n).to_owned())
            .unwrap_or_else(|| "NaN".into()),
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
pub fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(v) => v.as_f64().unwrap_or(f64::NAN),
        _ => {
            let text = js_string(value);
            let text = gateway_schema::util::js_trim(&text);
            if text.is_empty() {
                return 0.0;
            }
            match text {
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "NaN" => f64::NAN,
                _ => {
                    let radix = if text.starts_with("0x") || text.starts_with("0X") {
                        Some(16)
                    } else if text.starts_with("0b") || text.starts_with("0B") {
                        Some(2)
                    } else if text.starts_with("0o") || text.starts_with("0O") {
                        Some(8)
                    } else {
                        None
                    };
                    if let Some(radix) = radix {
                        if text.len() == 2 {
                            return f64::NAN;
                        }
                        return text[2..]
                            .chars()
                            .try_fold(0.0, |a, c| {
                                c.to_digit(radix)
                                    .map(|d| a * f64::from(radix) + f64::from(d))
                            })
                            .unwrap_or(f64::NAN);
                    }
                    if text
                        .chars()
                        .any(|c| !c.is_ascii_digit() && !".+-eE".contains(c))
                    {
                        return f64::NAN;
                    }
                    text.parse().unwrap_or(f64::NAN)
                }
            }
        }
    }
}
pub fn normalize_bigint(text: &str) -> Result<(bool, String, Vec<u8>), GatewayError> {
    let text = text.trim();
    let (negative, digits) = if let Some(v) = text.strip_prefix('-') {
        (true, v)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    let (radix, digits) = if digits.starts_with("0x") || digits.starts_with("0X") {
        (16, &digits[2..])
    } else if digits.starts_with("0b") || digits.starts_with("0B") {
        (2, &digits[2..])
    } else if digits.starts_with("0o") || digits.starts_with("0O") {
        (8, &digits[2..])
    } else {
        (10, digits)
    };
    if (negative || text.starts_with('+')) && radix != 10 {
        return Err(error("Signed nondecimal bigint is invalid."));
    }
    if digits.is_empty() && radix != 10 {
        return Err(error("Bigint digits are missing."));
    }
    let mut decimal = vec![0u8];
    let mut magnitude = vec![0u8];
    for c in digits.chars() {
        let digit = c
            .to_digit(radix)
            .ok_or_else(|| error("Invalid bigint digits."))?;
        let mut carry = digit;
        for d in &mut decimal {
            let n = u32::from(*d) * radix + carry;
            *d = (n % 10) as u8;
            carry = n / 10;
        }
        while carry > 0 {
            decimal.push((carry % 10) as u8);
            carry /= 10;
        }
        let mut carry = digit;
        for d in &mut magnitude {
            let n = u32::from(*d) * radix + carry;
            *d = (n % 256) as u8;
            carry = n / 256;
        }
        while carry > 0 {
            magnitude.push((carry % 256) as u8);
            carry /= 256;
        }
    }
    while decimal.len() > 1 && decimal.last() == Some(&0) {
        decimal.pop();
    }
    while magnitude.last() == Some(&0) {
        magnitude.pop();
    }
    let negative = negative && !magnitude.is_empty();
    let mut output = if negative {
        "-".to_owned()
    } else {
        String::new()
    };
    output.extend(decimal.iter().rev().map(|d| (b'0' + d) as char));
    magnitude.reverse();
    Ok((negative, output, magnitude))
}

/// Node Buffer's base64/base64url decoder ignores nonalphabet bytes and trailing orphan bits.
pub fn decode_base64(value: &str) -> Vec<u8> {
    let mut out = vec![];
    let mut bits = 0u32;
    let mut count = 0;
    for b in value.bytes() {
        if b == b'=' {
            break;
        }
        let digit = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(digit);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}
pub fn encode_base64(value: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut bits = 0u32;
    let mut count = 0;
    for b in value {
        bits = (bits << 8) | u32::from(*b);
        count += 8;
        while count >= 6 {
            count -= 6;
            out.push(A[((bits >> count) & 63) as usize] as char);
        }
        bits &= (1 << count) - 1;
    }
    if count > 0 {
        out.push(A[((bits << (6 - count)) & 63) as usize] as char);
    }
    out
}
pub(crate) fn binary_alignment(kind: &str) -> Option<usize> {
    match kind {
        "ArrayBuffer" | "DataView" | "Int8Array" | "Uint8Array" | "Uint8ClampedArray" => Some(1),
        "Int16Array" | "Uint16Array" => Some(2),
        "Int32Array" | "Uint32Array" | "Float32Array" => Some(4),
        "Float64Array" | "BigInt64Array" | "BigUint64Array" => Some(8),
        _ => None,
    }
}

fn date(value: Option<&Value>) -> Result<Option<i64>, GatewayError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !value.is_string() {
        let number = js_number(value);
        return Ok(
            (number.is_finite() && number.abs() <= 8_640_000_000_000_000.0)
                .then_some(number.trunc() as i64),
        );
    }
    let s = value.as_str().unwrap_or("");
    if let Some(epoch) = crate::profile_date::iso_millis(s) {
        return Ok(Some(epoch));
    }
    let iso_year = if s.starts_with('+') || s.starts_with('-') {
        7
    } else {
        4
    };
    if s.get(iso_year..iso_year + 1) == Some("-")
        && s.get(iso_year + 3..iso_year + 4) == Some("-")
        && (!s.contains('T')
            || s.ends_with('Z')
            || s.ends_with('z')
            || s.split('T')
                .nth(1)
                .is_some_and(|v| v.contains('+') || v.contains('-')))
    {
        return Ok(None);
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Ok(Some(d.timestamp_millis()));
    }
    if let Ok(d) = DateTime::parse_from_rfc2822(s) {
        return Ok(Some(d.timestamp_millis()));
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(d
            .and_hms_opt(0, 0, 0)
            .map(|d| d.and_utc().timestamp_millis()));
    }
    if s.is_empty() || s == "Invalid Date" || !s.chars().any(|c| c.is_ascii_digit()) {
        return Ok(None);
    }
    Err(error(
        "Noncanonical Date input requires explicit source-compatible date normalization; no timezone is guessed.",
    ))
}
pub(crate) fn regexp(raw: &str) -> Result<(String, String), GatewayError> {
    let split = raw.rfind('/');
    let flags = split.map(|p| &raw[p + 1..]).unwrap_or(raw);
    let source = if let Some(p) = split {
        raw.get(1..p).unwrap_or("").to_owned()
    } else {
        raw.chars()
            .skip(1)
            .take(raw.chars().count().saturating_sub(2))
            .collect()
    };
    let mut seen = std::collections::BTreeSet::new();
    for flag in flags.chars() {
        if !"dgimsuvy".contains(flag) || !seen.insert(flag) {
            return Err(error("Invalid RegExp flags."));
        }
    }
    if seen.contains(&'u') && seen.contains(&'v') {
        return Err(error("RegExp u and v flags are mutually exclusive."));
    }
    let syntax = regress::Flags {
        icase: seen.contains(&'i'),
        multiline: seen.contains(&'m'),
        dot_all: seen.contains(&'s'),
        unicode: seen.contains(&'u'),
        unicode_sets: seen.contains(&'v'),
        ..Default::default()
    };
    regress::Regex::with_flags(&source, syntax)
        .map_err(|_| error("Invalid ECMAScript RegExp pattern."))?;
    let mut canonical = String::new();
    let mut escaped = false;
    for c in source.chars() {
        match c {
            '/' if !escaped => canonical.push_str("\\/"),
            '\n' => canonical.push_str("\\n"),
            '\r' => canonical.push_str("\\r"),
            '\u{2028}' => canonical.push_str("\\u2028"),
            '\u{2029}' => canonical.push_str("\\u2029"),
            _ => canonical.push(c),
        }
        if c == '\\' {
            escaped = !escaped
        } else {
            escaped = false;
        }
    }
    if canonical.is_empty() {
        canonical = "(?:)".into();
    }
    let flags = "dgimsuvy".chars().filter(|f| seen.contains(f)).collect();
    Ok((canonical, flags))
}
pub(crate) fn same_primitive(a: &PortableValue, b: &PortableValue) -> bool {
    match (a, b) {
        (PortableValue::Undefined, PortableValue::Undefined)
        | (PortableValue::Null, PortableValue::Null) => true,
        (PortableValue::Boolean(a), PortableValue::Boolean(b)) => a == b,
        (PortableValue::String(a), PortableValue::String(b))
        | (PortableValue::BigInt(a), PortableValue::BigInt(b)) => a == b,
        (PortableValue::NumberBits(_), PortableValue::NumberBits(_)) => a
            .number_value()
            .zip(b.number_value())
            .is_some_and(|(a, b)| a == b || (a.is_nan() && b.is_nan())),
        _ => false,
    }
}
pub(crate) fn collection_key(value: PortableValue) -> PortableValue {
    if value.number_value() == Some(0.0) {
        PortableValue::number(0.0)
    } else {
        value
    }
}

/// Exact source Date constructor semantics supplied by the trusted execution realm.
/// Inputs are data, never JavaScript code, a timezone guess or an arbitrary evaluation capability.
pub trait SourceDateHost {
    fn date_value(&self, input: Option<&Value>) -> Result<Option<i64>, GatewayError>;
    /// Raw source Date inputs require a host realm capable of parsing their original JSON.
    fn source_date_value(
        &self,
        input: Option<&gateway_core::source_json::SourceJson>,
    ) -> Result<Option<i64>, GatewayError> {
        let input = input
            .map(|value| {
                value.deserialize::<Value>().map_err(|_| {
                    GatewayError::unavailable(
                        "Raw source Date input requires its source-compatible realm",
                        "source_date_host_missing",
                    )
                })
            })
            .transpose()?;
        self.date_value(input.as_ref())
    }
}
/// Retains the existing deterministic codec for canonical inputs; noncanonical inputs fail closed.
pub struct CanonicalDates;
impl SourceDateHost for CanonicalDates {
    fn date_value(&self, input: Option<&Value>) -> Result<Option<i64>, GatewayError> {
        date(input)
    }
}
pub fn from_profile(input: &Value) -> Result<PortableValue, GatewayError> {
    from_profile_with_host(input, &CanonicalDates)
}

pub fn from_profile_with_host(
    input: &Value,
    host: &dyn SourceDateHost,
) -> Result<PortableValue, GatewayError> {
    let kind = input
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| error("Malformed profile value."))?;
    let value = input.get("value");
    let raw = value.cloned().unwrap_or(Value::Null);
    let parsed = match kind {
        "undefined" => PortableValue::Undefined,
        "null" => PortableValue::Null,
        "boolean" | "string" => value
            .map(PortableValue::from_json)
            .unwrap_or(PortableValue::Undefined),
        "number" => PortableValue::number(value.map(js_number).unwrap_or(f64::NAN)),
        "bigint" | "KvU64" => {
            let text = value.map(js_string).unwrap_or_else(|| "undefined".into());
            let (_, decimal, _) = normalize_bigint(&text)?;
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
            epoch_ms: host.date_value(value)?,
        },
        "RegExp" => {
            let (source, flags) =
                regexp(&value.map(js_string).unwrap_or_else(|| "undefined".into()))?;
            PortableValue::RegExp { source, flags }
        }
        "Array" => PortableValue::Array(
            raw.as_array()
                .ok_or_else(|| error("Malformed profile Array."))?
                .iter()
                .map(|item| from_profile_with_host(item, host))
                .collect::<Result<_, _>>()?,
        ),
        "object" => {
            let fields: Vec<(String, Value)> = match raw {
                Value::Object(v) => v.into_iter().collect(),
                Value::Array(v) => v
                    .into_iter()
                    .enumerate()
                    .map(|(i, v)| (i.to_string(), v))
                    .collect(),
                Value::Null => return Err(error("Malformed profile object.")),
                Value::String(s) => s
                    .chars()
                    .enumerate()
                    .map(|(i, c)| (i.to_string(), json!(c.to_string())))
                    .collect(),
                _ => vec![],
            };
            PortableValue::Object(
                fields
                    .into_iter()
                    .map(|(k, v)| Ok((k, from_profile_with_host(&v, host)?)))
                    .collect::<Result<_, GatewayError>>()?,
            )
        }
        "Map" => {
            let mut entries: Vec<(PortableValue, PortableValue)> = vec![];
            for pair in raw
                .as_array()
                .ok_or_else(|| error("Malformed profile Map."))?
            {
                let pair = pair
                    .as_array()
                    .filter(|v| v.len() >= 2)
                    .ok_or_else(|| error("Malformed profile Map entry."))?;
                let key = collection_key(from_profile_with_host(&pair[0], host)?);
                let item = from_profile_with_host(&pair[1], host)?;
                if let Some(existing) = entries.iter_mut().find(|(k, _)| same_primitive(k, &key)) {
                    existing.1 = item;
                } else {
                    entries.push((key, item));
                }
            }
            PortableValue::Map(entries)
        }
        "Set" => {
            let mut entries = vec![];
            for item in raw
                .as_array()
                .ok_or_else(|| error("Malformed profile Set."))?
            {
                let item = collection_key(from_profile_with_host(item, host)?);
                if !entries.iter().any(|v| same_primitive(v, &item)) {
                    entries.push(item);
                }
            }
            PortableValue::Set(entries)
        }
        "Error" | "EvalError" | "RangeError" | "ReferenceError" | "SyntaxError" | "TypeError"
        | "URIError" => {
            if raw.is_null() {
                return Err(error("Malformed profile Error detail."));
            }
            let message = raw.get("message").map(js_string).unwrap_or_default();
            let stack = raw
                .get("stack")
                .filter(|v| !v.is_null() && **v != false && **v != 0 && **v != "");
            let stack = stack
                .map(|v| {
                    v.as_str().map(str::to_owned).ok_or_else(|| {
                        error("A nonstring Error stack requires source normalization.")
                    })
                })
                .transpose()?;
            let cause = raw
                .get("cause")
                .filter(|v| !v.is_null() && **v != false && **v != 0 && **v != "")
                .map(|item| from_profile_with_host(item, host))
                .transpose()?
                .map(Box::new);
            PortableValue::Error {
                kind: kind.into(),
                message,
                stack,
                cause,
            }
        }
        kind if binary_alignment(kind).is_some() => {
            let bytes = decode_base64(&value.map(js_string).unwrap_or_else(|| "undefined".into()));
            let alignment = binary_alignment(kind).unwrap_or(1);
            if !bytes.len().is_multiple_of(alignment) {
                return Err(error("Profile typed-array backing buffer is misaligned."));
            }
            let length = bytes.len() as u64;
            PortableValue::Binary {
                kind: kind.into(),
                bytes,
                byte_offset: 0,
                byte_length: length,
            }
        }
        _ => return Err(error(format!("Unsupported profile value type: {kind}"))),
    };
    parsed.validate()?;
    Ok(parsed)
}

pub fn to_profile(value: &PortableValue) -> Result<Value, GatewayError> {
    value.validate()?;
    let (kind, data) = match value {
        PortableValue::Undefined => return Ok(json!({"type":"undefined"})),
        PortableValue::Null => ("null", Value::Null),
        PortableValue::Boolean(v) => ("boolean", json!(v)),
        PortableValue::String(v) => ("string", json!(v)),
        PortableValue::NumberBits(_) => {
            let n = value
                .number_value()
                .ok_or_else(|| error("Invalid number bits."))?;
            (
                "number",
                if n.is_finite() {
                    json_number(Some(n))
                } else {
                    json!(if n.is_nan() {
                        "NaN"
                    } else if n.is_sign_negative() {
                        "-Infinity"
                    } else {
                        "Infinity"
                    })
                },
            )
        }
        PortableValue::BigInt(v) => ("bigint", json!(v)),
        PortableValue::KvU64(v) => ("KvU64", json!(v)),
        PortableValue::Binary {
            kind,
            bytes,
            byte_length,
            ..
        } => return Ok(json!({"type":kind,"value":encode_base64(bytes),"byteLength":byte_length})),
        PortableValue::Date { epoch_ms } => {
            ("Date", json!(epoch_ms.map(crate::profile_date::format_iso)))
        }
        PortableValue::RegExp { source, flags } => ("RegExp", json!(format!("/{source}/{flags}"))),
        PortableValue::Array(v) => (
            "Array",
            Value::Array(v.iter().map(to_profile).collect::<Result<_, _>>()?),
        ),
        PortableValue::Set(v) => (
            "Set",
            Value::Array(v.iter().map(to_profile).collect::<Result<_, _>>()?),
        ),
        PortableValue::Object(v) => (
            "object",
            Value::Object(
                v.iter()
                    .map(|(k, v)| Ok((k.clone(), to_profile(v)?)))
                    .collect::<Result<_, GatewayError>>()?,
            ),
        ),
        PortableValue::Map(v) => (
            "Map",
            Value::Array(
                v.iter()
                    .map(|(k, v)| Ok(json!([to_profile(k)?, to_profile(v)?])))
                    .collect::<Result<_, GatewayError>>()?,
            ),
        ),
        PortableValue::StringUtf16(_)
        | PortableValue::ObjectUtf16(_)
        | PortableValue::RegExpUtf16 { .. }
        | PortableValue::ErrorUtf16 { .. } => {
            return Err(error(
                "ProfileV2 strings require the raw source-profile writer; Value cannot preserve them.",
            ));
        }
        PortableValue::Error {
            kind,
            message,
            stack,
            cause,
        } => {
            let mut detail = json!({"message":message});
            if let Some(stack) = stack {
                detail["stack"] = json!(stack);
            }
            if let Some(cause) = cause {
                detail["cause"] = to_profile(cause)?;
            }
            return Ok(json!({"type":kind,"value":detail}));
        }
    };
    Ok(json!({"type":kind,"value":data}))
}

pub fn normalize_import_line(line: &str) -> Result<Option<NormalizedEntry>, GatewayError> {
    normalize_import_line_with_host(line, &CanonicalDates)
}

pub fn normalize_import_line_with_host(
    line: &str,
    host: &dyn SourceDateHost,
) -> Result<Option<NormalizedEntry>, GatewayError> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    let raw: Value =
        serde_json::from_str(line).map_err(|_| error("Malformed profile JSON line."))?;
    let input = raw
        .get("key")
        .and_then(Value::as_array)
        .ok_or_else(|| error("Malformed profile key."))?;
    let mut parts = vec![];
    let mut logical = vec![];
    for part in input {
        if !matches!(
            part["type"].as_str(),
            Some("bigint" | "boolean" | "number" | "string" | "Uint8Array")
        ) {
            return Err(error("Unsupported profile key type."));
        }
        let decoded = from_profile_with_host(part, host)?;
        let key = match decoded {
            PortableValue::String(v) => {
                logical.push(json!(v));
                KeyPart::String(v)
            }
            PortableValue::Boolean(v) => {
                logical.push(json!(v));
                KeyPart::Boolean(v)
            }
            PortableValue::NumberBits(_) => {
                let v = decoded
                    .number_value()
                    .ok_or_else(|| error("Invalid key number."))?;
                logical.push(if v.is_finite(){json!(v)}else{json!({"type":"number","value":if v.is_nan(){"NaN"}else if v.is_sign_negative(){"-Infinity"}else{"Infinity"}})});
                KeyPart::Number(v)
            }
            PortableValue::BigInt(v) => {
                let (negative, _, magnitude) = normalize_bigint(&v)?;
                logical.push(json!({"type":"bigint","value":v}));
                KeyPart::BigInt(BigIntKey::from_signed_magnitude(negative, magnitude)?)
            }
            PortableValue::Binary { kind, bytes, .. } if kind == "Uint8Array" => {
                logical.push(json!({"type":"Uint8Array","value":encode_base64(&bytes)}));
                KeyPart::Bytes(bytes)
            }
            _ => return Err(error("Unsupported decoded profile key type.")),
        };
        parts.push(key);
    }
    let tuple = TupleKey::from_parts(&parts)?;
    tuple.validate_stored_key()?;
    let value = from_profile_with_host(
        raw.get("value")
            .ok_or_else(|| error("Missing profile value."))?,
        host,
    )?;
    Ok(Some(NormalizedEntry {
        key: tuple.to_record_key(),
        parts: logical,
        value,
        raw,
    }))
}
