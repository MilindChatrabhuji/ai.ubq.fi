//! Source-compatible FoundationDB tuple bytes, shared by every portable storage operation.
//! Matches patched @deno/kv 0.14.0 and src/storage/key-compatibility.ts.

use serde_json::Value;

use crate::{GatewayError, state::RecordKey};

const KEY_PREFIX: &str = "tuple-v1:";
const SIGN_BIT: u64 = 1 << 63;

#[derive(Clone, Debug, PartialEq)]
pub enum KeyPart {
    Bytes(Vec<u8>),
    String(String),
    BigInt(BigIntKey),
    Number(f64),
    Boolean(bool),
}

/// Infallible application-key inputs; number values retain the source JS-number kind.
/// Application-specific safe-integer policies must be checked before constructing a key.
#[derive(Clone, Copy, Debug)]
pub enum ScalarKeyPart<'a> {
    String(&'a str),
    Number(i64),
    Boolean(bool),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BigIntKey {
    negative: bool,
    magnitude: Vec<u8>,
}

impl BigIntKey {
    /// Big-endian absolute magnitude; the source tuple length field is one byte.
    pub fn from_signed_magnitude(negative: bool, magnitude: Vec<u8>) -> Result<Self, GatewayError> {
        let first = magnitude
            .iter()
            .position(|byte| *byte != 0)
            .unwrap_or(magnitude.len());
        let magnitude = magnitude[first..].to_vec();
        if magnitude.len() > u8::MAX as usize {
            return Err(invalid_key(
                "A bigint exceeds the tuple encoding's one-byte length field.",
            ));
        }
        Ok(Self {
            negative: negative && !magnitude.is_empty(),
            magnitude,
        })
    }

    pub fn from_i128(value: i128) -> Self {
        let bytes = value.unsigned_abs().to_be_bytes();
        let first = bytes
            .iter()
            .position(|byte| *byte != 0)
            .unwrap_or(bytes.len());
        Self {
            negative: value < 0,
            magnitude: bytes[first..].to_vec(),
        }
    }
}

/// Identity and comparison both use these exact bytes, never JSON lexical order.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct TupleKey {
    bytes: Vec<u8>,
}

impl TupleKey {
    /// An empty tuple is valid as a selector prefix, but not as a stored key.
    pub fn from_parts(parts: &[KeyPart]) -> Result<Self, GatewayError> {
        let mut bytes = Vec::new();
        for part in parts {
            match part {
                KeyPart::Bytes(value) => append_escaped(&mut bytes, 0x01, value),
                KeyPart::String(value) => append_escaped(&mut bytes, 0x02, value.as_bytes()),
                KeyPart::Boolean(value) => bytes.push(if *value { 0x27 } else { 0x26 }),
                KeyPart::BigInt(value) => append_bigint(&mut bytes, value),
                KeyPart::Number(value) => {
                    if value.is_nan() && value.is_sign_negative() {
                        return Err(invalid_key("Negative NaN tuple keys are not portable."));
                    }
                    append_number(&mut bytes, *value);
                }
            }
        }
        Ok(Self { bytes })
    }

    pub fn from_scalar_parts(parts: &[ScalarKeyPart<'_>]) -> Self {
        let mut bytes = Vec::new();
        for part in parts {
            match part {
                ScalarKeyPart::String(value) => append_escaped(&mut bytes, 0x02, value.as_bytes()),
                ScalarKeyPart::Number(value) => append_number(&mut bytes, *value as f64),
                ScalarKeyPart::Boolean(value) => bytes.push(if *value { 0x27 } else { 0x26 }),
            }
        }
        Self { bytes }
    }

    /// Convenience for existing string/number/boolean key constructors; never coerces null or objects.
    pub fn from_json_parts(parts: &[Value]) -> Result<Self, GatewayError> {
        let parts = parts
            .iter()
            .map(|part| match part {
                Value::String(value) => Ok(KeyPart::String(value.clone())),
                Value::Number(value) => value.as_f64().map(KeyPart::Number).ok_or_else(|| {
                    invalid_key("A JSON key number cannot be represented as a source number.")
                }),
                Value::Bool(value) => Ok(KeyPart::Boolean(*value)),
                _ => Err(invalid_key(
                    "A JSON tuple part must be a string, number, or boolean.",
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Self::from_parts(&parts)
    }

    pub fn from_record_key(key: &RecordKey) -> Result<Self, GatewayError> {
        let encoded = key
            .0
            .strip_prefix(KEY_PREFIX)
            .ok_or_else(|| invalid_key("The portable tuple key codec is unsupported."))?;
        Self::from_sort_bytes(
            decode_hex(encoded)
                .map_err(|()| invalid_key("A tuple key has invalid lowercase hex."))?,
        )
    }

    /// Retains raw accepted bytes, including source-accepted noncanonical payloads.
    pub fn from_sort_bytes(bytes: Vec<u8>) -> Result<Self, GatewayError> {
        validate_source_bytes(&bytes)?;
        Ok(Self { bytes })
    }

    pub fn to_record_key(&self) -> RecordKey {
        RecordKey(format!("{KEY_PREFIX}{}", encode_hex(&self.bytes)))
    }

    pub fn sort_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn validate_stored_key(&self) -> Result<(), GatewayError> {
        if self.bytes.is_empty() {
            Err(invalid_key("A stored tuple key cannot be empty."))
        } else {
            Ok(())
        }
    }

    pub fn is_strict_descendant_of(&self, prefix: &Self) -> bool {
        self.bytes.len() > prefix.bytes.len() && self.bytes.starts_with(&prefix.bytes)
    }
}

fn append_escaped(output: &mut Vec<u8>, tag: u8, value: &[u8]) {
    output.push(tag);
    for byte in value {
        output.push(*byte);
        if *byte == 0 {
            output.push(0xff);
        }
    }
    output.push(0);
}

fn append_number(output: &mut Vec<u8>, value: f64) {
    let bits = if value.is_nan() {
        0x7ff8_0000_0000_0000
    } else {
        value.to_bits()
    };
    let ordered = if bits & SIGN_BIT != 0 {
        !bits
    } else {
        bits ^ SIGN_BIT
    };
    output.push(0x21);
    output.extend_from_slice(&ordered.to_be_bytes());
}

fn append_bigint(output: &mut Vec<u8>, value: &BigIntKey) {
    let length = value.magnitude.len() as u8;
    let tag = if length > 8 {
        if value.negative { 0x0b } else { 0x1d }
    } else if value.negative {
        0x14 - length
    } else {
        0x14 + length
    };
    output.push(tag);
    if length > 8 {
        output.push(if value.negative { !length } else { length });
    }
    output.extend(
        value
            .magnitude
            .iter()
            .map(|byte| if value.negative { !*byte } else { *byte }),
    );
}

/// The source validator accepts bytes/string payloads without Unicode normalization.
/// Do not strengthen it into a second, incompatible migration/key-identity codec.
fn validate_source_bytes(bytes: &[u8]) -> Result<(), GatewayError> {
    let mut offset = 0;
    while offset < bytes.len() {
        let tag = bytes[offset];
        offset += 1;
        match tag {
            0x01 | 0x02 => loop {
                let byte = *bytes
                    .get(offset)
                    .ok_or_else(|| invalid_key("A tuple string/bytes part is truncated."))?;
                offset += 1;
                if byte == 0 {
                    if bytes.get(offset) == Some(&0xff) {
                        offset += 1;
                    } else {
                        break;
                    }
                }
            },
            0x0b..=0x1d => {
                let length = if tag == 0x0b || tag == 0x1d {
                    let length = *bytes
                        .get(offset)
                        .ok_or_else(|| invalid_key("A tuple bigint length is truncated."))?;
                    offset += 1;
                    if tag == 0x0b {
                        usize::from(!length)
                    } else {
                        usize::from(length)
                    }
                } else {
                    tag.abs_diff(0x14) as usize
                };
                offset += length;
            }
            0x21 => {
                let value = bytes
                    .get(offset..offset + 8)
                    .ok_or_else(|| invalid_key("A tuple number is truncated."))?;
                let mut raw = [0; 8];
                raw.copy_from_slice(value);
                let ordered = u64::from_be_bytes(raw);
                let bits = if ordered & SIGN_BIT != 0 {
                    ordered ^ SIGN_BIT
                } else {
                    !ordered
                };
                let value = f64::from_bits(bits);
                if value.is_nan() && value.is_sign_negative() {
                    return Err(invalid_key("Negative NaN tuple keys are not portable."));
                }
                offset += 8;
            }
            0x26 | 0x27 => {}
            _ => return Err(invalid_key("A tuple key contains an unsupported part tag.")),
        }
        if offset > bytes.len() {
            return Err(invalid_key("A tuple key part is truncated."));
        }
    }
    Ok(())
}

pub(crate) fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

pub(crate) fn decode_hex(encoded: &str) -> Result<Vec<u8>, ()> {
    fn digit(byte: u8) -> Result<u8, ()> {
        match byte {
            b'0'..=b'9' => Ok(byte - b'0'),
            b'a'..=b'f' => Ok(byte - b'a' + 10),
            _ => Err(()),
        }
    }
    if !encoded.len().is_multiple_of(2) {
        return Err(());
    }
    encoded
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| Ok(digit(pair[0])? * 16 + digit(pair[1])?))
        .collect()
}

fn invalid_key(message: &str) -> GatewayError {
    GatewayError::new(400, message, Some("invalid_portable_tuple_key"))
}
