//! Real original action/Start/publication then readonly source response DATA.
use super::publication::synthetic_config;
use super::*;
use gateway_core::{
    js_string::JsString16,
    source_control::{decode_source_control_record, encode_source_control_record},
    source_json::SourceJson,
};
use gateway_schema::{catalog_store, snapshot::ModelSnapshot};

fn second_account(f: &Fixture) {
    let mut rows = f.store.rows.lock().unwrap();
    let source = rows.get_mut(&codex_source_pool_key().0).unwrap();
    let mut extra = source.value["accounts"][0].clone();
    extra["account_id"] = json!("other-existing-account");
    extra["access_token"] = json!("OTHER_SYNTHETIC_ACCESS");
    extra["updated_at_ms"] = json!(123456.0);
    extra["native_owner"]["codex_home"] = json!("/tmp/native-import-other-owner");
    extra["native_owner"]["managed_source"]["generation_hash"] =
        json!(sha256_hex(b"other-physical-source"));
    let identity = gateway_auth::provider_credentials::codex_credential_identity(
        "other-existing-account",
        &Secret::new("OTHER_SYNTHETIC_ACCESS".into()),
        &Secret::new(String::new()),
    );
    extra["native_owner"]["generation_hash"] = json!(identity.native_generation_hash);
    source.value["accounts"].as_array_mut().unwrap().push(extra);
    source.value["accounts"].as_array_mut().unwrap().reverse();
    let projected = rows.get_mut(&keys::pool().0).unwrap();
    projected.value["accounts"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "account_id_hash":identity.routing_account_hash,
            "admin_account_hash":identity.administrative_account_hash,
            "credential_version":identity.credential_version,
            "enabled":false,
        }));
    projected.value["accounts"]
        .as_array_mut()
        .unwrap()
        .reverse();
}

async fn publish(f: &Fixture, limited: bool) -> ImportCustodyStartedRequest {
    let (_, _, started) = f.prepare_version(true, true).await;
    let body = f.publication_wire(&started, limited).bytes().unwrap();
    let peer = f.publication_peer(&body, 91).await;
    let control = f.control();
    let plan = control
        .prepare_import_publication(&peer, &body)
        .await
        .unwrap();
    let config = synthetic_config(&plan);
    plan.commit(config).await.unwrap();
    started
}

#[test]
fn normalized_completion_projects_actual_pool_order_and_committed_catalog_readonly() {
    run(async {
        let f = Fixture::new();
        f.catalog_seed();
        second_account(&f);
        let started = publish(&f, false).await;
        let before = f.snapshot();
        let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
        let nonces = f.replay.calls.load(Ordering::SeqCst);
        let result = f
            .control()
            .completion_metadata_fixture(&started.action_ref)
            .await
            .unwrap();
        assert_eq!(result.account_count, 2);
        assert_eq!(
            result.account_ids,
            vec!["other-existing-account", "synthetic-account"]
        );
        assert_eq!(result.account_count, result.account_ids.len());
        assert_eq!(
            result.updated_at_ms,
            f.store.now.load(Ordering::SeqCst) as f64
        );
        let rows = f.store.rows.lock().unwrap();
        let actual: ModelSnapshot =
            decode_source_control_record(rows.get(&catalog_store::codex_snapshot_key().0).unwrap())
                .unwrap()
                .deserialize()
                .unwrap();
        assert_eq!(result.models.count, actual.models.len());
        assert_eq!(result.models.source, actual.source);
        assert_eq!(result.models.updated_at_ms, actual.updated_at_ms);
        assert_eq!(result.models.client_version, actual.client_version);
        drop(rows);
        f.assert_readonly(&before, tokens, nonces);
    });
}

#[test]
fn retained_429_completion_keeps_nondefault_utf16_source_time_version_and_null() {
    run(async {
        for version in [None, Some("9.8.7")] {
            let f = Fixture::new();
            f.catalog_seed();
            let mut snapshot: ModelSnapshot = {
                let rows = f.store.rows.lock().unwrap();
                decode_source_control_record(
                    rows.get(&catalog_store::codex_snapshot_key().0).unwrap(),
                )
                .unwrap()
                .deserialize()
                .unwrap()
            };
            snapshot.source = JsString16::from_units(vec![0x72, 0x65, 0x74, 0xd800]);
            snapshot.updated_at_ms = 12345;
            snapshot.client_version = version.map(str::to_owned);
            let original = encode_source_control_record(
                "catalog-before",
                &SourceJson::from_serializable(&snapshot).unwrap(),
                None,
            )
            .unwrap();
            f.store
                .rows
                .lock()
                .unwrap()
                .insert(catalog_store::codex_snapshot_key().0, original.clone());
            let started = publish(&f, true).await;
            let before = f.snapshot();
            let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
            let nonces = f.replay.calls.load(Ordering::SeqCst);
            let result = f
                .control()
                .completion_metadata_fixture(&started.action_ref)
                .await
                .unwrap();
            assert_eq!(result.account_count, 1);
            assert_eq!(result.account_ids, vec!["synthetic-account"]);
            assert_eq!(result.models.count, snapshot.models.len());
            assert_eq!(result.models.source.as_units(), &[0x72, 0x65, 0x74, 0xd800]);
            assert_eq!(result.models.updated_at_ms, 12345);
            assert_eq!(result.models.client_version.as_deref(), version);
            assert!(
                result
                    .models
                    .source
                    .to_source_json()
                    .unwrap()
                    .as_str()
                    .contains("\\ud800")
            );
            assert_eq!(
                f.store
                    .rows
                    .lock()
                    .unwrap()
                    .get(&catalog_store::codex_snapshot_key().0),
                Some(&original)
            );
            f.assert_readonly(&before, tokens, nonces);
        }
    });
}

#[test]
fn completion_foreign_source_catalog_wrong_slot_and_selected_account_refuse_readonly() {
    run(async {
        for changed in [
            "source_revision",
            "catalog_revision",
            "slot",
            "selected_account",
        ] {
            let f = Fixture::new();
            f.catalog_seed();
            let started = publish(&f, false).await;
            {
                let mut rows = f.store.rows.lock().unwrap();
                match changed {
                    "source_revision" => {
                        rows.get_mut(&codex_source_pool_key().0).unwrap().revision =
                            "foreign-source".into()
                    }
                    "catalog_revision" => {
                        rows.get_mut(&catalog_store::codex_snapshot_key().0)
                            .unwrap()
                            .revision = "foreign-catalog".into()
                    }
                    "slot" => {
                        rows.get_mut(
                            &crate::native_control::rows::key("action", &started.action_ref).0,
                        )
                        .unwrap()
                        .value["facts"]["slot"] = json!(1)
                    }
                    _ => {
                        rows.get_mut(&codex_source_pool_key().0).unwrap().value["accounts"][0]["account_id"] =
                            json!("foreign-account")
                    }
                }
            }
            let before = f.snapshot();
            let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
            let nonces = f.replay.calls.load(Ordering::SeqCst);
            assert!(
                f.control()
                    .completion_metadata_fixture(&started.action_ref)
                    .await
                    .is_err(),
                "{changed}"
            );
            f.assert_readonly(&before, tokens, nonces);
        }
    });
}

#[test]
fn completion_oversized_or_revision_changed_consumed_rows_refuse_readonly() {
    run(async {
        for source in [true, false] {
            for oversized in [true, false] {
                let f = Fixture::new();
                f.catalog_seed();
                let started = publish(&f, false).await;
                let key = if source {
                    codex_source_pool_key()
                } else {
                    catalog_store::codex_snapshot_key()
                };
                let mut replacement = f.store.rows.lock().unwrap().get(&key.0).unwrap().clone();
                if oversized {
                    // Shape-readable but noncanonical stored state: Worker
                    // prepare_transition could never persist this 2MB+ row.
                    replacement.value["oversized_legacy_payload"] = json!("x".repeat(2_000_000));
                    f.store
                        .rows
                        .lock()
                        .unwrap()
                        .insert(key.0.clone(), replacement.clone());
                } else {
                    replacement.revision = "changed-after-cached-read".into();
                    f.store.race(key.clone(), Some(replacement.clone()));
                }
                let mut expected = f.snapshot();
                if !oversized {
                    expected[&key.0] = serde_json::to_value(replacement).unwrap();
                }
                let tokens = f.authority.tokens.0.load(Ordering::SeqCst);
                let nonces = f.replay.calls.load(Ordering::SeqCst);
                assert!(
                    f.control()
                        .completion_metadata_fixture(&started.action_ref)
                        .await
                        .is_err()
                );
                f.assert_readonly(&expected, tokens, nonces);
            }
        }
    });
}
