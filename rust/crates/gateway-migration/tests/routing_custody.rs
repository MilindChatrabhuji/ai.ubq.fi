#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_admin_data::profile::{CanonicalDates, to_source_profile};
use gateway_core::{
    GatewayError,
    query::*,
    state::*,
    tuple_key::{DecodedKeyPart, TupleKey},
    value::PortableValue,
};
use gateway_migration::*;
use serde_json::{Value, json};
use std::path::Path;
use support::{fixture::*, sqlite_store::*};

const NOW: i64 = 1_800_000_000_002;
const WRITER_SHA: &str = "9cf5f956995d832489fd694ebed17ab2f57712ea";

#[derive(Clone, serde::Deserialize)]
struct FixtureRow {
    key: String,
    record: StoredRecord,
}

fn fixtures() -> Vec<Value> {
    let document: Value =
        serde_json::from_str(include_str!("fixtures/routing-writer-custody.json")).unwrap();
    assert_eq!(document["source_sha"], WRITER_SHA);
    assert_eq!(document["exit"], 0);
    assert_eq!(document["passed"], 5);
    assert_eq!(
        document["log_sha256"],
        "c3f5321c806e46116e6e25d7d6b4d9dcd9822163a481c9eea32e2aaf05a942c9"
    );
    let cases = document["fixtures"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 4);
    cases
}
fn rows(case: &Value) -> Vec<FixtureRow> {
    serde_json::from_value(case["rows"].clone()).unwrap()
}
fn capture() -> PrivateCapture {
    PrivateCapture {
        v: 1,
        source_git_sha: WRITER_SHA.into(),
        captured_at_ms: NOW - 2,
        entries: Vec::new(),
    }
}
fn artifacts() -> ArtifactContext {
    ArtifactContext {
        rust_git_sha: "a".repeat(40),
        rust_git_tree: "b".repeat(40),
        wasm_sha256: "c".repeat(64),
        native_sha256: "d".repeat(64),
        native_nonce_capture_sha256: None,
    }
}
fn store(path: &Path, rows: &[FixtureRow]) -> SqliteStore {
    let store = SqliteStore::open(path);
    run(adopt_empty(
        &store,
        &prepare(&capture(), &CanonicalDates).unwrap(),
    ))
    .unwrap();
    for row in rows {
        store.put(RecordKey(row.key.clone()), row.record.clone());
    }
    store
}
fn query() -> QueryRequest {
    QueryRequest {
        selector: QuerySelector::Prefix {
            prefix: TupleKey::from_parts(&[]).unwrap().to_record_key(),
            start: None,
            end: None,
        },
        reverse: false,
        limit: 256,
        cursor: None,
        now_ms: 0,
    }
}
fn snapshot(store: &SqliteStore, path: &Path) -> (Vec<QueryEntry>, Vec<Vec<u8>>) {
    let page = run(store.query(query())).unwrap();
    assert!(page.next_cursor.is_none());
    // SHM contains SQLite reader locks, not durable row data. Compare both the
    // main database and WAL, so a hidden write cannot pass a logical-only check.
    let wal = format!("{}-wal", path.display());
    let bytes = vec![
        std::fs::read(path).unwrap(),
        if Path::new(&wal).exists() {
            std::fs::read(wal).unwrap()
        } else {
            Vec::new()
        },
    ];
    (page.entries, bytes)
}
fn assert_refusal(rows: &[FixtureRow], label: &str) {
    let directory = Directory::new();
    let path = directory.file("invalid-custody.sqlite3");
    drop(store(&path, rows));
    let store = SqliteStore::open(&path);
    let before = snapshot(&store, &path);
    assert!(
        run(export_rollback_bundle(&store, NOW, artifacts())).is_err(),
        "{label}"
    );
    assert_eq!(snapshot(&store, &path), before, "{label}");
}

#[test]
fn actual_writer_v1_v2_pairs_and_finished_rows_survive_restart_and_latest_inverse() {
    for case in fixtures() {
        let directory = Directory::new();
        let path = directory.file("actual-writer.sqlite3");
        let rows = rows(&case);
        drop(store(&path, &rows));
        let store = SqliteStore::open(&path);
        let before = snapshot(&store, &path);
        let bundle = run(export_rollback_bundle(&store, NOW, artifacts())).unwrap();
        assert!(bundle.source.entries.is_empty());
        assert_eq!(
            serde_json::to_value(&bundle.rust_controls).unwrap(),
            case["rows"]
        );
        for row in &rows {
            assert_eq!(
                run(store.read(&RecordKey(row.key.clone()))).unwrap(),
                Some(row.record.clone())
            );
        }
        assert!(run(export_latest(&store, NOW)).is_err());
        assert_eq!(snapshot(&store, &path), before);
    }
}

#[test]
fn malformed_or_unpaired_actual_journals_refuse_without_changing_sqlite_or_wal() {
    for case in fixtures() {
        let original = rows(&case);
        let session = original
            .iter()
            .position(|row| row.record.value.get("context").is_some())
            .unwrap();
        if case["phase"] == "finished" {
            let mut invalid = original.clone();
            invalid[session].record.expires_at_ms = Some(NOW + 1);
            assert_refusal(&invalid, "finished expiry cannot be renewed");
            let unfinished = fixtures()
                .into_iter()
                .find(|other| other["v"] == case["v"] && other["phase"].is_null())
                .unwrap();
            invalid = original.clone();
            invalid.push(rows(&unfinished).remove(0));
            assert_refusal(&invalid, "finished session cannot retain pending marker");
        } else {
            let mut invalid = original.clone();
            invalid.remove(session);
            assert_refusal(&invalid, "orphan pending marker");
            invalid = original.clone();
            invalid.retain(|row| row.record.value.get("context").is_some());
            assert_refusal(&invalid, "unfinished session needs pending marker");
            invalid = original.clone();
            invalid[0].record.revision.push_str("-wrong");
            assert_refusal(&invalid, "pending revision must couple to session");
            invalid = original.clone();
            invalid[0].record.expires_at_ms = Some(NOW + 1);
            assert_refusal(&invalid, "pending marker cannot acquire TTL");
            invalid = original.clone();
            invalid[0].record.value["unknown"] = json!(true);
            assert_refusal(&invalid, "unknown pending field");
            invalid = original.clone();
            invalid[session]
                .record
                .value
                .as_object_mut()
                .unwrap()
                .remove("api");
            assert_refusal(&invalid, "partial session cannot default missing field");
        }
        for parts in [
            json!(["uos_ai", "routing_runtime"]),
            json!(["uos_ai", "routing_runtime", "v1"]),
            json!([
                "uos_ai",
                "routing_runtime",
                "v1",
                "unknown",
                "custody-request"
            ]),
        ] {
            let mut invalid = original.clone();
            invalid.push(FixtureRow {
                key: gateway_auth::store::key(parts).0,
                record: original[session].record.clone(),
            });
            assert_refusal(&invalid, "complete prefix includes malformed exact keys");
        }
        let mut invalid = original.clone();
        invalid[session].record.value["context"]["request_id"] = json!("different-request");
        assert_refusal(&invalid, "session key and request identity must match");
        invalid = original.clone();
        if case["v"] == 2 {
            invalid[session]
                .record
                .value
                .as_object_mut()
                .unwrap()
                .remove("local_work");
            assert_refusal(&invalid, "v2 cannot omit local work");
            invalid = original.clone();
            invalid[session].record.value["local_work"]["unknown"] = json!(true);
            assert_refusal(&invalid, "unknown v2 local work field");
            invalid = original.clone();
            invalid[session].record.value["local_work"]["phase"] = json!("unknown");
            assert_refusal(&invalid, "unknown v2 local phase");
        } else {
            let v2 = fixtures()
                .into_iter()
                .find(|other| other["v"] == 2 && other["phase"] == case["phase"])
                .unwrap();
            let local = rows(&v2)
                .into_iter()
                .find(|row| row.record.value.get("context").is_some())
                .unwrap();
            invalid[session].record.value["local_work"] = local.record.value["local_work"].clone();
            assert_refusal(&invalid, "v1 cannot mix in v2 local work");
        }
    }
}

#[test]
fn source_adoption_refuses_actual_v1_v2_private_rows_before_target_writes() {
    for case in fixtures() {
        for row in rows(&case) {
            let directory = Directory::new();
            let path = directory.file("source-spoof.sqlite3");
            let store = SqliteStore::open(&path);
            let before = snapshot(&store, &path);
            let mut forged = capture();
            let key = TupleKey::from_record_key(&RecordKey(row.key)).unwrap();
            let key = key
                .decoded_parts()
                .unwrap()
                .into_iter()
                .map(|part| {
                    let DecodedKeyPart::String(text) = part else {
                        panic!("Actual writer fixture key must be a string tuple")
                    };
                    to_source_profile(&PortableValue::from_json(&json!(
                        std::str::from_utf8(&text).unwrap()
                    )))
                    .unwrap()
                })
                .collect();
            forged.entries.push(SourceEntry {
                key,
                value: to_source_profile(&PortableValue::from_json(&row.record.value)).unwrap(),
                versionstamp: row.record.revision,
                expires_at_ms: row.record.expires_at_ms,
            });
            let error = prepare(&forged, &CanonicalDates).err().unwrap();
            assert_eq!(
                error.diagnostic(),
                "Source capture cannot mint Rust authority or adoption metadata"
            );
            assert_eq!(snapshot(&store, &path), before);
        }
    }
}

struct DuplicateQuery<'a>(&'a SqliteStore);
impl AuthorityStore for DuplicateQuery<'_> {
    async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
        self.0.read(key).await
    }
    async fn commit(&self, _: AtomicTransition) -> Result<CommitOutcome, GatewayError> {
        panic!("Private inverse must not write")
    }
}
impl QueryStore for DuplicateQuery<'_> {
    async fn query(&self, request: QueryRequest) -> Result<QueryPage, GatewayError> {
        let mut page = self.0.query(request).await?;
        let repeated = page
            .entries
            .iter()
            .find(|row| row.record.value.get("context").is_some())
            .unwrap()
            .clone();
        page.entries.push(repeated);
        Ok(page)
    }
}

#[test]
fn duplicate_query_custody_refuses_without_changing_sqlite_or_wal() {
    for case in fixtures() {
        let directory = Directory::new();
        let path = directory.file("duplicate-query.sqlite3");
        let store = store(&path, &rows(&case));
        let before = snapshot(&store, &path);
        assert!(
            run(export_rollback_bundle(
                &DuplicateQuery(&store),
                NOW,
                artifacts()
            ))
            .is_err()
        );
        assert_eq!(snapshot(&store, &path), before);
    }
}
