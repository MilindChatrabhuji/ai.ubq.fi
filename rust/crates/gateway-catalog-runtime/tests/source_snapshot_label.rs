//! The full stored-reader and runtime-compaction source-label phases are intentionally distinct.
use gateway_catalog_runtime::state::parse_full_snapshot;
use gateway_core::{
    js_string::JsString16, source_json::SourceJson, source_serialization as source,
};
use gateway_schema::{
    runtime_config::compact_snapshot,
    snapshot::{SnapshotOverrides, normalize_snapshot},
};

fn snapshot(label: &str) -> SourceJson {
    source::object(vec![
        (
            "models",
            SourceJson::parse(r#"[{"slug":"ordinary"}]"#).unwrap(),
        ),
        ("source", SourceJson::parse(label).unwrap()),
        ("updated_at_ms", SourceJson::parse("1").unwrap()),
    ])
    .unwrap()
}

#[test]
fn source_defined_stored_read_refuses_blank_after_upload_normalization_preserves_it() {
    // src/models/codex-models-fetch.ts:396-405; runtime-config.ts:112-127.
    for label in [r#""""#, r#"" \ufeff\u00a0 ""#] {
        let document = snapshot(label);
        let uploaded = normalize_snapshot(&document, &SnapshotOverrides::default(), 1).unwrap();
        assert_eq!(
            uploaded.source,
            source::string(&SourceJson::parse(label).unwrap()).unwrap()
        );
        assert!(parse_full_snapshot(&document).is_none());
        assert!(compact_snapshot(&uploaded).is_err());
    }
}

#[test]
fn stored_source_label_retains_original_units_but_runtime_projection_trims_at_source_phase() {
    let document = snapshot(r#"" \ud800\u00a0""#);
    let stored = parse_full_snapshot(&document).unwrap();
    assert_eq!(stored.source, JsString16::from_units(vec![32, 0xd800, 160]));
    let compact = compact_snapshot(&stored).unwrap();
    let runtime_label = source::string(&source::member(&compact, "source").unwrap()).unwrap();
    assert_eq!(runtime_label, JsString16::from_units(vec![0xd800]));
    let scalar = parse_full_snapshot(&snapshot(r#""codex_cli""#)).unwrap();
    assert_eq!(scalar.source, "codex_cli".into());
}
