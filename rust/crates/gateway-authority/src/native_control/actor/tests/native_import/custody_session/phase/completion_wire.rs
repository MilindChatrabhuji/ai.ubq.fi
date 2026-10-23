//! Actual signed actor reply must preserve retained source metadata and UTF16.
use super::*;
#[test]
fn retained_429_actor_reply_carries_real_projection_and_lossless_source() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let key = gateway_schema::catalog_store::codex_snapshot_key();
        let catalog=gateway_core::source_json::SourceJson::parse(r#"{"models":[{"slug":"model-a"}],"source":"\ud800","updated_at_ms":1234,"client_version":null}"#).unwrap();
        f.store.rows.lock().unwrap().insert(
            key.0,
            gateway_core::source_control::encode_source_control_record(
                "catalog-before",
                &catalog,
                None,
            )
            .unwrap(),
        );
        let state = f.admitted_phase().await;
        let (_, _, started) = f.prepare_version(true, true).await;
        let body = f.publication_wire(&started, true).bytes().unwrap();
        let peer = f.publication_peer(&body, 181).await;
        let control = f.control();
        control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap()
            .commit(None)
            .await
            .unwrap();
        let before = f.snapshot();
        let ResultData::Terminal { completion, .. } = f
            .phase(
                Command::Terminal {
                    state,
                    claim_ref: started.claim_ref,
                    publication_revision: "publication-one".into(),
                    native_receipt_ref: "native-receipt-one".into(),
                    publication_request_digest: sha256_hex(&body),
                },
                182,
            )
            .await
        else {
            panic!("terminal")
        };
        assert_eq!(completion.account_count, 1);
        assert_eq!(completion.account_ids, ["synthetic-account"]);
        assert_eq!(completion.updated_at_ms, 1_000_000.0);
        assert_eq!(completion.models.count, 1);
        assert_eq!(completion.models.source.as_units(), [0xd800]);
        assert_eq!(completion.models.updated_at_ms, 1234);
        assert_eq!(completion.models.client_version, None);
        assert_eq!(before, f.snapshot());
    });
}
