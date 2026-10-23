#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_admin_data::profile::{from_source_profile_with_host, to_source_profile};
use gateway_auth::store::key;
use gateway_core::{
    GatewayError, js_string::JsString16, source_json::SourceJson, state::*, value::PortableValue,
};
use gateway_migration::*;
use serde_json::{Value, json};
use support::{fixture::*, sqlite_store::*};
struct OracleDate;
impl SourceDateHost for OracleDate {
    fn date_value(&self, input: Option<&Value>) -> Result<Option<i64>, GatewayError> {
        CanonicalDates.date_value(input)
    }
    fn source_date_value(&self, input: Option<&SourceJson>) -> Result<Option<i64>, GatewayError> {
        if input.is_some_and(|value| value.as_str() == r#""2024-01-02\ud83d""#) {
            return Ok(None);
        }
        let input = input.map(SourceJson::deserialize::<Value>).transpose()?;
        self.date_value(input.as_ref())
    }
}
fn raw(value: Value) -> SourceJson {
    SourceJson::from_serializable(&value).unwrap()
}
fn entry(name: &str, value: SourceJson) -> SourceEntry {
    SourceEntry {
        key: vec![
            raw(json!({"type":"string","value":"default"})),
            raw(json!({"type":"string","value":name})),
        ],
        value,
        versionstamp: format!("original-{name}"),
        expires_at_ms: Some(9000),
    }
}
fn capture(entries: Vec<SourceEntry>) -> PrivateCapture {
    PrivateCapture {
        v: 1,
        source_git_sha: "6d4d4790a7c06514b92938ff677dbfd52764461d".into(),
        captured_at_ms: 2200,
        entries,
    }
}
#[test]
fn raw_source_values_restart_then_export_the_latest_state_without_surrogate_loss() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../gateway-admin-data/tests/fixtures/profile-utf16-source.json"
    ))
    .unwrap();
    let entries = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            entry(
                case["name"].as_str().unwrap(),
                SourceJson::parse(case["input"].as_str().unwrap()).unwrap(),
            )
        })
        .collect();
    let input = capture(entries);
    let raw_input = serde_json::to_vec(&input).unwrap();
    let input: PrivateCapture = serde_json::from_slice(&raw_input).unwrap();
    let directory = Directory::new();
    let path = directory.file("raw-source.sqlite3");
    let store = SqliteStore::open(&path);
    run(adopt_empty(&store, &prepare(&input, &OracleDate).unwrap())).unwrap();
    drop(store);
    let store = SqliteStore::open(&path);
    for original in &input.entries {
        let name: String = original.key[1]
            .object_entries()
            .unwrap()
            .into_iter()
            .find(|(key, _)| key == &JsString16::from_utf8("value"))
            .unwrap()
            .1
            .deserialize()
            .unwrap();
        let row = run(store.read(&key(json!(["default", name]))))
            .unwrap()
            .unwrap();
        assert_eq!(
            row.portable_value().unwrap(),
            from_source_profile_with_host(&original.value, &OracleDate).unwrap()
        );
        assert_eq!(row.revision, original.versionstamp);
        assert_eq!(row.expires_at_ms, Some(9000));
    }
    let changed = key(json!(["default", "lone-high"]));
    let latest = PortableValue::StringUtf16(JsString16::from_units(vec![0xde00, 0x78, 0xd83d]));
    store.put(
        changed,
        StoredRecord::profile_v2("latest-raw-write", latest.clone(), Some(8100)).unwrap(),
    );
    let deleted = key(json!(["default", "lone-low"]));
    let old = run(store.read(&deleted)).unwrap().unwrap();
    run(store.commit(AtomicTransition {
        checks: vec![RevisionCheck {
            key: deleted.clone(),
            expected_revision: Some(old.revision),
        }],
        mutations: vec![RecordMutation::Delete { key: deleted }],
    }))
    .unwrap();
    let output = run(export_latest(&store, 2300)).unwrap();
    assert_eq!(output.entries.len(), input.entries.len() - 1);
    let bytes = serde_json::to_vec(&output).unwrap();
    let output: PrivateCapture = serde_json::from_slice(&bytes).unwrap();
    let latest_row = output
        .entries
        .iter()
        .find(|row| row.versionstamp == "latest-raw-write")
        .unwrap();
    assert_eq!(latest_row.value, to_source_profile(&latest).unwrap());
    assert_eq!(latest_row.expires_at_ms, Some(8100));
    let inverse = SqliteStore::open(&directory.file("raw-inverse-new.sqlite3"));
    run(adopt_empty(
        &inverse,
        &prepare(&output, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let again = run(export_latest(&inverse, 2300)).unwrap();
    assert_eq!(serde_json::to_vec(&again).unwrap(), bytes);
}
#[test]
fn key_textencoder_fold_is_explicit_and_value_units_never_fold() {
    let mut source = entry(
        "key-high",
        SourceJson::parse(r#"{"type":"string","value":"\ud83d"}"#).unwrap(),
    );
    source
        .key
        .push(SourceJson::parse(r#"{"type":"string","value":"\ud83d"}"#).unwrap());
    let input = capture(vec![source.clone()]);
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("key-textencoder.sqlite3"));
    run(adopt_empty(
        &store,
        &prepare(&input, &CanonicalDates).unwrap(),
    ))
    .unwrap();
    let stored = run(store.read(&key(json!(["default", "key-high", "\u{fffd}"]))))
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.portable_value().unwrap(),
        PortableValue::StringUtf16(JsString16::from_units(vec![0xd83d]))
    );
    let mut duplicate = source;
    duplicate.key[2] = raw(json!({"type":"string","value":"\u{fffd}"}));
    assert!(
        prepare(
            &capture(vec![input.entries[0].clone(), duplicate]),
            &CanonicalDates
        )
        .is_err()
    );
    let output = run(export_latest(&store, 2300)).unwrap();
    assert_eq!(
        output.entries[0].key[2],
        raw(json!({"type":"string","value":"\u{fffd}"}))
    );
    assert_eq!(output.entries[0].value, input.entries[0].value);
}

#[test]
fn full_capture_refuses_a_partial_binary_view_before_writing() {
    let value = SourceJson::parse(
        r#"{"type":"Array","value":[{"type":"Uint8Array","value":"AAECAw","byteLength":2}]}"#,
    )
    .unwrap();
    let input = capture(vec![entry("partial-view", value)]);
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("partial-view.sqlite3"));
    assert!(prepare(&input, &CanonicalDates).is_err());
    assert!(
        run(store.read(&key(json!(["default", "partial-view"]))))
            .unwrap()
            .is_none()
    );
}
