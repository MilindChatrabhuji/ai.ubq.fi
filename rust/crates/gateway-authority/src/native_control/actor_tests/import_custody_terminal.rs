//! Authority-only current terminal observations; native stopped provenance stays native.
use super::*;
use gateway_auth::native_import::authority::ImportCustodyStartedWire;
fn published() -> (Fixture, ImportCustodyStartedRequest) {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let (_, _, started) = f.prepare_version(true, true).await;
        let body = f.publication_wire(&started, false).bytes().unwrap();
        let peer = f.publication_peer(&body, 161).await;
        {
            let control = f.control();
            let plan = control
                .prepare_import_publication(&peer, &body)
                .await
                .unwrap();
            let config = super::super::publication::synthetic_config(&plan);
            plan.commit(config).await.unwrap();
        }
        (f, started)
    })
}
fn command(started: &ImportCustodyStartedRequest, revision: &str) -> Command {
    Command::CustodyTerminal {
        started: ImportCustodyStartedWire::parse(&started.canonical_bytes().unwrap()).unwrap(),
        publication_revision: revision.into(),
    }
}
async fn refuses(f: &Fixture, command: Command, salt: u8) {
    let body = Request::new(command).unwrap().bytes().unwrap();
    let peer = f.phase_peer(&body, salt).await;
    let before = f.snapshot();
    let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
    assert!(
        f.control()
            .handle_import_authority(&peer, &body)
            .await
            .is_err()
    );
    assert_eq!(before, f.snapshot());
    assert_eq!(tokens, f.authority.tokens.0.load(Ordering::SeqCst));
}
#[test]
fn current_matching_terminal_is_readonly_without_an_actor_claim_or_new_start() {
    run(async {
        let (f, started) = published();
        let before = f.snapshot();
        let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
        let ResultData::CustodyTerminal {
            started: echoed,
            publication_revision,
            terminal,
        } = f.phase(command(&started, "publication-one"), 162).await
        else {
            panic!("wrong phase")
        };
        assert_eq!(echoed.bytes().unwrap(), started.canonical_bytes().unwrap());
        assert_eq!(publication_revision, "publication-one");
        assert_eq!(terminal.native_receipt_ref, "native-receipt-one");
        assert_eq!(before, f.snapshot());
        assert_eq!(tokens, f.authority.tokens.0.load(Ordering::SeqCst));
    });
}
#[test]
fn wrong_original_binding_publication_or_epoch_never_observes_a_terminal() {
    run(async {
        for field in 0..9 {
            let (f, mut started) = published();
            match field {
                0 => started.operation_id = "wrong-operation".into(),
                1 => started.claim_ref = "wrong-claim".into(),
                2 => started.native_owner_id = "foreign-owner".into(),
                3 => started.source_revision = "foreign-source".into(),
                4 => started.normalized_revision = "foreign-normalized".into(),
                5 => started.owner_revision = "foreign-owner-revision".into(),
                6 => started.source_native_generation = "f".repeat(64),
                7 => started.deadline_ms += 1,
                _ => {}
            }
            refuses(
                &f,
                command(
                    &started,
                    if field == 8 {
                        "wrong-publication"
                    } else {
                        "publication-one"
                    },
                ),
                163,
            )
            .await;
        }
        let (f, started) = published();
        let body = Request::new(command(&started, "publication-one"))
            .unwrap()
            .bytes()
            .unwrap();
        let other = NativeTransportIdentity::new(
            "import-test".into(),
            "owner".into(),
            "foreign-epoch".into(),
            [7; 32],
            BTreeSet::from([NativeCapability::CodexAuthImport]),
        )
        .unwrap();
        let nonce = base64url(&[164; 32]);
        let now = f.store.now.load(Ordering::SeqCst);
        let time = now.to_string();
        let mac = other
            .sign(NATIVE_RENEWAL_AUTHORITY_PATH, now, &nonce, &body)
            .unwrap();
        let peer = NativeAuthenticator::new(&other, &f.replay)
            .authenticate(
                NATIVE_RENEWAL_AUTHORITY_PATH,
                NativeAuthHeaders {
                    version: "1",
                    key_id: other.key_id(),
                    time_ms: &time,
                    nonce: &nonce,
                    mac: &mac,
                },
                &body,
                now,
            )
            .await
            .unwrap();
        let before = f.snapshot();
        assert!(
            f.control()
                .handle_import_authority(&peer, &body)
                .await
                .is_err()
        );
        assert_eq!(before, f.snapshot());
    });
}
#[test]
fn missing_pair_foreign_current_config_revocation_and_deadline_refuse() {
    run(async {
        for failure in 0..5 {
            let (f, started) = published();
            match failure {
                0 => {
                    let key = crate::native_control::rows::key("operation", &started.operation_id);
                    f.store.rows.lock().unwrap().get_mut(&key.0).unwrap().value["terminal"] =
                        json!(null);
                }
                1 => {
                    let key = crate::native_control::rows::key("action", &started.action_ref);
                    f.store.rows.lock().unwrap().get_mut(&key.0).unwrap().value["publication"]["native_receipt_ref"] =
                        json!("");
                }
                2 => {
                    f.store
                        .rows
                        .lock()
                        .unwrap()
                        .get_mut(&keys::paid_control_config().0)
                        .unwrap()
                        .revision = "foreign-config".into()
                }
                3 => {
                    f.store
                        .rows
                        .lock()
                        .unwrap()
                        .remove(&passkeys::key("users", "user-fixture").0);
                }
                _ => f.store.now.store(started.deadline_ms, Ordering::SeqCst),
            }
            refuses(&f, command(&started, "publication-one"), 165).await;
        }
        let f = Fixture::new();
        f.catalog_seed();
        let (_, _, started) = f.prepare_version(true, true).await;
        refuses(&f, command(&started, "publication-one"), 166).await;
    });
}
#[test]
fn overwritten_started_revision_is_echoed_data_not_a_historical_or_stop_proof() {
    run(async {
        let (f, mut started) = published();
        started.started_revision = "request-correlated-not-historically-proved".into();
        let before = f.snapshot();
        let ResultData::CustodyTerminal {
            started: echoed, ..
        } = f.phase(command(&started, "publication-one"), 167).await
        else {
            panic!("wrong phase")
        };
        assert_eq!(echoed.started_revision, started.started_revision);
        assert_eq!(before, f.snapshot());
        // Native must compare this exact echo with its OWN original stopped session.
        // Authority grants neither a historical Started observation nor a new stop.
    });
}
