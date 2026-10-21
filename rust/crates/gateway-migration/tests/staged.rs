#![cfg(not(target_arch = "wasm32"))]
mod support;
use gateway_core::state::AuthorityStore;
use gateway_migration::{staged::*, *};
use support::*;
fn fixture() -> NativeCapture {
    serde_json::from_str(include_str!("fixtures/native-source.json")).unwrap()
}
fn copy(request: &StageRequest) -> StageRequest {
    decode_stage_request(&serde_json::to_vec(request).unwrap()).unwrap()
}
#[test]
fn private_staging_seals_exact_native_state_without_claiming_one_atomic_commit() {
    let directory = Directory::new();
    let path = directory.file("staged.sqlite3");
    let source = fixture();
    let mut plan = StagePlan::from_prepared(prepare_native(&source).unwrap()).unwrap();
    let store = SqliteStore::open(&path);
    let begin = plan.begin();
    assert!(!run(execute_staged(&store, copy(&begin))).unwrap().sealed);
    assert!(run(execute_staged(&store, copy(&begin))).is_err());
    assert!(run(execute_staged(&store, plan.seal())).is_err());
    assert!(run(export_native_latest(&store, 2300)).is_err());
    while let Some(batch) = plan.next_batch().unwrap() {
        assert!(serde_json::to_vec(&batch).unwrap().len() <= STAGED_BATCH_MAX_BYTES);
        if let StageRequest::Append(mut wrong) = copy(&batch) {
            wrong.sequence += 1;
            assert!(run(execute_staged(&store, StageRequest::Append(wrong))).is_err());
        }
        if let StageRequest::Append(mut wrong) = copy(&batch) {
            wrong.digest.replace_range(
                ..1,
                if wrong.digest.starts_with('0') {
                    "1"
                } else {
                    "0"
                },
            );
            assert!(run(execute_staged(&store, StageRequest::Append(wrong))).is_err());
        }
        assert!(!run(execute_staged(&store, copy(&batch))).unwrap().sealed);
        assert!(run(execute_staged(&store, batch)).is_err());
    }
    let receipt = run(execute_staged(&store, plan.seal())).unwrap();
    assert!(receipt.sealed && !receipt.activation_authorized);
    assert_eq!(receipt.source_rows, source.entries.len());
    assert!(
        serde_json::to_value(&receipt)
            .unwrap()
            .get("atomic_committed")
            .is_none()
    );
    drop(store);
    let store = SqliteStore::open(&path);
    let latest = run(export_native_latest(&store, 2300)).unwrap();
    let map = |capture: &NativeCapture| {
        capture
            .entries
            .iter()
            .map(|e| (e.raw_key.clone(), serde_json::to_string(e).unwrap()))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    // The established inverse intentionally normalizes source graph wire tokens.
    // Staging must match the ENTIRE existing atomic adoption/inverse result,
    // not demand a new raw-JSON spelling guarantee from that codec.
    let atomic = SqliteStore::open(&directory.file("atomic-baseline.sqlite3"));
    run(adopt_empty(&atomic, &prepare_native(&source).unwrap())).unwrap();
    let baseline = run(export_native_latest(&atomic, 2300)).unwrap();
    assert_eq!(map(&baseline), map(&latest));
    assert!(run(execute_staged(&store, begin)).is_err());
    assert!(
        run(store.read(&gateway_auth::api_keys::id_key("offline-key")))
            .unwrap()
            .is_some()
    );
}
#[test]
fn bounded_closed_frames_and_global_source_audit_are_not_per_batch_guesses() {
    assert!(
        decode_stage_request(
            b"{\"stage\":\"seal\",\"data\":{\"capture_id\":\"x\"},\"extra\":true}"
        )
        .is_err()
    );
    assert!(decode_stage_request(b"{\"stage\":\"append\",\"data\":").is_err());
    assert!(decode_stage_request(&vec![b' '; STAGED_BATCH_MAX_BYTES + 1]).is_err());
    let mut source = fixture();
    source.entries.push(source.entries[0].clone());
    assert!(prepare_native(&source).is_err());
}

#[test]
fn moved_complete_audit_retains_expired_typed_metadata_and_rejects_orphan_coupling() {
    use gateway_core::{
        tuple_key::{KeyPart, TupleKey},
        value::PortableValue,
    };
    let source = fixture();
    let mut corrupt = source.clone();
    corrupt.entries.retain(|entry| {
        TupleKey::from_sort_bytes(entry.raw_key.clone())
            .unwrap()
            .to_record_key()
            != gateway_auth::api_keys::id_key("offline-key")
    });
    assert_eq!(corrupt.entries.len(), source.entries.len() - 1);
    assert!(
        prepare_native(&corrupt).is_err(),
        "the same complete hash/ID audit must reject an orphan"
    );
    let mut source = source;
    let tuple = TupleKey::from_parts(&[
        KeyPart::String("default".into()),
        KeyPart::String("expired-audit-owned".into()),
    ])
    .unwrap();
    let revision = source.data_revision.clone();
    let expiry = source.captured_at_ms - 1;
    source.entries.insert(
        1,
        NativeEntry {
            raw_key: tuple.sort_bytes().to_vec(),
            value: NativeValue::CounterLe64(u64::MAX.to_le_bytes().to_vec()),
            revision: revision.clone(),
            expiration_ms: expiry,
        },
    );
    let directory = Directory::new();
    let store = SqliteStore::open(&directory.file("owned-audit.sqlite3"));
    let result = run(adopt_empty(&store, &prepare_native(&source).unwrap())).unwrap();
    assert_eq!(result.source_rows, source.entries.len());
    let retained = run(store.read(&tuple.to_record_key())).unwrap().unwrap();
    assert_eq!(
        retained.revision,
        format!("native-v1:{}:{}", revision.version, revision.sequence)
    );
    assert_eq!(retained.expires_at_ms, Some(expiry));
    assert_eq!(
        retained.portable_value().unwrap(),
        PortableValue::KvU64(u64::MAX.to_string())
    );
}
