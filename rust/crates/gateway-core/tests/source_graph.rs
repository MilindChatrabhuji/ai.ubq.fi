use gateway_core::{
    js_string::JsString16,
    source_graph::{ErrorKind, GraphAtom, GraphNode, SourceGraph, ViewKind},
    source_json::SourceJson,
    state::StoredRecord,
    value::{PortableValue, ValueEncoding},
};
use serde::Serialize;
use serde_json::{Value, json};

fn text(value: &str) -> JsString16 {
    value.into()
}
fn graph(nodes: Vec<GraphNode>) -> SourceGraph {
    SourceGraph {
        root: GraphAtom::Ref(0),
        nodes,
    }
}
fn buffer(bytes: Vec<u8>) -> GraphNode {
    GraphNode::ArrayBuffer { bytes }
}
fn view(kind: ViewKind, buffer_node: u32, byte_offset: u64, byte_length: u64) -> GraphNode {
    GraphNode::View {
        kind,
        buffer_node,
        byte_offset,
        byte_length,
    }
}

#[test]
fn captured_native_aliases_and_cycles_survive_record_restart_with_exact_edges() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/source-graph-native.json")).unwrap();
    assert_eq!(
        fixture["source_sha"],
        "6d4d4790a7c06514b92938ff677dbfd52764461d"
    );
    assert_eq!(fixture["runtime"], "bun@1.4.0");
    assert_eq!(fixture["getter_calls"], 0);
    let rows = fixture["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 7);
    for row in rows {
        let value: SourceGraph = serde_json::from_value(row["graph"].clone()).unwrap();
        value.validate_for_storage().unwrap();
        let mut source_refs = Vec::new();
        collect_refs(&row["source_graph"], "ref", &mut source_refs);
        let mut stored_refs = Vec::new();
        collect_refs(
            &serde_json::to_value(&value).unwrap(),
            "value",
            &mut stored_refs,
        );
        assert_eq!(source_refs, stored_refs, "{}", row["name"]);
        let record =
            StoredRecord::source_graph("source-revision-7", value.clone(), Some(9001)).unwrap();
        assert_eq!(record.value_encoding, ValueEncoding::SourceGraphV1);
        let restarted: StoredRecord =
            serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(restarted.revision, "source-revision-7");
        assert_eq!(restarted.expires_at_ms, Some(9001));
        assert_eq!(restarted.source_graph_value().unwrap(), value);
        assert_eq!(
            value.try_identity_free_tree().unwrap(),
            None,
            "{}",
            row["name"]
        );
        assert!(restarted.json_value().is_err());
        assert!(restarted.portable_value().is_err());
        assert!(restarted.profile_v2_value().is_err());
    }
    assert!(
        fixture["source_refusals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["name"] == "error-cause-undefined" && row["rejectedAt"] == "guard")
    );
}

fn collect_refs(value: &Value, field: &str, refs: &mut Vec<u64>) {
    match value {
        Value::Object(object) => {
            if object.get("type") == Some(&json!("ref")) {
                refs.push(object[field].as_u64().unwrap());
            }
            if field == "value" && object.get("type") == Some(&json!("view")) {
                refs.push(object["buffer_node"].as_u64().unwrap());
            }
            for child in object.values() {
                collect_refs(child, field, refs);
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_refs(child, field, refs);
            }
        }
        _ => {}
    }
}

#[test]
fn updates_keep_one_shared_backing_and_do_not_alias_equal_distinct_buffers() {
    let mut shared = graph(vec![
        GraphNode::Object {
            entries: vec![
                (text("a"), GraphAtom::Ref(1)),
                (text("b"), GraphAtom::Ref(2)),
            ],
        },
        view(ViewKind::Uint8Array, 3, 1, 3),
        view(ViewKind::DataView, 3, 2, 2),
        buffer(vec![0, 1, 2, 3, 4]),
    ]);
    let record = StoredRecord::source_graph("before", shared.clone(), None).unwrap();
    shared = serde_json::from_slice::<StoredRecord>(&serde_json::to_vec(&record).unwrap())
        .unwrap()
        .source_graph_value()
        .unwrap();
    let GraphNode::ArrayBuffer { bytes } = &mut shared.nodes[3] else {
        panic!("backing changed kind");
    };
    bytes[2] = 99;
    let latest = StoredRecord::source_graph("after", shared, Some(456))
        .unwrap()
        .source_graph_value()
        .unwrap();
    assert_eq!(latest.nodes[1], view(ViewKind::Uint8Array, 3, 1, 3));
    assert_eq!(latest.nodes[2], view(ViewKind::DataView, 3, 2, 2));
    assert_eq!(latest.nodes[3], buffer(vec![0, 1, 99, 3, 4]));
    assert_eq!(latest.try_identity_free_tree().unwrap(), None);
    let distinct = graph(vec![
        GraphNode::Object {
            entries: vec![
                (text("a"), GraphAtom::Ref(1)),
                (text("b"), GraphAtom::Ref(2)),
            ],
        },
        buffer(vec![4, 5]),
        buffer(vec![4, 5]),
    ]);
    assert!(distinct.try_identity_free_tree().unwrap().is_some());
    let restarted = StoredRecord::source_graph("distinct", distinct.clone(), None)
        .unwrap()
        .source_graph_value()
        .unwrap();
    assert_eq!(restarted, distinct);
    assert_eq!(restarted.nodes.len(), 3);
}

#[test]
fn a_single_view_tree_keeps_full_backing_coordinates_and_buffer_brand_stays_graph_only() {
    let value = graph(vec![
        view(ViewKind::Uint16Array, 1, 2, 4),
        buffer(vec![8, 7, 6, 5, 4, 3, 2, 1]),
    ]);
    assert_eq!(
        value.try_identity_free_tree().unwrap(),
        Some(PortableValue::Binary {
            kind: "Uint16Array".into(),
            bytes: vec![8, 7, 6, 5, 4, 3, 2, 1],
            byte_offset: 2,
            byte_length: 4,
        })
    );
    let branded = graph(vec![view(ViewKind::Buffer, 1, 0, 3), buffer(vec![1, 2, 3])]);
    branded.validate_for_storage().unwrap();
    assert_eq!(branded.try_identity_free_tree().unwrap(), None);
    for name in [
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float32Array",
        "Float64Array",
        "BigInt64Array",
        "BigUint64Array",
        "DataView",
        "Buffer",
    ] {
        assert_eq!(
            ViewKind::from_source_name(name).unwrap().source_name(),
            name
        );
    }
    assert!(ViewKind::from_source_name("SharedArrayBuffer").is_none());
}

#[test]
fn sparse_named_and_dense_arrays_remain_distinct_without_hole_materialization() {
    for value in [
        graph(vec![GraphNode::Array {
            length: u32::MAX,
            entries: vec![],
        }]),
        graph(vec![GraphNode::Array {
            length: 3,
            entries: vec![(text("1"), GraphAtom::Undefined)],
        }]),
        graph(vec![GraphNode::Array {
            length: 0,
            entries: vec![(text("__proto__"), GraphAtom::Null)],
        }]),
    ] {
        value.validate_for_storage().unwrap();
        assert_eq!(value.try_identity_free_tree().unwrap(), None);
    }
    let dense = graph(vec![GraphNode::Array {
        length: 2,
        entries: vec![
            (text("0"), GraphAtom::Null),
            (text("1"), GraphAtom::Undefined),
        ],
    }]);
    assert_eq!(
        dense.try_identity_free_tree().unwrap(),
        Some(PortableValue::Array(vec![
            PortableValue::Null,
            PortableValue::Undefined
        ]))
    );
}

#[test]
fn malformed_graphs_fail_closed_before_record_encoding() {
    let invalid = [
        SourceGraph {
            root: GraphAtom::Ref(3),
            nodes: vec![],
        },
        SourceGraph {
            root: GraphAtom::Null,
            nodes: vec![buffer(vec![1])],
        },
        graph(vec![GraphNode::Object {
            entries: vec![(text("x"), GraphAtom::Ref(1))],
        }]),
        graph(vec![view(ViewKind::Uint8Array, 0, 0, 0)]),
        graph(vec![
            view(ViewKind::Uint16Array, 1, 1, 2),
            buffer(vec![0; 8]),
        ]),
        graph(vec![
            view(ViewKind::Uint32Array, 1, 0, 2),
            buffer(vec![0; 8]),
        ]),
        graph(vec![
            view(ViewKind::DataView, 1, u64::MAX, 2),
            buffer(vec![0; 8]),
        ]),
        graph(vec![view(ViewKind::Buffer, 1, 7, 2), buffer(vec![0; 8])]),
        graph(vec![GraphNode::Array {
            length: 1,
            entries: vec![(text("1"), GraphAtom::Null)],
        }]),
        graph(vec![GraphNode::Array {
            length: 0,
            entries: vec![(text("length"), GraphAtom::Null)],
        }]),
        graph(vec![GraphNode::Object {
            entries: vec![(text("a"), GraphAtom::Null), (text("0"), GraphAtom::Null)],
        }]),
        graph(vec![GraphNode::Object {
            entries: vec![(text("a"), GraphAtom::Null), (text("a"), GraphAtom::Null)],
        }]),
        graph(vec![GraphNode::Date {
            epoch_ms: Some(i64::MAX),
        }]),
        graph(vec![GraphNode::RegExp {
            source: text("x"),
            flags: "uv".into(),
        }]),
        SourceGraph {
            root: GraphAtom::BigInt("01".into()),
            nodes: vec![],
        },
        SourceGraph {
            root: GraphAtom::NumberBits("not-bits".into()),
            nodes: vec![],
        },
    ];
    for value in invalid {
        assert!(value.validate_for_storage().is_err(), "{value:?}");
        assert!(value.try_identity_free_tree().is_err());
        assert!(StoredRecord::source_graph("invalid", value, None).is_err());
    }
    for node in [
        json!({"type":"function","body":"command"}),
        json!({"type":"object","entries":[],"getter":"side effect"}),
        json!({"type":"error","kind":"Error","message":[],"stack":null,"cause":{"type":"undefined"}}),
        json!({"type":"error","kind":"AggregateError","message":[],"stack":null}),
        json!({"type":"view","kind":"UnknownArray","buffer_node":0,"byte_offset":0,"byte_length":0}),
        json!({"type":"object","entries":[[[65536],{"type":"null"}]]}),
    ] {
        assert!(serde_json::from_value::<GraphNode>(node).is_err());
    }
}

#[test]
fn source_map_and_set_key_uniqueness_uses_same_value_zero() {
    let invalid = [
        GraphNode::Map {
            entries: vec![
                (GraphAtom::number(0.0), GraphAtom::Null),
                (GraphAtom::number(-0.0), GraphAtom::Undefined),
            ],
        },
        GraphNode::Set {
            items: vec![
                GraphAtom::number(f64::NAN),
                GraphAtom::NumberBits("7ff8000000000001".into()),
            ],
        },
        GraphNode::Map {
            entries: vec![
                (GraphAtom::String(text("x")), GraphAtom::Null),
                (GraphAtom::String(text("x")), GraphAtom::Null),
            ],
        },
    ];
    for node in invalid {
        assert!(graph(vec![node]).validate_for_storage().is_err());
    }
    graph(vec![GraphNode::Set {
        items: vec![
            GraphAtom::Null,
            GraphAtom::Undefined,
            GraphAtom::Boolean(false),
            GraphAtom::number(0.0),
            GraphAtom::BigInt("0".into()),
            GraphAtom::String(text("0")),
        ],
    }])
    .validate_for_storage()
    .unwrap();
}

#[test]
fn utf16_graph_fields_survive_storage_and_emit_actual_source_json_strings() {
    let unpaired = JsString16::from_units(vec![0xd83d]);
    let value = graph(vec![GraphNode::Object {
        entries: vec![(unpaired.clone(), GraphAtom::String(unpaired.clone()))],
    }]);
    let record = StoredRecord::source_graph("utf16", value.clone(), None).unwrap();
    assert_eq!(record.source_graph_value().unwrap(), value);
    let Some(PortableValue::ObjectUtf16(entries)) = value.try_identity_free_tree().unwrap() else {
        panic!("identity-free string object was not projected");
    };
    assert_eq!(entries[0].0, unpaired);
    let GraphAtom::String(message) = value
        .nodes
        .iter()
        .find_map(|node| {
            if let GraphNode::Object { entries } = node {
                Some(&entries[0].1)
            } else {
                None
            }
        })
        .unwrap()
    else {
        panic!("not a string");
    };
    #[derive(Serialize)]
    struct Message<'a> {
        message: &'a JsString16,
    }
    let output = SourceJson::from_serializable(&Message { message }).unwrap();
    assert_eq!(output.as_str(), "{\"message\":\"\\ud83d\"}");
    assert!(serde_json::to_value(Message { message }).is_err());
    let old = StoredRecord::json(
        "old",
        json!({"root":{"type":"ref","value":0},"nodes":[]}),
        None,
    );
    assert!(old.json_value().is_ok());
    assert!(old.source_graph_value().is_err());
}

#[test]
fn native_error_and_special_primitive_vocabulary_stays_closed() {
    for name in [
        "Error",
        "EvalError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "TypeError",
        "URIError",
    ] {
        let kind = ErrorKind::from_source_name(name).unwrap();
        assert_eq!(kind.source_name(), name);
        let value = graph(vec![GraphNode::Error {
            kind,
            message: JsString16::from_units(vec![0xdc00]),
            stack: None,
        }]);
        value.validate_for_storage().unwrap();
        assert!(matches!(
            value.try_identity_free_tree().unwrap(),
            Some(PortableValue::ErrorUtf16 { cause: None, .. })
        ));
    }
    assert!(ErrorKind::from_source_name("AggregateError").is_none());
    for number in [-0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let value = SourceGraph {
            root: GraphAtom::number(number),
            nodes: vec![],
        };
        let Some(PortableValue::NumberBits(bits)) = value.try_identity_free_tree().unwrap() else {
            panic!("number lost");
        };
        assert_eq!(bits, format!("{:016x}", number.to_bits()));
    }
}

#[test]
fn large_source_supported_cycle_validation_is_iterative_and_never_expands_to_a_tree() {
    let count = 20_000;
    let nodes = (0..count)
        .map(|index| GraphNode::Array {
            length: 1,
            entries: vec![(text("0"), GraphAtom::Ref((index + 1) % count))],
        })
        .collect();
    let value = graph(nodes);
    value.validate_for_storage().unwrap();
    assert_eq!(value.try_identity_free_tree().unwrap(), None);
}
