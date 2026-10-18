use gateway_admin_runtime::{
    claude::{Credential, CredentialKind},
    claude_generation::{StateChange, StateGeneration},
};
use gateway_auth::crypto::{Secret, sha256_hex};

fn credential() -> Credential {
    Credential {
        kind: CredentialKind::ApiKey,
        secret: Secret::new("synthetic-key".into()),
        hint: "configured".into(),
        label: None,
        source: "kv".into(),
        updated_at_ms: Some(1),
    }
}

#[test]
fn successful_same_value_writes_clear_and_workspace_events_invalidate_inflight_reads() {
    let owner = StateGeneration::default();
    let other = StateGeneration::default();
    let clone = owner.clone();
    let snapshot = owner.snapshot();
    assert_eq!(snapshot.number(), 0);
    assert!(!other.is_current(&snapshot));
    for (index, event) in [
        StateChange::CredentialStored,
        StateChange::CredentialStored,
        StateChange::CredentialCleared,
        StateChange::CredentialCleared,
        StateChange::WorkspaceStored,
        StateChange::WorkspaceStored,
    ]
    .into_iter()
    .enumerate()
    {
        let before_read = owner.snapshot();
        clone.record_success(event);
        assert!(!before_read.is_current());
        assert_eq!(owner.snapshot().number(), index as u64 + 1);
        assert!(
            owner
                .catalog_identity(&before_read, None, &credential(), None)
                .is_none()
        );
    }
    assert_eq!(other.snapshot().number(), 0);
    assert_eq!(StateGeneration::default().snapshot().number(), 0);
}

#[test]
fn identity_uses_source_json_numeric_generation_and_null_environment_ids() {
    let owner = StateGeneration::default();
    let snapshot = owner.snapshot();
    assert_eq!(
        owner.catalog_identity(&snapshot, None, &credential(), Some("wrkspc_fixture")),
        Some(sha256_hex(
            br#"[null,null,"api_key","synthetic-key","wrkspc_fixture",0]"#
        ))
    );
    // Reads and roster selection alone have no generation operation and retain the identity.
    assert!(snapshot.is_current());
    assert_eq!(owner.snapshot().number(), 0);
}
