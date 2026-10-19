//! Private native-source graph wire. Strings remain validated JSON tokens throughout.
use crate::{GatewayError, SourceJson, invalid};
use gateway_admin_data::profile::{
    decode_base64, encode_base64, from_source_profile, normalize_bigint, to_source_profile,
};
use gateway_core::{
    js_string::JsString16,
    source_graph::{ErrorKind, GraphAtom, GraphNode, SourceGraph, ViewKind},
    value::PortableValue,
};
use std::collections::BTreeMap;

type Fields = BTreeMap<String, SourceJson>;
fn fields(value: &SourceJson, allowed: &[&str]) -> Result<Fields, GatewayError> {
    let mut out = Fields::new();
    for (key, value) in value.object_entries()? {
        let key = key.try_utf8()?;
        if !allowed.contains(&key.as_str()) || out.insert(key, value).is_some() {
            return Err(invalid("Native graph has duplicate or unknown fields"));
        }
    }
    Ok(out)
}
fn get<'a>(fields: &'a Fields, name: &str) -> Result<&'a SourceJson, GatewayError> {
    fields
        .get(name)
        .ok_or_else(|| invalid(format!("Native graph is missing {name}")))
}
fn scalar(value: &SourceJson) -> Result<String, GatewayError> {
    value.deserialize::<String>()
}
fn string(value: &SourceJson) -> Result<JsString16, GatewayError> {
    value.deserialize::<JsString16>()
}
fn object(values: Vec<(&str, SourceJson)>) -> Result<SourceJson, GatewayError> {
    let values = values
        .into_iter()
        .map(|(key, value)| {
            Ok(format!(
                "{}:{}",
                SourceJson::from_serializable(key)?.as_str(),
                value.as_str()
            ))
        })
        .collect::<Result<Vec<_>, GatewayError>>()?;
    SourceJson::parse(&format!("{{{}}}", values.join(",")))
}
fn array(values: Vec<SourceJson>) -> Result<SourceJson, GatewayError> {
    SourceJson::from_serializable(&values)
}
fn source_base64(bytes: &[u8]) -> String {
    let mut text = encode_base64(bytes).replace('-', "+").replace('_', "/");
    while !text.len().is_multiple_of(4) {
        text.push('=');
    }
    text
}
pub(crate) fn decode_source_bytes(value: &SourceJson) -> Result<Vec<u8>, GatewayError> {
    let text = scalar(value)?;
    let bytes = decode_base64(&text);
    if source_base64(&bytes) != text {
        return Err(invalid(
            "Native graph backing bytes are not canonical source base64",
        ));
    }
    Ok(bytes)
}
fn atom(value: &SourceJson) -> Result<GraphAtom, GatewayError> {
    let fields = fields(value, &["type", "value", "ref"])?;
    let kind = scalar(get(&fields, "type")?)?;
    Ok(match kind.as_str() {
        "undefined" if fields.len() == 1 => GraphAtom::Undefined,
        "null" if fields.len() == 2 && get(&fields, "value")?.as_str() == "null" => GraphAtom::Null,
        "boolean" if fields.len() == 2 => GraphAtom::Boolean(get(&fields, "value")?.deserialize()?),
        "string" if fields.len() == 2 => GraphAtom::String(string(get(&fields, "value")?)?),
        "number" if fields.len() == 2 => {
            let value = get(&fields, "value")?;
            let number = if value.as_str().starts_with('"') {
                match scalar(value)?.as_str() {
                    "-0" => -0.0,
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ => return Err(invalid("Native graph number string is not canonical")),
                }
            } else {
                let number = value.deserialize::<f64>()?;
                if !number.is_finite() {
                    return Err(invalid(
                        "Nonfinite source numbers require explicit source strings",
                    ));
                }
                number
            };
            GraphAtom::number(number)
        }
        "bigint" if fields.len() == 2 => {
            let text = scalar(get(&fields, "value")?)?;
            let (_, decimal, _) = normalize_bigint(&text)?;
            if decimal != text {
                return Err(invalid("Native graph bigint is not canonical"));
            }
            GraphAtom::BigInt(decimal)
        }
        "ref" if fields.len() == 2 => GraphAtom::Ref(get(&fields, "ref")?.deserialize()?),
        _ => {
            return Err(invalid(
                "Native graph atom has an unsupported type or payload",
            ));
        }
    })
}
fn properties(value: &SourceJson) -> Result<Vec<(JsString16, GraphAtom)>, GatewayError> {
    value
        .array_items()?
        .into_iter()
        .map(|pair| {
            let pair = pair.array_items()?;
            if pair.len() != 2 {
                return Err(invalid("Native graph property is not a pair"));
            }
            Ok((string(&pair[0])?, atom(&pair[1])?))
        })
        .collect()
}
fn node(value: &SourceJson) -> Result<GraphNode, GatewayError> {
    let all = fields(
        value,
        &[
            "type", "value", "items", "entries", "buffer", "offset", "length",
        ],
    )?;
    let kind = scalar(get(&all, "type")?)?;
    let expected = match kind.as_str() {
        "object" | "Map" => vec!["type", "entries"],
        "Array" => vec!["type", "length", "entries"],
        "Set" => vec!["type", "items"],
        "ArrayBuffer" | "Date" => vec!["type", "value"],
        "RegExp" => vec!["type", "value", "items"],
        other if ViewKind::from_source_name(other).is_some() => {
            vec!["type", "buffer", "offset", "length"]
        }
        other if ErrorKind::from_source_name(other).is_some() => vec!["type", "entries"],
        _ => return Err(invalid("Unsupported native graph node kind")),
    };
    if all.len() != expected.len() || expected.iter().any(|name| !all.contains_key(*name)) {
        return Err(invalid(
            "Native graph node fields do not match its fixed kind",
        ));
    }
    Ok(match kind.as_str() {
        "object" => GraphNode::Object {
            entries: properties(get(&all, "entries")?)?,
        },
        "Array" => GraphNode::Array {
            length: get(&all, "length")?.deserialize()?,
            entries: properties(get(&all, "entries")?)?,
        },
        "Map" => GraphNode::Map {
            entries: get(&all, "entries")?
                .array_items()?
                .into_iter()
                .map(|pair| {
                    let pair = pair.array_items()?;
                    if pair.len() != 2 {
                        return Err(invalid("Native graph Map entry is not a pair"));
                    }
                    Ok((atom(&pair[0])?, atom(&pair[1])?))
                })
                .collect::<Result<_, GatewayError>>()?,
        },
        "Set" => GraphNode::Set {
            items: get(&all, "items")?
                .array_items()?
                .iter()
                .map(atom)
                .collect::<Result<_, _>>()?,
        },
        "ArrayBuffer" => GraphNode::ArrayBuffer {
            bytes: decode_source_bytes(get(&all, "value")?)?,
        },
        "Date" => {
            let value = scalar(get(&all, "value")?)?;
            let epoch_ms = if value == "NaN" {
                None
            } else {
                let millis = value
                    .parse::<i64>()
                    .map_err(|_| invalid("Native graph Date is not a canonical source instant"))?;
                if millis.to_string() != value {
                    return Err(invalid("Native graph Date is not canonical"));
                }
                Some(millis)
            };
            GraphNode::Date { epoch_ms }
        }
        "RegExp" => {
            let source = string(get(&all, "value")?)?;
            let items = get(&all, "items")?.array_items()?;
            if items.len() != 1 {
                return Err(invalid("Native graph RegExp flags are missing"));
            }
            let GraphAtom::String(flags) = atom(&items[0])? else {
                return Err(invalid("Native graph RegExp flags are not strings"));
            };
            let flags = flags.try_utf8()?;
            let value = PortableValue::RegExpUtf16 {
                source: source.clone(),
                flags: flags.clone(),
            };
            from_source_profile(&to_source_profile(&value)?)?;
            GraphNode::RegExp { source, flags }
        }
        other if ViewKind::from_source_name(other).is_some() => {
            let GraphAtom::Ref(buffer_node) = atom(get(&all, "buffer")?)? else {
                return Err(invalid(
                    "Native graph view backing must be a node reference",
                ));
            };
            GraphNode::View {
                kind: ViewKind::from_source_name(other)
                    .ok_or_else(|| invalid("Native view kind is unsupported"))?,
                buffer_node,
                byte_offset: get(&all, "offset")?.deserialize()?,
                byte_length: get(&all, "length")?.deserialize()?,
            }
        }
        other => {
            let entries = properties(get(&all, "entries")?)?;
            if entries.len() != 2
                || entries[0]
                    .0
                    .as_units()
                    .iter()
                    .copied()
                    .ne("message".encode_utf16())
                || entries[1]
                    .0
                    .as_units()
                    .iter()
                    .copied()
                    .ne("stack".encode_utf16())
            {
                return Err(invalid(
                    "Native Error must contain only source-cloned message/stack; cause is forbidden",
                ));
            }
            let GraphAtom::String(message) = &entries[0].1 else {
                return Err(invalid("Native-cloned Error message must be a string"));
            };
            let stack = match &entries[1].1 {
                GraphAtom::Undefined => None,
                GraphAtom::String(value) => Some(value.clone()),
                _ => {
                    return Err(invalid(
                        "Native-cloned Error stack must be a string or undefined",
                    ));
                }
            };
            GraphNode::Error {
                kind: ErrorKind::from_source_name(other)
                    .ok_or_else(|| invalid("Native Error kind is unsupported"))?,
                message: message.clone(),
                stack,
            }
        }
    })
}
pub fn from_source_graph(value: &SourceJson) -> Result<SourceGraph, GatewayError> {
    let fields = fields(value, &["root", "nodes"])?;
    if fields.len() != 2 {
        return Err(invalid("Native source graph is incomplete"));
    }
    let graph = SourceGraph {
        root: atom(get(&fields, "root")?)?,
        nodes: get(&fields, "nodes")?
            .array_items()?
            .iter()
            .map(node)
            .collect::<Result<_, _>>()?,
    };
    graph.validate_for_storage()?;
    Ok(graph)
}
fn atom_wire(value: &GraphAtom) -> Result<SourceJson, GatewayError> {
    let (kind, data) = match value {
        GraphAtom::Undefined => {
            return object(vec![("type", SourceJson::from_serializable("undefined")?)]);
        }
        GraphAtom::Null => ("null", SourceJson::parse("null")?),
        GraphAtom::Boolean(value) => ("boolean", SourceJson::from_serializable(value)?),
        GraphAtom::String(value) => ("string", value.to_source_json()?),
        GraphAtom::BigInt(value) => ("bigint", SourceJson::from_serializable(value)?),
        GraphAtom::Ref(value) => {
            return object(vec![
                ("type", SourceJson::from_serializable("ref")?),
                ("ref", SourceJson::from_serializable(value)?),
            ]);
        }
        GraphAtom::NumberBits(bits) => {
            let number = PortableValue::NumberBits(bits.clone())
                .number_value()
                .ok_or_else(|| invalid("Native graph number bits are invalid"))?;
            let data = if number == 0.0 && number.is_sign_negative() {
                SourceJson::from_serializable("-0")?
            } else if !number.is_finite() {
                SourceJson::from_serializable(if number.is_nan() {
                    "NaN"
                } else if number.is_sign_negative() {
                    "-Infinity"
                } else {
                    "Infinity"
                })?
            } else {
                SourceJson::parse(&gateway_admin_data::profile::js_string(&serde_json::json!(
                    number
                )))?
            };
            ("number", data)
        }
    };
    object(vec![
        ("type", SourceJson::from_serializable(kind)?),
        ("value", data),
    ])
}
fn properties_wire(values: &[(JsString16, GraphAtom)]) -> Result<SourceJson, GatewayError> {
    array(
        values
            .iter()
            .map(|(key, value)| array(vec![key.to_source_json()?, atom_wire(value)?]))
            .collect::<Result<_, _>>()?,
    )
}
fn node_wire(value: &GraphNode) -> Result<SourceJson, GatewayError> {
    let mut out = Vec::new();
    match value {
        GraphNode::Object { entries } => {
            out.push(("type", SourceJson::from_serializable("object")?));
            out.push(("entries", properties_wire(entries)?));
        }
        GraphNode::Array { length, entries } => {
            out.push(("type", SourceJson::from_serializable("Array")?));
            out.push(("length", SourceJson::from_serializable(length)?));
            out.push(("entries", properties_wire(entries)?));
        }
        GraphNode::Map { entries } => {
            out.push(("type", SourceJson::from_serializable("Map")?));
            out.push((
                "entries",
                array(
                    entries
                        .iter()
                        .map(|(key, value)| array(vec![atom_wire(key)?, atom_wire(value)?]))
                        .collect::<Result<_, _>>()?,
                )?,
            ));
        }
        GraphNode::Set { items } => {
            out.push(("type", SourceJson::from_serializable("Set")?));
            out.push((
                "items",
                array(items.iter().map(atom_wire).collect::<Result<_, _>>()?)?,
            ));
        }
        GraphNode::ArrayBuffer { bytes } => {
            out.push(("type", SourceJson::from_serializable("ArrayBuffer")?));
            out.push((
                "value",
                SourceJson::from_serializable(&source_base64(bytes))?,
            ));
        }
        GraphNode::View {
            kind,
            buffer_node,
            byte_offset,
            byte_length,
        } => {
            out.push(("type", SourceJson::from_serializable(kind.source_name())?));
            out.push(("buffer", atom_wire(&GraphAtom::Ref(*buffer_node))?));
            out.push(("offset", SourceJson::from_serializable(byte_offset)?));
            out.push(("length", SourceJson::from_serializable(byte_length)?));
        }
        GraphNode::Date { epoch_ms } => {
            out.push(("type", SourceJson::from_serializable("Date")?));
            out.push((
                "value",
                SourceJson::from_serializable(
                    &epoch_ms.map(|v| v.to_string()).unwrap_or("NaN".into()),
                )?,
            ));
        }
        GraphNode::RegExp { source, flags } => {
            out.push(("type", SourceJson::from_serializable("RegExp")?));
            out.push(("value", source.to_source_json()?));
            out.push((
                "items",
                array(vec![atom_wire(&GraphAtom::String(JsString16::from_utf8(
                    flags,
                )))?])?,
            ));
        }
        GraphNode::Error {
            kind,
            message,
            stack,
        } => {
            out.push(("type", SourceJson::from_serializable(kind.source_name())?));
            out.push((
                "entries",
                properties_wire(&[
                    (
                        JsString16::from_utf8("message"),
                        GraphAtom::String(message.clone()),
                    ),
                    (
                        JsString16::from_utf8("stack"),
                        stack
                            .clone()
                            .map(GraphAtom::String)
                            .unwrap_or(GraphAtom::Undefined),
                    ),
                ])?,
            ));
        }
    }
    object(out)
}
pub fn to_source_graph(value: &SourceGraph) -> Result<SourceJson, GatewayError> {
    value.validate_for_storage()?;
    object(vec![
        ("root", atom_wire(&value.root)?),
        (
            "nodes",
            array(
                value
                    .nodes
                    .iter()
                    .map(node_wire)
                    .collect::<Result<_, _>>()?,
            )?,
        ),
    ])
}
