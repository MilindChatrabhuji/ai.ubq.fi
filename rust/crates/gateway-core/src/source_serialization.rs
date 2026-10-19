//! Shared JS JSON.stringify semantics lifted from frozen M31 text.rs.
//! Grammar and UTF16 serialization remain SourceJson/JsString16; no I/O or storage codec is added.
use crate::{GatewayError, js_string::JsString16, source_json::SourceJson};
use std::collections::BTreeMap;
fn fail() -> GatewayError {
    GatewayError::unavailable(
        "Invalid source JSON serialization.",
        "source_json_serialization_invalid",
    )
}
fn raw(text: &str) -> Result<SourceJson, GatewayError> {
    SourceJson::parse(text).map_err(|_| fail())
}
pub fn string(value: &SourceJson) -> Option<JsString16> {
    JsString16::from_json_token(value.as_raw()).ok()
}
pub fn array(value: &SourceJson) -> Option<Vec<SourceJson>> {
    value.array_items().ok()
}
pub fn quoted(text: &JsString16) -> Result<SourceJson, GatewayError> {
    SourceJson::from_serializable(text).map_err(|_| fail())
}
fn index(key: &JsString16) -> Option<u32> {
    let s = key.try_utf8().ok()?;
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    s.parse::<u32>().ok().filter(|&v| v < u32::MAX)
}
pub fn entries(value: &SourceJson) -> Option<Vec<(JsString16, SourceJson)>> {
    let mut out: Vec<(JsString16, SourceJson)> = Vec::new();
    let mut known: BTreeMap<JsString16, usize> = BTreeMap::new();
    for (k, v) in value.object_entries().ok()? {
        if let Some(&i) = known.get(&k) {
            out[i].1 = v;
        } else {
            known.insert(k.clone(), out.len());
            out.push((k, v));
        }
    }
    out.sort_by_key(|(key, _)| index(key).map_or((1, 0), |i| (0, i)));
    Some(out)
}
pub fn member(value: &SourceJson, name: &str) -> Option<SourceJson> {
    value
        .object_entries()
        .ok()?
        .into_iter()
        .rev()
        .find(|(k, _)| k.as_units().iter().copied().eq(name.encode_utf16()))
        .map(|(_, v)| v)
}
pub fn object(fields: Vec<(&str, SourceJson)>) -> Result<SourceJson, GatewayError> {
    object_keys(
        fields
            .into_iter()
            .map(|(k, v)| (JsString16::from_utf8(k), v))
            .collect(),
    )
}
pub fn object_keys(fields: Vec<(JsString16, SourceJson)>) -> Result<SourceJson, GatewayError> {
    let mut out = String::from("{");
    for (i, (k, v)) in fields.into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(k.to_source_json().map_err(|_| fail())?.as_str());
        out.push(':');
        out.push_str(v.as_str());
    }
    out.push('}');
    raw(&out)
}
pub fn json_array(values: &[SourceJson]) -> Result<SourceJson, GatewayError> {
    raw(&format!(
        "[{}]",
        values
            .iter()
            .map(SourceJson::as_str)
            .collect::<Vec<_>>()
            .join(",")
    ))
}
pub fn number(value: &SourceJson) -> Option<f64> {
    value.as_str().parse::<f64>().ok()
}
pub fn canonical(value: &SourceJson) -> Result<SourceJson, GatewayError> {
    enum Write {
        Value(SourceJson),
        Bytes(String),
    }
    let mut stack = vec![Write::Value(value.clone())];
    let mut out = String::new();
    while let Some(task) = stack.pop() {
        match task {
            Write::Bytes(s) => out.push_str(&s),
            Write::Value(value) => {
                let s = value.as_str();
                match s.as_bytes().first() {
                    Some(b'{') => {
                        let fields = entries(&value).ok_or_else(fail)?;
                        stack.push(Write::Bytes("}".into()));
                        for (i, (k, v)) in fields.into_iter().enumerate().rev() {
                            stack.push(Write::Value(v));
                            stack.push(Write::Bytes(":".into()));
                            stack.push(Write::Bytes(
                                k.to_source_json().map_err(|_| fail())?.as_str().into(),
                            ));
                            if i > 0 {
                                stack.push(Write::Bytes(",".into()));
                            }
                        }
                        out.push('{');
                    }
                    Some(b'[') => {
                        let values = array(&value).ok_or_else(fail)?;
                        stack.push(Write::Bytes("]".into()));
                        for (i, v) in values.into_iter().enumerate().rev() {
                            stack.push(Write::Value(v));
                            if i > 0 {
                                stack.push(Write::Bytes(",".into()));
                            }
                        }
                        out.push('[');
                    }
                    Some(b'"') => out.push_str(quoted(&string(&value).ok_or_else(fail)?)?.as_str()),
                    _ if matches!(s, "null" | "true" | "false") => out.push_str(s),
                    _ => {
                        let n = number(&value).ok_or_else(fail)?;
                        if !n.is_finite() {
                            out.push_str("null");
                        } else if n == 0.0 {
                            out.push('0');
                        } else {
                            out.push_str(ryu_js::Buffer::new().format(n));
                        }
                    }
                }
            }
        }
    }
    raw(&out)
}
