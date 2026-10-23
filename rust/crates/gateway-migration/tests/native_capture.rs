#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_auth::store::key;
use gateway_core::{query::*, source_graph::GraphNode, state::*, tuple_key::TupleKey};
use gateway_migration::*;
use serde_json::json;
use support::{fixture::*, sqlite_store::*};

fn fixture() -> NativeCapture {
    serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap()
}
fn graph_key(index: i64) -> RecordKey {
    key(json!(["default", "native-graph", index]))
}
struct Tokens(std::sync::atomic::AtomicU64);
impl gateway_authority::TokenSource for Tokens {
    fn next_token(&self) -> Result<String, gateway_core::GatewayError> {
        Ok(format!(
            "native-fixture-{}",
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ))
    }
}
struct Clock;
impl gateway_authority::AuthorityClock for Clock {
    fn now_ms(&self) -> Result<i64, gateway_core::GatewayError> {
        Ok(2300)
    }
}

#[test]
fn source_complete_graphs_share_the_persisted_auth_store_and_latest_inverse() {
    let directory = Directory::new();
    let path = directory.file("one-native-authority.sqlite3");
    let input = fixture();
    let store = SqliteStore::open(&path);
    let receipt = run(adopt_empty(&store, &prepare_native(&input).unwrap())).unwrap();
    assert_eq!(receipt.source_rows, 10);
    drop(store);
    let store = SqliteStore::open(&path);
    let token = format!("u_{}", "1".repeat(64));
    assert_eq!(
        run(gateway_auth::api_keys::authenticate(&store, &token, 2300))
            .unwrap()
            .key_id,
        "offline-key"
    );
    let authority = gateway_authority::Authority::with_clock(
        store.clone(),
        Tokens(std::sync::atomic::AtomicU64::new(1)),
        Clock,
    );
    let admission = run(authority.reserve_api_key(
        &gateway_core::identity::ApiKeyId("offline-key".into()),
        &gateway_core::identity::RequestId("native-post-restart-admission".into()),
        "responses",
        2300,
    ))
    .unwrap();
    assert_eq!(admission.request_id.0, "native-post-restart-admission");
    drop(authority);
    let original = run(store.read(&graph_key(0))).unwrap().unwrap();
    let mut graph = original.source_graph_value().unwrap();
    for node in &mut graph.nodes {
        if let GraphNode::ArrayBuffer { bytes } = node {
            bytes[4] = 99;
        }
    }
    let current =
        StoredRecord::source_graph("post-restart-alias-write", graph.clone(), Some(9500)).unwrap();
    assert_eq!(
        run(store.commit(AtomicTransition {
            checks: vec![RevisionCheck {
                key: graph_key(0),
                expected_revision: Some(original.revision)
            }],
            mutations: vec![
                RecordMutation::Put {
                    key: graph_key(0),
                    record: current
                },
                RecordMutation::Delete { key: graph_key(1) }
            ]
        }))
        .unwrap(),
        CommitOutcome::Committed
    );
    let page = run(store.query(QueryRequest {
        selector: QuerySelector::Prefix {
            prefix: key(json!(["default", "native-graph"])),
            start: None,
            end: None,
        },
        reverse: false,
        limit: 10,
        cursor: None,
        now_ms: 2300,
    }))
    .unwrap();
    assert_eq!(page.entries.len(), 3);
    assert_eq!(page.entries[0].record.source_graph_value().unwrap(), graph);
    drop(store);
    let store = SqliteStore::open(&path);
    assert!(run(export_latest(&store, 2300)).is_err());
    let latest = run(export_native_latest(&store, 2300)).unwrap();
    assert_eq!(latest.entries.len(), input.entries.len());
    assert_eq!(latest.data_revision.version, "51");
    let changed = latest
        .entries
        .iter()
        .find(|e| {
            TupleKey::from_sort_bytes(e.raw_key.clone())
                .unwrap()
                .to_record_key()
                == graph_key(0)
        })
        .unwrap();
    assert_eq!(changed.expiration_ms, 9500);
    assert_eq!(changed.revision.version, "51");
    let NativeValue::SourceGraphV1(value) = &changed.value else {
        panic!("graph encoding erased")
    };
    assert_eq!(graph_transport::from_source_graph(value).unwrap(), graph);
    let opaque = input.entries.last().unwrap();
    let exported = latest
        .entries
        .iter()
        .find(|e| e.raw_key == opaque.raw_key)
        .unwrap();
    assert_eq!(exported.revision, opaque.revision);
    let inverse = SqliteStore::open(&directory.file("new-inverse.sqlite3"));
    run(adopt_empty(&inverse, &prepare_native(&latest).unwrap())).unwrap();
    assert_eq!(
        run(inverse.read(&graph_key(0)))
            .unwrap()
            .unwrap()
            .source_graph_value()
            .unwrap(),
        graph
    );
    assert!(run(inverse.read(&graph_key(1))).unwrap().is_none());
    assert_eq!(
        run(gateway_auth::api_keys::authenticate(&inverse, &token, 2400))
            .unwrap()
            .key_id,
        "offline-key"
    );
}

#[test]
fn source_graph_wire_matches_the_independent_bun_native_corpus() {
    use gateway_core::source_json::SourceJson;
    let corpus = SourceJson::parse(include_str!(
        "../../gateway-core/tests/fixtures/source-graph-native.json"
    ))
    .unwrap();
    let rows = corpus
        .object_entries()
        .unwrap()
        .into_iter()
        .find(|(k, _)| k.try_utf8().unwrap() == "rows")
        .unwrap()
        .1;
    for row in rows.array_items().unwrap() {
        let fields = row.object_entries().unwrap();
        let get = |name: &str| {
            fields
                .iter()
                .find(|(k, _)| k.try_utf8().unwrap() == name)
                .unwrap()
                .1
                .clone()
        };
        let graph = graph_transport::from_source_graph(&get("source_graph")).unwrap();
        assert_eq!(
            graph_transport::from_source_graph(&graph_transport::to_source_graph(&graph).unwrap())
                .unwrap(),
            graph
        );
    }
}

#[test]
fn malformed_raw_keys_graphs_counters_queues_and_business_aliases_are_atomic_refusals() {
    let input = fixture();
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("refuse.sqlite3"));
    let mut invalids = Vec::new();
    let mut candidate = input.clone();
    candidate.entries[0].raw_key = vec![0];
    invalids.push(candidate);
    let mut candidate = input.clone();
    candidate.entries[0].revision.version = "51".into();
    invalids.push(candidate);
    let mut candidate = input.clone();
    candidate.queue_entries = 1;
    invalids.push(candidate);
    let mut candidate = input.clone();
    candidate.entries[0].value = NativeValue::CounterLe64(vec![0; 7]);
    invalids.push(candidate);
    let mut candidate = input.clone();
    candidate.entries[0].value = input.entries[3].value.clone();
    invalids.push(candidate);
    let mut candidate = input.clone();
    candidate.entries[0].raw_key = TupleKey::from_json_parts(
        json!(["uos_ai", "auth", "session_revision_index", "v1", "fake"])
            .as_array()
            .unwrap(),
    )
    .unwrap()
    .sort_bytes()
    .to_vec();
    invalids.push(candidate);
    for candidate in invalids {
        assert!(prepare_native(&candidate).is_err());
    }
    assert!(run(store.read(&graph_key(0))).unwrap().is_none());
    assert_eq!(
        run(adopt_empty(&store, &prepare_native(&input).unwrap()))
            .unwrap()
            .source_rows,
        10
    );
}

#[test]
fn pending_retirement_and_suppressed_mapping_remain_only_in_private_custody() {
    let mut input = fixture();
    let mapping = key(json!(["uos_ai", "codex_live_calls", "v1", "fixture-call"]));
    input.entries.push(NativeEntry{raw_key:TupleKey::from_record_key(&mapping).unwrap().sort_bytes().to_vec(),value:NativeValue::SourceGraphV1(gateway_core::source_json::SourceJson::parse(r#"{"root":{"type":"ref","ref":0},"nodes":[{"type":"object","entries":[["account_id",{"type":"string","value":"fixture-account"}],["principal_id",{"type":"string","value":"fixture-principal"}]]}]}"#).unwrap()),revision:NativeRevision{version:"14".into(),sequence:"0".into()},expiration_ms:3600000});
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("retirement.sqlite3"));
    run(adopt_empty(&store, &prepare_native(&input).unwrap())).unwrap();
    let marker = key(json!([
        "uos_ai",
        "codex_live_calls",
        "v1",
        "pending_retirement",
        "fixture-call"
    ]));
    store.put(marker.clone(),StoredRecord::json("pending-delete",json!({"schema_version":1,"call_id":"fixture-call","upstream_status":410,"created_at_ms":2300}),None));
    assert!(run(export_native_latest(&store, 2400)).is_err());
    let context = ArtifactContext {
        rust_git_sha: "a".repeat(40),
        rust_git_tree: "b".repeat(40),
        wasm_sha256: "c".repeat(64),
        native_sha256: "d".repeat(64),
        native_nonce_capture_sha256: None,
    };
    let bundle = run(export_native_rollback_bundle(&store, 2400, context.clone())).unwrap();
    assert_eq!(bundle.rust_controls.len(), 2);
    assert!(
        !bundle
            .source
            .entries
            .iter()
            .any(|e| e.raw_key == TupleKey::from_record_key(&mapping).unwrap().sort_bytes())
    );
    assert!(bundle.rust_controls.iter().any(|r| r.key == mapping.0));
    assert!(bundle.rust_controls.iter().any(|r| r.key == marker.0));
    prepare_native(&bundle.source).unwrap();
    store.put(marker,StoredRecord::json("bad-marker",json!({"schema_version":1,"call_id":"fixture-call","upstream_status":500,"created_at_ms":2300}),None));
    assert!(run(export_native_rollback_bundle(&store, 2400, context)).is_err());
}
