use gateway_core::GatewayError;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// ECMAScript WhiteSpace + LineTerminator; differs from Rust Unicode White_Space.
pub fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
}
pub fn invalid(message: impl Into<String>, param: Option<&str>) -> GatewayError {
    let error = GatewayError::new(400, message, Some("invalid_request_error"));
    match param {
        Some(param) => error.with_param(Some(param)),
        None => error,
    }
}
pub fn normalized_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(crate::util::js_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
pub fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
        .then_some(number as i64)
}
pub fn positive_integer(value: Option<&Value>) -> Option<i64> {
    value.and_then(safe_integer).filter(|n| *n > 0)
}
pub fn nonnegative_truncated(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number >= 0.0).then_some(number.trunc() as i64)
}
/// Keep finite integral values outside i64/safe-integer range as JavaScript numbers.
pub fn nonnegative_truncated_value(value: Option<&Value>) -> Option<Value> {
    let number = value?.as_f64()?.trunc();
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    Some(if number <= MAX_SAFE_INTEGER {
        serde_json::json!(number as i64)
    } else {
        serde_json::json!(number)
    })
}
pub fn identifier(record: &Value) -> Option<&str> {
    ["slug", "id", "model", "name"]
        .iter()
        .find_map(|key| record.get(key).and_then(Value::as_str))
}
pub fn is_record(value: &Value) -> bool {
    value.is_object() || value.is_array()
}
fn array_index(key: &str) -> Option<u32> {
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}
/// JavaScript OwnPropertyKeys: integer indices precede insertion-ordered other keys.
pub fn js_keys(value: &Value) -> Vec<String> {
    if let Some(array) = value.as_array() {
        return (0..array.len()).map(|i| i.to_string()).collect();
    }
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    let mut indices: Vec<_> = object
        .keys()
        .filter_map(|k| array_index(k).map(|n| (n, k.clone())))
        .collect();
    indices.sort_by_key(|(n, _)| *n);
    indices
        .into_iter()
        .map(|(_, k)| k)
        .chain(object.keys().filter(|k| array_index(k).is_none()).cloned())
        .collect()
}
pub fn unknown_key(value: &Value, allowed: &[&str]) -> Option<String> {
    js_keys(value)
        .into_iter()
        .find(|key| !allowed.contains(&key.as_str()))
}
/// JSON.stringify-compatible number spelling and JavaScript property enumeration.
pub fn json_stringify(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Object(_) => {
                out.push('{');
                for (i, key) in js_keys(value).iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).expect("string serialization"));
                    out.push(':');
                    write(&value[key], out);
                }
                out.push('}');
            }
            Value::Array(array) => {
                out.push('[');
                for (i, v) in array.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(v, out);
                }
                out.push(']');
            }
            Value::Number(number) => {
                let mut buffer = ryu_js::Buffer::new();
                if let Some(number) = number.as_f64().filter(|n| n.is_finite()) {
                    out.push_str(buffer.format(number));
                } else {
                    out.push_str("null");
                }
            }
            _ => out.push_str(&serde_json::to_string(value).expect("JSON value serialization")),
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn object_with(entries: impl IntoIterator<Item = (String, Value)>) -> Value {
    Value::Object(entries.into_iter().collect::<Map<_, _>>())
}
pub fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}
