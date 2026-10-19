use super::*;
use gateway_core::value::ValueEncoding;

fn units(values: &[u16]) -> JsString16 {
    JsString16::from_units(values.to_vec())
}
fn credential(secret: JsString16) -> Credential {
    submitted_credential(
        Arc::new(ClaudeSourceSecret::from_source(secret)),
        Some(units(&[0xdc00])),
        100,
    )
    .unwrap()
}
fn workspace(id: JsString16) -> Workspace {
    Workspace {
        id,
        name: Some(units(&[0xd800])),
        source: "kv".into(),
        discovered_at_ms: None,
        verified_at_ms: None,
        last_error: None,
    }
}
fn roster(credential: Credential, workspace: Option<Workspace>) -> AccountStore {
    let fingerprint = fingerprint(&credential, workspace.as_ref());
    AccountStore {
        v: 1,
        accounts: vec![AccountBinding {
            account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into(),
            account_cohort_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".into(),
            evidence_generation: "cccccccc-cccc-cccc-cccc-cccccccccccc".into(),
            credential_fingerprint: fingerprint,
            credential,
            workspace,
        }],
        active_account_id: Some("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".into()),
        active_reason: JsString16::from_utf8("admin_selection"),
        updated_at_ms: 100,
    }
}
#[test]
fn scalar_fingerprint_and_roster_remain_source_compatible() {
    let mut value = credential(JsString16::from_utf8("sk-ant-api-synthetic-example-long"));
    value.label = Some(JsString16::from_utf8("scalar"));
    let workspace = workspace(JsString16::from_utf8("wrkspc_scalar"));
    let expected =
        sha256_hex(br#"["api_key","sk-ant-api-synthetic-example-long","wrkspc_scalar"]"#);
    assert_eq!(fingerprint(&value, Some(&workspace)), expected);
    let mut roster = roster(value, Some(workspace));
    roster.accounts[0].workspace.as_mut().unwrap().name = None;
    let record = encode_roster_record("original", &roster, Some(1_000)).unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::Json);
    let legacy = json!({"v":1,"accounts":[{"account_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","account_cohort_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","evidence_generation":"cccccccc-cccc-cccc-cccc-cccccccccccc","credential_fingerprint":expected,"credential":{"kind":"api_key","secret":"sk-ant-api-synthetic-example-long","hint":"sk-ant-api-syn...long","label":"scalar","source":"kv","updated_at_ms":100},"workspace":{"id":"wrkspc_scalar","name":null,"source":"kv","discovered_at_ms":null,"verified_at_ms":null,"last_error":null}}],"active_account_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","active_reason":"admin_selection","updated_at_ms":100});
    assert_eq!(record.json_value().unwrap(), &legacy);
    assert_eq!(record.revision, "original");
    assert_eq!(record.expires_at_ms, Some(1_000));
    assert_eq!(decode_roster_record(&record, 999).unwrap(), Some(roster));
    assert!(decode_roster_record(&record, 1_000).unwrap().is_none());
}
#[test]
fn lone_units_roundtrip_named_credential_workspace_and_roster_without_loss() {
    let mut secret = "sk-ant-api-".encode_utf16().collect::<Vec<_>>();
    secret.extend_from_slice(&[0xd800, 0xdc00, 0xd800]);
    let credential = credential(JsString16::from_units(secret));
    let workspace = workspace(units(&[119, 114, 107, 115, 112, 99, 95, 0xdc00]));
    let credential_record =
        encode_credential_record("credential-r", &credential, Some(900)).unwrap();
    assert_eq!(credential_record.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(
        decode_credential_record(&credential_record, 100).unwrap(),
        Some(credential.clone())
    );
    let workspace_record = encode_workspace_record("workspace-r", &workspace, None).unwrap();
    assert_eq!(workspace_record.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(
        decode_workspace_record(&workspace_record, 100).unwrap(),
        Some(workspace.clone())
    );
    let roster = roster(credential, Some(workspace));
    let record = encode_roster_record("roster-r", &roster, None).unwrap();
    assert_eq!(record.value_encoding, ValueEncoding::ProfileV2);
    assert_eq!(decode_roster_record(&record, 100).unwrap(), Some(roster));
}
#[test]
fn fingerprint_uses_original_json_stringify_bytes_not_scalar_replacement() {
    let secret = credential(units(&[115, 107, 45, 97, 110, 116, 45, 0xd800]));
    let workspace = workspace(units(&[119, 114, 107, 115, 112, 99, 95, 0xdc00]));
    assert_eq!(
        fingerprint(&secret, Some(&workspace)),
        sha256_hex(br#"["api_key","sk-ant-\ud800","wrkspc_\udc00"]"#)
    );
    let replacement = credential(units(&[115, 107, 45, 97, 110, 116, 45, 0xfffd]));
    assert_ne!(
        fingerprint(&secret, Some(&workspace)),
        fingerprint(&replacement, Some(&workspace))
    );
}
#[test]
fn secret_debug_is_redacted_and_scalar_projection_is_exact_or_fallible() {
    let secret = ClaudeSourceSecret::from_source(units(&[0xd800]));
    assert_eq!(format!("{secret:?}"), "[redacted]");
    assert!(secret.try_scalar_secret().is_err());
    let scalar = ClaudeSourceSecret::from_source(JsString16::from_utf8("sk-ant-synthetic"));
    assert_eq!(
        scalar.try_scalar_secret().unwrap().expose(),
        "sk-ant-synthetic"
    );
    let first = Arc::new(scalar);
    let second = Arc::clone(&first);
    assert!(Arc::ptr_eq(&first, &second));
}
#[test]
fn source_hint_slices_utf16_units_even_when_the_slice_splits_a_pair() {
    let mut secret = "sk-ant-api-ab".encode_utf16().collect::<Vec<_>>();
    assert_eq!(secret.len(), 13);
    secret.extend_from_slice(&[0xd83d, 0xde00, 97, 98, 99, 100, 101]);
    let credential = credential(JsString16::from_units(secret.clone()));
    let mut expected = secret[..14].to_vec();
    expected.extend_from_slice(&[46, 46, 46]);
    expected.extend_from_slice(&secret[secret.len() - 4..]);
    assert_eq!(credential.hint, JsString16::from_units(expected));
}
#[test]
fn finite_stored_ids_and_empty_tombstones_are_unchanged() {
    let value = roster(credential(JsString16::from_utf8("sk-ant-synthetic")), None);
    let document = roster_source(&value);
    let altered = document
        .as_str()
        .replace("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", r"\ud800");
    assert!(parse_source_roster(&SourceJson::parse(&altered).unwrap()).is_err());
    let empty = empty(100);
    let record = encode_roster_record("tombstone", &empty, None).unwrap();
    assert_eq!(decode_roster_record(&record, 100).unwrap(), Some(empty));
}

#[test]
fn original_revision_and_generation_fences_survive_source_records() {
    use gateway_core::state::{AtomicTransition, CommitOutcome};
    use std::{
        cell::RefCell,
        collections::BTreeMap,
        future::Future,
        task::{Context, Poll, Waker},
    };
    struct Store(RefCell<BTreeMap<String, StoredRecord>>);
    impl AuthorityStore for Store {
        async fn read(&self, key: &RecordKey) -> Result<Option<StoredRecord>, GatewayError> {
            Ok(self.0.borrow().get(&key.0).cloned())
        }
        async fn commit(
            &self,
            transition: AtomicTransition,
        ) -> Result<CommitOutcome, GatewayError> {
            let mut rows = self.0.borrow_mut();
            if transition
                .checks
                .iter()
                .any(|c| rows.get(&c.key.0).map(|r| &r.revision) != c.expected_revision.as_ref())
            {
                return Ok(CommitOutcome::Conflict);
            }
            for mutation in transition.mutations {
                match mutation {
                    RecordMutation::Put { key, record } => {
                        rows.insert(key.0, record);
                    }
                    RecordMutation::Delete { key } => {
                        rows.remove(&key.0);
                    }
                }
            }
            Ok(CommitOutcome::Committed)
        }
    }
    fn run<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
    }
    let mut secret = "sk-ant-".encode_utf16().collect::<Vec<_>>();
    secret.push(0xd800);
    let mut value = roster(credential(JsString16::from_units(secret)), None);
    let original = value.accounts[0].clone();
    let store = Store(RefCell::new(BTreeMap::from([(
        account_store_key().0,
        encode_roster_record("r1", &value, None).unwrap(),
    )])));
    let first = run(current_binding(&store, &original, 100))
        .unwrap()
        .unwrap();
    assert_eq!(first.expected_revision.as_deref(), Some("r1"));
    value.accounts[0].evidence_generation = "dddddddd-dddd-dddd-dddd-dddddddddddd".into();
    store.0.borrow_mut().insert(
        account_store_key().0,
        encode_roster_record("r2", &value, None).unwrap(),
    );
    assert!(
        run(current_binding(&store, &original, 100))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        run(store.commit(AtomicTransition {
            checks: vec![first],
            mutations: Vec::new()
        }))
        .unwrap(),
        CommitOutcome::Conflict
    );
    assert_eq!(store.0.borrow()[&account_store_key().0].revision, "r2");
}

#[test]
fn source_submission_empty_label_is_written_before_later_record_normalization() {
    let credential = submitted_credential(
        Arc::new(ClaudeSourceSecret::from_source(JsString16::from_utf8(
            "sk-ant-synthetic",
        ))),
        Some(JsString16::from_utf8("")),
        100,
    )
    .unwrap();
    assert_eq!(credential.label, Some(JsString16::from_utf8("")));
    let row = encode_credential_record("label", &credential, None).unwrap();
    assert_eq!(
        source::member(&decode_source_control_record(&row).unwrap(), "label")
            .unwrap()
            .as_str(),
        "\"\""
    );
    assert_eq!(
        decode_credential_record(&row, 100).unwrap().unwrap().label,
        None
    );
}
