use super::*;
use gateway_auth::native_auth::NativeCapability;
use gateway_core::state::RecordKey;

const PAYLOAD: &[u8] = b"private exact payload";

fn binding() -> InitialAdoptionBinding {
    InitialAdoptionBinding {
        worker_git_sha: "a".repeat(40),
        worker_git_tree: "b".repeat(40),
        authority_namespace_id: "c".repeat(32),
        authority_object_id: "d".repeat(64),
        capture_id: "e".repeat(64),
        source_git_sha: "f".repeat(40),
        source_native_version: "7".into(),
        source_native_sequence: "2".into(),
        source_pool_revision: "source-r7".into(),
        normalized_pool_revision: "pool-r7".into(),
        custody: vec![InitialNativeCustodyBinding {
            account_id_hash: "1".repeat(64),
            native_source_generation: "2".repeat(64),
            access_generation: "3".repeat(64),
        }],
        custody_observed_at_ms: 1000,
        valid_through_ms: 2000,
        owner_revision: "fresh-operator-owner-r1".into(),
    }
}

fn deployment() -> InitialControlOwnerDeployment {
    let identity = NativeTransportIdentity::new(
        "candidate-live-key".into(),
        "candidate-live-owner".into(),
        "candidate-live-epoch".into(),
        [91; 32],
        BTreeSet::from([
            NativeCapability::SupervisorRead,
            NativeCapability::LiveSideband,
        ]),
    )
    .unwrap();
    InitialControlOwnerDeployment::configured(&identity, binding(), sha256_hex(PAYLOAD)).unwrap()
}

fn prepared() -> PreparedInitialControlOwner {
    deployment()
        .prepare(
            PAYLOAD,
            &"a".repeat(40),
            &"b".repeat(40),
            &"d".repeat(64),
            1500,
        )
        .unwrap()
}

fn transition() -> AtomicTransition {
    AtomicTransition {
        checks: vec![RevisionCheck {
            key: RecordKey("existing-adoption-manifest-key".into()),
            expected_revision: None,
        }],
        mutations: vec![RecordMutation::Put {
            key: RecordKey("existing-adoption-manifest-key".into()),
            record: StoredRecord::json("capture-r1", serde_json::json!({"v":4}), None),
        }],
    }
}

fn adoption_facts() -> InitialAdoptionFacts {
    InitialAdoptionFacts {
        capture_id: "e".repeat(64),
        source_git_sha: "f".repeat(40),
        source_captured_at_ms: 900,
        source_native_version: "7".into(),
        source_native_sequence: "2".into(),
        source_pool_revision: "source-r7".into(),
        normalized_pool_revision: "pool-r7".into(),
        accounts: vec![InitialAdoptionAccountFacts {
            account_id_hash: "1".repeat(64),
            projection_generation: "3".repeat(64),
            access_generation: "3".repeat(64),
        }],
    }
}

#[test]
fn real_readonly_identity_derives_fixed_owner_without_configuration_capability() {
    let prepared = prepared();
    let mut transaction = transition();
    prepared.bind_empty_adoption(&mut transaction).unwrap();
    assert_eq!(transaction.checks.len(), 2);
    assert_eq!(transaction.checks[1].key, keys::paid_control_owner());
    assert_eq!(transaction.checks[1].expected_revision, None);
    let RecordMutation::Put { key, record } = &transaction.mutations[1] else {
        panic!("fixed owner must be a Put");
    };
    assert_eq!(key, &keys::paid_control_owner());
    assert!(prepared.matches_current_owner(Some(record)));
    assert_eq!(record.value["owner_id"], "candidate-live-owner");
    assert_eq!(record.value["key_fingerprint"], sha256_hex(&[91; 32]));
    assert!(record.value.get("capabilities").is_none());
}

#[test]
fn payload_build_object_and_custody_time_are_exact() {
    let deployment = deployment();
    for (payload, sha, tree, object, now) in [
        (
            b"tampered".as_slice(),
            "a".repeat(40),
            "b".repeat(40),
            "d".repeat(64),
            1500,
        ),
        (
            PAYLOAD,
            "9".repeat(40),
            "b".repeat(40),
            "d".repeat(64),
            1500,
        ),
        (
            PAYLOAD,
            "a".repeat(40),
            "9".repeat(40),
            "d".repeat(64),
            1500,
        ),
        (
            PAYLOAD,
            "a".repeat(40),
            "b".repeat(40),
            "9".repeat(64),
            1500,
        ),
        (PAYLOAD, "a".repeat(40), "b".repeat(40), "d".repeat(64), 999),
        (
            PAYLOAD,
            "a".repeat(40),
            "b".repeat(40),
            "d".repeat(64),
            2001,
        ),
    ] {
        assert!(
            deployment
                .prepare(payload, &sha, &tree, &object, now)
                .is_err()
        );
    }
}

#[test]
fn migration_compares_only_reconstructed_source_and_access_projection_facts() {
    let prepared = prepared();
    // The locally attested native generation is "2"; Worker projection and
    // credential generations are "3". The Worker never invents a physical read.
    let mut changed = adoption_facts();
    assert!(prepared.require_adoption_facts(&changed, 1500).is_ok());
    changed.accounts[0].projection_generation = "4".repeat(64);
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.accounts[0].access_generation = "4".repeat(64);
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.accounts[0].account_id_hash = "4".repeat(64);
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.source_pool_revision = "new-source-revision".into();
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.normalized_pool_revision = "new-pool-revision".into();
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.capture_id = "4".repeat(64);
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.source_git_sha = "4".repeat(40);
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.source_native_version = "8".into();
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.source_native_sequence = "3".into();
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    changed = adoption_facts();
    changed.accounts.clear();
    assert!(prepared.require_adoption_facts(&changed, 1500).is_err());
    assert!(
        prepared
            .require_adoption_facts(&adoption_facts(), 2001)
            .is_err()
    );
}

#[test]
fn capture_clock_cannot_follow_sealed_custody_observation() {
    let prepared = prepared();
    let mut facts = adoption_facts();
    facts.source_captured_at_ms = 1000;
    assert!(prepared.require_adoption_facts(&facts, 1500).is_ok());
    facts.source_captured_at_ms = 1001;
    assert!(prepared.require_adoption_facts(&facts, 1500).is_err());
    facts.source_captured_at_ms = -1;
    assert!(prepared.require_adoption_facts(&facts, 1500).is_err());
}

#[test]
fn occupied_or_noninitial_transition_is_never_modified() {
    let prepared = prepared();
    let mut changed = transition();
    changed.checks[0].expected_revision = Some("occupied".into());
    let before = changed.clone();
    assert!(prepared.bind_empty_adoption(&mut changed).is_err());
    assert_eq!(changed, before);
    let mut changed = transition();
    prepared.bind_empty_adoption(&mut changed).unwrap();
    let before = changed.clone();
    assert!(prepared.bind_empty_adoption(&mut changed).is_err());
    assert_eq!(changed, before);
    let mut changed = transition();
    changed.mutations.push(RecordMutation::Delete {
        key: RecordKey("other".into()),
    });
    let before = changed.clone();
    assert!(prepared.bind_empty_adoption(&mut changed).is_err());
    assert_eq!(changed, before);
}

#[test]
fn matching_owner_readback_is_exact_and_receipt_contains_no_secret_material() {
    let prepared = prepared();
    let mut transaction = transition();
    prepared.bind_empty_adoption(&mut transaction).unwrap();
    let RecordMutation::Put { record, .. } = &mut transaction.mutations[1] else {
        panic!()
    };
    let before = record.clone();
    assert!(prepared.matches_current_owner(Some(record)));
    assert_eq!(record, &before);
    record.revision = "later-owner-revision".into();
    assert!(!prepared.matches_current_owner(Some(record)));
    *record = before;
    record.value["key_fingerprint"] = serde_json::json!("different");
    assert!(!prepared.matches_current_owner(Some(record)));
    assert!(!prepared.matches_current_owner(None));
    let receipt = serde_json::to_string(&prepared.receipt()).unwrap();
    for forbidden in [
        "capturebytes",
        "access_token",
        "refresh_token",
        "hmac",
        "capabilities",
    ] {
        assert!(!receipt.contains(forbidden));
    }
    assert!(receipt.contains("candidate-live-owner"));
}
