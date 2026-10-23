//! Fixed synthetic source -> one persisted authority -> latest native inverse.
#[cfg(not(target_arch = "wasm32"))]
mod fixture;
#[cfg(not(target_arch = "wasm32"))]
mod sqlite_store;
#[cfg(not(target_arch = "wasm32"))]
fn main() {
    assert_eq!(
        std::env::args_os().len(),
        1,
        "The fixture accepts no source, credential or target arguments"
    );
    use fixture::{Directory, run};
    use gateway_auth::store::key;
    use gateway_core::{source_graph::GraphNode, state::*};
    use gateway_migration::*;
    use sqlite_store::SqliteStore;
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
    let source: NativeCapture =
        serde_json::from_str(include_str!("../fixtures/native-source.json")).unwrap();
    let directory = Directory::new();
    let path = directory.file("source-candidate.sqlite3");
    let store = SqliteStore::open(&path);
    run(adopt_empty(&store, &prepare_native(&source).unwrap())).unwrap();
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
    run(authority.reserve_api_key(
        &gateway_core::identity::ApiKeyId("offline-key".into()),
        &gateway_core::identity::RequestId("native-post-restart-admission".into()),
        "responses",
        2300,
    ))
    .unwrap();
    drop(authority);
    let key = key(serde_json::json!(["default", "native-graph", 0]));
    let original = run(store.read(&key)).unwrap().unwrap();
    let mut graph = original.source_graph_value().unwrap();
    for node in &mut graph.nodes {
        if let GraphNode::ArrayBuffer { bytes } = node {
            bytes[4] = 99;
        }
    }
    store.put(
        key,
        StoredRecord::source_graph("latest-alias-write", graph, Some(9500)).unwrap(),
    );
    drop(store);
    let store = SqliteStore::open(&path);
    let latest = run(export_native_latest(&store, 2300)).unwrap();
    let inverse = SqliteStore::open(&directory.file("new-inverse.sqlite3"));
    run(adopt_empty(&inverse, &prepare_native(&latest).unwrap())).unwrap();
    println!("{}", serde_json::to_string(&latest).unwrap());
}
#[cfg(target_arch = "wasm32")]
fn main() {}
