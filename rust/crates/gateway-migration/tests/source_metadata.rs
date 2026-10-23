#![cfg(not(target_arch = "wasm32"))]
//! Invalid source metadata views are retained raw, not promoted into normalized authority.
mod support;
use gateway_admin_data::profile::{CanonicalDates, from_source_profile, to_source_profile};
use gateway_core::{
    source_control::source_json_tree, source_json::SourceJson, value::PortableValue,
};
use gateway_migration::*;
use serde_json::{Value, json};
use support::{fixture::*, sqlite_store::*};

fn entry(key: Value, value: &str) -> SourceEntry {
    SourceEntry {
        key: key
            .as_array()
            .unwrap()
            .iter()
            .map(|part| to_source_profile(&PortableValue::from_json(part)).unwrap())
            .collect(),
        value: to_source_profile(&source_json_tree(&SourceJson::parse(value).unwrap()).unwrap())
            .unwrap(),
        versionstamp: "source-raw-metadata".into(),
        expires_at_ms: Some(9000),
    }
}
fn capture(entries: Vec<SourceEntry>) -> PrivateCapture {
    PrivateCapture {
        v: 1,
        source_git_sha: "a".repeat(40),
        captured_at_ms: 1000,
        entries,
    }
}
#[test]
fn named_metadata_parse_none_preserves_raw_units_revision_and_expiry() {
    for key in [
        json!(["uos_ai", "codex_account_models", "v1"]),
        json!(["uos_ai", "codex_models_whitelist"]),
        json!(["uos_ai", "runtime_config", "v2"]),
    ] {
        let input = capture(vec![entry(key, r#""\ud800""#)]);
        let directory = Directory::new();
        let path = directory.file("raw-metadata.sqlite3");
        let store = SqliteStore::open(&path);
        run(adopt_empty(
            &store,
            &prepare(&input, &CanonicalDates).unwrap(),
        ))
        .unwrap();
        drop(store);
        let store = SqliteStore::open(&path);
        let output = run(export_latest(&store, 2000)).unwrap();
        assert_eq!(output.entries.len(), 1);
        assert_eq!(output.entries[0].key, input.entries[0].key);
        assert_eq!(
            from_source_profile(&output.entries[0].value).unwrap(),
            from_source_profile(&input.entries[0].value).unwrap()
        );
        assert_eq!(output.entries[0].versionstamp, "source-raw-metadata");
        assert_eq!(output.entries[0].expires_at_ms, Some(9000));
    }
}
#[test]
fn explicit_source_default_snapshot_audit_fatal_and_absence_rules_are_unchanged() {
    let default = entry(json!(["default", "model"]), r#""\ud800""#);
    for snapshot in [r#"{"models":[]}"#, r#"{"models":[{"slug":"other"}]}"#] {
        let input = capture(vec![
            default.clone(),
            entry(json!(["ubq_ai", "codex_models"]), snapshot),
        ]);
        let error = prepare(&input, &CanonicalDates).err().unwrap();
        assert!(matches!(&error, MigrationError::SourceInventory(_)));
        assert_eq!(error.status(), 409);
        assert_eq!(error.code(), Some("migration_state_invalid"));
    }
    // Original source migration audit skips a missing or null snapshot, rather
    // than inventing catalog/model availability from the raw default value.
    assert!(prepare(&capture(vec![default.clone()]), &CanonicalDates).is_ok());
    assert!(
        prepare(
            &capture(vec![
                default,
                entry(json!(["ubq_ai", "codex_models"]), "null")
            ]),
            &CanonicalDates
        )
        .is_ok()
    );
}
