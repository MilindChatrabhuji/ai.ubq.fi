//! Genuine publication preserves input auth time, not later upsert/catalog time.
use super::*;
use gateway_core::source_control::decode_source_control_record;
use gateway_schema::{catalog_store, snapshot::ModelSnapshot};
#[test]
fn seed_refresh_and_limited429_selected_auth_times_survive_later_publication_clock() {
    run(async {
        let seed_time = 1_000_012.25;
        let refresh_time = 1_000_050.75;
        let publication_time = 1_000_200;
        for (limited, auth_time) in [(false, seed_time), (false, refresh_time), (true, seed_time)] {
            let f = Fixture::new();
            f.catalog_seed();
            let (_, _, started) = f.prepare_version(true, true).await;
            let retained = f
                .store
                .read(&catalog_store::codex_snapshot_key())
                .await
                .unwrap()
                .unwrap();
            let mut wire = f.publication_wire(&started, limited);
            wire.document.updated_at_ms = auth_time;
            f.store.now.store(publication_time, Ordering::SeqCst);
            let body = wire.bytes().unwrap();
            let peer = f.publication_peer(&body, 71).await;
            let control = f.control();
            let plan = control
                .prepare_import_publication(&peer, &body)
                .await
                .unwrap();
            let config = super::super::publication::synthetic_config(&plan);
            plan.commit(config).await.unwrap();
            let source = f
                .store
                .read(&codex_source_pool_key())
                .await
                .unwrap()
                .unwrap();
            let source = gateway_auth::provider_credentials::parse_codex_source_pool(&source.value)
                .unwrap()
                .unwrap();
            assert_eq!(source.accounts[0].updated_at_ms, auth_time);
            assert_eq!(source.updated_at_ms, publication_time as f64);
            assert_ne!(source.accounts[0].updated_at_ms, source.updated_at_ms);
            let completion = control
                .completion_metadata_fixture(&wire.action_ref)
                .await
                .unwrap();
            assert_eq!(completion.updated_at_ms, auth_time);
            let catalog = f
                .store
                .read(&catalog_store::codex_snapshot_key())
                .await
                .unwrap()
                .unwrap();
            if limited {
                assert_eq!(
                    serde_json::to_value(catalog).unwrap(),
                    serde_json::to_value(retained).unwrap()
                );
                assert_eq!(completion.models.updated_at_ms, 1_000_000);
            } else {
                let snapshot: ModelSnapshot = decode_source_control_record(&catalog)
                    .unwrap()
                    .deserialize()
                    .unwrap();
                assert_eq!(completion.models.updated_at_ms, snapshot.updated_at_ms);
                assert_eq!(snapshot.updated_at_ms, publication_time);
            }
        }
    });
}
#[test]
fn authenticated_publication_timestamp_cannot_be_replaced_after_native_mac() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let (_, _, started) = f.prepare_version(true, true).await;
        let mut wire = f.publication_wire(&started, false);
        wire.document.updated_at_ms = 1_000_012.25;
        let original = wire.bytes().unwrap();
        let peer = f.publication_peer(&original, 72).await;
        wire.document.updated_at_ms = 1_000_050.75;
        let changed = wire.bytes().unwrap();
        let before = f.snapshot();
        assert!(
            f.control()
                .prepare_import_publication(&peer, &changed)
                .await
                .is_err()
        );
        assert_eq!(before, f.snapshot());
    });
}
