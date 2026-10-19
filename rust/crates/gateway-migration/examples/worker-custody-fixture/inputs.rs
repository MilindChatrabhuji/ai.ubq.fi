//! Original native-source + native_custody.rs:25-77,145-165 + runtime debug input.
//! Fixed synthetic preparation only; generation hashes come from the actual native parser.
use super::port::error;
use gateway_auth::{
    crypto::base64url, native_credentials::parse_native_document,
    provider_credentials::codex_source_pool_key, store::key,
};
use gateway_core::{
    GatewayError,
    js_string::JsString16,
    source_graph::{GraphAtom, GraphNode, SourceGraph},
    tuple_key::TupleKey,
};
use gateway_migration::{NativeCapture, NativeEntry, NativeRevision, NativeValue, graph_transport};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;
fn graph(value: &Value) -> SourceGraph {
    fn atom(value: &Value, nodes: &mut Vec<GraphNode>) -> GraphAtom {
        match value {
            Value::Null => GraphAtom::Null,
            Value::Bool(v) => GraphAtom::Boolean(*v),
            Value::Number(v) => GraphAtom::number(v.as_f64().unwrap()),
            Value::String(v) => GraphAtom::String(JsString16::from_utf8(v)),
            Value::Array(values) => {
                let id = nodes.len() as u32;
                nodes.push(GraphNode::Object { entries: vec![] });
                let entries = values
                    .iter()
                    .enumerate()
                    .map(|(i, v)| (JsString16::from_utf8(&i.to_string()), atom(v, nodes)))
                    .collect();
                nodes[id as usize] = GraphNode::Array {
                    length: values.len() as u32,
                    entries,
                };
                GraphAtom::Ref(id)
            }
            Value::Object(values) => {
                let id = nodes.len() as u32;
                nodes.push(GraphNode::Object { entries: vec![] });
                let entries = values
                    .iter()
                    .map(|(k, v)| (JsString16::from_utf8(k), atom(v, nodes)))
                    .collect();
                nodes[id as usize] = GraphNode::Object { entries };
                GraphAtom::Ref(id)
            }
        }
    }
    let mut nodes = vec![];
    let root = atom(value, &mut nodes);
    SourceGraph { root, nodes }
}
#[derive(Serialize)]
pub struct Prepared {
    pub operation: &'static str,
    pub directory: String,
    pub capture: NativeCapture,
}
pub fn prepare(directory: &str, now_ms: i64) -> Result<Prepared, GatewayError> {
    if now_ms != 2200 {
        return Err(error("Only the original source fixture clock is supported"));
    }
    let root =
        std::fs::canonicalize("/tmp/ai-rust-wasm-20261018/state-controller-2101").map_err(error)?;
    let destination = Path::new(directory);
    let parent = destination
        .parent()
        .ok_or_else(|| error("Missing task parent"))?;
    let canonical_parent = std::fs::canonicalize(parent).map_err(error)?;
    let lexical_parent = if let Ok(tail) = parent.strip_prefix("/tmp") {
        std::fs::canonicalize("/tmp").map_err(error)?.join(tail)
    } else {
        parent.to_path_buf()
    };
    if destination
        .file_name()
        .is_none_or(|name| name == "." || name == "..")
        || canonical_parent != lexical_parent
        || !canonical_parent.starts_with(&root)
    {
        return Err(error("Preparation target is not a canonical task child"));
    }
    std::fs::create_dir(destination).map_err(error)?;
    let destination = std::fs::canonicalize(destination).map_err(error)?;
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(error)?
        .as_secs()
        + 3600;
    let mut accounts = vec![];
    for id in ["managed-a", "managed-b"] {
        let home = destination.join(id);
        std::fs::create_dir(&home).map_err(error)?;
        let token = format!(
            "e30.{}.synthetic",
            base64url(json!({"exp":expires}).to_string().as_bytes())
        );
        let document = json!({"auth_mode":"chatgpt","tokens":{"account_id":id,"access_token":token,"id_token":token,"refresh_token":format!("synthetic-native-{id}-fixture-refresh")},"last_refresh":"2026-10-19T00:00:00.000000000Z"});
        let credentials = parse_native_document(&document)?;
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(home.join("auth.json"))
            .map_err(error)?;
        file.write_all(&serde_json::to_vec(&document).map_err(error)?)
            .map_err(error)?;
        file.sync_all().map_err(error)?;
        accounts.push(json!({"account_id":id,"access_token":credentials.access_token.expose(),"refresh_token":credentials.refresh_token.expose(),"updated_at_ms":2200,"native_owner":{"codex_home":home.to_str().ok_or_else(||error("Task path is not UTF8"))?,"generation_hash":credentials.generation_hash(),"native_refreshed_at":credentials.native_refreshed_at}}));
    }
    let mut capture: NativeCapture =
        serde_json::from_str(include_str!("../../tests/fixtures/native-source.json"))
            .map_err(error)?;
    for (record, value, revision, expiration_ms) in [
        (
            codex_source_pool_key(),
            json!({"accounts":accounts,"updated_at_ms":2200}),
            "14",
            -1,
        ),
        (
            key(json!(["uos_ai", "debug_routing", "v1"])),
            json!({"scenario":"codex_429","expires_at_ms":5000,"updated_at_ms":2000}),
            "15",
            5000,
        ),
    ] {
        capture.entries.push(NativeEntry {
            raw_key: TupleKey::from_record_key(&record)?.sort_bytes().to_vec(),
            value: NativeValue::SourceGraphV1(graph_transport::to_source_graph(&graph(&value))?),
            revision: NativeRevision {
                version: revision.into(),
                sequence: "0".into(),
            },
            expiration_ms,
        });
    }
    Ok(Prepared {
        operation: "inputs_prepared",
        directory: destination
            .to_str()
            .ok_or_else(|| error("Task path is not UTF8"))?
            .into(),
        capture,
    })
}
