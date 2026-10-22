//! Convert current tree state to a fresh identity-free source graph, never guess aliases.
use crate::{GatewayError, invalid};
use gateway_core::{
    js_string::JsString16,
    source_graph::{ErrorKind, GraphAtom, GraphNode, SourceGraph, ViewKind},
    value::PortableValue,
};

fn index(key: &JsString16) -> Option<u32> {
    let key = key.try_utf8().ok()?;
    let value = key.parse::<u32>().ok().filter(|n| *n < u32::MAX)?;
    (value.to_string() == key).then_some(value)
}
fn source_order(entries: &mut [(JsString16, &PortableValue)]) {
    entries.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}
struct Builder {
    nodes: Vec<GraphNode>,
}
impl Builder {
    fn node(&mut self, value: &PortableValue) -> Result<GraphAtom, GatewayError> {
        Ok(match value {
            PortableValue::Undefined => GraphAtom::Undefined,
            PortableValue::Null => GraphAtom::Null,
            PortableValue::Boolean(value) => GraphAtom::Boolean(*value),
            PortableValue::String(value) => GraphAtom::String(JsString16::from_utf8(value)),
            PortableValue::StringUtf16(value) => GraphAtom::String(value.clone()),
            PortableValue::NumberBits(value) => GraphAtom::NumberBits(value.clone()),
            PortableValue::BigInt(value) => GraphAtom::BigInt(value.clone()),
            PortableValue::KvU64(_) => {
                return Err(invalid(
                    "Native counters require their explicit counter capture encoding; a VM graph cannot contain KvU64 class values",
                ));
            }
            _ => {
                let id = u32::try_from(self.nodes.len())
                    .map_err(|_| invalid("Source graph has too many nodes"))?;
                self.nodes.push(GraphNode::Object { entries: vec![] });
                let node = match value {
                    PortableValue::Array(values) => GraphNode::Array {
                        length: u32::try_from(values.len())
                            .map_err(|_| invalid("Source array is too long"))?,
                        entries: values
                            .iter()
                            .enumerate()
                            .map(|(index, value)| {
                                Ok((JsString16::from_utf8(&index.to_string()), self.node(value)?))
                            })
                            .collect::<Result<_, GatewayError>>()?,
                    },
                    PortableValue::Object(values) => {
                        let mut entries = values
                            .iter()
                            .map(|(key, value)| (JsString16::from_utf8(key), value))
                            .collect::<Vec<_>>();
                        source_order(&mut entries);
                        GraphNode::Object {
                            entries: entries
                                .into_iter()
                                .map(|(key, value)| Ok((key, self.node(value)?)))
                                .collect::<Result<_, GatewayError>>()?,
                        }
                    }
                    PortableValue::ObjectUtf16(values) => {
                        let mut entries = values
                            .iter()
                            .map(|(key, value)| (key.clone(), value))
                            .collect::<Vec<_>>();
                        source_order(&mut entries);
                        GraphNode::Object {
                            entries: entries
                                .into_iter()
                                .map(|(key, value)| Ok((key, self.node(value)?)))
                                .collect::<Result<_, GatewayError>>()?,
                        }
                    }
                    PortableValue::Map(values) => GraphNode::Map {
                        entries: values
                            .iter()
                            .map(|(key, value)| Ok((self.node(key)?, self.node(value)?)))
                            .collect::<Result<_, GatewayError>>()?,
                    },
                    PortableValue::Set(values) => GraphNode::Set {
                        items: values
                            .iter()
                            .map(|value| self.node(value))
                            .collect::<Result<_, _>>()?,
                    },
                    PortableValue::Binary {
                        kind,
                        bytes,
                        byte_offset,
                        byte_length,
                    } => {
                        if kind == "ArrayBuffer" {
                            GraphNode::ArrayBuffer {
                                bytes: bytes.clone(),
                            }
                        } else {
                            let buffer_node = u32::try_from(self.nodes.len())
                                .map_err(|_| invalid("Source graph has too many nodes"))?;
                            self.nodes.push(GraphNode::ArrayBuffer {
                                bytes: bytes.clone(),
                            });
                            GraphNode::View {
                                kind: ViewKind::from_source_name(kind)
                                    .ok_or_else(|| invalid("Unsupported source binary kind"))?,
                                buffer_node,
                                byte_offset: *byte_offset,
                                byte_length: *byte_length,
                            }
                        }
                    }
                    PortableValue::Date { epoch_ms } => GraphNode::Date {
                        epoch_ms: *epoch_ms,
                    },
                    PortableValue::RegExp { source, flags } => GraphNode::RegExp {
                        source: JsString16::from_utf8(source),
                        flags: flags.clone(),
                    },
                    PortableValue::RegExpUtf16 { source, flags } => GraphNode::RegExp {
                        source: source.clone(),
                        flags: flags.clone(),
                    },
                    PortableValue::Error {
                        kind,
                        message,
                        stack,
                        ..
                    } => GraphNode::Error {
                        kind: ErrorKind::from_source_name(kind)
                            .ok_or_else(|| invalid("Unsupported source Error kind"))?,
                        message: JsString16::from_utf8(message),
                        stack: stack.as_ref().map(|v| JsString16::from_utf8(v)),
                    },
                    PortableValue::ErrorUtf16 {
                        kind,
                        message,
                        stack,
                        ..
                    } => GraphNode::Error {
                        kind: ErrorKind::from_source_name(kind)
                            .ok_or_else(|| invalid("Unsupported source Error kind"))?,
                        message: message.clone(),
                        stack: stack.clone(),
                    },
                    _ => return Err(invalid("Unsupported current source tree type")),
                };
                self.nodes[id as usize] = node;
                GraphAtom::Ref(id)
            }
        })
    }
}
pub(crate) fn from_tree(value: &PortableValue) -> Result<SourceGraph, GatewayError> {
    value.validate_for_storage_v2()?;
    let mut builder = Builder { nodes: vec![] };
    let root = builder.node(value)?;
    let graph = SourceGraph {
        root,
        nodes: builder.nodes,
    };
    graph.validate_for_storage()?;
    Ok(graph)
}
