use gateway_auth::session_index::{index_key, validate_custody_record};
use gateway_core::state::{RecordKey, StoredRecord};
use serde_json::json;

fn row() -> (RecordKey, StoredRecord) {
    let digest = "a".repeat(64);
    (
        index_key(&digest).unwrap(),
        StoredRecord::json(
            "source-session",
            json!({"v":1,"session_digest":digest,"user_id":"fixture-user","session_revision":"source-session","expires_at_ms":2000}),
            Some(2000),
        ),
    )
}

#[test]
fn expired_session_custody_is_data_without_renewing_its_expiry() {
    let (key, record) = row();
    let original = record.clone();
    validate_custody_record(&key, &record).unwrap();
    assert_eq!(record, original);
}

#[test]
fn session_custody_requires_exact_key_revision_expiry_and_schema() {
    let (key, record) = row();
    assert!(validate_custody_record(&index_key(&"b".repeat(64)).unwrap(), &record).is_err());
    for revision in ["", "another-session"] {
        let mut changed = record.clone();
        changed.revision = revision.into();
        assert!(validate_custody_record(&key, &changed).is_err());
    }
    for expiry in [None, Some(3000)] {
        let mut changed = record.clone();
        changed.expires_at_ms = expiry;
        assert!(validate_custody_record(&key, &changed).is_err());
    }
    for change in ["missing", "unknown", "version", "expiry"] {
        let mut changed = record.clone();
        match change {
            "missing" => {
                changed.value.as_object_mut().unwrap().remove("v");
            }
            "unknown" => changed.value["unknown"] = json!(true),
            "version" => changed.value["v"] = json!(2),
            _ => {
                changed.value["expires_at_ms"] = json!(-1);
                changed.expires_at_ms = Some(-1);
            }
        }
        assert!(validate_custody_record(&key, &changed).is_err());
    }
}
