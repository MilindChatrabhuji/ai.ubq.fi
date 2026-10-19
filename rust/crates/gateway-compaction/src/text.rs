//! Source String/JSON operations: UTF16 units, JS property order and Number serialization.
use crate::{CompactionFailure, FailureKind};
use gateway_core::{js_string::JsString16, source_json::SourceJson};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{collections::BTreeMap, ops::Deref, rc::Rc};

#[derive(Clone, Default, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct Text(Rc<JsString16>);
impl Text {
    pub fn new(units: Vec<u16>) -> Self {
        Self(Rc::new(JsString16::from_units(units)))
    }
    pub fn len(&self) -> usize {
        self.as_units().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn slice(&self, start: usize, end: usize) -> Self {
        Self::new(
            self.as_units()[start.min(self.len())..end.min(self.len()).max(start.min(self.len()))]
                .to_vec(),
        )
    }
    pub fn blank(&self) -> bool {
        self.as_units().iter().all(|&u| whitespace(u))
    }
    pub fn trimmed(&self) -> Self {
        let lo = self
            .as_units()
            .iter()
            .position(|&u| !whitespace(u))
            .unwrap_or(self.len());
        let hi = self
            .as_units()
            .iter()
            .rposition(|&u| !whitespace(u))
            .map_or(lo, |i| i + 1);
        self.slice(lo, hi)
    }
    pub fn contains(&self, needle: &str) -> bool {
        let n = needle.encode_utf16().collect::<Vec<_>>();
        n.is_empty() || self.as_units().windows(n.len()).any(|s| s == n)
    }
    pub fn core(&self) -> JsString16 {
        self.0.as_ref().clone()
    }
}
impl Deref for Text {
    type Target = JsString16;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl From<&str> for Text {
    fn from(s: &str) -> Self {
        Self(Rc::new(JsString16::from_utf8(s)))
    }
}
impl From<String> for Text {
    fn from(s: String) -> Self {
        Self::from(s.as_str())
    }
}
impl From<JsString16> for Text {
    fn from(s: JsString16) -> Self {
        Self(Rc::new(s))
    }
}
impl Serialize for Text {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(s)
    }
}
impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        JsString16::deserialize(d).map(Self::from)
    }
}
pub(crate) trait Part {
    fn append(&self, out: &mut Vec<u16>);
}
impl Part for Text {
    fn append(&self, out: &mut Vec<u16>) {
        out.extend_from_slice(self.as_units());
    }
}
impl Part for str {
    fn append(&self, out: &mut Vec<u16>) {
        out.extend(self.encode_utf16());
    }
}
impl Part for String {
    fn append(&self, out: &mut Vec<u16>) {
        self.as_str().append(out);
    }
}
impl<T: Part + ?Sized> Part for &T {
    fn append(&self, out: &mut Vec<u16>) {
        (*self).append(out);
    }
}
macro_rules! numbers {($($t:ty),*)=>{$(impl Part for $t {fn append(&self,out:&mut Vec<u16>){self.to_string().append(out);}})*};}
numbers!(usize, u64, u32, i64, i32);
macro_rules! text {($($s:expr),*$(,)?)=>{{let mut units=Vec::new();$(crate::text::Part::append(&$s,&mut units);)*crate::text::Text::new(units)}};}
pub(crate) use text;
pub fn whitespace(u: u16) -> bool {
    matches!(u,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
pub fn join(values: &[Text], separator: &str) -> Text {
    let mut out = Vec::new();
    for (i, s) in values.iter().enumerate() {
        if i > 0 {
            separator.append(&mut out);
        }
        s.append(&mut out);
    }
    Text::new(out)
}
pub fn collapsed(text: &Text) -> Text {
    let mut out = Vec::new();
    let mut pending = false;
    for &u in text.as_units() {
        if whitespace(u) {
            pending = true;
        } else {
            if pending {
                out.push(32);
            }
            pending = false;
            out.push(u);
        }
    }
    if pending {
        out.push(32);
    }
    Text::new(out)
}
pub fn fail() -> CompactionFailure {
    CompactionFailure::new(FailureKind::RenderFailed, "invalid source JSON")
}
pub fn raw(text: &str) -> Result<SourceJson, CompactionFailure> {
    SourceJson::parse(text).map_err(|_| fail())
}
pub fn string(value: &SourceJson) -> Option<Text> {
    JsString16::from_json_token(value.as_raw())
        .ok()
        .map(Text::from)
}
pub fn str_or_empty(value: Option<&SourceJson>) -> Text {
    value.and_then(string).unwrap_or_default()
}
pub fn is_object(value: &SourceJson) -> bool {
    value.as_str().starts_with('{')
}
pub fn array(value: &SourceJson) -> Option<Vec<SourceJson>> {
    value.array_items().ok()
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
pub fn quoted(text: &Text) -> Result<SourceJson, CompactionFailure> {
    SourceJson::from_serializable(text).map_err(|_| fail())
}
pub fn object(fields: Vec<(&str, SourceJson)>) -> Result<SourceJson, CompactionFailure> {
    object_keys(
        fields
            .into_iter()
            .map(|(k, v)| (JsString16::from_utf8(k), v))
            .collect(),
    )
}
pub fn object_keys(fields: Vec<(JsString16, SourceJson)>) -> Result<SourceJson, CompactionFailure> {
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
pub fn json_array(values: &[SourceJson]) -> Result<SourceJson, CompactionFailure> {
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
pub fn canonical(value: &SourceJson) -> Result<SourceJson, CompactionFailure> {
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
/// JSON text held in a JS string may contain literal lone surrogates inside string tokens.
pub fn parse_text(text: &Text) -> Option<SourceJson> {
    let mut out = String::new();
    let mut inside = false;
    let mut escaped = false;
    let mut i = 0;
    let units = text.as_units();
    while i < units.len() {
        let u = units[i];
        if (0xd800..=0xdbff).contains(&u)
            && units
                .get(i + 1)
                .is_some_and(|v| (0xdc00..=0xdfff).contains(v))
        {
            let scalar =
                0x10000 + ((u32::from(u) - 0xd800) << 10) + (u32::from(units[i + 1]) - 0xdc00);
            out.push(char::from_u32(scalar)?);
            i += 2;
            escaped = false;
            continue;
        }
        if (0xd800..=0xdfff).contains(&u) {
            if !inside || escaped {
                return None;
            }
            out.push_str(&format!("\\u{u:04x}"));
        } else {
            let c = char::from_u32(u32::from(u))?;
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' && inside {
                escaped = true;
            } else if c == '"' {
                inside = !inside;
            }
        }
        i += 1;
    }
    raw(&out).ok().and_then(|v| canonical(&v).ok())
}
