use super::*;
fn published_peer(fault: Fault) -> (Peer, ImportCustodyStartedRequest) {
    let (f, metadata) = prepare();
    let started = run(async {
        let admitted = admission(&metadata, 171);
        f.store.now.store(wall(), Ordering::SeqCst);
        let control = f.control();
        let admitted = control.admit_import(admitted).await.unwrap();
        let proof = control.finish_import(admitted, PRIVATE_BODY).await.unwrap();
        let mut claim = control.claim_import(&proof).await.unwrap();
        let start = control
            .start_import(&mut claim, &proof)
            .await
            .unwrap()
            .unwrap();
        let started = start.custody_request().unwrap();
        let body = f.publication_wire(&started, false).bytes().unwrap();
        let auth = f.publication_peer(&body, 172).await;
        let plan = control
            .prepare_import_publication(&auth, &body)
            .await
            .unwrap();
        let config = super::super::super::publication::synthetic_config(&plan);
        plan.commit(config).await.unwrap();
        started
    });
    (peer(f, fault), started)
}
#[test]
fn actual_tls_current_custody_terminal_needs_no_actor_claim_and_wrong_mac_never_mints() {
    for fault in [Fault::None, Fault::WrongMac] {
        let (Peer { socket, task }, started) = published_peer(fault);
        let cancel = CancelNow::default();
        let client = client(socket, &cancel);
        let result = client.verify_custody_terminal(&started, "publication-one");
        if matches!(fault, Fault::WrongMac) {
            assert!(result.is_err());
        } else {
            let proof = result.unwrap();
            assert_eq!(
                proof.request().canonical_bytes().unwrap(),
                started.canonical_bytes().unwrap()
            );
            assert_eq!(proof.publication_revision(), "publication-one");
            assert_eq!(proof.terminal().native_receipt_ref, "native-receipt-one");
            assert_eq!(proof.deadline_ms(), started.deadline_ms);
        }
        drop(client);
        let result = task.join().unwrap();
        assert_eq!(result.bodies.len(), 1);
    }
}
