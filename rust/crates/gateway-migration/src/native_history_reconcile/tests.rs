use super::*;
use crate::{NativeRevision, NativeValue, SourceJson};
use gateway_core::tuple_key::{BigIntKey, KeyPart};
use std::path::{Path, PathBuf};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        Self(crate::native_stage::directory(&std::env::temp_dir()).unwrap())
    }
    fn capture(&self, name: &str, source: NativeCapture) -> Captured {
        let directory = self.0.join(name);
        std::fs::create_dir(&directory).unwrap();
        Captured::owned(source, &directory).unwrap()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn header() -> NativeCapture {
    NativeCapture {
        v: 2,
        source_git_sha: "a".repeat(40),
        captured_at_ms: 2200,
        source_codec: "bun-jsc-v1".into(),
        native_schema_version: 3,
        data_revision: NativeRevision {
            version: "50".into(),
            sequence: "0".into(),
        },
        queue_entries: 0,
        running_queue_entries: 0,
        entries: vec![],
    }
}
fn entry(part: KeyPart, value: NativeValue, sequence: &str, expiration_ms: i64) -> NativeEntry {
    NativeEntry {
        raw_key: TupleKey::from_parts(&[
            KeyPart::String("default".into()),
            KeyPart::String("reconcile-fixture".into()),
            part,
        ])
        .unwrap()
        .sort_bytes()
        .to_vec(),
        value,
        revision: NativeRevision {
            version: "49".into(),
            sequence: sequence.into(),
        },
        expiration_ms,
    }
}
fn bytes(name: &str, value: u8) -> NativeEntry {
    entry(
        KeyPart::String(name.into()),
        NativeValue::Bytes(vec![value]),
        "0",
        -1,
    )
}
fn capture(entries: Vec<NativeEntry>) -> NativeCapture {
    let mut source = header();
    source.entries = entries;
    source
}
fn mapping(raw_keys: &[Vec<u8>]) -> (Manifest, BTreeSet<String>) {
    let capture_id = "b".repeat(64);
    let keys = raw_keys
        .iter()
        .map(|raw| {
            let key = TupleKey::from_sort_bytes(raw.clone())
                .unwrap()
                .to_record_key();
            crate::engine::mapping_key(&capture_id, &key.0).0
        })
        .collect::<BTreeSet<_>>();
    let manifest = Manifest {
        v: 4,
        capture_id,
        source_git_sha: header().source_git_sha,
        captured_at_ms: 2200,
        source_rows: keys.len(),
        mapping_checksum: "c".repeat(64),
        derived: BTreeMap::new(),
        native_revision: Some(header().data_revision),
    };
    // This tests pure candidate merging. Real caller provenance/count/checksum
    // validation is deliberately not claimed by synthetic manifest construction.
    (manifest, keys)
}
fn wire(entry: &NativeEntry) -> Vec<u8> {
    serde_json::to_vec(entry).unwrap()
}
fn collect(
    original: NativeCapture,
    latest: NativeCapture,
    raw_keys: &[Vec<u8>],
) -> (NativeCapture, Vec<Vec<u8>>) {
    let scratch = Scratch::new();
    let original = scratch.capture("original", original);
    let latest = scratch.capture("latest", latest);
    let (manifest, keys) = mapping(raw_keys);
    let mut rows = vec![];
    let result = reconcile(&original, &latest, &manifest, &keys, &mut |entry| {
        rows.push(wire(entry));
        Ok(())
    })
    .unwrap();
    (result, rows)
}

#[test]
fn mapped_deletion_does_not_erase_never_imported_history_or_latest_writes() {
    let deleted = bytes("deleted", 1);
    let history = bytes("never-imported-history", 2);
    let old = bytes("updated", 3);
    let mut updated = bytes("updated", 4);
    updated.revision = NativeRevision {
        version: "51".into(),
        sequence: "7".into(),
    };
    updated.expiration_ms = 9900;
    let added = bytes("new-write", 5);
    let mut latest = capture(vec![updated.clone(), added.clone()]);
    latest.captured_at_ms = 2300;
    latest.data_revision = NativeRevision {
        version: "51".into(),
        sequence: "7".into(),
    };
    let expected_header = serde_json::to_vec(&NativeCapture {
        entries: vec![],
        ..latest.clone()
    })
    .unwrap();
    let (result, rows) = collect(
        capture(vec![deleted.clone(), history.clone(), old.clone()]),
        latest,
        &[deleted.raw_key, old.raw_key],
    );
    assert_eq!(rows, vec![wire(&history), wire(&updated), wire(&added)]);
    assert_eq!(serde_json::to_vec(&result).unwrap(), expected_header);
}

#[test]
fn imported_keys_created_after_original_can_be_absent_or_present_in_latest() {
    let history = bytes("old-history", 1);
    let deleted_after_original = bytes("newer-imported-then-deleted", 2);
    let present_after_original = bytes("newer-imported-current", 3);
    let (_, rows) = collect(
        capture(vec![history.clone()]),
        capture(vec![present_after_original.clone()]),
        &[
            deleted_after_original.raw_key,
            present_after_original.raw_key.clone(),
        ],
    );
    assert_eq!(rows, vec![wire(&history), wire(&present_after_original)]);
}

#[test]
fn raw_typed_keys_values_revisions_and_absolute_expiry_remain_exact() {
    let values = vec![
        entry(
            KeyPart::Bytes(vec![0, 255]),
            NativeValue::Bytes(vec![0, 255, 7]),
            "1",
            -1,
        ),
        entry(
            KeyPart::BigInt(BigIntKey::from_i128(1)),
            NativeValue::CounterLe64(u64::MAX.to_le_bytes().to_vec()),
            "2",
            2199,
        ),
        entry(
            KeyPart::Number(1.0),
            NativeValue::SourceGraphV1(
                SourceJson::parse(r#"{"root":{"type":"string","value":"\ud800"},"nodes":[]}"#)
                    .unwrap(),
            ),
            "3",
            9200,
        ),
        entry(KeyPart::Boolean(true), NativeValue::Bytes(vec![4]), "4", 0),
    ];
    let expected = values.iter().map(wire).collect::<Vec<_>>();
    let (_, actual) = collect(capture(values), capture(vec![]), &[]);
    assert_eq!(actual, expected);
    large_spooled_payloads_remain_exact();
}

fn large_spooled_payloads_remain_exact() {
    let scratch = Scratch::new();
    let directory = scratch.0.join("large-original");
    std::fs::create_dir(&directory).unwrap();
    let mut writer = crate::native_spool::Writer::create(&directory.join("entries")).unwrap();
    let row_bytes = 2 * 1024 * 1024;
    for ordinal in 0u32..20 {
        writer
            .push(&entry(
                KeyPart::Number(f64::from(ordinal)),
                NativeValue::Bytes(vec![7; row_bytes]),
                &ordinal.to_string(),
                9900,
            ))
            .unwrap();
    }
    let original = Captured::from_parts(header(), writer.seal().unwrap(), &directory);
    let latest = scratch.capture("large-latest", header());
    let (manifest, keys) = mapping(&[]);
    let expected_hash = gateway_auth::crypto::sha256_hex(&vec![7; row_bytes]);
    let mut count = 0usize;
    let mut total = 0usize;
    let result = reconcile(&original, &latest, &manifest, &keys, &mut |entry| {
        let NativeValue::Bytes(bytes) = &entry.value else {
            panic!("synthetic byte payload")
        };
        assert_eq!(bytes.len(), row_bytes);
        assert_eq!(gateway_auth::crypto::sha256_hex(bytes), expected_hash);
        assert_eq!(entry.expiration_ms, 9900);
        count += 1;
        total += bytes.len();
        Ok(())
    })
    .unwrap();
    assert_eq!(count, 20);
    assert_eq!(total, 40 * 1024 * 1024);
    assert!(result.entries.is_empty());
}

fn refused(
    original: NativeCapture,
    latest: NativeCapture,
    mutate: impl FnOnce(&mut Manifest, &mut BTreeSet<String>),
) {
    let scratch = Scratch::new();
    let original = scratch.capture("original", original);
    let latest = scratch.capture("latest", latest);
    let (mut manifest, mut keys) = mapping(&[]);
    mutate(&mut manifest, &mut keys);
    let mut emitted = 0;
    assert!(
        reconcile(&original, &latest, &manifest, &keys, &mut |_| {
            emitted += 1;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(emitted, 0);
}

#[test]
fn malformed_duplicate_source_and_mapping_anchor_mismatches_fail_before_output() {
    let row = bytes("original", 1);
    refused(
        capture(vec![row.clone(), row.clone()]),
        capture(vec![]),
        |_, _| {},
    );
    refused(
        capture(vec![]),
        capture(vec![row.clone(), row.clone()]),
        |_, _| {},
    );
    let mut malformed = row.clone();
    malformed.raw_key = vec![0];
    refused(capture(vec![malformed]), capture(vec![]), |_, _| {});
    let mut malformed = row;
    malformed.value = NativeValue::CounterLe64(vec![0; 7]);
    refused(capture(vec![]), capture(vec![malformed]), |_, _| {});
    refused(capture(vec![]), capture(vec![]), |manifest, _| {
        manifest.source_rows = 1
    });
    refused(capture(vec![]), capture(vec![]), |manifest, _| {
        manifest.source_git_sha = "d".repeat(40)
    });
    refused(capture(vec![]), capture(vec![]), |manifest, _| {
        manifest.native_revision = None
    });
    refused(capture(vec![]), capture(vec![]), |manifest, keys| {
        keys.insert(crate::engine::mapping_key(&"d".repeat(64), "wrong-capture").0);
        manifest.source_rows = 1;
    });
}

#[test]
fn different_or_older_latest_header_is_not_silently_relabelled() {
    let mut latest = header();
    latest.source_git_sha = "d".repeat(40);
    refused(header(), latest, |_, _| {});
    let mut latest = header();
    latest.captured_at_ms -= 1;
    refused(header(), latest, |_, _| {});
    let mut latest = header();
    latest.data_revision.version = "49".into();
    refused(header(), latest, |_, _| {});
}

#[test]
fn complete_merged_key_audit_runs_before_any_output() {
    let mut source: NativeCapture =
        serde_json::from_str(include_str!("../../tests/fixtures/native-source.json")).unwrap();
    // Break the genuine id/hash pair in a still-well-typed native graph.
    let NativeValue::SourceGraphV1(graph) = &source.entries[0].value else {
        panic!("fixture graph")
    };
    let mut graph: serde_json::Value = graph.deserialize().unwrap();
    graph["nodes"][0]["entries"][0][1]["value"] = serde_json::json!("different-key");
    source.entries[0].value =
        NativeValue::SourceGraphV1(SourceJson::from_serializable(&graph).unwrap());
    let mut latest = source.clone();
    latest.entries.clear();
    let scratch = Scratch::new();
    let original = scratch.capture("original", source);
    let latest = scratch.capture("latest", latest);
    let (mut manifest, keys) = mapping(&[]);
    manifest.source_git_sha = original.metadata().source_git_sha.clone();
    let mut emitted = 0;
    let error = reconcile(&original, &latest, &manifest, &keys, &mut |_| {
        emitted += 1;
        Ok(())
    })
    .unwrap_err();
    assert!(matches!(error, MigrationError::SourceInventory(_)));
    assert_eq!(emitted, 0);
}

#[test]
fn fallible_private_sink_failure_never_returns_a_completed_header() {
    let scratch = Scratch::new();
    let original = scratch.capture("original", capture(vec![bytes("one", 1), bytes("two", 2)]));
    let latest = scratch.capture("latest", header());
    let (manifest, keys) = mapping(&[]);
    let mut attempts = 0;
    let error = reconcile(&original, &latest, &manifest, &keys, &mut |_| {
        attempts += 1;
        Err(GatewayError::new(
            503,
            "Synthetic sink failed",
            Some("synthetic_sink_failed"),
        ))
    })
    .unwrap_err();
    assert_eq!(attempts, 1);
    assert_eq!(error.code(), Some("synthetic_sink_failed"));
}

#[test]
fn complete_spool_eof_is_verified_even_when_input_rows_would_be_deleted() {
    let scratch = Scratch::new();
    let row = bytes("deleted", 1);
    let original = scratch.capture("original", capture(vec![row.clone()]));
    let latest = scratch.capture("latest", header());
    let (manifest, keys) = mapping(&[row.raw_key]);
    let path = scratch.0.join("original").join("native-entries.spool");
    append(&path);
    let mut emitted = 0;
    assert!(
        reconcile(&original, &latest, &manifest, &keys, &mut |_| {
            emitted += 1;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(emitted, 0);
}
fn append(path: &Path) {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b" ")
        .unwrap();
}
