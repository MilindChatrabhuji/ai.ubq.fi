#![cfg(all(unix, not(target_arch = "wasm32")))]
mod copied_store_inverse {
    pub mod driver;
    pub mod store;
}
mod support;

use copied_store_inverse::store::ReadonlyStore;
use gateway_auth::{
    crypto::base64url,
    native_auth::NativeNonceAuthority,
    native_credentials::{NativeOwnerId, OwnerFence, parse_native_document},
    native_replay::StoreNonceAuthority,
    provider_credentials::codex_source_pool_key,
};
use gateway_core::{
    js_string::JsString16,
    query::{QueryRequest, QuerySelector, QueryStore},
    source_graph::{GraphAtom, GraphNode, SourceGraph},
    state::*,
    tuple_key::{KeyPart, TupleKey},
};
use gateway_migration::{
    NativeCapture, NativeEntry, NativeRevision, NativeValue, adopt_empty, graph_transport,
    native_operator::{NativeCustodyRegistration, prepare_local_bootstrap},
    prepare_native,
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
use support::{
    fixture::{Directory, run},
    sqlite_store::SqliteStore,
};

const NOW: i64 = 2400;
const METADATA: &str = "CREATE TABLE uos_authority_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL, key_codec TEXT NOT NULL, value_codec TEXT NOT NULL)";
const RECORDS: &str = "CREATE TABLE uos_authority_records (record_key TEXT PRIMARY KEY NOT NULL, sort_key BLOB UNIQUE NOT NULL, schema_version INTEGER NOT NULL, value_encoding TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, expires_at_ms INTEGER)";

fn hash(path: &Path) -> String {
    format!("{:x}", Sha256::digest(fs::read(path).unwrap()))
}

fn private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn key(parts: &[&str]) -> RecordKey {
    TupleKey::from_parts(
        &parts
            .iter()
            .map(|s| KeyPart::String((*s).into()))
            .collect::<Vec<_>>(),
    )
    .unwrap()
    .to_record_key()
}

fn query(cursor: Option<String>, reverse: bool, limit: u32) -> QueryRequest {
    QueryRequest {
        selector: QuerySelector::Prefix {
            prefix: TupleKey::from_parts(&[]).unwrap().to_record_key(),
            start: None,
            end: None,
        },
        reverse,
        limit,
        cursor,
        now_ms: NOW,
    }
}

fn graph(value: &Value) -> NativeValue {
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
    NativeValue::SourceGraphV1(
        graph_transport::to_source_graph(&SourceGraph { root, nodes }).unwrap(),
    )
}

struct Fixture {
    directory: Directory,
    snapshot: PathBuf,
    auth: PathBuf,
    input: Value,
    original_snapshot_hash: String,
    expected_removed: Vec<u8>,
    expected_updated: Vec<u8>,
}

impl Fixture {
    fn new() -> Self {
        // These are exact shipping DDLs; the fixture is synthetic, not a claim
        // that the real workerd runtime was launched by this native test.
        let actual = include_str!("../../gateway-worker/src/storage.rs");
        assert!(actual.contains(METADATA) && actual.contains(RECORDS));
        let directory = Directory::new();
        let home = directory.file("native-home");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        let token = format!(
            "e30.{}.synthetic",
            base64url(br#"{"exp":4000000000,"sub":"copy-fixture"}"#)
        );
        let document = json!({"auth_mode":"chatgpt","tokens":{"account_id":"copy-fixture","access_token":token,"id_token":token,"refresh_token":"synthetic-copy-refresh"},"last_refresh":"2026-10-18T12:00:00Z"});
        let auth = home.join("auth.json");
        private(&auth, &serde_json::to_vec(&document).unwrap());
        let credentials = parse_native_document(&document).unwrap();
        let fence = OwnerFence {
            owner: NativeOwnerId("copied-fixture-owner".into()),
            account_id: "copy-fixture".into(),
            generation_hash: credentials.generation_hash(),
            authority_revision: "native-v1:50:0".into(),
        };
        let mut source: NativeCapture =
            serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap();
        let pool_key = codex_source_pool_key();
        source.entries.push(NativeEntry {
            raw_key: TupleKey::from_record_key(&pool_key).unwrap().sort_bytes().to_vec(),
            value: graph(&json!({"accounts":[{"account_id":"copy-fixture","access_token":credentials.access_token.expose(),"refresh_token":credentials.refresh_token.expose(),"updated_at_ms":2200,"native_owner":{"codex_home":home,"generation_hash":credentials.generation_hash(),"native_refreshed_at":credentials.native_refreshed_at}}],"updated_at_ms":2200})),
            revision: NativeRevision { version: "50".into(), sequence: "0".into() }, expiration_ms: -1,
        });
        for name in ["copied-update", "copied-remove"] {
            source.entries.push(NativeEntry {
                raw_key: TupleKey::from_record_key(&key(&["default", name]))
                    .unwrap()
                    .sort_bytes()
                    .to_vec(),
                value: graph(&json!({"original":name})),
                revision: NativeRevision {
                    version: "50".into(),
                    sequence: "0".into(),
                },
                expiration_ms: 9000,
            });
        }
        let candidate = run(prepare_local_bootstrap(
            &source,
            vec![NativeCustodyRegistration::existing(home.clone(), fence.clone()).unwrap()],
        ))
        .unwrap();
        let common = SqliteStore::open(&directory.file("synthetic-common.sqlite3"));
        run(adopt_empty(&common, &prepare_native(&candidate).unwrap())).unwrap();
        let updated = key(&["default", "copied-update"]);
        let removed = key(&["default", "copied-remove"]);
        assert_eq!(
            run(common.commit(AtomicTransition {
                checks: vec![],
                mutations: vec![
                    RecordMutation::Put {
                        key: updated.clone(),
                        record: StoredRecord::json(
                            "latest-update",
                            json!({"latest":true}),
                            Some(8000)
                        )
                    },
                    RecordMutation::Delete {
                        key: removed.clone()
                    },
                    RecordMutation::Put {
                        key: key(&["default", "copied-new"]),
                        record: StoredRecord::json("latest-new", json!([1, 2, 3]), None)
                    },
                ],
            }))
            .unwrap(),
            CommitOutcome::Committed
        );
        run(StoreNonceAuthority::new(&common).consume_nonce(
            "copied-fixture-key",
            &base64url(&[7; 32]),
            8000,
            NOW,
        ))
        .unwrap();
        let namespace = directory.file("fixture-namespace");
        fs::create_dir(&namespace).unwrap();
        let object_id = "e".repeat(64);
        let source_db = namespace.join(format!("{object_id}.sqlite"));
        let db = Connection::open(&source_db).unwrap();
        db.execute_batch(&format!("{METADATA}; {RECORDS};"))
            .unwrap();
        db.execute(
            "INSERT INTO uos_authority_metadata VALUES (1, ?, 'tuple-v1', 'explicit-value-v1')",
            [PORTABLE_STATE_VERSION],
        )
        .unwrap();
        let entries = run(common.query(query(None, false, 10000)))
            .unwrap()
            .entries;
        for entry in entries {
            let record = entry.record;
            let encoding = serde_json::to_value(record.value_encoding).unwrap();
            db.execute(
                "INSERT INTO uos_authority_records VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    entry.key.0,
                    TupleKey::from_record_key(&entry.key).unwrap().sort_bytes(),
                    record.schema_version,
                    encoding.as_str().unwrap(),
                    record.revision,
                    serde_json::to_string(&record.value).unwrap(),
                    record.expires_at_ms
                ],
            )
            .unwrap();
        }
        drop(db);
        fs::set_permissions(&source_db, fs::Permissions::from_mode(0o600)).unwrap();
        let snapshot = directory.file("immutable-copy.sqlite3");
        fs::copy(&source_db, &snapshot).unwrap();
        fs::set_permissions(&snapshot, fs::Permissions::from_mode(0o400)).unwrap();
        let original_snapshot_hash = hash(&snapshot);
        let source_meta = fs::metadata(&source_db).unwrap();
        // Synthetic operator metadata exercises receipt binding. The test uses a
        // stopped synthetic copy, and does not claim an online backup occurred.
        let backup = directory.file("backup.receipt.json");
        private(&backup, &serde_json::to_vec(&json!({"method":"sqlite3.Connection.backup","source_mode":"ro","source":source_db,"destination":snapshot,"source_inode":source_meta.ino(),"source_device":source_meta.dev(),"started_at":"synthetic","consistent_backup_complete":true,"progress":{"status":101,"remaining":0,"total":1},"finished_at":"synthetic","bytes":fs::metadata(&snapshot).unwrap().len(),"destination_sha256":original_snapshot_hash})).unwrap());
        let authority = directory.file("authority.receipt.json");
        private(&authority, &serde_json::to_vec(&json!({"v":1,"operation":"observed_workerd_authority","backup_receipt_sha256":hash(&backup),"source_database":source_db,"source_inode":source_meta.ino(),"source_device":source_meta.dev(),"namespace":"fixture-namespace","object_name":"gateway-authority-v1","object_id":object_id,"source_git_sha":"a".repeat(40),"source_git_tree":"b".repeat(40),"wasm_sha256":"c".repeat(64),"native_sha256":"d".repeat(64),"observed_at_ms":2300})).unwrap());
        let input = json!({"v":1,"now_ms":NOW,"backup_receipt":{"path":backup,"sha256":hash(&backup)},"authority_receipt":{"path":authority,"sha256":hash(&authority)},"registrations":[{"home":home,"fence":fence}],"artifacts":{"rust_git_sha":"a".repeat(40),"rust_git_tree":"b".repeat(40),"wasm_sha256":"c".repeat(64),"native_sha256":"d".repeat(64),"native_nonce_capture_sha256":null},"native_nonce_capture":null,"output_directory":directory.file("inverse-output")});
        Self {
            directory,
            snapshot,
            auth,
            input,
            original_snapshot_hash,
            expected_removed: TupleKey::from_record_key(&removed)
                .unwrap()
                .sort_bytes()
                .to_vec(),
            expected_updated: TupleKey::from_record_key(&updated)
                .unwrap()
                .sort_bytes()
                .to_vec(),
        }
    }

    fn invoke(&self) -> Result<copied_store_inverse::driver::Receipt, Box<dyn std::error::Error>> {
        copied_store_inverse::driver::execute(serde_json::from_value(self.input.clone()).unwrap())
    }

    fn receipt_path(&self) -> PathBuf {
        self.directory.file("inverse-output/receipt.json")
    }
}

#[test]
fn copied_workerd_schema_exports_latest_state_and_private_current_custody_without_input_writes() {
    let fixture = Fixture::new();
    let receipt = serde_json::to_value(fixture.invoke().unwrap()).unwrap();
    assert_eq!(receipt["operation"], "copied_store_latest_inverse");
    assert_eq!(receipt["activation_authorized"], false);
    assert_eq!(receipt["input_unchanged"], true);
    assert_eq!(hash(&fixture.snapshot), fixture.original_snapshot_hash);
    let output = fixture.directory.file("inverse-output/source.private.json");
    let source: NativeCapture = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    assert!(
        !source
            .entries
            .iter()
            .any(|e| e.raw_key == fixture.expected_removed)
    );
    let updated = source
        .entries
        .iter()
        .find(|e| e.raw_key == fixture.expected_updated)
        .unwrap();
    assert_eq!(updated.expiration_ms, 8000);
    assert_eq!(updated.revision.version, "51");
    let private_source =
        fs::read_to_string(fixture.directory.file("inverse-output/source.private.json")).unwrap();
    assert!(private_source.contains("synthetic-copy-refresh"));
    let custody: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .directory
                .file("inverse-output/custody.private.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!custody["rust_controls"].as_array().unwrap().is_empty());
    let text = serde_json::to_string(&receipt).unwrap();
    assert!(!text.contains("synthetic-copy-refresh") && !text.contains("access_token"));
    assert!(fixture.receipt_path().is_file());
    for name in [
        "source.private.json",
        "custody.private.json",
        "receipt.json",
    ] {
        assert_eq!(
            fs::metadata(fixture.directory.file(&format!("inverse-output/{name}")))
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(
        fs::metadata(fixture.directory.file("inverse-output"))
            .unwrap()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn readonly_adapter_uses_bound_tuple_order_cursors_expiry_and_refuses_commit() {
    let fixture = Fixture::new();
    let store = ReadonlyStore::open(&fixture.snapshot, NOW).unwrap();
    let all = run(store.query(query(None, false, 10000))).unwrap().entries;
    let mut paged = vec![];
    let mut cursor = None;
    loop {
        let page = run(store.query(query(cursor, false, 1))).unwrap();
        paged.extend(page.entries);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(paged, all);
    let reversed = run(store.query(query(None, true, 10000))).unwrap().entries;
    assert_eq!(reversed, all.into_iter().rev().collect::<Vec<_>>());
    assert!(
        run(store.commit(AtomicTransition {
            checks: vec![],
            mutations: vec![]
        }))
        .is_err()
    );
    assert_eq!(hash(&fixture.snapshot), fixture.original_snapshot_hash);
    assert!(run(store.query(query(Some("invalid".into()), false, 1))).is_err());
    let mut wrong_clock = query(None, false, 1);
    wrong_clock.now_ms += 1;
    assert!(run(store.query(wrong_clock)).is_err());
}

#[test]
fn copied_hash_or_independent_binding_mismatch_refuses_before_output() {
    let mut fixture = Fixture::new();
    fixture.input["backup_receipt"]["sha256"] = json!("0".repeat(64));
    assert!(fixture.invoke().is_err());
    assert!(!fixture.receipt_path().exists());
    assert!(!fixture.directory.file("inverse-output").exists());
    assert_eq!(hash(&fixture.snapshot), fixture.original_snapshot_hash);
}

#[test]
fn authority_context_mismatch_is_not_an_expected_value_echo() {
    let mut fixture = Fixture::new();
    fixture.input["artifacts"]["rust_git_tree"] = json!("f".repeat(40));
    assert!(fixture.invoke().is_err());
    assert!(!fixture.directory.file("inverse-output").exists());
}

#[test]
fn stale_physical_custody_leaves_no_success_receipt() {
    let fixture = Fixture::new();
    let mut document: Value = serde_json::from_slice(&fs::read(&fixture.auth).unwrap()).unwrap();
    document["tokens"]["refresh_token"] = json!("synthetic-new-generation");
    private(&fixture.auth, &serde_json::to_vec(&document).unwrap());
    assert!(fixture.invoke().is_err());
    assert!(!fixture.receipt_path().exists());
    assert_eq!(hash(&fixture.snapshot), fixture.original_snapshot_hash);
}

#[test]
fn malformed_schema_and_tuple_index_fail_closed() {
    let fixture = Fixture::new();
    let malformed = fixture.directory.file("malformed.sqlite3");
    fs::copy(&fixture.snapshot, &malformed).unwrap();
    fs::set_permissions(&malformed, fs::Permissions::from_mode(0o600)).unwrap();
    let connection = Connection::open(&malformed).unwrap();
    connection
        .execute("UPDATE uos_authority_metadata SET schema_version = 99", [])
        .unwrap();
    assert!(ReadonlyStore::open(&malformed, NOW).is_err());
    connection
        .execute(
            "UPDATE uos_authority_metadata SET schema_version = ?",
            [PORTABLE_STATE_VERSION],
        )
        .unwrap();
    connection.execute("UPDATE uos_authority_records SET sort_key = X'0100' WHERE record_key = (SELECT record_key FROM uos_authority_records LIMIT 1)", []).unwrap();
    drop(connection);
    let store = ReadonlyStore::open(&malformed, NOW).unwrap();
    assert!(run(store.query(query(None, false, 10000))).is_err());
}

#[test]
fn existing_output_and_missing_nonce_capture_never_get_success_receipts() {
    let mut fixture = Fixture::new();
    fixture.input["artifacts"]["native_nonce_capture_sha256"] = json!("a".repeat(64));
    assert!(fixture.invoke().is_err());
    assert!(!fixture.directory.file("inverse-output").exists());
    fixture.input["artifacts"]["native_nonce_capture_sha256"] = Value::Null;
    fs::create_dir(fixture.directory.file("inverse-output")).unwrap();
    assert!(fixture.invoke().is_err());
    assert!(!fixture.receipt_path().exists());
}
