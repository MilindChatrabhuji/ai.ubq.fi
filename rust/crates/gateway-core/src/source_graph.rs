//! Explicit native-source object identity. This is data, never an evaluator.
use crate::{GatewayError, js_string::JsString16, value::PortableValue};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceGraph {
    pub root: GraphAtom,
    pub nodes: Vec<GraphNode>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum GraphAtom {
    Undefined,
    Null,
    Boolean(bool),
    String(#[serde(with = "crate::js_string::units")] JsString16),
    NumberBits(String),
    BigInt(String),
    Ref(u32),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum GraphNode {
    Object {
        #[serde(with = "properties")]
        entries: Vec<(JsString16, GraphAtom)>,
    },
    Array {
        length: u32,
        #[serde(with = "properties")]
        entries: Vec<(JsString16, GraphAtom)>,
    },
    Map {
        entries: Vec<(GraphAtom, GraphAtom)>,
    },
    Set {
        items: Vec<GraphAtom>,
    },
    ArrayBuffer {
        bytes: Vec<u8>,
    },
    View {
        kind: ViewKind,
        buffer_node: u32,
        byte_offset: u64,
        byte_length: u64,
    },
    Date {
        epoch_ms: Option<i64>,
    },
    RegExp {
        #[serde(with = "crate::js_string::units")]
        source: JsString16,
        flags: String,
    },
    Error {
        kind: ErrorKind,
        #[serde(with = "crate::js_string::units")]
        message: JsString16,
        #[serde(with = "crate::js_string::optional_units")]
        stack: Option<JsString16>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ViewKind {
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    DataView,
    Buffer,
}

impl ViewKind {
    pub fn from_source_name(name: &str) -> Option<Self> {
        [
            Self::Int8Array,
            Self::Uint8Array,
            Self::Uint8ClampedArray,
            Self::Int16Array,
            Self::Uint16Array,
            Self::Int32Array,
            Self::Uint32Array,
            Self::Float32Array,
            Self::Float64Array,
            Self::BigInt64Array,
            Self::BigUint64Array,
            Self::DataView,
            Self::Buffer,
        ]
        .into_iter()
        .find(|kind| kind.source_name() == name)
    }
    pub fn source_name(self) -> &'static str {
        self.as_str()
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Int8Array => "Int8Array",
            Self::Uint8Array => "Uint8Array",
            Self::Uint8ClampedArray => "Uint8ClampedArray",
            Self::Int16Array => "Int16Array",
            Self::Uint16Array => "Uint16Array",
            Self::Int32Array => "Int32Array",
            Self::Uint32Array => "Uint32Array",
            Self::Float32Array => "Float32Array",
            Self::Float64Array => "Float64Array",
            Self::BigInt64Array => "BigInt64Array",
            Self::BigUint64Array => "BigUint64Array",
            Self::DataView => "DataView",
            Self::Buffer => "Buffer",
        }
    }
    fn alignment(self) -> u64 {
        match self {
            Self::Int8Array
            | Self::Uint8Array
            | Self::Uint8ClampedArray
            | Self::DataView
            | Self::Buffer => 1,
            Self::Int16Array | Self::Uint16Array => 2,
            Self::Int32Array | Self::Uint32Array | Self::Float32Array => 4,
            Self::Float64Array | Self::BigInt64Array | Self::BigUint64Array => 8,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ErrorKind {
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
}
impl ErrorKind {
    pub fn from_source_name(name: &str) -> Option<Self> {
        [
            Self::Error,
            Self::EvalError,
            Self::RangeError,
            Self::ReferenceError,
            Self::SyntaxError,
            Self::TypeError,
            Self::URIError,
        ]
        .into_iter()
        .find(|kind| kind.source_name() == name)
    }
    pub fn source_name(self) -> &'static str {
        self.as_str()
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "Error",
            Self::EvalError => "EvalError",
            Self::RangeError => "RangeError",
            Self::ReferenceError => "ReferenceError",
            Self::SyntaxError => "SyntaxError",
            Self::TypeError => "TypeError",
            Self::URIError => "URIError",
        }
    }
}

impl GraphAtom {
    pub fn number(value: f64) -> Self {
        Self::NumberBits(format!("{:016x}", value.to_bits()))
    }
    fn validate(&self, nodes: usize) -> Result<(), GatewayError> {
        match self {
            Self::NumberBits(bits) => PortableValue::NumberBits(bits.clone())
                .validate()
                .map_err(|_| invalid()),
            Self::BigInt(value) => PortableValue::BigInt(value.clone())
                .validate()
                .map_err(|_| invalid()),
            Self::Ref(id) if (*id as usize) >= nodes => Err(invalid()),
            _ => Ok(()),
        }
    }
}

impl GraphNode {
    fn atoms(
        &self,
        mut visit: impl FnMut(&GraphAtom) -> Result<(), GatewayError>,
    ) -> Result<(), GatewayError> {
        match self {
            Self::Object { entries } | Self::Array { entries, .. } => {
                for (_, atom) in entries {
                    visit(atom)?;
                }
            }
            Self::Map { entries } => {
                for (key, value) in entries {
                    visit(key)?;
                    visit(value)?;
                }
            }
            Self::Set { items } => {
                for atom in items {
                    visit(atom)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn refs(&self, mut visit: impl FnMut(u32)) {
        let _ = self.atoms(|atom| {
            if let GraphAtom::Ref(id) = atom {
                visit(*id);
            }
            Ok(())
        });
        if let Self::View { buffer_node, .. } = self {
            visit(*buffer_node);
        }
    }
    fn validate(&self, nodes: &[Self]) -> Result<(), GatewayError> {
        self.atoms(|atom| atom.validate(nodes.len()))?;
        match self {
            Self::Object { entries } => validate_properties(entries, None)?,
            Self::Array { length, entries } => validate_properties(entries, Some(*length))?,
            Self::Map { entries } => {
                let mut seen = HashSet::new();
                for (key, _) in entries {
                    if !seen.insert(atom_identity(key)?) {
                        return Err(invalid());
                    }
                }
            }
            Self::Set { items } => {
                let mut seen = HashSet::new();
                for atom in items {
                    if !seen.insert(atom_identity(atom)?) {
                        return Err(invalid());
                    }
                }
            }
            Self::View {
                kind,
                buffer_node,
                byte_offset,
                byte_length,
            } => {
                let Some(Self::ArrayBuffer { bytes }) = nodes.get(*buffer_node as usize) else {
                    return Err(invalid());
                };
                let size = u64::try_from(bytes.len()).map_err(|_| invalid())?;
                if !byte_offset.is_multiple_of(kind.alignment())
                    || !byte_length.is_multiple_of(kind.alignment())
                    || byte_offset
                        .checked_add(*byte_length)
                        .is_none_or(|end| end > size)
                {
                    return Err(invalid());
                }
            }
            Self::Date {
                epoch_ms: Some(value),
            } if value.unsigned_abs() > 8_640_000_000_000_000 => return Err(invalid()),
            Self::RegExp { flags, .. } => {
                PortableValue::RegExp {
                    source: String::new(),
                    flags: flags.clone(),
                }
                .validate()
                .map_err(|_| invalid())?;
            }
            _ => {}
        }
        Ok(())
    }
}

impl SourceGraph {
    /// Checks each node/edge once. Cycles are data and never recursively evaluated.
    pub fn validate_for_storage(&self) -> Result<(), GatewayError> {
        u32::try_from(self.nodes.len()).map_err(|_| invalid())?;
        self.root.validate(self.nodes.len())?;
        for node in &self.nodes {
            node.validate(&self.nodes)?;
        }
        let mut seen = vec![false; self.nodes.len()];
        let mut pending = Vec::new();
        if let GraphAtom::Ref(id) = self.root {
            pending.push(id);
        }
        while let Some(id) = pending.pop() {
            if std::mem::replace(&mut seen[id as usize], true) {
                continue;
            }
            self.nodes[id as usize].refs(|child| pending.push(child));
        }
        if seen.iter().any(|visited| !visited) {
            return Err(invalid());
        }
        Ok(())
    }

    /// A projection is allowed only when it cannot duplicate or erase object identity.
    pub fn try_identity_free_tree(&self) -> Result<Option<PortableValue>, GatewayError> {
        self.validate_for_storage()?;
        let mut references = vec![0usize; self.nodes.len()];
        if let GraphAtom::Ref(id) = self.root {
            references[id as usize] += 1;
        }
        for node in &self.nodes {
            node.refs(|id| references[id as usize] += 1);
        }
        if references.iter().any(|count| *count > 1) {
            return Ok(None);
        }
        let mut values = vec![None; self.nodes.len()];
        let mut pending = Vec::new();
        if let GraphAtom::Ref(id) = self.root {
            pending.push((id as usize, false));
        }
        while let Some((id, ready)) = pending.pop() {
            if ready {
                let Some(value) = tree_node(&self.nodes[id], &mut values) else {
                    return Ok(None);
                };
                values[id] = Some(value);
            } else {
                pending.push((id, true));
                self.nodes[id].refs(|child| pending.push((child as usize, false)));
            }
        }
        Ok(tree_atom(&self.root, &mut values))
    }
}

fn tree_atom(atom: &GraphAtom, values: &mut [Option<PortableValue>]) -> Option<PortableValue> {
    Some(match atom {
        GraphAtom::Undefined => PortableValue::Undefined,
        GraphAtom::Null => PortableValue::Null,
        GraphAtom::Boolean(value) => PortableValue::Boolean(*value),
        GraphAtom::String(value) => PortableValue::StringUtf16(value.clone()),
        GraphAtom::NumberBits(value) => PortableValue::NumberBits(value.clone()),
        GraphAtom::BigInt(value) => PortableValue::BigInt(value.clone()),
        GraphAtom::Ref(id) => values.get_mut(*id as usize)?.take()?,
    })
}

fn tree_node(node: &GraphNode, values: &mut [Option<PortableValue>]) -> Option<PortableValue> {
    Some(match node {
        GraphNode::Object { entries } => PortableValue::ObjectUtf16(
            entries
                .iter()
                .map(|(key, atom)| Some((key.clone(), tree_atom(atom, values)?)))
                .collect::<Option<_>>()?,
        ),
        GraphNode::Array { length, entries } => {
            if entries.len() != *length as usize
                || entries
                    .iter()
                    .enumerate()
                    .any(|(index, (key, _))| array_index(key) != u32::try_from(index).ok())
            {
                return None;
            }
            PortableValue::Array(
                entries
                    .iter()
                    .map(|(_, atom)| tree_atom(atom, values))
                    .collect::<Option<_>>()?,
            )
        }
        GraphNode::Map { entries } => PortableValue::Map(
            entries
                .iter()
                .map(|(key, atom)| Some((tree_atom(key, values)?, tree_atom(atom, values)?)))
                .collect::<Option<_>>()?,
        ),
        GraphNode::Set { items } => PortableValue::Set(
            items
                .iter()
                .map(|atom| tree_atom(atom, values))
                .collect::<Option<_>>()?,
        ),
        GraphNode::ArrayBuffer { bytes } => PortableValue::Binary {
            kind: "ArrayBuffer".into(),
            bytes: bytes.clone(),
            byte_offset: 0,
            byte_length: bytes.len() as u64,
        },
        GraphNode::View {
            kind,
            buffer_node,
            byte_offset,
            byte_length,
        } => {
            if *kind == ViewKind::Buffer {
                return None;
            }
            let PortableValue::Binary {
                kind: backing_kind,
                bytes,
                ..
            } = values.get_mut(*buffer_node as usize)?.take()?
            else {
                return None;
            };
            if backing_kind != "ArrayBuffer" {
                return None;
            }
            PortableValue::Binary {
                kind: kind.as_str().into(),
                bytes,
                byte_offset: *byte_offset,
                byte_length: *byte_length,
            }
        }
        GraphNode::Date { epoch_ms } => PortableValue::Date {
            epoch_ms: *epoch_ms,
        },
        GraphNode::RegExp { source, flags } => PortableValue::RegExpUtf16 {
            source: source.clone(),
            flags: flags.clone(),
        },
        GraphNode::Error {
            kind,
            message,
            stack,
        } => PortableValue::ErrorUtf16 {
            kind: kind.as_str().into(),
            message: message.clone(),
            stack: stack.clone(),
            cause: None,
        },
    })
}

fn array_index(key: &JsString16) -> Option<u32> {
    let units = key.as_units();
    if units.is_empty() || (units.len() > 1 && units[0] == u16::from(b'0')) {
        return None;
    }
    let mut value = 0u32;
    for unit in units {
        if !(48..=57).contains(unit) {
            return None;
        }
        value = value.checked_mul(10)?.checked_add(u32::from(*unit - 48))?;
    }
    (value != u32::MAX).then_some(value)
}

fn validate_properties(
    entries: &[(JsString16, GraphAtom)],
    length: Option<u32>,
) -> Result<(), GatewayError> {
    let mut seen = HashSet::new();
    let mut last_index = None;
    let mut named = false;
    for (key, _) in entries {
        if !seen.insert(key)
            || (length.is_some() && key.as_units() == [108, 101, 110, 103, 116, 104])
        {
            return Err(invalid());
        }
        if let Some(index) = array_index(key) {
            if named
                || last_index.is_some_and(|last| index <= last)
                || length.is_some_and(|len| index >= len)
            {
                return Err(invalid());
            }
            last_index = Some(index);
        } else {
            named = true;
        }
    }
    Ok(())
}

#[derive(Eq, Hash, PartialEq)]
enum AtomIdentity<'a> {
    Undefined,
    Null,
    Boolean(bool),
    String(&'a JsString16),
    Number(u64),
    BigInt(&'a str),
    Ref(u32),
}
fn atom_identity(atom: &GraphAtom) -> Result<AtomIdentity<'_>, GatewayError> {
    Ok(match atom {
        GraphAtom::Undefined => AtomIdentity::Undefined,
        GraphAtom::Null => AtomIdentity::Null,
        GraphAtom::Boolean(value) => AtomIdentity::Boolean(*value),
        GraphAtom::String(value) => AtomIdentity::String(value),
        GraphAtom::BigInt(value) => AtomIdentity::BigInt(value),
        GraphAtom::Ref(id) => AtomIdentity::Ref(*id),
        GraphAtom::NumberBits(bits) => {
            let value = PortableValue::NumberBits(bits.clone())
                .number_value()
                .ok_or_else(invalid)?;
            AtomIdentity::Number(if value == 0.0 {
                0
            } else if value.is_nan() {
                f64::NAN.to_bits()
            } else {
                value.to_bits()
            })
        }
    })
}

fn invalid() -> GatewayError {
    GatewayError::unavailable(
        "The native source graph is malformed or unsupported.",
        "source_graph_invalid",
    )
}

mod properties {
    use super::*;
    use serde::{Deserializer, Serializer};
    pub fn serialize<S: Serializer>(
        values: &[(JsString16, GraphAtom)],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        values
            .iter()
            .map(|(key, value)| (key.as_units(), value))
            .collect::<Vec<_>>()
            .serialize(serializer)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<(JsString16, GraphAtom)>, D::Error> {
        Vec::<(Vec<u16>, GraphAtom)>::deserialize(deserializer).map(|values| {
            values
                .into_iter()
                .map(|(key, value)| (JsString16::from_units(key), value))
                .collect()
        })
    }
}
