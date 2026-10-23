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
#[derive(Clone, Copy)]
pub struct FixtureTime {
    pub origin: i64,
    pub deadline: i64,
}
impl FixtureTime {
    pub fn new(origin: i64) -> Result<Self, GatewayError> {
        let deadline = origin
            .checked_add(300_000)
            .ok_or_else(|| error("Fixture time overflow"))?;
        if origin < 1200 || deadline > gateway_core::identity::MAX_SAFE_INTEGER {
            return Err(error("Fixture time is outside its safe range"));
        }
        Ok(Self { origin, deadline })
    }
    pub fn runtime(self) -> i64 {
        self.origin + 100
    }
    pub fn export(self) -> i64 {
        self.origin + 200
    }
    pub fn check_at(self, now: i64) -> Result<(), GatewayError> {
        if now < self.origin || now >= self.deadline {
            return Err(error("fixture_time_budget_expired"));
        }
        Ok(())
    }
    pub fn check(self) -> Result<(), GatewayError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(error)?
            .as_millis();
        self.check_at(i64::try_from(now).map_err(error)?)
    }
}
fn root_entries(
    graph: &mut SourceGraph,
) -> Result<&mut Vec<(JsString16, GraphAtom)>, GatewayError> {
    let GraphAtom::Ref(root) = graph.root else {
        return Err(error("Fixture metadata root differs"));
    };
    let Some(GraphNode::Object { entries }) = graph.nodes.get_mut(root as usize) else {
        return Err(error("Fixture metadata object differs"));
    };
    Ok(entries)
}
fn replace(
    graph: &mut SourceGraph,
    name: &str,
    expected: GraphAtom,
    next: GraphAtom,
) -> Result<(), GatewayError> {
    let entries = root_entries(graph)?;
    let indices: Vec<_> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, (key, _))| (*key == JsString16::from_utf8(name)).then_some(i))
        .collect();
    if indices.len() != 1 || entries[indices[0]].1 != expected {
        return Err(error("Named fixture metadata baseline differs"));
    }
    entries[indices[0]].1 = next;
    Ok(())
}
fn number(value: i64) -> GraphAtom {
    GraphAtom::number(value as f64)
}
fn string(value: &str) -> GraphAtom {
    GraphAtom::String(JsString16::from_utf8(value))
}
fn graph_value(entry: &NativeEntry) -> Result<SourceGraph, GatewayError> {
    let NativeValue::SourceGraphV1(value) = &entry.value else {
        return Err(error("Named fixture graph encoding differs"));
    };
    graph_transport::from_source_graph(value)
}
fn source(time: FixtureTime) -> Result<NativeCapture, GatewayError> {
    let capture =
        serde_json::from_str(include_str!("../../fixtures/native-source.json")).map_err(error)?;
    rebase(capture, time)
}
fn rebase(mut capture: NativeCapture, time: FixtureTime) -> Result<NativeCapture, GatewayError> {
    if capture.captured_at_ms != 2200 || capture.entries.len() != 10 {
        return Err(error("Original fixture capture differs"));
    }
    let mut policy = graph_value(&capture.entries[0])?;
    let hash = root_entries(&mut policy)?
        .iter()
        .find(|(name, _)| *name == JsString16::from_utf8("hash"))
        .and_then(|(_, value)| {
            if let GraphAtom::String(hash) = value {
                Some(hash.try_utf8())
            } else {
                None
            }
        })
        .ok_or_else(|| error("Original fixture key hash differs"))??;
    let mut expected = vec![
        key(json!(["ubq_ai", "api_keys", "id", "offline-key"])),
        key(json!(["ubq_ai", "api_keys", "hash", hash])),
        gateway_authority::keys::api_window("offline-key", "v3:1000", 2000),
    ];
    for index in 0..4 {
        expected.push(key(json!(["default", "native-graph", index])));
    }
    expected.push(key(json!(["default", "native-counter"])));
    expected.push(key(json!(["default", "native-bytes"])));
    let mut opaque = TupleKey::from_record_key(&key(json!(["default"])))?
        .sort_bytes()
        .to_vec();
    opaque.extend_from_slice(&[2, 255, 254, 0]);
    let expiries = [-1, -1, 10000, 9000, 9000, 9000, 9000, -1, 9000, 9000];
    for (index, entry) in capture.entries.iter_mut().enumerate() {
        let raw = if index == 9 {
            opaque.clone()
        } else {
            TupleKey::from_record_key(&expected[index])?
                .sort_bytes()
                .to_vec()
        };
        if entry.raw_key != raw || entry.expiration_ms != expiries[index] {
            return Err(error("Original fixture key or expiry cohort differs"));
        }
        if entry.expiration_ms != -1 {
            entry.expiration_ms = time.deadline;
        }
    }
    for index in [0, 1] {
        let mut value = graph_value(&capture.entries[index])?;
        for (name, old, next) in [
            ("window_ms", 1000, 300_000),
            ("usage_reset_at_ms", 3000, time.deadline),
            ("usage_limit_requests", 3, 3),
            ("usage_requests", 0, 0),
            ("usage_quota_version", 3, 3),
            ("expires_at_ms", -1, -1),
        ] {
            replace(&mut value, name, number(old), number(next))?;
        }
        replace(
            &mut value,
            "id",
            string("offline-key"),
            string("offline-key"),
        )?;
        replace(
            &mut value,
            "revoked_at_ms",
            GraphAtom::Null,
            GraphAtom::Null,
        )?;
        if index == 0 {
            replace(
                &mut value,
                "created_at_ms",
                number(1000),
                number(time.origin - 1200),
            )?;
        }
        capture.entries[index].value =
            NativeValue::SourceGraphV1(graph_transport::to_source_graph(&value)?);
    }
    let mut window = graph_value(&capture.entries[2])?;
    for (name, old, next) in [
        ("v", 3, 3),
        ("window_start_ms", 2000, time.origin),
        ("window_reset_at_ms", 3000, time.deadline),
        ("updated_at_ms", 2000, time.origin),
        ("committed_requests", 0, 0),
        ("reserved_requests", 0, 0),
    ] {
        replace(&mut window, name, number(old), number(next))?;
    }
    replace(
        &mut window,
        "policy_version",
        string("v3:1000"),
        string("v3:300000"),
    )?;
    capture.entries[2].raw_key = TupleKey::from_record_key(&gateway_authority::keys::api_window(
        "offline-key",
        "v3:300000",
        time.origin,
    ))?
    .sort_bytes()
    .to_vec();
    capture.entries[2].value =
        NativeValue::SourceGraphV1(graph_transport::to_source_graph(&window)?);
    capture.captured_at_ms = time.origin;
    Ok(capture)
}

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
    let time = FixtureTime::new(now_ms)?;
    time.check()?;
    let mut capture = source(time)?;
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
        accounts.push(json!({"account_id":id,"access_token":credentials.access_token.expose(),"refresh_token":credentials.refresh_token.expose(),"updated_at_ms":time.origin,"native_owner":{"codex_home":home.to_str().ok_or_else(||error("Task path is not UTF8"))?,"generation_hash":credentials.generation_hash(),"native_refreshed_at":credentials.native_refreshed_at}}));
    }
    for (record, value, revision, expiration_ms) in [
        (
            codex_source_pool_key(),
            json!({"accounts":accounts,"updated_at_ms":time.origin}),
            "14",
            -1,
        ),
        (
            key(json!(["uos_ai", "debug_routing", "v1"])),
            json!({"scenario":"codex_429","expires_at_ms":time.deadline,"updated_at_ms":time.origin-200}),
            "15",
            time.deadline,
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
    time.check()?;
    Ok(Prepared {
        operation: "inputs_prepared",
        directory: destination
            .to_str()
            .ok_or_else(|| error("Task path is not UTF8"))?
            .into(),
        capture,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn original() -> NativeCapture {
        serde_json::from_str(include_str!("../../fixtures/native-source.json")).unwrap()
    }
    fn at(graph: &mut SourceGraph, name: &str) -> GraphAtom {
        root_entries(graph)
            .unwrap()
            .iter()
            .find(|(key, _)| *key == JsString16::from_utf8(name))
            .unwrap()
            .1
            .clone()
    }
    #[test]
    fn time_window_policy_key_and_expiry_cohorts_are_coherent() {
        let time = FixtureTime::new(1_800_000_000_000).unwrap();
        let old = original();
        let new = source(time).unwrap();
        assert_eq!(new.captured_at_ms, time.origin);
        assert_eq!(new.source_git_sha, old.source_git_sha);
        assert_eq!(new.data_revision, old.data_revision);
        for (index, entry) in new.entries.iter().enumerate() {
            assert_eq!(entry.revision, old.entries[index].revision);
            assert_eq!(
                entry.expiration_ms,
                if [0, 1, 7].contains(&index) {
                    -1
                } else {
                    time.deadline
                }
            );
            if index >= 3 {
                assert!(
                    serde_json::to_string(&entry.value).unwrap()
                        == serde_json::to_string(&old.entries[index].value).unwrap(),
                    "Opaque fixture value changed"
                );
                assert!(
                    entry.raw_key == old.entries[index].raw_key,
                    "Opaque fixture key changed"
                );
            }
        }
        for index in [0, 1] {
            let mut policy = graph_value(&new.entries[index]).unwrap();
            assert_eq!(at(&mut policy, "window_ms"), number(300_000));
            assert_eq!(at(&mut policy, "usage_reset_at_ms"), number(time.deadline));
            assert_eq!(at(&mut policy, "usage_limit_requests"), number(3));
            assert_eq!(at(&mut policy, "usage_quota_version"), number(3));
            assert_eq!(at(&mut policy, "expires_at_ms"), number(-1));
            let mut before = graph_value(&old.entries[index]).unwrap();
            for graph in [&mut policy, &mut before] {
                root_entries(graph).unwrap().retain(|(name, _)| {
                    !["window_ms", "usage_reset_at_ms", "created_at_ms"]
                        .iter()
                        .any(|field| *name == JsString16::from_utf8(field))
                });
            }
            assert!(policy == before, "Unchanged API fixture data changed");
        }
        let mut window = graph_value(&new.entries[2]).unwrap();
        assert_eq!(at(&mut window, "policy_version"), string("v3:300000"));
        assert_eq!(at(&mut window, "window_start_ms"), number(time.origin));
        assert_eq!(at(&mut window, "window_reset_at_ms"), number(time.deadline));
        assert_eq!(at(&mut window, "reserved_requests"), number(0));
        assert_eq!(
            new.entries[2].raw_key,
            TupleKey::from_record_key(&gateway_authority::keys::api_window(
                "offline-key",
                "v3:300000",
                time.origin
            ))
            .unwrap()
            .sort_bytes()
        );
    }
    #[test]
    fn opaque_numbers_dates_identity_and_bytes_are_not_rebased() {
        let time = FixtureTime::new(1_800_000_000_000).unwrap();
        let mut old = original();
        let mut opaque = graph_value(&old.entries[3]).unwrap();
        let index = opaque.nodes.len() as u32;
        root_entries(&mut opaque)
            .unwrap()
            .push((JsString16::from_utf8("opaque_date"), GraphAtom::Ref(index)));
        root_entries(&mut opaque)
            .unwrap()
            .push((JsString16::from_utf8("opaque_number"), number(3000)));
        opaque.nodes.push(GraphNode::Date {
            epoch_ms: Some(9000),
        });
        old.entries[3].value =
            NativeValue::SourceGraphV1(graph_transport::to_source_graph(&opaque).unwrap());
        let before = serde_json::to_string(&old.entries[3].value).unwrap();
        let new = rebase(old, time).unwrap();
        assert!(
            serde_json::to_string(&new.entries[3].value).unwrap() == before,
            "Opaque numbers, dates or graph identity changed"
        );
    }
    #[test]
    fn unexpected_expired_never_key_or_policy_baselines_are_refused() {
        let time = FixtureTime::new(1_800_000_000_000).unwrap();
        for expiry in [0, -1, 8999] {
            let mut old = original();
            old.entries[3].expiration_ms = expiry;
            assert!(rebase(old, time).is_err());
        }
        let mut old = original();
        old.entries[7].expiration_ms = 9000;
        assert!(rebase(old, time).is_err());
        let mut old = original();
        old.entries[2].raw_key.push(0);
        assert!(rebase(old, time).is_err());
        let mut old = original();
        let mut policy = graph_value(&old.entries[0]).unwrap();
        replace(&mut policy, "window_ms", number(1000), number(2000)).unwrap();
        old.entries[0].value =
            NativeValue::SourceGraphV1(graph_transport::to_source_graph(&policy).unwrap());
        assert!(rebase(old, time).is_err());
    }
    #[test]
    fn budget_expires_without_refresh_or_unsafe_time() {
        let time = FixtureTime::new(1_800_000_000_000).unwrap();
        assert!(time.check_at(time.origin).is_ok());
        assert!(time.check_at(time.deadline - 1).is_ok());
        assert!(time.check_at(time.deadline).is_err());
        assert!(time.check_at(time.origin - 1).is_err());
        assert_eq!(time.runtime(), time.origin + 100);
        assert_eq!(time.export(), time.origin + 200);
        assert_eq!(time.deadline - time.origin, 300_000);
        assert!(FixtureTime::new(1199).is_err());
        assert!(FixtureTime::new(i64::MAX).is_err());
        assert!(FixtureTime::new(2200).unwrap().check().is_err());
    }
}
