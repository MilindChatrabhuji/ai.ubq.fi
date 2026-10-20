//! Resource selection is readonly and never reconstructs import permission.
use super::*;
use crate::native_control::{RegisteredRenewalOwner, RegisteredRenewalOwners};
fn registry(f: &Fixture) -> RegisteredRenewalOwners {
    RegisteredRenewalOwners::configured(vec![
        RegisteredRenewalOwner::configured(
            "unrelated".into(),
            "/tmp/unrelated-import-owner".into(),
        )
        .unwrap(),
        RegisteredRenewalOwner::configured(
            f.registered.native_owner_id().into(),
            f.registered.registered_home().into(),
        )
        .unwrap(),
    ])
    .unwrap()
}
#[test]
fn import_owner_selects_existing_registered_profile_before_and_after_publication_readonly() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        let (_, _, started) = f.prepare_version(true, true).await;
        let owners = registry(&f);
        let before = f.snapshot();
        assert_eq!(
            owners
                .for_import_action(&f.authority, &started.action_ref)
                .await
                .unwrap()
                .native_owner_id(),
            f.registered.native_owner_id()
        );
        assert_eq!(before, f.snapshot());
        let body = f.publication_wire(&started, false).bytes().unwrap();
        let peer = f.publication_peer(&body, 74).await;
        let control = f.control();
        let plan = control
            .prepare_import_publication(&peer, &body)
            .await
            .unwrap();
        let config = super::super::publication::synthetic_config(&plan);
        plan.commit(config).await.unwrap();
        let before = f.snapshot();
        assert_eq!(
            owners
                .for_import_action(&f.authority, &started.action_ref)
                .await
                .unwrap()
                .native_owner_id(),
            f.registered.native_owner_id()
        );
        assert_eq!(before, f.snapshot());
    });
}
#[test]
fn import_owner_missing_malformed_and_foreign_source_never_select_a_profile() {
    run(async {
        for kind in 0..3 {
            let f = Fixture::new();
            let (_, _, started) = f.prepare_version(true, true).await;
            let owners = registry(&f);
            if kind == 0 {
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .remove(&crate::native_control::rows::key("action", &started.action_ref).0);
            } else if kind == 1 {
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .get_mut(&crate::native_control::rows::key("action", &started.action_ref).0)
                    .unwrap()
                    .value
                    .as_object_mut()
                    .unwrap()
                    .remove("publication");
            } else {
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .get_mut(&codex_source_pool_key().0)
                    .unwrap()
                    .value["accounts"][0]["native_owner"]["codex_home"] =
                    json!("/tmp/not-a-registered-import-home");
            }
            let before = f.snapshot();
            assert!(
                owners
                    .for_import_action(&f.authority, &started.action_ref)
                    .await
                    .is_err()
            );
            assert_eq!(before, f.snapshot());
        }
    });
}
